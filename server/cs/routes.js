'use strict';
/**
 * Módulo Sucesso do Cliente — Rotas HTTP
 * ------------------------------------------------------------------
 * Como montar em server/index.js (arquivo que NÃO está neste pacote —
 * ver CONTEXTO_PROJETO_GRUPO_E.md seção 10). Ao lado de onde os outros
 * routers são registrados (ex.: perto de `app.use('/api/data', ...)`),
 * adicionar:
 *
 *     app.use('/api/cs', require('./cs/routes'));
 *
 * Endpoints:
 *   GET  /api/cs/dashboard                 -> totais/gráficos (status SLA, departamento, analista)
 *   GET  /api/cs/agora                    -> radar de tickets em risco (só vínculos tipo='cliente')
 *   GET  /api/cs/historico                 -> lista de tickets p/ tela de relatórios (filtros: departamento/analista/status)
 *   GET  /api/cs/filtros                   -> opções de departamento/analista já vistas, p/ popular os selects
 *   POST /api/cs/ingerir                   -> dispara a ingestão manualmente (admin)
 *   POST /api/cs/backfill?dias=90          -> carga retroativa única, roda em segundo plano (admin)
 *   GET  /api/cs/vinculos/pendentes        -> fila de de-para aguardando confirmação humana
 *   POST /api/cs/vinculos/:id/confirmar    -> confirma um vínculo (empresa/tipo)
 *
 * Autenticação: reusa server/auth.js (requireAuth/requireAdmin), no mesmo
 * padrão descrito no handoff. Se esse require falhar neste ambiente
 * (ex.: rodando fora do repo completo), cai num passthrough — isso é só
 * para não travar testes locais; NÃO deve acontecer em produção.
 */
const express = require('express');
const router = express.Router();
const { obterPool } = require('./pool');
const { ingerirTickets, executarCargaRetroativa } = require('./ingestao');
const { criarClienteZappy } = require('./zappyClient');
const { listarPendentes, confirmarVinculo } = require('./vinculos');

// Trava simples pra não deixar disparar 2 backfills ao mesmo tempo (ex.: duplo clique).
let backfillEmAndamento = false;

let requireAuth, requireAdmin;
try {
  ({ requireAuth, requireAdmin } = require('../auth'));
} catch (e) {
  console.warn('[cs/routes] server/auth.js não encontrado — rotas SEM autenticação. Corrigir antes de subir ao Render.');
  requireAuth = (req, res, next) => next();
  requireAdmin = (req, res, next) => next();
}

/** GET /api/cs/agora — radar de tickets fora do SLA, ordenado por gravidade. */
router.get('/agora', requireAuth, async (req, res) => {
  try {
    const pool = obterPool();
    const { rows } = await pool.query(`
      SELECT t.id, t.zappy_id, t.empresa_texto, v.empresa_nome, t.departamento,
             t.analista, t.status, t.pior_status, t.sla, t.abertura, t.updated_at
        FROM cs_tickets t
        JOIN cs_vinculos v ON v.id = t.vinculo_id
       WHERE t.em_risco = TRUE
         AND v.tipo = 'cliente'
       ORDER BY CASE t.pior_status
                  WHEN 'vermelho' THEN 3
                  WHEN 'amarelo'  THEN 2
                  ELSE 1
                END DESC,
                t.updated_at DESC
    `);
    res.json({ tickets: rows });
  } catch (e) {
    console.error('[cs] GET /agora falhou:', e);
    res.status(500).json({ error: 'Falha ao carregar o radar de tickets: ' + e.message });
  }
});

/**
 * GET /api/cs/historico?departamento=&analista=&status= — lista tickets (TODOS,
 * não só os em risco agora) para a tela de relatórios/histórico. `status` aqui
 * é o pior_status já calculado (vermelho/amarelo/verde). Limita a 500 linhas
 * mais recentes para não pesar a tela.
 */
