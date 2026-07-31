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
 *   GET  /api/cs/dashboard/etapas           -> quebra do SLA por etapa (aceite/transferência/departamento)
 *   GET  /api/cs/agora                    -> radar de tickets em risco (só vínculos tipo='cliente')
 *   GET  /api/cs/historico                 -> lista de tickets p/ tela de relatórios (filtros: departamento/analista/status)
 *   GET  /api/cs/filtros                   -> opções de departamento/analista já vistas, p/ popular os selects
 *   POST /api/cs/ingerir                   -> dispara a ingestão manualmente (admin)
 *   POST /api/cs/backfill?dias=90          -> carga retroativa única, roda em segundo plano (admin)
 *   POST /api/cs/recalcular-sla            -> reprocessa o SLA de tudo que já está salvo, sem chamar o Zappy (admin)
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
const { ingerirTickets, executarCargaRetroativa, recalcularSlaTodos } = require('./ingestao');
const { criarClienteZappy } = require('./zappyClient');
const { listarPendentes, confirmarVinculo } = require('./vinculos');
const { detectarSinalChurn, detectarInsatisfacao } = require('./slaEngine');

// Trava simples pra não deixar disparar 2 backfills ao mesmo tempo (ex.: duplo clique).
let backfillEmAndamento = false;
// Idem, mas pro recálculo de SLA (ver POST /recalcular-sla abaixo).
let recalculoSlaEmAndamento = false;

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
    const { departamento, analista, status, etapa } = req.query;
    const condicoes = [];
    const valores = [];
    if (departamento) { valores.push(departamento); condicoes.push(`t.departamento = $${valores.length}`); }
    if (analista) { valores.push(analista); condicoes.push(`t.analista = $${valores.length}`); }

    // `etapa` (vindo do clique no gráfico "% dentro do SLA por etapa") filtra
    // pelo status DAQUELA etapa específica, não pelo pior_status geral do
    // ticket — um ticket pode estar vermelho por causa de OUTRA etapa e não
    // deve aparecer aqui se a etapa clicada estiver verde nele. Sem `etapa`,
    // continua igual a antes: `status` filtra o pior_status geral.
    //
    // `selectEtapaStatus` monta uma coluna extra `etapa_status` com o status
    // DAQUELA etapa (não o pior_status geral) — sem isso, a bolinha colorida
    // do Histórico mostrava o status GERAL do ticket (muitas vezes verde,
    // porque o ticket já foi encerrado e não tem mais nada "em curso"), o
    // que parecia contradizer o filtro "vermelho" que a Thais tinha acabado
    // de escolher. Reaproveita o MESMO placeholder ($N) já usado no WHERE.
    let selectEtapaStatus = 'NULL AS etapa_status';
    if (etapa === 'resposta_continua') {
      valores.push(status || null);
      condicoes.push(`EXISTS (
        SELECT 1 FROM jsonb_array_elements(COALESCE(t.sla->'trocasPosTransferencia', '[]'::jsonb)) r
         WHERE r->>'em_curso' = 'false' AND ($${valores.length}::text IS NULL OR r->>'status' = $${valores.length}::text)
      )`);
      selectEtapaStatus = `(
        SELECT r->>'status' FROM jsonb_array_elements(COALESCE(t.sla->'trocasPosTransferencia', '[]'::jsonb)) r
         WHERE r->>'em_curso' = 'false'
         ORDER BY (r->>'minutos_uteis')::numeric DESC LIMIT 1
      ) AS etapa_status`;
    } else if (etapa) {
      valores.push(etapa);
      const idxEtapa = valores.length;
      valores.push(status || null);
      condicoes.push(`EXISTS (
        SELECT 1 FROM jsonb_array_elements(COALESCE(t.sla->'relogios', '[]'::jsonb)) r
         WHERE r->>'tipo' = $${idxEtapa} AND r->>'em_curso' = 'false' AND ($${valores.length}::text IS NULL OR r->>'status' = $${valores.length}::text)
      )`);
      selectEtapaStatus = `(
        SELECT r->>'status' FROM jsonb_array_elements(COALESCE(t.sla->'relogios', '[]'::jsonb)) r
         WHERE r->>'tipo' = $${idxEtapa} AND r->>'em_curso' = 'false' LIMIT 1
      ) AS etapa_status`;
    } else if (status) {
      valores.push(status); condicoes.push(`t.pior_status = $${valores.length}`);
    }

    const where = condicoes.length ? 'WHERE ' + condicoes.join(' AND ') : '';
    const { rows } = await pool.query(`
      SELECT t.id, t.zappy_id, t.empresa_texto, v.empresa_nome, t.departamento,
             t.analista, t.status, t.pior_status, t.sla, t.abertura, t.encerramento, t.updated_at,
             ${selectEtapaStatus}
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
 * POST /api/cs/recalcular-sla — reprocessa os relógios de SLA de TODOS os
 * tickets já salvos, usando as regras ATUAIS do motor (slaEngine.js) — SEM
 * chamar o Zappy de novo. Necessário depois de qualquer ajuste na fórmula
 * de SLA (ex.: tickets #46296/#46251/#45963, reportados pela Thais):
 * corrigir o código não atualiza sozinho os tickets que já foram
 * calculados e salvos com a fórmula antiga — o Dashboard só LÊ o que já
 * está em cs_tickets.sla, não recalcula na hora que a página abre.
 * Roda em segundo plano (como o /backfill) — com milhares de tickets pode
 * levar alguns minutos.
 */
router.post('/recalcular-sla', requireAuth, requireAdmin, async (req, res) => {
  if (recalculoSlaEmAndamento) {
    return res.status(409).json({ error: 'Já existe um recálculo de SLA em andamento. Aguarde terminar.' });
  }
  recalculoSlaEmAndamento = true;
  res.json({ ok: true, mensagem: 'Recálculo de SLA iniciado em segundo plano. Pode levar alguns minutos — acompanhe pelos logs do Render ou recarregue a tela daqui a pouco.' });

  try {
    const pool = obterPool();
    const total = await recalcularSlaTodos(pool);
    console.log('[CS] Recálculo de SLA concluído:', total, 'tickets');
  } catch (e) {
    console.error('[CS] Recálculo de SLA falhou:', e);
  } finally {
    recalculoSlaEmAndamento = false;
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
      // NOTA: pior_status é o status do RADAR (o que está em curso agora) — um
      // ticket ENCERRADO normalmente fica com pior_status NULL, porque nenhum
      // relógio está mais em_curso. Sem o COALESCE abaixo, ticket fechado não
      // contava nem como verde nem como amarelo/vermelho (só entrava no total),
      // derrubando o % de todo mundo pra perto de 0 — mesmo bug de fundo do
      // etapa_status vs pior_status já corrigido no Histórico, aqui nesse
      // ranking. Mesma convenção do porStatus acima: sem problema em curso = verde.
      pool.query(`
        SELECT t.analista AS label,
               COUNT(*)::int AS total,
               COUNT(*) FILTER (WHERE COALESCE(t.pior_status, 'verde') = 'verde')::int AS verdes,
               COUNT(*) FILTER (WHERE COALESCE(t.pior_status, 'verde') = 'amarelo')::int AS amarelos,
               COUNT(*) FILTER (WHERE COALESCE(t.pior_status, 'verde') = 'vermelho')::int AS vermelhos
          FROM cs_tickets t ${cond} AND t.analista IS NOT NULL
         GROUP BY t.analista
        HAVING COUNT(*) >= 3
         ORDER BY (COUNT(*) FILTER (WHERE COALESCE(t.pior_status, 'verde') = 'verde')::float / COUNT(*)) ASC
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

/**
 * GET /api/cs/dashboard/etapas — quebra do SLA POR ETAPA, usando os relógios
 * que o motor de SLA já calcula e guarda por ticket (cs_tickets.sla, JSONB):
 *   aceite         -> quanto tempo a equipe leva pra aceitar/responder o 1º contato
 *   transferencia  -> quanto tempo leva do aceite até encaminhar pro departamento certo
 *   departamento   -> quanto tempo o analista leva pra responder DEPOIS de receber
 *                     o ticket transferido (é o que responde "o analista após a
 *                     transferência" e "a bola foi devolvida e demorou")
 *   promessa       -> quando respondem antes de transferir e demoram a encaminhar
 * Só entra relógio já CONCLUÍDO (em_curso=false) — os que ainda estão correndo
 * agora distorceriam a média (isso é papel do radar "Agora", não daqui).
 * `vez_cliente` não tem limite de SLA (ver tempoUtil.LIMITES) e sai como
 * status='neutro', então já fica fora automaticamente.
 *
 * Mesmos filtros do /dashboard: ?period=todos|hoje|semana|mes OU ?ano=&mes=,
 * e opcionalmente ?analista=Nome.
 *
 * Também inclui "resposta_continua" (dentro de porEtapa) e
 * porAnalistaRespostaContinua: tempo de resposta em CADA turno do cliente
 * DEPOIS da transferência (não só a 1ª resposta), vindo de
 * sla->'trocasPosTransferencia' — ver slaEngine.calcularTrocas e
 * resolverHoraTransferencia em ingestao.js. Isola o trabalho de quem
 * recebeu o ticket transferido do trabalho de quem aceitou/transferiu antes.
 */
router.get('/dashboard/etapas', requireAuth, async (req, res) => {
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
    condicoes.unshift('TRUE');
    const cond = 'WHERE ' + condicoes.join(' AND ');

    const [porEtapa, porAnalistaDepto, respostaContinua, porAnalistaResposta] = await Promise.all([
      // Visão geral: tempo médio e % dentro do SLA de cada etapa (1ª resposta de cada trecho).
      pool.query(`
        SELECT r->>'tipo' AS etapa,
               COUNT(*)::int AS total,
               ROUND(AVG((r->>'minutos_uteis')::numeric))::int AS media_minutos,
               COUNT(*) FILTER (WHERE r->>'status' = 'verde')::int AS verdes,
               COUNT(*) FILTER (WHERE r->>'status' = 'amarelo')::int AS amarelos,
               COUNT(*) FILTER (WHERE r->>'status' = 'vermelho')::int AS vermelhos
          FROM cs_tickets t,
               LATERAL jsonb_array_elements(COALESCE(t.sla->'relogios', '[]'::jsonb)) AS r
          ${cond} AND r->>'status' <> 'neutro' AND r->>'em_curso' = 'false'
         GROUP BY r->>'tipo'
      `, params),
      // Ranking por analista SÓ na etapa "departamento" (resposta pós-transferência) —
      // pior primeiro, exige pelo menos 3 tickets no período (mesmo critério do /dashboard).
      pool.query(`
        SELECT t.analista AS label,
               COUNT(*)::int AS total,
               ROUND(AVG((r->>'minutos_uteis')::numeric))::int AS media_minutos,
               COUNT(*) FILTER (WHERE r->>'status' = 'verde')::int AS verdes,
               COUNT(*) FILTER (WHERE r->>'status' = 'amarelo')::int AS amarelos,
               COUNT(*) FILTER (WHERE r->>'status' = 'vermelho')::int AS vermelhos
          FROM cs_tickets t,
               LATERAL jsonb_array_elements(COALESCE(t.sla->'relogios', '[]'::jsonb)) AS r
          ${cond} AND r->>'tipo' = 'departamento' AND t.analista IS NOT NULL AND r->>'em_curso' = 'false'
         GROUP BY t.analista
        HAVING COUNT(*) >= 3
         ORDER BY (COUNT(*) FILTER (WHERE r->>'status' = 'verde')::float / COUNT(*)) ASC
         LIMIT 15
      `, params),
      // "Resposta contínua": tempo médio e % dentro do SLA em CADA turno do
      // cliente DEPOIS da transferência (não só a 1ª resposta) — vem de
      // sla->'trocasPosTransferencia' (ver slaEngine.calcularTrocas e
      // resolverHoraTransferencia em ingestao.js). Fica só com o que é do
      // analista que recebeu o ticket, sem misturar o que foi de quem
      // aceitou/transferiu antes (ex.: recepção do Sucesso do Cliente).
      pool.query(`
        SELECT COUNT(*)::int AS total,
               ROUND(AVG((r->>'minutos_uteis')::numeric))::int AS media_minutos,
               COUNT(*) FILTER (WHERE r->>'status' = 'verde')::int AS verdes,
               COUNT(*) FILTER (WHERE r->>'status' = 'amarelo')::int AS amarelos,
               COUNT(*) FILTER (WHERE r->>'status' = 'vermelho')::int AS vermelhos
          FROM cs_tickets t,
               LATERAL jsonb_array_elements(COALESCE(t.sla->'trocasPosTransferencia', '[]'::jsonb)) AS r
          ${cond} AND r->>'em_curso' = 'false'
      `, params),
      // Mesmo "resposta contínua" (pós-transferência), mas por analista (pior
      // primeiro) — usa o analista FINAL do ticket como atribuição (a API do
      // Zappy não guarda quem mandou cada mensagem individualmente, só quem
      // é o responsável pelo ticket como um todo).
      pool.query(`
        SELECT t.analista AS label,
               COUNT(*)::int AS total,
               ROUND(AVG((r->>'minutos_uteis')::numeric))::int AS media_minutos,
               COUNT(*) FILTER (WHERE r->>'status' = 'verde')::int AS verdes,
               COUNT(*) FILTER (WHERE r->>'status' = 'amarelo')::int AS amarelos,
               COUNT(*) FILTER (WHERE r->>'status' = 'vermelho')::int AS vermelhos
          FROM cs_tickets t,
               LATERAL jsonb_array_elements(COALESCE(t.sla->'trocasPosTransferencia', '[]'::jsonb)) AS r
          ${cond} AND t.analista IS NOT NULL AND r->>'em_curso' = 'false'
         GROUP BY t.analista
        HAVING COUNT(*) >= 3
         ORDER BY (COUNT(*) FILTER (WHERE r->>'status' = 'verde')::float / COUNT(*)) ASC
         LIMIT 15
      `, params),
    ]);

    const comPct = (rows) => rows.map(r => ({ ...r, pct: r.total ? Math.round((r.verdes / r.total) * 100) : null }));
    const linhasEtapa = comPct(porEtapa.rows);
    // "Resposta contínua" entra como mais uma etapa na mesma lista (só se tiver dado).
    if (respostaContinua.rows[0] && respostaContinua.rows[0].total > 0) {
      linhasEtapa.push({ etapa: 'resposta_continua', ...comPct(respostaContinua.rows)[0] });
    }

    res.json({
      porEtapa: linhasEtapa,
      porAnalistaDepartamento: comPct(porAnalistaDepto.rows),
      porAnalistaRespostaContinua: comPct(porAnalistaResposta.rows),
    });
  } catch (e) {
    console.error('[cs] GET /dashboard/etapas falhou:', e);
    res.status(500).json({ error: 'Falha ao carregar quebra por etapa: ' + e.message });
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

/**
 * GET /api/cs/churn?dias=180 — varre as mensagens do CLIENTE (Zappy) dos
 * últimos N dias procurando frases que sinalizam risco de cancelamento
 * (ver FRASES_CHURN em slaEngine.js — "vou procurar outra contabilidade",
 * "erram demais", etc.). Zero IA paga: é o mesmo tipo de casamento de
 * frase já usado pra detectar "vou transferir". Agrupa por empresa (usa o
 * vínculo confirmado se existir; senão cai no nome/telefone do contato do
 * Zappy) e devolve a ocorrência mais recente de cada uma, pior primeiro.
 */
router.get('/churn', requireAuth, requireAdmin, async (req, res) => {
  try {
    const pool = obterPool();
    const dias = Math.max(1, Math.min(365, parseInt(req.query.dias, 10) || 180));

    await pool.query(`CREATE TABLE IF NOT EXISTS cs_churn_tratamentos (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      ticket_id UUID NOT NULL REFERENCES cs_tickets(id) ON DELETE CASCADE,
      motivo TEXT, tratado_por TEXT, tratado_em TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (ticket_id)
    )`).catch(() => {});

    const { rows } = await pool.query(`
      SELECT cm.texto, cm.hora, ct.id AS ticket_id, ct.zappy_id, ct.empresa_texto,
             ct.telefone, ct.analista, ct.departamento,
             cv.empresa_nome, cv.cnpj, cv.tipo AS vinculo_tipo
        FROM cs_mensagens cm
        JOIN cs_tickets ct ON ct.id = cm.ticket_id
        LEFT JOIN cs_vinculos cv ON cv.id = ct.vinculo_id
        LEFT JOIN cs_churn_tratamentos tr ON tr.ticket_id = ct.id
       WHERE cm.remetente = 'cliente'
         AND cm.hora >= NOW() - ($1 || ' days')::interval
         AND cm.texto IS NOT NULL AND cm.texto <> ''
         AND tr.id IS NULL
       ORDER BY cm.hora DESC
       LIMIT 5000
    `, [dias]);

    // Agrupa por empresa (vínculo confirmado > nome do contato > telefone).
    // Guarda a ocorrência mais recente nos campos de topo (compatibilidade
    // com quem só olha frase_detectada/trecho) E TAMBÉM a lista completa de
    // ocorrências em `detalhes` (até MAX_DETALHES por empresa), pra dar pra
    // ver TODAS as mensagens que bateram, não só a última — pedido da Thais
    // depois de ver "3 ocorrências" sem conseguir abrir quais eram.
    const MAX_DETALHES = 20;
    const porEmpresa = new Map();
    for (const row of rows) {
      const frase = detectarSinalChurn(row.texto);
      if (!frase) continue;

      const chave = row.empresa_nome || row.empresa_texto || row.telefone || row.ticket_id;
      if (!porEmpresa.has(chave)) {
        porEmpresa.set(chave, {
          empresa: row.empresa_nome || row.empresa_texto || '(sem nome identificado)',
          cnpj: row.cnpj || null,
          telefone: row.telefone || null,
          vinculado: row.vinculo_tipo === 'cliente',
          ocorrencias: 0,
          ultima_hora: row.hora,
          frase_detectada: frase,
          trecho: row.texto,
          ticket_id: row.ticket_id,
          zappy_id: row.zappy_id,
          analista: row.analista,
          departamento: row.departamento,
          detalhes: [],
        });
      }
      const item = porEmpresa.get(chave);
      item.ocorrencias++;
      if (item.detalhes.length < MAX_DETALHES) {
        item.detalhes.push({
          hora: row.hora,
          ticket_id: row.ticket_id,
          zappy_id: row.zappy_id,
          frase,
          trecho: row.texto,
        });
      }
    }

    const data = [...porEmpresa.values()].sort((a, b) => new Date(b.ultima_hora) - new Date(a.ultima_hora));
    res.json({ data, dias, mensagensAnalisadas: rows.length });
  } catch (e) {
    console.error('[cs] GET /churn falhou:', e);
    res.status(500).json({ error: 'Falha ao analisar possíveis churns: ' + e.message });
  }
});

/**
 * POST /api/cs/churn/:ticketId/tratar — marca o ticket como revisado (falso
 * alarme / não é churn de verdade). A partir daí ele para de aparecer no
 * GET /churn, mesmo que a mensagem continue batendo com alguma frase da
 * lista. `motivo` é opcional, só pra registrar por que não é churn.
 */
router.post('/churn/:ticketId/tratar', requireAuth, requireAdmin, async (req, res) => {
  try {
    const pool = obterPool();
    const { motivo } = req.body || {};
    const tratadoPor = (req.user && (req.user.name || req.user.email || req.user.id)) || 'desconhecido';

    await pool.query(`CREATE TABLE IF NOT EXISTS cs_churn_tratamentos (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      ticket_id UUID NOT NULL REFERENCES cs_tickets(id) ON DELETE CASCADE,
      motivo TEXT, tratado_por TEXT, tratado_em TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (ticket_id)
    )`).catch(() => {});

    await pool.query(
      `INSERT INTO cs_churn_tratamentos (ticket_id, motivo, tratado_por)
       VALUES ($1, $2, $3)
       ON CONFLICT (ticket_id) DO UPDATE SET motivo = EXCLUDED.motivo, tratado_por = EXCLUDED.tratado_por, tratado_em = NOW()`,
      [req.params.ticketId, motivo || null, tratadoPor]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('[cs] POST /churn/:ticketId/tratar falhou:', e);
    res.status(500).json({ error: 'Falha ao marcar como tratado: ' + e.message });
  }
});

/**
 * GET /api/cs/insatisfacao-conversas?dias=180 — varre TODAS as mensagens do
 * CLIENTE (não só as que sinalizam risco de cancelamento) procurando
 * qualquer sinal de insatisfação, desespero, desrespeito, erro ou
 * juros/multa (ver PALAVRAS_INSATISFACAO em slaEngine.js). Pedido da Thais:
 * o painel "Sentimento dos Comentários" só olhava as pesquisas de
 * satisfação — isso aqui cobre TODO atendimento do Zappy. Diferente de
 * /churn, NÃO agrupa por empresa — devolve uma linha por MENSAGEM que
 * bateu (mais recentes primeiro), porque uma insatisfação em cada
 * atendimento merece ser vista, não só resumida num contador.
 */
router.get('/insatisfacao-conversas', requireAuth, requireAdmin, async (req, res) => {
  try {
    const pool = obterPool();
    const dias = Math.max(1, Math.min(365, parseInt(req.query.dias, 10) || 180));

    await pool.query(`CREATE TABLE IF NOT EXISTS cs_insatisfacao_tratamentos (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      mensagem_id UUID NOT NULL REFERENCES cs_mensagens(id) ON DELETE CASCADE,
      motivo TEXT, tratado_por TEXT, tratado_em TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (mensagem_id)
    )`).catch(() => {});

    const { rows } = await pool.query(`
      SELECT cm.id AS mensagem_id, cm.texto, cm.hora, ct.id AS ticket_id, ct.zappy_id,
             ct.empresa_texto, ct.telefone, ct.analista, ct.departamento,
             cv.empresa_nome, cv.cnpj, cv.tipo AS vinculo_tipo
        FROM cs_mensagens cm
        JOIN cs_tickets ct ON ct.id = cm.ticket_id
        LEFT JOIN cs_vinculos cv ON cv.id = ct.vinculo_id
        LEFT JOIN cs_insatisfacao_tratamentos tr ON tr.mensagem_id = cm.id
       WHERE cm.remetente = 'cliente'
         AND cm.hora >= NOW() - ($1 || ' days')::interval
         AND cm.texto IS NOT NULL AND cm.texto <> ''
         AND tr.id IS NULL
       ORDER BY cm.hora DESC
       LIMIT 5000
    `, [dias]);

    const MAX_LINHAS = 500;
    const data = [];
    for (const row of rows) {
      const palavra = detectarInsatisfacao(row.texto);
      if (!palavra) continue;
      data.push({
        mensagem_id: row.mensagem_id,
        empresa: row.empresa_nome || row.empresa_texto || '(sem nome identificado)',
        cnpj: row.cnpj || null,
        telefone: row.telefone || null,
        vinculado: row.vinculo_tipo === 'cliente',
        hora: row.hora,
        palavra_detectada: palavra,
        trecho: row.texto,
        ticket_id: row.ticket_id,
        zappy_id: row.zappy_id,
        analista: row.analista,
        departamento: row.departamento,
      });
      if (data.length >= MAX_LINHAS) break;
    }

    res.json({ data, dias, mensagensAnalisadas: rows.length });
  } catch (e) {
    console.error('[cs] GET /insatisfacao-conversas falhou:', e);
    res.status(500).json({ error: 'Falha ao analisar insatisfação nas conversas: ' + e.message });
  }
});

/**
 * POST /api/cs/insatisfacao-conversas/:mensagemId/tratar — marca a MENSAGEM
 * como revisada (falso alarme / já resolvido). Diferente de /churn/:id
 * (que trata o ticket inteiro), aqui é por mensagem individual, porque um
 * mesmo ticket pode ter várias mensagens de insatisfação em momentos
 * diferentes e cada uma merece revisão própria.
 */
router.post('/insatisfacao-conversas/:mensagemId/tratar', requireAuth, requireAdmin, async (req, res) => {
  try {
    const pool = obterPool();
    const { motivo } = req.body || {};
    const tratadoPor = (req.user && (req.user.name || req.user.email || req.user.id)) || 'desconhecido';

    await pool.query(`CREATE TABLE IF NOT EXISTS cs_insatisfacao_tratamentos (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      mensagem_id UUID NOT NULL REFERENCES cs_mensagens(id) ON DELETE CASCADE,
      motivo TEXT, tratado_por TEXT, tratado_em TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (mensagem_id)
    )`).catch(() => {});

    await pool.query(
      `INSERT INTO cs_insatisfacao_tratamentos (mensagem_id, motivo, tratado_por)
       VALUES ($1, $2, $3)
       ON CONFLICT (mensagem_id) DO UPDATE SET motivo = EXCLUDED.motivo, tratado_por = EXCLUDED.tratado_por, tratado_em = NOW()`,
      [req.params.mensagemId, motivo || null, tratadoPor]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('[cs] POST /insatisfacao-conversas/:mensagemId/tratar falhou:', e);
    res.status(500).json({ error: 'Falha ao marcar como tratado: ' + e.message });
  }
});

/**
 * GET /api/cs/afastamento — pra cada cliente ATIVO na Carteira com vínculo
 * confirmado, calcula há quantos dias foi a última mensagem QUE ELE mandou
 * no Zappy (não conta mensagem do escritório) — pedido da Thais: "medir o
 * afastamento, a ausência de procura" como sinal indireto de possível
 * churn silencioso (cliente que não reclama nada, só some). Clientes sem
 * NENHUM histórico de conversa registrado vêm marcados à parte
 * (`sem_historico: true`) — pode ser cliente antigo de antes do Zappy
 * rastrear, não necessariamente afastamento real.
 */
router.get('/afastamento', requireAuth, requireAdmin, async (req, res) => {
  try {
    const pool = obterPool();
    const { rows } = await pool.query(`
      SELECT c.id AS cliente_id, c.nome_empresa, c.cnpj, c.grupo_empresas, c.unidade,
             c.data_entrada, v.id AS vinculo_id,
             ultima.hora AS ultimo_contato
        FROM clientes c
        LEFT JOIN cs_vinculos v ON v.cliente_id = c.id::text AND v.tipo = 'cliente'
        LEFT JOIN LATERAL (
          SELECT MAX(cm.hora) AS hora
            FROM cs_mensagens cm
            JOIN cs_tickets ct ON ct.id = cm.ticket_id
           WHERE ct.vinculo_id = v.id AND cm.remetente = 'cliente'
        ) ultima ON true
       WHERE c.status = 'ativo'
       ORDER BY ultima.hora ASC NULLS FIRST
    `);

    const agora = Date.now();
    const diasEntre = (de) => de ? Math.floor((agora - new Date(de).getTime()) / (1000 * 60 * 60 * 24)) : null;

    const data = rows.map(r => ({
      cliente_id: r.cliente_id,
      empresa: r.nome_empresa,
      cnpj: r.cnpj,
      grupo_empresas: r.grupo_empresas,
      unidade: r.unidade,
      vinculado: !!r.vinculo_id,
      ultimo_contato: r.ultimo_contato,
      dias_sem_contato: diasEntre(r.ultimo_contato),
      sem_historico: !r.ultimo_contato,
      dias_desde_entrada: diasEntre(r.data_entrada),
    }));

    // Mais afastado primeiro: sem_historico junto (ordenado por tempo de
    // Carteira, já que não há conversa pra medir), depois os com contato
    // registrado, do maior gap pro menor.
    data.sort((a, b) => {
      if (a.sem_historico !== b.sem_historico) return a.sem_historico ? -1 : 1;
      if (a.sem_historico) return (b.dias_desde_entrada || 0) - (a.dias_desde_entrada || 0);
      return (b.dias_sem_contato || 0) - (a.dias_sem_contato || 0);
    });

    res.json({ data, total: data.length });
  } catch (e) {
    console.error('[cs] GET /afastamento falhou:', e);
    res.status(500).json({ error: 'Falha ao calcular afastamento: ' + e.message });
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
