'use strict';
/**
 * Lista canônica de Grupos de Empresas — CRUD simples, mesmo padrão de
 * server/routes/analistas.js (sem login/senha própria, só um cadastro
 * simples pra alimentar dropdown). Antes "Grupo de Empresas" era texto livre
 * em Gestão de Clientes, o que gerava duplicidade tipo "Grupo Capanema" x
 * "Grupo capanema". Usado pelo dropdown "Grupo de Empresas" em Gestão de
 * Clientes (ver Thais, pedido de gerenciar lista igual ao Analista Procurado).
 *
 * Montar em server/index.js, junto dos outros routers:
 *   app.use('/api/grupos-empresas', require('./routes/grupos-empresas'));
 *
 * Endpoints:
 *   GET    /api/grupos-empresas?ativo=true   -> lista (todos, ou só ativos com ?ativo=true)
 *   POST   /api/grupos-empresas              -> cria { nome }  (reativa se já existir com esse nome)
 *   PATCH  /api/grupos-empresas/:id          -> ativa/desativa { ativo: true|false }
 *   DELETE /api/grupos-empresas/:id          -> apaga de vez (uso raro — prefira desativar)
 */
const express = require('express');
const router = express.Router();
const { pool } = require('../db');

let requireAuth, requireAdmin;
try {
  ({ requireAuth, requireAdmin } = require('../auth'));
} catch (e) {
  console.warn('[grupos-empresas] server/auth.js não encontrado — rotas SEM autenticação.');
  requireAuth = (req, res, next) => next();
  requireAdmin = (req, res, next) => next();
}

async function garantirTabela() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS grupos_empresas (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      nome TEXT UNIQUE NOT NULL,
      ativo BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`).catch(() => {});
}

router.get('/', requireAuth, async (req, res) => {
  try {
    await garantirTabela();
    const somenteAtivos = req.query.ativo === 'true';
    const { rows } = await pool.query(
      somenteAtivos
        ? `SELECT id, nome, ativo FROM grupos_empresas WHERE ativo = TRUE ORDER BY nome`
        : `SELECT id, nome, ativo FROM grupos_empresas ORDER BY nome`
    );
    res.json({ grupos: rows });
  } catch (e) {
    console.error('[grupos-empresas] GET / falhou:', e);
    res.status(500).json({ error: e.message });
  }
});

router.post('/', requireAuth, requireAdmin, async (req, res) => {
  const nome = (req.body.nome || '').trim();
  if (!nome) return res.status(400).json({ error: 'Nome é obrigatório.' });
  try {
    await garantirTabela();
    const { rows } = await pool.query(
      `INSERT INTO grupos_empresas (nome) VALUES ($1)
       ON CONFLICT (nome) DO UPDATE SET ativo = TRUE
       RETURNING id, nome, ativo`,
      [nome]
    );
    res.json({ grupo: rows[0] });
  } catch (e) {
    console.error('[grupos-empresas] POST / falhou:', e);
    res.status(500).json({ error: e.message });
  }
});

router.patch('/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE grupos_empresas SET ativo = $1 WHERE id = $2 RETURNING id, nome, ativo`,
      [!!req.body.ativo, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Grupo não encontrado.' });
    res.json({ grupo: rows[0] });
  } catch (e) {
    console.error('[grupos-empresas] PATCH /:id falhou:', e);
    res.status(500).json({ error: e.message });
  }
});

router.delete('/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    await pool.query(`DELETE FROM grupos_empresas WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('[grupos-empresas] DELETE /:id falhou:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
