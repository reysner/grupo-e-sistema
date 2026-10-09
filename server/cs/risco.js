'use strict';
/**
 * Risco de perda do cliente (Etapa 3 do painel de Risco) — leitura dos dados, rotas e sincronização das entregas.
 * Regras de cálculo em riscoCalculo.js (puras, com testes).
 *
 * Atendimento usa os dados do Zappy DEPOIS da revisão da Gamificação (pedido do Reysner, 06/10/2026, "pra não ser
 * injusto"): nota baixa marcada "indevida", SLA vermelho cuja revisão de velocidade foi "indevida" e abandono "indevida"
 * não entram no risco do cliente.
 *
 * Endpoints (montados em /api/cs/risco):
 *   GET  /                      -> risco, termômetros e motivos de cada cliente ativo (qualquer usuário logado)
 *   GET  /config  PUT /config   -> pesos e cortes (admin)
 *   POST /sincronizar-entregas  -> lê as entregas do Acessórias (Operacional), em segundo plano (admin)
 *   POST /suspensos-omie        -> lista de contratos "Suspenso" do Omie (selo Suspenso; token de sincronização)
 */
const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireAdmin } = require('../auth');
const acessorias = require('../acessoriasClient');
const calc = require('./riscoCalculo');
const { ehPessoaJuridica } = require('./churnSaidas');

const CHAVE_CONFIG = 'risco_config';
const CHAVE_SYNC_ENTREGAS = 'risco_entregas_sync';
const VERSAO_LEITURA = 3; // 2 = lê o objeto da empresa e usa o Status do Acessórias; 3 = só entregas que chegam ao cliente
const soDigitos = (s) => String(s || '').replace(/\D/g, '');
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const hojeBrasilia = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const somarDias = (iso, n) => { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };

// ── Banco ────────────────────────────────────────────────────────────────────
let _schema = null;
function garantirSchema() {
  if (!_schema) {
    _schema = pool.query(`CREATE TABLE IF NOT EXISTS cliente_entregas_resumo (
      doc TEXT PRIMARY KEY, total INT NOT NULL DEFAULT 0, atrasadas_entregues INT NOT NULL DEFAULT 0,
      vencidas_pendentes INT NOT NULL DEFAULT 0, janela_ini DATE, janela_fim DATE, atualizado_em TIMESTAMPTZ DEFAULT NOW())`)
      // versao: leituras antigas (versão 1) gravaram total 0 por erro de leitura da resposta; são refeitas.
      .then(() => pool.query(`ALTER TABLE cliente_entregas_resumo ADD COLUMN IF NOT EXISTS versao INT NOT NULL DEFAULT 1`))
      // Contratos com situação "Suspenso" no Omie (selo "Suspenso" do Risco). RLS ligado e sem policy: só o servidor lê (regra do projeto para tabela nova).
      .then(() => pool.query(`CREATE TABLE IF NOT EXISTS omie_contratos_suspensos (
        doc TEXT PRIMARY KEY, contrato TEXT, nome TEXT, atualizado_em TIMESTAMPTZ DEFAULT NOW())`))
      .then(() => pool.query(`ALTER TABLE omie_contratos_suspensos ENABLE ROW LEVEL SECURITY`))
      .catch((e) => { _schema = null; throw e; });
  }
  return _schema;
}

/**
 * Troca a lista de contratos suspensos no Omie (a lista inteira de uma vez: quem saiu da lista deixa de ser "Suspenso").
 * lista: [{ cnpj, contrato?, nome? }]. Só CNPJ (14 dígitos) entra, como no resto do Risco.
 */