router.get('/historico', requireAuth, async (req, res) => {
  try {
    const pool = obterPool();
    const { departamento, analista, status } = req.query;
    const condicoes = [];
    const valores = [];
    if (departamento) { valores.push(departamento); condicoes.push(`t.departamento = $${valores.length}`); }
    if (analista) { valores.push(analista); condicoes.push(`t.analista = $${valores.length}`); }
    if (status) { valores.push(status); condicoes.push(`t.pior_status = $${valores.length}`); }
    const where = condicoes.length ? 'WHERE ' + condicoes.join(' AND ') : '';
    const { rows } = await pool.query(`
      SELECT t.id, t.zappy_id, t.empresa_texto, v.empresa_nome, t.departamento,
             t.analista, t.status, t.pior_status, t.sla, t.abertura, t.encerramento, t.updated_at
        FROM cs_tickets t
        LEFT JOIN cs_vinculos v ON v.id = t.vinculo_id
        ${where}
       ORDER BY t.abertura DESC NULLS LAST
       LIMIT 500
    `, valores);
    res.json({ tickets: rows });
  } catch (e) {
    console.error('[cs] GET /historico falhou:', e);
    res.status(500).json({ error: 'Falha ao carregar histórico: ' + e.message });
  }
});

/**
 * GET /api/cs/filtros — opções (departamento/analista) já vistas nos tickets
 * gravados, pra popular os <select> da tela de histórico sem depender de
 * mais uma chamada ao Zappy.
 */
