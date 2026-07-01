'use strict';
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../db');
const { requireAuth, requireAdmin } = require('../auth');

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
router.get('/gestao', async (req, res) => {
  try {
    const pf = periodFilter(req.query.period);
    const result = await pool.query(`SELECT * FROM gestao_clientes WHERE 1=1 ${pf} ORDER BY created_at DESC`);
    res.json({ data: result.rows });
  } catch (err) { res.status(500).json({ error: 'Erro.' }); }
});

router.post('/gestao', async (req, res) => {
  try {
    const { analista, solicitacao, cnpj, empresa, data_sol, competencia, canal, motivo, codigo } = req.body;
    if (!analista || !solicitacao || !cnpj || !empresa || !data_sol || !competencia || !canal)
      return res.status(400).json({ error: 'Campos obrigatórios ausentes.' });
    await pool.query(`ALTER TABLE gestao_clientes ADD COLUMN IF NOT EXISTS codigo TEXT`).catch(()=>{});
    const id = uuidv4();
    await pool.query(
      `INSERT INTO gestao_clientes (id, user_id, analista, solicitacao, cnpj, empresa, data_sol, competencia, canal, motivo, codigo) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, req.user.id, analista, solicitacao, cnpj, empresa, data_sol, competencia, canal, motivo || null, codigo || null]
    );
    await registrarLog(req.user.id, req.user.name, 'criar', 'gestao', `Gestao: ${solicitacao} - ${empresa}`, req);
    res.status(201).json({ id });
  } catch (err) { res.status(500).json({ error: 'Erro.' }); }
});

// ── INSATISFAÇÕES ─────────────────────────────────────────────────────────────
router.get('/insatisfacoes', async (req, res) => {
  try {
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
    const id = uuidv4();
    await pool.query(
      `INSERT INTO insatisfacoes (id, user_id, analista, cliente, cnpj, empresa, reclamado, reclamacao, gravidade, area, tipo) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id, req.user.id, analista, cliente, cnpj, empresa, reclamado || null, reclamacao, gravidade, area||null, tipo||null]
    );
    res.status(201).json({ id });
  } catch (err) { res.status(500).json({ error: 'Erro.' }); }
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
    const pf = periodFilter(req.query.period);
    const result = await pool.query(`SELECT * FROM recuperacoes WHERE 1=1 ${pf} ORDER BY created_at DESC`);
    res.json({ data: result.rows });
  } catch (err) { res.status(500).json({ error: 'Erro.' }); }
});