async function gravarSuspensosOmie(lista) {
  await garantirSchema();
  const vistos = new Map();
  for (const x of lista || []) {
    const doc = soDigitos(x && x.cnpj);
    if (doc.length === 14) vistos.set(doc, { contrato: x.contrato ? String(x.contrato).slice(0, 40) : null, nome: x.nome ? String(x.nome).slice(0, 200) : null });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM omie_contratos_suspensos`);
    for (const [doc, v] of vistos) await client.query(`INSERT INTO omie_contratos_suspensos (doc, contrato, nome) VALUES ($1,$2,$3)`, [doc, v.contrato, v.nome]);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  return { suspensos: vistos.size };
}

function tokenSyncOk(req, res) {
  const esperado = process.env.LEGALIZACAO_SYNC_TOKEN || process.env.CERTISEGURO_SYNC_TOKEN;
  if (!esperado) { res.status(503).json({ error: 'Sincronização não configurada no servidor.' }); return false; }
  if (req.get('X-Sync-Token') !== esperado) { res.status(401).json({ error: 'Token de sincronização inválido.' }); return false; }
  return true;
}

/** Consulta tolerante: se uma fonte opcional (ex.: tabela da Gamificação) não existir, o termômetro segue sem ela. */
async function consultar(sql, params = [], rotulo = '') {
  try { return (await pool.query(sql, params)).rows; }
  catch (e) { console.warn(`[risco] consulta opcional falhou (${rotulo}):`, e.message); return null; }
}

async function lerConfig() {
  const { rows } = await pool.query(`SELECT valor FROM cs_config WHERE chave = $1`, [CHAVE_CONFIG]);
  const padrao = { pesos: { ...calc.PESOS_PADRAO }, cortes: { ...calc.CORTES_PADRAO } };
  if (!rows.length) return padrao;
  try {
    const c = JSON.parse(rows[0].valor);
    const pesos = {}; calc.TERMOMETROS.forEach((t) => { pesos[t] = Number(c.pesos && c.pesos[t]) >= 0 ? Number(c.pesos[t]) : 1; });
    const cortes = { medio: Number(c.cortes && c.cortes.medio), alto: Number(c.cortes && c.cortes.alto) };
    if (!(cortes.medio > 0 && cortes.alto > cortes.medio)) return padrao;
    return { pesos, cortes };
  } catch (e) { return padrao; }
}

const agrupar = (linhas, chave) => { const m = new Map(); (linhas || []).forEach((l) => { const k = l[chave]; if (!m.has(k)) m.set(k, []); m.get(k).push(l); }); return m; };

/** detalhes:true acrescenta, em cada cliente, o texto de cada termômetro (usado pela página /cs). */
async function calcularTodos({ detalhes = false } = {}) {
  await garantirSchema();
  const hoje = hojeBrasilia();
  const config = await lerConfig();

  let clientes = await consultar(`SELECT c.id, c.nome_empresa AS nome, c.cnpj, COALESCE(c.inadimplente_cronico, false) AS cronico FROM clientes c WHERE c.status = 'ativo'`, [], 'clientes');
  if (!clientes) clientes = await consultar(`SELECT c.id, c.nome_empresa AS nome, c.cnpj, false AS cronico FROM clientes c WHERE c.status = 'ativo'`, [], 'clientes (sem crônico)') || [];
  // Só CNPJ entra no Risco (06/10/2026, Reysner): CPF, CAEPF, CNO e cadastro sem documento ficam de fora.
  const totalAtivos = clientes.length;
  clientes = clientes.filter((c) => ehPessoaJuridica(c.cnpj));
  const desconsiderados = totalAtivos - clientes.length;

  const aberto = new Map(((await consultar(
    `SELECT regexp_replace(cnpj, '\\D', '', 'g') AS doc, SUM(qtd_atrasados)::int AS qtd, SUM(valor_atrasado)::float AS valor,
            to_char(MIN(mais_antigo), 'YYYY-MM-DD') AS mais_antigo FROM financeiro_aberto GROUP BY 1`, [], 'financeiro_aberto')) || []).map((r) => [r.doc, r]));
  const coberto = new Set(((await consultar(`SELECT DISTINCT regexp_replace(cnpj, '\\D', '', 'g') AS doc FROM financeiro_clientes`, [], 'financeiro_clientes')) || []).map((r) => r.doc));

  const insat = agrupar(await consultar(
    `SELECT regexp_replace(cnpj, '\\D', '', 'g') AS doc, gravidade, (CURRENT_DATE - created_at::date)::int AS dias FROM insatisfacoes WHERE created_at >= NOW() - INTERVAL '180 days'`, [], 'insatisfacoes'), 'doc');
  const sensiveis = agrupar(await consultar(
    `SELECT regexp_replace(cnpj, '\\D', '', 'g') AS doc, gravidade, (CURRENT_DATE - created_at::date)::int AS dias FROM clientes_sensiveis WHERE created_at >= NOW() - INTERVAL '90 days'`, [], 'clientes_sensiveis'), 'doc');
  const detratores = new Map(((await consultar(
    `SELECT doc, COUNT(*)::int AS n FROM (SELECT regexp_replace(cnpj, '\\D', '', 'g') AS doc FROM pesquisas WHERE nps <= 6 AND created_at >= NOW() - INTERVAL '180 days') x GROUP BY doc`, [], 'pesquisas')) || []).map((r) => [r.doc, r.n]));

  // Zappy depois da revisão da Gamificação; se as colunas/tabelas de revisão não existirem, cai na versão sem exclusões.
  const zappyComRevisao = `
    SELECT v.cliente_id,
           COUNT(*)::int AS tickets90,
           COUNT(*) FILTER (WHERE t.nota_avaliacao <= 2 AND COALESCE(t.revisao_nota_status, 'pendente') <> 'indevida')::int AS notas_baixas,
           COUNT(*) FILTER (WHERE t.pior_status = 'vermelho'
             AND NOT (EXISTS (SELECT 1 FROM gam_velocidade_revisoes r WHERE r.ticket_id = t.id AND r.status = 'indevida')
                      AND NOT EXISTS (SELECT 1 FROM gam_velocidade_revisoes r WHERE r.ticket_id = t.id AND r.status <> 'indevida')))::int AS sla_vermelho
      FROM cs_tickets t JOIN cs_vinculos v ON v.id = t.vinculo_id
     WHERE v.tipo = 'cliente' AND v.cliente_id IS NOT NULL AND t.abertura >= NOW() - INTERVAL '90 days'
     GROUP BY v.cliente_id`;
  const zappySemRevisao = `
    SELECT v.cliente_id, COUNT(*)::int AS tickets90,
           COUNT(*) FILTER (WHERE t.nota_avaliacao <= 2)::int AS notas_baixas,
           COUNT(*) FILTER (WHERE t.pior_status = 'vermelho')::int AS sla_vermelho
      FROM cs_tickets t JOIN cs_vinculos v ON v.id = t.vinculo_id
     WHERE v.tipo = 'cliente' AND v.cliente_id IS NOT NULL AND t.abertura >= NOW() - INTERVAL '90 days'
     GROUP BY v.cliente_id`;
  let zappyRows = await consultar(zappyComRevisao, [], 'zappy com revisão');
  if (!zappyRows) zappyRows = await consultar(zappySemRevisao, [], 'zappy sem revisão') || [];
  const zappy = new Map(zappyRows.map((r) => [r.cliente_id, r]));

  const abandonos = new Map(((await consultar(
    `SELECT v.cliente_id, COUNT(*)::int AS n
       FROM gam_abandono_incidentes a JOIN cs_tickets t ON t.id = a.ticket_id JOIN cs_vinculos v ON v.id = t.vinculo_id
      WHERE v.tipo = 'cliente' AND v.cliente_id IS NOT NULL AND a.data >= CURRENT_DATE - 90 AND a.status <> 'indevida'
      GROUP BY v.cliente_id`, [], 'abandonos')) || []).map((r) => [r.cliente_id, r.n]));

  const entregas = new Map(((await consultar(`SELECT doc, total, atrasadas_entregues, vencidas_pendentes FROM cliente_entregas_resumo`, [], 'entregas')) || []).map((r) => [r.doc, r]));

  // Suspensos = contrato com situação "Suspenso" no Omie (decisão do Reysner, 08/10/2026: só o Omie vale, não a TAG do Acessórias).
  const suspensos = new Set(((await consultar(`SELECT doc FROM omie_contratos_suspensos`, [], 'suspensos do Omie')) || []).map((r) => r.doc));

  const data = {};
  const resumo = { Alto: 0, 'Médio': 0, Baixo: 0, Incompleto: 0 };
  let totalSuspensos = 0; // já contados no nível de cada um
  for (const c of clientes) {
    const doc = soDigitos(c.cnpj);
    const ab = aberto.get(doc);
    const z = zappy.get(c.id) || {};
    const e = entregas.get(doc);
    const suspenso = suspensos.has(doc);
    const termometros = {
      financeiro: calc.termometroFinanceiro({ temDado: coberto.has(doc) || !!ab, qtdAtrasados: ab ? ab.qtd : 0, valorAtrasado: ab ? ab.valor : 0, maisAntigo: ab ? ab.mais_antigo : null, cronico: c.cronico, hoje }),
      atendimento: calc.termometroAtendimento({
        insatisfacoes: insat.get(doc) || [], sensiveis: sensiveis.get(doc) || [], notasBaixas: z.notas_baixas || 0,
        slaVermelho: z.sla_vermelho || 0, abandonos: abandonos.get(c.id) || 0, detratores: detratores.get(doc) || 0, tickets90: z.tickets90 || 0,
      }),
      operacional: calc.termometroOperacional({ temDado: !!e, total: e ? e.total : 0, atrasadasEntregues: e ? e.atrasadas_entregues : 0, vencidasPendentes: e ? e.vencidas_pendentes : 0, suspenso }),
    };
    const r = calc.calcularRisco(termometros, config.pesos, config.cortes);
    // Cliente SUSPENSO (contrato suspenso no Omie) NÃO conta em risco (Reysner, 09/10/2026): fica com nível "Suspenso", sem pontos, fora de Alto/Médio/Baixo,
    // das contagens e da foto dos laudos. Os termômetros continuam calculados só para a ficha mostrar o que aconteceu.
    if (suspenso) totalSuspensos++; else resumo[r.nivel]++;
    data[c.id] = {
      pontos: suspenso ? null : r.pontos, nivel: suspenso ? 'Suspenso' : r.nivel, parcial: r.parcial, sem_dado: r.sem_dado, alerta: suspenso ? false : r.alerta, suspenso,
      motivos: suspenso ? ['Contrato suspenso no Omie', ...r.motivos] : r.motivos,
      termometros: Object.fromEntries(calc.TERMOMETROS.map((t) => [t, termometros[t].pontos])),
    };
    if (detalhes) data[c.id].detalhes = Object.fromEntries(calc.TERMOMETROS.map((t) => [t, termometros[t].detalhe || []]));
  }
  return { config, data, resumo, suspensos: totalSuspensos, operacional_lido: entregas.size, desconsiderados_nao_cnpj: desconsiderados };
}

// ── Entregas do Acessórias (Operacional) ─────────────────────────────────────
/**
 * Só entra no Operacional o que CHEGA AO CLIENTE (decisão do Reysner, 07/10/2026: "só as entregas que chegam ao cliente").
 * Levantamento em 55 empresas mostrou muito ruído de tarefas internas (BALANCETE 52 de 52 "atrasada", NIVER SOCIO,
 * RENOVAR CERTIFICADO, CADASTRO..., relatórios de férias/consignado). Critério:
 *  1) nunca: tarefas internas (EXCLUIR);  2) sempre: entrega com multa no Acessórias (guias e declarações);
 *  3) também: folha, FGTS, DCTFWeb, INSS, EFD, PGDAS, DIRB e as "para o e-mail do cliente" (INCLUIR), que não têm multa cadastrada.
 */
const ENTREGA_EXCLUIR = /BALANCETE|NIVER|RENOVAR|CADASTRO|DUPLICAR|COMUNICAR|ALVAR[AÁ]|AO FISCAL/;
const ENTREGA_INCLUIR = /FGTS|FOLHA|SAL[AÁ]RIO|DCTFWEB|INSS|EFD|PGDAS|DIRB|CLIENTE/;
function entregaChegaAoCliente(e) {
  const nome = String((e && e.nome) || '').toUpperCase();
  if (ENTREGA_EXCLUIR.test(nome)) return false;
  return !!(e && e.multa) || ENTREGA_INCLUIR.test(nome);
}

/**
 * Conta, a partir do Status que o próprio Acessórias informa (valores vistos: "Ent. antecipada", "Ent. PzTéc",
 * "Ent. atrasada", "Atrasada!", "Pendente", "Dispensada"). "Ent. PzTéc" = entregue depois do prazo técnico (interno)
 * mas dentro do prazo legal → NÃO é atraso. Dispensada não é entrega devida.
 */
function classificarEntregas(lista, hoje) {
  let total = 0, atrasadasEntregues = 0, vencidasPendentes = 0;
  for (const e of lista || []) {
    if (!entregaChegaAoCliente(e)) continue;
    const st = String(e.status || '').toLowerCase();
    if (st.includes('dispensada')) continue;
    total++;
    if (st.includes('ent. atrasada')) atrasadasEntregues++;
    else if (st.includes('atrasada!')) vencidasPendentes++;
    else if (!e.entrega && (e.atraso || e.prazo) && (e.atraso || e.prazo) < hoje) vencidasPendentes++; // pendente já vencida
  }
  return { total, atrasadasEntregues, vencidasPendentes };
}

let _sincronizando = false;
async function sincronizarEntregas({ limite = 200 } = {}) {
  const token = process.env.ACESSORIAS_API_TOKEN;
  if (!token) throw new Error('ACESSORIAS_API_TOKEN não configurado.');
  if (_sincronizando) throw new Error('Já existe uma leitura de entregas em andamento.');
  _sincronizando = true;
  try {
    await garantirSchema();
    const hoje = hojeBrasilia(), ini = somarDias(hoje, -90);
    const { rows } = await pool.query(
      `SELECT c.cnpj FROM clientes c
         LEFT JOIN cliente_entregas_resumo r ON r.doc = regexp_replace(c.cnpj, '\\D', '', 'g')
        WHERE c.status = 'ativo' AND c.cnpj IS NOT NULL AND length(regexp_replace(c.cnpj, '\\D', '', 'g')) = 14
          AND c.cnpj !~ '^[0-9]{3}[.][0-9]{3}[.][0-9]{3}/[0-9]{3}-[0-9]{2}$'
          AND (r.atualizado_em IS NULL OR r.versao < $2 OR r.atualizado_em < NOW() - INTERVAL '6 days')
        ORDER BY r.atualizado_em NULLS FIRST LIMIT $1`, [limite, VERSAO_LEITURA]
    );
    const resumo = { em: new Date().toISOString(), lidas: 0, com_entregas: 0, sem_entregas: 0, erros: 0 };
    for (const c of rows) {
      try {
        const lista = await acessorias.listarEntregasEmpresa(c.cnpj, { token, ini, fim: hoje });
        const r = classificarEntregas(lista, hoje);
        await pool.query(
          `INSERT INTO cliente_entregas_resumo (doc, total, atrasadas_entregues, vencidas_pendentes, janela_ini, janela_fim, atualizado_em, versao)
           VALUES ($1,$2,$3,$4,$5,$6,NOW(),$7)
           ON CONFLICT (doc) DO UPDATE SET total = $2, atrasadas_entregues = $3, vencidas_pendentes = $4, janela_ini = $5, janela_fim = $6, atualizado_em = NOW(), versao = $7`,
          [soDigitos(c.cnpj), r.total, r.atrasadasEntregues, r.vencidasPendentes, ini, hoje, VERSAO_LEITURA]
        );
        resumo.lidas++; if (r.total) resumo.com_entregas++; else resumo.sem_entregas++;
      } catch (e) { resumo.erros++; if (!resumo.exemplo_de_erro) { resumo.exemplo_de_erro = String(e.message || e).slice(0, 200); console.warn('[risco] leitura de entregas falhou:', resumo.exemplo_de_erro); } }
      await esperar(700);
    }
    await pool.query(
      `INSERT INTO cs_config (chave, valor, updated_at) VALUES ($1,$2,NOW()) ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor, updated_at = NOW()`,
      [CHAVE_SYNC_ENTREGAS, JSON.stringify(resumo)]
    );
    return resumo;
  } finally { _sincronizando = false; }
}

// ── Foto diária do risco ─────────────────────────────────────────────────────
/**
 * Guarda em cs_config a lista de clientes em risco Alto ou Médio (a mesma que a página /cs mostra), uma vez por dia.
 * Serve de fonte única para quem precisa dessa lista fora do sistema (laudos mensais de atendimento) e de histórico
 * para ver a evolução do risco. 'risco_foto_ultima' = a mais recente; 'risco_foto_AAAA-MM-DD' = uma por dia (guarda 120 dias).
 */
async function salvarFoto() {
  const r = await calcularTodos({ detalhes: false });
  const { rows: cli } = await pool.query(`SELECT id, nome_empresa AS nome, cnpj FROM clientes WHERE status = 'ativo'`);
  const porId = new Map(cli.map((c) => [c.id, c]));
  const hoje = hojeBrasilia();
  const clientes = [];
  for (const [id, x] of Object.entries(r.data)) {
    if (x.nivel !== 'Alto' && x.nivel !== 'Médio') continue;
    const c = porId.get(id); if (!c) continue;
    clientes.push({ id, nome: c.nome, cnpj: c.cnpj, nivel: x.nivel, pontos: x.pontos, alerta: x.alerta, suspenso: !!x.suspenso, termometros: x.termometros, motivos: x.motivos });
  }
  clientes.sort((a, b) => (b.pontos || 0) - (a.pontos || 0));
  const foto = { data: hoje, gerado_em: new Date().toISOString(), config: r.config, resumo: r.resumo, clientes };
  const json = JSON.stringify(foto);
  const gravar = (chave) => pool.query(
    `INSERT INTO cs_config (chave, valor, updated_at) VALUES ($1,$2,NOW()) ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor, updated_at = NOW()`, [chave, json]);
  await gravar('risco_foto_ultima');
  await gravar('risco_foto_' + hoje);
  await pool.query(`DELETE FROM cs_config WHERE chave ~ '^risco_foto_[0-9]{4}-[0-9]{2}-[0-9]{2}$' AND chave < $1`, ['risco_foto_' + somarDias(hoje, -120)]);
  return { data: hoje, clientes: clientes.length, resumo: r.resumo };
}

// ── Rotas ────────────────────────────────────────────────────────────────────
const router = express.Router();

// Lista de contratos "Suspenso" do Omie (token de sincronização, como as demais cargas do Omie). Substitui a lista inteira.
router.post('/suspensos-omie', async (req, res) => {
  if (!tokenSyncOk(req, res)) return;
  if (!Array.isArray(req.body && req.body.contratos)) return res.status(400).json({ error: 'Informe contratos: [{ cnpj, contrato, nome }].' });
  try { res.json({ ok: true, ...(await gravarSuspensosOmie(req.body.contratos)) }); }
  catch (err) { console.error('[risco] POST /suspensos-omie falhou:', err); res.status(500).json({ error: 'Erro ao gravar os contratos suspensos.' }); }
});

router.post('/foto', requireAuth, requireAdmin, async (req, res) => {
  try { res.json({ ok: true, ...(await salvarFoto()) }); }
  catch (err) { console.error('[risco] POST /foto falhou:', err); res.status(500).json({ error: 'Erro ao gravar a foto do risco.' }); }
});

router.get('/', requireAuth, async (req, res) => {
  try { res.json(await calcularTodos()); }
  catch (err) { console.error('[risco] GET / falhou:', err); res.status(500).json({ error: 'Erro ao calcular o risco.' }); }
});

router.get('/config', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT valor FROM cs_config WHERE chave = $1`, [CHAVE_SYNC_ENTREGAS]);
    let sync = null; try { sync = rows.length ? JSON.parse(rows[0].valor) : null; } catch (e) { /* sem leitura */ }
    res.json({ ...(await lerConfig()), entregas_sincronizadas: sync, sincronizando: _sincronizando });
  } catch (err) { console.error('[risco] GET /config falhou:', err); res.status(500).json({ error: 'Erro ao carregar a configuração do risco.' }); }
});