router.get('/filtros', requireAuth, async (req, res) => {
  try {
    const pool = obterPool();
    const [deps, anals] = await Promise.all([
      pool.query(`SELECT DISTINCT departamento FROM cs_tickets WHERE departamento IS NOT NULL ORDER BY departamento`),
      pool.query(`SELECT DISTINCT analista FROM cs_tickets WHERE analista IS NOT NULL ORDER BY analista`),
    ]);
    res.json({
      departamentos: deps.rows.map(r => r.departamento),
      analistas: anals.rows.map(r => r.analista),
    });
  } catch (e) {
    console.error('[cs] GET /filtros falhou:', e);
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/cs/backfill?dias=90 — carga retroativa ÚNICA. Reabre a "data de
 * início da coleta" pra trás (nunca esconde ticket já coletado) e roda a
 * ingestão em SEGUNDO PLANO (não espera terminar pra responder) — com 90
 * dias de histórico isso pode levar vários minutos, tempo demais pra uma
 * requisição HTTP normal aguentar. Acompanhar pelos logs do Render
 * (procurar por "[CS] Backfill concluído") ou recarregando a aba Histórico.
 */
router.post('/backfill', requireAuth, requireAdmin, async (req, res) => {
  if (backfillEmAndamento) {
    return res.status(409).json({ error: 'Já existe uma carga retroativa em andamento. Aguarde terminar.' });
  }
  const dias = Math.max(1, Math.min(365, parseInt(req.query.dias, 10) || 90));
  backfillEmAndamento = true;
  res.json({ ok: true, dias, mensagem: `Carga retroativa de ${dias} dias iniciada em segundo plano. Pode levar alguns minutos — acompanhe pelos logs do Render ou recarregue a tela daqui a pouco.` });

  try {
    const pool = obterPool();
    const zappyClient = criarClienteZappy();
    const resultado = await executarCargaRetroativa({ zappyClient, pool, dias });
    console.log('[CS] Backfill concluído:', resultado);
  } catch (e) {
    console.error('[CS] Backfill falhou:', e);
  } finally {
    backfillEmAndamento = false;
  }
});

/**
 * Calcula [de, até] a partir do `period` usado no Dashboard geral do app
 * (mesmos valores do <select id="dash-period">: todos/hoje/semana/mes).
 * Retorna null se for "todos" ou algo não reconhecido (= sem filtro).
 */
function intervaloPorPeriod(period) {
  const agora = new Date();
  if (period === 'hoje') {
    const de = new Date(agora); de.setHours(0, 0, 0, 0);
    return [de, agora];
  }
  if (period === 'semana') {
    return [new Date(agora.getTime() - 7 * 24 * 60 * 60 * 1000), agora];
  }
  if (period === 'mes') {
    return [new Date(agora.getFullYear(), agora.getMonth(), 1), agora];
  }
  return null;
}

/**
 * GET /api/cs/dashboard — visão geral do que já foi coletado: totais, quebra
 * por status de SLA (verde/amarelo/vermelho), por departamento e por
 * analista. Alimenta tanto o painel dentro de "Sucesso do Cliente" quanto a
 * seção embutida no Dashboard geral (entre Atendimento e Gestão de Clientes).
 *
 * Dois jeitos de filtrar por data (o que vier, manda):
 *   ?period=todos|hoje|semana|mes  — mesmo padrão do Dashboard geral
 *   ?ano=2026&mes=7                — usado pelo painel dentro do próprio módulo
 * Mais opcionalmente ?analista=Nome (filtra só por esse analista).
 * Sempre filtra pela data de ABERTURA do ticket. Devolve `anos` (lista de
 * anos com dados) pra popular o <select> sem outra chamada.
 */
router.get('/dashboard', requireAuth, async (req, res) => {
  try {
    const pool = obterPool();
    const condicoes = [];
    const params = [];

    if (req.query.period) {
      const intervalo = intervaloPorPeriod(req.query.period);
      if (intervalo) {
        params.push(intervalo[0].toISOString(), intervalo[1].toISOString());
        condicoes.push(`t.abertura >= $${params.length - 1}`, `t.abertura <= $${params.length}`);
      }
    } else {
      const ano = req.query.ano ? parseInt(req.query.ano, 10) : null;
      const mes = req.query.mes ? parseInt(req.query.mes, 10) : null;
      if (ano) { params.push(ano); condicoes.push(`EXTRACT(YEAR FROM t.abertura) = $${params.length}::int`); }
      if (mes) { params.push(mes); condicoes.push(`EXTRACT(MONTH FROM t.abertura) = $${params.length}::int`); }
    }
    if (req.query.analista) { params.push(req.query.analista); condicoes.push(`t.analista = $${params.length}`); }

    // "TRUE" sempre presente: garante que `cond` nunca fica vazio, então dá
    // pra sempre colar "${cond} AND ..." nas consultas abaixo sem checar caso a caso.
    condicoes.unshift('TRUE');
    const cond = 'WHERE ' + condicoes.join(' AND ');

    const [total, emRisco, porStatus, porDepartamento, porAnalista, desempenho, anos] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS n FROM cs_tickets t ${cond}`, params),
      pool.query(`SELECT COUNT(*)::int AS n FROM cs_tickets t ${cond} AND t.em_risco = TRUE`, params),
      pool.query(`
        SELECT COALESCE(t.pior_status, 'verde') AS label, COUNT(*)::int AS n
          FROM cs_tickets t ${cond} GROUP BY COALESCE(t.pior_status, 'verde')`, params),
      pool.query(`
        SELECT t.departamento AS label, COUNT(*)::int AS n
          FROM cs_tickets t ${cond} AND t.departamento IS NOT NULL
         GROUP BY t.departamento ORDER BY n DESC LIMIT 15`, params),
      pool.query(`
        SELECT t.analista AS label, COUNT(*)::int AS n
          FROM cs_tickets t ${cond} AND t.analista IS NOT NULL
         GROUP BY t.analista ORDER BY n DESC LIMIT 15`, params),
      // Desempenho por analista: % dentro do SLA (verde/total), pior primeiro —
      // é o que permite enxergar "quem está deixando mais cliente esperando".
      // Exige pelo menos 3 tickets no período pra não colocar alguém no topo
      // do ranking (bom ou ruim) por causa de 1 caso isolado.
      pool.query(`
        SELECT t.analista AS label,
               COUNT(*)::int AS total,
               COUNT(*) FILTER (WHERE t.pior_status = 'verde')::int AS verdes,
               COUNT(*) FILTER (WHERE t.pior_status = 'amarelo')::int AS amarelos,
               COUNT(*) FILTER (WHERE t.pior_status = 'vermelho')::int AS vermelhos
          FROM cs_tickets t ${cond} AND t.analista IS NOT NULL
         GROUP BY t.analista
        HAVING COUNT(*) >= 3
         ORDER BY (COUNT(*) FILTER (WHERE t.pior_status = 'verde')::float / COUNT(*)) ASC
         LIMIT 15`, params),
      pool.query(`
        SELECT DISTINCT EXTRACT(YEAR FROM abertura)::int AS ano
          FROM cs_tickets WHERE abertura IS NOT NULL ORDER BY ano DESC`),
    ]);
    res.json({
      totalTickets: total.rows[0].n,
      emRiscoAgora: emRisco.rows[0].n,
      porStatus: porStatus.rows,
      porDepartamento: porDepartamento.rows,
      porAnalista: porAnalista.rows,
      desempenhoAnalistas: desempenho.rows.map(r => ({
        ...r,
        pct: r.total ? Math.round((r.verdes / r.total) * 100) : null,
      })),
      anos: anos.rows.map(r => r.ano),
    });
  } catch (e) {
    console.error('[cs] GET /dashboard falhou:', e);
    res.status(500).json({ error: 'Falha ao carregar dashboard: ' + e.message });
  }
});

/** POST /api/cs/ingerir — dispara a ingestão manualmente (uso: botão "Atualizar agora" / debug). */
router.post('/ingerir', requireAuth, requireAdmin, async (req, res) => {
  try {
    const pool = obterPool();
    const zappyClient = criarClienteZappy();
    const resultado = await ingerirTickets({ zappyClient, pool });
    res.json(resultado);
  } catch (e) {
    console.error('[cs] POST /ingerir falhou:', e);
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/cs/diagnostico?ticketId=46072 — testa a ligação com o Zappy usando
 * SÓ o endpoint que já está confirmado (GET /tickets/:id), sem depender da
 * hipótese do endpoint de listagem em lote. Serve pra isolar o problema:
 * se isso falhar, é ZAPPY_BASE_URL/ZAPPY_TOKEN; se isso funcionar mas
 * POST /ingerir falhar, é só o endpoint de listagem que está errado.
 */
router.get('/diagnostico', requireAuth, requireAdmin, async (req, res) => {
  const ticketId = req.query.ticketId;
  if (!ticketId) return res.status(400).json({ error: 'Passe ?ticketId=NUMERO de um ticket real do Zappy.' });
  try {
    const zappyClient = criarClienteZappy();
    const ticket = await zappyClient.obterTicket(ticketId);
    res.json({ ok: true, ticket });
  } catch (e) {
    console.error('[cs] GET /diagnostico falhou:', e);
    res.status(500).json({ ok: false, error: e.message, status: e.status, body: e.body });
  }
});

/** GET /api/cs/vinculos/pendentes — fila de de-para aguardando confirmação humana. */
router.get('/vinculos/pendentes', requireAuth, async (req, res) => {
  try {
    const pool = obterPool();
    const vinculos = await listarPendentes(pool);
    res.json({ vinculos });
  } catch (e) {
    console.error('[cs] GET /vinculos/pendentes falhou:', e);
    res.status(500).json({ error: e.message });
  }
});

/** POST /api/cs/vinculos/:id/confirmar — confirma manualmente empresa + tipo do vínculo. */
router.post('/vinculos/:id/confirmar', requireAuth, async (req, res) => {
  try {
    const pool = obterPool();
    const { clienteId, empresaNome, cnpj, tipo } = req.body || {};
    const confirmadoPor = (req.user && (req.user.name || req.user.email || req.user.id)) || 'desconhecido';
    const atualizado = await confirmarVinculo(pool, req.params.id, {
      clienteId: clienteId ?? null, empresaNome, cnpj: cnpj ?? null, tipo, confirmadoPor,
    });
    if (!atualizado) return res.status(404).json({ error: 'Vínculo não encontrado.' });
    res.json({ vinculo: atualizado });
  } catch (e) {
    console.error('[cs] POST /vinculos/:id/confirmar falhou:', e);
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
