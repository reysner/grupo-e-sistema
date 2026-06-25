'use strict';
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db');
const { requireAuth, requireAdmin } = require('../auth');

const router = express.Router();
router.use(requireAuth);

// ── Helpers ────────────────────────────────────────────────────────────────────
function periodFilter(period) {
  switch (period) {
    case 'hoje':   return `AND date(created_at) = date('now')`;
    case 'semana': return `AND created_at >= datetime('now', '-7 days')`;
    case 'mes':    return `AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')`;
    default:       return '';
  }
}

function buildQuery(table, period) {
  return `SELECT * FROM ${table} WHERE 1=1 ${periodFilter(period)} ORDER BY created_at DESC`;
}

// ── ATENDIMENTOS ──────────────────────────────────────────────────────────────
router.get('/atendimentos', (req, res) => {
  const rows = db.prepare(buildQuery('atendimentos', req.query.period)).all().map(r => ({ ...r }));
  res.json({ data: rows });
});

router.post('/atendimentos', (req, res) => {
  const { analista, cliente, cnpj, empresa, departamento, procurado, demanda, resumo } = req.body;
  if (!analista || !cliente || !cnpj || !empresa || !departamento || !procurado || !demanda) {
    return res.status(400).json({ error: 'Campos obrigatórios ausentes.' });
  }
  const id = uuidv4();
  db.prepare(
    `INSERT INTO atendimentos (id, user_id, analista, cliente, cnpj, empresa, departamento, procurado, demanda, resumo)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, req.user.id, analista, cliente, cnpj, empresa, departamento, procurado, demanda, resumo || null);
  res.status(201).json({ id });
});

// ── GESTÃO DE CLIENTES ────────────────────────────────────────────────────────
router.get('/gestao', (req, res) => {
  const rows = db.prepare(buildQuery('gestao_clientes', req.query.period)).all().map(r => ({ ...r }));
  res.json({ data: rows });
});

router.post('/gestao', (req, res) => {
  const { analista, solicitacao, cnpj, empresa, data_sol, competencia, canal, motivo } = req.body;
  if (!analista || !solicitacao || !cnpj || !empresa || !data_sol || !competencia || !canal) {
    return res.status(400).json({ error: 'Campos obrigatórios ausentes.' });
  }
  const id = uuidv4();
  db.prepare(
    `INSERT INTO gestao_clientes (id, user_id, analista, solicitacao, cnpj, empresa, data_sol, competencia, canal, motivo)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, req.user.id, analista, solicitacao, cnpj, empresa, data_sol, competencia, canal, motivo || null);
  res.status(201).json({ id });
});

// ── INSATISFAÇÕES ─────────────────────────────────────────────────────────────
router.get('/insatisfacoes', (req, res) => {
  const rows = db.prepare(buildQuery('insatisfacoes', req.query.period)).all().map(r => ({ ...r }));
  res.json({ data: rows });
});

router.post('/insatisfacoes', (req, res) => {
  const { analista, cliente, cnpj, empresa, reclamado, reclamacao, gravidade } = req.body;
  if (!analista || !cliente || !cnpj || !empresa || !reclamacao || !gravidade) {
    return res.status(400).json({ error: 'Campos obrigatórios ausentes.' });
  }
  const id = uuidv4();
  db.prepare(
    `INSERT INTO insatisfacoes (id, user_id, analista, cliente, cnpj, empresa, reclamado, reclamacao, gravidade)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, req.user.id, analista, cliente, cnpj, empresa, reclamado || null, reclamacao, gravidade);
  res.status(201).json({ id });
});

// ── CLIENTES SENSÍVEIS ────────────────────────────────────────────────────────
router.get('/sensiveis', (req, res) => {
  const rows = db.prepare(buildQuery('clientes_sensiveis', req.query.period)).all().map(r => ({ ...r }));
  res.json({ data: rows });
});

router.post('/sensiveis', (req, res) => {
  const { analista, cliente, cnpj, empresa, demonstrou, gravidade } = req.body;
  if (!analista || !cliente || !cnpj || !empresa || !demonstrou || !gravidade) {
    return res.status(400).json({ error: 'Campos obrigatórios ausentes.' });
  }
  const id = uuidv4();
  db.prepare(
    `INSERT INTO clientes_sensiveis (id, user_id, analista, cliente, cnpj, empresa, demonstrou, gravidade)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, req.user.id, analista, cliente, cnpj, empresa, demonstrou, gravidade);
  res.status(201).json({ id });
});