router.post('/recuperacoes', async (req, res) => {
  try {
    const { analista, cliente, cnpj, empresa, demonstrou, gravidade } = req.body;
    if (!analista || !cliente || !cnpj || !empresa || !demonstrou || !gravidade)
      return res.status(400).json({ error: 'Campos obrigatórios ausentes.' });
    const id = uuidv4();
    await pool.query(
      `INSERT INTO recuperacoes (id, user_id, analista, cliente, cnpj, empresa, demonstrou, gravidade) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, req.user.id, analista, cliente, cnpj, empresa, demonstrou, gravidade]
    );
    res.status(201).json({ id });
  } catch (err) { res.status(500).json({ error: 'Erro.' }); }
});

// ── DASHBOARD ─────────────────────────────────────────────────────────────────
router.get('/dashboard', async (req, res) => {
  try {
    const pf = periodFilter(req.query.period);

    const analista = req.query.analista || '';
    const af = analista ? ` AND analista = '${analista.replace(/'/g,"''")}' ` : '';

    const groupBy = async (table, col, limit=10, extra='') => {
      const r = await pool.query(
        `SELECT COALESCE(${col},'Não informado') as label, COUNT(*) as n
         FROM ${table} WHERE 1=1 ${pf} ${extra}
         GROUP BY ${col} ORDER BY n DESC LIMIT ${limit}`
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
      gcTipo, gcCanal,
      insGrav, insArea, insTipo, insEmpresa,
      nps, csat, ces,
    ] = await Promise.all([
      safe(() => groupBy('atendimentos', 'empresa', 10, af)),
      safe(() => groupBy('atendimentos', 'departamento', 8, af)),
      safe(() => groupBy('atendimentos', 'procurado', 8, af)),
      safe(() => groupBy('atendimentos', 'demanda', 8, af + " AND demanda IS NOT NULL AND demanda != ''")),
      safe(() => groupBy('gestao_clientes', 'solicitacao', 8)),
      safe(() => groupBy('gestao_clientes', 'canal', 8)),
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
      `SELECT DISTINCT analista FROM atendimentos WHERE analista IS NOT NULL ORDER BY analista`
    ).catch(() => ({ rows: [] }));

    // Meses sem reajuste per cliente (for Carteira)
    res.json({
      charts: {
        atEmpresa, atDepto, atAnalista: atAnalista, atDemanda,
        gcTipo, gcCanal,
        insGrav, insArea, insTipo, insEmpresa,
        npsEvolucao: npsEvolucao.rows,
      },
      nps, csat, ces,
      analistas: analistasList.rows.map(r => r.analista),
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
    await pool.query(`DELETE FROM gestao_clientes WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Erro ao limpar.' }); }
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
    q += ` ORDER BY c.created_at DESC`;
    const result = await pool.query(q, params);
    res.json({ data: result.rows });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro ao buscar clientes.' }); }
});

router.post('/clientes', requireAuth, async (req, res) => {
  try {
    const { cnpj, nome_empresa, regime_tributario, data_entrada, honorario_inicial,
            origem, cac, obs } = req.body;
    if (!cnpj || !nome_empresa || !data_entrada || !honorario_inicial)
      return res.status(400).json({ error: 'Campos obrigatórios faltando.' });
    const { v4: uuidv4 } = require('uuid');
    const clienteId = uuidv4();
    // Auto-add codigo column if not exists
    await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS codigo TEXT`).catch(()=>{});
    const { codigo } = req.body;
    await pool.query(
      `INSERT INTO clientes (id, user_id, cnpj, nome_empresa, regime_tributario, data_entrada,
        honorario_inicial, origem, cac, obs, codigo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [clienteId, req.user.id, cnpj, nome_empresa, regime_tributario || null,
       data_entrada, honorario_inicial, origem || null, cac || 0, obs || null, codigo || null]
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

router.delete('/clientes/clear', requireAdmin, async (req, res) => {
  try {
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

    // Clientes adquiridos no período (entradas na Carteira naquele mês)
    let cliQ = `SELECT COUNT(*) as n FROM clientes`;
    let cliParams = [];
    if (mes && mes !== 'todos') {
      cliQ += ` WHERE TO_CHAR(data_entrada,'YYYY-MM') = $1`;
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
      `SELECT empresa, COUNT(*) as n FROM insatisfacoes WHERE 1=1 ${pf} GROUP BY empresa ORDER BY n DESC LIMIT 5`
    );

    // Atendimentos por departamento
    const atDepto = await pool.query(
      `SELECT departamento, COUNT(*) as n FROM atendimentos WHERE 1=1 ${pf} GROUP BY departamento ORDER BY n DESC`
    );

    // Atendimentos por analista procurado
    const atAnalista = await pool.query(
      `SELECT procurado, COUNT(*) as n FROM atendimentos WHERE 1=1 ${pf} GROUP BY procurado ORDER BY n DESC LIMIT 5`
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
router.get('/backup', requireAdmin, async (req, res) => {
  try {
    const timestamp = new Date().toISOString().slice(0,19).replace('T','_').replace(/:/g,'-');

    // Buscar todos os dados de todas as tabelas
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

    const backup = {
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

    const pesoR = await pool.query(`SELECT valor FROM gam_config WHERE chave = 'peso_minimo'`);
    const pesoMinimo = pesoR.rows[0] ? parseFloat(pesoR.rows[0].valor) : 10;

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
      .sort((a,b) => parseFloat(b.media) - parseFloat(a.media));

    const mediaGeral = ranking.length
      ? (ranking.reduce((s,r) => s + parseFloat(r.media), 0) / ranking.length).toFixed(2)
      : null;

    // ── Consolidado acumulado (desde o início da gamificação) ──────────────────
    const todasNotas = await pool.query(`
      SELECT c.id, c.nome, n.media_individual, n.avaliacoes, n.mes
      FROM gam_notas n
      JOIN gam_colaboradores c ON c.id = n.colaborador_id
      WHERE c.ativo = true
      ORDER BY n.mes ASC
    `);

    // Média geral histórica: considera SOMENTE lançamentos com avaliações > 0
    const mediasHistValidas = todasNotas.rows.filter(r => parseFloat(r.media_individual) > 0).map(r => parseFloat(r.media_individual));
    const notaMaisBaixaHist = mediasHistValidas.length ? Math.min(...mediasHistValidas) : 0;
    const mediaGeralHistorica = mediasHistValidas.length
      ? mediasHistValidas.reduce((s,m) => s + m, 0) / mediasHistValidas.length
      : 0;

    // Agrupa por colaborador: soma ponderada de (média × avaliações) ao longo de todos os meses
    const porColaborador = {};
    todasNotas.rows.forEach(r => {
      if (!porColaborador[r.id]) porColaborador[r.id] = { nome: r.nome, totalAval: 0, somaPonderada: 0, meses: 0 };
      let m = parseFloat(r.media_individual);
      if (m === 0) m = notaMaisBaixaHist;
      const aval = parseInt(r.avaliacoes);
      porColaborador[r.id].totalAval += aval;
      porColaborador[r.id].somaPonderada += m * aval;
      porColaborador[r.id].meses += 1;
    });

    const consolidado = Object.values(porColaborador).map(c => {
      let final;
      if (c.totalAval === 0) {
        final = notaMaisBaixaHist; // sem avaliações: recebe a nota mais baixa histórica
      } else {
        const mediaIndividualAcumulada = c.somaPonderada / c.totalAval;
        final = ((mediaIndividualAcumulada * c.totalAval) + (mediaGeralHistorica * pesoMinimo)) / (c.totalAval + pesoMinimo);
      }
      return { nome: c.nome, media_geral: final.toFixed(2), meses_avaliados: c.meses, total_avaliacoes: c.totalAval };
    }).sort((a,b) => parseFloat(b.media_geral) - parseFloat(a.media_geral));

    const meses = await pool.query(`SELECT DISTINCT mes FROM gam_notas ORDER BY mes DESC`);
    const inicio = await pool.query(`SELECT MIN(mes) as primeiro_mes FROM gam_notas`);

    res.json({
      mes: mesAtual,
      ranking,
      mediaGeral,
      consolidado,
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
}

async function getPesoMinimo() {
  const r = await pool.query(`SELECT valor FROM gam_config WHERE chave = 'peso_minimo'`);
  return r.rows[0] ? parseFloat(r.rows[0].valor) : 10;
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
    res.json({ peso_minimo: peso });
  } catch (err) { res.status(500).json({ error: 'Erro ao buscar configuração.' }); }
});

router.patch('/gam/config', requireAdmin, async (req, res) => {
  try {
    const { peso_minimo } = req.body;
    if (peso_minimo == null || peso_minimo < 0) return res.status(400).json({ error: 'Peso mínimo inválido.' });
    await pool.query(
      `INSERT INTO gam_config (chave, valor) VALUES ('peso_minimo', $1)
       ON CONFLICT (chave) DO UPDATE SET valor = $1`,
      [peso_minimo]
    );
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

module.exports = router;


module.exports.publicRouter = publicRouter;
module.exports.registrarLog = registrarLog;
