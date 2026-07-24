'use strict';
/**
 * Lista canônica de Unidades (ex.: "Escritorial Contadores", "Escritorial
 * Soluções") — mesmo padrão de server/routes/grupos-empresas.js e
 * server/routes/analistas.js. Marca em qual unidade/CNPJ do escritório cada
 * empresa da Carteira está cadastrada (pedido da Thais: já vem determinado
 * na hora de cadastrar novos CNPJs, e alimenta o filtro/ticket médio por
 * unidade em Gestão de Clientes — ex.: 250 empresas na Contadores x 100 na
 * Soluções, com ticket médio diferente pra cada lado).
 *
 * Montar em server/index.js, junto dos outros routers:
 *   app.use('/api/unidades', require('./routes/unidades'));
 *
 * Endpoints:
 *   GET    /api/unidades?ativo=true   -> lista (todas, ou só ativas com ?ativo=true)
 *   POST   /api/unidades              -> cria { nome }  (reativa se já existir com esse nome)
 *   PATCH  /api/unidades/:id          -> ativa/desativa { ativo: true|false }
 *   DELETE /api/unidades/:id          -> apaga de vez (uso raro — prefira desativar)
 */
const express = require('express');
const router = express.Router();
const { pool } = require('../db');

let requireAuth, requireAdmin;
try {
  ({ requireAuth, requireAdmin } = require('../auth'));
} catch (e) {
  console.warn('[unidades] server/auth.js não encontrado — rotas SEM autenticação.');
  requireAuth = (req, res, next) => next();
  requireAdmin = (req, res, next) => next();
}

async function garantirTabela() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS unidades (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      nome TEXT UNIQUE NOT NULL,
      ativo BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`).catch(() => {});
}

router.get('/', requireAuth, async (req, res) => {
  try {
    await garantirTabela();
    const somenteAtivas = req.query.ativo === 'true';
    const { rows } = await pool.query(
      somenteAtivas
        ? `SELECT id, nome, ativo FROM unidades WHERE ativo = TRUE ORDER BY nome`
        : `SELECT id, nome, ativo FROM unidades ORDER BY nome`
    );
    res.json({ unidades: rows });
  } catch (e) {
    console.error('[unidades] GET / falhou:', e);
    res.status(500).json({ error: e.message });
  }
});

router.post('/', requireAuth, requireAdmin, async (req, res) => {
  const nome = (req.body.nome || '').trim();
  if (!nome) return res.status(400).json({ error: 'Nome é obrigatório.' });
  try {
    await garantirTabela();
    const { rows } = await pool.query(
      `INSERT INTO unidades (nome) VALUES ($1)
       ON CONFLICT (nome) DO UPDATE SET ativo = TRUE
       RETURNING id, nome, ativo`,
      [nome]
    );
    res.json({ unidade: rows[0] });
  } catch (e) {
    console.error('[unidades] POST / falhou:', e);
    res.status(500).json({ error: e.message });
  }
});

router.patch('/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE unidades SET ativo = $1 WHERE id = $2 RETURNING id, nome, ativo`,
      [!!req.body.ativo, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Unidade não encontrada.' });
    res.json({ unidade: rows[0] });
  } catch (e) {
    console.error('[unidades] PATCH /:id falhou:', e);
    res.status(500).json({ error: e.message });
  }
});

router.delete('/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    await pool.query(`DELETE FROM unidades WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('[unidades] DELETE /:id falhou:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
