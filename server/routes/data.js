'use strict';
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../db');
const { requireAuth, requireAdmin, hashPassword, revokeAllUserTokens } = require('../auth');
const acessoriasClient = require('../acessoriasClient');
const { criarClienteZappy } = require('../cs/zappyClient');
const { ensurePontuacaoSchema, recalcularPontosDoMes, clamp } = require('../cs/pontuacao');
const { ensureAbandonoSchema, recalcularAbandonoDoMes } = require('../cs/abandono');

const router = express.Router();

/**
 * POST /api/data/legalizacao/certificados/importar-certiseguro — recebe a
 * lista de certificados (CNPJ/CPF + validade) trazida pelo script local que
 * roda numa estação do escritório com o IP liberado na CertiSeguro (ver
 * server/legalizacao/certiseguroSync.js). Chamada máquina-a-máquina,
 * autenticada por token compartilhado — por isso fica ANTES do
 * `router.use(requireAuth)` abaixo, que exigiria sessão de usuário logado.
 */
/**
 * A Prefeitura de Uberlândia bloqueia o IP do Render (a sessão nem abre). Então a consulta
 * roda numa estação do escritório (server/legalizacao/consultarAlvarasLocal.js), 1 empresa a
 * cada 20s, e o resultado é gravado aqui — mesmo token máquina-a-máquina das procurações.
 *   GET  /legalizacao/alvaras-a-consultar   → empresas que a rotina noturna consultaria
 *   POST /legalizacao/alvaras-consulta-local → { cliente_id, resultado } (saída do scraper)
 */
function tokenSyncOk(req, res) {
  const esperado = process.env.LEGALIZACAO_SYNC_TOKEN || process.env.CERTISEGURO_SYNC_TOKEN;
  if (!esperado) { res.status(503).json({ error: 'Sincronização não configurada no servidor.' }); return false; }
  if (req.get('X-Sync-Token') !== esperado) { res.status(401).json({ error: 'Token de sincronização inválido.' }); return false; }
  return true;
}

router.get('/legalizacao/alvaras-a-consultar', async (req, res) => {
  try {
    if (!tokenSyncOk(req, res)) return;
    await ensureLegalizacaoSchema();
    // ?ibge=<código> limita a uma cidade; ?forcar=1 ignora "consultado há pouco" (ex.: cidade que acabou de ganhar consulta própria).
    const ibges = req.query.ibge ? IBGES_INTEGRADOS.filter(i => i === String(req.query.ibge)) : IBGES_INTEGRADOS;
    const recencia = req.query.forcar === '1' ? 'TRUE' : `(
                a.ultima_consulta_em IS NULL
             OR ((a.data_vencimento IS NOT NULL OR a.ultima_consulta_status = 'solicitacao_andamento')
                 AND a.ultima_consulta_em < NOW() - INTERVAL '20 hours')
             OR a.ultima_consulta_em < NOW() - INTERVAL '7 days'
          )`;
    const { rows } = await pool.query(
      `SELECT c.id::text AS cliente_id, c.nome_empresa, c.cnpj, c.municipio_ibge
         FROM clientes c
         LEFT JOIN legalizacao_alvaras a ON a.cliente_id = c.id::text AND a.tipo = 'funcionamento'
        WHERE c.status = 'ativo'
          AND c.municipio_ibge = ANY($1::text[])
          AND length(regexp_replace(COALESCE(c.cnpj, ''), '\\D', '', 'g')) = 14
          AND (a.data_vencimento IS NULL OR a.data_vencimento <= CURRENT_DATE)
          AND ${recencia}
        ORDER BY a.ultima_consulta_em ASC NULLS FIRST, c.nome_empresa`, [ibges]
    );
    res.json({ data: rows });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro ao listar empresas.' }); }
});

/**
 * Grava a inscrição municipal lida de uma fonte automática (PDF de alvará, certidão da prefeitura) SÓ se o campo estiver vazio
 * — o que alguém digitou à mão nunca é sobrescrito. Devolve true se gravou.
 */
async function guardarInscricaoSeVazia(clienteId, valor) {
  const v = String(valor || '').trim();
  if (!v || v.length < 3 || v.length > 30 || /[^0-9A-Za-z.\-\/ ]/.test(v)) return false;
  await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS inscricao_municipal TEXT`).catch(() => {});
  const r = await pool.query(`UPDATE clientes SET inscricao_municipal = $1 WHERE id::text = $2 AND (inscricao_municipal IS NULL OR inscricao_municipal = '')`, [v, clienteId]);
  return r.rowCount > 0;
}

/** POST /legalizacao/inscricao-municipal-arquivo → { cliente_id, inscricao_municipal } — leitor de pastas (X-Sync-Token); só grava se vazio. */
router.post('/legalizacao/inscricao-municipal-arquivo', async (req, res) => {
  try {
    if (!tokenSyncOk(req, res)) return;
    const { cliente_id, inscricao_municipal } = req.body || {};
    if (!cliente_id || !inscricao_municipal) return res.status(400).json({ error: 'cliente_id e inscricao_municipal são obrigatórios.' });
    res.json({ ok: true, gravou: await guardarInscricaoSeVazia(String(cliente_id), inscricao_municipal) });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro ao gravar a inscrição municipal.' }); }
});

/**
 * HONORÁRIOS DO OMIE → Gestão de Clientes (Reysner, 21/09/2026). Recebe, por CNPJ/CPF, o honorário atual da categoria
 * "SERVIÇOS HONORÁRIOS CONTÁBEIS" do Omie (já descontada a fração de outras categorias do mesmo título) e grava em `honorarios`
 * (histórico — nunca sobrescreve). Cliente do Omie sem cadastro na Carteira é criado com a observação "Não há cadastro no Acessórias".
 *   POST /gestao/honorarios-omie  (X-Sync-Token) → { itens:[{cnpj, nome, valor, mes, desde}], aplicar:false, aplicarDiferentes:false }
 * Sem `aplicar` só simula e devolve o que faria. Honorário diferente do já cadastrado só é trocado com `aplicarDiferentes`.
 */
const formatarDocumento = (d) => d.length === 14 ? d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5') : d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
router.post('/gestao/honorarios-omie', async (req, res) => {
  try {
    if (!tokenSyncOk(req, res)) return;
    const { itens, aplicar, aplicarDiferentes } = req.body || {};
    if (!Array.isArray(itens) || !itens.length) return res.status(400).json({ error: 'Envie os itens.' });
    const admin = (await pool.query(`SELECT id FROM users WHERE role = 'administrador' ORDER BY created_at ASC LIMIT 1`)).rows[0];
    const r = { total: itens.length, preencher: [], igual: 0, diferente: [], inativoNaCarteira: [], semCadastro: [], erros: [] };
    for (const it of itens) {
      try {
        const doc = String(it.cnpj || '').replace(/\D/g, '');
        const valor = Math.round((+it.valor || 0) * 100) / 100;
        if (![11, 14].includes(doc.length) || valor <= 0 || !/^\d{4}-\d{2}$/.test(String(it.mes || ''))) { r.erros.push({ doc, motivo: 'dado inválido' }); continue; }
        const vig = it.mes + '-01';
        const obsHon = `Omie — SERVIÇOS HONORÁRIOS CONTÁBEIS (${it.mes.split('-').reverse().join('/')})`;
        const { rows } = await pool.query(
          `SELECT c.id, c.nome_empresa, c.status,
                  (SELECT valor FROM honorarios h WHERE h.cliente_id = c.id ORDER BY data_vigencia DESC LIMIT 1) AS atual
             FROM clientes c WHERE regexp_replace(c.cnpj, '\\D', '', 'g') = $1
            ORDER BY (c.status = 'ativo') DESC, c.created_at DESC LIMIT 1`, [doc]);
        const c = rows[0];
        if (c && c.status !== 'ativo') { r.inativoNaCarteira.push({ doc, nome: it.nome, carteira: c.nome_empresa, status: c.status, valor }); continue; }
        if (c) {
          const atual = c.atual != null ? parseFloat(c.atual) : null;
          if (atual != null && atual > 0 && Math.abs(atual - valor) < 0.005) { r.igual++; continue; }
          const registro = { doc, nome: c.nome_empresa, atual, valor, mes: it.mes };
          if (atual != null && atual > 0) {
            r.diferente.push(registro);
            if (!(aplicar && aplicarDiferentes)) continue;
          } else r.preencher.push(registro);
          if (aplicar) {
            await pool.query(`INSERT INTO honorarios (cliente_id, valor, data_vigencia, obs) VALUES ($1,$2,$3,$4)`, [c.id, valor, vig, obsHon]);
            if (atual != null && atual > 0) await pool.query(`INSERT INTO eventos_clientes (cliente_id, tipo, descricao, valor_anterior, valor_novo, data_evento) VALUES ($1,'reajuste','Honorário atualizado a partir do Omie',$2,$3,$4)`, [c.id, atual, valor, vig]);
          }
          continue;
        }
        r.semCadastro.push({ doc, nome: it.nome, valor, mes: it.mes });
        if (aplicar) {
          const id = uuidv4(); const docF = formatarDocumento(doc);
          const desde = /^\d{4}-\d{2}$/.test(String(it.desde || '')) ? it.desde + '-01' : vig;
          await pool.query(
            `INSERT INTO clientes (id, user_id, cnpj, nome_empresa, data_entrada, origem, obs, status) VALUES ($1,$2,$3,$4,$5,'Omie (sem Acessórias)','Não há cadastro no Acessórias','ativo')`,
            [id, admin.id, docF, it.nome, desde]);
          await pool.query(`INSERT INTO honorarios (cliente_id, valor, data_vigencia, obs) VALUES ($1,$2,$3,$4)`, [id, valor, vig, obsHon]);
          await pool.query(
            `INSERT INTO gestao_clientes (id, user_id, analista, solicitacao, cnpj, empresa, data_sol, competencia, canal, motivo)
             VALUES ($1,$2,'Importação Omie','Cliente vindo de outro contador',$3,$4,$5,$6,'Outro','Não há cadastro no Acessórias')`,
            [uuidv4(), admin.id, docF, it.nome, null, null]);
        }
      } catch (e) { r.erros.push({ doc: it.cnpj, motivo: e.message }); }
    }
    res.json({ aplicado: !!aplicar, ...r, contagem: { preencher: r.preencher.length, igual: r.igual, diferente: r.diferente.length, inativoNaCarteira: r.inativoNaCarteira.length, semCadastro: r.semCadastro.length, erros: r.erros.length } });
  } catch (err) { console.error('[Honorários Omie]', err); res.status(500).json({ error: 'Erro ao processar os honorários do Omie.' }); }
});

/**
 * MÓDULO FINANCEIRO (Reysner, 21/09/2026): honorário atual por cliente e por UNIDADE (Soluções Escritorial agora; Escritorial depois),
 * ticket médio, faixa (acima/na média/abaixo) e inadimplência, a partir do Omie.
 *   POST /financeiro/importar (X-Sync-Token) → { unidade, fonte, clientes:[{cnpj,nome,valor,vigencia}], abertos:[{cnpj,nome,qtd,aberto,atrasado,qtdAtrasados,maisAntigo}] }
 *        substitui os dados daquela unidade (snapshot do Omie).
 *   GET  /financeiro?unidade=  (admin) → resumo (ticket médio etc.) + lista de clientes com faixa e inadimplência.
 */
async function ensureFinanceiroSchema() {
  await pool.query(`CREATE TABLE IF NOT EXISTS financeiro_clientes (
    unidade TEXT NOT NULL, cnpj TEXT NOT NULL, nome TEXT, honorario_atual NUMERIC(14,2) NOT NULL, vigencia DATE,
    PRIMARY KEY (unidade, cnpj))`).catch(() => {});
  await pool.query(`CREATE TABLE IF NOT EXISTS financeiro_aberto (
    unidade TEXT NOT NULL, cnpj TEXT NOT NULL, nome TEXT, qtd INT NOT NULL DEFAULT 0, valor_aberto NUMERIC(14,2) NOT NULL DEFAULT 0,
    valor_atrasado NUMERIC(14,2) NOT NULL DEFAULT 0, qtd_atrasados INT NOT NULL DEFAULT 0, mais_antigo DATE,
    PRIMARY KEY (unidade, cnpj))`).catch(() => {});
  await pool.query(`CREATE TABLE IF NOT EXISTS financeiro_importacoes (
    id SERIAL PRIMARY KEY, unidade TEXT NOT NULL, fonte TEXT, importado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(), total_clientes INT, total_abertos INT)`).catch(() => {});
}

router.post('/financeiro/importar', async (req, res) => {
  const client = await pool.connect();
  try {
    if (!tokenSyncOk(req, res)) return;
    const { unidade, fonte, clientes, abertos } = req.body || {};
    if (!unidade || !Array.isArray(clientes) || !Array.isArray(abertos)) return res.status(400).json({ error: 'Informe unidade, clientes e abertos.' });
    await ensureFinanceiroSchema();
    const so = (s) => String(s || '').replace(/\D/g, '');
    await client.query('BEGIN');
    await client.query(`DELETE FROM financeiro_clientes WHERE unidade = $1`, [unidade]);
    await client.query(`DELETE FROM financeiro_aberto WHERE unidade = $1`, [unidade]);
    for (const c of clientes) {
      const doc = so(c.cnpj); const v = Math.round((+c.valor || 0) * 100) / 100;
      if (![11, 14].includes(doc.length) || v <= 0) continue;
      await client.query(`INSERT INTO financeiro_clientes (unidade, cnpj, nome, honorario_atual, vigencia) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (unidade, cnpj) DO UPDATE SET nome = $3, honorario_atual = $4, vigencia = $5`,
        [unidade, doc, String(c.nome || '').slice(0, 200), v, /^\d{4}-\d{2}(-\d{2})?$/.test(c.vigencia || '') ? (c.vigencia.length === 7 ? c.vigencia + '-01' : c.vigencia) : null]);
    }
    for (const a of abertos) {
      const doc = so(a.cnpj); if (![11, 14].includes(doc.length)) continue;
      await client.query(`INSERT INTO financeiro_aberto (unidade, cnpj, nome, qtd, valor_aberto, valor_atrasado, qtd_atrasados, mais_antigo) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (unidade, cnpj) DO UPDATE SET nome=$3, qtd=$4, valor_aberto=$5, valor_atrasado=$6, qtd_atrasados=$7, mais_antigo=$8`,
        [unidade, doc, String(a.nome || '').slice(0, 200), parseInt(a.qtd, 10) || 0, +a.aberto || 0, +a.atrasado || 0, parseInt(a.qtdAtrasados, 10) || 0, /^\d{4}-\d{2}-\d{2}$/.test(a.maisAntigo || '') ? a.maisAntigo : null]);
    }
    await client.query(`INSERT INTO financeiro_importacoes (unidade, fonte, total_clientes, total_abertos) VALUES ($1,$2,$3,$4)`, [unidade, fonte || 'Omie', clientes.length, abertos.length]);
    await client.query('COMMIT');
    // Carteira alimentada pelo Financeiro: honorário em vigor no Omie vira o honorário atual do cliente ATIVO (nova linha em
    // `honorarios`, histórico/receita acumulada intactos). Status quem manda é o Acessórias: encerrado lá não é reativado, só listado.
    const carteira = { atualizados: 0, iguais: 0, encerradosFaturando: [], erros: 0 };
    for (const c of clientes) {
      try {
        const doc = so(c.cnpj); const v = Math.round((+c.valor || 0) * 100) / 100;
        if (![11, 14].includes(doc.length) || v <= 0) continue;
        const { rows } = await pool.query(
          `SELECT c.id, c.nome_empresa, c.status,
                  (SELECT valor FROM honorarios h WHERE h.cliente_id = c.id ORDER BY data_vigencia DESC LIMIT 1) AS atual,
                  (SELECT MAX(data_vigencia) FROM honorarios h WHERE h.cliente_id = c.id) AS ultima
             FROM clientes c WHERE regexp_replace(c.cnpj, '\\D', '', 'g') = $1
            ORDER BY (c.status = 'ativo') DESC, c.created_at DESC LIMIT 1`, [doc]);
        const cli = rows[0];
        if (!cli) continue; // sem cadastro: /gestao/honorarios-omie cria
        if (cli.status !== 'ativo') { carteira.encerradosFaturando.push({ nome: cli.nome_empresa, valor: v }); continue; }
        const atual = cli.atual != null ? parseFloat(cli.atual) : null;
        if (atual != null && Math.abs(atual - v) < 0.005) { carteira.iguais++; continue; }
        const mesOmie = /^\d{4}-\d{2}(-\d{2})?$/.test(c.vigencia || '') ? String(c.vigencia).slice(0, 7) + '-01' : null;
        const hoje1 = new Date().toISOString().slice(0, 7) + '-01';
        const ultima = cli.ultima ? new Date(cli.ultima).toISOString().slice(0, 10) : null;
        const vig = mesOmie && (!ultima || mesOmie >= ultima) ? mesOmie : (ultima && ultima > hoje1 ? ultima : hoje1);
        await pool.query(`INSERT INTO honorarios (cliente_id, valor, data_vigencia, obs) VALUES ($1,$2,$3,$4)`, [cli.id, v, vig, `Financeiro/Omie — ${unidade}`]);
        if (atual != null && atual > 0) await pool.query(`INSERT INTO eventos_clientes (cliente_id, tipo, descricao, valor_anterior, valor_novo, data_evento) VALUES ($1,'reajuste',$2,$3,$4,$5)`, [cli.id, `Honorário atualizado pelo Financeiro (${unidade})`, atual, v, vig]);
        carteira.atualizados++;
      } catch (e) { carteira.erros++; console.error('[Financeiro→Carteira]', e.message); }
    }
    res.json({ ok: true, unidade, clientes: clientes.length, abertos: abertos.length, carteira });
  } catch (err) { await client.query('ROLLBACK').catch(() => {}); console.error('[Financeiro] importar:', err); res.status(500).json({ error: 'Erro ao importar o financeiro.' }); }
  finally { client.release(); }
});

// (rota de máquina: fica ANTES do requireAuth, autenticada só pelo X-Sync-Token)
router.post('/legalizacao/saude-rotina', async (req, res) => {
  try {
    if (!tokenSyncOk(req, res)) return;
    await ensureLegalizacaoSchema();
    const { rotina, inicio, total, ok, falhas, resumo, por_cidade } = req.body || {};
    if (!ROTINAS_LEGALIZACAO[rotina]) return res.status(400).json({ error: 'Rotina desconhecida.' });
    await pool.query(
      `INSERT INTO legalizacao_rotinas (rotina, inicio, total, ok, falhas, resumo, por_cidade) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)`,
      [rotina, inicio || null, parseInt(total, 10) || 0, parseInt(ok, 10) || 0, parseInt(falhas, 10) || 0, JSON.stringify(resumo || {}), JSON.stringify(por_cidade || {})]
    );
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro ao registrar a rotina.' }); }
});

router.post('/legalizacao/alvaras-consulta-local', async (req, res) => {
  try {
    if (!tokenSyncOk(req, res)) return;
    const { cliente_id, resultado } = req.body || {};
    if (!cliente_id || !resultado || typeof resultado !== 'object') return res.status(400).json({ error: 'cliente_id e resultado são obrigatórios.' });
    await ensureLegalizacaoSchema();
    const { rows } = await pool.query(`SELECT 1 FROM clientes WHERE id::text = $1`, [String(cliente_id)]);
    if (!rows.length) return res.status(404).json({ error: 'Cliente não encontrado.' });
    const r = await gravarResultadoConsultaAlvara(String(cliente_id), 'funcionamento', resultado, 'Consulta local (escritório)');
    if (resultado.inscricaoMunicipal) await guardarInscricaoSeVazia(String(cliente_id), resultado.inscricaoMunicipal); // ex.: C.M.C. do PDF de Uberlândia
    res.json(r);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro ao gravar a consulta.' }); }
});

/**
 * Sanitário "exige, não localizado": pelo CNAE do cartão CNPJ (clientes.cnaes, ver municipioCnpj.js) estima se a
 * atividade exige alvará sanitário (legalizacao/sanitario.js). Quem exige e NÃO tem data de vencimento ganha uma linha de
 * alvará sanitário "sem data" com a observação "Exige alvará sanitário (CNAE …) — não localizado." (só observações
 * automáticas são reescritas/limpas; texto escrito por gente nunca é tocado). Quando a data aparece (Redesim, pasta do
 * servidor, prefeitura), a observação automática some sozinha.
 */
const { avaliarExigenciaSanitaria, textoExigencia, PADRAO_OBS_AUTOMATICA } = require('../legalizacao/sanitario');

async function atualizarObservacaoSanitaria() {
  await ensureLegalizacaoSchema();
  const { rows } = await pool.query(
    `SELECT c.id::text AS cliente_id, c.cnaes, a.id AS alvara_id, a.data_vencimento, a.observacoes, a.desativado_em,
            a.ultima_consulta_status, a.criado_por
       FROM clientes c
       LEFT JOIN legalizacao_alvaras a ON a.cliente_id = c.id::text AND a.tipo = 'sanitario'
      WHERE c.status = 'ativo' AND c.cnaes IS NOT NULL`
  );
  let marcadas = 0, limpas = 0, exigem = 0;
  for (const r of rows) {
    if (r.desativado_em) continue;
    const obsAuto = PADRAO_OBS_AUTOMATICA.test(r.observacoes || '');
    if (r.data_vencimento) {
      if (obsAuto) { await pool.query(`UPDATE legalizacao_alvaras SET observacoes = NULL WHERE id = $1`, [r.alvara_id]); limpas++; }
      continue;
    }
    const av = avaliarExigenciaSanitaria(Array.isArray(r.cnaes) ? r.cnaes : []);
    if (av.exige) {
      exigem++;
      const texto = textoExigencia(av);
      if (!r.alvara_id) {
        await pool.query(
          `INSERT INTO legalizacao_alvaras (cliente_id, tipo, observacoes, criado_por) VALUES ($1,'sanitario',$2,'Avaliação CNAE')
           ON CONFLICT (cliente_id, tipo) DO NOTHING`, [r.cliente_id, texto]);
        marcadas++;
      } else if ((!r.observacoes || obsAuto) && r.observacoes !== texto) {
        await pool.query(`UPDATE legalizacao_alvaras SET observacoes = $2 WHERE id = $1`, [r.alvara_id, texto]);
        marcadas++;
      }
    } else if (obsAuto && r.alvara_id) {
      if (r.criado_por === 'Avaliação CNAE' && !r.ultima_consulta_status) await pool.query(`DELETE FROM legalizacao_alvaras WHERE id = $1`, [r.alvara_id]);
      else await pool.query(`UPDATE legalizacao_alvaras SET observacoes = NULL WHERE id = $1`, [r.alvara_id]);
      limpas++;
    }
  }
  return { avaliadas: rows.length, exigem, marcadas, limpas };
}

/**
 * Rotas do script que lê os PDFs de alvará das pastas do servidor (legalizacao/lerAlvarasPasta.js):
 *   GET  /legalizacao/clientes-ativos     → empresas ativas (id, nome, cnpj)
 *   POST /legalizacao/alvaras-arquivo     → { cliente_id, tipo, vencimento (AAAA-MM-DD), numero, arquivo }
 *   POST /legalizacao/sanitario-avaliar   → reavalia "exige, não localizado" (chamar depois de um lote)
 */
router.get('/legalizacao/clientes-ativos', async (req, res) => {
  try {
    if (!tokenSyncOk(req, res)) return;
    const { rows } = await pool.query(
      `SELECT id::text AS cliente_id, nome_empresa, cnpj, municipio_ibge, inscricao_municipal FROM clientes
        WHERE status = 'ativo' AND length(regexp_replace(COALESCE(cnpj, ''), '\\D', '', 'g')) = 14 ORDER BY nome_empresa`
    );
    res.json({ data: rows });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro ao listar empresas.' }); }
});

router.post('/legalizacao/alvaras-arquivo', async (req, res) => {
  try {
    if (!tokenSyncOk(req, res)) return;
    await ensureLegalizacaoSchema();
    const { cliente_id, tipo, vencimento, numero, arquivo, ocr, caminho, trecho } = req.body || {};
    if (!cliente_id || !['funcionamento', 'sanitario'].includes(tipo) || !/^\d{4}-\d{2}-\d{2}$/.test(String(vencimento || ''))) {
      return res.status(400).json({ error: 'cliente_id, tipo e vencimento (AAAA-MM-DD) são obrigatórios.' });
    }
    const { rows: cli } = await pool.query(`SELECT 1 FROM clientes WHERE id::text = $1`, [String(cliente_id)]);
    if (!cli.length) return res.status(404).json({ error: 'Cliente não encontrado.' });
    const br = String(vencimento).split('-').reverse().join('/');
    const resumo = `Lido do PDF na pasta do servidor: ${String(arquivo || 'alvará').slice(0, 90)} (vence ${br}).`;
    const r = await pool.query(
      `INSERT INTO legalizacao_alvaras (cliente_id, tipo, data_vencimento, numero, ultima_consulta_status, ultima_consulta_resumo, ultima_consulta_em, criado_por, lido_por_ocr, origem_arquivo, trecho_lido)
       VALUES ($1,$2,$3::date,$4,NULL,$5,NOW(),'Pasta do servidor',$6,$7,$8)
       ON CONFLICT (cliente_id, tipo) DO UPDATE SET
         lido_por_ocr = CASE WHEN legalizacao_alvaras.data_vencimento IS NULL OR legalizacao_alvaras.data_vencimento < $3::date THEN $6 ELSE legalizacao_alvaras.lido_por_ocr END,
         origem_arquivo = CASE WHEN legalizacao_alvaras.data_vencimento IS NULL OR legalizacao_alvaras.data_vencimento < $3::date THEN $7 ELSE legalizacao_alvaras.origem_arquivo END,
         trecho_lido = CASE WHEN legalizacao_alvaras.data_vencimento IS NULL OR legalizacao_alvaras.data_vencimento < $3::date THEN $8
                            WHEN legalizacao_alvaras.data_vencimento = $3::date AND legalizacao_alvaras.trecho_lido IS NULL AND legalizacao_alvaras.lido_por_ocr THEN $8
                            ELSE legalizacao_alvaras.trecho_lido END,
         conferido_em = CASE WHEN legalizacao_alvaras.data_vencimento IS NULL OR legalizacao_alvaras.data_vencimento < $3::date THEN NULL ELSE legalizacao_alvaras.conferido_em END,
         conferido_por = CASE WHEN legalizacao_alvaras.data_vencimento IS NULL OR legalizacao_alvaras.data_vencimento < $3::date THEN NULL ELSE legalizacao_alvaras.conferido_por END,
         numero = CASE WHEN legalizacao_alvaras.data_vencimento IS NULL OR legalizacao_alvaras.data_vencimento < $3::date THEN COALESCE($4, legalizacao_alvaras.numero) ELSE legalizacao_alvaras.numero END,
         ultima_consulta_resumo = CASE WHEN legalizacao_alvaras.data_vencimento IS NULL OR legalizacao_alvaras.data_vencimento < $3::date THEN $5 ELSE legalizacao_alvaras.ultima_consulta_resumo END,
         ultima_consulta_status = CASE WHEN legalizacao_alvaras.data_vencimento IS NULL OR legalizacao_alvaras.data_vencimento < $3::date THEN NULL ELSE legalizacao_alvaras.ultima_consulta_status END,
         notificado_vencimento_em = CASE WHEN legalizacao_alvaras.data_vencimento IS NULL OR legalizacao_alvaras.data_vencimento < $3::date THEN NULL ELSE legalizacao_alvaras.notificado_vencimento_em END,
         data_vencimento = CASE WHEN legalizacao_alvaras.data_vencimento IS NULL OR legalizacao_alvaras.data_vencimento < $3::date THEN $3::date ELSE legalizacao_alvaras.data_vencimento END,
         atualizado_em = NOW()
       WHERE legalizacao_alvaras.desativado_em IS NULL
       RETURNING (legalizacao_alvaras.data_vencimento = $3::date) AS gravou`,
      [String(cliente_id), tipo, vencimento, numero ? String(numero).slice(0, 60) : null, resumo,
       !!ocr, caminho ? String(caminho).slice(0, 400) : null, trecho ? String(trecho).slice(0, 300) : null]
    );
    res.json({ ok: true, gravou: !!(r.rows[0] && r.rows[0].gravou) });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro ao gravar o alvará lido da pasta.' }); }
});

/** POST /legalizacao/cnaes-completar — dispara em segundo plano o preenchimento de município/CNAEs que faltam (e reavalia o sanitário no fim). */
router.post('/legalizacao/cnaes-completar', async (req, res) => {
  if (!tokenSyncOk(req, res)) return;
  completarMunicipiosClientes({ limite: 700 }).then((r) => console.log('[Município/CNAE] Rodada manual:', r)).catch((e) => console.error('[Município/CNAE] Falha:', e.message));
  res.json({ ok: true, iniciado: true });
});

router.post('/legalizacao/sanitario-avaliar', async (req, res) => {
  try {
    if (!tokenSyncOk(req, res)) return;
    res.json({ ok: true, ...(await atualizarObservacaoSanitaria()) });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro ao avaliar exigência sanitária.' }); }
});

/**
 * Licenciamento pela REDESIM MG (Portal de Serviços da JUCEMG) — o script do Tampermonkey
 * (public/tools/sincronizar-redesim.user.js) roda no Chrome do escritório, logado no gov.br, e por
 * CNPJ lê os órgãos que licenciam a empresa (Vigilância Sanitária municipal = alvará SANITÁRIO, com
 * "Validade"; Prefeitura = número do alvará de FUNCIONAMENTO emitido pela Redesim/SINAL).
 *   GET  /legalizacao/redesim-a-consultar  → empresas mineiras ativas ainda não conferidas (últimos 7 dias)
 *   POST /legalizacao/redesim-resultado    → { cliente_id, cnpj, orgaos: [...], sem_licenciamento, nao_encontrado }
 */
router.get('/legalizacao/redesim-a-consultar', async (req, res) => {
  try {
    if (!tokenSyncOk(req, res)) return;
    await ensureLegalizacaoSchema();
    const limite = Math.min(parseInt(req.query.limite, 10) || 40, 200);
    const { rows } = await pool.query(
      `SELECT c.id::text AS cliente_id, c.nome_empresa, c.cnpj
         FROM clientes c
         LEFT JOIN legalizacao_redesim r ON r.cliente_id = c.id::text
        WHERE c.status = 'ativo'
          AND (c.municipio_ibge LIKE '31%' OR upper(COALESCE(c.uf, '')) = 'MG')
          AND length(regexp_replace(COALESCE(c.cnpj, ''), '\\D', '', 'g')) = 14
          AND (r.consultado_em IS NULL OR r.consultado_em < NOW() - INTERVAL '7 days')
        ORDER BY r.consultado_em ASC NULLS FIRST, c.nome_empresa
        LIMIT $1`, [limite]
    );
    res.json({ data: rows });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro ao listar empresas.' }); }
});

/** GET /legalizacao/redesim-resumo — conferência do que o script da Redesim já mandou (só leitura). ?cidade=UBERABA lista os detalhes. */
router.get('/legalizacao/redesim-resumo', async (req, res) => {
  try {
    if (!tokenSyncOk(req, res)) return;
    await ensureLegalizacaoSchema();
    const { rows: tot } = await pool.query(`SELECT count(*)::int AS total,
        count(*) FILTER (WHERE sem_licenciamento)::int AS sem_licenciamento,
        count(*) FILTER (WHERE nao_encontrado)::int AS nao_encontrado,
        count(*) FILTER (WHERE jsonb_array_length(COALESCE(dados, '[]'::jsonb)) > 0)::int AS com_orgaos
      FROM legalizacao_redesim`);
    const cidade = req.query.cidade ? String(req.query.cidade).toUpperCase() : null;
    const { rows: det } = await pool.query(
      `SELECT c.nome_empresa, c.municipio, r.sem_licenciamento, r.nao_encontrado, r.dados
         FROM legalizacao_redesim r JOIN clientes c ON c.id::text = r.cliente_id
        WHERE ($1::text IS NULL OR upper(c.municipio) = $1) AND ($1::text IS NOT NULL OR jsonb_array_length(COALESCE(r.dados, '[]'::jsonb)) > 0)
        ORDER BY c.nome_empresa LIMIT 60`, [cidade]
    );
    const { rows: porCidade } = await pool.query(
      `SELECT upper(COALESCE(c.municipio, '?')) AS municipio, count(*)::int AS consultadas,
              count(*) FILTER (WHERE jsonb_array_length(COALESCE(r.dados, '[]'::jsonb)) > 0)::int AS com_orgaos
         FROM legalizacao_redesim r JOIN clientes c ON c.id::text = r.cliente_id GROUP BY 1 ORDER BY 2 DESC LIMIT 30`
    );
    res.json({ totais: tot[0], porCidade, detalhes: det });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro no resumo.' }); }
});

/**
 * Aplica o que a Redesim mostrou de uma empresa aos alvarás do Grupo-E:
 *   - Vigilância Sanitária (concluído + validade)  → alvará SANITÁRIO com a data;
 *   - Prefeitura (concluído): nº do alvará de FUNCIONAMENTO; e, se veio uma validade FUTURA, a data também —
 *     só quando não há data ou a que existe é mais antiga (nunca rebaixa uma data já preenchida por outra fonte;
 *     validade já vencida da Redesim não vira "vencido": pode haver alvará mais novo em outro processo).
 * Item desativado (desativado_em) nunca é alterado.
 */
async function aplicarResultadoRedesim(clienteId, lista) {
  const brParaIso = (d) => { const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(d || '').trim()); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };
  const hoje = new Date().toISOString().slice(0, 10);
  let sanitario = null, funcionamento = null;

  for (const o of lista) {
    const nome = String(o.orgao || '').toUpperCase();
    const concluido = /CONCLU/i.test(String(o.situacao || ''));
    const iso = brParaIso(o.validade);
    if (/SA[UÚ]DE|VIGIL/.test(nome) && concluido && iso) {
      const resumo = `Redesim/JUCEMG — ${o.documento || 'Licenciamento sanitário'} (validade ${o.validade})${o.risco ? ' · ' + o.risco : ''}.`;
      await pool.query(
        `INSERT INTO legalizacao_alvaras (cliente_id, tipo, data_vencimento, ultima_consulta_status, ultima_consulta_resumo, ultima_consulta_em, criado_por)
         VALUES ($1,'sanitario',$2::date,NULL,$3,NOW(),'Redesim/JUCEMG')
         ON CONFLICT (cliente_id, tipo) DO UPDATE SET
           data_vencimento = $2::date, ultima_consulta_status = NULL, ultima_consulta_resumo = $3,
           ultima_consulta_em = NOW(), atualizado_em = NOW(),
           notificado_vencimento_em = CASE WHEN $2::date IS DISTINCT FROM legalizacao_alvaras.data_vencimento THEN NULL ELSE legalizacao_alvaras.notificado_vencimento_em END
         WHERE legalizacao_alvaras.desativado_em IS NULL`,
        [clienteId, iso, resumo]
      );
      sanitario = iso;
    } else if (/PREFEITURA|ALVAR[AÁ]/.test(nome) && concluido && (o.alvara || iso)) {
      const futura = iso && iso > hoje ? iso : null;
      const numero = o.alvara ? String(o.alvara).slice(0, 60) : null;
      const resumo = futura
        ? `Redesim/JUCEMG — alvará de funcionamento ${numero || ''} (validade ${o.validade}).`
        : `Redesim/JUCEMG — alvará de funcionamento ${numero || ''} emitido${iso ? ' (validade ' + o.validade + ')' : ' (validade a confirmar no documento do SINAL)'}.`;
      await pool.query(
        `INSERT INTO legalizacao_alvaras (cliente_id, tipo, numero, data_vencimento, ultima_consulta_resumo, ultima_consulta_em, criado_por)
         VALUES ($1,'funcionamento',$2,$4::date,$3,NOW(),'Redesim/JUCEMG')
         ON CONFLICT (cliente_id, tipo) DO UPDATE SET
           numero = CASE WHEN legalizacao_alvaras.data_vencimento IS NULL OR legalizacao_alvaras.data_vencimento < COALESCE($4::date, DATE '0001-01-01') THEN COALESCE($2, legalizacao_alvaras.numero) ELSE legalizacao_alvaras.numero END,
           ultima_consulta_resumo = CASE WHEN legalizacao_alvaras.data_vencimento IS NULL OR legalizacao_alvaras.data_vencimento < COALESCE($4::date, DATE '0001-01-01') THEN $3 ELSE legalizacao_alvaras.ultima_consulta_resumo END,
           notificado_vencimento_em = CASE WHEN $4::date IS NOT NULL AND (legalizacao_alvaras.data_vencimento IS NULL OR legalizacao_alvaras.data_vencimento < $4::date) THEN NULL ELSE legalizacao_alvaras.notificado_vencimento_em END,
           ultima_consulta_status = CASE WHEN $4::date IS NOT NULL AND (legalizacao_alvaras.data_vencimento IS NULL OR legalizacao_alvaras.data_vencimento < $4::date) THEN NULL ELSE legalizacao_alvaras.ultima_consulta_status END,
           data_vencimento = CASE WHEN $4::date IS NOT NULL AND (legalizacao_alvaras.data_vencimento IS NULL OR legalizacao_alvaras.data_vencimento < $4::date) THEN $4::date ELSE legalizacao_alvaras.data_vencimento END,
           ultima_consulta_em = NOW()
         WHERE legalizacao_alvaras.desativado_em IS NULL`,
        [clienteId, numero, resumo, futura]
      );
      funcionamento = futura || numero;
    }
  }
  return { sanitario, funcionamento };
}

/** POST /legalizacao/redesim-reprocessar — reaplica os dados já guardados (sem consultar o portal de novo). */
router.post('/legalizacao/redesim-reprocessar', async (req, res) => {
  try {
    if (!tokenSyncOk(req, res)) return;
    await ensureLegalizacaoSchema();
    const { rows } = await pool.query(
      `SELECT r.cliente_id, r.dados FROM legalizacao_redesim r JOIN clientes c ON c.id::text = r.cliente_id
        WHERE c.status = 'ativo' AND jsonb_array_length(COALESCE(r.dados, '[]'::jsonb)) > 0`
    );
    let sanitarios = 0, funcionamentos = 0;
    for (const r of rows) {
      const a = await aplicarResultadoRedesim(r.cliente_id, Array.isArray(r.dados) ? r.dados : []);
      if (a.sanitario) sanitarios++;
      if (a.funcionamento) funcionamentos++;
    }
    res.json({ ok: true, empresas: rows.length, sanitarios, funcionamentos });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro ao reprocessar.' }); }
});

router.post('/legalizacao/redesim-resultado', async (req, res) => {
  try {
    if (!tokenSyncOk(req, res)) return;
    await ensureLegalizacaoSchema();
    const { cliente_id, orgaos, sem_licenciamento, nao_encontrado } = req.body || {};
    if (!cliente_id) return res.status(400).json({ error: 'cliente_id é obrigatório.' });
    const { rows: cli } = await pool.query(`SELECT 1 FROM clientes WHERE id::text = $1`, [String(cliente_id)]);
    if (!cli.length) return res.status(404).json({ error: 'Cliente não encontrado.' });
    const lista = Array.isArray(orgaos) ? orgaos.slice(0, 20) : [];
    const { sanitario, funcionamento } = await aplicarResultadoRedesim(String(cliente_id), lista);

    await pool.query(
      `INSERT INTO legalizacao_redesim (cliente_id, consultado_em, dados, sem_licenciamento, nao_encontrado)
       VALUES ($1, NOW(), $2::jsonb, $3, $4)
       ON CONFLICT (cliente_id) DO UPDATE SET consultado_em = NOW(), dados = $2::jsonb, sem_licenciamento = $3, nao_encontrado = $4`,
      [String(cliente_id), JSON.stringify(lista), !!sem_licenciamento, !!nao_encontrado]
    );
    res.json({ ok: true, sanitario, funcionamento });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro ao gravar a consulta da Redesim.' }); }
});

router.post('/legalizacao/certificados/importar-certiseguro', async (req, res) => {
  try {
    const tokenEsperado = process.env.CERTISEGURO_SYNC_TOKEN;
    if (!tokenEsperado) return res.status(503).json({ error: 'Sincronização CertiSeguro não configurada (variável CERTISEGURO_SYNC_TOKEN ausente no servidor).' });
    if (req.get('X-Sync-Token') !== tokenEsperado) return res.status(401).json({ error: 'Token de sincronização inválido.' });

    await ensureLegalizacaoSchema();
    const lista = Array.isArray(req.body.certificados) ? req.body.certificados : [];
    let atualizados = 0, criados = 0, ignorados = 0;

    for (const item of lista) {
      const doc = String(item.cnpj || item.documento || '').replace(/\D/g, '');
      const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(item.validade || '').trim());
      if (!doc || !m) { ignorados++; continue; }
      const dataVencimento = `${m[3]}-${m[2]}-${m[1]}`;
      const nome = item.nome_amigavel || item.nome || null;

      if (doc.length === 14) {
        const { rows: cli } = await pool.query(
          `SELECT id, nome_empresa, cnpj FROM clientes WHERE regexp_replace(cnpj, '\\D', '', 'g') = $1 LIMIT 1`, [doc]
        );
        if (cli.length) {
          const clienteId = String(cli[0].id);
          await pool.query(
            `INSERT INTO legalizacao_certificados (cliente_id, tipo, titular_nome, titular_documento, data_vencimento, fonte, criado_por)
             VALUES ($1,'pj',$2,$3,$4,'certiseguro',$5)
             ON CONFLICT (cliente_id) WHERE tipo = 'pj' AND cliente_id IS NOT NULL DO UPDATE SET
               data_vencimento = $4, fonte = 'certiseguro', atualizado_em = NOW(),
               notificado_vencimento_em = CASE WHEN $4 IS DISTINCT FROM legalizacao_certificados.data_vencimento THEN NULL ELSE legalizacao_certificados.notificado_vencimento_em END`,
            [clienteId, cli[0].nome_empresa, cli[0].cnpj, dataVencimento, 'CertiSeguro (sync automático)']
          );
          atualizados++;
          continue;
        }
      }

      // Não bateu com nenhum cliente ativo (ou é CPF) — tenta achar um certificado PF/avulso já cadastrado com esse documento.
      const { rows: existente } = await pool.query(
        `SELECT id FROM legalizacao_certificados WHERE regexp_replace(titular_documento, '\\D', '', 'g') = $1 LIMIT 1`, [doc]
      );
      if (existente.length) {
        await pool.query(
          `UPDATE legalizacao_certificados SET data_vencimento = $2, fonte = 'certiseguro', atualizado_em = NOW(),
             notificado_vencimento_em = CASE WHEN $2 IS DISTINCT FROM data_vencimento THEN NULL ELSE notificado_vencimento_em END
           WHERE id = $1`,
          [existente[0].id, dataVencimento]
        );
        atualizados++;
      } else if (nome) {
        await pool.query(
          `INSERT INTO legalizacao_certificados (cliente_id, tipo, titular_nome, titular_documento, data_vencimento, fonte, criado_por)
           VALUES (NULL,'pf',$1,$2,$3,'certiseguro',$4)`,
          [nome, doc, dataVencimento, 'CertiSeguro (sync automático)']
        );
        criados++;
      } else {
        ignorados++;
      }
    }

    await registrarLog('sync', 'CertiSeguro (sync automático)', 'importar', 'legalizacao',
      `Sincronização CertiSeguro: ${atualizados} atualizado(s), ${criados} criado(s), ${ignorados} ignorado(s) de ${lista.length} certificado(s).`, req);
    res.json({ ok: true, atualizados, criados, ignorados, total: lista.length });
  } catch (err) {
    console.error('[legalizacao] importar-certiseguro falhou:', err);
    res.status(500).json({ error: err.message || 'Erro ao importar certificados da CertiSeguro.' });
  }
});

/**
 * POST /api/data/legalizacao/procuracoes/importar — recebe as procurações
 * RECEBIDAS lidas no e-CAC (Autorizações de Acesso → Recebidas, tipo 'ecac') ou
 * no SPE do FGTS Digital (tipo 'fgts'), com o login pelo certificado do
 * escritório — pedido do Reysner, 18/09/2026. Chamada máquina-a-máquina (token compartilhado, igual ao
 * importar-certiseguro), por isso fica antes do requireAuth. Regras:
 *   - só Ativa (vencimento = Validade) e Expirada (vira "Vencido" pela data);
 *   - Cancelada / Rejeitada / Em Análise = "Sem dados" (ignoradas, não gravam);
 *   - só clientes ATIVOS da Carteira (casa pelo CPF/CNPJ, só dígitos);
 *   - vários registros pro mesmo CNPJ: vale a Ativa de maior validade.
 */
router.post('/legalizacao/procuracoes/importar', async (req, res) => {
  try {
    const tokenEsperado = process.env.LEGALIZACAO_SYNC_TOKEN || process.env.CERTISEGURO_SYNC_TOKEN;
    if (!tokenEsperado) return res.status(503).json({ error: 'Sincronização não configurada (falta LEGALIZACAO_SYNC_TOKEN/CERTISEGURO_SYNC_TOKEN no servidor).' });
    if (req.get('X-Sync-Token') !== tokenEsperado) return res.status(401).json({ error: 'Token de sincronização inválido.' });

    const tipo = req.body.tipo;
    if (!['ecac', 'fgts'].includes(tipo)) return res.status(400).json({ error: "Informe tipo: 'ecac' ou 'fgts'." });
    await ensureLegalizacaoSchema();
    const lista = Array.isArray(req.body.procuracoes) ? req.body.procuracoes : [];
    const melhor = new Map(); // documento -> { venc, rank }
    for (const p of lista) {
      const doc = String(p.cnpj || '').replace(/\D/g, '');
      const situacao = String(p.situacao || '').trim().toLowerCase();
      const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(p.validade || '').trim());
      if (!doc || !m || !['ativa', 'expirada'].includes(situacao)) continue;
      const venc = `${m[3]}-${m[2]}-${m[1]}`;
      const rank = situacao === 'ativa' ? 1 : 0;
      const atual = melhor.get(doc);
      if (!atual || rank > atual.rank || (rank === atual.rank && venc > atual.venc)) melhor.set(doc, { venc, rank });
    }

    const { rows: clientes } = await pool.query(
      `SELECT id::text AS id, regexp_replace(COALESCE(cnpj, ''), '\\D', '', 'g') AS doc FROM clientes WHERE status = 'ativo'`
    );
    const porDoc = new Map(clientes.map(c => [c.doc, c.id]));
    const ids = [], vencs = [];
    let semCliente = 0;
    for (const [doc, { venc }] of melhor) {
      const clienteId = porDoc.get(doc);
      if (!clienteId) { semCliente++; continue; }
      ids.push(clienteId); vencs.push(venc);
    }
    // Em lote (1 query) e só toca no que MUDOU — o script do Chrome reenvia a lista
    // inteira toda vez que o portal é aberto.
    let atualizados = 0, limpos = 0;
    if (ids.length) {
      const r = await pool.query(
        `INSERT INTO legalizacao_procuracoes (cliente_id, tipo, data_vencimento, fonte, criado_por)
         SELECT u.cid, $3::text, u.venc, $3::text, 'Importação Receita/FGTS'
           FROM unnest($1::text[], $2::date[]) AS u(cid, venc)
         ON CONFLICT (cliente_id, tipo) DO UPDATE SET data_vencimento = EXCLUDED.data_vencimento, fonte = EXCLUDED.fonte, atualizado_em = NOW(), notificado_vencimento_em = NULL
         WHERE legalizacao_procuracoes.data_vencimento IS DISTINCT FROM EXCLUDED.data_vencimento
         RETURNING 1`,
        [ids, vencs, tipo]
      );
      atualizados = r.rowCount;
      // Lista COMPLETA do portal: quem tinha data importada mas não tem mais procuração
      // Ativa/Expirada (cancelada, revogada...) volta pra "sem dados". Nunca mexe no que
      // foi preenchido à mão (fonte diferente do tipo).
      if (req.body.completo === true) {
        const z = await pool.query(
          `UPDATE legalizacao_procuracoes SET data_vencimento = NULL, atualizado_em = NOW(), notificado_vencimento_em = NULL
            WHERE tipo = $1 AND fonte = $1 AND data_vencimento IS NOT NULL AND cliente_id <> ALL($2::text[])`,
          [tipo, ids]
        );
        limpos = z.rowCount;
      }
    }
    await registrarLog('sync', 'Procurações (importação)', 'importar', 'legalizacao',
      `Procurações ${tipo === 'ecac' ? 'e-CAC' : 'FGTS Digital'}: ${atualizados} atualizada(s), ${limpos} zerada(s), ${semCliente} sem cliente ativo na Carteira, de ${lista.length} lida(s).`, req);
    res.json({ ok: true, tipo, recebidas: lista.length, consideradas: melhor.size, atualizados, limpos, semCliente });
  } catch (err) {
    console.error('[legalizacao] importar procurações falhou:', err);
    res.status(500).json({ error: err.message || 'Erro ao importar procurações.' });
  }
});

router.use(requireAuth);

async function registrarLog(userId, userName, acao, modulo, descricao, req) {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS log_atividades (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id TEXT NOT NULL, user_name TEXT NOT NULL,
      acao TEXT NOT NULL, modulo TEXT NOT NULL, descricao TEXT,
      ip TEXT, created_at TIMESTAMPTZ DEFAULT NOW()
    )`).catch(()=>{});
    const ip = req?.ip || req?.headers?.['x-forwarded-for'] || '—';
    await pool.query(
      `INSERT INTO log_atividades (user_id, user_name, acao, modulo, descricao, ip)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [userId, userName, acao, modulo, descricao||null, ip]
    );
  } catch(e) { /* log não deve quebrar a operação principal */ }
}


function periodFilter(period) {
  switch (period) {
    case 'hoje':   return `AND created_at::date = CURRENT_DATE`;
    case 'semana': return `AND created_at >= NOW() - INTERVAL '7 days'`;
    case 'mes':    return `AND DATE_TRUNC('month', created_at) = DATE_TRUNC('month', NOW())`;
    default:       return '';
  }
}

// ── ATENDIMENTOS ──────────────────────────────────────────────────────────────
router.get('/atendimentos', async (req, res) => {
  try {
    const pf = periodFilter(req.query.period);
    const result = await pool.query(`SELECT * FROM atendimentos WHERE 1=1 ${pf} ORDER BY created_at DESC`);
    res.json({ data: result.rows });
  } catch (err) { res.status(500).json({ error: 'Erro ao buscar atendimentos.' }); }
});

router.post('/atendimentos', async (req, res) => {
  try {
    const { analista, cliente, cnpj, empresa, departamento, procurado, demanda, resumo } = req.body;
    if (!analista || !cliente || !cnpj || !empresa || !departamento || !procurado)
      return res.status(400).json({ error: 'Campos obrigatórios ausentes.' });
    const id = uuidv4();
    await pool.query(
      `INSERT INTO atendimentos (id, user_id, analista, cliente, cnpj, empresa, departamento, procurado, demanda, resumo) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, req.user.id, analista, cliente, cnpj, empresa, departamento, procurado, demanda, resumo || null]
    );
    await registrarLog(req.user.id, req.user.name, 'criar', 'atendimento', `Atendimento: ${empresa||cliente}`, req);
    res.status(201).json({ id });
  } catch (err) { res.status(500).json({ error: 'Erro ao salvar atendimento.' }); }
});

// ── GESTÃO ────────────────────────────────────────────────────────────────────

// Faixa de ticket relativa à média: banda fixa de R$50 (pedido do Reysner —
// antes era ±15% relativo, trocado pra valor fixo em reais).
const FAIXA_BANDA_RS = 50;
function classificarFaixa(valor, media) {
  if (valor == null || !media) return null;
  if (valor > media + FAIXA_BANDA_RS) return 'acima';
  if (valor < media - FAIXA_BANDA_RS) return 'abaixo';
  return 'na_media';
}

router.get('/financeiro', requireAdmin, async (req, res) => {
  try {
    await ensureFinanceiroSchema();
    const { rows: unis } = await pool.query(`SELECT unidade, MAX(importado_em) AS importado_em FROM financeiro_importacoes GROUP BY unidade ORDER BY unidade`);
    const unidade = req.query.unidade || (unis[0] && unis[0].unidade);
    if (!unidade) return res.json({ unidades: [], resumo: null, clientes: [] });
    const { rows } = await pool.query(
      `WITH fc AS (
         SELECT cnpj, MAX(nome) AS nome, SUM(honorario_atual) AS honorario_atual, MIN(vigencia) AS vigencia
           FROM financeiro_clientes WHERE ($1 = '__todas' OR unidade = $1) GROUP BY cnpj
       ), fa AS (
         SELECT cnpj, MAX(nome) AS nome, SUM(qtd) AS qtd, SUM(valor_aberto) AS valor_aberto, SUM(valor_atrasado) AS valor_atrasado,
                SUM(qtd_atrasados) AS qtd_atrasados, MIN(mais_antigo) AS mais_antigo
           FROM financeiro_aberto WHERE ($1 = '__todas' OR unidade = $1) GROUP BY cnpj
       ), docs AS (
         SELECT cnpj, MAX(nome) AS nome FROM (SELECT cnpj, nome FROM fc UNION ALL SELECT cnpj, nome FROM fa) u GROUP BY cnpj
       )
       SELECT d.cnpj, COALESCE(NULLIF(cc.nome_empresa, ''), d.nome) AS nome, cc.status AS status_carteira, cc.id AS cliente_id, cc.origem AS origem_carteira,
              fc.honorario_atual, fc.vigencia, fa.qtd, fa.valor_aberto, fa.valor_atrasado, fa.qtd_atrasados, fa.mais_antigo
         FROM docs d
         LEFT JOIN fc ON fc.cnpj = d.cnpj
         LEFT JOIN fa ON fa.cnpj = d.cnpj
         LEFT JOIN LATERAL (SELECT nome_empresa, status, id, origem FROM clientes c WHERE regexp_replace(c.cnpj, '\\D', '', 'g') = d.cnpj
                             ORDER BY (c.status = 'ativo') DESC, c.created_at DESC LIMIT 1) cc ON true
        ORDER BY fc.honorario_atual DESC NULLS LAST, nome`, [unidade]);
    const hon = rows.filter(r => r.honorario_atual != null).map(r => parseFloat(r.honorario_atual));
    const ticket = hon.length ? Math.round((hon.reduce((s, v) => s + v, 0) / hon.length) * 100) / 100 : 0;
    const hoje = Date.now();
    const clientes = rows.map(r => {
      const h = r.honorario_atual != null ? parseFloat(r.honorario_atual) : null;
      const atrasado = parseFloat(r.valor_atrasado || 0);
      const doc = r.cnpj;
      return {
        cnpj: doc.length === 14 ? doc.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5') : doc.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4'),
        nome: r.nome, status_carteira: r.status_carteira || null, na_carteira: !!r.cliente_id && r.origem_carteira !== 'Omie (sem Acessórias)',
        honorario_atual: h, vigencia: r.vigencia, faixa: classificarFaixa(h, ticket), diferenca_ticket: h != null ? Math.round((h - ticket) * 100) / 100 : null,
        ativo_omie: h != null, em_aberto: parseFloat(r.valor_aberto || 0), atrasado, qtd_atrasados: r.qtd_atrasados || 0,
        atrasado_desde: r.mais_antigo, dias_atraso: r.mais_antigo && atrasado > 0 ? Math.max(0, Math.floor((hoje - new Date(r.mais_antigo).getTime()) / 86400000)) : null,
        inadimplente: atrasado > 0,
      };
    });
    const ativos = clientes.filter(c => c.ativo_omie);
    const inad = clientes.filter(c => c.inadimplente);
    res.json({
      unidades: unis, unidade,
      resumo: {
        ticket_medio: ticket, banda: FAIXA_BANDA_RS, clientes_com_honorario: ativos.length,
        receita_mensal: Math.round(ativos.reduce((s, c) => s + c.honorario_atual, 0) * 100) / 100,
        acima: ativos.filter(c => c.faixa === 'acima').length, na_media: ativos.filter(c => c.faixa === 'na_media').length, abaixo: ativos.filter(c => c.faixa === 'abaixo').length,
        inadimplentes: inad.length, valor_atrasado: Math.round(inad.reduce((s, c) => s + c.atrasado, 0) * 100) / 100,
        importado_em: unidade === '__todas' ? (unis.map(u => u.importado_em).sort().pop() || null) : ((unis.find(u => u.unidade === unidade) || {}).importado_em || null),
      },
      clientes,
    });
  } catch (err) { console.error('[Financeiro]', err); res.status(500).json({ error: 'Erro ao carregar o financeiro.' }); }
});

router.get('/gestao', async (req, res) => {
  try {
    const pf = periodFilter(req.query.period);
    await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS grupo_empresas TEXT`).catch(()=>{});
    await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS tipo_entrada TEXT`).catch(()=>{});
    await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS inadimplente_cronico BOOLEAN DEFAULT FALSE`).catch(()=>{});
    await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS unidade TEXT`).catch(()=>{});

    const result = await pool.query(`
      SELECT g.*,
        c.id AS cliente_id, c.grupo_empresas, c.inadimplente_cronico, c.unidade,
        c.status AS status_cliente, c.alerta_baixa_notificado_em,
        (SELECT valor FROM honorarios h WHERE h.cliente_id = c.id ORDER BY data_vigencia DESC LIMIT 1) AS honorario_atual
      FROM gestao_clientes g
      LEFT JOIN LATERAL (
        SELECT * FROM clientes c2 WHERE c2.cnpj = g.cnpj
        ORDER BY (c2.status = 'ativo') DESC, c2.created_at DESC LIMIT 1
      ) c ON true
      WHERE 1=1 ${pf}
      ORDER BY g.empresa ASC`);

    // Ticket médio (ativos, honorário vigente) — mesma base do dashboard de Carteira.
    const ticketQ = await pool.query(`
      SELECT COALESCE(AVG(h.valor), 0) AS ticket
      FROM clientes c
      JOIN LATERAL (
        SELECT valor FROM honorarios h2 WHERE h2.cliente_id = c.id ORDER BY data_vigencia DESC LIMIT 1
      ) h ON true
      WHERE c.status = 'ativo'`);
    const ticketMedio = parseFloat(ticketQ.rows[0].ticket) || 0;

    // Ticket médio POR unidade (ex.: Escritorial Contadores x Escritorial
    // Soluções) — cada uma tem escala/precificação diferente, então faz mais
    // sentido comparar dentro do mesmo grupo do que só contra a média geral.
    const ticketPorUnidadeQ = await pool.query(`
      SELECT COALESCE(c.unidade, '(sem unidade)') AS unidade,
             COALESCE(AVG(h.valor), 0) AS ticket,
             COUNT(*)::int AS quantidade
      FROM clientes c
      JOIN LATERAL (
        SELECT valor FROM honorarios h2 WHERE h2.cliente_id = c.id ORDER BY data_vigencia DESC LIMIT 1
      ) h ON true
      WHERE c.status = 'ativo'
      GROUP BY COALESCE(c.unidade, '(sem unidade)')
      ORDER BY unidade`);

    const data = result.rows.map(r => ({
      ...r,
      honorario_atual: r.honorario_atual != null ? parseFloat(r.honorario_atual) : null,
      faixa: classificarFaixa(r.honorario_atual != null ? parseFloat(r.honorario_atual) : null, ticketMedio),
      possivel_churn: r.alerta_baixa_notificado_em != null,
    }));

    res.json({
      data,
      ticketMedio,
      ticketMedioPorUnidade: ticketPorUnidadeQ.rows.map(r => ({
        unidade: r.unidade, ticket: parseFloat(r.ticket) || 0, quantidade: r.quantidade,
      })),
    });
  } catch (err) { console.error('Gestao GET error:', err); res.status(500).json({ error: 'Erro.' }); }
});

router.post('/gestao', async (req, res) => {
  try {
    const { analista, solicitacao, cnpj, empresa, data_sol, competencia, canal, motivo, codigo, regime_tributario } = req.body;
    // Data da Solicitação / Fim da Competência deixaram de ser obrigatórios
    // pras 3 solicitações de ENTRADA (Constituição/Cliente vindo de outro
    // contador/Transformação) — pedido do Reysner: não fazem sentido nesse
    // caso, o que importa ali é a Data de Entrada do Cliente.
    const ehEntrada = SOLICITACOES_ENTRADA.includes(solicitacao);
    if (!analista || !solicitacao || !cnpj || !empresa || !canal || (!ehEntrada && (!data_sol || !competencia)))
      return res.status(400).json({ error: 'Campos obrigatórios ausentes.' });
    await pool.query(`ALTER TABLE gestao_clientes ADD COLUMN IF NOT EXISTS codigo TEXT`).catch(()=>{});
    await pool.query(`ALTER TABLE gestao_clientes ADD COLUMN IF NOT EXISTS regime_tributario TEXT`).catch(()=>{});
    await pool.query(`ALTER TABLE gestao_clientes ALTER COLUMN data_sol DROP NOT NULL`).catch(()=>{});
    await pool.query(`ALTER TABLE gestao_clientes ALTER COLUMN competencia DROP NOT NULL`).catch(()=>{});
    const id = uuidv4();
    await pool.query(
      `INSERT INTO gestao_clientes (id, user_id, analista, solicitacao, cnpj, empresa, data_sol, competencia, canal, motivo, codigo, regime_tributario)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [id, req.user.id, analista, solicitacao, cnpj, empresa, data_sol || null, competencia || null, canal, motivo || null, codigo || null, regime_tributario || null]
    );
    await registrarLog(req.user.id, req.user.name, 'criar', 'gestao', `Gestao: ${solicitacao} - ${empresa}`, req);
    res.status(201).json({ id });
  } catch (err) { console.error('Gestao POST error:', err); res.status(500).json({ error: 'Erro ao salvar gestão.' }); }
});

const SOLICITACOES_ENTRADA = ['Constituição de empresa', 'Cliente vindo de outro contador', 'Transformação de empresa'];
const SOLICITACOES_SAIDA = ['Saída de empresa', 'Baixa de empresa'];

/**
 * POST /api/data/gestao/importar — importação em massa de registros de
 * Gestão de Clientes (usada pela planilha .xlsx/.csv que o frontend lê e
 * envia já convertida em JSON). Replica EXATAMENTE o que o formulário manual
 * faz linha a linha (ver Forms.gestao() em app.js):
 *   - sempre grava o registro em gestao_clientes;
 *   - se a Solicitação for de ENTRADA (Constituição/Cliente vindo de outro
 *     contador/Transformação) e não existir cliente ativo com esse CNPJ,
 *     cria o cliente na Carteira (com CAC calculado do jeito que o
 *     formulário calcula) — honorário e data de entrada são obrigatórios
 *     nesse caso;
 *   - se o CNPJ já bater com um cliente ATIVO na Carteira — em QUALQUER tipo
 *     de Solicitação, não só entrada — atualiza honorário (se veio valor
 *     novo na planilha), Grupo de Empresas, Unidade e Inadimplente Crônico
 *     dele, sem duplicar registro. Isso permite subir uma planilha só pra
 *     atualizar honorário/grupo/unidade em massa, sem precisar tratar como
 *     entrada de cliente novo;
 *   - se for de SAÍDA (Saída/Baixa de empresa), encerra o cliente na
 *     Carteira pelo CNPJ (se não achar um cliente ativo com esse CNPJ, só
 *     avisa — não impede o registro de Gestão de entrar);
 *   - NUNCA pergunta sobre abrir ticket (isso é só do fluxo manual/admin).
 * Linha com campo obrigatório faltando é pulada (vai pra `erros`), sem
 * travar o restante da importação.
 */
router.post('/gestao/importar', requireAdmin, async (req, res) => {
  const linhas = Array.isArray(req.body?.linhas) ? req.body.linhas : [];
  if (!linhas.length) return res.status(400).json({ error: 'Nenhuma linha pra importar.' });

  await pool.query(`ALTER TABLE gestao_clientes ADD COLUMN IF NOT EXISTS codigo TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE gestao_clientes ADD COLUMN IF NOT EXISTS regime_tributario TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS codigo TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS grupo_empresas TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS tipo_entrada TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS inadimplente_cronico BOOLEAN DEFAULT FALSE`).catch(() => {});
  await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS unidade TEXT`).catch(() => {});

  let processados = 0;
  const erros = [];
  const avisos = [];

  for (let i = 0; i < linhas.length; i++) {
    const n = i + 2; // linha 1 = cabeçalho na planilha, então dado começa na 2
    const linha = linhas[i] || {};
    const { analista, solicitacao, cnpj, empresa, data_sol, competencia, canal, motivo, codigo, regime_tributario,
            data_entrada, honorario_inicial, origem, data_saida, grupo_empresas, unidade, inadimplente_cronico } = linha;

    if (!analista || !solicitacao || !cnpj || !empresa || !data_sol || !competencia || !canal || !regime_tributario) {
      erros.push({ linha: n, empresa: empresa || '(sem empresa)', motivo: 'Campo obrigatório faltando (Analista, Solicitação, CNPJ, Empresa, Data, Competência, Canal ou Regime Tributário).' });
      continue;
    }

    const isEntrada = SOLICITACOES_ENTRADA.includes(solicitacao);
    const isSaida = SOLICITACOES_SAIDA.includes(solicitacao);

    if (isEntrada && (!honorario_inicial || !data_entrada)) {
      erros.push({ linha: n, empresa, motivo: `Solicitação "${solicitacao}" exige Honorário Inicial e Data de Entrada do Cliente preenchidos.` });
      continue;
    }

    try {
      const gestaoId = uuidv4();
      await pool.query(
        `INSERT INTO gestao_clientes (id, user_id, analista, solicitacao, cnpj, empresa, data_sol, competencia, canal, motivo, codigo, regime_tributario)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [gestaoId, req.user.id, analista, solicitacao, cnpj, empresa, data_sol, competencia, canal, motivo || null, codigo || null, regime_tributario]
      );

      // Atualiza/cria cliente na Carteira quando fizer sentido:
      //  - Solicitação de ENTRADA sem cliente ativo existente com esse CNPJ -> cria cliente novo.
      //  - QUALQUER solicitação (entrada ou não) cujo CNPJ bata com um cliente já
      //    ativo na Carteira -> atualiza honorário/grupo/unidade/inadimplência dele.
      //    Isso permite usar a planilha só pra "atualização em massa" de honorário
      //    e grupo de empresas, sem precisar marcar a linha como uma "entrada"
      //    de fato (pedido da Thais: subir uma planilha só com honorário e grupo
      //    pros clientes que já estão na Carteira).
      if (!isSaida) {
        const honorarioNum = honorario_inicial ? (parseFloat(String(honorario_inicial).replace(',', '.')) || 0) : 0;
        const grupoVal = grupo_empresas || null;
        const unidadeVal = unidade || null;
        const inadimplenteVal = inadimplente_cronico === true || inadimplente_cronico === 'true';
        const dataVigenciaHonorario = data_entrada || data_sol;

        const { rows: existentes } = await pool.query(
          `SELECT id FROM clientes WHERE cnpj = $1 AND status = 'ativo' LIMIT 1`, [cnpj]
        );

        if (existentes.length) {
          const clienteId = existentes[0].id;
          await pool.query(
            `UPDATE clientes SET grupo_empresas = COALESCE($1, grupo_empresas),
               unidade = COALESCE($2, unidade),
               tipo_entrada = COALESCE(tipo_entrada, $3),
               inadimplente_cronico = $4
             WHERE id = $5`,
            [grupoVal, unidadeVal, solicitacao, inadimplenteVal, clienteId]
          );
          if (honorarioNum) {
            const ant = await pool.query(
              `SELECT valor FROM honorarios WHERE cliente_id=$1 ORDER BY data_vigencia DESC LIMIT 1`, [clienteId]
            );
            const honorarioAnterior = parseFloat(ant.rows[0]?.valor || 0);
            if (honorarioNum !== honorarioAnterior) {
              await pool.query(
                `INSERT INTO honorarios (cliente_id, valor, data_vigencia, obs) VALUES ($1,$2,$3,'Atualizado via importação de planilha')`,
                [clienteId, honorarioNum, dataVigenciaHonorario]
              );
              await pool.query(
                `INSERT INTO eventos_clientes (cliente_id, tipo, descricao, valor_anterior, valor_novo, data_evento)
                 VALUES ($1,'reajuste','Atualização via importação de planilha',$2,$3,$4)`,
                [clienteId, honorarioAnterior, honorarioNum, dataVigenciaHonorario]
              );
            }
          }
          avisos.push({ linha: n, empresa, motivo: 'Já existia como cliente ativo na Carteira (mesmo CNPJ) — atualizei grupo/unidade/honorário em vez de duplicar.' });
        } else if (isEntrada) {
          let cacCalculado = 0;
          const mesEntrada = String(data_entrada).slice(0, 7);
          try {
            const invResult = await pool.query(`SELECT COALESCE(SUM(valor),0) AS total FROM investimentos WHERE mes = $1`, [mesEntrada]);
            const cliResult = await pool.query(`SELECT COUNT(*) AS n FROM clientes WHERE TO_CHAR(data_entrada,'YYYY-MM') = $1`, [mesEntrada]);
            const totalInv = parseFloat(invResult.rows[0]?.total || 0);
            const totalCli = parseInt(cliResult.rows[0]?.n || 0, 10);
            cacCalculado = totalCli > 0 ? totalInv / totalCli : 0;
          } catch (e) { /* CAC fica 0 se der erro — não impede o cadastro */ }

          const clienteId = uuidv4();
          await pool.query(
            `INSERT INTO clientes (id, user_id, cnpj, nome_empresa, regime_tributario, data_entrada,
              honorario_inicial, origem, cac, codigo, grupo_empresas, unidade, tipo_entrada, inadimplente_cronico)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
            [clienteId, req.user.id, cnpj, empresa, regime_tributario, data_entrada, honorarioNum,
             origem || null, cacCalculado, codigo || null, grupoVal, unidadeVal, solicitacao, inadimplenteVal]
          );
          await pool.query(
            `INSERT INTO honorarios (cliente_id, valor, data_vigencia, obs) VALUES ($1,$2,$3,'Honorário inicial')`,
            [clienteId, honorarioNum, data_entrada]
          );
          await pool.query(
            `INSERT INTO eventos_clientes (cliente_id, tipo, descricao, valor_novo, data_evento) VALUES ($1,'entrada',$2,$3,$4)`,
            [clienteId, `Entrada — ${empresa}`, honorarioNum, data_entrada]
          );
        } else if (honorarioNum || grupoVal || unidadeVal) {
          // Não é entrada e não achei cliente ativo com esse CNPJ pra atualizar —
          // avisa em vez de simplesmente ignorar o honorário/grupo informado.
          avisos.push({ linha: n, empresa, motivo: 'Não encontrei cliente ativo com esse CNPJ na Carteira pra atualizar honorário/grupo/unidade. Se for um cliente novo, marque a Solicitação como "Constituição de empresa", "Cliente vindo de outro contador" ou "Transformação de empresa".' });
        }
      }

      if (isSaida) {
        const dataSaidaEfetiva = data_saida || data_sol;
        const motivoSaida = motivo || solicitacao;
        const { rows: clientesAtivos } = await pool.query(
          `SELECT id FROM clientes WHERE cnpj = $1 AND status = 'ativo' LIMIT 1`, [cnpj]
        );
        if (clientesAtivos.length) {
          const clienteId = clientesAtivos[0].id;
          await pool.query(
            `UPDATE clientes SET status='encerrado', data_saida=$1, motivo_saida=$2 WHERE id=$3`,
            [dataSaidaEfetiva, motivoSaida, clienteId]
          );
          await pool.query(
            `INSERT INTO eventos_clientes (cliente_id, tipo, descricao, data_evento) VALUES ($1,'saida',$2,$3)`,
            [clienteId, motivoSaida, dataSaidaEfetiva]
          );
        } else {
          avisos.push({ linha: n, empresa, motivo: 'Registro de Gestão salvo, mas não achei esse CNPJ como cliente ativo na Carteira pra encerrar.' });
        }
      }

      processados++;
    } catch (e) {
      console.error('Gestao importar — linha', n, e);
      erros.push({ linha: n, empresa, motivo: 'Erro ao salvar: ' + e.message });
    }
  }

  await registrarLog(req.user.id, req.user.name, 'importar', 'gestao', `Importação de planilha: ${processados} registro(s)`, req);
  res.json({ processados, avisos, erros });
});

/**
 * Sincroniza clientes ATIVOS do Sistema Acessórias pra Carteira (`clientes`).
 * Pedido do Reysner: traz tudo (nome, CNPJ, regime, data de entrada) MENOS
 * o honorário — de propósito, fica pendente de preenchimento manual/depois.
 * Casa por `acessorias_id` primeiro (estável entre sincronizações mesmo se o
 * CNPJ vier formatado diferente em algum lugar), com fallback por CNPJ pra
 * já linkar quem foi cadastrado manualmente antes de existir essa integração.
 * NUNCA mexe em honorário de cliente existente — só cria/atualiza dados
 * cadastrais. Usada tanto pelo endpoint manual (com `userId` de quem
 * clicou) quanto pelo job automático em index.js (sem usuário logado — por
 * isso busca um admin de fallback pra assinar os registros automáticos).
 *
 * Pedido do Reysner: cada cliente novo criado aqui também gera uma linha
 * em `gestao_clientes` (aparece no "Registro de Gestão" igual uma entrada
 * manual), preenchendo SÓ os campos que são de Gestão de Clientes mesmo —
 * não inventa honorário nem nada que pertença só à Carteira.
 */
/**
 * Município do cliente (pela Receita, via CNPJ) — decide em qual prefeitura buscar alvará. Roda
 * sozinho depois de cada sincronização com o Acessórias (cliente novo entra com município) e
 * completa quem ainda não tem, devagar (1 CNPJ a cada 3s) pra não estourar o limite das fontes.
 */
const { portalDaPrefeitura } = require('../legalizacao/portaisPrefeituras');
const IBGE_UBERLANDIA = '3170206';
const { IBGES_INTEGRADOS } = require('../legalizacao/municipiosIntegrados');
let municipiosRodando = false;
// Código IBGE de município → UF (2 primeiros dígitos). Vale mais que o "UF" do Acessórias (estado do cadastro, nem sempre o da empresa).
const UF_POR_CODIGO_IBGE = { 11: 'RO', 12: 'AC', 13: 'AM', 14: 'RR', 15: 'PA', 16: 'AP', 17: 'TO', 21: 'MA', 22: 'PI', 23: 'CE', 24: 'RN', 25: 'PB', 26: 'PE', 27: 'AL', 28: 'SE', 29: 'BA', 31: 'MG', 32: 'ES', 33: 'RJ', 35: 'SP', 41: 'PR', 42: 'SC', 43: 'RS', 50: 'MS', 51: 'MT', 52: 'GO', 53: 'DF' };
const ufDoIbge = (ibge) => UF_POR_CODIGO_IBGE[String(ibge || '').slice(0, 2)] || null;
async function garantirColunasMunicipio() {
  await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS municipio TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS municipio_ibge TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS municipio_verificado_em TIMESTAMPTZ`).catch(() => {});
  await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS cnaes JSONB`).catch(() => {});
  await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS inscricao_municipal TEXT`).catch(() => {});
  // corrige UF que destoa do município (ex.: São Paulo/MG): o município (IBGE) manda
  await pool.query(`UPDATE clientes SET uf = CASE substring(municipio_ibge, 1, 2)
      WHEN '11' THEN 'RO' WHEN '12' THEN 'AC' WHEN '13' THEN 'AM' WHEN '14' THEN 'RR' WHEN '15' THEN 'PA' WHEN '16' THEN 'AP' WHEN '17' THEN 'TO'
      WHEN '21' THEN 'MA' WHEN '22' THEN 'PI' WHEN '23' THEN 'CE' WHEN '24' THEN 'RN' WHEN '25' THEN 'PB' WHEN '26' THEN 'PE' WHEN '27' THEN 'AL' WHEN '28' THEN 'SE' WHEN '29' THEN 'BA'
      WHEN '31' THEN 'MG' WHEN '32' THEN 'ES' WHEN '33' THEN 'RJ' WHEN '35' THEN 'SP' WHEN '41' THEN 'PR' WHEN '42' THEN 'SC' WHEN '43' THEN 'RS'
      WHEN '50' THEN 'MS' WHEN '51' THEN 'MT' WHEN '52' THEN 'GO' WHEN '53' THEN 'DF' ELSE uf END
    WHERE municipio_ibge IS NOT NULL AND length(municipio_ibge) >= 2 AND uf IS DISTINCT FROM CASE substring(municipio_ibge, 1, 2)
      WHEN '11' THEN 'RO' WHEN '12' THEN 'AC' WHEN '13' THEN 'AM' WHEN '14' THEN 'RR' WHEN '15' THEN 'PA' WHEN '16' THEN 'AP' WHEN '17' THEN 'TO'
      WHEN '21' THEN 'MA' WHEN '22' THEN 'PI' WHEN '23' THEN 'CE' WHEN '24' THEN 'RN' WHEN '25' THEN 'PB' WHEN '26' THEN 'PE' WHEN '27' THEN 'AL' WHEN '28' THEN 'SE' WHEN '29' THEN 'BA'
      WHEN '31' THEN 'MG' WHEN '32' THEN 'ES' WHEN '33' THEN 'RJ' WHEN '35' THEN 'SP' WHEN '41' THEN 'PR' WHEN '42' THEN 'SC' WHEN '43' THEN 'RS'
      WHEN '50' THEN 'MS' WHEN '51' THEN 'MT' WHEN '52' THEN 'GO' WHEN '53' THEN 'DF' ELSE uf END`).catch(() => {});
}
async function completarMunicipiosClientes({ limite = 300, intervaloMs = 3000 } = {}) {
  if (municipiosRodando) return { pulou: true };
  municipiosRodando = true;
  try {
    await garantirColunasMunicipio();
    const { consultarMunicipioCnpj } = require('../legalizacao/municipioCnpj');
    const { rows } = await pool.query(
      `SELECT id, cnpj, nome_empresa FROM clientes
        WHERE status = 'ativo' AND (municipio IS NULL OR cnaes IS NULL)
          AND length(regexp_replace(COALESCE(cnpj, ''), '\\D', '', 'g')) = 14
        ORDER BY nome_empresa LIMIT $1`, [limite]
    );
    let ok = 0, falhas = 0, seguidas = 0;
    for (const c of rows) {
      try {
        const m = await consultarMunicipioCnpj(c.cnpj);
        await pool.query(
          `UPDATE clientes SET municipio = $1, uf = COALESCE($2, uf), municipio_ibge = $3, municipio_verificado_em = NOW(), cnaes = $5::jsonb WHERE id = $4`,
          [m.municipio, ufDoIbge(m.ibge) || m.uf, m.ibge, c.id, JSON.stringify(m.cnaes || [])]
        );
        ok++; seguidas = 0;
      } catch (e) {
        falhas++; seguidas++;
        console.error(`[Município] Falhou (${c.nome_empresa}):`, e.message);
        if (seguidas >= 5) break; // fonte fora do ar ou limitando — tenta de novo na próxima rodada
      }
      await new Promise(r => setTimeout(r, intervaloMs));
    }
    if (ok) await atualizarObservacaoSanitaria().catch((e) => console.error('[Sanitário] avaliação falhou:', e.message));
    return { pendentes: rows.length, ok, falhas };
  } finally {
    municipiosRodando = false;
  }
}

async function sincronizarAcessorias({ userId = null } = {}) {
  const token = process.env.ACESSORIAS_API_TOKEN;
  if (!token) throw new Error('ACESSORIAS_API_TOKEN não configurado.');

  await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS acessorias_id TEXT`).catch(() => {});
  // UF (estado) — pedido do Reysner, 17/09/2026, tentativa de automação da
  // Legalização. Acessórias não traz cidade, só estado (ver acessoriasClient.js).
  await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS uf TEXT`).catch(() => {});
  await garantirColunasMunicipio();
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_clientes_acessorias_id ON clientes (acessorias_id) WHERE acessorias_id IS NOT NULL`).catch(() => {});
  // Usada tanto no loop principal (reseta ao ver o cliente ainda ativo)
  // quanto em detectarPossiveisChurns — precisa existir antes das duas.
  await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS alerta_baixa_notificado_em TIMESTAMPTZ`).catch(() => {});
  // user_id normalmente é preenchido por quem cadastra manualmente — o job
  // automático não tem usuário logado, então a coluna precisa aceitar null.
  await pool.query(`ALTER TABLE clientes ALTER COLUMN user_id DROP NOT NULL`).catch(() => {});
  // Data da Solicitação / Fim da Competência não fazem sentido pra um
  // registro que só existe porque o cliente já é ativo no Acessórias —
  // pedido do Reysner pra deixar em branco em vez de forçar a data de hoje.
  await pool.query(`ALTER TABLE gestao_clientes ALTER COLUMN data_sol DROP NOT NULL`).catch(() => {});
  await pool.query(`ALTER TABLE gestao_clientes ALTER COLUMN competencia DROP NOT NULL`).catch(() => {});
  // Limpa o placeholder (data de hoje) que as rodadas anteriores já tinham
  // gravado nesses dois campos antes dessa mudança — só nos registros
  // vindos da sincronização, nunca em registro criado manualmente.
  await pool.query(`
    UPDATE gestao_clientes SET data_sol = NULL, competencia = NULL
     WHERE motivo IN (
       'Importado automaticamente do Sistema Acessórias',
       'Registro completado a partir da Carteira (cliente já existia sem essa linha)'
     ) AND (data_sol IS NOT NULL OR competencia IS NOT NULL)
  `).catch(() => {});

  // Notificação de cliente novo — garante a tabela/coluna aqui também (não
  // só em detectarPossiveisChurns, que só roda DEPOIS do loop abaixo).
  await pool.query(`CREATE TABLE IF NOT EXISTS notificacoes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tipo TEXT NOT NULL, titulo TEXT NOT NULL, mensagem TEXT NOT NULL,
    lida BOOLEAN DEFAULT false, link_modulo TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`).catch(() => {});
  await pool.query(`ALTER TABLE notificacoes ADD COLUMN IF NOT EXISTS cliente_id UUID`).catch(() => {});

  // gestao_clientes.user_id é NOT NULL (referencia users) — sem usuário
  // logado (job automático), assina com o admin mais antigo cadastrado.
  let userIdEfetivo = userId;
  let userNomeEfetivo = 'Sincronização automática';
  if (!userIdEfetivo) {
    const admin = await pool.query(
      `SELECT id, name FROM users WHERE role = 'administrador' ORDER BY created_at ASC LIMIT 1`
    );
    if (admin.rows.length) { userIdEfetivo = admin.rows[0].id; userNomeEfetivo = admin.rows[0].name; }
  }

  const empresas = await acessoriasClient.listarEmpresasAtivas({ token });
  let criados = 0, atualizados = 0, semRegimeReconhecido = 0, semGestaoRegistrada = 0, gestaoCompletados = 0;
  const erros = [];

  for (const emp of empresas) {
    if (!emp.cnpj) { erros.push({ empresa: emp.nome_empresa, motivo: 'Sem CNPJ/CPF na Acessórias.' }); continue; }
    if (!emp.regime_tributario) semRegimeReconhecido++;
    try {
      const existente = await pool.query(
        `SELECT id FROM clientes WHERE acessorias_id = $1 OR cnpj = $2 LIMIT 1`,
        [emp.acessorias_id, emp.cnpj]
      );
      if (existente.rows.length) {
        await pool.query(
          `UPDATE clientes SET
             nome_empresa = COALESCE($1, nome_empresa),
             regime_tributario = COALESCE($2, regime_tributario),
             codigo = COALESCE(codigo, $3),
             acessorias_id = $4,
             uf = CASE WHEN municipio_ibge IS NOT NULL THEN uf ELSE COALESCE($6, uf) END,
             alerta_baixa_notificado_em = NULL
           WHERE id = $5`,
          [emp.nome_empresa, emp.regime_tributario, emp.codigo, emp.acessorias_id, existente.rows[0].id, emp.uf]
        );
        atualizados++;

        // Pedido do Reysner: completar Registro de Gestão pra quem já está
        // na Carteira (ex.: os importados antes de essa mirror existir) mas
        // ainda não tem uma linha lá — sem duplicar quem já tem ("só o
        // excedente"), e sem chamar a API de novo, só reaproveitando o que
        // já veio nesta mesma sincronização.
        const jaTemGestao = await pool.query(`SELECT id FROM gestao_clientes WHERE cnpj = $1 LIMIT 1`, [emp.cnpj]);
        if (!jaTemGestao.rows.length) {
          if (userIdEfetivo) {
            await pool.query(
              `INSERT INTO gestao_clientes (id, user_id, analista, solicitacao, cnpj, empresa, data_sol, competencia, canal, motivo, codigo, regime_tributario)
               VALUES ($1,$2,$3,'Cliente vindo de outro contador',$4,$5,$6,$7,'Outro',$8,$9,$10)`,
              [uuidv4(), userIdEfetivo, userNomeEfetivo, emp.cnpj, emp.nome_empresa, null, null,
               'Registro completado a partir da Carteira (cliente já existia sem essa linha)', emp.codigo, emp.regime_tributario]
            );
            gestaoCompletados++;
          } else {
            semGestaoRegistrada++;
          }
        } else {
          // Achado pelo Reysner: linha de Gestão já existia (de antes do
          // fix do regime_tributario/registrationData) e nunca foi
          // atualizada — só a Carteira era corrigida aqui. Sem isso, a
          // coluna "Regime" ficava sempre "—" em Empresas mesmo já
          // resolvido na Carteira. Regime usa a MESMA prioridade da
          // Carteira (COALESCE(novo, existente) — valor novo da Acessórias
          // sempre vence quando vier preenchido), pra Empresas continuar
          // acompanhando se o regime mudar lá no futuro, não só preencher
          // uma vez e travar. Código continua existente-primeiro (mesma
          // regra de sempre, só preenche se estava vazio).
          await pool.query(
            `UPDATE gestao_clientes SET
               regime_tributario = COALESCE($1, regime_tributario),
               codigo = COALESCE(codigo, $2)
             WHERE id = $3`,
            [emp.regime_tributario, emp.codigo, jaTemGestao.rows[0].id]
          );
        }
      } else {
        const clienteId = uuidv4();
        await pool.query(
          `INSERT INTO clientes (id, user_id, cnpj, nome_empresa, regime_tributario, data_entrada, acessorias_id, codigo, uf, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'ativo')`,
          [clienteId, userIdEfetivo, emp.cnpj, emp.nome_empresa, emp.regime_tributario, emp.data_entrada, emp.acessorias_id, emp.codigo, emp.uf]
        );
        // Sem INSERT em `honorarios` de propósito — cliente fica com
        // honorário pendente (honorario_atual sai null nas telas que já
        // tratam esse caso, ex.: Gestão de Clientes, Carteira).
        criados++;

        // Espelha em Registro de Gestão — só os campos que são dela.
        if (userIdEfetivo) {
          await pool.query(
            `INSERT INTO gestao_clientes (id, user_id, analista, solicitacao, cnpj, empresa, data_sol, competencia, canal, motivo, codigo, regime_tributario)
             VALUES ($1,$2,$3,'Cliente vindo de outro contador',$4,$5,$6,$7,'Outro',$8,$9,$10)`,
            [uuidv4(), userIdEfetivo, userNomeEfetivo, emp.cnpj, emp.nome_empresa, null, null,
             'Importado automaticamente do Sistema Acessórias', emp.codigo, emp.regime_tributario]
          );
        } else {
          semGestaoRegistrada++;
        }

        // Notifica — pedido do Reysner: nem todo cliente novo vem completo
        // do Acessórias (falta classificar o tipo de entrada de verdade —
        // Constituição/Cliente vindo de outro contador/Transformação — e
        // preencher honorário/origem, que a gente nunca traz de lá). Clicar
        // na notificação abre o resolvedor (ver /completar-entrada).
        await pool.query(
          `INSERT INTO notificacoes (tipo, titulo, mensagem, link_modulo, cliente_id)
           VALUES ('novo_cliente_acessorias', 'Novo cliente no Acessórias', $1, 'gestao', $2)`,
          [`${emp.nome_empresa} (CNPJ ${emp.cnpj}) apareceu como ativa no Acessórias — classifique o tipo de entrada e complete honorário/origem.`, clienteId]
        );
      }
    } catch (e) {
      erros.push({ empresa: emp.nome_empresa, motivo: e.message });
    }
  }

  const possiveisChurns = await detectarPossiveisChurns(empresas);

  // Cliente novo (ou ainda sem município): descobre a cidade em segundo plano, sem atrasar a resposta.
  completarMunicipiosClientes().then(r => console.log('[Município] Conferência após sincronização:', r)).catch(e => console.error('[Município] Falha:', e.message));

  return { totalNaAcessorias: empresas.length, criados, atualizados, gestaoCompletados, semRegimeReconhecido, semGestaoRegistrada, possiveisChurns, erros };
}

/**
 * Detecta cliente que estava ATIVO aqui e sumiu da lista de ativos do
 * Acessórias (baixa/saída registrada lá) — notifica pelo sininho, mas NÃO
 * encerra o cliente sozinho: quem decide o motivo do churn e confirma o
 * encerramento é humano (pedido do Reysner: "eu incluo o motivo dos
 * churns"). Notifica só 1x por cliente (marca `alerta_baixa_notificado_em`)
 * — enquanto ele continuar "ativo" aqui sem ser tratado, não repete o
 * aviso todo dia; assim que alguém encerra o cliente (status vira
 * 'encerrado'), ele simplesmente sai da comparação.
 *
 * Guarda de segurança: se a lista vinda da Acessórias vier bem menor que o
 * esperado (ex.: paginação falhou no meio), NÃO dispara nada — evita um
 * alarme falso em massa por causa de uma falha de rede, não de baixa real.
 */
async function detectarPossiveisChurns(empresasAtivasNaAcessorias) {
  await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS alerta_baixa_notificado_em TIMESTAMPTZ`).catch(() => {});
  await pool.query(`CREATE TABLE IF NOT EXISTS notificacoes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tipo TEXT NOT NULL, titulo TEXT NOT NULL, mensagem TEXT NOT NULL,
    lida BOOLEAN DEFAULT false, link_modulo TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`).catch(() => {});
  // cliente_id: pra notificação de churn abrir direto o resolvedor
  // (Baixa/Saída) sem precisar procurar o cliente na Carteira na mão.
  await pool.query(`ALTER TABLE notificacoes ADD COLUMN IF NOT EXISTS cliente_id UUID`).catch(() => {});

  const nossosAtivos = await pool.query(
    `SELECT id, nome_empresa, cnpj, acessorias_id FROM clientes
      WHERE status = 'ativo' AND acessorias_id IS NOT NULL`
  );
  if (!nossosAtivos.rows.length) return 0;

  // Guarda: só compara se a lista da Acessórias tiver um tamanho plausível
  // perto do que já temos cadastrado (evita falso alarme por paginação
  // incompleta — ver comentário acima).
  if (empresasAtivasNaAcessorias.length < nossosAtivos.rows.length * 0.7) return 0;

  const idsAtivosNaAcessorias = new Set(empresasAtivasNaAcessorias.map(e => e.acessorias_id));
  let notificados = 0;
  for (const cliente of nossosAtivos.rows) {
    if (idsAtivosNaAcessorias.has(cliente.acessorias_id)) continue;
    // Inativou no Acessórias → baixa automática aqui (pedido do Reysner: não decidir mais baixa x saída à mão).
    // Se a consulta da empresa falhar, cai no aviso antigo pelo sininho (nunca perde o caso).
    try {
      await encerrarClientePorAcessorias(cliente, null);
      notificados++;
      continue;
    } catch (e) {
      console.error('[churn-auto] falhou, notificando:', cliente.nome_empresa, e.message);
    }
    await pool.query(
      `INSERT INTO notificacoes (tipo, titulo, mensagem, link_modulo, cliente_id)
       VALUES ('churn_acessorias', 'Possível baixa/saída no Acessórias', $1, 'carteira', $2)`,
      [`${cliente.nome_empresa} (CNPJ ${cliente.cnpj}) não aparece mais como ativa no Acessórias — clique pra confirmar se foi baixa ou saída.`, cliente.id]
    );
    await pool.query(`UPDATE clientes SET alerta_baixa_notificado_em = NOW() WHERE id = $1`, [cliente.id]);
    notificados++;
  }
  return notificados;
}

/**
 * Encerra o cliente sozinho quando ele fica inativo no Acessórias: status 'encerrado' (some da Carteira ativa, de
 * Gestão de Clientes e da Legalização), evento de saída e registro em Gestão de Clientes. Tipo pelo motivo do
 * Acessórias: "Baixada" → Baixa de empresa; "Transferência…" → Saída de empresa (churn); sem motivo → Baixa.
 */
async function encerrarClientePorAcessorias(cliente, empresaAcessorias) {
  await pool.query(`ALTER TABLE gestao_clientes ALTER COLUMN data_sol DROP NOT NULL`).catch(() => {});
  await pool.query(`ALTER TABLE gestao_clientes ALTER COLUMN competencia DROP NOT NULL`).catch(() => {});
  let emp = empresaAcessorias;
  const token = process.env.ACESSORIAS_API_TOKEN;
  if (!emp && token && cliente.cnpj) emp = await acessoriasClient.buscarEmpresaPorCnpj(cliente.cnpj, token).catch(() => null);
  const hoje = new Date().toISOString().slice(0, 10);
  const dataSaida = (emp && emp.clienteAte) || hoje;
  const motivoBruto = emp && emp.motivoCancelamentoBruto;
  const tipo = palpiteTipoChurn(motivoBruto) === 'saida' ? 'saida' : 'baixa';
  const solicitacao = tipo === 'saida' ? 'Saída de empresa' : 'Baixa de empresa';
  // Usa o motivo real do Acessórias quando veio (ex.: "Transferida por preço"), senão o rótulo genérico.
  const motivo = tipo === 'saida'
    ? (motivoBruto ? `${motivoBruto} (automático — Acessórias)` : 'Transferida para outro contador (automático — Acessórias)')
    : 'Baixa de empresa';
  const upd = await pool.query(
    `UPDATE clientes SET status='encerrado', data_saida=$1, motivo_saida=$2 WHERE id=$3 AND status='ativo'`,
    [dataSaida, motivo, cliente.id]
  );
  if (!upd.rowCount) return;
  await pool.query(`INSERT INTO eventos_clientes (cliente_id, tipo, descricao, data_evento) VALUES ($1,'saida',$2,$3)`, [cliente.id, motivo, dataSaida]);
  const gestaoId = uuidv4();
  await pool.query(
    `INSERT INTO gestao_clientes (id, user_id, analista, solicitacao, cnpj, empresa, data_sol, competencia, canal, motivo, codigo, regime_tributario)
     VALUES ($1,$2,'Automático (Acessórias)',$3,$4,$5,$6,$7,'Outro',$8,$9,$10)`,
    [gestaoId, cliente.user_id, solicitacao, cliente.cnpj, cliente.nome_empresa, dataSaida, dataSaida.slice(0, 7), motivo, cliente.codigo || null, cliente.regime_tributario || null]
  );
  await pool.query(`UPDATE clientes SET alerta_baixa_notificado_em = NOW() WHERE id = $1`, [cliente.id]);
  await pool.query(`UPDATE notificacoes SET lida = true WHERE cliente_id = $1 AND tipo = 'churn_acessorias' AND lida = false`, [cliente.id]).catch(() => {});
  // Pedido do Reysner (22/09/2026): toda baixa/saída detectada no Acessórias abre ticket pro Contábil sozinha,
  // já roteado pro time do regime da empresa — ver criarTicketInterno().
  try {
    await criarTicketInterno({
      gestaoId, empresa: cliente.nome_empresa, cnpj: cliente.cnpj, regime: cliente.regime_tributario,
      tipoMovimentacao: solicitacao,
      observacoes: `Empresa inativada no Acessórias em ${dataSaida} — ${motivo}.`,
      dadosGestao: { codigo: cliente.codigo || null }, criadoPor: 'Automático (Acessórias)',
    });
  } catch (e) { console.error('[baixa-automatica] falhou ao abrir ticket:', cliente.nome_empresa, e.message); }
}

/** POST /api/data/clientes/importar-acessorias — dispara a sincronização manualmente (botão "Atualizar agora"). */
router.post('/clientes/importar-acessorias', requireAdmin, async (req, res) => {
  try {
    const resultado = await sincronizarAcessorias({ userId: req.user.id });
    await registrarLog(
      req.user.id, req.user.name, 'importar', 'gestao',
      `Sincronização Acessórias: ${resultado.criados} criado(s), ${resultado.atualizados} atualizado(s)`, req
    );
    res.json(resultado);
  } catch (e) {
    console.error('[acessorias] importar falhou:', e);
    res.status(500).json({ error: 'Falha ao sincronizar com Acessórias: ' + e.message });
  }
});

/**
 * Palpite (baixa|saida|null) a partir do motivo de cancelamento BRUTO do Acessórias — corrigido 22/09/2026
 * (Reysner): o combo "Motivo de cancelamento" lá tem "Baixada" (empresa fechou o CNPJ de verdade — modelo de
 * BAIXA no contábil) e três variações de "Transferida por..." (conveniência / mau atendimento / preço — cliente
 * foi pra outro contador, churn de verdade — modelo de SAÍDA no contábil). A checagem antiga procurava
 * "transferência" (substantivo) e nunca batia com "Transferida" (particípio, o texto real do combo) — todo
 * "Transferida por X" caía silenciosamente em "baixa". Determina o tipo do ticket automático (checklist e
 * mencionados mudam entre Baixa/Saída — ver criarTicketInterno) e, no fluxo manual, só entra como dica no
 * TEXTO da notificação; quem confirma de vez é sempre humano, ver PATCH /clientes/:id/resolver-churn.
 */
function palpiteTipoChurn(motivoBruto) {
  const m = String(motivoBruto || '').toLowerCase();
  if (!m) return null;
  if (m.includes('transferida') || m.includes('transferência') || m.includes('transferencia')) return 'saida';
  if (m.includes('baixa')) return 'baixa';
  return null;
}

/**
 * POST /api/data/clientes/importar-baixas-acessorias — pedido do Reysner:
 * "trazer todas as empresas inativas do Acessórias desde 01/11/2024
 * (Cliente até) como notificação pra lançar como baixa ou saída e ter
 * ideia dos principais motivos dos churns". Reaproveita o MESMO tipo de
 * notificação ('churn_acessorias') e o MESMO fluxo de resolução já
 * existente (PATCH /clientes/:id/resolver-churn, aberto pelo sininho) —
 * nada novo no front pra resolver, só pra disparar a busca.
 *
 * Diferente do drift-detection automático de sincronizarAcessorias() (que
 * só pega quem JÁ era 'ativo' aqui e sumiu de lá), isso também traz
 * empresas que NUNCA chegaram a entrar na Carteira — já estavam inativas
 * no Acessórias antes dessa integração existir. Pra essas, cria o cliente
 * como 'ativo' (mesmo já não sendo, de fato) só como placeholder pendente
 * de resolução — assim que a notificação é resolvida, vira 'encerrado' com
 * a data e o motivo reais, igual qualquer outro fluxo de churn.
 *
 * `dryRun: true` só calcula os números, sem escrever nada — usado pelo
 * botão pra mostrar uma prévia antes de aplicar de verdade.
 */
router.post('/clientes/importar-baixas-acessorias', requireAdmin, async (req, res) => {
  try {
    const token = process.env.ACESSORIAS_API_TOKEN;
    if (!token) return res.status(500).json({ error: 'ACESSORIAS_API_TOKEN não configurado.' });
    const desde = (req.body && req.body.desde) || '2024-11-01';
    const dryRun = !!(req.body && req.body.dryRun);

    const inativas = await acessoriasClient.listarEmpresasInativasDesde({ token, desde });

    let jaEncerrados = 0, jaNotificados = 0, novosClientes = 0, novasNotificacoes = 0, semCnpj = 0;
    const erros = [];

    for (const emp of inativas) {
      if (!emp.cnpj) { semCnpj++; continue; }
      try {
        const existente = await pool.query(
          `SELECT id, status FROM clientes WHERE acessorias_id = $1 OR cnpj = $2 LIMIT 1`,
          [emp.acessorias_id, emp.cnpj]
        );

        let clienteId, jaEraAtivo;
        if (existente.rows.length) {
          if (existente.rows[0].status === 'encerrado') { jaEncerrados++; continue; }
          clienteId = existente.rows[0].id;
          jaEraAtivo = true;
        } else {
          jaEraAtivo = false;
          if (!dryRun) {
            clienteId = uuidv4();
            // status='encerrado' direto, não 'ativo' — achado do Reysner:
            // diferente do drift-detection (onde o cliente ERA ativo até
            // agora, cabe deixar 'ativo' pendente de resolução), aqui já
            // SABEMOS que a empresa está inativa desde `clienteAte` — contar
            // como ativa infla "Clientes ativos" à toa (622 virou 756 na
            // 1ª rodada). motivo_saida fica um placeholder óbvio; quem
            // resolve a notificação sobrescreve com o valor real escolhido
            // (resolver-churn não checa status antes de sobrescrever).
            await pool.query(
              `INSERT INTO clientes (id, user_id, cnpj, nome_empresa, regime_tributario, data_entrada, acessorias_id, codigo, status, data_saida, motivo_saida)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'encerrado',$9,$10)`,
              [clienteId, req.user.id, emp.cnpj, emp.nome_empresa, emp.regime_tributario, emp.data_entrada, emp.acessorias_id, emp.codigo,
               emp.clienteAte, 'Pendente de revisão — baixa/saída detectada no Acessórias']
            );
          }
          novosClientes++;
        }

        // Evita duplicar notificação — só checa quando o cliente já existia
        // (cliente novo nunca teve notificação antes).
        const jaTemNotif = jaEraAtivo
          ? await pool.query(
              `SELECT 1 FROM notificacoes WHERE cliente_id = $1 AND tipo = 'churn_acessorias' AND lida = false LIMIT 1`,
              [clienteId]
            )
          : { rows: [] };
        if (jaTemNotif.rows.length) { jaNotificados++; continue; }

        novasNotificacoes++;
        if (!dryRun) {
          const palpite = palpiteTipoChurn(emp.motivoCancelamentoBruto);
          const palpiteTexto = palpite === 'baixa'
            ? ' (Acessórias registrou como Baixada.)'
            : palpite === 'saida'
            ? ` (Acessórias registrou como "${emp.motivoCancelamentoBruto}" — provável Saída/churn real.)`
            : '';
          await pool.query(
            `INSERT INTO notificacoes (tipo, titulo, mensagem, link_modulo, cliente_id)
             VALUES ('churn_acessorias', 'Baixa/saída no Acessórias', $1, 'carteira', $2)`,
            [`${emp.nome_empresa} (CNPJ ${emp.cnpj}) está inativa no Acessórias desde ${emp.clienteAte} — clique pra confirmar se foi baixa ou saída.${palpiteTexto}`, clienteId]
          );
          await pool.query(`UPDATE clientes SET alerta_baixa_notificado_em = NOW() WHERE id = $1`, [clienteId]);
        }
      } catch (e) {
        erros.push({ empresa: emp.nome_empresa, motivo: e.message });
      }
    }

    if (!dryRun) {
      await registrarLog(
        req.user.id, req.user.name, 'importar', 'carteira',
        `Baixas do Acessórias desde ${desde}: ${novasNotificacoes} notificação(ões), ${novosClientes} cliente(s) novo(s) criado(s)`, req
      );
    }

    res.json({
      desde, totalInativasDesde: inativas.length, semCnpj,
      jaEncerrados, jaNotificados, novosClientes, novasNotificacoes, erros, dryRun,
    });
  } catch (e) {
    console.error('[importar-baixas-acessorias] falhou:', e);
    res.status(500).json({ error: 'Falha ao buscar baixas no Acessórias: ' + e.message });
  }
});

/**
 * POST /api/data/clientes/corrigir-baixas-acessorias-status — correção
 * pontual: a 1ª rodada de importar-baixas-acessorias (antes do fix acima)
 * criou os 134 clientes novos como status='ativo', inflando "Clientes
 * Ativos" de 622 pra 756 (achado do Reysner, comparando Dashboard x
 * Carteira). Acha esses 134 pela notificação que só ELES têm (tipo +
 * título exclusivos desse fluxo, ainda não lida) e corrige pra
 * 'encerrado', com a data real (extraída do texto da própria notificação)
 * — nunca mexe em quem já foi resolvido (status != 'ativo' fica de fora).
 * Idempotente: rodar de novo não faz nada se já não sobrar ninguém 'ativo'
 * nesse grupo.
 */
router.post('/clientes/corrigir-baixas-acessorias-status', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT n.cliente_id, n.mensagem
        FROM notificacoes n
        JOIN clientes c ON c.id = n.cliente_id
       WHERE n.tipo = 'churn_acessorias'
         AND n.titulo = 'Baixa/saída no Acessórias'
         AND n.lida = false
         AND c.status = 'ativo'
    `);

    let corrigidos = 0;
    const semData = [];
    for (const r of rows) {
      const m = r.mensagem.match(/está inativa no Acessórias desde (\d{4}-\d{2}-\d{2})/);
      const dataSaida = m ? m[1] : null;
      if (!dataSaida) { semData.push(r.cliente_id); continue; }
      await pool.query(
        `UPDATE clientes SET status = 'encerrado', data_saida = $1,
           motivo_saida = COALESCE(motivo_saida, 'Pendente de revisão — baixa/saída detectada no Acessórias')
         WHERE id = $2 AND status = 'ativo'`,
        [dataSaida, r.cliente_id]
      );
      corrigidos++;
    }

    await registrarLog(
      req.user.id, req.user.name, 'editar', 'carteira',
      `Corrigiu status de ${corrigidos} cliente(s) de baixa/saída do Acessórias (ativo → encerrado)`, req
    );
    res.json({ encontrados: rows.length, corrigidos, semData });
  } catch (e) {
    console.error('[corrigir-baixas-acessorias-status] falhou:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── INSATISFAÇÕES ─────────────────────────────────────────────────────────────
router.get('/insatisfacoes', async (req, res) => {
  try {
    // Achado na auditoria: insatisfação registrada não tinha como ser
    // marcada como resolvida (só apagar, perdendo o histórico). Migração
    // aqui no GET (não só no POST) pra já aparecer em quem já tinha
    // registro antes dessa coluna existir — Postgres aplica o DEFAULT nas
    // linhas existentes também, não só nas novas.
    await pool.query(`ALTER TABLE insatisfacoes ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'aberta'`).catch(()=>{});
    const pf = periodFilter(req.query.period);
    const result = await pool.query(`SELECT * FROM insatisfacoes WHERE 1=1 ${pf} ORDER BY created_at DESC`);
    res.json({ data: result.rows });
  } catch (err) { res.status(500).json({ error: 'Erro.' }); }
});

router.post('/insatisfacoes', async (req, res) => {
  try {
    const { analista, cliente, cnpj, empresa, reclamado, reclamacao, gravidade, area, tipo } = req.body;
    if (!analista || !cliente || !cnpj || !empresa || !reclamacao || !gravidade)
      return res.status(400).json({ error: 'Campos obrigatórios ausentes.' });
    // Auto-migrate columns
    await pool.query(`ALTER TABLE insatisfacoes ADD COLUMN IF NOT EXISTS area TEXT`).catch(()=>{});
    await pool.query(`ALTER TABLE insatisfacoes ADD COLUMN IF NOT EXISTS tipo TEXT`).catch(()=>{});
    await pool.query(`ALTER TABLE insatisfacoes ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'aberta'`).catch(()=>{});
    const id = uuidv4();
    await pool.query(
      `INSERT INTO insatisfacoes (id, user_id, analista, cliente, cnpj, empresa, reclamado, reclamacao, gravidade, area, tipo, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'aberta')`,
      [id, req.user.id, analista, cliente, cnpj, empresa, reclamado || null, reclamacao, gravidade, area||null, tipo||null]
    );
    res.status(201).json({ id });
  } catch (err) { res.status(500).json({ error: 'Erro.' }); }
});

/**
 * PATCH /api/data/insatisfacoes/:id/status — pedido do Reysner (auditoria):
 * insatisfação passa a ter um ciclo de vida (aberta → em andamento →
 * resolvida) em vez de só "registrada ou apagada". Sem requireAdmin de
 * propósito — mesmo padrão de PATCH /pesquisas/:id/tratado, qualquer
 * analista logado pode atualizar o status de uma insatisfação que está
 * tratando.
 */
router.patch('/insatisfacoes/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    if (!['aberta', 'em_andamento', 'resolvida'].includes(status))
      return res.status(400).json({ error: 'Status inválido.' });
    await pool.query(`ALTER TABLE insatisfacoes ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'aberta'`).catch(()=>{});
    const { rows } = await pool.query(
      `UPDATE insatisfacoes SET status = $1 WHERE id = $2 RETURNING id, status`,
      [status, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Insatisfação não encontrada.' });
    res.json({ ok: true, status: rows[0].status });
  } catch (err) { res.status(500).json({ error: 'Erro ao atualizar status.' }); }
});

// ── CLIENTES SENSÍVEIS ────────────────────────────────────────────────────────
router.get('/sensiveis', async (req, res) => {
  try {
    const pf = periodFilter(req.query.period);
    const result = await pool.query(`SELECT * FROM clientes_sensiveis WHERE 1=1 ${pf} ORDER BY created_at DESC`);
    res.json({ data: result.rows });
  } catch (err) { res.status(500).json({ error: 'Erro.' }); }
});

router.post('/sensiveis', async (req, res) => {
  try {
    const { analista, cliente, cnpj, empresa, demonstrou, gravidade, detalhe } = req.body;
    if (!analista || !cliente || !cnpj || !empresa || !demonstrou || !gravidade)
      return res.status(400).json({ error: 'Campos obrigatórios ausentes.' });
    // Garante que coluna detalhe existe (migração automática)
    await pool.query(`ALTER TABLE clientes_sensiveis ADD COLUMN IF NOT EXISTS detalhe TEXT`).catch(() => {});
    const id = uuidv4();
    await pool.query(
      `INSERT INTO clientes_sensiveis (id, user_id, analista, cliente, cnpj, empresa, demonstrou, gravidade, detalhe) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, req.user.id, analista, cliente, cnpj, empresa, demonstrou, gravidade, detalhe || null]
    );
    res.status(201).json({ id });
  } catch (err) { res.status(500).json({ error: 'Erro.' }); }
});

// ── PESQUISAS ─────────────────────────────────────────────────────────────────
router.get('/pesquisas', async (req, res) => {
  try {
    const pf = periodFilter(req.query.period);
    const result = await pool.query(`SELECT * FROM pesquisas WHERE 1=1 ${pf} ORDER BY created_at DESC`);
    res.json({ data: result.rows });
  } catch (err) { res.status(500).json({ error: 'Erro.' }); }
});

router.post('/pesquisas', async (req, res) => {
  try {
    const { analista, cliente, cnpj, empresa, nps, csat, ces, pontos } = req.body;
    if (!analista || !cliente || !cnpj || !empresa || nps == null || csat == null || ces == null)
      return res.status(400).json({ error: 'Campos obrigatórios ausentes.' });
    const id = uuidv4();
    await pool.query(
      `INSERT INTO pesquisas (id, user_id, analista, cliente, cnpj, empresa, nps, csat, ces, pontos) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, req.user.id, analista, cliente, cnpj, empresa, Number(nps), Number(csat), Number(ces), pontos || null]
    );
    res.status(201).json({ id });
  } catch (err) { res.status(500).json({ error: 'Erro.' }); }
});

// ── RECUPERAÇÕES ──────────────────────────────────────────────────────────────
router.get('/recuperacoes', async (req, res) => {
  try {
    await pool.query(`ALTER TABLE recuperacoes ADD COLUMN IF NOT EXISTS insatisfacao_id UUID`).catch(()=>{});
    const pf = periodFilter(req.query.period);
    const result = await pool.query(`SELECT * FROM recuperacoes WHERE 1=1 ${pf} ORDER BY created_at DESC`);
    res.json({ data: result.rows });
  } catch (err) { res.status(500).json({ error: 'Erro.' }); }
});

router.post('/recuperacoes', async (req, res) => {
  try {
    const { analista, cliente, cnpj, empresa, demonstrou, gravidade, insatisfacao_id } = req.body;
    if (!analista || !cliente || !cnpj || !empresa || !demonstrou || !gravidade)
      return res.status(400).json({ error: 'Campos obrigatórios ausentes.' });
    // insatisfacao_id (opcional) — pedido do Reysner (auditoria): vínculo
    // entre a ação de recuperação e a insatisfação que ela está resolvendo.
    // FK lógica, mesmo padrão já usado em cs_vinculos.cliente_id — sem
    // constraint de banco, só pra não travar se um dia a insatisfação for
    // apagada.
    await pool.query(`ALTER TABLE recuperacoes ADD COLUMN IF NOT EXISTS insatisfacao_id UUID`).catch(()=>{});
    const id = uuidv4();
    await pool.query(
      `INSERT INTO recuperacoes (id, user_id, analista, cliente, cnpj, empresa, demonstrou, gravidade, insatisfacao_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, req.user.id, analista, cliente, cnpj, empresa, demonstrou, gravidade, insatisfacao_id || null]
    );
    res.status(201).json({ id });
  } catch (err) { res.status(500).json({ error: 'Erro.' }); }
});

// ── DASHBOARD ─────────────────────────────────────────────────────────────────
router.get('/dashboard', async (req, res) => {
  try {
    const pf = periodFilter(req.query.period);

    const analista = req.query.analista || '';
    // Filtra por PROCURADO (quem o cliente pediu), não por analista (quem digitou o registro) —
    // é o que bate com o gráfico "Por analista procurado" e com o conceito usado no Zappy.
    // Corrigido: antes montava a condição colando o valor direto na string SQL
    // (com um escape manual de aspas); agora usa parâmetro $1 como todo o
    // resto do arquivo já fazia — mesmo padrão, sem exceção.
    const af = analista ? ` AND procurado = $1 ` : '';
    const afParams = analista ? [analista] : [];

    const groupBy = async (table, col, limit=10, extra='') => {
      const r = await pool.query(
        `SELECT COALESCE(${col},'Não informado') as label, COUNT(*) as n
         FROM ${table} WHERE 1=1 ${pf} ${extra}
         GROUP BY ${col} ORDER BY n DESC LIMIT ${limit}`,
        afParams
      );
      return r.rows;
    };
    // Versão SEM limite (para exportações completas: CSV, PDF, relatório)
    const groupByFull = async (table, col, extra='') => {
      const r = await pool.query(
        `SELECT COALESCE(${col},'Não informado') as label, COUNT(*) as n
         FROM ${table} WHERE 1=1 ${pf} ${extra}
         GROUP BY ${col} ORDER BY n DESC`,
        afParams
      );
      return r.rows;
    };
    const avgCol = async (table, col) => {
      const r = await pool.query(`SELECT AVG(${col}) as v FROM ${table} WHERE 1=1 ${pf}`);
      return r.rows[0].v ? parseFloat(r.rows[0].v) : null;
    };

    const safe = async (fn) => { try { return await fn(); } catch(e) { return []; } };
    const safeAvg = async (fn) => { try { return await fn(); } catch(e) { return null; } };

    const [
      atEmpresa, atDepto, atAnalista, atDemanda,
      gcTipo, gcCanal, gcMotivoChurn,
      insGrav, insArea, insTipo, insEmpresa,
      nps, csat, ces,
    ] = await Promise.all([
      safe(() => groupBy('atendimentos', 'empresa', 10, af)),
      safe(() => groupBy('atendimentos', 'departamento', 8, af)),
      safe(() => groupBy('atendimentos', 'procurado', 8, af)),
      safe(() => groupBy('atendimentos', 'demanda', 8, af + " AND demanda IS NOT NULL AND demanda != ''")),
      safe(() => groupBy('gestao_clientes', 'solicitacao', 8)),
      safe(() => groupBy('gestao_clientes', 'canal', 8)),
      // Principais motivos de churn — só "Saída de empresa" (não "Baixa",
      // que não é churn de verdade, ver detectarPossiveisChurns acima).
      safe(() => groupBy('gestao_clientes', 'motivo', 10, "AND solicitacao = 'Saída de empresa' AND motivo IS NOT NULL AND motivo != ''")),
      safe(() => groupBy('insatisfacoes', 'gravidade', 5)),
      safe(() => groupBy('insatisfacoes', 'area', 8)),
      safe(() => groupBy('insatisfacoes', 'tipo', 10)),
      safe(() => groupBy('insatisfacoes', 'empresa', 8)),
      safeAvg(() => avgCol('pesquisas', 'nps')),
      safeAvg(() => avgCol('pesquisas', 'csat')),
      safeAvg(() => avgCol('pesquisas', 'ces')),
    ]);

    // NPS evolution by month
    const npsEvolucao = await pool.query(`
      SELECT TO_CHAR(created_at, 'MM/YYYY') as mes,
        ROUND(AVG(nps)::numeric, 1) as nps,
        ROUND(AVG(csat)::numeric, 1) as csat,
        ROUND(AVG(ces)::numeric, 1) as ces
      FROM pesquisas WHERE 1=1 ${pf}
      GROUP BY TO_CHAR(created_at, 'MM/YYYY'), DATE_TRUNC('month', created_at)
      ORDER BY DATE_TRUNC('month', created_at) ASC
      LIMIT 12
    `).catch(() => ({ rows: [] }));

    // Analistas list for filter
    const analistasList = await pool.query(
      `SELECT DISTINCT procurado FROM atendimentos WHERE procurado IS NOT NULL ORDER BY procurado`
    ).catch(() => ({ rows: [] }));

    // Meses sem reajuste per cliente (for Carteira)
    // Versões COMPLETAS (sem limite) para exportações
    const [
      fEmpresa, fDepto, fAnalista, fDemanda,
      fGcTipo, fGcCanal, fGcMotivoChurn,
      fInsGrav, fInsArea, fInsTipo, fInsEmpresa,
    ] = await Promise.all([
      safe(() => groupByFull('atendimentos', 'empresa', af)),
      safe(() => groupByFull('atendimentos', 'departamento', af)),
      safe(() => groupByFull('atendimentos', 'procurado', af)),
      safe(() => groupByFull('atendimentos', 'demanda', af + " AND demanda IS NOT NULL AND demanda != ''")),
      safe(() => groupByFull('gestao_clientes', 'solicitacao')),
      safe(() => groupByFull('gestao_clientes', 'canal')),
      safe(() => groupByFull('gestao_clientes', 'motivo', "AND solicitacao = 'Saída de empresa' AND motivo IS NOT NULL AND motivo != ''")),
      safe(() => groupByFull('insatisfacoes', 'gravidade')),
      safe(() => groupByFull('insatisfacoes', 'area')),
      safe(() => groupByFull('insatisfacoes', 'tipo')),
      safe(() => groupByFull('insatisfacoes', 'empresa')),
    ]);

    res.json({
      charts: {
        atEmpresa, atDepto, atAnalista: atAnalista, atDemanda,
        gcTipo, gcCanal, gcMotivoChurn,
        insGrav, insArea, insTipo, insEmpresa,
        npsEvolucao: npsEvolucao.rows,
      },
      chartsFull: {
        atEmpresa: fEmpresa, atDepto: fDepto, atAnalista: fAnalista, atDemanda: fDemanda,
        gcTipo: fGcTipo, gcCanal: fGcCanal, gcMotivoChurn: fGcMotivoChurn,
        insGrav: fInsGrav, insArea: fInsArea, insTipo: fInsTipo, insEmpresa: fInsEmpresa,
        npsEvolucao: npsEvolucao.rows,
      },
      nps, csat, ces,
      analistas: analistasList.rows.map(r => r.procurado),
    });
  } catch (err) {
    console.error('Dashboard error:', err);
    res.status(500).json({ error: 'Erro no dashboard.' });
  }
});

// ── MARCAR PESQUISA COMO TRATADA ─────────────────────────────────────────────
router.patch('/pesquisas/:id/tratado', async (req, res) => {
  try {
    // Add column if not exists
    await pool.query(`ALTER TABLE pesquisas ADD COLUMN IF NOT EXISTS tratado BOOLEAN DEFAULT FALSE`).catch(() => {});
    await pool.query(`UPDATE pesquisas SET tratado = TRUE WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao atualizar.' });
  }
});

// ── CLEAR PESQUISAS ──────────────────────────────────────────────────────────────
router.delete('/pesquisas/clear', requireAdmin, async (req, res) => {
  try {
    await pool.query(`DELETE FROM pesquisas`);
    res.json({ ok: true, message: 'Todas as respostas foram removidas.' });
  } catch (err) { res.status(500).json({ error: 'Erro ao limpar respostas.' }); }
});

// ── CLEAR PESQUISAS ──────────────────────────────────────────────────────────────

// ── DELETE INDIVIDUAL ────────────────────────────────────────────────────────────
router.delete('/atendimentos/clear', requireAdmin, async (req, res) => {
  try {
    await pool.query(`DELETE FROM atendimentos`);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Erro ao limpar.' }); }
});

router.delete('/gestao/clear', requireAdmin, async (req, res) => {
  try {
    await pool.query(`DELETE FROM gestao_clientes`);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Erro ao excluir.' }); }
});

router.delete('/insatisfacoes/clear', requireAdmin, async (req, res) => {
  try {
    await pool.query(`DELETE FROM insatisfacoes`);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Erro ao excluir.' }); }
});

router.delete('/sensiveis/clear', requireAdmin, async (req, res) => {
  try {
    await pool.query(`DELETE FROM clientes_sensiveis`);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Erro ao excluir.' }); }
});

router.delete('/pesquisas/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query(`DELETE FROM pesquisas WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Erro ao excluir.' }); }
});

router.delete('/recuperacoes/clear', requireAdmin, async (req, res) => {
  try {
    await pool.query(`DELETE FROM recuperacoes`);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Erro ao excluir.' }); }
});

router.delete('/atendimentos/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query(`DELETE FROM atendimentos WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Erro ao excluir.' }); }
});

router.delete('/gestao/:id', requireAdmin, async (req, res) => {
  try {
    // Remove o ticket vinculado a este registro de Gestão (cascata apaga menções e interações)
    await pool.query(`DELETE FROM tickets WHERE gestao_id = $1`, [req.params.id]).catch(()=>{});
    await pool.query(`DELETE FROM gestao_clientes WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) { console.error('Delete gestao error:', err); res.status(500).json({ error: 'Erro ao excluir.' }); }
});

router.delete('/recuperacoes/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query(`DELETE FROM recuperacoes WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Erro ao limpar.' }); }
});

// ── CARTEIRA — CLIENTES ──────────────────────────────────────────────────────

router.get('/clientes', requireAuth, async (req, res) => {
  try {
    const { status } = req.query;
    let q = `SELECT c.*,
      (SELECT valor FROM honorarios h WHERE h.cliente_id = c.id ORDER BY data_vigencia DESC LIMIT 1) AS honorario_atual,
      (SELECT to_char(data_vigencia,'YYYY-MM-DD') FROM honorarios h WHERE h.cliente_id = c.id ORDER BY data_vigencia DESC LIMIT 1) AS honorario_desde,
      (SELECT obs FROM honorarios h WHERE h.cliente_id = c.id ORDER BY data_vigencia DESC LIMIT 1) AS honorario_obs,
      (SELECT COALESCE(SUM(
        CASE
          WHEN h2.data_vigencia <= CURRENT_DATE THEN
            (EXTRACT(YEAR FROM AGE(
              COALESCE((SELECT MIN(h3.data_vigencia) FROM honorarios h3
                WHERE h3.cliente_id = h2.cliente_id AND h3.data_vigencia > h2.data_vigencia),
                COALESCE(c.data_saida, CURRENT_DATE)
              ), h2.data_vigencia
            )) * 12 +
            EXTRACT(MONTH FROM AGE(
              COALESCE((SELECT MIN(h3.data_vigencia) FROM honorarios h3
                WHERE h3.cliente_id = h2.cliente_id AND h3.data_vigencia > h2.data_vigencia),
                COALESCE(c.data_saida, CURRENT_DATE)
              ), h2.data_vigencia
            ))) * h2.valor
          ELSE 0
        END
      ), 0) FROM honorarios h2 WHERE h2.cliente_id = c.id) AS receita_acumulada,
      (SELECT ROUND((EXTRACT(YEAR FROM AGE(CURRENT_DATE, MAX(h4.data_vigencia)))*12 +
        EXTRACT(MONTH FROM AGE(CURRENT_DATE, MAX(h4.data_vigencia))))::numeric, 0)
       FROM honorarios h4 WHERE h4.cliente_id = c.id) AS meses_sem_reajuste
      FROM clientes c`;
    const params = [];
    if (status && status !== 'todos') { q += ` WHERE c.status = $1`; params.push(status); }
    q += ` ORDER BY c.nome_empresa ASC`;
    const result = await pool.query(q, params);
    res.json({ data: result.rows });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro ao buscar clientes.' }); }
});

router.post('/clientes', requireAuth, async (req, res) => {
  try {
    const { cnpj, nome_empresa, regime_tributario, data_entrada, honorario_inicial,
            origem, cac, obs, grupo_empresas, unidade, tipo_entrada, inadimplente_cronico } = req.body;
    if (!cnpj || !nome_empresa || !data_entrada || !honorario_inicial)
      return res.status(400).json({ error: 'Campos obrigatórios faltando.' });
    const { v4: uuidv4 } = require('uuid');
    const clienteId = uuidv4();
    // Auto-add colunas novas se não existirem
    await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS codigo TEXT`).catch(()=>{});
    await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS grupo_empresas TEXT`).catch(()=>{});
    await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS tipo_entrada TEXT`).catch(()=>{});
    await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS inadimplente_cronico BOOLEAN DEFAULT FALSE`).catch(()=>{});
    await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS unidade TEXT`).catch(()=>{});
    const { codigo } = req.body;
    await pool.query(
      `INSERT INTO clientes (id, user_id, cnpj, nome_empresa, regime_tributario, data_entrada,
        honorario_inicial, origem, cac, obs, codigo, grupo_empresas, unidade, tipo_entrada, inadimplente_cronico)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [clienteId, req.user.id, cnpj, nome_empresa, regime_tributario || null,
       data_entrada, honorario_inicial, origem || null, cac || 0, obs || null, codigo || null,
       grupo_empresas || null, unidade || null, tipo_entrada || null, inadimplente_cronico === true || inadimplente_cronico === 'true']
    );
    // Registrar honorário inicial no histórico
    await pool.query(
      `INSERT INTO honorarios (cliente_id, valor, data_vigencia, obs)
       VALUES ($1,$2,$3,'Honorário inicial')`,
      [clienteId, honorario_inicial, data_entrada]
    );
    // Registrar evento de entrada
    await pool.query(
      `INSERT INTO eventos_clientes (cliente_id, tipo, descricao, valor_novo, data_evento)
       VALUES ($1,'entrada',$2,$3,$4)`,
      [clienteId, `Entrada — ${nome_empresa}`, honorario_inicial, data_entrada]
    );
    await registrarLog(req.user.id, req.user.name, 'criar', 'carteira', `Novo cliente: ${nome_empresa}`, req);
    res.json({ ok: true, id: clienteId });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro ao cadastrar cliente.' }); }
});

router.get('/clientes/:id', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM clientes WHERE id = $1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Cliente não encontrado.' });
    const honorarios = await pool.query(
      `SELECT * FROM honorarios WHERE cliente_id = $1 ORDER BY data_vigencia DESC`, [req.params.id]);
    const eventos = await pool.query(
      `SELECT * FROM eventos_clientes WHERE cliente_id = $1 ORDER BY data_evento DESC`, [req.params.id]);
    res.json({ cliente: rows[0], honorarios: honorarios.rows, eventos: eventos.rows });
  } catch (err) { res.status(500).json({ error: 'Erro ao buscar cliente.' }); }
});

/**
 * PATCH /api/data/clientes/:id — edita dados CADASTRAIS do cliente (nome,
 * CNPJ, código, regime, origem, grupo, unidade, data de entrada). Não mexe
 * em honorário (isso é só por POST /clientes/:id/honorario, que mantém
 * histórico) nem em status (isso é só por /encerrar). Pedido do Reysner:
 * botão "Editar" na Carteira, do lado do "$+".
 */
router.patch('/clientes/:id', requireAdmin, async (req, res) => {
  try {
    const { nome_empresa, cnpj, codigo, regime_tributario, origem, grupo_empresas, unidade, data_entrada } = req.body;
    if (!nome_empresa || !cnpj) return res.status(400).json({ error: 'Nome da empresa e CNPJ são obrigatórios.' });
    const { rows } = await pool.query(
      `UPDATE clientes SET
         nome_empresa = $1, cnpj = $2, codigo = $3, regime_tributario = $4,
         origem = $5, grupo_empresas = $6, unidade = $7,
         data_entrada = COALESCE($8, data_entrada)
       WHERE id = $9
       RETURNING id`,
      [nome_empresa, cnpj, codigo || null, regime_tributario || null,
       origem || null, grupo_empresas || null, unidade || null, data_entrada || null, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Cliente não encontrado.' });
    await registrarLog(req.user.id, req.user.name, 'editar', 'carteira', `Editou cadastro: ${nome_empresa}`, req);
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro ao editar cliente.' }); }
});

router.patch('/clientes/:id/encerrar', requireAdmin, async (req, res) => {
  try {
    const { data_saida, motivo_saida } = req.body;
    await pool.query(
      `UPDATE clientes SET status='encerrado', data_saida=$1, motivo_saida=$2 WHERE id=$3`,
      [data_saida, motivo_saida, req.params.id]
    );
    await pool.query(
      `INSERT INTO eventos_clientes (cliente_id, tipo, descricao, data_evento)
       VALUES ($1,'saida',$2,$3)`,
      [req.params.id, motivo_saida || 'Encerramento', data_saida]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Erro ao encerrar cliente.' }); }
});

/**
 * PATCH /api/data/clientes/:id/resolver-churn — resolve a notificação de
 * "possível baixa/saída no Acessórias" (pedido do Reysner, fluxo completo):
 * clica na notificação, escolhe se foi Baixa ou Saída, confirma:
 *   - Baixa: encerra o cliente com motivo_saida = "Baixa de empresa" — não
 *     pede motivo do churn (não é churn de verdade, empresário fechou o
 *     CNPJ por motivo diverso).
 *   - Saída: exige `motivoChurn` (vindo da lista gerenciável de Motivos de
 *     Churn) e encerra o cliente com esse motivo.
 * Nos dois casos: encerra o cliente (sai de "ativas" na Carteira e em
 * Gestão de Clientes, que reflete o status via o mesmo cliente), cria um
 * registro em Gestão de Clientes documentando o evento (mesmo padrão de
 * quando alguém preenche isso manualmente) e marca a notificação como lida.
 */
router.patch('/clientes/:id/resolver-churn', requireAdmin, async (req, res) => {
  try {
    const { tipo, motivoChurn, notificacaoId } = req.body;
    if (tipo !== 'baixa' && tipo !== 'saida') {
      return res.status(400).json({ error: 'tipo precisa ser "baixa" ou "saida".' });
    }
    if (tipo === 'saida' && !motivoChurn) {
      return res.status(400).json({ error: 'Motivo do Churn é obrigatório para Saída de empresa.' });
    }
    // Idempotente — já roda em sincronizarAcessorias(), mas garante aqui
    // também pro caso desse endpoint ser chamado antes de qualquer sync.
    await pool.query(`ALTER TABLE gestao_clientes ALTER COLUMN data_sol DROP NOT NULL`).catch(() => {});
    await pool.query(`ALTER TABLE gestao_clientes ALTER COLUMN competencia DROP NOT NULL`).catch(() => {});

    const { rows } = await pool.query(`SELECT * FROM clientes WHERE id = $1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Cliente não encontrado.' });
    const cliente = rows[0];

    const solicitacao = tipo === 'baixa' ? 'Baixa de empresa' : 'Saída de empresa';
    const motivo = tipo === 'baixa' ? 'Baixa de empresa' : motivoChurn;
    const hoje = new Date().toISOString().slice(0, 10);

    // Pedido do Reysner: pegar a data real de saída ("Cliente até") direto
    // do Acessórias em vez de usar "hoje" — a Acessórias já sabe quando o
    // cliente saiu de verdade. Se a busca falhar por qualquer motivo (token
    // não configurado, empresa não encontrada, API fora do ar), cai pra
    // "hoje" — nunca trava a resolução do churn por causa disso.
    let dataSaida = hoje;
    const token = process.env.ACESSORIAS_API_TOKEN;
    if (token && cliente.cnpj) {
      const empresaAcessorias = await acessoriasClient.buscarEmpresaPorCnpj(cliente.cnpj, token);
      if (empresaAcessorias?.clienteAte) dataSaida = empresaAcessorias.clienteAte;
    }

    await pool.query(
      `UPDATE clientes SET status='encerrado', data_saida=$1, motivo_saida=$2 WHERE id=$3`,
      [dataSaida, motivo, cliente.id]
    );
    await pool.query(
      `INSERT INTO eventos_clientes (cliente_id, tipo, descricao, data_evento)
       VALUES ($1,'saida',$2,$3)`,
      [cliente.id, motivo, dataSaida]
    );
    // Espelha em Gestão de Clientes, mesmo padrão de quando isso é
    // preenchido manualmente pelo formulário. Diferente da ENTRADA (onde o
    // Reysner pediu pra tirar Data da Solicitação/Competência), o
    // formulário EXIGE esses dois campos pra Saída/Baixa de empresa — usa
    // a data real de saída (já buscada acima) em vez de deixar null, senão
    // esse registro fica "incompleto" comparado ao que o formulário exige.
    const gestaoId = uuidv4();
    await pool.query(
      `INSERT INTO gestao_clientes (id, user_id, analista, solicitacao, cnpj, empresa, data_sol, competencia, canal, motivo, codigo, regime_tributario)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'Outro',$9,$10,$11)`,
      [gestaoId, req.user.id, req.user.name, solicitacao, cliente.cnpj, cliente.nome_empresa,
       dataSaida, dataSaida.slice(0, 7), motivo, cliente.codigo, cliente.regime_tributario]
    );
    if (notificacaoId) {
      await pool.query(`UPDATE notificacoes SET lida = true WHERE id = $1`, [notificacaoId]);
    }
    await registrarLog(req.user.id, req.user.name, 'encerrar', 'carteira', `Resolveu churn (${solicitacao}): ${cliente.nome_empresa} — ${motivo}`, req);
    // Devolve os dados que o front precisa pra oferecer "Abrir Ticket
    // Contábil" também aqui — pedido do Reysner: o fluxo manual (Forms.
    // gestao()) já faz esse convite, o fluxo pela notificação não fazia.
    res.json({
      ok: true,
      empresa: cliente.nome_empresa, cnpj: cliente.cnpj, regime: cliente.regime_tributario,
      codigo: cliente.codigo, solicitacao, motivo, dataSaida, gestaoId,
    });
  } catch (err) {
    console.error('[resolver-churn] falhou:', err);
    res.status(500).json({ error: 'Erro ao resolver churn.' });
  }
});

/**
 * PATCH /api/data/clientes/:id/completar-entrada — resolve a notificação de
 * "novo cliente no Acessórias" (pedido do Reysner): nem todo cliente novo
 * vem completo de lá — falta classificar o TIPO de entrada de verdade
 * (Constituição de empresa / Cliente vindo de outro contador /
 * Transformação de empresa — a sincronização sempre usa "Cliente vindo de
 * outro contador" como valor genérico, porque não dá pra saber qual é o
 * certo automaticamente) e preencher Honorário Inicial e Origem, que a
 * gente nunca traz do Acessórias de propósito.
 *
 * Atualiza a linha de Gestão de Clientes já criada na sincronização (em vez
 * de criar uma segunda) — troca a solicitação genérica pela real escolhida
 * aqui.
 */
router.patch('/clientes/:id/completar-entrada', requireAdmin, async (req, res) => {
  try {
    const { tipoEntrada, honorarioInicial, origem, dataEntrada, notificacaoId } = req.body;
    if (!SOLICITACOES_ENTRADA.includes(tipoEntrada)) {
      return res.status(400).json({ error: 'Tipo de entrada inválido.' });
    }
    const honorarioNum = parseFloat(honorarioInicial);
    if (!honorarioNum || honorarioNum <= 0) {
      return res.status(400).json({ error: 'Honorário Inicial é obrigatório.' });
    }

    const { rows } = await pool.query(`SELECT * FROM clientes WHERE id = $1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Cliente não encontrado.' });
    const cliente = rows[0];
    const dataVigencia = dataEntrada || cliente.data_entrada || new Date().toISOString().slice(0, 10);

    await pool.query(
      `UPDATE clientes SET tipo_entrada = $1, origem = COALESCE($2, origem), data_entrada = COALESCE($3, data_entrada) WHERE id = $4`,
      [tipoEntrada, origem || null, dataEntrada || null, cliente.id]
    );
    await pool.query(
      `INSERT INTO honorarios (cliente_id, valor, data_vigencia, obs) VALUES ($1,$2,$3,'Honorário inicial (completado via notificação)')`,
      [cliente.id, honorarioNum, dataVigencia]
    );
    await pool.query(
      `INSERT INTO eventos_clientes (cliente_id, tipo, descricao, valor_novo, data_evento) VALUES ($1,'entrada',$2,$3,$4)`,
      [cliente.id, `Entrada — ${cliente.nome_empresa}`, honorarioNum, dataVigencia]
    );
    // Troca a solicitação genérica pela real na linha de Gestão já criada
    // (não cria uma segunda linha pra mesma entrada). UPDATE não aceita
    // ORDER BY/LIMIT direto no Postgres — por isso a subquery.
    await pool.query(
      `UPDATE gestao_clientes SET solicitacao = $1
        WHERE id = (
          SELECT id FROM gestao_clientes
           WHERE cnpj = $2 AND solicitacao = 'Cliente vindo de outro contador'
             AND motivo IN ('Importado automaticamente do Sistema Acessórias', 'Registro completado a partir da Carteira (cliente já existia sem essa linha)')
           ORDER BY created_at DESC LIMIT 1
        )`,
      [tipoEntrada, cliente.cnpj]
    );
    if (notificacaoId) {
      await pool.query(`UPDATE notificacoes SET lida = true WHERE id = $1`, [notificacaoId]);
    }
    await registrarLog(req.user.id, req.user.name, 'editar', 'carteira', `Completou entrada (${tipoEntrada}): ${cliente.nome_empresa}`, req);
    res.json({ ok: true });
  } catch (err) {
    console.error('[completar-entrada] falhou:', err);
    res.status(500).json({ error: 'Erro ao completar entrada.' });
  }
});

router.post('/clientes/:id/honorario', requireAdmin, async (req, res) => {
  try {
    const { valor, data_vigencia, obs } = req.body;
    if (!valor || !data_vigencia) return res.status(400).json({ error: 'Valor e data obrigatórios.' });
    // Buscar honorário anterior
    const ant = await pool.query(
      `SELECT valor FROM honorarios WHERE cliente_id=$1 ORDER BY data_vigencia DESC LIMIT 1`, [req.params.id]);
    const valorAnterior = ant.rows[0]?.valor || 0;
    await pool.query(
      `INSERT INTO honorarios (cliente_id, valor, data_vigencia, obs) VALUES ($1,$2,$3,$4)`,
      [req.params.id, valor, data_vigencia, obs || null]
    );
    await pool.query(
      `INSERT INTO eventos_clientes (cliente_id, tipo, descricao, valor_anterior, valor_novo, data_evento)
       VALUES ($1,'reajuste','Atualização de honorário',$2,$3,$4)`,
      [req.params.id, valorAnterior, valor, data_vigencia]
    );
    await registrarLog(req.user.id, req.user.name, 'editar', 'carteira', `Honorário atualizado: R$ ${valor}`, req);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Erro ao atualizar honorário.' }); }
});

/**
 * POST /api/data/clientes/reajuste-em-massa — aplica um reajuste percentual
 * ao honorário de TODOS os clientes ativos com honorário cadastrado. Pedido
 * do Reysner: um campo pra definir uma porcentagem e aplicar pra toda a
 * carteira de uma vez, em vez de cliente por cliente.
 *
 * Mesmo padrão do reajuste individual (POST /clientes/:id/honorario): cria
 * uma NOVA linha em `honorarios` (mantém histórico intacto, nunca sobrescreve
 * o valor anterior) + um evento 'reajuste' em `eventos_clientes`, por cliente
 * afetado. Clientes com honorário zerado/pendente são pulados de propósito —
 * X% de R$ 0,00 continua R$ 0,00, e criar um registro assim só poluiria o
 * histórico à toa (esses clientes ficam sinalizados como "honorário
 * pendente" nas telas que já tratam esse caso, não é isso que este endpoint
 * resolve). Também só considera clientes ATIVOS — encerrado não tem
 * honorário a reajustar.
 */
router.post('/clientes/reajuste-em-massa', requireAdmin, async (req, res) => {
  try {
    const { percentual, data_vigencia, obs } = req.body;
    const pct = parseFloat(String(percentual).replace(',', '.'));
    if (!pct || isNaN(pct)) return res.status(400).json({ error: 'Percentual é obrigatório e não pode ser zero.' });
    if (!data_vigencia) return res.status(400).json({ error: 'Data de vigência é obrigatória.' });

    const { rows: alvos } = await pool.query(`
      SELECT c.id, h.valor AS honorario_atual
      FROM clientes c
      JOIN LATERAL (
        SELECT valor FROM honorarios h2 WHERE h2.cliente_id = c.id ORDER BY data_vigencia DESC LIMIT 1
      ) h ON true
      WHERE c.status = 'ativo' AND h.valor > 0
    `);

    const observacao = (obs && obs.trim()) || `Reajuste em massa (${pct > 0 ? '+' : ''}${pct}%)`;
    let totalAnterior = 0, totalNovo = 0;
    for (const alvo of alvos) {
      const valorAnterior = parseFloat(alvo.honorario_atual);
      const valorNovo = Math.round(valorAnterior * (1 + pct / 100) * 100) / 100;
      totalAnterior += valorAnterior;
      totalNovo += valorNovo;
      await pool.query(
        `INSERT INTO honorarios (cliente_id, valor, data_vigencia, obs) VALUES ($1,$2,$3,$4)`,
        [alvo.id, valorNovo, data_vigencia, observacao]
      );
      await pool.query(
        `INSERT INTO eventos_clientes (cliente_id, tipo, descricao, valor_anterior, valor_novo, data_evento)
         VALUES ($1,'reajuste',$2,$3,$4,$5)`,
        [alvo.id, observacao, valorAnterior, valorNovo, data_vigencia]
      );
    }

    await registrarLog(
      req.user.id, req.user.name, 'editar', 'carteira',
      `Reajuste em massa: ${pct > 0 ? '+' : ''}${pct}% em ${alvos.length} cliente(s) (R$ ${totalAnterior.toFixed(2)} → R$ ${totalNovo.toFixed(2)})`,
      req
    );

    res.json({ ok: true, afetados: alvos.length, totalAnterior, totalNovo });
  } catch (err) {
    console.error('[reajuste-em-massa] falhou:', err);
    res.status(500).json({ error: 'Erro ao aplicar reajuste em massa.' });
  }
});

router.get('/carteira/dashboard', requireAuth, async (req, res) => {
  try {
    // MRR = soma dos honorários vigentes de clientes ativos
    const mrr = await pool.query(`
      SELECT COALESCE(SUM(h.valor), 0) AS mrr
      FROM clientes c
      JOIN LATERAL (
        SELECT valor FROM honorarios h2
        WHERE h2.cliente_id = c.id ORDER BY data_vigencia DESC LIMIT 1
      ) h ON true
      WHERE c.status = 'ativo'`);
    const ativos = await pool.query(`SELECT COUNT(*) FROM clientes WHERE status='ativo'`);
    const encerrados = await pool.query(`SELECT COUNT(*) FROM clientes WHERE status='encerrado'`);
    // Ticket médio
    const ticket = await pool.query(`
      SELECT COALESCE(AVG(h.valor), 0) AS ticket
      FROM clientes c
      JOIN LATERAL (
        SELECT valor FROM honorarios h2
        WHERE h2.cliente_id = c.id ORDER BY data_vigencia DESC LIMIT 1
      ) h ON true
      WHERE c.status = 'ativo'`);
    // Tempo médio retenção (meses) de clientes encerrados
    const retencao = await pool.query(`
      SELECT COALESCE(AVG(
        EXTRACT(YEAR FROM AGE(data_saida, data_entrada))*12 +
        EXTRACT(MONTH FROM AGE(data_saida, data_entrada))
      ), 0) AS meses
      FROM clientes WHERE status='encerrado' AND data_saida IS NOT NULL`);
    const mesesMedio = parseFloat(retencao.rows[0].meses) || 48;
    const ticketMedio = parseFloat(ticket.rows[0].ticket) || 0;
    const mrrVal = parseFloat(mrr.rows[0].mrr) || 0;
    const omie = await pool.query(`SELECT unidade, MAX(importado_em) AS em FROM financeiro_importacoes GROUP BY unidade ORDER BY unidade`).catch(() => ({ rows: [] }));
    res.json({
      mrr: mrrVal,
      omie_leituras: omie.rows.map(r => ({ unidade: r.unidade, em: r.em })),
      arr: mrrVal * 12,
      ativos: parseInt(ativos.rows[0].count),
      encerrados: parseInt(encerrados.rows[0].count),
      ticket_medio: ticketMedio,
      ltv_medio_projetado: ticketMedio * mesesMedio,
      retencao_media_meses: mesesMedio,
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro no dashboard.' }); }
});

/**
 * DELETE /api/data/clientes/clear — apaga a Carteira INTEIRA. Antes só
 * dependia de ser admin; um clique errado (ou um token vazado) zerava tudo
 * de uma vez. Agora exige que o front mande a frase exata de confirmação
 * no corpo da requisição — segunda trava, além do backup diário automático.
 */
router.delete('/clientes/clear', requireAdmin, async (req, res) => {
  try {
    const FRASE_CONFIRMACAO = 'EXCLUIR TODOS OS CLIENTES';
    const { confirmar } = req.body || {};
    if (confirmar !== FRASE_CONFIRMACAO) {
      return res.status(400).json({
        error: `Ação bloqueada: para confirmar, é preciso enviar o texto exato "${FRASE_CONFIRMACAO}".`,
      });
    }
    await pool.query('DELETE FROM clientes');
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Erro ao excluir.' }); }
});

router.delete('/clientes/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM clientes WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Erro ao limpar.' }); }
});

// ── CLEAR INSATISFACOES ──────────────────────────────────────────────────────────
router.delete('/insatisfacoes/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query(`DELETE FROM insatisfacoes WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Erro ao limpar registros.' }); }
});

// ── CLEAR SENSIVEIS ──────────────────────────────────────────────────────────────
router.delete('/sensiveis/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query(`DELETE FROM clientes_sensiveis WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Erro ao limpar registros.' }); }
});

// ── CLEAR ─────────────────────────────────────────────────────────────────────
router.delete('/clear', requireAdmin, async (req, res) => {
  try {
    const pf = periodFilter(req.query.period);
    const condition = req.query.period === 'todos' ? '' : `WHERE 1=1 ${pf}`;
    const tables = ['atendimentos','gestao_clientes','insatisfacoes','clientes_sensiveis','pesquisas','recuperacoes'];
    for (const t of tables) await pool.query(`DELETE FROM ${t} ${condition}`);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Erro ao limpar dados.' }); }
});

// ── PERFIL ───────────────────────────────────────────────────────────────────
router.patch('/perfil', requireAuth, async (req, res) => {
  try {
    const { nome, email, senhaAtual, senhaNova } = req.body;
    if (!nome) return res.status(400).json({ error: 'Nome obrigatorio.' });
    if (!senhaAtual) return res.status(400).json({ error: 'Senha atual obrigatoria.' });

    const bcrypt = require('bcryptjs');

    // Busca usuario com todas as colunas
    const u = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
    if (!u.rows.length) return res.status(404).json({ error: 'Usuario nao encontrado.' });

    const user = u.rows[0];
    const hashAtual = user.password_hash || user.password;
    if (!hashAtual) return res.status(500).json({ error: 'Hash nao encontrado.' });

    const valid = await bcrypt.compare(senhaAtual, hashAtual);
    if (!valid) return res.status(400).json({ error: 'Senha atual incorreta.' });

    // Verifica se e-mail ja esta em uso por outro usuario
    if (email && email.toLowerCase().trim() !== (user.email||'').toLowerCase().trim()) {
      const dup = await pool.query(
        'SELECT id FROM users WHERE LOWER(email) = LOWER($1) AND id != $2',
        [email, req.user.id]
      );
      if (dup.rows.length) return res.status(400).json({ error: 'Este e-mail ja esta em uso.' });
    }

    // Atualiza nome e e-mail
    if (email) {
      await pool.query('UPDATE users SET name = $1, email = $2 WHERE id = $3', [nome, email.toLowerCase().trim(), req.user.id]);
    } else {
      await pool.query('UPDATE users SET name = $1 WHERE id = $2', [nome, req.user.id]);
    }

    // Atualiza senha se informada
    if (senhaNova) {
      const novoHash = await bcrypt.hash(senhaNova, 10);
      if (user.password_hash !== undefined) {
        await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [novoHash, req.user.id]);
      } else {
        await pool.query('UPDATE users SET password = $1 WHERE id = $2', [novoHash, req.user.id]);
      }
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Perfil error:', err.message);
    res.status(500).json({ error: 'Erro: ' + err.message });
  }
});


// ── CAC / INVESTIMENTOS ──────────────────────────────────────────────────────

router.get('/investimentos', requireAuth, async (req, res) => {
  try {
    const { mes } = req.query;
    let q = `SELECT i.*, u.name as lancado_por FROM investimentos i
             LEFT JOIN users u ON u.id = i.user_id`;
    const params = [];
    if (mes && mes !== 'todos') {
      q += ` WHERE i.mes = $1`;
      params.push(mes);
    }
    q += ` ORDER BY i.mes DESC, i.created_at DESC`;
    const { rows } = await pool.query(q, params);
    res.json({ data: rows });
  } catch (err) { res.status(500).json({ error: 'Erro ao buscar investimentos.' }); }
});

router.post('/investimentos', requireAdmin, async (req, res) => {
  try {
    const { mes, canal, valor, descricao, recorrente } = req.body;
    if (!mes || !canal || !valor)
      return res.status(400).json({ error: 'Mês, canal e valor são obrigatórios.' });
    const { v4: uuidv4 } = require('uuid');
    // Auto-add columns if not exist
    await pool.query(`ALTER TABLE investimentos ADD COLUMN IF NOT EXISTS recorrente BOOLEAN DEFAULT false`).catch(()=>{});
    await pool.query(`ALTER TABLE investimentos ADD COLUMN IF NOT EXISTS valor_original NUMERIC(10,2)`).catch(()=>{});
    const id = uuidv4();
    await pool.query(
      `INSERT INTO investimentos (id, user_id, mes, canal, valor, descricao, recorrente)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, req.user.id, mes, canal, parseFloat(valor), descricao||null, recorrente||false]
    );
    res.status(201).json({ ok: true, id });
  } catch (err) { res.status(500).json({ error: 'Erro ao lançar investimento.' }); }
});

router.patch('/investimentos/:id', requireAdmin, async (req, res) => {
  try {
    const { valor, descricao } = req.body;
    if (!valor) return res.status(400).json({ error: 'Valor obrigatório.' });
    // Save original value on first edit if not already saved
    await pool.query(`ALTER TABLE investimentos ADD COLUMN IF NOT EXISTS valor_original NUMERIC(10,2)`).catch(()=>{});
    const cur = await pool.query(`SELECT valor, valor_original FROM investimentos WHERE id = $1`, [req.params.id]);
    if (!cur.rows.length) return res.status(404).json({ error: 'Não encontrado.' });
    const valorOriginal = cur.rows[0].valor_original || cur.rows[0].valor;
    await pool.query(
      `UPDATE investimentos SET valor = $1, descricao = $2, valor_original = $3 WHERE id = $4`,
      [parseFloat(valor), descricao||cur.rows[0].descricao||null, valorOriginal, req.params.id]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Erro ao editar.' }); }
});

router.delete('/investimentos/clear', requireAdmin, async (req, res) => {
  try {
    await pool.query(`DELETE FROM investimentos`);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Erro ao excluir.' }); }
});

router.delete('/investimentos/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query(`DELETE FROM investimentos WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Erro ao limpar.' }); }
});

router.get('/cac/dashboard', requireAuth, async (req, res) => {
  try {
    const { mes } = req.query;
    let pf = '';
    const params = [];
    if (mes && mes !== 'todos') { pf = `WHERE mes = $1`; params.push(mes); }

    // Total investido no período
    const invResult = await pool.query(
      `SELECT COALESCE(SUM(valor),0) as total, canal, SUM(valor) as val_canal
       FROM investimentos ${pf}
       GROUP BY canal ORDER BY val_canal DESC`, params
    );
    const totalInv = invResult.rows.reduce((s,r) => s + parseFloat(r.val_canal||0), 0);
    const melhorCanal = invResult.rows[0]?.canal || '—';
    const maiorInv = invResult.rows[0]?.val_canal || 0;

    // Clientes adquiridos no período (entradas na Carteira naquele mês).
    // Decisão do Reysner: só conta quem está ATIVO hoje — antes contava
    // todo mundo que já entrou (inclusive quem já saiu depois), e isso
    // ficou visível quando importamos 134 baixas históricas do Acessórias
    // (622 ativos virou 756 aqui, igual ao card de Clientes Ativos da
    // Carteira antes da correção).
    let cliQ = `SELECT COUNT(*) as n FROM clientes WHERE status = 'ativo'`;
    let cliParams = [];
    if (mes && mes !== 'todos') {
      cliQ += ` AND TO_CHAR(data_entrada,'YYYY-MM') = $1`;
      cliParams.push(mes);
    }
    const cliResult = await pool.query(cliQ, cliParams);
    const totalCli = parseInt(cliResult.rows[0]?.n || 0);

    // CAC médio = total investido no mês ÷ clientes adquiridos no mês
    const cacMedio = totalCli > 0 ? totalInv / totalCli : 0;

    // LTV médio da carteira
    const ltvResult = await pool.query(`
      SELECT COALESCE(AVG(
        (SELECT valor FROM honorarios h WHERE h.cliente_id = c.id ORDER BY data_vigencia DESC LIMIT 1)
      ), 0) * 48 as ltv_medio
      FROM clientes c WHERE c.status = 'ativo'
    `);
    const ltvMedio = parseFloat(ltvResult.rows[0]?.ltv_medio || 0);
    const ltvCac = cacMedio > 0 ? (ltvMedio / cacMedio).toFixed(1) : '—';

    // Meses disponíveis para filtro
    const meses = await pool.query(
      `SELECT DISTINCT mes FROM investimentos ORDER BY mes DESC`
    );

    res.json({
      totalInv, totalCli, cacMedio, melhorCanal,
      maiorInv: parseFloat(maiorInv),
      ltvMedio, ltvCac,
      canais: invResult.rows,
      meses: meses.rows.map(r => r.mes),
    });
  } catch (err) {
    console.error('CAC dashboard error:', err);
    res.status(500).json({ error: 'Erro no dashboard CAC.' });
  }
});

// ── NOTIFICAÇÕES ─────────────────────────────────────────────────────────────
router.get('/notificacoes', requireAuth, async (req, res) => {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS notificacoes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tipo TEXT NOT NULL, titulo TEXT NOT NULL, mensagem TEXT NOT NULL,
      lida BOOLEAN DEFAULT false, link_modulo TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`).catch(()=>{});
    const { rows } = await pool.query(
      `SELECT * FROM notificacoes ORDER BY lida ASC, created_at DESC LIMIT 50`
    );
    const naoLidas = rows.filter(r => !r.lida).length;
    res.json({ data: rows, naoLidas });
  } catch (err) { res.status(500).json({ error: 'Erro ao buscar notificações.' }); }
});

router.patch('/notificacoes/:id/lida', requireAuth, async (req, res) => {
  try {
    await pool.query(`UPDATE notificacoes SET lida = true WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Erro.' }); }
});

router.patch('/notificacoes/todas/lidas', requireAuth, async (req, res) => {
  try {
    await pool.query(`UPDATE notificacoes SET lida = true WHERE lida = false`);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Erro.' }); }
});

// Criar notificação automaticamente ao registrar insatisfação alta
router.post('/notificacoes', requireAuth, async (req, res) => {
  try {
    const { tipo, titulo, mensagem, link_modulo } = req.body;
    await pool.query(
      `INSERT INTO notificacoes (tipo, titulo, mensagem, link_modulo) VALUES ($1,$2,$3,$4)`,
      [tipo, titulo, mensagem, link_modulo || null]
    );
    res.status(201).json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Erro.' }); }
});

// ── RELATÓRIO EXECUTIVO ───────────────────────────────────────────────────────
router.get('/relatorio-executivo', requireAdmin, async (req, res) => {
  try {
    const { mes } = req.query; // formato: 2026-06
    const mesAtual = mes || new Date().toISOString().slice(0,7);
    // Valida o formato ANTES de colar `mesAtual` dentro de uma string SQL
    // abaixo (`pf`) — sem isso, um valor malicioso em ?mes= ia direto pra
    // dentro da query (mesmo risco do filtro de analista no /dashboard,
    // corrigido acima). Com o formato garantido AAAA-MM (só dígito e
    // hífen), fica seguro interpolar.
    if (!/^\d{4}-\d{2}$/.test(mesAtual)) {
      return res.status(400).json({ error: 'Parâmetro "mes" inválido. Use o formato AAAA-MM.' });
    }
    const [ano, m] = mesAtual.split('-');
    const inicio = `${mesAtual}-01`;
    const fim = new Date(parseInt(ano), parseInt(m), 0).toISOString().slice(0,10);

    const pf = `AND created_at >= '${inicio}' AND created_at <= '${fim} 23:59:59'`;

    // Totais por módulo
    const totais = {};
    for (const [key, table] of [
      ['atendimentos','atendimentos'], ['gestoes','gestao_clientes'],
      ['insatisfacoes','insatisfacoes'], ['sensiveis','clientes_sensiveis'],
      ['pesquisas','pesquisas'], ['recuperacoes','recuperacoes']
    ]) {
      const r = await pool.query(`SELECT COUNT(*) as n FROM ${table} WHERE 1=1 ${pf}`);
      totais[key] = parseInt(r.rows[0].n);
    }

    // Insatisfações por gravidade
    const insGrav = await pool.query(
      `SELECT gravidade, COUNT(*) as n FROM insatisfacoes WHERE 1=1 ${pf} GROUP BY gravidade ORDER BY n DESC`
    );

    // Insatisfações por área
    const insArea = await pool.query(
      `SELECT COALESCE(area,'Não informado') as area, COUNT(*) as n FROM insatisfacoes WHERE 1=1 ${pf} GROUP BY area ORDER BY n DESC`
    ).catch(() => ({ rows: [] }));

    // Top empresas com insatisfação
    const insEmpresas = await pool.query(
      `SELECT empresa, COUNT(*) as n FROM insatisfacoes WHERE 1=1 ${pf} GROUP BY empresa ORDER BY n DESC`
    );

    // Atendimentos por departamento
    const atDepto = await pool.query(
      `SELECT departamento, COUNT(*) as n FROM atendimentos WHERE 1=1 ${pf} GROUP BY departamento ORDER BY n DESC`
    );

    // Atendimentos por analista procurado
    const atAnalista = await pool.query(
      `SELECT procurado, COUNT(*) as n FROM atendimentos WHERE 1=1 ${pf} GROUP BY procurado ORDER BY n DESC`
    ).catch(() => ({ rows: [] }));

    // Gestão por solicitação
    const gcTipo = await pool.query(
      `SELECT solicitacao, COUNT(*) as n FROM gestao_clientes WHERE 1=1 ${pf} GROUP BY solicitacao ORDER BY n DESC`
    );

    // Pesquisas NPS
    const npsData = await pool.query(
      `SELECT ROUND(AVG(nps)::numeric,1) as nps, ROUND(AVG(csat)::numeric,1) as csat, 
       ROUND(AVG(ces)::numeric,1) as ces, COUNT(*) as total FROM pesquisas WHERE 1=1 ${pf}`
    );

    // Carteira métricas
    const carteira = await pool.query(`
      SELECT COUNT(*) FILTER (WHERE status='ativo') as ativos,
        COUNT(*) FILTER (WHERE status='encerrado') as encerrados,
        COALESCE(SUM(
          (SELECT valor FROM honorarios h WHERE h.cliente_id = c.id ORDER BY data_vigencia DESC LIMIT 1)
          FILTER (WHERE c.status='ativo')
        ), 0) as mrr
      FROM clientes c
    `).catch(() => ({ rows: [{ ativos: 0, encerrados: 0, mrr: 0 }] }));

    // CAC do mês
    const cacData = await pool.query(
      `SELECT COALESCE(SUM(valor),0) as total FROM investimentos WHERE mes = $1`, [mesAtual]
    ).catch(() => ({ rows: [{ total: 0 }] }));

    // Novos clientes no mês
    const novosClientes = await pool.query(
      `SELECT COUNT(*) as n FROM clientes WHERE TO_CHAR(data_entrada,'YYYY-MM') = $1`, [mesAtual]
    ).catch(() => ({ rows: [{ n: 0 }] }));

    const meses = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho',
      'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
    const mesLabel = meses[parseInt(m)-1] + '/' + ano;

    res.json({
      mes: mesAtual, mesLabel,
      totais,
      insGrav: insGrav.rows,
      insArea: insArea.rows,
      insEmpresas: insEmpresas.rows,
      atDepto: atDepto.rows,
      atAnalista: atAnalista.rows,
      gcTipo: gcTipo.rows,
      pesquisas: npsData.rows[0],
      carteira: carteira.rows[0],
      cac: parseFloat(cacData.rows[0].total || 0),
      novosClientes: parseInt(novosClientes.rows[0].n || 0),
    });
  } catch (err) {
    console.error('Relatorio error:', err);
    res.status(500).json({ error: 'Erro ao gerar relatório.' });
  }
});

// ── BUSCA GLOBAL ──────────────────────────────────────────────────────────────
router.get('/busca-global', requireAuth, async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.trim().length < 2)
      return res.status(400).json({ error: 'Digite ao menos 2 caracteres.' });
    const termo = '%' + q.trim().toLowerCase() + '%';

    const [at, gc, ins, cs, rc, cli] = await Promise.all([
      pool.query(`SELECT id,'atendimento' as modulo, empresa, cliente, cnpj, analista, created_at FROM atendimentos
        WHERE LOWER(empresa) LIKE $1 OR LOWER(cliente) LIKE $1 OR cnpj LIKE $1 LIMIT 5`, [termo]),
      pool.query(`SELECT id,'gestao' as modulo, empresa, '' as cliente, cnpj, analista, created_at FROM gestao_clientes
        WHERE LOWER(empresa) LIKE $1 OR cnpj LIKE $1 LIMIT 5`, [termo]),
      pool.query(`SELECT id,'insatisfacao' as modulo, empresa, cliente, cnpj, analista, created_at FROM insatisfacoes
        WHERE LOWER(empresa) LIKE $1 OR LOWER(cliente) LIKE $1 OR cnpj LIKE $1 LIMIT 5`, [termo]),
      pool.query(`SELECT id,'sensiveis' as modulo, empresa, cliente, cnpj, analista, created_at FROM clientes_sensiveis
        WHERE LOWER(empresa) LIKE $1 OR LOWER(cliente) LIKE $1 OR cnpj LIKE $1 LIMIT 5`, [termo]),
      pool.query(`SELECT id,'recuperacao' as modulo, empresa, cliente, cnpj, analista, created_at FROM recuperacoes
        WHERE LOWER(empresa) LIKE $1 OR LOWER(cliente) LIKE $1 OR cnpj LIKE $1 LIMIT 5`, [termo]),
      pool.query(`SELECT id,'carteira' as modulo, nome_empresa as empresa, '' as cliente, cnpj, '' as analista, created_at FROM clientes
        WHERE LOWER(nome_empresa) LIKE $1 OR cnpj LIKE $1 LIMIT 5`, [termo]).catch(() => ({ rows: [] })),
    ]);

    const resultados = [...at.rows, ...gc.rows, ...ins.rows, ...cs.rows, ...rc.rows, ...cli.rows]
      .sort((a,b) => new Date(b.created_at) - new Date(a.created_at));

    res.json({ data: resultados, total: resultados.length });
  } catch (err) {
    console.error('Busca global error:', err);
    res.status(500).json({ error: 'Erro na busca.' });
  }
});

// ── LOG DE ATIVIDADES ─────────────────────────────────────────────────────────

// Middleware helper para registrar log (usado internamente)

router.get('/log-atividades', requireAdmin, async (req, res) => {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS log_atividades (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id TEXT NOT NULL, user_name TEXT NOT NULL,
      acao TEXT NOT NULL, modulo TEXT NOT NULL, descricao TEXT,
      ip TEXT, created_at TIMESTAMPTZ DEFAULT NOW()
    )`).catch(()=>{});

    const { modulo, user, limit: lim } = req.query;
    let q = `SELECT * FROM log_atividades WHERE 1=1`;
    const params = [];
    if (modulo && modulo !== 'todos') { q += ` AND modulo = $${params.length+1}`; params.push(modulo); }
    if (user && user !== 'todos') { q += ` AND user_id = $${params.length+1}`; params.push(user); }
    q += ` ORDER BY created_at DESC LIMIT $${params.length+1}`;
    params.push(parseInt(lim)||200);

    const { rows } = await pool.query(q, params);

    // Lista de usuários para filtro
    const users = await pool.query(`SELECT DISTINCT user_id, user_name FROM log_atividades ORDER BY user_name`);

    res.json({ data: rows, users: users.rows });
  } catch (err) { res.status(500).json({ error: 'Erro ao buscar log.' }); }
});

router.delete('/log-atividades', requireAdmin, async (req, res) => {
  try {
    await pool.query(`DELETE FROM log_atividades`);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Erro ao limpar log.' }); }
});

// ── BACKUP DOS DADOS ──────────────────────────────────────────────────────────

// Junta os dados de todas as tabelas num único objeto — usado tanto pelo
// backup manual (botão "Baixar backup") quanto pelo backup automático diário.
async function gerarBackupCompleto() {
  const [
    atendimentos, gestao, insatisfacoes, sensiveis,
    pesquisas, recuperacoes, clientes, honorarios,
    eventos, investimentos, notificacoes, log,
    csVinculos, csTickets, gamColaboradores, gamNotas,
    gamNotaFinalOverride, gamTicketsPontos, gamAbandonoIncidentes,
    gamVelocidadeRevisoes, gamAceiteRevisoes, gamFinalizarRevisoes,
    gamQualificacaoMapa, gamConfig,
  ] = await Promise.all([
    pool.query('SELECT * FROM atendimentos ORDER BY created_at').catch(()=>({rows:[]})),
    pool.query('SELECT * FROM gestao_clientes ORDER BY created_at').catch(()=>({rows:[]})),
    pool.query('SELECT * FROM insatisfacoes ORDER BY created_at').catch(()=>({rows:[]})),
    pool.query('SELECT * FROM clientes_sensiveis ORDER BY created_at').catch(()=>({rows:[]})),
    pool.query('SELECT * FROM pesquisas ORDER BY created_at').catch(()=>({rows:[]})),
    pool.query('SELECT * FROM recuperacoes ORDER BY created_at').catch(()=>({rows:[]})),
    pool.query('SELECT * FROM clientes ORDER BY created_at').catch(()=>({rows:[]})),
    pool.query('SELECT * FROM honorarios ORDER BY created_at').catch(()=>({rows:[]})),
    pool.query('SELECT * FROM eventos_clientes ORDER BY created_at').catch(()=>({rows:[]})),
    pool.query('SELECT * FROM investimentos ORDER BY created_at').catch(()=>({rows:[]})),
    pool.query('SELECT * FROM notificacoes ORDER BY created_at').catch(()=>({rows:[]})),
    pool.query('SELECT * FROM log_atividades ORDER BY created_at DESC LIMIT 1000').catch(()=>({rows:[]})),
    // ── Sucesso do Cliente / Gamificação — incluídas 05/09/2026 depois do
    // Reysner perguntar se corríamos o risco de perder essa base do mesmo
    // jeito que perdemos Maio/Junho (ali foi a API do Zappy que expirou;
    // aqui seria o NOSSO banco, sem backup nenhum até agora). cs_mensagens
    // fica de fora de propósito (é o histórico de chat inteiro, grande
    // demais pra esse backup diário e não essencial pra reconstruir nota/
    // pontuação — só os campos abaixo bastam pra isso).
    pool.query('SELECT * FROM cs_vinculos ORDER BY created_at').catch(()=>({rows:[]})),
    pool.query('SELECT * FROM cs_tickets ORDER BY ingerido_em').catch(()=>({rows:[]})),
    pool.query('SELECT * FROM gam_colaboradores ORDER BY created_at').catch(()=>({rows:[]})),
    pool.query('SELECT * FROM gam_notas ORDER BY mes, colaborador_id').catch(()=>({rows:[]})),
    pool.query('SELECT * FROM gam_nota_final_override ORDER BY mes, colaborador_id').catch(()=>({rows:[]})),
    pool.query('SELECT * FROM gam_tickets_pontos ORDER BY calculado_em').catch(()=>({rows:[]})),
    pool.query('SELECT * FROM gam_abandono_incidentes ORDER BY mes, data').catch(()=>({rows:[]})),
    pool.query('SELECT * FROM gam_velocidade_revisoes').catch(()=>({rows:[]})),
    pool.query('SELECT * FROM gam_aceite_revisoes').catch(()=>({rows:[]})),
    pool.query('SELECT * FROM gam_finalizar_revisoes').catch(()=>({rows:[]})),
    pool.query('SELECT * FROM gam_qualificacao_mapa ORDER BY created_at').catch(()=>({rows:[]})),
    pool.query('SELECT * FROM gam_config').catch(()=>({rows:[]})),
  ]);

  return {
    meta: {
      sistema: 'Grupo-E',
      gerado_em: new Date().toISOString(),
      versao: '1.1',
      totais: {
        atendimentos: atendimentos.rows.length,
        gestao: gestao.rows.length,
        insatisfacoes: insatisfacoes.rows.length,
        sensiveis: sensiveis.rows.length,
        pesquisas: pesquisas.rows.length,
        recuperacoes: recuperacoes.rows.length,
        clientes: clientes.rows.length,
        honorarios: honorarios.rows.length,
        investimentos: investimentos.rows.length,
        cs_tickets: csTickets.rows.length,
        gam_notas: gamNotas.rows.length,
        gam_tickets_pontos: gamTicketsPontos.rows.length,
      }
    },
    dados: {
      atendimentos: atendimentos.rows,
      gestao_clientes: gestao.rows,
      insatisfacoes: insatisfacoes.rows,
      clientes_sensiveis: sensiveis.rows,
      pesquisas: pesquisas.rows,
      recuperacoes: recuperacoes.rows,
      clientes: clientes.rows,
      honorarios: honorarios.rows,
      eventos_clientes: eventos.rows,
      investimentos: investimentos.rows,
      notificacoes: notificacoes.rows,
      log_atividades: log.rows,
      cs_vinculos: csVinculos.rows,
      cs_tickets: csTickets.rows,
      gam_colaboradores: gamColaboradores.rows,
      gam_notas: gamNotas.rows,
      gam_nota_final_override: gamNotaFinalOverride.rows,
      gam_tickets_pontos: gamTicketsPontos.rows,
      gam_abandono_incidentes: gamAbandonoIncidentes.rows,
      gam_velocidade_revisoes: gamVelocidadeRevisoes.rows,
      gam_aceite_revisoes: gamAceiteRevisoes.rows,
      gam_finalizar_revisoes: gamFinalizarRevisoes.rows,
      gam_qualificacao_mapa: gamQualificacaoMapa.rows,
      gam_config: gamConfig.rows,
    }
  };
}

router.get('/backup', requireAdmin, async (req, res) => {
  try {
    const timestamp = new Date().toISOString().slice(0,19).replace('T','_').replace(/:/g,'-');
    const backup = await gerarBackupCompleto();

    // Registrar no log
    await registrarLog(req.user.id, req.user.name, 'criar', 'admin', 'Backup manual realizado', req);

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="backup-grupo-e-${timestamp}.json"`);
    res.json(backup);
  } catch (err) {
    console.error('Backup error:', err);
    res.status(500).json({ error: 'Erro ao gerar backup.' });
  }
});

// ── BACKUP AUTOMÁTICO (diário, sem precisar clicar em nada) ────────────────────
// Guarda o backup dentro do próprio banco (tabela backups_automaticos), porque
// o disco do Render é temporário — some a cada deploy/reinício. Roda 1x por
// dia, de madrugada (horário de Brasília), e mantém só os últimos 30 pra não
// crescer sem limite. O setInterval só é criado uma vez, porque o Node só
// carrega este arquivo uma vez (cache de require), mesmo que outros arquivos
// façam require('./data') várias vezes.

async function garantirTabelaBackupsAutomaticos() {
  await pool.query(`CREATE TABLE IF NOT EXISTS backups_automaticos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    gerado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    dados JSONB NOT NULL,
    totais JSONB
  )`).catch(()=>{});
}

async function rodarBackupAutomaticoSeNecessario() {
  try {
    await garantirTabelaBackupsAutomaticos();

    // Já existe um backup automático de hoje (horário de Brasília)? Se sim, não faz de novo.
    const jaExiste = await pool.query(
      `SELECT id FROM backups_automaticos
       WHERE (gerado_em AT TIME ZONE 'America/Sao_Paulo')::date = (NOW() AT TIME ZONE 'America/Sao_Paulo')::date
       LIMIT 1`
    );
    if (jaExiste.rows.length) return;

    // Só dispara de madrugada (entre 3h e 4h, horário de Brasília) pra não pesar em horário de uso.
    const horaBrasilia = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' })).getHours();
    if (horaBrasilia !== 3) return;

    const backup = await gerarBackupCompleto();
    await pool.query(
      `INSERT INTO backups_automaticos (dados, totais) VALUES ($1, $2)`,
      [JSON.stringify(backup.dados), JSON.stringify(backup.meta.totais)]
    );

    // Mantém só os 30 backups automáticos mais recentes.
    await pool.query(`
      DELETE FROM backups_automaticos
      WHERE id NOT IN (SELECT id FROM backups_automaticos ORDER BY gerado_em DESC LIMIT 30)
    `);

    console.log('[backup automático] Backup diário gerado com sucesso.');
  } catch (err) {
    console.error('[backup automático] Falhou:', err.message);
  }
}

// Confere a cada 10 minutos se está na hora de rodar (e se ainda não rodou hoje).
garantirTabelaBackupsAutomaticos().then(() => {
  rodarBackupAutomaticoSeNecessario();
  setInterval(rodarBackupAutomaticoSeNecessario, 10 * 60 * 1000);
});

// GET /api/data/backups-automaticos — lista os backups automáticos guardados (resumo, sem os dados)
router.get('/backups-automaticos', requireAdmin, async (req, res) => {
  try {
    await garantirTabelaBackupsAutomaticos();
    const { rows } = await pool.query(
      `SELECT id, gerado_em, totais FROM backups_automaticos ORDER BY gerado_em DESC`
    );
    res.json({ data: rows });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao listar backups automáticos.' });
  }
});

// GET /api/data/backups-automaticos/:id/download — baixa um backup automático específico
router.get('/backups-automaticos/:id/download', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM backups_automaticos WHERE id = $1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Backup não encontrado.' });
    const row = rows[0];
    const timestamp = new Date(row.gerado_em).toISOString().slice(0,19).replace('T','_').replace(/:/g,'-');
    const backup = {
      meta: { sistema: 'Grupo-E', gerado_em: row.gerado_em, versao: '1.0', totais: row.totais, tipo: 'automatico' },
      dados: row.dados,
    };
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="backup-automatico-grupo-e-${timestamp}.json"`);
    res.json(backup);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao baixar backup automático.' });
  }
});

// ── ROTA PÚBLICA — pesquisa sem login ─────────────────────────────────────────
const publicRouter = require('express').Router();

publicRouter.post('/pesquisa', async (req, res) => {
  try {
    const { cliente, empresa, nps, csat, ces, pontos } = req.body;
    if (!cliente || !empresa || nps == null || csat == null || ces == null)
      return res.status(400).json({ error: 'Campos obrigatórios ausentes.' });
    if (nps < 0 || nps > 10 || csat < 1 || csat > 5 || ces < 1 || ces > 5)
      return res.status(400).json({ error: 'Valores fora do intervalo permitido.' });

    const { v4: uuidv4 } = require('uuid');
    const { pool } = require('../db');
    const id = uuidv4();

    // Busca o primeiro admin para usar como user_id (campo obrigatório)
    const adminRow = await pool.query(`SELECT id FROM users WHERE role = 'administrador' LIMIT 1`);
    const userId = adminRow.rows[0]?.id || null;
    if (!userId) return res.status(500).json({ error: 'Nenhum administrador configurado.' });

    await pool.query(
      `INSERT INTO pesquisas (id, user_id, analista, cliente, cnpj, empresa, nps, csat, ces, pontos)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [id, userId, 'Pesquisa Pública', cliente, '', empresa, Number(nps), Number(csat), Number(ces), pontos || null]
    );
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error('Public survey error:', err);
    res.status(500).json({ error: 'Erro ao registrar pesquisa.' });
  }
});

// ── GAMIFICAÇÃO — rota pública (ranking sem login) ──────────────────────────
publicRouter.get('/gamificacao', async (req, res) => {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS gam_colaboradores (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      nome TEXT NOT NULL, ativo BOOLEAN DEFAULT true, created_at TIMESTAMPTZ DEFAULT NOW()
    )`).catch(()=>{});
    await pool.query(`CREATE TABLE IF NOT EXISTS gam_notas (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      colaborador_id UUID NOT NULL REFERENCES gam_colaboradores(id) ON DELETE CASCADE,
      mes VARCHAR(7) NOT NULL,
      media_individual NUMERIC(4,2) NOT NULL, avaliacoes INTEGER NOT NULL DEFAULT 0,
      lancado_por TEXT, updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(colaborador_id, mes)
    )`).catch(()=>{});
    await pool.query(`CREATE TABLE IF NOT EXISTS gam_config (
      chave TEXT PRIMARY KEY, valor NUMERIC(6,2) NOT NULL
    )`).catch(()=>{});
    await pool.query(`INSERT INTO gam_config (chave, valor) VALUES ('peso_minimo', 10) ON CONFLICT (chave) DO NOTHING`).catch(()=>{});
    await pool.query(`INSERT INTO gam_config (chave, valor) VALUES ('mostrar_consolidado', 1) ON CONFLICT (chave) DO NOTHING`).catch(()=>{});
    await pool.query(`INSERT INTO gam_config (chave, valor) VALUES ('permitir_filtro_meses', 1) ON CONFLICT (chave) DO NOTHING`).catch(()=>{});
    // Trava manual de nota final do mês (ver uso mais abaixo) — corrige o
    // pódio de um mês já anunciado à equipe sem afetar o Consolidado Geral.
    await pool.query(`CREATE TABLE IF NOT EXISTS gam_nota_final_override (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      colaborador_id UUID NOT NULL REFERENCES gam_colaboradores(id) ON DELETE CASCADE,
      mes VARCHAR(7) NOT NULL,
      nota_final NUMERIC(4,2) NOT NULL,
      motivo TEXT,
      criado_por TEXT, criado_em TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(colaborador_id, mes)
    )`).catch(()=>{});

    const pesoR = await pool.query(`SELECT valor FROM gam_config WHERE chave = 'peso_minimo'`);
    const pesoMinimo = pesoR.rows[0] ? parseFloat(pesoR.rows[0].valor) : 10;

    // Liga/desliga o card "Consolidado Geral" na página pública, controlado
    // pelo painel interno da Gamificação (pedido da Thais). Desligado, pula
    // o cálculo inteiro (evita recalcular nota final mês a mês à toa).
    const mostrarR = await pool.query(`SELECT valor FROM gam_config WHERE chave = 'mostrar_consolidado'`);
    const mostrarConsolidado = mostrarR.rows[0] ? parseFloat(mostrarR.rows[0].valor) !== 0 : true;

    // Liga/desliga o seletor "Filtrar por meses anteriores" na página pública
    // (pedido do Reysner, 10/09/2026). Desligado, a página só mostra o mês
    // corrente e esconde o dropdown de meses. Mesmo padrão do mostrar_consolidado.
    const filtroMesesR = await pool.query(`SELECT valor FROM gam_config WHERE chave = 'permitir_filtro_meses'`);
    const permitirFiltroMeses = filtroMesesR.rows[0] ? parseFloat(filtroMesesR.rows[0].valor) !== 0 : true;

    // Determina o mês a usar: se não veio na query, usa o ÚLTIMO mês com notas lançadas
    let { mes } = req.query;
    if (!mes) {
      const ultimoMes = await pool.query(`SELECT mes FROM gam_notas ORDER BY mes DESC LIMIT 1`);
      mes = ultimoMes.rows[0]?.mes || new Date().toISOString().slice(0,7);
    }
    const mesAtual = mes;

    // Dados brutos do mês
    const dadosMes = await pool.query(`
      SELECT c.id, c.nome, n.media_individual, n.avaliacoes
      FROM gam_notas n
      JOIN gam_colaboradores c ON c.id = n.colaborador_id
      WHERE n.mes = $1 AND c.ativo = true
    `, [mesAtual]);

    // Média Geral do mês: MÉDIASE — apenas quem tem avaliacoes > 0
    const comAvaliacoes = dadosMes.rows.filter(r => parseInt(r.avaliacoes) > 0);
    const mediasValidas = comAvaliacoes.map(r => parseFloat(r.media_individual));
    const mediaGeralSimples = mediasValidas.length
      ? mediasValidas.reduce((s,m) => s + m, 0) / mediasValidas.length
      : 0;

    // 1º passo: calcula nota final apenas de quem tem avaliações > 0
    const comNotaFinal = comAvaliacoes.map(r => {
      const media = parseFloat(r.media_individual);
      const aval = parseInt(r.avaliacoes);
      const notaFinal = ((media * aval) + (mediaGeralSimples * pesoMinimo)) / (aval + pesoMinimo);
      return { id: r.id, nome: r.nome, media: notaFinal, mediaIndividual: media, avaliacoes: aval };
    });

    // Trava manual de nota final — SÓ pro pódio/ranking do MÊS exibido, nunca
    // usada no Consolidado Geral (esse recalcula cada mês do zero direto de
    // gam_notas, ver bloco "consolidado" abaixo, que não passa por aqui).
    // Pedido do Reysner, 04/09/2026: Julho já tinha sido apresentado à equipe
    // com um pódio específico (Elma 4,98 / Bruno 4,97 / Douglas 4,96) antes
    // de revisões de nota baixa terem sido feitas depois; trava o que já foi
    // anunciado sem impedir que o consolidado da temporada reflita as
    // revisões de verdade.
    const { rows: overridesRows } = await pool.query(
      `SELECT colaborador_id, nota_final FROM gam_nota_final_override WHERE mes = $1`, [mesAtual]
    ).catch(() => ({ rows: [] }));
    if (overridesRows.length) {
      const overrideMap = Object.fromEntries(overridesRows.map(o => [o.colaborador_id, parseFloat(o.nota_final)]));
      comNotaFinal.forEach(r => { if (overrideMap[r.id] != null) r.media = overrideMap[r.id]; });
    }

    // 2º passo: menor nota FINAL (após fórmula) — é o que os zerados recebem
    const menorNotaFinal = comNotaFinal.length ? Math.min(...comNotaFinal.map(r => r.media)) : 0;

    // 3º passo: zerados recebem a menor nota final
    const semNotaFinal = dadosMes.rows
      .filter(r => parseInt(r.avaliacoes) === 0)
      .map(r => ({ id: r.id, nome: r.nome, media: menorNotaFinal, mediaIndividual: 0, avaliacoes: 0 }));

    // Ranking completo ordenado por nota final — 4 casas decimais (não só 2)
    // pra dar pra distinguir gente que empataria arredondado, ex.: no
    // Relatório da Temporada / relatórios gerenciais. A página pública
    // (gamificacao.html) já faz o próprio toFixed(2) na exibição, então
    // aumentar a precisão aqui não muda o que a equipe vê lá.
    const ranking = [...comNotaFinal, ...semNotaFinal]
      .map(r => ({ ...r, media: parseFloat(r.media).toFixed(4) }))
      .sort((a,b) => {
        // Critério principal: maior nota final. Só cai nos desempates em
        // empate REAL até a 4ª casa — antes o limite era 0,005 (metade do
        // centésimo), calibrado pra quando a nota tinha 2 casas; com 4 casas
        // isso virava uma "faixa de empate" larga e podia deixar quem tinha
        // 4,9461 atrás de quem tinha 4,9426 (pedido do Reysner, 10/09/2026).
        const diff = parseFloat(b.media) - parseFloat(a.media);
        if (Math.abs(diff) >= 0.00005) return diff;
        // Desempate 1: maior número de avaliações
        if (b.avaliacoes !== a.avaliacoes) return b.avaliacoes - a.avaliacoes;
        // Desempate 2: maior média individual (essa é NUMERIC(4,2), 2 casas
        // de verdade — 0,005 continua sendo o limite certo aqui)
        const diffMi = parseFloat(b.mediaIndividual) - parseFloat(a.mediaIndividual);
        if (Math.abs(diffMi) >= 0.005) return diffMi;
        // Desempate 3: ordem alfabética
        return a.nome.localeCompare(b.nome, 'pt-BR');
      });

    // Média exibida = MÉDIASE (apenas quem tem avaliações > 0), não a média do ranking final
    const mediaGeral = mediaGeralSimples > 0 ? mediaGeralSimples.toFixed(2) : null;

    // ── Consolidado acumulado: média das notas finais mensais por colaborador ──
    // Para cada mês, recalcula as notas finais com a mesma fórmula do ranking mensal
    // e depois tira a média simples dessas notas finais ao longo dos meses.
    // Pulado inteiro quando `mostrar_consolidado` está desligado (painel interno
    // da Gamificação) — nem faz sentido gastar as N queries por mês à toa.
    let consolidado = [];
    if (mostrarConsolidado) {
      // Busca todos os meses disponíveis
      const mesesDisp = await pool.query(`SELECT DISTINCT mes FROM gam_notas ORDER BY mes ASC`);
      const todosMeses = mesesDisp.rows.map(r => r.mes);

      // Todos os colaboradores ativos HOJE — usado pra garantir que todo
      // mundo entra em TODOS os meses do consolidado, mesmo quem ainda nem
      // tinha sido cadastrado num mês anterior (pega a menor nota do grupo
      // naquele mês, igual quem já existia mas não teve avaliação).
      const colabsAtivos = await pool.query(`SELECT id, nome FROM gam_colaboradores WHERE ativo = true`);

      // Para cada mês, calcula a nota final de cada colaborador (mesma lógica do ranking mensal)
      const notasFinalPorMes = {}; // { colaborador_id: [nota_final_mes1, nota_final_mes2, ...] }
      const nomesPorId = {};
      colabsAtivos.rows.forEach(c => { nomesPorId[c.id] = c.nome; });

      for (const mes of todosMeses) {
        const dadosMesC = await pool.query(`
          SELECT c.id, c.nome, n.media_individual, n.avaliacoes
          FROM gam_notas n
          JOIN gam_colaboradores c ON c.id = n.colaborador_id
          WHERE n.mes = $1 AND c.ativo = true
        `, [mes]);

        const comAvalC = dadosMesC.rows.filter(r => parseInt(r.avaliacoes) > 0);
        const mediasC = comAvalC.map(r => parseFloat(r.media_individual));
        const mediaGeralC = mediasC.length ? mediasC.reduce((s,m) => s+m, 0) / mediasC.length : 0;

        // Calcula nota final de quem tem avaliações
        const notasC = comAvalC.map(r => {
          const mi = parseFloat(r.media_individual);
          const av = parseInt(r.avaliacoes);
          return { id: r.id, nome: r.nome, nf: ((mi*av)+(mediaGeralC*pesoMinimo))/(av+pesoMinimo) };
        });
        const menorC = notasC.length ? Math.min(...notasC.map(r => r.nf)) : 0;

        // Atribui nota a TODO colaborador ativo — quem não tem avaliação
        // nesse mês (seja porque ficou sem ticket avaliado, seja porque
        // ainda nem tinha entrado no time) recebe a menor nota final do mês.
        colabsAtivos.rows.forEach(c => {
          if (!notasFinalPorMes[c.id]) notasFinalPorMes[c.id] = [];
          const encontrado = notasC.find(n => n.id === c.id);
          notasFinalPorMes[c.id].push(encontrado ? encontrado.nf : menorC);
        });
      }

      // Consolidado = média simples das notas finais mensais ao longo de
      // TODOS os meses do jogo (desde o primeiro mês lançado) — sem peso
      // mínimo por tempo de casa. Pedido do Reysner: mais simples de
      // explicar pra equipe do que uma fórmula bayesiana de meses.
      consolidado = Object.entries(notasFinalPorMes).map(([id, notas]) => {
        const media = notas.reduce((s,n) => s+n, 0) / notas.length;
        return {
          nome: nomesPorId[id],
          // 4 casas decimais (pedido do Reysner, 05/09/2026) — com só 2, o
          // pódio da temporada pode empatar (ex.: Guilherme/João/Max todos
          // em 4,94) sem dar pra mostrar quem realmente ganhou. A página
          // pública re-arredonda pra 2 na exibição, então isso só aumenta
          // a precisão nos relatórios (Relatório da Temporada etc.).
          media_geral: media.toFixed(4),
          meses_avaliados: notas.length,
          total_avaliacoes: 0
        };
      }).sort((a,b) => {
        // Decidido pela média real (4 casas), sem faixa de empate — só cai
        // pro alfabético em empate exato até a 4ª casa. Ver comentário no
        // sort do ranking mensal acima (mesma mudança, 10/09/2026).
        const diff = parseFloat(b.media_geral) - parseFloat(a.media_geral);
        if (Math.abs(diff) >= 0.00005) return diff;
        return a.nome.localeCompare(b.nome, 'pt-BR');
      });
    }

    const meses = await pool.query(`SELECT DISTINCT mes FROM gam_notas ORDER BY mes DESC`);
    const inicio = await pool.query(`SELECT MIN(mes) as primeiro_mes FROM gam_notas`);

    res.json({
      mes: mesAtual,
      ranking,
      mediaGeral,
      consolidado,
      mostrarConsolidado,
      permitirFiltroMeses,
      meses: meses.rows.map(r => r.mes),
      inicioGamificacao: inicio.rows[0]?.primeiro_mes || null,
    });
  } catch (err) {
    console.error('Gamificação pública error:', err);
    res.status(500).json({ error: 'Erro ao carregar ranking.' });
  }
});

router.publicRouter = publicRouter;


// ── GAMIFICAÇÃO MENSAL ───────────────────────────────────────────────────────

async function ensureGamTables() {
  await pool.query(`CREATE TABLE IF NOT EXISTS gam_colaboradores (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nome TEXT NOT NULL, ativo BOOLEAN DEFAULT true, created_at TIMESTAMPTZ DEFAULT NOW()
  )`).catch(()=>{});
  await pool.query(`CREATE TABLE IF NOT EXISTS gam_notas (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    colaborador_id UUID NOT NULL REFERENCES gam_colaboradores(id) ON DELETE CASCADE,
    mes VARCHAR(7) NOT NULL,
    media_individual NUMERIC(4,2) NOT NULL,
    avaliacoes INTEGER NOT NULL DEFAULT 0,
    lancado_por TEXT, updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(colaborador_id, mes)
  )`).catch(()=>{});
  await pool.query(`CREATE TABLE IF NOT EXISTS gam_config (
    chave TEXT PRIMARY KEY, valor NUMERIC(6,2) NOT NULL
  )`).catch(()=>{});
  await pool.query(`INSERT INTO gam_config (chave, valor) VALUES ('peso_minimo', 10) ON CONFLICT (chave) DO NOTHING`).catch(()=>{});
  // Liga/desliga o card "Consolidado Geral" na página pública — pedido da
  // Thais: "ligo e desligo no painel interno da Gamificação, somente para o
  // consolidado geral". Reaproveita a mesma tabela chave/valor de peso_minimo
  // (1 = mostrar, 0 = ocultar); default ligado, pra não mudar o comportamento
  // de quem nunca mexeu nisso.
  await pool.query(`INSERT INTO gam_config (chave, valor) VALUES ('mostrar_consolidado', 1) ON CONFLICT (chave) DO NOTHING`).catch(()=>{});
  // Liga/desliga o seletor "Filtrar por meses anteriores" na página pública —
  // pedido do Reysner (10/09/2026): "já existe um botão que oculta o consolidado
  // geral, agora quero que oculte filtrar por meses anteriores". Mesmo esquema
  // chave/valor (1 = permite filtrar, 0 = só mês corrente); default ligado.
  await pool.query(`INSERT INTO gam_config (chave, valor) VALUES ('permitir_filtro_meses', 1) ON CONFLICT (chave) DO NOTHING`).catch(()=>{});

  // ── Automação da nota mensal via Zappy (Modelo Atualizado — fase 1) ────────
  // A API pública do Zappy não dá nota por ticket (ver nota em zappyClient.js),
  // só um agregado por rótulo de "qualificação" no período — dá pra automatizar
  // a MÉDIA MENSAL que hoje é digitada à mão, mas não o detalhe por ticket.
  // `zappy_user_id` liga um colaborador da Gamificação ao userId do Zappy
  // (nomes podem divergir — "Reysner" x "Resyner" já foi problema real no
  // dropdown de Analista Procurado). `gam_qualificacao_mapa` traduz cada
  // rótulo que o Zappy usa (desconhecido até a 1ª chamada real) pra uma nota
  // 0-5 — fica null até o admin calibrar, e enquanto null aquele rótulo é
  // ignorado do cálculo (nunca inventa nota pra rótulo não mapeado).
  await pool.query(`ALTER TABLE gam_colaboradores ADD COLUMN IF NOT EXISTS zappy_user_id TEXT`).catch(()=>{});

  // ── Regra de ACEITE do aguardando (pedido do Reysner p/ a Elma) ───────────
  // A Elma é quem recebe a chegada do cliente no Sucesso do Cliente — se o
  // cliente fica >15min úteis aguardando ser aceito, desconta -1 (média,
  // igual ao bônus de transferência). Configurável por colaborador (não
  // hardcoded por nome/UUID) pra já deixar preparado caso a função mude de
  // pessoa no futuro; hoje só a Elma tem a flag ligada.
  await pool.query(`ALTER TABLE gam_colaboradores ADD COLUMN IF NOT EXISTS aplica_regra_aceite BOOLEAN DEFAULT false`).catch(()=>{});
  await pool.query(`UPDATE gam_colaboradores SET aplica_regra_aceite = true WHERE nome = 'Elma' AND aplica_regra_aceite = false`).catch(()=>{});

  // ── Login self-service (28/08/2026) — ver server/auth.js (role
  // 'colaborador') e public/minha-nota.html. Liga um colaborador a um login
  // da tabela `users`, pra ele conseguir ver a própria composição de nota
  // sem depender de pedir pro admin. ON DELETE SET NULL: se o login for
  // apagado, o colaborador não fica travado, só perde o vínculo.
  await pool.query(`ALTER TABLE gam_colaboradores ADD COLUMN IF NOT EXISTS user_id TEXT REFERENCES users(id) ON DELETE SET NULL`).catch(()=>{});

  await pool.query(`CREATE TABLE IF NOT EXISTS gam_qualificacao_mapa (
    chave TEXT PRIMARY KEY,
    nota NUMERIC(3,2),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`).catch(()=>{});

  // ── Revisão de DESCONTO DE VELOCIDADE (separada da revisão de nota) ───────
  // Achado do Reysner com o ticket #47735 (Max transferiu pra Kelen): mesmo
  // com o relógio de transferência corrigido (mede da última resposta do
  // escritório até a transferência, não mais do aceite), ainda existem casos
  // onde o "tempo parado" na verdade era o analista esperando o CLIENTE
  // mandar algo (ex.: valor da NF) — o sistema não tem como saber isso só
  // pelos horários. Por isso, igual à revisão de nota baixa (que é da NOTA
  // do cliente, em cs_tickets), esta é a revisão do DESCONTO DE VELOCIDADE
  // em si — por ticket+papel (não por ticket só), porque velocidade existe
  // tanto pra quem recebeu quanto pra quem transferiu, e um mesmo ticket
  // pode ter as duas linhas com julgamentos diferentes. Fica numa tabela
  // separada (não em gam_tickets_pontos) de propósito — essa tabela é
  // reescrita toda vez que os pontos são recalculados (fórmula muda,
  // reprocessamento etc.), e uma revisão humana não pode se perder nisso.
  await pool.query(`CREATE TABLE IF NOT EXISTS gam_velocidade_revisoes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id UUID NOT NULL REFERENCES cs_tickets(id) ON DELETE CASCADE,
    papel TEXT NOT NULL CHECK (papel IN ('transferiu','recebeu','unico')),
    status TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','devida','indevida')),
    revisado_por TEXT,
    revisado_em TIMESTAMPTZ,
    UNIQUE (ticket_id, papel)
  )`).catch(()=>{});
  // Reatribuição de analista (pedido do Reysner, 15/09/2026) — quando
  // preenchido, o desconto de velocidade dessa linha conta pro
  // zappy_user_id aqui em vez de quem o Zappy registrou como dono do
  // ticket. Ver comentário completo em executarAutoPreencher.
  await pool.query(`ALTER TABLE gam_velocidade_revisoes ADD COLUMN IF NOT EXISTS override_analista_id TEXT`).catch(()=>{});

  // ── Revisão do ACEITE do aguardando (separada da revisão de velocidade) ──
  // Pedido do Reysner: em situações que parecem bot/marketing/envio de
  // currículo etc. (contato não é um cliente de verdade pedindo suporte),
  // o tempo de aceite não deveria contar pra métrica de ninguém — mesmo
  // padrão de gam_velocidade_revisoes (ticket+papel, pendente/devida/
  // indevida), mas em tabela própria porque é um julgamento DIFERENTE: a
  // revisão de velocidade pergunta "o desconto reflete a realidade?"; esta
  // pergunta "esse contato/ticket devia estar sendo contado nessa métrica?".
  await pool.query(`CREATE TABLE IF NOT EXISTS gam_aceite_revisoes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id UUID NOT NULL REFERENCES cs_tickets(id) ON DELETE CASCADE,
    papel TEXT NOT NULL CHECK (papel IN ('transferiu','unico')),
    status TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','devida','indevida')),
    revisado_por TEXT,
    revisado_em TIMESTAMPTZ,
    UNIQUE (ticket_id, papel)
  )`).catch(()=>{});
  await pool.query(`ALTER TABLE gam_aceite_revisoes ADD COLUMN IF NOT EXISTS override_analista_id TEXT`).catch(()=>{});

  // ── Revisão do /FINALIZAR + REABERTURA (regra combinada, 28/08/2026) ─────
  // Mesmo padrão de gam_aceite_revisoes: quando 'indevida', o desconto some
  // da média de bonusFinalizar daquele colaborador — pra reaberturas que não
  // refletem um encerramento mal feito de verdade (ex.: cliente voltou por
  // um assunto novo, sem relação com o fechamento anterior). Só 'recebeu'/
  // 'unico' porque só quem encerra tem essa métrica (ver cs/pontuacao.js).
  await pool.query(`CREATE TABLE IF NOT EXISTS gam_finalizar_revisoes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id UUID NOT NULL REFERENCES cs_tickets(id) ON DELETE CASCADE,
    papel TEXT NOT NULL CHECK (papel IN ('recebeu','unico')),
    status TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','devida','indevida')),
    revisado_por TEXT,
    revisado_em TIMESTAMPTZ,
    UNIQUE (ticket_id, papel)
  )`).catch(()=>{});
  await pool.query(`ALTER TABLE gam_finalizar_revisoes ADD COLUMN IF NOT EXISTS override_analista_id TEXT`).catch(()=>{});

  // ── Mês fechado (pedido do Reysner, 15/09/2026) ───────────────────────────
  // "quando fechasse o mês e definirmos o pódio e o ganhador, não mexe mais
  // no mês, ficando definido da forma que apresentamos" — trava GERAL e
  // permanente pra um mês: nenhuma sincronização (job diário, "Sincronizar
  // Notas Agora", "Auto-preencher (Zappy)", "Relatório da Temporada") pode
  // mais GRAVAR nota pra ele. A trava não recalcula nada na hora de fechar —
  // só impede escritas dali pra frente, então o que já está gravado em
  // gam_notas (e qualquer override de pódio) fica exatamente como estava no
  // momento do fechamento, os "valores já definidos". Ver uso em
  // executarAutoPreencher, logo abaixo. Substitui o antigo array fixo
  // MESES_SEM_SINCRONIZAR do front-end (só cobria Julho, hardcoded) por um
  // mecanismo geral, dinâmico, aplicado no núcleo do cálculo — não só na
  // tela do Relatório da Temporada.
  await pool.query(`CREATE TABLE IF NOT EXISTS gam_meses_fechados (
    mes VARCHAR(7) PRIMARY KEY,
    fechado_por TEXT,
    fechado_em TIMESTAMPTZ DEFAULT NOW()
  )`).catch(()=>{});
  // Maio, Junho (valores históricos restaurados manualmente, sem dado de
  // ticket — "não pode alterar as notas de maio e junho", pedido explícito
  // do Reysner) e Julho (pódio já anunciado com metodologia própria de nota
  // bruta) vêm PROTEGIDOS por padrão, sem precisar clicar em nada.
  await pool.query(`INSERT INTO gam_meses_fechados (mes, fechado_por) VALUES
    ('2026-05', 'Sistema (protegido por padrão)'),
    ('2026-06', 'Sistema (protegido por padrão)'),
    ('2026-07', 'Sistema (protegido por padrão)')
    ON CONFLICT (mes) DO NOTHING`).catch(()=>{});
}

async function getMesesFechados() {
  const r = await pool.query(`SELECT mes FROM gam_meses_fechados ORDER BY mes`);
  return r.rows.map(row => row.mes);
}

async function isMesFechado(mes) {
  const r = await pool.query(`SELECT 1 FROM gam_meses_fechados WHERE mes = $1`, [mes]);
  return r.rows.length > 0;
}

async function getPesoMinimo() {
  const r = await pool.query(`SELECT valor FROM gam_config WHERE chave = 'peso_minimo'`);
  return r.rows[0] ? parseFloat(r.rows[0].valor) : 10;
}

/**
 * Resolve um `novo_colaborador_id` (UUID de gam_colaboradores, o que o
 * front-end manda no seletor "Trocar analista") pro zappy_user_id que as
 * revisões de fato armazenam em override_analista_id — é o zappy_user_id
 * que casa com gam_tickets_pontos.analista_id / gam_abandono_incidentes.analista_id.
 * Devolve null se novoColaboradorId vier vazio (reatribuição sendo removida).
 * Lança erro com .status=400 se o colaborador não existir ou não tiver
 * zappy_user_id vinculado (não dá pra reatribuir pra alguém sem vínculo).
 */
async function resolverNovoAnalistaId(novoColaboradorId) {
  if (!novoColaboradorId) return null;
  const { rows } = await pool.query(
    `SELECT zappy_user_id FROM gam_colaboradores WHERE id = $1`,
    [novoColaboradorId]
  );
  if (!rows.length) { const e = new Error('Colaborador não encontrado.'); e.status = 400; throw e; }
  if (!rows[0].zappy_user_id) { const e = new Error('Esse colaborador ainda não está vinculado a um usuário do Zappy.'); e.status = 400; throw e; }
  return rows[0].zappy_user_id;
}

async function getMostrarConsolidado() {
  const r = await pool.query(`SELECT valor FROM gam_config WHERE chave = 'mostrar_consolidado'`);
  return r.rows[0] ? parseFloat(r.rows[0].valor) !== 0 : true;
}

async function getPermitirFiltroMeses() {
  const r = await pool.query(`SELECT valor FROM gam_config WHERE chave = 'permitir_filtro_meses'`);
  return r.rows[0] ? parseFloat(r.rows[0].valor) !== 0 : true;
}

// Fórmula de média ponderada com peso mínimo (Bayesian average)
function notaFinal(mediaIndividual, avaliacoes, mediaGeral, pesoMinimo) {
  if (avaliacoes === 0) return null;
  return ((mediaIndividual * avaliacoes) + (mediaGeral * pesoMinimo)) / (avaliacoes + pesoMinimo);
}

// ── Configuração — Peso Mínimo (admin) ───────────────────────────────────────
router.get('/gam/config', requireAdmin, async (req, res) => {
  try {
    await ensureGamTables();
    const peso = await getPesoMinimo();
    const mostrarConsolidado = await getMostrarConsolidado();
    const permitirFiltroMeses = await getPermitirFiltroMeses();
    res.json({ peso_minimo: peso, mostrar_consolidado: mostrarConsolidado, permitir_filtro_meses: permitirFiltroMeses });
  } catch (err) { res.status(500).json({ error: 'Erro ao buscar configuração.' }); }
});

// Aceita peso_minimo e/ou mostrar_consolidado — parcial, só grava o que veio
// no corpo (o botão de ligar/desligar o Consolidado não deve exigir reenviar
// o peso mínimo, e vice-versa).
router.patch('/gam/config', requireAdmin, async (req, res) => {
  try {
    const { peso_minimo, mostrar_consolidado, permitir_filtro_meses } = req.body;
    if (peso_minimo == null && mostrar_consolidado == null && permitir_filtro_meses == null) {
      return res.status(400).json({ error: 'Nenhum campo para atualizar.' });
    }
    if (peso_minimo != null) {
      if (peso_minimo < 0) return res.status(400).json({ error: 'Peso mínimo inválido.' });
      await pool.query(
        `INSERT INTO gam_config (chave, valor) VALUES ('peso_minimo', $1)
         ON CONFLICT (chave) DO UPDATE SET valor = $1`,
        [peso_minimo]
      );
    }
    if (mostrar_consolidado != null) {
      await pool.query(
        `INSERT INTO gam_config (chave, valor) VALUES ('mostrar_consolidado', $1)
         ON CONFLICT (chave) DO UPDATE SET valor = $1`,
        [mostrar_consolidado ? 1 : 0]
      );
    }
    if (permitir_filtro_meses != null) {
      await pool.query(
        `INSERT INTO gam_config (chave, valor) VALUES ('permitir_filtro_meses', $1)
         ON CONFLICT (chave) DO UPDATE SET valor = $1`,
        [permitir_filtro_meses ? 1 : 0]
      );
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Erro ao salvar configuração.' }); }
});

// ── Mês fechado (admin) ──────────────────────────────────────────────────────
// "Fechar" trava PERMANENTEMENTE a gravação de nota pra esse mês (ver guard
// em executarAutoPreencher) — pra usar depois que o pódio já foi definido e
// apresentado. "Reabrir" é a saída de emergência se precisar corrigir algo
// depois (mesmo espírito do "Limpar Travas de Pódio" que já existia).
router.get('/gam/meses-fechados', requireAdmin, async (req, res) => {
  try {
    await ensureGamTables();
    res.json({ data: await getMesesFechados() });
  } catch (err) { res.status(500).json({ error: 'Erro ao listar meses fechados.' }); }
});

router.post('/gam/mes/:mes/fechar', requireAdmin, async (req, res) => {
  try {
    const { mes } = req.params;
    if (!/^\d{4}-\d{2}$/.test(mes)) return res.status(400).json({ error: 'Mês inválido, use AAAA-MM.' });
    await ensureGamTables();
    await pool.query(
      `INSERT INTO gam_meses_fechados (mes, fechado_por) VALUES ($1, $2)
       ON CONFLICT (mes) DO UPDATE SET fechado_por = $2, fechado_em = NOW()`,
      [mes, req.user.name]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Erro ao fechar o mês.' }); }
});

router.post('/gam/mes/:mes/reabrir', requireAdmin, async (req, res) => {
  try {
    const { mes } = req.params;
    if (!/^\d{4}-\d{2}$/.test(mes)) return res.status(400).json({ error: 'Mês inválido, use AAAA-MM.' });
    await pool.query(`DELETE FROM gam_meses_fechados WHERE mes = $1`, [mes]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Erro ao reabrir o mês.' }); }
});

// ── Colaboradores (admin) ──────────────────────────────────────────────────
router.get('/gam/colaboradores', requireAdmin, async (req, res) => {
  try {
    await ensureGamTables();
    const { rows } = await pool.query(`SELECT * FROM gam_colaboradores ORDER BY nome ASC`);
    res.json({ data: rows });
  } catch (err) { res.status(500).json({ error: 'Erro ao listar colaboradores.' }); }
});

router.post('/gam/colaboradores', requireAdmin, async (req, res) => {
  try {
    await ensureGamTables();
    const { nome } = req.body;
    if (!nome) return res.status(400).json({ error: 'Nome obrigatório.' });
    const { rows } = await pool.query(
      `INSERT INTO gam_colaboradores (nome) VALUES ($1) RETURNING *`, [nome.trim()]
    );
    res.status(201).json({ ok: true, data: rows[0] });
  } catch (err) { res.status(500).json({ error: 'Erro ao adicionar colaborador.' }); }
});

router.patch('/gam/colaboradores/:id/toggle', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT ativo FROM gam_colaboradores WHERE id = $1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Não encontrado.' });
    const novo = !rows[0].ativo;
    await pool.query(`UPDATE gam_colaboradores SET ativo = $1 WHERE id = $2`, [novo, req.params.id]);
    res.json({ ok: true, ativo: novo });
  } catch (err) { res.status(500).json({ error: 'Erro ao alterar status.' }); }
});

router.delete('/gam/colaboradores/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query(`DELETE FROM gam_colaboradores WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Erro ao excluir.' }); }
});

// ── Notas (admin) ───────────────────────────────────────────────────────────
router.get('/gam/notas', requireAdmin, async (req, res) => {
  try {
    await ensureGamTables();
    const { mes } = req.query;
    let q = `SELECT n.*, c.nome FROM gam_notas n JOIN gam_colaboradores c ON c.id = n.colaborador_id`;
    const params = [];
    if (mes) { q += ` WHERE n.mes = $1`; params.push(mes); }
    q += ` ORDER BY c.nome ASC`;
    const { rows } = await pool.query(q, params);
    res.json({ data: rows });
  } catch (err) { res.status(500).json({ error: 'Erro ao listar notas.' }); }
});

router.post('/gam/notas', requireAdmin, async (req, res) => {
  try {
    await ensureGamTables();
    const { colaborador_id, mes, media_individual, avaliacoes } = req.body;
    if (!colaborador_id || !mes || media_individual == null || avaliacoes == null)
      return res.status(400).json({ error: 'Todos os campos são obrigatórios.' });
    if (media_individual < 0 || media_individual > 5)
      return res.status(400).json({ error: 'Média deve estar entre 0 e 5.' });
    await pool.query(
      `INSERT INTO gam_notas (colaborador_id, mes, media_individual, avaliacoes, lancado_por)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (colaborador_id, mes)
       DO UPDATE SET media_individual=$3, avaliacoes=$4, lancado_por=$5, updated_at=NOW()`,
      [colaborador_id, mes, media_individual, avaliacoes, req.user.name]
    );
    res.status(201).json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro ao lançar nota.' }); }
});

router.delete('/gam/notas/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query(`DELETE FROM gam_notas WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Erro ao excluir.' }); }
});

// ── Trava manual de nota final do mês (gam_nota_final_override) ────────────
// Corrige o PÓDIO/ranking de um mês já anunciado à equipe sem mexer no dado
// bruto (gam_notas) — o Consolidado Geral continua recalculando cada mês
// direto de gam_notas, então não é afetado por essa trava. Pedido do
// Reysner, 04/09/2026: travar Julho no pódio já apresentado (Elma/Bruno/
// Douglas) mesmo depois de revisões de nota baixa terem mudado o cálculo
// "real" — sem impedir que o consolidado da temporada reflita as revisões.
router.post('/gam/nota-final-override', requireAdmin, async (req, res) => {
  try {
    const { colaborador_id, mes, nota_final, motivo } = req.body;
    if (!colaborador_id || !mes || nota_final == null)
      return res.status(400).json({ error: 'colaborador_id, mes e nota_final são obrigatórios.' });
    if (nota_final < 0 || nota_final > 5) return res.status(400).json({ error: 'nota_final deve estar entre 0 e 5.' });
    await pool.query(
      `INSERT INTO gam_nota_final_override (colaborador_id, mes, nota_final, motivo, criado_por)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (colaborador_id, mes) DO UPDATE SET nota_final=$3, motivo=$4, criado_por=$5, criado_em=NOW()`,
      [colaborador_id, mes, nota_final, motivo || null, req.user.name]
    );
    res.status(201).json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro ao gravar trava de nota final.' }); }
});

router.get('/gam/nota-final-override', requireAdmin, async (req, res) => {
  try {
    const { mes } = req.query;
    const { rows } = await pool.query(
      `SELECT o.*, c.nome FROM gam_nota_final_override o JOIN gam_colaboradores c ON c.id = o.colaborador_id
       WHERE ($1::varchar IS NULL OR o.mes = $1) ORDER BY o.mes DESC, c.nome ASC`, [mes || null]
    );
    res.json({ data: rows });
  } catch (err) { res.status(500).json({ error: 'Erro ao listar travas.' }); }
});

// Limpa TODAS as travas de uma vez — pedido do Reysner, 04/09/2026: "quero
// um botão que limpe tudo o que criamos aqui pra que o sistema a partir de
// Janeiro esteja rodando sem travas e da forma correta". As travas de
// Julho/Agosto/2026 foram uma correção pontual pra bater com pódios já
// anunciados à equipe antes de revisões de nota baixa — não devem virar
// hábito permanente. Não apaga nada de gam_notas, só as travas de exibição.
router.delete('/gam/nota-final-override', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(`DELETE FROM gam_nota_final_override RETURNING id`);
    res.json({ ok: true, removidas: rows.length });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro ao limpar travas.' }); }
});

router.delete('/gam/nota-final-override/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query(`DELETE FROM gam_nota_final_override WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Erro ao excluir trava.' }); }
});

// ── Automação da nota mensal via Zappy — "Modelo Atualizado" fase 1 ─────────
// Só automatiza a MÉDIA MENSAL agregada (o que hoje é digitado à mão em
// /gam/notas). Nota por ticket individual não existe na API pública do
// Zappy — ver nota em cs/zappyClient.js.

// Lista os usuários do Zappy, pra popular o dropdown "vincular ao Zappy"
// na lista de colaboradores (evita digitar o ID na mão).
router.get('/gam/usuarios-zappy', requireAdmin, async (req, res) => {
  try {
    const zappyClient = criarClienteZappy();
    const usuarios = await zappyClient.listarUsuarios();
    res.json({ data: usuarios.map(u => ({ id: String(u.id), nome: u.name })) });
  } catch (err) {
    console.error('[gam] usuarios-zappy falhou:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Liga/desliga o vínculo de um colaborador da Gamificação com um usuário do
// Zappy — sem esse vínculo, o auto-preenchimento pula o colaborador (não dá
// pra adivinhar por nome, já teve caso real de nome digitado diferente).
/** PATCH /api/data/gam/colaboradores/:id/aceite — liga/desliga a regra de tempo de aceite do aguardando pra esse colaborador. */
router.patch('/gam/colaboradores/:id/aceite', requireAdmin, async (req, res) => {
  try {
    await ensureGamTables();
    const { rows } = await pool.query(`SELECT aplica_regra_aceite FROM gam_colaboradores WHERE id = $1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Não encontrado.' });
    const novo = !rows[0].aplica_regra_aceite;
    await pool.query(`UPDATE gam_colaboradores SET aplica_regra_aceite = $1 WHERE id = $2`, [novo, req.params.id]);
    res.json({ ok: true, aplica_regra_aceite: novo });
  } catch (err) { res.status(500).json({ error: 'Erro ao alterar regra de aceite.' }); }
});

/** Normaliza um nome pra um e-mail padrão @escritorial.com.br (minúsculo, sem acento, sem espaço). */
function normalizarParaEmail(nome) {
  return String(nome || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * POST /api/data/gam/colaboradores/criar-logins-em-lote — pra cada
 * colaborador ativo sem login vinculado (user_id null), tenta um e-mail
 * padrão nome@escritorial.com.br: se já existir um usuário com esse
 * e-mail, só VINCULA (liga acesso_minha_nota=true nele, sem mexer em mais
 * nada — role, senha etc. ficam como já estavam); se não existir, CRIA um
 * login novo com perfil 'colaborador' (só Minha Nota) e a senha informada.
 * dryRun (default true) só mostra o plano, sem gravar nada — pedido
 * explícito do Reysner de deixar a criação de login/senha um clique
 * separado e deliberado (nunca automático).
 */
router.post('/gam/colaboradores/criar-logins-em-lote', requireAdmin, async (req, res) => {
  try {
    await ensureGamTables();
    const { senhaPadrao, dryRun = true } = req.body;
    if (!dryRun && (!senhaPadrao || senhaPadrao.length < 6)) {
      return res.status(400).json({ error: 'Senha padrão deve ter ao menos 6 caracteres.' });
    }
    const { rows: colaboradores } = await pool.query(
      `SELECT id, nome FROM gam_colaboradores WHERE ativo = true AND user_id IS NULL ORDER BY nome ASC`
    );
    const resultados = [];
    const hashedPw = !dryRun ? await hashPassword(senhaPadrao) : null;

    for (const c of colaboradores) {
      const email = normalizarParaEmail(c.nome) + '@escritorial.com.br';
      const { rows: existentes } = await pool.query(`SELECT id, role, acesso_minha_nota FROM users WHERE LOWER(email) = LOWER($1)`, [email]);

      if (existentes.length) {
        const u = existentes[0];
        resultados.push({ colaborador_id: c.id, nome: c.nome, email, acao: 'vincular_existente', role_atual: u.role, ja_tinha_acesso: !!u.acesso_minha_nota });
        if (!dryRun) {
          if (!u.acesso_minha_nota) {
            await pool.query(`UPDATE users SET acesso_minha_nota = true, updated_at = NOW() WHERE id = $1`, [u.id]);
            await revokeAllUserTokens(u.id).catch(()=>{});
          }
          await pool.query(`UPDATE gam_colaboradores SET user_id = $1 WHERE id = $2`, [u.id, c.id]);
        }
      } else {
        resultados.push({ colaborador_id: c.id, nome: c.nome, email, acao: 'criar_novo' });
        if (!dryRun) {
          const newId = uuidv4();
          await pool.query(
            `INSERT INTO users (id, name, email, password, role, acesso_minha_nota) VALUES ($1,$2,$3,$4,'colaborador',true)`,
            [newId, c.nome, email, hashedPw]
          );
          await pool.query(`UPDATE gam_colaboradores SET user_id = $1 WHERE id = $2`, [newId, c.id]);
        }
      }
    }
    res.json({ ok: true, dryRun: !!dryRun, total: resultados.length, resultados });
  } catch (err) {
    console.error('[gam] criar-logins-em-lote falhou:', err);
    res.status(500).json({ error: err.message || 'Erro ao criar logins em lote.' });
  }
});

/** PATCH /api/data/gam/colaboradores/:id/login — liga/desliga o colaborador a um login (users.id) pra ele ver a própria nota em /minha-nota. */
router.patch('/gam/colaboradores/:id/login', requireAdmin, async (req, res) => {
  try {
    await ensureGamTables();
    const { user_id } = req.body;
    const { rows } = await pool.query(
      `UPDATE gam_colaboradores SET user_id = $2 WHERE id = $1 RETURNING *`,
      [req.params.id, user_id || null]
    );
    if (!rows.length) return res.status(404).json({ error: 'Não encontrado.' });
    res.json({ ok: true, data: rows[0] });
  } catch (err) { res.status(500).json({ error: 'Erro ao vincular login.' }); }
});

router.patch('/gam/colaboradores/:id/zappy', requireAdmin, async (req, res) => {
  try {
    await ensureGamTables();
    const { zappy_user_id } = req.body;
    const { rows } = await pool.query(
      `UPDATE gam_colaboradores SET zappy_user_id = $2 WHERE id = $1 RETURNING *`,
      [req.params.id, zappy_user_id || null]
    );
    if (!rows.length) return res.status(404).json({ error: 'Não encontrado.' });
    res.json({ ok: true, data: rows[0] });
  } catch (err) { res.status(500).json({ error: 'Erro ao vincular ao Zappy.' }); }
});

// Mapa "rótulo do Zappy" -> nota 0-5. Os rótulos reais só aparecem depois da
// 1ª chamada de verdade à API (o Swagger não documenta os valores) — por
// isso o preview abaixo AUTO-CADASTRA rótulo novo com nota=null, e o admin
// calibra aqui. Rótulo com nota null fica de fora do cálculo (ver preview).
router.get('/gam/qualificacao-mapa', requireAdmin, async (req, res) => {
  try {
    await ensureGamTables();
    const { rows } = await pool.query(`SELECT * FROM gam_qualificacao_mapa ORDER BY chave ASC`);
    res.json({ data: rows });
  } catch (err) { res.status(500).json({ error: 'Erro ao listar mapa de qualificação.' }); }
});

router.patch('/gam/qualificacao-mapa', requireAdmin, async (req, res) => {
  try {
    await ensureGamTables();
    const { chave, nota } = req.body;
    if (!chave) return res.status(400).json({ error: 'Chave obrigatória.' });
    if (nota != null && (nota < 0 || nota > 5)) return res.status(400).json({ error: 'Nota deve estar entre 0 e 5.' });
    await pool.query(
      `INSERT INTO gam_qualificacao_mapa (chave, nota, updated_at) VALUES ($1,$2,NOW())
       ON CONFLICT (chave) DO UPDATE SET nota = $2, updated_at = NOW()`,
      [chave, nota ?? null]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Erro ao salvar mapa de qualificação.' }); }
});

/** Calcula {startDate, endDate} (AAAA-MM-DD) do mês inteiro a partir de "AAAA-MM". */
function faixaDoMes(mes) {
  const [ano, m] = mes.split('-').map(Number);
  const inicio = new Date(Date.UTC(ano, m - 1, 1));
  const fim = new Date(Date.UTC(ano, m, 0)); // dia 0 do mês seguinte = último dia deste mês
  const fmt = (d) => d.toISOString().slice(0, 10);
  return { startDate: fmt(inicio), endDate: fmt(fim) };
}

// Monta a prévia/aplica o auto-preenchimento das notas do mês, para todo
// colaborador ATIVO com zappy_user_id vinculado. dryRun=true (default) só
// calcula e devolve, sem gravar — mesmo padrão de prévia usado no Reajuste
// em Massa e na importação de baixas do Acessórias.
/**
 * Núcleo do auto-preenchimento — extraído da rota pra ser reaproveitado
 * pelo job automático diário (ver rodarAutoPreencherDiario em index.js),
 * sem duplicar a lógica. `lancadoPor` vai pro campo lancado_por de
 * gam_notas (identifica se foi um admin manual ou o job automático).
 */
async function executarAutoPreencher(mes, { dryRun = true, lancadoPor = 'Automático (Zappy)' } = {}) {
  await ensureGamTables();
  await ensurePontuacaoSchema(pool);
  await ensureAbandonoSchema(pool);
  if (!mes || !/^\d{4}-\d{2}$/.test(mes)) throw new Error('Informe "mes" no formato AAAA-MM.');

  // Mês fechado (pedido do Reysner, 15/09/2026): "quando fechasse o mês e
  // definirmos o pódio, não mexe mais nele" — sai ANTES de qualquer consulta
  // ao Zappy ou gravação, pra qualquer chamador (job diário, Sincronizar
  // Notas Agora, Auto-preencher, Relatório da Temporada). Vale tanto pra
  // gravação quanto pra PRÉVIA (dryRun) — um mês fechado nem deveria gastar
  // uma chamada ao Zappy só pra mostrar um número que não pode ser aplicado
  // mesmo. Ver gam_meses_fechados em ensureGamTables.
  if (await isMesFechado(mes)) {
    return { dryRun: !!dryRun, mes, resultados: [], rotulosNovos: [], fechado: true,
      aviso: `${mes} está fechado — o pódio já foi definido e apresentado, então nenhuma sincronização grava nota nova pra esse mês. Reabra em "Fechar/Reabrir Mês" se precisar corrigir algo.` };
  }

  const { rows: colaboradores } = await pool.query(
    `SELECT id, nome, zappy_user_id, aplica_regra_aceite FROM gam_colaboradores WHERE ativo = true AND zappy_user_id IS NOT NULL ORDER BY nome ASC`
  );
  if (!colaboradores.length) {
    return { dryRun: !!dryRun, mes, resultados: [], rotulosNovos: [], aviso: 'Nenhum colaborador ativo vinculado a um usuário do Zappy ainda.' };
  }

  const { rows: mapaRows } = await pool.query(`SELECT chave, nota FROM gam_qualificacao_mapa`);
  const mapa = Object.fromEntries(mapaRows.map(r => [r.chave, r.nota != null ? parseFloat(r.nota) : null]));

  const { startDate, endDate } = faixaDoMes(mes);
  const zappyClient = criarClienteZappy();
  const resultados = [];
  const rotulosNovos = new Set();

  for (const c of colaboradores) {
      // Fonte 1 (preferida): nota real por ticket, já com métricas 1/2/4
      // aplicadas e notas indevidas excluídas (gam_tickets_pontos — ver
      // cs/pontuacao.js). Só cai pro agregado de qualificação (fonte 2) se
      // ainda não tiver ticket pontuado pra esse colaborador nesse mês.
      //
      // Nota do cliente é atribuída só a quem ENCERROU (papel
      // recebeu/unico) — é essa média que vira a nota do mês, e a revisão
      // de nota baixa só afeta essas linhas. Quem só TRANSFERIU não gera
      // nota própria: o desempenho dele nas transferências vira um ajuste
      // que fica "banco" até ele encerrar pelo menos 1 ticket com nota real
      // no mês — só aí o ajuste soma na média (capado em 5). Sem nenhuma
      // nota real, fica sem nota mesmo com ajuste acumulado (mesmo
      // comportamento de "sem avaliação" que já existe pro resto do sistema).
      //
      // O ajuste é a MÉDIA dos pontos de velocidade das transferências (não
      // a soma) — combinado com o Reysner: somar tudo deixava o resultado
      // dependente do VOLUME de transferências (quem transfere muito, mesmo
      // que majoritariamente devagar, podia acumular um saldo negativo
      // gigante e apagar uma nota de atendimento boa). Com a média, o
      // ajuste sempre fica dentro da faixa de um único atendimento (-1 a
      // +2), proporcional à real performance, não ao volume.
      // Revisão de VELOCIDADE (separada da revisão de nota — ver
      // gam_velocidade_revisoes em ensureGamTables): quando 'indevida',
      // remove o ajuste_velocidade daquela linha em vez de descartar o
      // ticket inteiro. Pra recebeu/unico, recalcula a nota_final sem o
      // ajuste_velocidade (mantendo reabertura — /Finalizar não faz mais
      // parte da nota_final por ticket, ver bonusFinalizar abaixo); pra
      // transferiu, exclui a linha inteira da média (o ajuste_velocidade É
      // a nota_final desse papel, não tem "resto" pra manter).
      // Reatribuição de analista (pedido do Reysner, 15/09/2026): em cada uma
      // das 5 revisões (nota baixa, velocidade, aceite, finalizar, abandono)
      // dá pra trocar QUEM responde por aquele item, quando o Zappy atribui
      // o ticket/desconto à pessoa errada (ex.: ticket aparece "Único" da
      // Ivone, mas o atraso real foi no aceite da Elma antes de transferir,
      // e o Zappy não registrou isso como uma transferência formal). Cada
      // tabela de revisão ganhou uma coluna override_analista_id — quando
      // preenchida, o item conta pra ESSA pessoa em vez da original. Nota
      // baixa e Abandono são "linha inteira": COALESCE(override, dono
      // original) decide de quem é o item, igual pros dois lados (sai de
      // quem tinha e entra em quem recebeu). Velocidade e Finalizar são
      // PARCIAIS (moram dentro da mesma linha que a nota do cliente) — a
      // pessoa original mantém a nota do cliente, só o desconto específico
      // muda de dono, virando um item a mais na média de bônus (mesmo
      // princípio de "média, não soma" dos outros bônus).
      const { rows: notasRows } = await pool.query(
        `SELECT p.nota_final, p.nota_cliente, p.ajuste_velocidade, p.ajuste_finalizar, p.ajuste_reabertura,
                COALESCE(vr.status, 'pendente') AS vel_status, vr.override_analista_id AS vel_override,
                COALESCE(fr.status, 'pendente') AS finalizar_status, fr.override_analista_id AS fin_override
         FROM gam_tickets_pontos p
         JOIN cs_tickets t ON t.id = p.ticket_id
         LEFT JOIN gam_velocidade_revisoes vr ON vr.ticket_id = p.ticket_id AND vr.papel = p.papel
         LEFT JOIN gam_finalizar_revisoes fr ON fr.ticket_id = p.ticket_id AND fr.papel = p.papel
         WHERE p.mes = $1 AND p.papel IN ('recebeu','unico')
           AND COALESCE(t.revisao_nota_status, 'pendente') != 'indevida'
           AND COALESCE(t.revisao_nota_override_analista_id, p.analista_id) = $2`,
        [mes, c.zappy_user_id]
      );
      if (notasRows.length) {
        const { rows: bonusRows } = await pool.query(
          `SELECT p.ajuste_velocidade FROM gam_tickets_pontos p
           LEFT JOIN gam_velocidade_revisoes vr ON vr.ticket_id = p.ticket_id AND vr.papel = p.papel
           WHERE p.mes = $1 AND p.analista_id = $2 AND p.papel = 'transferiu'
             AND COALESCE(vr.status, 'pendente') != 'indevida'
             AND (vr.override_analista_id IS NULL OR vr.override_analista_id = $2)`,
          [mes, c.zappy_user_id]
        );
        // Descontos de velocidade dos PRÓPRIOS tickets recebeu/unico (pedido
        // do Reysner, 17/09/2026 — ticket #48308: cliente deu nota 4, um
        // atraso de +30min derrubava a nota_final EXIBIDA pra 3, parecendo
        // que o cliente tinha dado 3. Antes só a métrica de transferência
        // virava média separada; agora TODA velocidade (transferiu, recebeu,
        // unico) segue o mesmo modelo — nota_final do ticket é sempre a nota
        // real do cliente, ver cs/pontuacao.js). Reaproveita notasRows (já
        // filtrado pela nota-dona efetiva) — só olha vel_status/vel_override.
        const velocidadeProprioNotasRows = notasRows.filter(r =>
          r.vel_status !== 'indevida' && (!r.vel_override || r.vel_override === c.zappy_user_id)
        );
        // Descontos de velocidade REATRIBUÍDOS pra esse colaborador (de
        // qualquer papel — transferiu, recebeu ou único de OUTRA pessoa)
        // via revisão "Trocar analista". Entram na mesma média: é um
        // desconto que não veio de um ticket seu, mas que a revisão decidiu
        // que é sua responsabilidade real.
        const { rows: realocadosVelocidadeRows } = await pool.query(
          `SELECT p.ajuste_velocidade FROM gam_tickets_pontos p
           JOIN gam_velocidade_revisoes vr ON vr.ticket_id = p.ticket_id AND vr.papel = p.papel
           WHERE p.mes = $1 AND vr.override_analista_id = $2 AND vr.status = 'devida' AND p.analista_id != $2`,
          [mes, c.zappy_user_id]
        );
        const velocidadeTodos = [
          ...bonusRows.map(r => parseFloat(r.ajuste_velocidade)),
          ...velocidadeProprioNotasRows.map(r => parseFloat(r.ajuste_velocidade)),
          ...realocadosVelocidadeRows.map(r => parseFloat(r.ajuste_velocidade)),
        ];
        const bonusTransferencia = velocidadeTodos.length
          ? velocidadeTodos.reduce((s, v) => s + v, 0) / velocidadeTodos.length
          : 0;

        // Bônus/desconto de ACEITE do aguardando — só pra colaboradores com
        // a flag ligada (hoje só a Elma). Mesma lógica de média (não soma)
        // do bônus de transferência, pelos mesmos motivos (não punir por
        // volume). Usa as linhas 'transferiu' e 'unico' (só quem de fato fez
        // o aceite original tem ajuste_aceite gravado — ver cs/pontuacao.js;
        // 'recebeu' sempre vem NULL e é naturalmente excluído pelo filtro).
        // gam_aceite_revisoes (separada de gam_velocidade_revisoes): exclui
        // contatos marcados como bot/marketing/currículo etc. — "indevida"
        // aqui não é sobre o desconto ter sido justo, é sobre o ticket nem
        // dever entrar na amostra da métrica. COALESCE(override, dono
        // original): reatribuição move o aceite inteiro pra outra pessoa.
        let bonusAceite = 0;
        if (c.aplica_regra_aceite) {
          const { rows: aceiteRows } = await pool.query(
            `SELECT p.ajuste_aceite FROM gam_tickets_pontos p
             LEFT JOIN gam_aceite_revisoes ar ON ar.ticket_id = p.ticket_id AND ar.papel = p.papel
             WHERE p.mes = $1 AND p.papel IN ('transferiu','unico')
               AND p.ajuste_aceite IS NOT NULL
               AND COALESCE(ar.status, 'pendente') != 'indevida'
               AND COALESCE(ar.override_analista_id, p.analista_id) = $2`,
            [mes, c.zappy_user_id]
          );
          if (aceiteRows.length) {
            bonusAceite = aceiteRows.reduce((s, r) => s + parseFloat(r.ajuste_aceite), 0) / aceiteRows.length;
          }
        }

        // Bônus/desconto do /FINALIZAR + REABERTURA (regra combinada desde
        // 28/08/2026 — ver cs/pontuacao.js): avisou certo do encerramento ->
        // sempre neutro; não avisou -> -1 só se o cliente voltou a chamar
        // nos 30min. Mesma lógica de média (não soma) de transferência/
        // aceite, e pelo mesmo motivo: evitar que o teto de 5 por ticket
        // mascare o desconto. Reaproveita notasRows pros próprios (já traz
        // ajuste_finalizar + finalizar_status/fin_override), mais uma
        // consulta à parte pros REATRIBUÍDOS de outras pessoas (mesmo
        // esquema da velocidade acima). gam_finalizar_revisoes: exclui
        // reaberturas que não refletiam um encerramento mal feito (ex.:
        // cliente voltou por um assunto novo, sem relação com o fechamento).
        const finalizarValidosProprios = notasRows.filter(r =>
          r.finalizar_status !== 'indevida' && (!r.fin_override || r.fin_override === c.zappy_user_id)
        );
        const { rows: realocadosFinalizarRows } = await pool.query(
          `SELECT p.ajuste_finalizar FROM gam_tickets_pontos p
           JOIN gam_finalizar_revisoes fr ON fr.ticket_id = p.ticket_id AND fr.papel = p.papel
           WHERE p.mes = $1 AND fr.override_analista_id = $2 AND fr.status = 'devida' AND p.analista_id != $2`,
          [mes, c.zappy_user_id]
        );
        const finalizarTodos = [
          ...finalizarValidosProprios.map(r => parseFloat(r.ajuste_finalizar)),
          ...realocadosFinalizarRows.map(r => parseFloat(r.ajuste_finalizar)),
        ];
        const bonusFinalizar = finalizarTodos.length
          ? finalizarTodos.reduce((s, v) => s + v, 0) / finalizarTodos.length
          : 0;

        // Bônus/desconto de ABANDONO DE ATENDIMENTO (ver cs/abandono.js):
        // cliente interagiu até 16:50 (seg-qui) sem NENHUMA resposta até
        // 17:30 do mesmo dia. Cada incidente vale -1, mas divide pelos
        // MESMOS atendimentos avaliados do mês (notasRows.length) — não pela
        // quantidade de incidentes — senão um analista com só 1 avaliação e
        // 1 incidente cairia junto com quem tem 20 avaliações e 1 incidente.
        // Exemplo do Reysner: 3 incidentes ÷ 20 atendimentos = -0,15.
        // COALESCE(override, dono original): reatribuição move o incidente
        // inteiro pra outra pessoa (sai de quem tinha, entra em quem recebeu).
        let bonusAbandono = 0;
        if (notasRows.length) {
          const { rows: abandonoRows } = await pool.query(
            `SELECT id FROM gam_abandono_incidentes
             WHERE mes = $1 AND status != 'indevida' AND COALESCE(override_analista_id, analista_id) = $2`,
            [mes, c.zappy_user_id]
          );
          bonusAbandono = abandonoRows.length ? -(abandonoRows.length / notasRows.length) : 0;
        }

        // nota_final já é sempre a nota real do cliente (ver cs/pontuacao.js,
        // 17/09/2026) — mediaBase é só a média simples, sem precisar
        // neutralizar velocidade aqui (isso virou bonusTransferencia acima).
        const somaBase = notasRows.reduce((s, r) => s + parseFloat(r.nota_final), 0);
        const mediaBase = somaBase / notasRows.length;
        const media_individual = Number(Math.max(0, Math.min(5, mediaBase + bonusTransferencia + bonusAceite + bonusFinalizar + bonusAbandono)).toFixed(2));
        // mediaBase exposta pra transparência (ver GET /gam/composicao-nota)
        // — é a nota bruta antes dos 4 bônus mensais, pra dar pra mostrar
        // "sua nota final é X porque: base Y + transferência Z + aceite W +
        // finalizar V + abandono U", em vez desses números ficarem só numa
        // resposta crua. bonusTransferencia (agora inclui TODA velocidade,
        // não só transferência) e bonusFinalizar já incluem os itens
        // reatribuídos a esse colaborador.
        resultados.push({ colaborador_id: c.id, nome: c.nome, media_individual, avaliacoes: notasRows.length, mediaBase: Number(mediaBase.toFixed(2)), bonusTransferencia, bonusAceite, bonusFinalizar, bonusAbandono, fonte: 'tickets' });
        if (!dryRun) {
          await pool.query(
            `INSERT INTO gam_notas (colaborador_id, mes, media_individual, avaliacoes, lancado_por)
             VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (colaborador_id, mes)
             DO UPDATE SET media_individual=$3, avaliacoes=$4, lancado_por=$5, updated_at=NOW()`,
            [c.id, mes, media_individual, notasRows.length, `Automático (tickets Zappy) — ${lancadoPor}`]
          );
        }
        continue;
      }

      // Fonte 2 (reforço): agregado por rótulo de qualificação — usado
      // enquanto ainda não há ticket pontuado pra esse colaborador/mês.
      let qualificacoes = [];
      try {
        qualificacoes = await zappyClient.buscarTicketsPorQualificacao({ startDate, endDate, userIds: [c.zappy_user_id] });
      } catch (e) {
        resultados.push({ colaborador_id: c.id, nome: c.nome, erro: e.message });
        continue;
      }

      let somaPonderada = 0, avaliacoes = 0;
      const detalhamento = [];
      for (const q of qualificacoes) {
        const chave = q.qualificacao;
        const total = parseInt(q.totalTickets) || 0;
        if (!total) continue;
        if (!(chave in mapa)) {
          // Rótulo nunca visto — cadastra com nota null pra aparecer na tela
          // de calibração, e ignora essa contagem do cálculo por enquanto.
          await pool.query(`INSERT INTO gam_qualificacao_mapa (chave, nota) VALUES ($1, NULL) ON CONFLICT (chave) DO NOTHING`, [chave]);
          mapa[chave] = null;
          rotulosNovos.add(chave);
        }
        const nota = mapa[chave];
        detalhamento.push({ qualificacao: chave, totalTickets: total, nota });
        if (nota != null) {
          somaPonderada += nota * total;
          avaliacoes += total;
        }
      }

      const media_individual = avaliacoes > 0 ? Number((somaPonderada / avaliacoes).toFixed(2)) : null;

      if (!dryRun) {
        if (media_individual != null && avaliacoes > 0) {
          await pool.query(
            `INSERT INTO gam_notas (colaborador_id, mes, media_individual, avaliacoes, lancado_por)
             VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (colaborador_id, mes)
             DO UPDATE SET media_individual=$3, avaliacoes=$4, lancado_por=$5, updated_at=NOW()`,
            [c.id, mes, media_individual, avaliacoes, `Automático (Zappy) — ${lancadoPor}`]
          );
          resultados.push({ colaborador_id: c.id, nome: c.nome, media_individual, avaliacoes, detalhamento, fonte: 'qualificacao' });
        } else {
          // Sem nota nenhuma agora (nem tickets, nem qualificação retornada
          // pelo Zappy pra esse período) — trava de segurança adicionada
          // 04/09/2026 depois de um incidente real: rodar isso pra um mês
          // ANTIGO (a API de qualificação do Zappy parece ter uma janela de
          // consulta limitada — não retorna mais nada pra meses de vários
          // meses atrás) apagou o Maio e Junho/2026 de 20 colaboradores,
          // sobrescrevendo nota/avaliações REAIS por 0/0 sem nenhum jeito de
          // desfazer (gam_notas não entra no backup automático). A partir de
          // agora: só grava 0/0 se JÁ NÃO HAVIA nada de valor gravado antes
          // (evita sumir da consulta pro Modelo Inicial, como já era) — se
          // já existia avaliacoes>0, PRESERVA o valor antigo em vez de
          // apagar, e só sinaliza no resultado pra alguém ver.
          const { rows: existente } = await pool.query(
            `SELECT media_individual, avaliacoes FROM gam_notas WHERE colaborador_id=$1 AND mes=$2`,
            [c.id, mes]
          );
          if (existente.length && parseInt(existente[0].avaliacoes) > 0) {
            resultados.push({
              colaborador_id: c.id, nome: c.nome, media_individual: parseFloat(existente[0].media_individual),
              avaliacoes: parseInt(existente[0].avaliacoes), detalhamento, fonte: 'qualificacao',
              aviso: 'Zappy não retornou dado nenhum pra esse período agora — nota anterior PRESERVADA (não foi sobrescrita por zero).'
            });
          } else {
            await pool.query(
              `INSERT INTO gam_notas (colaborador_id, mes, media_individual, avaliacoes, lancado_por)
               VALUES ($1,$2,0,0,$3)
               ON CONFLICT (colaborador_id, mes)
               DO UPDATE SET media_individual=0, avaliacoes=0, lancado_por=$3, updated_at=NOW()`,
              [c.id, mes, `Automático (Zappy) — ${lancadoPor}`]
            );
            resultados.push({ colaborador_id: c.id, nome: c.nome, media_individual, avaliacoes, detalhamento, fonte: 'qualificacao' });
          }
        }
      } else {
        resultados.push({ colaborador_id: c.id, nome: c.nome, media_individual, avaliacoes, detalhamento, fonte: 'qualificacao' });
      }
  }

  return { dryRun: !!dryRun, mes, resultados, rotulosNovos: [...rotulosNovos] };
}

/**
 * GET /api/data/gam/diagnostico-vinculos?mes= — TEMPORÁRIO, pra conferir
 * se sobrou algum ticket de não-cliente (fornecedor/interno/software/
 * pendente/sem vínculo) ainda pontuando em gam_tickets_pontos depois do
 * fix de 28/08/2026 (persistirPontosTicket agora exige vinculo tipo=
 * 'cliente'). Como esse fix só roda quando o ticket é reprocessado
 * (recálculo do mês ou ingestão nova), agrupa por empresa+tipo pra achar
 * rápido quem ainda precisa de recálculo ou reclassificação.
 */
/**
 * GET /api/data/gam/diagnostico-analista?analista_id=&mes= — TEMPORÁRIO,
 * pra comparar a contagem BRUTA de tickets avaliados (analista_id, sem
 * filtro nenhum) contra o que sobra depois do filtro de vínculo=cliente,
 * agrupado por tipo de vínculo. Serve pra explicar diferenças com o
 * relatório nativo do Zappy (que conta TODO contato avaliado, sem separar
 * cliente de fornecedor/interno/pendente).
 */
router.get('/gam/diagnostico-analista', requireAdmin, async (req, res) => {
  try {
    const { analista_id, mes } = req.query;
    if (!analista_id) return res.status(400).json({ error: 'Informe "analista_id".' });
    if (!mes || !/^\d{4}-\d{2}$/.test(mes)) return res.status(400).json({ error: 'Informe "mes" no formato AAAA-MM.' });
    const { rows } = await pool.query(
      `SELECT COALESCE(v.tipo, 'sem_vinculo') AS vinculo_tipo, COUNT(*) AS total,
              array_agg(t.zappy_id ORDER BY t.zappy_id) AS zappy_ids
         FROM cs_tickets t
         LEFT JOIN cs_vinculos v ON v.id = t.vinculo_id
        WHERE t.nota_avaliacao IS NOT NULL
          AND TO_CHAR(COALESCE(t.encerramento, t.abertura), 'YYYY-MM') = $1
          AND (t.analista_id = $2 OR t.analista_anterior_id = $2)
        GROUP BY COALESCE(v.tipo, 'sem_vinculo')
        ORDER BY total DESC`,
      [mes, analista_id]
    );
    const totalGeral = rows.reduce((s, r) => s + parseInt(r.total, 10), 0);

    // Quebra por papel real (encerrou = conta como "avaliações"; só
    // transferiu = NÃO conta como avaliação dela, vira bônus separado) —
    // só entre os tickets de CLIENTE (os únicos que deveriam pontuar).
    const { rows: porPapel } = await pool.query(
      `SELECT
         CASE WHEN t.analista_id = $2 THEN 'encerrou_ela' ELSE 'so_transferiu' END AS papel_real,
         COUNT(*) AS total
         FROM cs_tickets t
         LEFT JOIN cs_vinculos v ON v.id = t.vinculo_id
        WHERE t.nota_avaliacao IS NOT NULL
          AND TO_CHAR(COALESCE(t.encerramento, t.abertura), 'YYYY-MM') = $1
          AND (t.analista_id = $2 OR t.analista_anterior_id = $2)
          AND v.tipo = 'cliente'
        GROUP BY papel_real`,
      [mes, analista_id]
    );

    // Dos que ela encerrou (cliente), quantos JÁ estão persistidos em
    // gam_tickets_pontos (papel recebeu/unico) pra esse mês — se for menos
    // que o total acima, tem ticket de cliente que nunca foi processado
    // pelo motor de pontuação (gap de ingestão/processamento, não de
    // classificação de vínculo).
    const { rows: jaPersistidos } = await pool.query(
      `SELECT COUNT(*) AS total, array_agg(t.zappy_id ORDER BY t.zappy_id) AS zappy_ids
         FROM cs_tickets t
         JOIN cs_vinculos v ON v.id = t.vinculo_id
         LEFT JOIN gam_tickets_pontos p ON p.ticket_id = t.id AND p.papel IN ('recebeu','unico')
        WHERE t.nota_avaliacao IS NOT NULL
          AND TO_CHAR(COALESCE(t.encerramento, t.abertura), 'YYYY-MM') = $1
          AND t.analista_id = $2
          AND v.tipo = 'cliente'
          AND p.id IS NULL`,
      [mes, analista_id]
    );

    res.json({ mes, analista_id, totalGeral, porTipo: rows, porPapel, ticketsClienteEncerradosNaoPersistidos: jaPersistidos[0] });
  } catch (err) {
    console.error('[gam] diagnostico-analista falhou:', err);
    res.status(500).json({ error: err.message || 'Erro ao diagnosticar analista.' });
  }
});

router.get('/gam/diagnostico-vinculos', requireAdmin, async (req, res) => {
  try {
    const { mes } = req.query;
    if (!mes || !/^\d{4}-\d{2}$/.test(mes)) return res.status(400).json({ error: 'Informe "mes" no formato AAAA-MM.' });
    const { rows } = await pool.query(
      `SELECT t.empresa_texto, v.tipo AS vinculo_tipo, v.id AS vinculo_id,
              COUNT(*) AS tickets, array_agg(DISTINCT t.zappy_id) AS zappy_ids, array_agg(DISTINCT p.analista) AS analistas
         FROM gam_tickets_pontos p
         JOIN cs_tickets t ON t.id = p.ticket_id
         LEFT JOIN cs_vinculos v ON v.id = t.vinculo_id
        WHERE p.mes = $1 AND COALESCE(v.tipo, 'sem_vinculo') != 'cliente'
        GROUP BY t.empresa_texto, v.tipo, v.id
        ORDER BY tickets DESC`,
      [mes]
    );
    res.json({ mes, total: rows.length, resultados: rows });
  } catch (err) {
    console.error('[gam] diagnostico-vinculos falhou:', err);
    res.status(500).json({ error: err.message || 'Erro ao diagnosticar vínculos.' });
  }
});

router.post('/gam/notas/auto-preencher', requireAdmin, async (req, res) => {
  try {
    const { mes, dryRun = true } = req.body;
    const resultado = await executarAutoPreencher(mes, { dryRun, lancadoPor: req.user.name });
    res.json({ ok: true, ...resultado });
  } catch (err) {
    console.error('[gam] auto-preencher falhou:', err);
    res.status(500).json({ error: err.message || 'Erro ao auto-preencher notas.' });
  }
});

/**
 * GET /api/data/gam/minha-composicao?mes= — versão self-service da
 * composição da nota (ver /gam/composicao-nota acima), pro colaborador ver
 * a própria nota sem precisar de acesso de admin. NUNCA aceita
 * colaborador_id do cliente — resolve sempre a partir de quem está logado
 * (req.user.id -> gam_colaboradores.user_id), então não tem como uma
 * pessoa ver a nota de outra trocando parâmetro. Role 'colaborador' só
 * consegue chegar aqui mesmo (ver auth.js); 'administrador'/'usuario'
 * também podem usar (útil pra admin conferir "o que ESSA pessoa vê").
 */
router.get('/gam/minha-composicao', async (req, res) => {
  try {
    await ensureGamTables();
    const { mes } = req.query;
    if (!mes || !/^\d{4}-\d{2}$/.test(mes)) return res.status(400).json({ error: 'Informe "mes" no formato AAAA-MM.' });
    const { rows } = await pool.query(`SELECT id, nome FROM gam_colaboradores WHERE user_id = $1`, [req.user.id]);
    if (!rows.length) return res.status(404).json({ error: 'Seu login ainda não está vinculado a um colaborador da Gamificação. Fale com a liderança.' });
    const colaborador = rows[0];
    const resultado = await executarAutoPreencher(mes, { dryRun: true });
    const linha = (resultado.resultados || []).find(r => r.colaborador_id === colaborador.id);
    if (!linha) {
      return res.json({ ok: true, mes, nome: colaborador.nome, semDados: true, mensagem: 'Sem nota calculada nesse mês (sem avaliação de cliente ainda).' });
    }
    res.json({ ok: true, mes, ...linha });
  } catch (err) {
    console.error('[gam] minha-composicao falhou:', err);
    res.status(500).json({ error: 'Erro ao calcular sua composição de nota.' });
  }
});

/** GET /api/data/gam/meus-tickets?mes= — versão self-service do relatório de descontos, mesmo esquema de segurança de /gam/minha-composicao acima. */
router.get('/gam/meus-tickets', async (req, res) => {
  try {
    await ensurePontuacaoSchema(pool);
    const { mes } = req.query;
    if (!mes || !/^\d{4}-\d{2}$/.test(mes)) return res.status(400).json({ error: 'Informe "mes" no formato AAAA-MM.' });
    const { rows: colabRows } = await pool.query(`SELECT nome, zappy_user_id FROM gam_colaboradores WHERE user_id = $1`, [req.user.id]);
    if (!colabRows.length) return res.status(404).json({ error: 'Seu login ainda não está vinculado a um colaborador da Gamificação. Fale com a liderança.' });
    if (!colabRows[0].zappy_user_id) return res.json({ colaborador: colabRows[0].nome, mes, tickets: [], aviso: 'Ainda não vinculado a um usuário do Zappy.' });
    const { rows } = await pool.query(
      `SELECT p.papel, p.nota_cliente, p.ajuste_velocidade, p.ajuste_finalizar, p.ajuste_aceite, p.nota_final,
              t.zappy_id, t.empresa_texto, t.encerramento, t.revisao_nota_status,
              COALESCE(vr.status, 'pendente') AS vel_revisao_status,
              COALESCE(fr.status, 'pendente') AS finalizar_revisao_status,
              COALESCE(ar.status, 'pendente') AS aceite_revisao_status
       FROM gam_tickets_pontos p
       JOIN cs_tickets t ON t.id = p.ticket_id
       LEFT JOIN gam_velocidade_revisoes vr ON vr.ticket_id = p.ticket_id AND vr.papel = p.papel
       LEFT JOIN gam_finalizar_revisoes fr ON fr.ticket_id = p.ticket_id AND fr.papel = p.papel
       LEFT JOIN gam_aceite_revisoes ar ON ar.ticket_id = p.ticket_id AND ar.papel = p.papel
       WHERE p.mes = $1 AND p.analista_id = $2
       ORDER BY t.encerramento DESC NULLS LAST`,
      [mes, colabRows[0].zappy_user_id]
    );
    res.json({ colaborador: colabRows[0].nome, mes, tickets: rows });
  } catch (err) {
    console.error('[gam] meus-tickets falhou:', err);
    res.status(500).json({ error: 'Erro ao listar seus tickets.' });
  }
});

/**
 * GET /api/data/gam/composicao-nota?colaborador_id=&mes= — versão admin da
 * composição da nota (mostra "a nota final é X porque": nota base + bônus/
 * desconto de transferência + aceite + /Finalizar) pra qualquer colaborador
 * — ver a versão self-service em /gam/minha-composicao acima.
 */
router.get('/gam/composicao-nota', requireAdmin, async (req, res) => {
  try {
    const { colaborador_id, mes } = req.query;
    if (!colaborador_id) return res.status(400).json({ error: 'Informe "colaborador_id".' });
    if (!mes || !/^\d{4}-\d{2}$/.test(mes)) return res.status(400).json({ error: 'Informe "mes" no formato AAAA-MM.' });
    const resultado = await executarAutoPreencher(mes, { dryRun: true });
    const linha = (resultado.resultados || []).find(r => r.colaborador_id === colaborador_id);
    if (!linha) {
      return res.json({ ok: true, mes, colaborador_id, semDados: true, mensagem: 'Sem nota calculada nesse mês (sem avaliação, ou colaborador ainda vem do agregado de qualificação — sem esse detalhamento).' });
    }
    res.json({ ok: true, mes, ...linha });
  } catch (err) {
    console.error('[gam] composicao-nota falhou:', err);
    res.status(500).json({ error: err.message || 'Erro ao calcular composição da nota.' });
  }
});

// Reprocessa TODOS os tickets já pontuados de um mês com a fórmula ATUAL
// (ver recalcularPontosDoMes em cs/pontuacao.js) — necessário sempre que a
// fórmula de pontuação muda, senão ticket já pontuado fica preso com o
// valor calculado pela fórmula velha pra sempre. Não é automático de
// propósito (rodar isso sem necessidade é desperdício) — botão manual.
let recalculoPontosEmAndamento = false;
router.post('/gam/recalcular-pontos', requireAdmin, async (req, res) => {
  if (recalculoPontosEmAndamento) {
    return res.status(409).json({ error: 'Já existe um recálculo em andamento. Aguarde terminar.' });
  }
  const { mes } = req.body;
  if (!mes || !/^\d{4}-\d{2}$/.test(mes)) return res.status(400).json({ error: 'Informe "mes" no formato AAAA-MM.' });
  recalculoPontosEmAndamento = true;
  res.json({ ok: true, mensagem: `Recálculo de ${mes} iniciado em segundo plano.` });
  try {
    const resultado = await recalcularPontosDoMes(pool, mes);
    console.log('[gam] Recálculo de pontos concluído:', mes, resultado);
    // Recalcula abandono TAMBÉM, forçando (não só o que mudou) — senão um
    // ticket já checado antes de uma correção na regra fica preso pra
    // sempre com o resultado antigo (achado do Reysner, 02/09/2026).
    const resultadoAbandono = await recalcularAbandonoDoMes(pool, mes);
    console.log('[gam] Recálculo de abandono concluído:', mes, resultadoAbandono);
  } catch (e) {
    console.error('[gam] Recálculo de pontos falhou:', e);
  } finally {
    recalculoPontosEmAndamento = false;
  }
});

// ── Relatório de descontos por colaborador (transparência pra justificar
// a nota quando o analista questionar) — mostra, ticket a ticket, cada
// ajuste de métrica aplicado (velocidade/finalizar/reabertura) e o motivo.
router.get('/gam/relatorio-descontos', requireAdmin, async (req, res) => {
  try {
    await ensurePontuacaoSchema(pool);
    await ensureAbandonoSchema(pool);
    const { mes, colaborador_id } = req.query;
    if (!mes || !/^\d{4}-\d{2}$/.test(mes)) return res.status(400).json({ error: 'Informe "mes" no formato AAAA-MM.' });
    if (!colaborador_id) return res.status(400).json({ error: 'Informe "colaborador_id".' });

    const { rows: colabRows } = await pool.query(
      `SELECT nome, zappy_user_id FROM gam_colaboradores WHERE id = $1`, [colaborador_id]
    );
    if (!colabRows.length) return res.status(404).json({ error: 'Colaborador não encontrado.' });
    if (!colabRows[0].zappy_user_id) return res.json({ colaborador: colabRows[0].nome, mes, tickets: [], abandono: [], aviso: 'Colaborador ainda não vinculado a um usuário do Zappy.' });

    const { rows } = await pool.query(
      `SELECT p.papel, p.nota_cliente, p.ajuste_velocidade, p.ajuste_finalizar, p.ajuste_reabertura, p.ajuste_aceite, p.nota_final,
              t.zappy_id, t.empresa_texto, t.encerramento, t.revisao_nota_status,
              COALESCE(vr.status, 'pendente') AS vel_revisao_status,
              COALESCE(fr.status, 'pendente') AS finalizar_revisao_status,
              COALESCE(ar.status, 'pendente') AS aceite_revisao_status
       FROM gam_tickets_pontos p
       JOIN cs_tickets t ON t.id = p.ticket_id
       LEFT JOIN gam_velocidade_revisoes vr ON vr.ticket_id = p.ticket_id AND vr.papel = p.papel
       LEFT JOIN gam_finalizar_revisoes fr ON fr.ticket_id = p.ticket_id AND fr.papel = p.papel
       LEFT JOIN gam_aceite_revisoes ar ON ar.ticket_id = p.ticket_id AND ar.papel = p.papel
       WHERE p.mes = $1 AND p.analista_id = $2
       ORDER BY t.encerramento DESC NULLS LAST`,
      [mes, colabRows[0].zappy_user_id]
    );
    const { rows: abandono } = await pool.query(
      `SELECT a.id, a.data, a.ultima_mensagem_cliente, a.ultima_mensagem_texto, a.status,
              t.zappy_id, t.empresa_texto
         FROM gam_abandono_incidentes a
         JOIN cs_tickets t ON t.id = a.ticket_id
        WHERE a.mes = $1 AND a.analista_id = $2
        ORDER BY a.data DESC`,
      [mes, colabRows[0].zappy_user_id]
    );
    res.json({ colaborador: colabRows[0].nome, mes, tickets: rows, abandono });
  } catch (err) {
    console.error('[gam] relatorio-descontos falhou:', err);
    res.status(500).json({ error: 'Erro ao gerar relatório.' });
  }
});

// ── Revisão de nota baixa (Modelo Atualizado) — só admin ───────────────────
// Tela simples: Ticket / Cliente / Nota. Todo ticket com nota do cliente
// abaixo de 5 fica "pendente" até alguém marcar devida (conta normalmente)
// ou indevida (some do cálculo da nota mensal — ver auto-preencher acima).
// Por TICKET, não por papel: a nota do cliente é atribuída só a quem
// encerrou o atendimento — revisar afeta só o cálculo de quem encerrou,
// quem transferiu não é dono da nota e conta sempre (ver auto-preencher acima).
//
// Também entra na fila quem tem nota 5 mas o CONTATO do ticket parece ser
// alguém da própria equipe (bate com um nome de usuário do Zappy) — achado
// real do Reysner: um colega pode avaliar o colega pra inflar a nota
// (ex.: contato "Suporte Hands Financeiro 2", ou nomes de diretoria tipo
// Josiane/Denisa/Eduardo/Thais aparecendo como "cliente"). Isso não prova
// fraude sozinho (pode ser nome coincidente), só bota na fila pra alguém olhar.
router.get('/gam/tickets-revisao', requireAdmin, async (req, res) => {
  try {
    await ensurePontuacaoSchema(pool);
    const { mes } = req.query;
    if (!mes || !/^\d{4}-\d{2}$/.test(mes)) return res.status(400).json({ error: 'Informe "mes" no formato AAAA-MM.' });
    const status = ['pendente', 'devida', 'indevida'].includes(req.query.status) ? req.query.status : 'pendente';

    let padroesInternos = [];
    try {
      const zappyClient = criarClienteZappy();
      const usuarios = await zappyClient.listarUsuarios();
      padroesInternos = [...new Set(
        usuarios
          .map(u => (u.name || '').split(/[-,]/)[0].trim()) // "Eduardo - Diretor..." -> "Eduardo"
          .filter(n => n.length >= 3)
      )].map(n => '%' + n + '%');
    } catch (e) {
      console.error('[gam] tickets-revisao: falha ao buscar usuários do Zappy pra checar contato interno (segue só com notas baixas):', e.message);
    }

    const params = [mes, status];
    let condicaoInterno = '';
    if (padroesInternos.length) {
      params.push(padroesInternos);
      condicaoInterno = ` OR empresa_texto ILIKE ANY($${params.length})`;
    }

    const { rows } = await pool.query(
      `SELECT t.id, t.zappy_id, t.empresa_texto, t.analista, t.nota_avaliacao AS nota_cliente, t.encerramento,
              t.revisao_nota_status, t.revisao_nota_por, t.revisao_nota_em,
              (t.nota_avaliacao < 5) AS nota_baixa,
              t.revisao_nota_override_analista_id AS override_analista_id, oc.nome AS override_analista_nome
       FROM cs_tickets t
       LEFT JOIN gam_colaboradores oc ON oc.zappy_user_id = t.revisao_nota_override_analista_id
       WHERE t.nota_avaliacao IS NOT NULL
         AND COALESCE(t.revisao_nota_status, 'pendente') = $2
         AND TO_CHAR(COALESCE(t.encerramento, t.abertura), 'YYYY-MM') = $1
         AND (t.nota_avaliacao < 5${condicaoInterno})
       ORDER BY t.encerramento DESC NULLS LAST`,
      params
    );
    res.json({ data: rows });
  } catch (err) {
    console.error('[gam] tickets-revisao falhou:', err);
    res.status(500).json({ error: 'Erro ao listar tickets para revisão.' });
  }
});

/**
 * PATCH /api/data/gam/tickets-revisao/:id — marca devida/indevida/pendente,
 * e opcionalmente reatribui a NOTA (nota do cliente + tudo que anda na mesma
 * linha: velocidade, finalizar) pra outro colaborador via `novo_colaborador_id`
 * (UUID de gam_colaboradores — só aceito junto com status_revisao='devida';
 * reatribuir uma nota que nem vai contar não faz sentido). Mandar
 * novo_colaborador_id=null limpa uma reatribuição anterior sem mudar o status.
 */
router.patch('/gam/tickets-revisao/:id', requireAdmin, async (req, res) => {
  try {
    const { status_revisao, novo_colaborador_id } = req.body;
    if (!['devida', 'indevida', 'pendente'].includes(status_revisao)) {
      return res.status(400).json({ error: 'status_revisao deve ser "devida", "indevida" ou "pendente".' });
    }
    if (novo_colaborador_id && status_revisao !== 'devida') {
      return res.status(400).json({ error: 'Só dá pra reatribuir junto com status "devida".' });
    }
    // "pendente" reabre a revisão (limpa a decisão anterior) — pedido do
    // Reysner, 05/09/2026: quis reverter uma marcação de indevida pra
    // decidir de novo manualmente, em vez de ficar preso na decisão antiga.
    // "pendente" também limpa qualquer reatribuição anterior.
    const valor = status_revisao === 'pendente' ? null : status_revisao;
    const novoAnalistaId = valor === null ? null : await resolverNovoAnalistaId(novo_colaborador_id);
    const { rows } = await pool.query(
      `UPDATE cs_tickets SET revisao_nota_status = $2, revisao_nota_por = $3, revisao_nota_em = NOW(),
              revisao_nota_override_analista_id = $4
       WHERE id = $1 RETURNING id`,
      [req.params.id, valor, req.user.name, novoAnalistaId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Não encontrado.' });
    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    console.error('[gam] PATCH tickets-revisao falhou:', err);
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Erro ao salvar revisão.' });
  }
});

/**
 * GET /api/data/gam/tickets-revisao-velocidade — revisão do DESCONTO DE
 * VELOCIDADE em si (diferente de /gam/tickets-revisao, que é sobre a NOTA
 * do cliente). Lista linhas de gam_tickets_pontos com ajuste_velocidade
 * negativo (o desconto), pra qualquer papel — recebeu/único/transferiu —
 * porque um analista que só transferiu também pode ter um desconto de
 * velocidade injusto (ex.: esperando o cliente mandar um documento).
 */
router.get('/gam/tickets-revisao-velocidade', requireAdmin, async (req, res) => {
  try {
    await ensureGamTables();
    const { mes } = req.query;
    if (!mes || !/^\d{4}-\d{2}$/.test(mes)) return res.status(400).json({ error: 'Informe "mes" no formato AAAA-MM.' });
    const status = ['pendente', 'devida', 'indevida'].includes(req.query.status) ? req.query.status : 'pendente';

    const { rows } = await pool.query(
      `SELECT p.ticket_id, p.papel, p.analista, p.ajuste_velocidade, p.nota_final,
              t.zappy_id, t.empresa_texto, t.encerramento,
              vr.status AS revisao_status, vr.revisado_por, vr.revisado_em,
              vr.override_analista_id, oc.nome AS override_analista_nome
         FROM gam_tickets_pontos p
         JOIN cs_tickets t ON t.id = p.ticket_id
         LEFT JOIN gam_velocidade_revisoes vr ON vr.ticket_id = p.ticket_id AND vr.papel = p.papel
         LEFT JOIN gam_colaboradores oc ON oc.zappy_user_id = vr.override_analista_id
        WHERE p.mes = $1
          AND p.ajuste_velocidade < 0
          AND COALESCE(vr.status, 'pendente') = $2
        ORDER BY t.encerramento DESC NULLS LAST`,
      [mes, status]
    );
    res.json({ data: rows });
  } catch (err) {
    console.error('[gam] tickets-revisao-velocidade falhou:', err);
    res.status(500).json({ error: 'Erro ao listar descontos de velocidade para revisão.' });
  }
});

/**
 * PATCH /api/data/gam/tickets-revisao-velocidade/:ticketId/:papel — marca
 * devida/indevida, e opcionalmente reatribui SÓ o desconto (não a nota do
 * cliente) pra outro colaborador via `novo_colaborador_id` (UUID de
 * gam_colaboradores — só junto com status_revisao='devida').
 */
router.patch('/gam/tickets-revisao-velocidade/:ticketId/:papel', requireAdmin, async (req, res) => {
  try {
    const { status_revisao, novo_colaborador_id } = req.body;
    if (!['devida', 'indevida'].includes(status_revisao)) {
      return res.status(400).json({ error: 'status_revisao deve ser "devida" ou "indevida".' });
    }
    if (novo_colaborador_id && status_revisao !== 'devida') {
      return res.status(400).json({ error: 'Só dá pra reatribuir junto com status "devida".' });
    }
    const { papel } = req.params;
    if (!['transferiu', 'recebeu', 'unico'].includes(papel)) {
      return res.status(400).json({ error: 'papel inválido.' });
    }
    await ensureGamTables();
    const novoAnalistaId = await resolverNovoAnalistaId(novo_colaborador_id);
    const { rows } = await pool.query(
      `INSERT INTO gam_velocidade_revisoes (ticket_id, papel, status, revisado_por, revisado_em, override_analista_id)
       VALUES ($1, $2, $3, $4, NOW(), $5)
       ON CONFLICT (ticket_id, papel) DO UPDATE SET
         status = $3, revisado_por = $4, revisado_em = NOW(), override_analista_id = $5
       RETURNING id`,
      [req.params.ticketId, papel, status_revisao, req.user.name, novoAnalistaId]
    );
    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    console.error('[gam] PATCH tickets-revisao-velocidade falhou:', err);
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Erro ao salvar revisão de velocidade.' });
  }
});

/**
 * GET /api/data/gam/tickets-revisao-aceite — revisão do ACEITE do
 * aguardando: lista linhas de gam_tickets_pontos com desconto de aceite
 * (ajuste_aceite < 0 — mesmo critério da revisão de velocidade, só o que
 * de fato pesa contra alguém) pra colaboradores com
 * gam_colaboradores.aplica_regra_aceite = true. Pra marcar como 'indevida'
 * contatos que parecem bot/marketing/currículo etc. — o ticket some do
 * cálculo da média de aceite daquele colaborador, sem afetar mais nada.
 */
router.get('/gam/tickets-revisao-aceite', requireAdmin, async (req, res) => {
  try {
    await ensureGamTables();
    await ensurePontuacaoSchema(pool);
    const { mes } = req.query;
    if (!mes || !/^\d{4}-\d{2}$/.test(mes)) return res.status(400).json({ error: 'Informe "mes" no formato AAAA-MM.' });
    const status = ['pendente', 'devida', 'indevida'].includes(req.query.status) ? req.query.status : 'pendente';

    const { rows } = await pool.query(
      `SELECT p.ticket_id, p.papel, p.analista, p.ajuste_aceite, p.nota_final,
              t.zappy_id, t.empresa_texto, t.encerramento,
              ar.status AS revisao_status, ar.revisado_por, ar.revisado_em,
              ar.override_analista_id, oc.nome AS override_analista_nome
         FROM gam_tickets_pontos p
         JOIN cs_tickets t ON t.id = p.ticket_id
         JOIN gam_colaboradores c ON c.zappy_user_id = p.analista_id
         LEFT JOIN gam_aceite_revisoes ar ON ar.ticket_id = p.ticket_id AND ar.papel = p.papel
         LEFT JOIN gam_colaboradores oc ON oc.zappy_user_id = ar.override_analista_id
        WHERE p.mes = $1
          AND p.ajuste_aceite < 0
          AND c.aplica_regra_aceite = true
          AND COALESCE(ar.status, 'pendente') = $2
        ORDER BY t.encerramento DESC NULLS LAST`,
      [mes, status]
    );
    res.json({ data: rows });
  } catch (err) {
    console.error('[gam] tickets-revisao-aceite falhou:', err);
    res.status(500).json({ error: 'Erro ao listar aceites para revisão.' });
  }
});

/**
 * PATCH /api/data/gam/tickets-revisao-aceite/:ticketId/:papel — marca
 * devida/indevida, e opcionalmente reatribui o aceite pra outro colaborador
 * via `novo_colaborador_id` (UUID de gam_colaboradores — só junto com
 * status_revisao='devida').
 */
router.patch('/gam/tickets-revisao-aceite/:ticketId/:papel', requireAdmin, async (req, res) => {
  try {
    const { status_revisao, novo_colaborador_id } = req.body;
    if (!['devida', 'indevida'].includes(status_revisao)) {
      return res.status(400).json({ error: 'status_revisao deve ser "devida" ou "indevida".' });
    }
    if (novo_colaborador_id && status_revisao !== 'devida') {
      return res.status(400).json({ error: 'Só dá pra reatribuir junto com status "devida".' });
    }
    const { papel } = req.params;
    if (!['transferiu', 'unico'].includes(papel)) {
      return res.status(400).json({ error: 'papel inválido.' });
    }
    await ensureGamTables();
    const novoAnalistaId = await resolverNovoAnalistaId(novo_colaborador_id);
    const { rows } = await pool.query(
      `INSERT INTO gam_aceite_revisoes (ticket_id, papel, status, revisado_por, revisado_em, override_analista_id)
       VALUES ($1, $2, $3, $4, NOW(), $5)
       ON CONFLICT (ticket_id, papel) DO UPDATE SET
         status = $3, revisado_por = $4, revisado_em = NOW(), override_analista_id = $5
       RETURNING id`,
      [req.params.ticketId, papel, status_revisao, req.user.name, novoAnalistaId]
    );
    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    console.error('[gam] PATCH tickets-revisao-aceite falhou:', err);
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Erro ao salvar revisão de aceite.' });
  }
});

/**
 * GET /api/data/gam/tickets-revisao-finalizar — revisão do /FINALIZAR +
 * REABERTURA combinado (ver cs/pontuacao.js): lista linhas de
 * gam_tickets_pontos com desconto (ajuste_finalizar < 0 — só acontece
 * quando não avisou certo E o cliente voltou a chamar em 30min). Pra marcar
 * como 'indevida' reaberturas que não refletem um encerramento mal feito
 * de verdade (ex.: cliente voltou por um assunto novo) — o ticket some do
 * cálculo da média daquele colaborador, sem afetar mais nada.
 */
router.get('/gam/tickets-revisao-finalizar', requireAdmin, async (req, res) => {
  try {
    await ensureGamTables();
    await ensurePontuacaoSchema(pool);
    const { mes } = req.query;
    if (!mes || !/^\d{4}-\d{2}$/.test(mes)) return res.status(400).json({ error: 'Informe "mes" no formato AAAA-MM.' });
    const status = ['pendente', 'devida', 'indevida'].includes(req.query.status) ? req.query.status : 'pendente';

    const { rows } = await pool.query(
      `SELECT p.ticket_id, p.papel, p.analista, p.ajuste_finalizar, p.nota_final,
              t.zappy_id, t.empresa_texto, t.encerramento,
              fr.status AS revisao_status, fr.revisado_por, fr.revisado_em,
              fr.override_analista_id, oc.nome AS override_analista_nome
         FROM gam_tickets_pontos p
         JOIN cs_tickets t ON t.id = p.ticket_id
         LEFT JOIN gam_finalizar_revisoes fr ON fr.ticket_id = p.ticket_id AND fr.papel = p.papel
         LEFT JOIN gam_colaboradores oc ON oc.zappy_user_id = fr.override_analista_id
        WHERE p.mes = $1
          AND p.ajuste_finalizar < 0
          AND COALESCE(fr.status, 'pendente') = $2
        ORDER BY t.encerramento DESC NULLS LAST`,
      [mes, status]
    );
    res.json({ data: rows });
  } catch (err) {
    console.error('[gam] tickets-revisao-finalizar falhou:', err);
    res.status(500).json({ error: 'Erro ao listar descontos de finalizar/reabertura para revisão.' });
  }
});

/**
 * PATCH /api/data/gam/tickets-revisao-finalizar/:ticketId/:papel — marca
 * devida/indevida, e opcionalmente reatribui SÓ o desconto pra outro
 * colaborador via `novo_colaborador_id` (UUID de gam_colaboradores — só
 * junto com status_revisao='devida').
 */
router.patch('/gam/tickets-revisao-finalizar/:ticketId/:papel', requireAdmin, async (req, res) => {
  try {
    const { status_revisao, novo_colaborador_id } = req.body;
    if (!['devida', 'indevida'].includes(status_revisao)) {
      return res.status(400).json({ error: 'status_revisao deve ser "devida" ou "indevida".' });
    }
    if (novo_colaborador_id && status_revisao !== 'devida') {
      return res.status(400).json({ error: 'Só dá pra reatribuir junto com status "devida".' });
    }
    const { papel } = req.params;
    if (!['recebeu', 'unico'].includes(papel)) {
      return res.status(400).json({ error: 'papel inválido.' });
    }
    await ensureGamTables();
    const novoAnalistaId = await resolverNovoAnalistaId(novo_colaborador_id);
    const { rows } = await pool.query(
      `INSERT INTO gam_finalizar_revisoes (ticket_id, papel, status, revisado_por, revisado_em, override_analista_id)
       VALUES ($1, $2, $3, $4, NOW(), $5)
       ON CONFLICT (ticket_id, papel) DO UPDATE SET
         status = $3, revisado_por = $4, revisado_em = NOW(), override_analista_id = $5
       RETURNING id`,
      [req.params.ticketId, papel, status_revisao, req.user.name, novoAnalistaId]
    );
    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    console.error('[gam] PATCH tickets-revisao-finalizar falhou:', err);
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Erro ao salvar revisão de finalizar/reabertura.' });
  }
});

/**
 * GET /api/data/gam/tickets-revisao-abandono — revisão de ABANDONO DE
 * ATENDIMENTO (ver cs/abandono.js): cliente interagiu até 16:50 (seg-qui) e
 * ninguém do escritório respondeu até 17:30 do mesmo dia. Diferente das
 * outras 3 revisões, aqui a chave é (ticket, DIA) — um ticket parado vários
 * dias gera um incidente por dia, cada um revisável separadamente. Marca
 * "Devida" se realmente não teve resposta nenhuma (desconta), ou "Indevida"
 * se por algum motivo não deveria contar (ex.: mensagem do cliente
 * classificada errado como pendente, analista de folga programada com
 * cobertura combinada, etc.).
 */
router.get('/gam/tickets-revisao-abandono', requireAdmin, async (req, res) => {
  try {
    await ensureAbandonoSchema(pool);
    const { mes } = req.query;
    if (!mes || !/^\d{4}-\d{2}$/.test(mes)) return res.status(400).json({ error: 'Informe "mes" no formato AAAA-MM.' });
    const status = ['pendente', 'devida', 'indevida'].includes(req.query.status) ? req.query.status : 'pendente';

    const { rows } = await pool.query(
      `SELECT a.id, a.data, a.analista, a.ultima_mensagem_cliente, a.ultima_mensagem_texto,
              a.status AS revisao_status, a.revisado_por, a.revisado_em,
              t.zappy_id, t.empresa_texto,
              a.override_analista_id, oc.nome AS override_analista_nome
         FROM gam_abandono_incidentes a
         JOIN cs_tickets t ON t.id = a.ticket_id
         LEFT JOIN gam_colaboradores oc ON oc.zappy_user_id = a.override_analista_id
        WHERE a.mes = $1 AND a.status = $2
        ORDER BY a.data DESC, t.encerramento DESC NULLS LAST`,
      [mes, status]
    );
    res.json({ data: rows });
  } catch (err) {
    console.error('[gam] tickets-revisao-abandono falhou:', err);
    res.status(500).json({ error: 'Erro ao listar incidentes de abandono para revisão.' });
  }
});

/**
 * PATCH /api/data/gam/tickets-revisao-abandono/:id — marca devida/indevida,
 * e opcionalmente reatribui o incidente inteiro pra outro colaborador via
 * `novo_colaborador_id` (UUID de gam_colaboradores — só junto com
 * status_revisao='devida').
 */
router.patch('/gam/tickets-revisao-abandono/:id', requireAdmin, async (req, res) => {
  try {
    const { status_revisao, novo_colaborador_id } = req.body;
    if (!['devida', 'indevida'].includes(status_revisao)) {
      return res.status(400).json({ error: 'status_revisao deve ser "devida" ou "indevida".' });
    }
    if (novo_colaborador_id && status_revisao !== 'devida') {
      return res.status(400).json({ error: 'Só dá pra reatribuir junto com status "devida".' });
    }
    await ensureAbandonoSchema(pool);
    const novoAnalistaId = await resolverNovoAnalistaId(novo_colaborador_id);
    const { rows } = await pool.query(
      `UPDATE gam_abandono_incidentes SET status = $2, revisado_por = $3, revisado_em = NOW(), override_analista_id = $4
       WHERE id = $1 RETURNING id`,
      [req.params.id, status_revisao, req.user.name, novoAnalistaId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Não encontrado.' });
    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    console.error('[gam] PATCH tickets-revisao-abandono falhou:', err);
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Erro ao salvar revisão de abandono.' });
  }
});

/**
 * GET /api/data/gam/ticket-busca?zappy_id=&mes= — busca direta por número de
 * ticket, pra usar nas 5 telas de revisão (nota/velocidade/aceite/
 * finalizar/abandono) sem depender do ticket estar na lista de pendentes
 * filtrada. Pedido do Reysner, 28/08/2026: às vezes o admin já sabe qual
 * ticket quer corrigir e não quer catar na lista. Devolve o ticket (pra
 * revisão de nota) + as linhas de gam_tickets_pontos daquele mês (pra
 * revisão de velocidade/aceite/finalizar, uma por papel) + os incidentes de
 * abandono daquele mês, já com o status atual de cada revisão.
 */
router.get('/gam/ticket-busca', requireAdmin, async (req, res) => {
  try {
    await ensureGamTables();
    const zappyId = String(req.query.zappy_id || '').replace(/\D/g, '');
    const { mes } = req.query;
    if (!zappyId) return res.status(400).json({ error: 'Informe o número do ticket.' });
    if (!mes || !/^\d{4}-\d{2}$/.test(mes)) return res.status(400).json({ error: 'Informe "mes" no formato AAAA-MM.' });

    const { rows: ticketRows } = await pool.query(
      `SELECT id, zappy_id, empresa_texto, encerramento, nota_avaliacao AS nota_cliente,
              revisao_nota_status, revisao_nota_por, revisao_nota_em,
              revisao_nota_override_analista_id AS nota_override_analista_id,
              analista, analista_id, analista_anterior, analista_anterior_id, transferencia, aceite,
              abandono_calculado_em
         FROM cs_tickets WHERE zappy_id = $1`,
      [zappyId]
    );
    if (!ticketRows.length) return res.status(404).json({ error: 'Ticket #' + zappyId + ' não encontrado.' });
    const ticket = ticketRows[0];

    const { rows: pontos } = await pool.query(
      `SELECT p.papel, p.analista, p.ajuste_velocidade, p.ajuste_aceite, p.ajuste_finalizar, p.nota_final,
              vr.status AS vel_status, vr.revisado_por AS vel_por, vr.revisado_em AS vel_em, vr.override_analista_id AS vel_override_analista_id,
              ar.status AS aceite_status, ar.revisado_por AS aceite_por, ar.revisado_em AS aceite_em, ar.override_analista_id AS aceite_override_analista_id,
              fr.status AS finalizar_status, fr.revisado_por AS finalizar_por, fr.revisado_em AS finalizar_em, fr.override_analista_id AS finalizar_override_analista_id
         FROM gam_tickets_pontos p
         LEFT JOIN gam_velocidade_revisoes vr ON vr.ticket_id = p.ticket_id AND vr.papel = p.papel
         LEFT JOIN gam_aceite_revisoes ar ON ar.ticket_id = p.ticket_id AND ar.papel = p.papel
         LEFT JOIN gam_finalizar_revisoes fr ON fr.ticket_id = p.ticket_id AND fr.papel = p.papel
        WHERE p.ticket_id = $1 AND p.mes = $2
        ORDER BY p.papel`,
      [ticket.id, mes]
    );

    // Abandono não depende de nota do cliente nem de mês bater com
    // gam_tickets_pontos — busca livre por ticket_id, filtrando pelo mesmo
    // "mes" só pra manter o mesmo escopo das outras revisões na tela.
    await ensureAbandonoSchema(pool);
    const { rows: abandono } = await pool.query(
      `SELECT id, data, analista, ultima_mensagem_cliente, ultima_mensagem_texto,
              status AS abandono_status, revisado_por AS abandono_por, revisado_em AS abandono_em,
              override_analista_id AS abandono_override_analista_id
         FROM gam_abandono_incidentes
        WHERE ticket_id = $1 AND mes = $2
        ORDER BY data ASC`,
      [ticket.id, mes]
    );

    res.json({ ticket, pontos, abandono });
  } catch (err) {
    console.error('[gam] ticket-busca falhou:', err);
    res.status(500).json({ error: 'Erro ao buscar ticket.' });
  }
});

// ── Mapeamento de checklist por regime + tipo ─────────────────────────────────
const CHECKLIST_MAP = {
  'Baixa de empresa': {
    'Simples Nacional':  ['Balanço','DRE','DEFIS','REINF'],
    'Lucro Presumido':   ['Balanço','DRE','ECD Baixa','ECF Baixa','DEFIS','REINF'],
    'Lucro Real':        ['Balanço','DRE','ECD Baixa','ECF Baixa','DEFIS','REINF'],
  },
  'Saída de empresa': {
    'Simples Nacional':  ['Balanço','DRE','REINF'],
    'Lucro Presumido':   ['Balanço','DRE','ECD','REINF'],
    'Lucro Real':        ['Balanço','DRE','ECD','REINF'],
  },
};

function buildChecklist(tipo, regime) {
  const itens = (CHECKLIST_MAP[tipo] || {})[regime] || [];
  return itens.map(item => ({ item, ok: false, por: null, em: null }));
}

async function ensureTicketTables() {
  await pool.query(`CREATE TABLE IF NOT EXISTS tickets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    gestao_id UUID, empresa TEXT NOT NULL, cnpj TEXT NOT NULL,
    regime TEXT NOT NULL, tipo_movimentacao TEXT NOT NULL,
    checklist JSONB NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'nova',
    observacoes TEXT, criado_por TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
  )`).catch(()=>{});
  await pool.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS dados_gestao JSONB DEFAULT '{}'`).catch(()=>{});
  await pool.query(`CREATE TABLE IF NOT EXISTS ticket_interacoes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    autor_id TEXT, autor_nome TEXT NOT NULL, comentario TEXT NOT NULL,
    is_automatica BOOLEAN DEFAULT false, created_at TIMESTAMPTZ DEFAULT NOW()
  )`).catch(()=>{});
  await pool.query(`CREATE TABLE IF NOT EXISTS ticket_mencoes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    usuario_id TEXT NOT NULL, UNIQUE(ticket_id, usuario_id)
  )`).catch(()=>{});
}

// ── TICKETS — rotas admin ─────────────────────────────────────────────────────

// Listar tickets (admin vê todos, contábil vê só os mencionados)
router.get('/tickets', requireAuth, async (req, res) => {
  try {
    await ensureTicketTables();
    const isAdmin = req.user.role === 'administrador';
    let rows;
    if (isAdmin) {
      const r = await pool.query(`
        SELECT t.*,
          EXTRACT(DAY FROM NOW() - t.created_at)::int AS dias,
          COALESCE(json_agg(DISTINCT jsonb_build_object('id', u.id, 'nome', u.name))
            FILTER (WHERE u.id IS NOT NULL), '[]') AS mencoes
        FROM tickets t
        LEFT JOIN ticket_mencoes tm ON tm.ticket_id = t.id
        LEFT JOIN users u ON u.id = tm.usuario_id
        GROUP BY t.id ORDER BY t.created_at DESC
      `);
      rows = r.rows;
    } else {
      const r = await pool.query(`
        SELECT t.*,
          EXTRACT(DAY FROM NOW() - t.created_at)::int AS dias,
          COALESCE(json_agg(DISTINCT jsonb_build_object('id', u.id, 'nome', u.name))
            FILTER (WHERE u.id IS NOT NULL), '[]') AS mencoes
        FROM tickets t
        JOIN ticket_mencoes tm2 ON tm2.ticket_id = t.id AND tm2.usuario_id = $1
        LEFT JOIN ticket_mencoes tm ON tm.ticket_id = t.id
        LEFT JOIN users u ON u.id = tm.usuario_id
        GROUP BY t.id ORDER BY t.created_at DESC
      `, [req.user.id]);
      rows = r.rows;
    }
    res.json({ data: rows });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro ao listar tickets.' }); }
});

/**
 * Cria o ticket + menciona quem deve ver (pedido do Reysner, 22/09/2026): sempre os administradores, mais os
 * Contábeis marcados em Administração de Usuários pra atender aquele REGIME (campo `regimes_atendidos` do
 * usuário — Simples Nacional / Lucro Presumido / Lucro Real). Ninguém marcado pro regime do cliente (ou regime
 * fora dessas 3 opções, ex. MEI) → menciona todos os Contábeis ativos, pra nunca perder o aviso. Cada mencionado
 * já enxerga o ticket no Portal Contábil (link público /contabil.html) e recebe o sininho — é o MESMO mecanismo
 * do botão manual "Abrir Ticket", só que disparado sozinho.
 */
async function criarTicketInterno({ gestaoId, empresa, cnpj, regime, tipoMovimentacao, observacoes, mencoesExtra, dadosGestao, criadoPor }) {
  await ensureTicketTables();
  const checklist = buildChecklist(tipoMovimentacao, regime);
  const { rows } = await pool.query(
    `INSERT INTO tickets (gestao_id, empresa, cnpj, regime, tipo_movimentacao, checklist, observacoes, criado_por, dados_gestao)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [gestaoId || null, empresa, cnpj, regime || null, tipoMovimentacao, JSON.stringify(checklist), observacoes || null, criadoPor, JSON.stringify(dadosGestao || {})]
  );
  const ticket = rows[0];
  const adminsRes = await pool.query(`SELECT id FROM users WHERE role='administrador' AND active=1`);
  let responsaveis = [];
  if (regime) {
    const porRegime = await pool.query(
      `SELECT id FROM users WHERE role='contabil' AND active=1 AND regimes_atendidos @> $1::jsonb`,
      [JSON.stringify([regime])]
    ).catch(() => ({ rows: [] }));
    responsaveis = porRegime.rows.map(r => r.id.toString());
  }
  if (!responsaveis.length) {
    const todosContabeis = await pool.query(`SELECT id FROM users WHERE role='contabil' AND active=1`);
    responsaveis = todosContabeis.rows.map(r => r.id.toString());
  }
  const adminIds = adminsRes.rows.map(r => r.id.toString());
  const todasMencoes = [...new Set([...(mencoesExtra || []), ...responsaveis, ...adminIds])];

  for (const uid of todasMencoes) {
    await pool.query(`INSERT INTO ticket_mencoes (ticket_id, usuario_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [ticket.id, uid]);
    await pool.query(
      `INSERT INTO notificacoes (user_id, tipo, mensagem, referencia_id)
       VALUES ($1,'ticket','Novo ticket aberto: '||$2,$3)`,
      [uid, empresa, ticket.id]
    ).catch(()=>{});
  }
  if (observacoes) {
    await pool.query(
      `INSERT INTO ticket_interacoes (ticket_id, autor_nome, comentario) VALUES ($1,$2,$3)`,
      [ticket.id, criadoPor, observacoes]
    );
  }
  return ticket;
}

// Criar ticket
router.post('/tickets', requireAdmin, async (req, res) => {
  try {
    const { gestao_id, empresa, cnpj, regime, tipo_movimentacao, observacoes, mencoes, dados_gestao } = req.body;
    if (!empresa || !cnpj || !regime || !tipo_movimentacao)
      return res.status(400).json({ error: 'Campos obrigatórios ausentes.' });
    const ticket = await criarTicketInterno({
      gestaoId: gestao_id, empresa, cnpj, regime, tipoMovimentacao: tipo_movimentacao,
      observacoes, mencoesExtra: mencoes, dadosGestao: dados_gestao, criadoPor: req.user.name,
    });
    res.status(201).json({ ok: true, data: ticket });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro ao criar ticket.' }); }
});

// Buscar ticket + interações
router.get('/tickets/:id', requireAuth, async (req, res) => {
  try {
    const t = await pool.query(`
      SELECT t.*,
        EXTRACT(DAY FROM NOW() - t.created_at)::int AS dias,
        COALESCE(json_agg(DISTINCT jsonb_build_object('id', u.id, 'nome', u.name))
          FILTER (WHERE u.id IS NOT NULL), '[]') AS mencoes
      FROM tickets t
      LEFT JOIN ticket_mencoes tm ON tm.ticket_id = t.id
      LEFT JOIN users u ON u.id = tm.usuario_id
      WHERE t.id = $1 GROUP BY t.id
    `, [req.params.id]);
    if (!t.rows.length) return res.status(404).json({ error: 'Ticket não encontrado.' });
    const interacoes = await pool.query(
      `SELECT * FROM ticket_interacoes WHERE ticket_id = $1 ORDER BY created_at ASC`,
      [req.params.id]
    );
    res.json({ data: { ...t.rows[0], interacoes: interacoes.rows } });
  } catch (err) { res.status(500).json({ error: 'Erro ao buscar ticket.' }); }
});

// Adicionar interação + mudar status para resolvendo
router.post('/tickets/:id/interacoes', requireAuth, async (req, res) => {
  try {
    const { comentario, mencoes_novas } = req.body;
    const temComentario = comentario && comentario.trim();
    const temMencao = mencoes_novas && mencoes_novas.length;
    if (!temComentario && !temMencao) return res.status(400).json({ error: 'Informe um comentário ou uma menção.' });
    // Muda status para resolvendo se era nova
    const t = await pool.query(`SELECT * FROM tickets WHERE id = $1`, [req.params.id]);
    if (!t.rows.length) return res.status(404).json({ error: 'Ticket não encontrado.' });
    const ticket = t.rows[0];
    if (ticket.status === 'nova') {
      await pool.query(`UPDATE tickets SET status='resolvendo', updated_at=NOW() WHERE id=$1`, [req.params.id]);
      // Notifica admins
      const admins = await pool.query(`SELECT id FROM users WHERE role='administrador' AND active=1`);
      for (const a of admins.rows) {
        await pool.query(
          `INSERT INTO notificacoes (user_id, tipo, mensagem, referencia_id) VALUES ($1,'ticket',$2,$3)`,
          [a.id, `Ticket "${ticket.empresa}" está sendo resolvido`, req.params.id]
        ).catch(()=>{});
      }
    }
    // Adiciona novas menções se houver
    if (mencoes_novas && mencoes_novas.length) {
      for (const uid of mencoes_novas) {
        await pool.query(`INSERT INTO ticket_mencoes (ticket_id, usuario_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [req.params.id, uid]);
        await pool.query(
          `INSERT INTO notificacoes (user_id, tipo, mensagem, referencia_id) VALUES ($1,'ticket',$2,$3)`,
          [uid, `Você foi mencionado no ticket "${ticket.empresa}"`, req.params.id]
        ).catch(()=>{});
      }
    }
    let novaInteracao = null;
    if (temComentario) {
      const { rows } = await pool.query(
        `INSERT INTO ticket_interacoes (ticket_id, autor_id, autor_nome, comentario) VALUES ($1,$2,$3,$4) RETURNING *`,
        [req.params.id, req.user.id, req.user.name, comentario.trim()]
      );
      novaInteracao = rows[0];
    }
    res.status(201).json({ ok: true, data: novaInteracao });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro ao adicionar interação.' }); }
});

// Marcar item do checklist
router.patch('/tickets/:id/checklist', requireAuth, async (req, res) => {
  try {
    const { item_index } = req.body;
    const t = await pool.query(`SELECT * FROM tickets WHERE id=$1`, [req.params.id]);
    if (!t.rows.length) return res.status(404).json({ error: 'Não encontrado.' });
    const ticket = t.rows[0];
    // Verifica permissão: admin ou mencionado
    const isAdmin = req.user.role === 'administrador';
    if (!isAdmin) {
      const m = await pool.query(`SELECT id FROM ticket_mencoes WHERE ticket_id=$1 AND usuario_id=$2`, [req.params.id, req.user.id]);
      if (!m.rows.length) return res.status(403).json({ error: 'Sem permissão.' });
    }
    const checklist = ticket.checklist;
    if (item_index < 0 || item_index >= checklist.length)
      return res.status(400).json({ error: 'Item inválido.' });
    checklist[item_index].ok  = !checklist[item_index].ok;
    checklist[item_index].por = checklist[item_index].ok ? req.user.name : null;
    checklist[item_index].em  = checklist[item_index].ok ? new Date().toISOString() : null;
    await pool.query(`UPDATE tickets SET checklist=$1, updated_at=NOW() WHERE id=$2`, [JSON.stringify(checklist), req.params.id]);
    // Se o ticket estava "nova" e um item foi marcado, muda para "resolvendo"
    if (ticket.status === 'nova' && checklist[item_index].ok) {
      await pool.query(`UPDATE tickets SET status='resolvendo', updated_at=NOW() WHERE id=$1`, [req.params.id]);
      const adminsNotif = await pool.query(`SELECT id FROM users WHERE role='administrador' AND active=1`);
      for (const a of adminsNotif.rows) {
        await pool.query(
          `INSERT INTO notificacoes (user_id, tipo, mensagem, referencia_id) VALUES ($1,'ticket',$2,$3)`,
          [a.id, `Ticket "${ticket.empresa}" está sendo resolvido`, req.params.id]
        ).catch(()=>{});
      }
    }
    // Verifica se todos marcados
    const todosOk = checklist.every(c => c.ok);
    if (todosOk) {
      // A mensagem "Documentos direcionados..." NÃO é mais gravada no histórico;
      // ela aparece apenas junto do botão "Finalizar ticket" no portal.
      // Notifica admins
      const admins = await pool.query(`SELECT id FROM users WHERE role='administrador' AND active=1`);
      for (const a of admins.rows) {
        await pool.query(
          `INSERT INTO notificacoes (user_id, tipo, mensagem, referencia_id) VALUES ($1,'ticket',$2,$3)`,
          [a.id, `✅ Checklist completo — ticket "${ticket.empresa}" pronto para encerrar`, req.params.id]
        ).catch(()=>{});
      }
    }
    res.json({ ok: true, checklist, todosOk });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro ao marcar item.' }); }
});

// Finalizar ticket (contábil ou admin) — só permite se o checklist estiver 100% completo
router.patch('/tickets/:id/finalizar', requireAuth, async (req, res) => {
  try {
    const t = await pool.query(`SELECT * FROM tickets WHERE id = $1`, [req.params.id]);
    if (!t.rows.length) return res.status(404).json({ error: 'Ticket não encontrado.' });
    const ticket = t.rows[0];
    // Se não for admin, precisa ser um usuário mencionado no ticket
    if (req.user.role !== 'administrador') {
      const m = await pool.query(`SELECT id FROM ticket_mencoes WHERE ticket_id = $1 AND usuario_id = $2`, [req.params.id, req.user.id]);
      if (!m.rows.length) return res.status(403).json({ error: 'Sem permissão para finalizar este ticket.' });
    }
    const checklist = ticket.checklist || [];
    const completo = checklist.length > 0 && checklist.every(c => c.ok);
    if (!completo) return res.status(400).json({ error: 'O checklist precisa estar completo para finalizar.' });
    await pool.query(`UPDATE tickets SET status = 'encerrada', updated_at = NOW() WHERE id = $1`, [req.params.id]);
    // Registra interação de finalização e notifica admins
    await pool.query(
      `INSERT INTO ticket_interacoes (ticket_id, autor_nome, comentario, is_automatica) VALUES ($1,$2,$3,true)`,
      [req.params.id, req.user.name, `Ticket finalizado por ${req.user.name} — checklist completo.`]
    ).catch(()=>{});
    const admins = await pool.query(`SELECT id FROM users WHERE role='administrador' AND active=1`);
    for (const a of admins.rows) {
      await pool.query(
        `INSERT INTO notificacoes (user_id, tipo, mensagem, referencia_id) VALUES ($1,'ticket',$2,$3)`,
        [a.id, `Ticket "${ticket.empresa}" foi finalizado`, req.params.id]
      ).catch(()=>{});
    }
    res.json({ ok: true });
  } catch (err) { console.error('Finalizar ticket error:', err); res.status(500).json({ error: 'Erro ao finalizar ticket.' }); }
});

// Encerrar / Reabrir ticket (admin only)
router.patch('/tickets/:id/status', requireAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    if (!['encerrada','resolvendo'].includes(status)) return res.status(400).json({ error: 'Status inválido.' });
    await pool.query(`UPDATE tickets SET status=$1, updated_at=NOW() WHERE id=$2`, [status, req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Erro ao atualizar status.' }); }
});

// Limpar TODOS os tickets (admin only) — cascata remove interações e menções
router.delete('/tickets/clear', requireAdmin, async (req, res) => {
  try {
    await pool.query(`DELETE FROM tickets`);
    res.json({ ok: true });
  } catch (err) { console.error('Clear tickets error:', err); res.status(500).json({ error: 'Erro ao limpar tickets.' }); }
});

// Excluir ticket (admin only) — a cascata remove interações e menções junto
router.delete('/tickets/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query(`DELETE FROM tickets WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) { console.error('Delete ticket error:', err); res.status(500).json({ error: 'Erro ao excluir ticket.' }); }
});

// Listar usuários contábil+admin para mencionar
router.get('/tickets-usuarios', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, role FROM users WHERE role = 'contabil' AND active=1 ORDER BY name ASC`
    );
    res.json({ data: rows });
  } catch (err) { res.status(500).json({ error: 'Erro ao listar usuários.' }); }
});

// ── ANÁLISE INTELIGENTE (sem custo — por palavras-chave, não usa IA paga) ──────
// Mesma lógica já usada no motor de SLA pra detectar "vou transferir": lista
// de palavras normalizada (sem acento, minúsculo) e contagem de ocorrências.
// Não manda nenhum dado pra fora do sistema.

function normalizarTexto(txt) {
  return (txt || '')
    .toString()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

const PALAVRAS_POSITIVAS = [
  'otimo', 'excelente', 'muito bom', 'adorei', 'satisfeito', 'satisfeita', 'recomendo',
  'rapido', 'rapida', 'eficiente', 'atencioso', 'atenciosa', 'prestativo', 'prestativa',
  'parabens', 'maravilhoso', 'maravilhosa', 'confio', 'confianca', 'resolveu', 'resolvido',
  'agil', 'competente', 'educado', 'educada', 'gentil', 'superou', 'impecavel', 'nota 10',
];
const PALAVRAS_NEGATIVAS = [
  'ruim', 'pessimo', 'pessima', 'demorou', 'demora', 'lento', 'lenta', 'insatisfeito',
  'insatisfeita', 'nao resolveu', 'sem retorno', 'sem resposta', 'descaso',
  'falta de atencao', 'desorganizado', 'desorganizada', 'erro', 'nao resolvido',
  'frustrado', 'frustrada', 'decepcionado', 'decepcionada', 'cancelar', 'trocar de contador',
  'despreparado', 'despreparada', 'grosseiro', 'grosseira', 'mal atendido', 'mal atendida',
  'nunca mais', 'absurdo', 'inaceitavel', 'pior atendimento',
];

function analisarSentimento(texto) {
  const t = normalizarTexto(texto);
  if (!t) return 'sem_comentario';
  let pos = 0, neg = 0;
  PALAVRAS_POSITIVAS.forEach(p => { if (t.includes(p)) pos++; });
  PALAVRAS_NEGATIVAS.forEach(p => { if (t.includes(p)) neg++; });
  if (pos === 0 && neg === 0) return 'neutro';
  return pos > neg ? 'positivo' : (neg > pos ? 'negativo' : 'neutro');
}

// GET /api/data/sentimento — classifica os comentários das pesquisas (sem custo, sem IA paga)
router.get('/sentimento', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, cliente, empresa, nps, csat, ces, pontos, created_at
       FROM pesquisas WHERE pontos IS NOT NULL AND pontos != ''
       ORDER BY created_at DESC LIMIT 500`
    );
    const comentarios = rows.map(r => ({ ...r, sentimento: analisarSentimento(r.pontos) }));
    const resumo = { positivo: 0, neutro: 0, negativo: 0, sem_comentario: 0 };
    comentarios.forEach(c => { resumo[c.sentimento] = (resumo[c.sentimento] || 0) + 1; });
    res.json({ resumo, comentarios: comentarios.slice(0, 100) });
  } catch (err) {
    console.error('Sentimento error:', err);
    res.status(500).json({ error: 'Erro ao analisar sentimento.' });
  }
});

// GET /api/data/churn — risco de cancelamento por cliente ativo, com base em
// dados que já existem no sistema (sem IA paga, sem dado saindo do sistema).
router.get('/churn', requireAdmin, async (req, res) => {
  try {
    const [clientesR, honorariosR, pesquisasR, insatisfacoesR, sensiveisR, recuperacoesR] = await Promise.all([
      pool.query(`SELECT id, cnpj, nome_empresa, codigo, regime_tributario FROM clientes WHERE status = 'ativo'`),
      pool.query(`SELECT cliente_id, MAX(data_vigencia) as ultimo FROM honorarios GROUP BY cliente_id`),
      pool.query(`SELECT cnpj, nps, csat, ces, pontos, created_at FROM pesquisas ORDER BY created_at DESC`),
      pool.query(`SELECT cnpj, gravidade, created_at FROM insatisfacoes WHERE created_at >= NOW() - INTERVAL '90 days'`),
      pool.query(`SELECT cnpj, created_at FROM clientes_sensiveis WHERE created_at >= NOW() - INTERVAL '90 days'`),
      pool.query(`SELECT cnpj, created_at FROM recuperacoes WHERE created_at >= NOW() - INTERVAL '180 days'`),
    ]);

    const honPorCliente = new Map(honorariosR.rows.map(h => [h.cliente_id, h.ultimo]));

    const pesqPorCnpj = new Map();
    pesquisasR.rows.forEach(p => {
      if (!pesqPorCnpj.has(p.cnpj)) pesqPorCnpj.set(p.cnpj, []);
      const arr = pesqPorCnpj.get(p.cnpj);
      if (arr.length < 3) arr.push(p);
    });

    const insPorCnpj = new Map();
    insatisfacoesR.rows.forEach(i => {
      if (!insPorCnpj.has(i.cnpj)) insPorCnpj.set(i.cnpj, []);
      insPorCnpj.get(i.cnpj).push(i);
    });

    const sensPorCnpj = new Map();
    sensiveisR.rows.forEach(s => sensPorCnpj.set(s.cnpj, (sensPorCnpj.get(s.cnpj) || 0) + 1));

    const recPorCnpj = new Map();
    recuperacoesR.rows.forEach(r => recPorCnpj.set(r.cnpj, (recPorCnpj.get(r.cnpj) || 0) + 1));

    const hoje = new Date();
    const resultado = clientesR.rows.map(c => {
      let score = 0;
      const motivos = [];

      const pesq = pesqPorCnpj.get(c.cnpj) || [];
      if (pesq.length) {
        const ultima = pesq[0];
        if (ultima.nps != null) {
          if (ultima.nps <= 6) { score += 30; motivos.push('NPS baixo (detrator) na última pesquisa'); }
          else if (ultima.nps <= 8) { score += 10; motivos.push('NPS neutro na última pesquisa'); }
        }
        if (ultima.csat != null && ultima.csat <= 2) { score += 15; motivos.push('CSAT baixo na última pesquisa'); }
        const sentimentos = pesq.map(p => analisarSentimento(p.pontos));
        const neg = sentimentos.filter(s => s === 'negativo').length;
        const pos = sentimentos.filter(s => s === 'positivo').length;
        if (neg > pos && neg > 0) { score += 15; motivos.push('Comentários recentes de tom negativo'); }
      }

      const ins = insPorCnpj.get(c.cnpj) || [];
      if (ins.length) {
        const alta = ins.some(i => (i.gravidade || '').toLowerCase().includes('alta'));
        score += alta ? 25 : 15;
        motivos.push(`${ins.length} insatisfação(ões) nos últimos 90 dias${alta ? ' (gravidade alta)' : ''}`);
      }

      if (sensPorCnpj.get(c.cnpj)) { score += 20; motivos.push('Sinalizado como cliente sensível recentemente'); }
      if (recPorCnpj.get(c.cnpj)) { score += 15; motivos.push('Já passou por ação de recuperação recente'); }

      const ultimoReajuste = honPorCliente.get(c.id);
      if (ultimoReajuste) {
        const meses = (hoje - new Date(ultimoReajuste)) / (1000 * 60 * 60 * 24 * 30);
        if (meses >= 24) { score += 10; motivos.push('Sem reajuste de honorário há 24+ meses'); }
      }

      score = Math.min(score, 100);
      const nivel = score >= 60 ? 'vermelho' : score >= 30 ? 'amarelo' : 'verde';
      return { id: c.id, cnpj: c.cnpj, empresa: c.nome_empresa, codigo: c.codigo, regime_tributario: c.regime_tributario, score, nivel, motivos };
    });

    // Pedido do Reysner: ordem alfabética por empresa (antes era por score,
    // maior risco primeiro).
    resultado.sort((a, b) => (a.empresa || '').localeCompare(b.empresa || '', 'pt-BR'));
    res.json({ data: resultado });
  } catch (err) {
    console.error('Churn error:', err);
    res.status(500).json({ error: 'Erro ao calcular risco de churn.' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ── LEGALIZAÇÃO ──────────────────────────────────────────────────────────────
// Módulo novo (pedido do Reysner, 17/09/2026): acompanha vencimento de
// Alvarás (Funcionamento e Sanitário) e Certificados Digitais (PJ e PF).
//
// v2 (17/09/2026, mesmo dia): a lista de Alvará-Funcionamento e Certificado-
// PJ NÃO parte de um cadastro manual — vem direto de `clientes` (Carteira),
// uma linha por empresa ATIVA, sempre, com ou sem data ainda ("linha
// virtual" até alguém preencher algo ou rodar "Consultar Prefeitura" —
// nesse momento vira um registro de verdade via UPSERT). Sanitário e
// Certificado PF continuam precisando de uma ação manual (nem toda empresa
// tem Sanitário — não dá pra saber por CNAE, API do Acessórias não tem
// esse campo; PF é pessoa avulsa, não é 1-pra-1 com a Carteira).
//
// Vencimento continua SEM fonte automática nenhuma (nem Acessórias, nem o
// portal da prefeitura, nem CertiSeguro sem doc ainda) — isso é sempre
// preenchido à mão. O campo `fonte` fica pronto ('manual' por padrão) pra
// quando a CERTISEGURO mandar a doc da API.
//
// "Vencendo" = pedido do Reysner, 17/09/2026: 60 dias pra Alvará
// (Funcionamento/Sanitário), 10 dias pra Certificado Digital — prazos
// diferentes porque um certificado se renova rápido, um alvará não.
// ═══════════════════════════════════════════════════════════════════════════

const LEGAL_DIAS_ALERTA_ALVARA = 60;
const LEGAL_DIAS_ALERTA_CERTIFICADO = 10;

// Diagnóstico rodado em 17/09/2026 (removido depois de confirmar): a API do
// Acessórias (endpoint único e ListAll com registrationData) NÃO tem CNAE em
// nenhuma resposta — campos disponíveis são só ID, Identificador, Razao,
// Fantasia, Status, Telefone, UF, ClienteDesde, ClienteAte, DataDoCadastro,
// Honorario, DtLastDH, Regime, GrupoDeEmpresas. Por isso "Alvará Sanitário
// exigível" não dá pra automatizar por CNAE — mas isso não precisa de campo
// nenhum: como cada alvará é um registro que o admin cria manualmente, só
// não se cria o registro de Sanitário pra quem não precisa (ex.: prestador
// de serviço sem contato com alimento/saúde). O CRUD já resolve isso sozinho.

async function ensureLegalizacaoSchema() {
  await garantirColunasMunicipio(); // painel e consulta de alvarás leem clientes.municipio*
  await pool.query(`CREATE TABLE IF NOT EXISTS legalizacao_alvaras (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cliente_id TEXT NOT NULL,
    tipo TEXT NOT NULL CHECK (tipo IN ('funcionamento','sanitario')),
    orgao TEXT,
    link TEXT,
    numero TEXT,
    data_vencimento DATE,
    observacoes TEXT,
    fonte TEXT NOT NULL DEFAULT 'manual',
    criado_por TEXT,
    criado_em TIMESTAMPTZ DEFAULT NOW(),
    atualizado_em TIMESTAMPTZ DEFAULT NOW()
  )`).catch(()=>{});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_legal_alvaras_cliente ON legalizacao_alvaras (cliente_id)`).catch(()=>{});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_legal_alvaras_vencimento ON legalizacao_alvaras (data_vencimento)`).catch(()=>{});
  // Resultado da última consulta automática ao portal da prefeitura (hoje só
  // Uberlândia-MG/Ciclo7 — ver server/legalizacao/ciclo7Uberlandia.js).
  // Pedido do Reysner, 17/09/2026: o alvará mostra 3 estados — "Vencido"
  // (passou da data e NÃO tem solicitação de renovação em andamento),
  // "A vencer" (dentro do prazo) e "Solicitação" (tem protocolo de
  // renovação em andamento na prefeitura — esse estado tem PRIORIDADE sobre
  // os outros dois, já que uma renovação em curso é mais relevante que só
  // saber se venceu). Clicar em qualquer um mostra o detalhe (data de
  // vencimento, ou o andamento por secretaria).
  await pool.query(`ALTER TABLE legalizacao_alvaras ADD COLUMN IF NOT EXISTS ultima_consulta_status TEXT`).catch(()=>{});
  await pool.query(`ALTER TABLE legalizacao_alvaras ADD COLUMN IF NOT EXISTS ultima_consulta_resumo TEXT`).catch(()=>{});
  await pool.query(`ALTER TABLE legalizacao_alvaras ADD COLUMN IF NOT EXISTS ultima_consulta_data_solicitacao TEXT`).catch(()=>{});
  await pool.query(`ALTER TABLE legalizacao_alvaras ADD COLUMN IF NOT EXISTS ultima_consulta_em TIMESTAMPTZ`).catch(()=>{});
  // Um alvará por (cliente, tipo) — pedido do Reysner, 17/09/2026: a lista
  // agora traz TODO cliente ativo automaticamente (Funcionamento é
  // universal), então grava/edita por UPSERT em vez de escolher empresa
  // toda vez num formulário. Ver PUT /legalizacao/alvaras/:clienteId/:tipo.
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_legal_alvaras_cliente_tipo ON legalizacao_alvaras (cliente_id, tipo)`).catch(()=>{});
  // Pedido do Reysner, 17/09/2026: notificação (sininho) quando entra na
  // janela de "vencendo" — 60 dias pra alvará. Guarda quando já notificou
  // PRA ESSA data específica; muda a data (renovou) e o campo volta a NULL
  // sozinho (ver PUT .../:clienteId/:tipo acima), pra poder notificar nessa
  // próxima renovação também, sem spam repetido enquanto a data não muda.
  await pool.query(`ALTER TABLE legalizacao_alvaras ADD COLUMN IF NOT EXISTS notificado_vencimento_em TIMESTAMPTZ`).catch(()=>{});
  await pool.query(`ALTER TABLE legalizacao_alvaras ADD COLUMN IF NOT EXISTS desativado_em TIMESTAMPTZ`).catch(()=>{});
  // Fila de conferência: datas lidas por OCR do PDF da pasta ficam "a conferir" até alguém confirmar/corrigir.
  await pool.query(`ALTER TABLE legalizacao_alvaras ADD COLUMN IF NOT EXISTS lido_por_ocr BOOLEAN NOT NULL DEFAULT false`).catch(()=>{});
  await pool.query(`ALTER TABLE legalizacao_alvaras ADD COLUMN IF NOT EXISTS origem_arquivo TEXT`).catch(()=>{});
  await pool.query(`ALTER TABLE legalizacao_alvaras ADD COLUMN IF NOT EXISTS trecho_lido TEXT`).catch(()=>{});
  await pool.query(`ALTER TABLE legalizacao_alvaras ADD COLUMN IF NOT EXISTS conferido_em TIMESTAMPTZ`).catch(()=>{});
  await pool.query(`ALTER TABLE legalizacao_alvaras ADD COLUMN IF NOT EXISTS conferido_por TEXT`).catch(()=>{});
  // Saúde das consultas: cada rotina do escritório (consulta às prefeituras, leitura das pastas) registra aqui como foi a rodada.
  await pool.query(`CREATE TABLE IF NOT EXISTS legalizacao_rotinas (
    id SERIAL PRIMARY KEY,
    rotina TEXT NOT NULL,
    inicio TIMESTAMPTZ,
    fim TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    total INT NOT NULL DEFAULT 0,
    ok INT NOT NULL DEFAULT 0,
    falhas INT NOT NULL DEFAULT 0,
    resumo JSONB,
    por_cidade JSONB
  )`).catch(()=>{});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_legal_rotinas_rotina_fim ON legalizacao_rotinas (rotina, fim DESC)`).catch(()=>{});
  // Uma vez só (origem_arquivo ainda nula): marca como "a conferir" o que já foi gravado por OCR antes desta fila existir.
  await pool.query(`UPDATE legalizacao_alvaras
       SET lido_por_ocr = true, origem_arquivo = COALESCE(substring(ultima_consulta_resumo from 'servidor: (.*) \\(vence'), 'PDF da pasta')
     WHERE lido_por_ocr = false AND origem_arquivo IS NULL AND conferido_em IS NULL
       AND data_vencimento IS NOT NULL AND ultima_consulta_resumo LIKE '%lido por OCR%'`).catch(()=>{});
  await pool.query(`CREATE TABLE IF NOT EXISTS legalizacao_redesim (
    cliente_id TEXT PRIMARY KEY,
    consultado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    dados JSONB,
    sem_licenciamento BOOLEAN NOT NULL DEFAULT false,
    nao_encontrado BOOLEAN NOT NULL DEFAULT false
  )`).catch(()=>{});

  await pool.query(`CREATE TABLE IF NOT EXISTS legalizacao_certificados (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cliente_id TEXT,
    tipo TEXT NOT NULL CHECK (tipo IN ('pj','pf')),
    titular_nome TEXT NOT NULL,
    titular_documento TEXT,
    data_vencimento DATE,
    observacoes TEXT,
    fonte TEXT NOT NULL DEFAULT 'manual',
    criado_por TEXT,
    criado_em TIMESTAMPTZ DEFAULT NOW(),
    atualizado_em TIMESTAMPTZ DEFAULT NOW()
  )`).catch(()=>{});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_legal_cert_cliente ON legalizacao_certificados (cliente_id)`).catch(()=>{});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_legal_cert_vencimento ON legalizacao_certificados (data_vencimento)`).catch(()=>{});
  // Um certificado PJ por cliente (índice parcial — PF fica de fora de
  // propósito: pode ter várias PF avulsas, ou nenhuma ligada a cliente
  // nenhum). Mesmo raciocínio do índice de alvarás acima.
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_legal_cert_cliente_pj ON legalizacao_certificados (cliente_id) WHERE tipo = 'pj' AND cliente_id IS NOT NULL`).catch(()=>{});
  // Mesmo esquema de notificação dos alvarás, mas 10 dias (ver LEGAL_DIAS_ALERTA_CERTIFICADO).
  await pool.query(`ALTER TABLE legalizacao_certificados ADD COLUMN IF NOT EXISTS notificado_vencimento_em TIMESTAMPTZ`).catch(()=>{});
  await pool.query(`ALTER TABLE legalizacao_certificados ADD COLUMN IF NOT EXISTS desativado_em TIMESTAMPTZ`).catch(()=>{});

  // Solicitação de inativação de cliente, feita pelo colaborador na página
  // pública de Legalização (pedido do Reysner, 18/09/2026): "ele poderá
  // inativar porém colocando a observação e aqui no módulo se realmente
  // estiver certo eu valido e excluo/desativo". Nunca desativa o cliente
  // sozinha — só registra o pedido com status 'pendente'; aprovar de
  // verdade encerra o cliente (mesma lógica de PATCH /clientes/:id/encerrar).
  await pool.query(`CREATE TABLE IF NOT EXISTS legalizacao_solicitacoes_inativacao (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cliente_id TEXT NOT NULL,
    nome_empresa TEXT,
    observacao TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','aprovada','rejeitada')),
    solicitado_por TEXT,
    solicitado_em TIMESTAMPTZ DEFAULT NOW(),
    decidido_por TEXT,
    decidido_em TIMESTAMPTZ,
    decisao_observacao TEXT
  )`).catch(()=>{});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_legal_solic_inativ_status ON legalizacao_solicitacoes_inativacao (status)`).catch(()=>{});
  // Motivo (lista de Motivos de Churn) separado da observação livre — pedido do Reysner, 18/09/2026.
  await pool.query(`ALTER TABLE legalizacao_solicitacoes_inativacao ADD COLUMN IF NOT EXISTS motivo TEXT`).catch(()=>{});
  // Sininho da página pública: o "lida" de notificacoes é global (vale pro admin também), então cada
  // usuário guarda só a hora em que viu o sininho pela última vez.
  await pool.query(`CREATE TABLE IF NOT EXISTS legalizacao_notif_visto (user_id TEXT PRIMARY KEY, visto_em TIMESTAMPTZ NOT NULL DEFAULT NOW())`).catch(()=>{});

  // Procuração ECAC e Procuração FGTS Digital — pedido do Reysner, 18/09/2026: novas colunas na mesma
  // lista de clientes (uma linha por empresa). Por ora só preenchimento manual da data; ele vai indicar
  // onde achar o vencimento pra automatizar depois (por isso `fonte`).
  await pool.query(`CREATE TABLE IF NOT EXISTS legalizacao_procuracoes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cliente_id TEXT NOT NULL,
    tipo TEXT NOT NULL CHECK (tipo IN ('ecac','fgts')),
    data_vencimento DATE,
    observacoes TEXT,
    fonte TEXT NOT NULL DEFAULT 'manual',
    criado_por TEXT,
    criado_em TIMESTAMPTZ DEFAULT NOW(),
    atualizado_em TIMESTAMPTZ DEFAULT NOW()
  )`).catch(()=>{});
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_legal_proc_cliente_tipo ON legalizacao_procuracoes (cliente_id, tipo)`).catch(()=>{});
  await pool.query(`ALTER TABLE legalizacao_procuracoes ADD COLUMN IF NOT EXISTS notificado_vencimento_em TIMESTAMPTZ`).catch(()=>{});
}

const LEGAL_DIAS_ALERTA_PROCURACAO = 5;

/**
 * CASE de status por coluna de data — mesmo critério em todo o módulo.
 * `prioridade` é um WHEN extra que vence sobre a data (ex.: alvará com
 * solicitação de renovação em andamento na prefeitura). Alvará tem prazo de
 * "vencendo" mais longo que certificado (60 x 10 dias — pedido do Reysner:
 * alvará demora bem mais pra renovar).
 */
const _legalStatusSql = (col, dias, prioridade = '') => `CASE ${prioridade}
  WHEN ${col} IS NULL THEN 'sem_data'
  WHEN ${col} < CURRENT_DATE THEN 'vencido'
  WHEN ${col} <= CURRENT_DATE + INTERVAL '${dias} days' THEN 'vencendo'
  ELSE 'ok'
END`;

/**
 * Painel ÚNICO de Legalização — pedido do Reysner, 18/09/2026: uma lista de
 * clientes só, com uma coluna por situação (Alvarás Funcionamento+Sanitário,
 * Certificado Digital, Procuração ECAC, Procuração FGTS Digital), em vez de
 * uma lista de empresas por assunto. A 1ª metade traz TODO cliente ativo
 * (LEFT JOIN — linha "virtual" até alguém preencher/consultar algo); a 2ª
 * traz o que não é cliente ativo mas está na CertiSeguro (PF avulso + CNPJ
 * que nunca existiu no Acessórias — sem_cadastro_acessorias=true). Cliente
 * INATIVO no Acessórias não entra. Sanitário só aparece pra quem tem
 * registro (nem toda empresa precisa).
 */
const LEGAL_PAINEL_SQL = `
SELECT x.cliente_id, x.nome_empresa, x.cnpj, x.codigo, x.sem_cadastro_acessorias,
  x.func_id, x.func_venc::text AS func_venc, x.func_numero, x.func_obs, x.func_cr, x.func_cd,
  ${_legalStatusSql('x.func_venc', LEGAL_DIAS_ALERTA_ALVARA, "WHEN x.func_cs = 'solicitacao_andamento' THEN 'solicitacao'")} AS func_status,
  x.sanit_id, x.sanit_venc::text AS sanit_venc, x.sanit_numero, x.sanit_obs, x.sanit_cr, x.sanit_cd,
  ${_legalStatusSql('x.sanit_venc', LEGAL_DIAS_ALERTA_ALVARA, "WHEN x.sanit_cs = 'solicitacao_andamento' THEN 'solicitacao'")} AS sanit_status,
  x.cert_id, x.cert_tipo, x.cert_venc::text AS cert_venc, x.cert_obs,
  ${_legalStatusSql('x.cert_venc', LEGAL_DIAS_ALERTA_CERTIFICADO)} AS cert_status,
  x.ecac_id, x.ecac_venc::text AS ecac_venc, x.ecac_obs,
  ${_legalStatusSql('x.ecac_venc', LEGAL_DIAS_ALERTA_PROCURACAO)} AS ecac_status,
  x.fgts_id, x.fgts_venc::text AS fgts_venc, x.fgts_obs, x.sanit_desat, x.cert_desat,
  ${_legalStatusSql('x.fgts_venc', LEGAL_DIAS_ALERTA_PROCURACAO)} AS fgts_status
FROM (
  SELECT c.id::text AS cliente_id, c.nome_empresa, c.cnpj, c.codigo, false AS sem_cadastro_acessorias,
         fa.id AS func_id, fa.data_vencimento AS func_venc, fa.numero AS func_numero, fa.observacoes AS func_obs,
         fa.ultima_consulta_status AS func_cs, fa.ultima_consulta_resumo AS func_cr, fa.ultima_consulta_data_solicitacao AS func_cd,
         sa.id AS sanit_id, sa.data_vencimento AS sanit_venc, sa.numero AS sanit_numero, sa.observacoes AS sanit_obs,
         sa.ultima_consulta_status AS sanit_cs, sa.ultima_consulta_resumo AS sanit_cr, sa.ultima_consulta_data_solicitacao AS sanit_cd,
         ce.id AS cert_id, ce.tipo AS cert_tipo, ce.data_vencimento AS cert_venc, ce.observacoes AS cert_obs,
         pe.id AS ecac_id, pe.data_vencimento AS ecac_venc, pe.observacoes AS ecac_obs,
         pg.id AS fgts_id, pg.data_vencimento AS fgts_venc, pg.observacoes AS fgts_obs,
         (sa.desativado_em IS NOT NULL) AS sanit_desat, (ce.desativado_em IS NOT NULL) AS cert_desat
    FROM clientes c
    LEFT JOIN legalizacao_alvaras fa ON fa.cliente_id = c.id::text AND fa.tipo = 'funcionamento'
    LEFT JOIN legalizacao_alvaras sa ON sa.cliente_id = c.id::text AND sa.tipo = 'sanitario'
    LEFT JOIN legalizacao_certificados ce ON ce.cliente_id = c.id::text AND ce.tipo = 'pj'
    LEFT JOIN legalizacao_procuracoes pe ON pe.cliente_id = c.id::text AND pe.tipo = 'ecac'
    LEFT JOIN legalizacao_procuracoes pg ON pg.cliente_id = c.id::text AND pg.tipo = 'fgts'
   WHERE c.status = 'ativo'
  UNION ALL
  SELECT ce.cliente_id, ce.titular_nome, ce.titular_documento, NULL, true,
         NULL, NULL, NULL, NULL, NULL, NULL, NULL,
         NULL, NULL, NULL, NULL, NULL, NULL, NULL,
         ce.id, ce.tipo, ce.data_vencimento, ce.observacoes,
         NULL, NULL, NULL,
         NULL, NULL, NULL,
         false, (ce.desativado_em IS NOT NULL)
    FROM legalizacao_certificados ce
   WHERE ce.tipo = 'pf'
      OR (ce.tipo = 'pj' AND NOT EXISTS (SELECT 1 FROM clientes c2 WHERE c2.id::text = ce.cliente_id))
) x
ORDER BY x.nome_empresa ASC`;

function legalPainelLinha(r) {
  const orfao = !!r.sem_cadastro_acessorias;
  const alvara = (p) => ({
    id: r[p + '_id'], vencimento: r[p + '_venc'], numero: r[p + '_numero'], observacoes: r[p + '_obs'],
    consulta_resumo: r[p + '_cr'], consulta_data_solicitacao: r[p + '_cd'],
    desativado: !!r[p + '_desat'], status: r[p + '_desat'] ? 'desativado' : r[p + '_status'],
  });
  const procuracao = (p) => ({ id: r[p + '_id'], vencimento: r[p + '_venc'], observacoes: r[p + '_obs'], status: r[p + '_status'] });
  return {
    cliente_id: orfao ? null : r.cliente_id,
    nome_empresa: r.nome_empresa, cnpj: r.cnpj, codigo: r.codigo, sem_cadastro_acessorias: orfao,
    func: orfao ? null : alvara('func'),
    sanit: r.sanit_id ? alvara('sanit') : null,
    cert: { id: r.cert_id, tipo: r.cert_tipo || 'pj', vencimento: r.cert_venc, observacoes: r.cert_obs, desativado: !!r.cert_desat, status: r.cert_desat ? 'desativado' : r.cert_status },
    ecac: orfao ? null : procuracao('ecac'),
    fgts: orfao ? null : procuracao('fgts'),
  };
}

/**
 * GET /api/data/legalizacao/painel — a lista inteira volta de uma vez e o
 * front pagina/filtra localmente (mesmo padrão de Carteira/Recuperação/
 * Atendimento, App.Util.paginate). Também alimenta os cards de resumo.
 */
router.get('/legalizacao/painel', async (req, res) => {
  try {
    await ensureLegalizacaoSchema();
    const { rows: todas } = await pool.query(LEGAL_PAINEL_SQL);
    const { rows: muns } = await pool.query(`SELECT id::text AS id, municipio, uf, municipio_ibge, inscricao_municipal FROM clientes`);
    const munPorId = new Map(muns.map(m => [m.id, m]));
    const { rows: pend } = await pool.query(`SELECT cliente_id, tipo FROM legalizacao_alvaras WHERE lido_por_ocr AND conferido_em IS NULL AND desativado_em IS NULL AND data_vencimento IS NOT NULL`);
    const aConferir = new Set(pend.map(p => p.cliente_id + '|' + p.tipo));
    const verDesativados = req.query.desativados === '1' && req.user.role === 'administrador';
    const rows = verDesativados ? todas : todas.filter(r => !(r.sem_cadastro_acessorias && r.cert_desat)).map(r => (r.sanit_desat ? { ...r, sanit_id: null } : r));
    res.json({
      data: rows.map(r => {
        const l = legalPainelLinha(r);
        const m = munPorId.get(r.cliente_id);
        l.municipio = m && m.municipio ? m.municipio : null;
        l.uf = m && m.uf ? m.uf : null;
        l.inscricao_municipal = m && m.inscricao_municipal ? m.inscricao_municipal : null;
        if (l.func) l.func.a_conferir = aConferir.has(r.cliente_id + '|funcionamento');
        if (l.sanit) l.sanit.a_conferir = aConferir.has(r.cliente_id + '|sanitario');
        // null = ainda não conferido; false = cidade sem consulta automática (buscar na prefeitura de lá)
        l.prefeitura_integrada = m && m.municipio_ibge ? IBGES_INTEGRADOS.includes(m.municipio_ibge) : null;
        // automatica = Uberlândia/Uberaba/BH (consulta na prefeitura) · pasta = cidade sem consulta (só pela pasta da Legalização) · sem_municipio = ainda sem cidade (CPF, cadastro sem CNPJ…)
        // pessoa_fisica = CPF sem município: não precisa de cidade (só certificado/procuração PF), então não conta como pendência
        // idem CNO/CAEPF (rural: CPF + sufixo) e cadastros internos (9997..9999): documento que não é CPF nem CNPJ válido
        const docPF = String(r.cnpj || l.cnpj || '').replace(/\D/g, '');
        const cnpjValido = (d) => { if (d.length !== 14 || /^(\d)\1+$/.test(d)) return false; const dv = (n) => { let s = 0, p = n - 7; for (let i = 0; i < n; i++) { s += +d[i] * p--; if (p < 2) p = 9; } const r = s % 11; return r < 2 ? 0 : 11 - r; }; return dv(12) === +d[12] && dv(13) === +d[13]; };
        const ehPF = docPF.length === 11 || !cnpjValido(docPF);
        l.automacao = l.prefeitura_integrada === true ? 'automatica' : (m && m.municipio ? 'pasta' : (ehPF ? 'pessoa_fisica' : 'sem_municipio'));
        if (l.prefeitura_integrada === false) { // atalho pro portal da cidade (consulta manual)
          const p = portalDaPrefeitura(m.municipio, m.uf);
          l.prefeitura_url = p.url; l.prefeitura_url_oficial = p.oficial; l.prefeitura_url_sanitario = p.url_sanitario;
        }
        return l;
      }),
      diasAlerta: { alvara: LEGAL_DIAS_ALERTA_ALVARA, certificado: LEGAL_DIAS_ALERTA_CERTIFICADO, procuracao: LEGAL_DIAS_ALERTA_PROCURACAO },
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro ao carregar legalização.' }); }
});

/**
 * SAÚDE DAS CONSULTAS — as rotinas do computador do escritório (consulta às prefeituras às 03:00, leitura das pastas às 05:00)
 * registram o resultado de cada rodada; a tela mostra se rodaram, quantas falharam e a situação de cada cidade.
 *   POST /legalizacao/saude-rotina  (X-Sync-Token) → { rotina, inicio, total, ok, falhas, resumo, por_cidade }
 *   GET  /legalizacao/saude         (admin)        → rotinas + cidades
 */
const ROTINAS_LEGALIZACAO = {
  consulta_prefeituras: { nome: 'Consulta às prefeituras', horario: 'todo dia às 03:00', horasMax: 30 },
  leitura_pastas: { nome: 'Leitura das pastas da Legalização', horario: 'todo dia às 05:00', horasMax: 30 },
};

/** Situação de cada rotina: última rodada, se está atrasada e se houve muitas falhas. */
async function situacaoRotinas() {
  const saida = [];
  for (const [chave, cfg] of Object.entries(ROTINAS_LEGALIZACAO)) {
    const { rows } = await pool.query(`SELECT * FROM legalizacao_rotinas WHERE rotina = $1 ORDER BY fim DESC LIMIT 1`, [chave]);
    const u = rows[0] || null;
    const horas = u ? (Date.now() - new Date(u.fim).getTime()) / 3600000 : null;
    let status = 'sem_registro';
    if (u) status = horas > cfg.horasMax ? 'atrasada' : (u.total > 0 && u.falhas / u.total > 0.2 ? 'com_falhas' : 'ok');
    saida.push({ rotina: chave, nome: cfg.nome, horario: cfg.horario, status, horas_desde: horas == null ? null : Math.round(horas * 10) / 10,
      ultima: u ? { fim: u.fim, inicio: u.inicio, total: u.total, ok: u.ok, falhas: u.falhas, resumo: u.resumo, por_cidade: u.por_cidade } : null });
  }
  return saida;
}

router.get('/legalizacao/saude', requireAdmin, async (req, res) => {
  try {
    await ensureLegalizacaoSchema();
    const rotinas = await situacaoRotinas();
    const consulta = rotinas.find(r => r.rotina === 'consulta_prefeituras');
    const porCidadeRodada = (consulta && consulta.ultima && consulta.ultima.por_cidade) || {};
    const { rows } = await pool.query(
      `SELECT c.municipio_ibge AS ibge, COALESCE(NULLIF(c.municipio, ''), 'Não conferido') AS municipio, c.uf,
              COUNT(DISTINCT c.id) AS empresas,
              COUNT(DISTINCT c.id) FILTER (WHERE f.data_vencimento IS NOT NULL) AS func_com_data,
              COUNT(DISTINCT c.id) FILTER (WHERE f.data_vencimento IS NOT NULL AND f.data_vencimento < CURRENT_DATE) AS func_vencido,
              COUNT(DISTINCT c.id) FILTER (WHERE s.data_vencimento IS NOT NULL) AS sanit_com_data,
              MAX(f.ultima_consulta_em) AS ultima_consulta
         FROM clientes c
         LEFT JOIN legalizacao_alvaras f ON f.cliente_id = c.id::text AND f.tipo = 'funcionamento' AND f.desativado_em IS NULL
         LEFT JOIN legalizacao_alvaras s ON s.cliente_id = c.id::text AND s.tipo = 'sanitario' AND s.desativado_em IS NULL
        WHERE c.status = 'ativo'
        GROUP BY c.municipio_ibge, c.municipio, c.uf
        ORDER BY COUNT(DISTINCT c.id) DESC, c.municipio`
    );
    const cidades = rows.map(r => {
      const rod = r.ibge ? porCidadeRodada[r.ibge] : null;
      return { ibge: r.ibge, municipio: r.municipio, uf: r.uf, empresas: +r.empresas, func_com_data: +r.func_com_data, func_vencido: +r.func_vencido,
        sanit_com_data: +r.sanit_com_data, ultima_consulta: r.ultima_consulta,
        fonte: r.ibge && IBGES_INTEGRADOS.includes(r.ibge) ? 'consulta automática' : 'pasta da Legalização',
        rodada: rod || null };
    });
    res.json({ rotinas, cidades });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro ao carregar a saúde das consultas.' }); }
});

/** Avisa no sino (1x por dia) quando uma rotina do escritório não reportou dentro do prazo — computador desligado, tarefa parada… */
async function checarSaudeRotinasLegalizacao() {
  try {
    await ensureLegalizacaoSchema();
    for (const r of await situacaoRotinas()) {
      if (r.status !== 'atrasada') continue; // 'sem_registro' (nunca rodou) não alarma: evita falso alerta antes da 1ª rodada
      const { rows } = await pool.query(`SELECT 1 FROM notificacoes WHERE tipo = 'legalizacao_rotina_atrasada' AND mensagem LIKE $1 AND created_at > NOW() - INTERVAL '20 hours' LIMIT 1`, [r.nome + '%']);
      if (rows.length) continue;
      await pool.query(`INSERT INTO notificacoes (tipo, titulo, mensagem, link_modulo) VALUES ('legalizacao_rotina_atrasada', $1, $2, 'legalizacao')`,
        ['Rotina da Legalização não rodou', `${r.nome} não reporta há ${Math.round(r.horas_desde)} h (deveria rodar ${r.horario}). Confira se o computador do escritório está ligado.`]);
    }
  } catch (err) { console.error('[Legalização] checarSaudeRotinas:', err.message); }
}

/**
 * PATCH /legalizacao/clientes/:clienteId/municipio — { municipio, uf }: informa a cidade de quem não tem como achar pelo cartão CNPJ
 * (pessoa física/produtor rural, cadastro com identificador que não é CNPJ). Descobre o código IBGE pelo nome (API do IBGE) e grava
 * município, UF e IBGE — assim o filtro "só pasta"/"automática" e as buscas passam a saber onde procurar.
 */
router.patch('/legalizacao/clientes/:clienteId/municipio', async (req, res) => {
  try {
    await garantirColunasMunicipio();
    const uf = String((req.body && req.body.uf) || '').trim().toUpperCase();
    const semAcento = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
    const nome = semAcento(req.body && req.body.municipio);
    if (!/^[A-Z]{2}$/.test(uf) || !nome) return res.status(400).json({ error: 'Informe o município e a UF (ex.: Uberlândia / MG).' });
    const r = await fetch(`https://servicodados.ibge.gov.br/api/v1/localidades/estados/${uf}/municipios`, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) return res.status(502).json({ error: 'Não consegui consultar o IBGE agora. Tente de novo.' });
    const lista = await r.json();
    const achado = lista.find((m) => semAcento(m.nome) === nome);
    if (!achado) return res.status(404).json({ error: `Não achei "${req.body.municipio}" em ${uf}. Confira a grafia.` });
    const up = await pool.query(`UPDATE clientes SET municipio = $1, uf = $2, municipio_ibge = $3, municipio_verificado_em = NOW() WHERE id::text = $4`, [semAcento(achado.nome), uf, String(achado.id), req.params.clienteId]);
    if (!up.rowCount) return res.status(404).json({ error: 'Cliente não encontrado.' });
    res.json({ ok: true, municipio: semAcento(achado.nome), uf, ibge: String(achado.id) });
  } catch (err) { console.error('[legalizacao] município:', err); res.status(500).json({ error: 'Erro ao salvar o município.' }); }
});

/**
 * FILA DE CONFERÊNCIA — datas lidas por OCR de PDF escaneado da pasta do servidor. O OCR erra (ex.: "31/12/2924"), então cada
 * leitura fica "a conferir" até um admin confirmar ou corrigir a data.
 *   GET  /legalizacao/conferencia            → lista o que falta conferir (empresa, tipo, data lida, arquivo e o trecho do texto)
 *   POST /legalizacao/alvaras/:id/conferir   → { data_vencimento? } confirma; se vier uma data diferente, corrige e confirma
 */
router.get('/legalizacao/conferencia', requireAdmin, async (req, res) => {
  try {
    await ensureLegalizacaoSchema();
    const { rows } = await pool.query(
      `SELECT a.id, a.tipo, a.data_vencimento::text AS vencimento, a.numero, a.origem_arquivo, a.trecho_lido, a.atualizado_em,
              a.cliente_id, c.nome_empresa, c.cnpj, c.municipio, c.uf
         FROM legalizacao_alvaras a JOIN clientes c ON c.id::text = a.cliente_id
        WHERE a.lido_por_ocr AND a.conferido_em IS NULL AND a.desativado_em IS NULL AND a.data_vencimento IS NOT NULL
        ORDER BY c.nome_empresa, a.tipo`
    );
    res.json({ data: rows });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro ao carregar a fila de conferência.' }); }
});

router.post('/legalizacao/alvaras/:id/conferir', requireAdmin, async (req, res) => {
  try {
    await ensureLegalizacaoSchema();
    const nova = req.body && req.body.data_vencimento ? String(req.body.data_vencimento) : null;
    if (nova && !/^\d{4}-\d{2}-\d{2}$/.test(nova)) return res.status(400).json({ error: 'Data inválida.' });
    const { rows } = await pool.query(
      `UPDATE legalizacao_alvaras SET
         notificado_vencimento_em = CASE WHEN $2::date IS NOT NULL AND $2::date IS DISTINCT FROM data_vencimento THEN NULL ELSE notificado_vencimento_em END,
         data_vencimento = COALESCE($2::date, data_vencimento),
         conferido_em = NOW(), conferido_por = $3, atualizado_em = NOW()
       WHERE id = $1 AND lido_por_ocr
       RETURNING id, data_vencimento::text AS vencimento`,
      [req.params.id, nova, req.user.name]
    );
    if (!rows.length) return res.status(404).json({ error: 'Item não encontrado ou já conferido.' });
    await registrarLog(req.user.id, req.user.name, 'editar', 'legalizacao', nova ? 'Data lida por OCR corrigida e confirmada' : 'Data lida por OCR confirmada', req);
    res.json({ ok: true, vencimento: rows[0].vencimento });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro ao confirmar a leitura.' }); }
});

/**
 * PATCH /api/data/legalizacao/clientes/:clienteId/inscricao-municipal — grava a Inscrição Municipal (CGA/CMC…) da empresa.
 * Várias prefeituras (Lauro de Freitas, Rio, Arcos…) só consultam alvará por inscrição, não por CNPJ. Vazio = apaga.
 * Mesma abertura da solicitação de inativação: qualquer usuário logado com acesso à Legalização.
 */
router.patch('/legalizacao/clientes/:clienteId/inscricao-municipal', async (req, res) => {
  try {
    await ensureLegalizacaoSchema();
    const bruto = String(req.body && req.body.inscricao_municipal != null ? req.body.inscricao_municipal : '').trim();
    if (bruto.length > 30 || /[^0-9A-Za-z.\-\/ ]/.test(bruto)) return res.status(400).json({ error: 'Inscrição municipal inválida — use só números, letras, ponto, hífen ou barra (até 30 caracteres).' });
    const valor = bruto || null;
    const { rowCount } = await pool.query(`UPDATE clientes SET inscricao_municipal = $1 WHERE id = $2`, [valor, req.params.clienteId]);
    if (!rowCount) return res.status(404).json({ error: 'Cliente não encontrado.' });
    res.json({ ok: true, inscricao_municipal: valor });
  } catch (err) { console.error('[legalizacao] inscrição municipal:', err); res.status(500).json({ error: 'Erro ao salvar a inscrição municipal.' }); }
});

/** PUT /api/data/legalizacao/procuracoes/:clienteId/:tipo (ecac|fgts) — só admin; UPSERT da data de vencimento. */
router.put('/legalizacao/procuracoes/:clienteId/:tipo', requireAdmin, async (req, res) => {
  try {
    await ensureLegalizacaoSchema();
    const { clienteId, tipo } = req.params;
    if (!['ecac', 'fgts'].includes(tipo)) return res.status(400).json({ error: 'Tipo inválido.' });
    const { rows: cli } = await pool.query(`SELECT nome_empresa FROM clientes WHERE id = $1`, [clienteId]);
    if (!cli.length) return res.status(404).json({ error: 'Cliente não encontrado.' });
    const { data_vencimento, observacoes } = req.body;
    await pool.query(
      `INSERT INTO legalizacao_procuracoes (cliente_id, tipo, data_vencimento, observacoes, criado_por)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (cliente_id, tipo) DO UPDATE SET
         notificado_vencimento_em = CASE WHEN legalizacao_procuracoes.data_vencimento IS DISTINCT FROM $3::date THEN NULL ELSE legalizacao_procuracoes.notificado_vencimento_em END,
         data_vencimento = $3, observacoes = $4, atualizado_em = NOW()`,
      [clienteId, tipo, data_vencimento || null, observacoes || null, req.user.name]
    );
    await registrarLog(req.user.id, req.user.name, 'editar', 'legalizacao',
      `Procuração ${tipo === 'ecac' ? 'ECAC' : 'FGTS Digital'} atualizada: ${cli[0].nome_empresa}`, req);
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro ao salvar procuração.' }); }
});

/**
 * PUT /api/data/legalizacao/alvaras/:clienteId/:tipo — cria OU atualiza
 * (UPSERT) o alvará daquele cliente+tipo. Substitui o antigo POST/PATCH por
 * id — a linha pode ainda nem existir de verdade (é "virtual" até alguém
 * preencher algo), então edita sempre por cliente+tipo, nunca por id.
 * Gravar uma data nova limpa a marca de "Solicitação em andamento" — já se
 * sabe a data certa, não precisa mais do status da última consulta.
 */
router.put('/legalizacao/alvaras/:clienteId/:tipo', async (req, res) => {
  try {
    await ensureLegalizacaoSchema();
    const { clienteId, tipo } = req.params;
    if (!['funcionamento', 'sanitario'].includes(tipo)) return res.status(400).json({ error: 'Tipo inválido.' });
    const { data_vencimento, numero, observacoes } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO legalizacao_alvaras (cliente_id, tipo, data_vencimento, numero, observacoes, criado_por)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (cliente_id, tipo) DO UPDATE SET
         data_vencimento = $3, numero = $4, observacoes = $5, atualizado_em = NOW(),
         origem_arquivo = CASE WHEN legalizacao_alvaras.lido_por_ocr THEN 'manual' ELSE legalizacao_alvaras.origem_arquivo END,
         lido_por_ocr = false, conferido_em = NULL, conferido_por = NULL,
         ultima_consulta_status = CASE WHEN $3 IS NOT NULL THEN NULL ELSE legalizacao_alvaras.ultima_consulta_status END,
         notificado_vencimento_em = CASE WHEN $3 IS DISTINCT FROM legalizacao_alvaras.data_vencimento THEN NULL ELSE legalizacao_alvaras.notificado_vencimento_em END
       RETURNING id`,
      [clienteId, tipo, data_vencimento || null, numero || null, observacoes || null, req.user.name]
    );
    await registrarLog(req.user.id, req.user.name, 'editar', 'legalizacao', `Alvará (${tipo}) atualizado`, req);
    res.json({ ok: true, id: rows[0].id });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro ao salvar alvará.' }); }
});

/**
 * POST /api/data/legalizacao/alvaras/:clienteId/:tipo/consultar-prefeitura
 * — roda a consulta automática no portal da prefeitura (hoje só
 * Uberlândia-MG/Ciclo7, ver ciclo7Uberlandia.js) pro CNPJ desse cliente.
 * Achado do Reysner, 17/09/2026: o botão "Imprimir" do portal gera uma
 * certidão em PDF com a data de vencimento REAL — quando o ciclo7Uberlandia
 * consegue extrair isso, GRAVA `data_vencimento` de verdade (não fica só no
 * status "Solicitação"). Quando não consegue (layout mudou, timeout, ou o
 * portal só devolveu o status do protocolo mesmo), cai pro comportamento
 * antigo: grava só o status pra virar o badge "Solicitação" (UPSERT — a
 * linha pode ser virtual ainda). Só funciona pra CNPJ de Uberlândia-MG hoje.
 */
async function gravarAlvaraConsultado(clienteId, tipo, resultado, bloco, vencimento, autor) {
  let ultimaConsultaStatus = null, resumo = null, dataSolicitacao = null;
  if (!bloco || !bloco.encontrado) {
    resumo = (resultado.erros && resultado.erros[0]) || 'Nada encontrado no portal da prefeitura nos últimos 5 anos.';
  } else if (vencimento) {
    resumo = `Vencimento encontrado na certidão da prefeitura: ${vencimento.split('-').reverse().join('/')}.`;
  } else {
    ultimaConsultaStatus = 'solicitacao_andamento';
    dataSolicitacao = bloco.solicitacao;
    const pareceres = (bloco.pareceres || []).map(p => `${p.secretaria}: ${p.parecer}`).join(' · ');
    resumo = `${bloco.servico || 'Solicitação'} (${bloco.solicitacao || '—'}, nº ${bloco.numeroPlanilha || '—'})${bloco.statusGeral ? ' — ' + bloco.statusGeral : ''}${pareceres ? ' — ' + pareceres : ''}`;
  }
  if (vencimento) {
    // Achou a data real — grava ela de verdade, igual um PUT manual (inclusive
    // limpando a marca de notificado, pra caso a nova data caia na janela de alerta).
    await pool.query(
      `INSERT INTO legalizacao_alvaras (cliente_id, tipo, data_vencimento, ultima_consulta_status, ultima_consulta_resumo, ultima_consulta_data_solicitacao, ultima_consulta_em, criado_por)
       VALUES ($1,$2,$3,NULL,$4,NULL,NOW(),$5)
       ON CONFLICT (cliente_id, tipo) DO UPDATE SET
         data_vencimento = $3, ultima_consulta_status = NULL, ultima_consulta_resumo = $4,
         ultima_consulta_data_solicitacao = NULL, ultima_consulta_em = NOW(), atualizado_em = NOW(),
         notificado_vencimento_em = CASE WHEN $3 IS DISTINCT FROM legalizacao_alvaras.data_vencimento THEN NULL ELSE legalizacao_alvaras.notificado_vencimento_em END`,
      [clienteId, tipo, vencimento, resumo, autor]
    );
  } else {
    await pool.query(
      `INSERT INTO legalizacao_alvaras (cliente_id, tipo, ultima_consulta_status, ultima_consulta_resumo, ultima_consulta_data_solicitacao, ultima_consulta_em, criado_por)
       VALUES ($1,$2,$3,$4,$5,NOW(),$6)
       ON CONFLICT (cliente_id, tipo) DO UPDATE SET
         ultima_consulta_status = $3, ultima_consulta_resumo = $4,
         ultima_consulta_data_solicitacao = $5, ultima_consulta_em = NOW()`,
      [clienteId, tipo, ultimaConsultaStatus, resumo, dataSolicitacao, autor]
    );
  }
  return { ultimaConsultaStatus, resumo, dataSolicitacao };
}

async function consultarAlvaraPrefeitura(clienteId, tipo, autor) {
    await ensureLegalizacaoSchema();
    const erroHttp = (status, msg) => Object.assign(new Error(msg), { statusHttp: status });
    if (!['funcionamento', 'sanitario'].includes(tipo)) throw erroHttp(400, 'Tipo inválido.');
    const { rows: clienteRows } = await pool.query(`SELECT cnpj FROM clientes WHERE id = $1`, [clienteId]);
    if (!clienteRows.length) throw erroHttp(404, 'Cliente não encontrado.');
    if (!clienteRows[0].cnpj) throw erroHttp(400, 'Cliente sem CNPJ cadastrado.');

    const { consultarAlvaraUberlandia } = require('../legalizacao/ciclo7Uberlandia');
    const resultado = await consultarAlvaraUberlandia(clienteRows[0].cnpj);
    return gravarResultadoConsultaAlvara(clienteId, tipo, resultado, autor);
}

async function gravarResultadoConsultaAlvara(clienteId, tipo, resultado, autor) {
    // O portal devolve Funcionamento e Sanitário na MESMA busca. Grava cada um
    // que foi achado (o Sanitário entra sozinho — sem cadastro manual) e SEMPRE
    // o tipo pedido (pra marcar a data da última consulta mesmo sem resultado).
    // A data de vencimento só vale pro tipo que foi de fato achado: o scraper
    // só extrai data quando UM tipo só aparece, então nunca vai pro tipo errado.
    const achouFunc = !!resultado.funcionamento?.encontrado, achouSanit = !!resultado.sanitario?.encontrado;
    const venc = {
      funcionamento: achouFunc && !achouSanit ? resultado.vencimentoEncontrado : null,
      sanitario: achouSanit && !achouFunc ? resultado.vencimentoEncontrado : null,
    };
    // Portais que devolvem as datas já separadas por tipo (ex.: Belo Horizonte: ALF + SISVISA) mandam `vencimentos`.
    if (resultado.vencimentos) for (const t of ['funcionamento', 'sanitario']) if (resultado.vencimentos[t] && resultado[t]?.encontrado) venc[t] = resultado.vencimentos[t];
    const gravados = {};
    for (const t of ['funcionamento', 'sanitario']) {
      const bloco = resultado[t];
      if (t !== tipo && !bloco?.encontrado) continue;
      gravados[t] = await gravarAlvaraConsultado(clienteId, t, resultado, bloco, venc[t], autor);
    }
    const g = gravados[tipo];
    return {
      ok: true, encontrado: !!g.ultimaConsultaStatus || !!venc[tipo],
      vencimentoEncontrado: venc[tipo] || null,
      resumo: g.resumo, dataSolicitacao: g.dataSolicitacao, anoConsultado: resultado.ano, anosVarridos: resultado.anosVarridos,
      sanitarioEncontrado: achouSanit,
    };
}

router.post('/legalizacao/alvaras/:clienteId/:tipo/consultar-prefeitura', async (req, res) => {
  try {
    res.json(await consultarAlvaraPrefeitura(req.params.clienteId, req.params.tipo, req.user.name));
  } catch (err) {
    console.error('[legalizacao] consultar-prefeitura falhou:', err);
    res.status(err.statusHttp || 500).json({ error: err.message || 'Erro ao consultar a prefeitura.' });
  }
});

/**
 * Rotina NOTURNA de consulta de alvarás (Funcionamento) na prefeitura —
 * pedido do Reysner, 18/09/2026: achou uma data de vencimento válida, não
 * pesquisa mais essa empresa até o dia do vencimento; venceu (ou ainda
 * não tem data), continua pesquisando toda madrugada até achar uma data
 * não vencida. Escolhas pra não repetir o bloqueio do Akamai da prefeitura
 * (consulta em lote a 400ms/req derrubou o acesso em 18/09/2026):
 *   - intervalo de 4s entre consultas;
 *   - no máximo LEGAL_CONSULTA_MAX_POR_NOITE empresas por noite (a 1ª carga
 *     de ~640 se espalha em algumas noites);
 *   - "nada encontrado" (não é de Uberlândia / sem alvará) só é
 *     reconsultado a cada 7 dias, não toda noite — senão essas empresas
 *     martelariam o portal pra sempre;
 *   - aborta a noite se 5 consultas seguidas falharem (sinal de bloqueio).
 */
const LEGAL_CONSULTA_MAX_POR_NOITE = 300;
const LEGAL_CONSULTA_INTERVALO_MS = 4000;
let consultaNoturnaRodando = false;

async function rodarConsultaNoturnaAlvaras() {
  if (consultaNoturnaRodando) return { pulou: true };
  consultaNoturnaRodando = true;
  try {
    await ensureLegalizacaoSchema();
    const { rows: alvos } = await pool.query(
      `SELECT c.id::text AS cliente_id, c.nome_empresa
         FROM clientes c
         LEFT JOIN legalizacao_alvaras a ON a.cliente_id = c.id::text AND a.tipo = 'funcionamento'
        WHERE c.status = 'ativo'
          AND c.municipio_ibge = '${IBGE_UBERLANDIA}'
          AND length(regexp_replace(COALESCE(c.cnpj, ''), '\\D', '', 'g')) = 14
          AND (a.data_vencimento IS NULL OR a.data_vencimento <= CURRENT_DATE)
          AND (
                a.ultima_consulta_em IS NULL
             OR ((a.data_vencimento IS NOT NULL OR a.ultima_consulta_status = 'solicitacao_andamento')
                 AND a.ultima_consulta_em < NOW() - INTERVAL '20 hours')
             OR a.ultima_consulta_em < NOW() - INTERVAL '7 days'
          )
        ORDER BY a.ultima_consulta_em ASC NULLS FIRST
        LIMIT $1`,
      [LEGAL_CONSULTA_MAX_POR_NOITE]
    );
    let consultadas = 0, comData = 0, comSolicitacao = 0, falhasSeguidas = 0, abortou = false;
    for (const alvo of alvos) {
      try {
        const r = await consultarAlvaraPrefeitura(alvo.cliente_id, 'funcionamento', 'Rotina noturna');
        consultadas++; falhasSeguidas = 0;
        if (r.vencimentoEncontrado) comData++; else if (r.encontrado) comSolicitacao++;
      } catch (e) {
        falhasSeguidas++;
        console.error(`[Legalização] Consulta noturna falhou (${alvo.nome_empresa}):`, e.message);
        if (falhasSeguidas >= 5) { abortou = true; break; }
      }
      await new Promise(r => setTimeout(r, LEGAL_CONSULTA_INTERVALO_MS));
    }
    return { elegiveis: alvos.length, consultadas, comData, comSolicitacao, abortou };
  } finally {
    consultaNoturnaRodando = false;
  }
}

/**
 * PATCH /legalizacao/alvaras/:id/desativar e /certificados/:id/desativar — tira o item da lista,
 * dos KPIs, da página pública e do sino sem apagar (a consulta automática não o reativa).
 */
router.patch('/legalizacao/alvaras/:id/desativar', requireAdmin, async (req, res) => {
  try {
    await ensureLegalizacaoSchema();
    await pool.query(`UPDATE legalizacao_alvaras SET desativado_em = NOW() WHERE id = $1`, [req.params.id]);
    await registrarLog(req.user.id, req.user.name, 'editar', 'legalizacao', 'Alvará desativado', req);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Erro ao desativar alvará.' }); }
});

router.patch('/legalizacao/certificados/:id/desativar', requireAdmin, async (req, res) => {
  try {
    await ensureLegalizacaoSchema();
    await pool.query(`UPDATE legalizacao_certificados SET desativado_em = NOW() WHERE id = $1`, [req.params.id]);
    await registrarLog(req.user.id, req.user.name, 'editar', 'legalizacao', 'Certificado desativado', req);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Erro ao desativar certificado.' }); }
});

router.patch('/legalizacao/alvaras/:id/reativar', requireAdmin, async (req, res) => {
  try {
    await pool.query(`UPDATE legalizacao_alvaras SET desativado_em = NULL WHERE id = $1`, [req.params.id]);
    await registrarLog(req.user.id, req.user.name, 'editar', 'legalizacao', 'Alvará reativado', req);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Erro ao reativar alvará.' }); }
});

router.patch('/legalizacao/certificados/:id/reativar', requireAdmin, async (req, res) => {
  try {
    await pool.query(`UPDATE legalizacao_certificados SET desativado_em = NULL WHERE id = $1`, [req.params.id]);
    await registrarLog(req.user.id, req.user.name, 'editar', 'legalizacao', 'Certificado reativado', req);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Erro ao reativar certificado.' }); }
});

router.delete('/legalizacao/alvaras/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query(`DELETE FROM legalizacao_alvaras WHERE id = $1`, [req.params.id]);
    await registrarLog(req.user.id, req.user.name, 'excluir', 'legalizacao', 'Alvará excluído', req);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Erro ao excluir alvará.' }); }
});

/**
 * PUT /api/data/legalizacao/certificados/:clienteId — UPSERT do certificado
 * PJ daquele cliente (titular = a própria empresa). Substitui o antigo
 * "+ Novo Certificado" pro caso PJ — a linha já existe (virtual) pra toda
 * empresa ativa, só falta preencher a data.
 */
router.put('/legalizacao/certificados/:clienteId', async (req, res) => {
  try {
    await ensureLegalizacaoSchema();
    const { clienteId } = req.params;
    const { rows: clienteRows } = await pool.query(`SELECT nome_empresa, cnpj FROM clientes WHERE id = $1`, [clienteId]);
    if (!clienteRows.length) return res.status(404).json({ error: 'Cliente não encontrado.' });
    const { data_vencimento, observacoes } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO legalizacao_certificados (cliente_id, tipo, titular_nome, titular_documento, data_vencimento, observacoes, criado_por)
       VALUES ($1,'pj',$2,$3,$4,$5,$6)
       ON CONFLICT (cliente_id) WHERE tipo = 'pj' AND cliente_id IS NOT NULL DO UPDATE SET
         data_vencimento = $4, observacoes = $5, atualizado_em = NOW(),
         notificado_vencimento_em = CASE WHEN $4 IS DISTINCT FROM legalizacao_certificados.data_vencimento THEN NULL ELSE legalizacao_certificados.notificado_vencimento_em END
       RETURNING id`,
      [clienteId, clienteRows[0].nome_empresa, clienteRows[0].cnpj, data_vencimento || null, observacoes || null, req.user.name]
    );
    await registrarLog(req.user.id, req.user.name, 'editar', 'legalizacao', 'Certificado PJ atualizado', req);
    res.json({ ok: true, id: rows[0].id });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro ao salvar certificado.' }); }
});

router.patch('/legalizacao/certificados/:id', requireAdmin, async (req, res) => {
  try {
    const { titular_nome, titular_documento, data_vencimento, observacoes } = req.body;
    const { rows } = await pool.query(
      `UPDATE legalizacao_certificados SET
         titular_nome = COALESCE($2, titular_nome), titular_documento = $3,
         data_vencimento = $4, observacoes = $5, atualizado_em = NOW(),
         notificado_vencimento_em = CASE WHEN $4 IS DISTINCT FROM data_vencimento THEN NULL ELSE notificado_vencimento_em END
       WHERE id = $1 RETURNING id`,
      [req.params.id, titular_nome || null, titular_documento || null, data_vencimento || null, observacoes || null]
    );
    if (!rows.length) return res.status(404).json({ error: 'Certificado não encontrado.' });
    await registrarLog(req.user.id, req.user.name, 'editar', 'legalizacao', 'Certificado atualizado', req);
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro ao atualizar certificado.' }); }
});

router.delete('/legalizacao/certificados/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query(`DELETE FROM legalizacao_certificados WHERE id = $1`, [req.params.id]);
    await registrarLog(req.user.id, req.user.name, 'excluir', 'legalizacao', 'Certificado excluído', req);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Erro ao excluir certificado.' }); }
});

/**
 * Cria notificações (sininho) pra todo alvará/certificado que ENTROU na
 * janela de "vencendo" (ou já venceu) e ainda não foi notificado pra essa
 * data específica — pedido do Reysner, 17/09/2026: 60 dias pra alvará, 10
 * pra certificado. Pensada pra rodar 1x por dia (ver server/index.js).
 * Nunca notifica 2x pra mesma data — só volta a notificar se a data mudar
 * (ver notificado_vencimento_em, resetado nos PUT/PATCH acima).
 */
async function verificarNotificacoesLegalizacao() {
  await ensureLegalizacaoSchema();
  await atualizarObservacaoSanitaria().catch((e) => console.error('[Sanitário] avaliação falhou:', e.message));
  let criadas = 0;

  const { rows: alvaras } = await pool.query(
    `SELECT a.id, a.cliente_id, a.tipo, a.data_vencimento, c.nome_empresa
       FROM legalizacao_alvaras a
       JOIN clientes c ON c.id::text = a.cliente_id
      WHERE a.data_vencimento IS NOT NULL
        AND a.data_vencimento <= CURRENT_DATE + INTERVAL '${LEGAL_DIAS_ALERTA_ALVARA} days'
        AND a.notificado_vencimento_em IS NULL
        AND a.desativado_em IS NULL`
  );
  for (const a of alvaras) {
    const tipoLabel = a.tipo === 'funcionamento' ? 'Alvará de Funcionamento' : 'Alvará Sanitário';
    const venceu = new Date(a.data_vencimento) < new Date();
    const dataFmt = new Date(a.data_vencimento).toLocaleDateString('pt-BR', { timeZone: 'UTC' });
    await pool.query(
      `INSERT INTO notificacoes (tipo, titulo, mensagem, link_modulo, cliente_id)
       VALUES ('legalizacao_vencimento', $1, $2, 'legalizacao', $3)`,
      [`${tipoLabel} ${venceu ? 'vencido' : 'vencendo'}`,
       `${a.nome_empresa} — ${tipoLabel} ${venceu ? 'venceu em' : 'vence em'} ${dataFmt}.`, a.cliente_id]
    );
    await pool.query(`UPDATE legalizacao_alvaras SET notificado_vencimento_em = NOW() WHERE id = $1`, [a.id]);
    criadas++;
  }

  const { rows: certs } = await pool.query(
    `SELECT id, titular_nome, data_vencimento FROM legalizacao_certificados
      WHERE data_vencimento IS NOT NULL
        AND data_vencimento <= CURRENT_DATE + INTERVAL '${LEGAL_DIAS_ALERTA_CERTIFICADO} days'
        AND notificado_vencimento_em IS NULL
        AND desativado_em IS NULL`
  );
  for (const c of certs) {
    const venceu = new Date(c.data_vencimento) < new Date();
    const dataFmt = new Date(c.data_vencimento).toLocaleDateString('pt-BR', { timeZone: 'UTC' });
    await pool.query(
      `INSERT INTO notificacoes (tipo, titulo, mensagem, link_modulo)
       VALUES ('legalizacao_vencimento', $1, $2, 'legalizacao')`,
      [`Certificado Digital ${venceu ? 'vencido' : 'vencendo'}`,
       `${c.titular_nome} — certificado digital ${venceu ? 'venceu em' : 'vence em'} ${dataFmt}.`]
    );
    await pool.query(`UPDATE legalizacao_certificados SET notificado_vencimento_em = NOW() WHERE id = $1`, [c.id]);
    criadas++;
  }

  // Procurações E-CAC / FGTS Digital: só empresas ativas do Acessórias.
  const { rows: procs } = await pool.query(
    `SELECT p.id, p.tipo, p.cliente_id, p.data_vencimento, c.nome_empresa
       FROM legalizacao_procuracoes p
       JOIN clientes c ON c.id::text = p.cliente_id
      WHERE p.data_vencimento IS NOT NULL
        AND p.data_vencimento <= CURRENT_DATE + INTERVAL '${LEGAL_DIAS_ALERTA_PROCURACAO} days'
        AND p.notificado_vencimento_em IS NULL
        AND c.status = 'ativo'`
  );
  for (const p of procs) {
    const venceu = new Date(p.data_vencimento) < new Date();
    const dataFmt = new Date(p.data_vencimento).toLocaleDateString('pt-BR', { timeZone: 'UTC' });
    const nome = p.tipo === 'ecac' ? 'E-CAC' : 'FGTS Digital';
    await pool.query(
      `INSERT INTO notificacoes (tipo, titulo, mensagem, link_modulo, cliente_id)
       VALUES ('legalizacao_vencimento', $1, $2, 'legalizacao', $3)`,
      [`Procuração ${nome} ${venceu ? 'vencida' : 'vencendo'}`,
       `${p.nome_empresa} — procuração ${nome} ${venceu ? 'venceu em' : 'vence em'} ${dataFmt}.`, p.cliente_id]
    );
    await pool.query(`UPDATE legalizacao_procuracoes SET notificado_vencimento_em = NOW() WHERE id = $1`, [p.id]);
    criadas++;
  }

  return { criadas };
}

/**
 * GET /api/data/legalizacao/notificacoes — sininho da página pública de Legalização
 * (pedido do Reysner, 18/09/2026): avisos de vencimento de alvará/certificado, com
 * "não lida" POR USUÁRIO (desde a última vez que ele abriu/limpou o sininho).
 */
router.get('/legalizacao/notificacoes', async (req, res) => {
  try {
    await ensureLegalizacaoSchema();
    const { rows: v } = await pool.query(`SELECT visto_em FROM legalizacao_notif_visto WHERE user_id = $1`, [req.user.id]);
    // 1º acesso: só conta como nova o que veio nos últimos 7 dias (senão o sino abre com centenas)
    const visto = v[0] ? v[0].visto_em : new Date(Date.now() - 7 * 24 * 3600 * 1000);
    const { rows } = await pool.query(
      `SELECT id, titulo, mensagem, created_at, (created_at > $1) AS nova
         FROM notificacoes WHERE tipo = 'legalizacao_vencimento' ORDER BY created_at DESC LIMIT 60`, [visto]);
    const { rows: c } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM notificacoes WHERE tipo = 'legalizacao_vencimento' AND created_at > $1`, [visto]);
    res.json({ data: rows, naoLidas: c[0].n });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro ao carregar notificações.' }); }
});

/** POST /api/data/legalizacao/notificacoes/lidas — "marcar todas como lidas" (só pra esse usuário). */
router.post('/legalizacao/notificacoes/lidas', async (req, res) => {
  try {
    await ensureLegalizacaoSchema();
    await pool.query(
      `INSERT INTO legalizacao_notif_visto (user_id, visto_em) VALUES ($1, NOW())
       ON CONFLICT (user_id) DO UPDATE SET visto_em = NOW()`, [req.user.id]);
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro ao marcar como lidas.' }); }
});

/** GET /api/data/legalizacao/motivos-inativacao — motivos de saída (a mesma lista de Motivos de Churn que o admin gerencia). */
router.get('/legalizacao/motivos-inativacao', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT nome FROM motivos_churn WHERE ativo = TRUE ORDER BY nome ASC`);
    res.json({ data: rows.map(r => r.nome) });
  } catch (err) { res.json({ data: [] }); }
});

/**
 * POST /api/data/legalizacao/solicitar-inativacao — usado pela página
 * pública de Legalização (colaborador com acesso_legalizacao). NÃO desativa
 * ninguém sozinho — só registra o pedido pendente + notifica o admin.
 * Pedido do Reysner, 18/09/2026: "ele poderá inativar porém colocando a
 * observação e aqui no módulo se realmente estiver certo eu valido".
 */
router.post('/legalizacao/solicitar-inativacao', async (req, res) => {
  try {
    await ensureLegalizacaoSchema();
    const { clienteId, motivo, observacao } = req.body;
    if (!clienteId) return res.status(400).json({ error: 'Informe o cliente.' });
    // Motivo é opcional (pedido do Reysner, 20/09/2026): só a observação é obrigatória.
    if (!observacao || !observacao.trim()) return res.status(400).json({ error: 'Escreva uma observação explicando o porquê.' });

    const { rows: cli } = await pool.query(`SELECT nome_empresa FROM clientes WHERE id = $1`, [clienteId]);
    if (!cli.length) return res.status(404).json({ error: 'Cliente não encontrado.' });

    const { rows: pendente } = await pool.query(
      `SELECT id FROM legalizacao_solicitacoes_inativacao WHERE cliente_id = $1 AND status = 'pendente'`, [clienteId]
    );
    if (pendente.length) return res.status(409).json({ error: 'Já existe uma solicitação pendente pra esse cliente.' });

    const { rows } = await pool.query(
      `INSERT INTO legalizacao_solicitacoes_inativacao (cliente_id, nome_empresa, motivo, observacao, solicitado_por)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [clienteId, cli[0].nome_empresa, motivo && String(motivo).trim() ? String(motivo).trim() : null, observacao.trim(), req.user.name]
    );
    await pool.query(
      `INSERT INTO notificacoes (tipo, titulo, mensagem, link_modulo, cliente_id)
       VALUES ('legalizacao_inativacao_solicitada', $1, $2, 'legalizacao', $3)`,
      ['Solicitação de inativação de cliente',
       `${req.user.name} solicitou inativar ${cli[0].nome_empresa}${motivo && String(motivo).trim() ? ' — motivo: ' + String(motivo).trim() : ''}. "${observacao.trim()}"`, clienteId]
    );
    res.status(201).json({ ok: true, id: rows[0].id });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro ao registrar solicitação.' }); }
});

/** GET /api/data/legalizacao/solicitacoes-inativacao — lista pro admin revisar (padrão: só pendentes). */
router.get('/legalizacao/solicitacoes-inativacao', requireAdmin, async (req, res) => {
  try {
    await ensureLegalizacaoSchema();
    const status = req.query.status || 'pendente';
    const { rows } = await pool.query(
      status === 'todas'
        ? `SELECT * FROM legalizacao_solicitacoes_inativacao ORDER BY solicitado_em DESC`
        : `SELECT * FROM legalizacao_solicitacoes_inativacao WHERE status = $1 ORDER BY solicitado_em DESC`,
      status === 'todas' ? [] : [status]
    );
    res.json({ data: rows });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro ao listar solicitações.' }); }
});

/**
 * PATCH /api/data/legalizacao/solicitacoes-inativacao/:id/aprovar — só o
 * admin. Encerra o cliente de verdade (mesma lógica de
 * PATCH /clientes/:id/encerrar) usando a observação do colaborador como
 * motivo_saida, e marca a solicitação como aprovada.
 */
router.patch('/legalizacao/solicitacoes-inativacao/:id/aprovar', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM legalizacao_solicitacoes_inativacao WHERE id = $1 AND status = 'pendente'`, [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Solicitação não encontrada ou já decidida.' });
    const solicitacao = rows[0];
    const hoje = new Date().toISOString().slice(0, 10);
    const motivo = solicitacao.motivo || 'Inativação solicitada';
    const descricao = `${motivo} — ${solicitacao.observacao} (solicitado por ${solicitacao.solicitado_por})`;

    await pool.query(
      `UPDATE clientes SET status='encerrado', data_saida=$1, motivo_saida=$2 WHERE id=$3`,
      [hoje, motivo, solicitacao.cliente_id]
    );
    await pool.query(
      `INSERT INTO eventos_clientes (cliente_id, tipo, descricao, data_evento) VALUES ($1,'saida',$2,$3)`,
      [solicitacao.cliente_id, descricao, hoje]
    );
    await pool.query(
      `UPDATE legalizacao_solicitacoes_inativacao SET status='aprovada', decidido_por=$1, decidido_em=NOW() WHERE id=$2`,
      [req.user.name, req.params.id]
    );
    await registrarLog(req.user.id, req.user.name, 'editar', 'legalizacao',
      `Aprovou inativação de ${solicitacao.nome_empresa} (solicitado por ${solicitacao.solicitado_por})`, req);
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro ao aprovar solicitação.' }); }
});

/** PATCH /api/data/legalizacao/solicitacoes-inativacao/:id/rejeitar — só o admin, não mexe no cliente. */
router.patch('/legalizacao/solicitacoes-inativacao/:id/rejeitar', requireAdmin, async (req, res) => {
  try {
    const { decisaoObservacao } = req.body;
    const { rows } = await pool.query(
      `UPDATE legalizacao_solicitacoes_inativacao
         SET status='rejeitada', decidido_por=$1, decidido_em=NOW(), decisao_observacao=$2
       WHERE id=$3 AND status='pendente' RETURNING id`,
      [req.user.name, decisaoObservacao || null, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Solicitação não encontrada ou já decidida.' });
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro ao rejeitar solicitação.' }); }
});

module.exports = router;
module.exports.verificarNotificacoesLegalizacao = verificarNotificacoesLegalizacao;
module.exports.rodarConsultaNoturnaAlvaras = rodarConsultaNoturnaAlvaras;
module.exports.checarSaudeRotinasLegalizacao = checarSaudeRotinasLegalizacao;


module.exports.publicRouter = publicRouter;
module.exports.registrarLog = registrarLog;
module.exports.sincronizarAcessorias = sincronizarAcessorias;
module.exports.completarMunicipiosClientes = completarMunicipiosClientes;
module.exports.executarAutoPreencher = executarAutoPreencher;
