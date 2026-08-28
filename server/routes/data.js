'use strict';
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../db');
const { requireAuth, requireAdmin, hashPassword, revokeAllUserTokens } = require('../auth');
const acessoriasClient = require('../acessoriasClient');
const { criarClienteZappy } = require('../cs/zappyClient');
const { ensurePontuacaoSchema, recalcularPontosDoMes, clamp } = require('../cs/pontuacao');

const router = express.Router();
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
async function sincronizarAcessorias({ userId = null } = {}) {
  const token = process.env.ACESSORIAS_API_TOKEN;
  if (!token) throw new Error('ACESSORIAS_API_TOKEN não configurado.');

  await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS acessorias_id TEXT`).catch(() => {});
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
             alerta_baixa_notificado_em = NULL
           WHERE id = $5`,
          [emp.nome_empresa, emp.regime_tributario, emp.codigo, emp.acessorias_id, existente.rows[0].id]
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
          `INSERT INTO clientes (id, user_id, cnpj, nome_empresa, regime_tributario, data_entrada, acessorias_id, codigo, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'ativo')`,
          [clienteId, userIdEfetivo, emp.cnpj, emp.nome_empresa, emp.regime_tributario, emp.data_entrada, emp.acessorias_id, emp.codigo]
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
      WHERE status = 'ativo' AND acessorias_id IS NOT NULL AND alerta_baixa_notificado_em IS NULL`
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
 * Palpite (baixa|saida|null) a partir do motivo de cancelamento BRUTO do
 * Acessórias — achado do Reysner: lá só existem 2 valores, "Baixada" (não
 * é churn de verdade) e "Transferência por conveniência" (churn de verdade
 * — foi pra outro contador). Só entra no TEXTO da notificação como dica;
 * quem confirma de vez é sempre humano, ver PATCH /clientes/:id/resolver-churn.
 */
function palpiteTipoChurn(motivoBruto) {
  const m = String(motivoBruto || '').toLowerCase();
  if (!m) return null;
  if (m.includes('transferencia') || m.includes('transferência')) return 'saida';
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
            ? ' (Acessórias registrou como Transferência por conveniência — provável Saída/churn real.)'
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
    res.json({
      mrr: mrrVal,
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
    eventos, investimentos, notificacoes, log
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
  ]);

  return {
    meta: {
      sistema: 'Grupo-E',
      gerado_em: new Date().toISOString(),
      versao: '1.0',
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

    const pesoR = await pool.query(`SELECT valor FROM gam_config WHERE chave = 'peso_minimo'`);
    const pesoMinimo = pesoR.rows[0] ? parseFloat(pesoR.rows[0].valor) : 10;

    // Liga/desliga o card "Consolidado Geral" na página pública, controlado
    // pelo painel interno da Gamificação (pedido da Thais). Desligado, pula
    // o cálculo inteiro (evita recalcular nota final mês a mês à toa).
    const mostrarR = await pool.query(`SELECT valor FROM gam_config WHERE chave = 'mostrar_consolidado'`);
    const mostrarConsolidado = mostrarR.rows[0] ? parseFloat(mostrarR.rows[0].valor) !== 0 : true;

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

    // 2º passo: menor nota FINAL (após fórmula) — é o que os zerados recebem
    const menorNotaFinal = comNotaFinal.length ? Math.min(...comNotaFinal.map(r => r.media)) : 0;

    // 3º passo: zerados recebem a menor nota final
    const semNotaFinal = dadosMes.rows
      .filter(r => parseInt(r.avaliacoes) === 0)
      .map(r => ({ id: r.id, nome: r.nome, media: menorNotaFinal, mediaIndividual: 0, avaliacoes: 0 }));

    // Ranking completo ordenado por nota final
    const ranking = [...comNotaFinal, ...semNotaFinal]
      .map(r => ({ ...r, media: parseFloat(r.media).toFixed(2) }))
      .sort((a,b) => {
        // Critério principal: maior nota final
        const diff = parseFloat(b.media) - parseFloat(a.media);
        if (Math.abs(diff) >= 0.005) return diff;
        // Desempate 1: maior número de avaliações
        if (b.avaliacoes !== a.avaliacoes) return b.avaliacoes - a.avaliacoes;
        // Desempate 2: maior média individual
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
          media_geral: media.toFixed(2),
          meses_avaliados: notas.length,
          total_avaliacoes: 0
        };
      }).sort((a,b) => {
        const diff = parseFloat(b.media_geral) - parseFloat(a.media_geral);
        if (Math.abs(diff) >= 0.005) return diff;
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
}

async function getPesoMinimo() {
  const r = await pool.query(`SELECT valor FROM gam_config WHERE chave = 'peso_minimo'`);
  return r.rows[0] ? parseFloat(r.rows[0].valor) : 10;
}

async function getMostrarConsolidado() {
  const r = await pool.query(`SELECT valor FROM gam_config WHERE chave = 'mostrar_consolidado'`);
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
    res.json({ peso_minimo: peso, mostrar_consolidado: mostrarConsolidado });
  } catch (err) { res.status(500).json({ error: 'Erro ao buscar configuração.' }); }
});

// Aceita peso_minimo e/ou mostrar_consolidado — parcial, só grava o que veio
// no corpo (o botão de ligar/desligar o Consolidado não deve exigir reenviar
// o peso mínimo, e vice-versa).
router.patch('/gam/config', requireAdmin, async (req, res) => {
  try {
    const { peso_minimo, mostrar_consolidado } = req.body;
    if (peso_minimo == null && mostrar_consolidado == null) {
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
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Erro ao salvar configuração.' }); }
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
  if (!mes || !/^\d{4}-\d{2}$/.test(mes)) throw new Error('Informe "mes" no formato AAAA-MM.');

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
      const { rows: notasRows } = await pool.query(
        `SELECT p.nota_final, p.nota_cliente, p.ajuste_velocidade, p.ajuste_finalizar, p.ajuste_reabertura,
                COALESCE(vr.status, 'pendente') AS vel_status,
                COALESCE(fr.status, 'pendente') AS finalizar_status
         FROM gam_tickets_pontos p
         JOIN cs_tickets t ON t.id = p.ticket_id
         LEFT JOIN gam_velocidade_revisoes vr ON vr.ticket_id = p.ticket_id AND vr.papel = p.papel
         LEFT JOIN gam_finalizar_revisoes fr ON fr.ticket_id = p.ticket_id AND fr.papel = p.papel
         WHERE p.mes = $1 AND p.analista_id = $2 AND p.papel IN ('recebeu','unico')
           AND COALESCE(t.revisao_nota_status, 'pendente') != 'indevida'`,
        [mes, c.zappy_user_id]
      );
      if (notasRows.length) {
        const { rows: bonusRows } = await pool.query(
          `SELECT p.ajuste_velocidade FROM gam_tickets_pontos p
           LEFT JOIN gam_velocidade_revisoes vr ON vr.ticket_id = p.ticket_id AND vr.papel = p.papel
           WHERE p.mes = $1 AND p.analista_id = $2 AND p.papel = 'transferiu'
             AND COALESCE(vr.status, 'pendente') != 'indevida'`,
          [mes, c.zappy_user_id]
        );
        const bonusTransferencia = bonusRows.length
          ? bonusRows.reduce((s, r) => s + parseFloat(r.ajuste_velocidade), 0) / bonusRows.length
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
        // dever entrar na amostra da métrica.
        let bonusAceite = 0;
        if (c.aplica_regra_aceite) {
          const { rows: aceiteRows } = await pool.query(
            `SELECT p.ajuste_aceite FROM gam_tickets_pontos p
             LEFT JOIN gam_aceite_revisoes ar ON ar.ticket_id = p.ticket_id AND ar.papel = p.papel
             WHERE p.mes = $1 AND p.analista_id = $2 AND p.papel IN ('transferiu','unico')
               AND p.ajuste_aceite IS NOT NULL
               AND COALESCE(ar.status, 'pendente') != 'indevida'`,
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
        // mascare o desconto. Reaproveita notasRows (já traz
        // ajuste_finalizar + finalizar_status) — mesmo conjunto de tickets
        // (recebeu/unico, nota não-indevida) que forma a mediaBase logo
        // abaixo. gam_finalizar_revisoes: exclui reaberturas que não
        // refletiam um encerramento mal feito (ex.: cliente voltou por um
        // assunto novo, sem relação com o fechamento).
        const finalizarValidos = notasRows.filter(r => r.finalizar_status !== 'indevida');
        const bonusFinalizar = finalizarValidos.length
          ? finalizarValidos.reduce((s, r) => s + parseFloat(r.ajuste_finalizar), 0) / finalizarValidos.length
          : 0;

        const somaBase = notasRows.reduce((s, r) => {
          if (r.vel_status === 'indevida') {
            const semVelocidade = clamp(parseFloat(r.nota_cliente) + 0 + parseFloat(r.ajuste_reabertura), 0, 5);
            return s + semVelocidade;
          }
          return s + parseFloat(r.nota_final);
        }, 0);
        const mediaBase = somaBase / notasRows.length;
        const media_individual = Number(Math.max(0, Math.min(5, mediaBase + bonusTransferencia + bonusAceite + bonusFinalizar)).toFixed(2));
        // mediaBase exposta pra transparência (ver GET /gam/composicao-nota)
        // — é a nota bruta antes dos 3 bônus mensais, pra dar pra mostrar
        // "sua nota final é X porque: base Y + transferência Z + aceite W +
        // finalizar V", em vez desses números ficarem só numa resposta crua.
        resultados.push({ colaborador_id: c.id, nome: c.nome, media_individual, avaliacoes: notasRows.length, mediaBase: Number(mediaBase.toFixed(2)), bonusTransferencia, bonusAceite, bonusFinalizar, fonte: 'tickets' });
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
      resultados.push({ colaborador_id: c.id, nome: c.nome, media_individual, avaliacoes, detalhamento, fonte: 'qualificacao' });

      if (!dryRun) {
        if (media_individual != null && avaliacoes > 0) {
          await pool.query(
            `INSERT INTO gam_notas (colaborador_id, mes, media_individual, avaliacoes, lancado_por)
             VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (colaborador_id, mes)
             DO UPDATE SET media_individual=$3, avaliacoes=$4, lancado_por=$5, updated_at=NOW()`,
            [c.id, mes, media_individual, avaliacoes, `Automático (Zappy) — ${lancadoPor}`]
          );
        } else {
          // Sem nota nenhuma (nem tickets, nem qualificação) — grava
          // avaliacoes=0 mesmo assim, senão o colaborador some da consulta
          // do ranking (INNER JOIN em gam_notas) e nunca recebe a "menor
          // nota do grupo" — regra que já existe pro Modelo Inicial e o
          // Reysner confirmou que vale igual pro Modelo Atualizado.
          await pool.query(
            `INSERT INTO gam_notas (colaborador_id, mes, media_individual, avaliacoes, lancado_por)
             VALUES ($1,$2,0,0,$3)
             ON CONFLICT (colaborador_id, mes)
             DO UPDATE SET media_individual=0, avaliacoes=0, lancado_por=$3, updated_at=NOW()`,
            [c.id, mes, `Automático (Zappy) — ${lancadoPor}`]
          );
        }
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
              t.zappy_id, t.empresa_texto, t.encerramento, t.revisao_nota_status
       FROM gam_tickets_pontos p
       JOIN cs_tickets t ON t.id = p.ticket_id
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
    const { mes, colaborador_id } = req.query;
    if (!mes || !/^\d{4}-\d{2}$/.test(mes)) return res.status(400).json({ error: 'Informe "mes" no formato AAAA-MM.' });
    if (!colaborador_id) return res.status(400).json({ error: 'Informe "colaborador_id".' });

    const { rows: colabRows } = await pool.query(
      `SELECT nome, zappy_user_id FROM gam_colaboradores WHERE id = $1`, [colaborador_id]
    );
    if (!colabRows.length) return res.status(404).json({ error: 'Colaborador não encontrado.' });
    if (!colabRows[0].zappy_user_id) return res.json({ colaborador: colabRows[0].nome, mes, tickets: [], aviso: 'Colaborador ainda não vinculado a um usuário do Zappy.' });

    const { rows } = await pool.query(
      `SELECT p.papel, p.nota_cliente, p.ajuste_velocidade, p.ajuste_finalizar, p.ajuste_reabertura, p.ajuste_aceite, p.nota_final,
              t.zappy_id, t.empresa_texto, t.encerramento, t.revisao_nota_status
       FROM gam_tickets_pontos p
       JOIN cs_tickets t ON t.id = p.ticket_id
       WHERE p.mes = $1 AND p.analista_id = $2
       ORDER BY t.encerramento DESC NULLS LAST`,
      [mes, colabRows[0].zappy_user_id]
    );
    res.json({ colaborador: colabRows[0].nome, mes, tickets: rows });
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
      `SELECT id, zappy_id, empresa_texto, analista, nota_avaliacao AS nota_cliente, encerramento,
              revisao_nota_status, revisao_nota_por, revisao_nota_em,
              (nota_avaliacao < 5) AS nota_baixa
       FROM cs_tickets
       WHERE nota_avaliacao IS NOT NULL
         AND COALESCE(revisao_nota_status, 'pendente') = $2
         AND TO_CHAR(COALESCE(encerramento, abertura), 'YYYY-MM') = $1
         AND (nota_avaliacao < 5${condicaoInterno})
       ORDER BY encerramento DESC NULLS LAST`,
      params
    );
    res.json({ data: rows });
  } catch (err) {
    console.error('[gam] tickets-revisao falhou:', err);
    res.status(500).json({ error: 'Erro ao listar tickets para revisão.' });
  }
});

router.patch('/gam/tickets-revisao/:id', requireAdmin, async (req, res) => {
  try {
    const { status_revisao } = req.body;
    if (!['devida', 'indevida'].includes(status_revisao)) {
      return res.status(400).json({ error: 'status_revisao deve ser "devida" ou "indevida".' });
    }
    const { rows } = await pool.query(
      `UPDATE cs_tickets SET revisao_nota_status = $2, revisao_nota_por = $3, revisao_nota_em = NOW() WHERE id = $1 RETURNING id`,
      [req.params.id, status_revisao, req.user.name]
    );
    if (!rows.length) return res.status(404).json({ error: 'Não encontrado.' });
    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    console.error('[gam] PATCH tickets-revisao falhou:', err);
    res.status(500).json({ error: 'Erro ao salvar revisão.' });
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
              vr.status AS revisao_status, vr.revisado_por, vr.revisado_em
         FROM gam_tickets_pontos p
         JOIN cs_tickets t ON t.id = p.ticket_id
         LEFT JOIN gam_velocidade_revisoes vr ON vr.ticket_id = p.ticket_id AND vr.papel = p.papel
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

/** PATCH /api/data/gam/tickets-revisao-velocidade/:ticketId/:papel — marca devida/indevida. */
router.patch('/gam/tickets-revisao-velocidade/:ticketId/:papel', requireAdmin, async (req, res) => {
  try {
    const { status_revisao } = req.body;
    if (!['devida', 'indevida'].includes(status_revisao)) {
      return res.status(400).json({ error: 'status_revisao deve ser "devida" ou "indevida".' });
    }
    const { papel } = req.params;
    if (!['transferiu', 'recebeu', 'unico'].includes(papel)) {
      return res.status(400).json({ error: 'papel inválido.' });
    }
    await ensureGamTables();
    const { rows } = await pool.query(
      `INSERT INTO gam_velocidade_revisoes (ticket_id, papel, status, revisado_por, revisado_em)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (ticket_id, papel) DO UPDATE SET
         status = $3, revisado_por = $4, revisado_em = NOW()
       RETURNING id`,
      [req.params.ticketId, papel, status_revisao, req.user.name]
    );
    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    console.error('[gam] PATCH tickets-revisao-velocidade falhou:', err);
    res.status(500).json({ error: 'Erro ao salvar revisão de velocidade.' });
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
              ar.status AS revisao_status, ar.revisado_por, ar.revisado_em
         FROM gam_tickets_pontos p
         JOIN cs_tickets t ON t.id = p.ticket_id
         JOIN gam_colaboradores c ON c.zappy_user_id = p.analista_id
         LEFT JOIN gam_aceite_revisoes ar ON ar.ticket_id = p.ticket_id AND ar.papel = p.papel
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

/** PATCH /api/data/gam/tickets-revisao-aceite/:ticketId/:papel — marca devida/indevida. */
router.patch('/gam/tickets-revisao-aceite/:ticketId/:papel', requireAdmin, async (req, res) => {
  try {
    const { status_revisao } = req.body;
    if (!['devida', 'indevida'].includes(status_revisao)) {
      return res.status(400).json({ error: 'status_revisao deve ser "devida" ou "indevida".' });
    }
    const { papel } = req.params;
    if (!['transferiu', 'unico'].includes(papel)) {
      return res.status(400).json({ error: 'papel inválido.' });
    }
    await ensureGamTables();
    const { rows } = await pool.query(
      `INSERT INTO gam_aceite_revisoes (ticket_id, papel, status, revisado_por, revisado_em)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (ticket_id, papel) DO UPDATE SET
         status = $3, revisado_por = $4, revisado_em = NOW()
       RETURNING id`,
      [req.params.ticketId, papel, status_revisao, req.user.name]
    );
    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    console.error('[gam] PATCH tickets-revisao-aceite falhou:', err);
    res.status(500).json({ error: 'Erro ao salvar revisão de aceite.' });
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
              fr.status AS revisao_status, fr.revisado_por, fr.revisado_em
         FROM gam_tickets_pontos p
         JOIN cs_tickets t ON t.id = p.ticket_id
         LEFT JOIN gam_finalizar_revisoes fr ON fr.ticket_id = p.ticket_id AND fr.papel = p.papel
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

/** PATCH /api/data/gam/tickets-revisao-finalizar/:ticketId/:papel — marca devida/indevida. */
router.patch('/gam/tickets-revisao-finalizar/:ticketId/:papel', requireAdmin, async (req, res) => {
  try {
    const { status_revisao } = req.body;
    if (!['devida', 'indevida'].includes(status_revisao)) {
      return res.status(400).json({ error: 'status_revisao deve ser "devida" ou "indevida".' });
    }
    const { papel } = req.params;
    if (!['recebeu', 'unico'].includes(papel)) {
      return res.status(400).json({ error: 'papel inválido.' });
    }
    await ensureGamTables();
    const { rows } = await pool.query(
      `INSERT INTO gam_finalizar_revisoes (ticket_id, papel, status, revisado_por, revisado_em)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (ticket_id, papel) DO UPDATE SET
         status = $3, revisado_por = $4, revisado_em = NOW()
       RETURNING id`,
      [req.params.ticketId, papel, status_revisao, req.user.name]
    );
    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    console.error('[gam] PATCH tickets-revisao-finalizar falhou:', err);
    res.status(500).json({ error: 'Erro ao salvar revisão de finalizar/reabertura.' });
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

// Criar ticket
router.post('/tickets', requireAdmin, async (req, res) => {
  try {
    await ensureTicketTables();
    const { gestao_id, empresa, cnpj, regime, tipo_movimentacao, observacoes, mencoes, dados_gestao } = req.body;
    if (!empresa || !cnpj || !regime || !tipo_movimentacao)
      return res.status(400).json({ error: 'Campos obrigatórios ausentes.' });
    const checklist = buildChecklist(tipo_movimentacao, regime);
    const { rows } = await pool.query(
      `INSERT INTO tickets (gestao_id, empresa, cnpj, regime, tipo_movimentacao, checklist, observacoes, criado_por, dados_gestao)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [gestao_id||null, empresa, cnpj, regime, tipo_movimentacao, JSON.stringify(checklist), observacoes||null, req.user.name, JSON.stringify(dados_gestao||{})]
    );
    const ticket = rows[0];
    // Admins são incluídos automaticamente em todos os tickets
    const adminsRes = await pool.query(`SELECT id FROM users WHERE role='administrador' AND active=1`);
    const adminIds = adminsRes.rows.map(r => r.id.toString());
    const todasMencoes = [...new Set([...(mencoes||[]), ...adminIds])];

    for (const uid of todasMencoes) {
      await pool.query(`INSERT INTO ticket_mencoes (ticket_id, usuario_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [ticket.id, uid]);
      await pool.query(
        `INSERT INTO notificacoes (user_id, tipo, mensagem, referencia_id)
         VALUES ($1,'ticket','Novo ticket aberto: '||$2,$3)`,
        [uid, empresa, ticket.id]
      ).catch(()=>{});
    }
    // Interação de abertura
    if (observacoes) {
      await pool.query(
        `INSERT INTO ticket_interacoes (ticket_id, autor_nome, comentario) VALUES ($1,$2,$3)`,
        [ticket.id, req.user.name, observacoes]
      );
    }
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

module.exports = router;


module.exports.publicRouter = publicRouter;
module.exports.registrarLog = registrarLog;
module.exports.sincronizarAcessorias = sincronizarAcessorias;
module.exports.executarAutoPreencher = executarAutoPreencher;