router.put('/config', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { pesos, cortes } = req.body || {};
    const p = {}; calc.TERMOMETROS.forEach((t) => { p[t] = Number(pesos && pesos[t]); });
    if (!calc.TERMOMETROS.every((t) => p[t] >= 0) || calc.TERMOMETROS.every((t) => p[t] === 0)) return res.status(400).json({ error: 'Informe pesos de 0 em diante (ao menos um maior que zero).' });
    const c = { medio: Number(cortes && cortes.medio), alto: Number(cortes && cortes.alto) };
    if (!(c.medio > 0 && c.alto > c.medio && c.alto <= 100)) return res.status(400).json({ error: 'Os cortes precisam estar em ordem: Médio < Alto, até 100.' });
    await pool.query(
      `INSERT INTO cs_config (chave, valor, updated_at) VALUES ($1,$2,NOW()) ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor, updated_at = NOW()`,
      [CHAVE_CONFIG, JSON.stringify({ pesos: p, cortes: c })]
    );
    res.json({ ok: true });
  } catch (err) { console.error('[risco] PUT /config falhou:', err); res.status(500).json({ error: 'Erro ao salvar a configuração do risco.' }); }
});

router.post('/sincronizar-entregas', requireAuth, requireAdmin, (req, res) => {
  if (_sincronizando) return res.status(409).json({ error: 'Já existe uma leitura de entregas em andamento.' });
  if (!process.env.ACESSORIAS_API_TOKEN) return res.status(400).json({ error: 'ACESSORIAS_API_TOKEN não configurado.' });
  sincronizarEntregas()
    .then((r) => console.log('[risco] Entregas lidas do Acessórias:', r))
    .catch((e) => console.error('[risco] Falha ao ler entregas do Acessórias:', e.message));
  res.json({ ok: true, mensagem: 'Leitura das entregas iniciada em segundo plano (200 empresas por rodada). Reabra a tela daqui a alguns minutos.' });
});

module.exports = { router, calcularTodos, gravarSuspensosOmie, sincronizarEntregas, classificarEntregas, entregaChegaAoCliente, salvarFoto };