// ── PESQUISAS ─────────────────────────────────────────────────────────────────
router.get('/pesquisas', (req, res) => {
  const rows = db.prepare(buildQuery('pesquisas', req.query.period)).all().map(r => ({ ...r }));
  res.json({ data: rows });
});

router.post('/pesquisas', (req, res) => {
  const { analista, cliente, cnpj, empresa, nps, csat, ces, pontos } = req.body;
  if (!analista || !cliente || !cnpj || !empresa || nps == null || csat == null || ces == null) {
    return res.status(400).json({ error: 'Campos obrigatórios ausentes.' });
  }
  const id = uuidv4();
  db.prepare(
    `INSERT INTO pesquisas (id, user_id, analista, cliente, cnpj, empresa, nps, csat, ces, pontos)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, req.user.id, analista, cliente, cnpj, empresa, Number(nps), Number(csat), Number(ces), pontos || null);
  res.status(201).json({ id });
});

// ── RECUPERAÇÕES ──────────────────────────────────────────────────────────────
router.get('/recuperacoes', (req, res) => {
  const rows = db.prepare(buildQuery('recuperacoes', req.query.period)).all().map(r => ({ ...r }));
  res.json({ data: rows });
});

router.post('/recuperacoes', (req, res) => {
  const { analista, cliente, cnpj, empresa, demonstrou, gravidade } = req.body;
  if (!analista || !cliente || !cnpj || !empresa || !demonstrou || !gravidade) {
    return res.status(400).json({ error: 'Campos obrigatórios ausentes.' });
  }
  const id = uuidv4();
  db.prepare(
    `INSERT INTO recuperacoes (id, user_id, analista, cliente, cnpj, empresa, demonstrou, gravidade)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, req.user.id, analista, cliente, cnpj, empresa, demonstrou, gravidade);
  res.status(201).json({ id });
});

// ── DASHBOARD STATS ───────────────────────────────────────────────────────────
router.get('/dashboard', (req, res) => {
  const p = req.query.period;
  const pf = periodFilter(p);

  const count = (table) =>
    ({ ...db.prepare(`SELECT COUNT(*) as n FROM ${table} WHERE 1=1 ${pf}`).get() }).n;

  const groupBy = (table, col) =>
    db.prepare(`SELECT ${col} as label, COUNT(*) as n FROM ${table} WHERE 1=1 ${pf} GROUP BY ${col}`).all().map(r => ({ ...r }));

  const avgNPS = ({ ...db.prepare(`SELECT AVG(nps) as v FROM pesquisas WHERE 1=1 ${pf}`).get() }).v;
  const avgCSAT = ({ ...db.prepare(`SELECT AVG(csat) as v FROM pesquisas WHERE 1=1 ${pf}`).get() }).v;
  const avgCES = ({ ...db.prepare(`SELECT AVG(ces) as v FROM pesquisas WHERE 1=1 ${pf}`).get() }).v;

  res.json({
    totals: {
      atendimentos: count('atendimentos'),
      gestoes:      count('gestao_clientes'),
      insatisfacoes: count('insatisfacoes'),
      sensiveis:    count('clientes_sensiveis'),
      pesquisas:    count('pesquisas'),
      recuperacoes: count('recuperacoes'),
    },
    charts: {
      atendPorDepto:    groupBy('atendimentos', 'departamento'),
      gestaoPorTipo:    groupBy('gestao_clientes', 'solicitacao'),
      insatPorGravidade: groupBy('insatisfacoes', 'gravidade'),
      gestaoPorCanal:   groupBy('gestao_clientes', 'canal'),
      sensivelPorGrav:  groupBy('clientes_sensiveis', 'gravidade'),
    },
    nps:  avgNPS  != null ? Math.round(avgNPS  * 10) / 10 : null,
    csat: avgCSAT != null ? Math.round(avgCSAT * 10) / 10 : null,
    ces:  avgCES  != null ? Math.round(avgCES  * 10) / 10 : null,
  });
});

// ── CLEAR DATA (admin only, by period) ───────────────────────────────────────
router.delete('/clear', requireAdmin, (req, res) => {
  const p = req.query.period;
  const pf = periodFilter(p);
  if (!pf && p !== 'todos') {
    return res.status(400).json({ error: 'Período inválido.' });
  }
  const tables = ['atendimentos', 'gestao_clientes', 'insatisfacoes', 'clientes_sensiveis', 'pesquisas', 'recuperacoes'];
  const condition = p === 'todos' ? '' : `WHERE 1=1 ${pf}`;
  tables.forEach(t => db.prepare(`DELETE FROM ${t} ${condition}`).run());
  res.json({ ok: true });
});

module.exports = router;
