'use strict';
/**
 * Lista canônica de analistas — CRUD simples, SEM login/senha.
 * Usada hoje pelo dropdown "Analista Procurado" do Atendimento (antes era
 * texto livre e gerava duplicidade tipo "Reysner" x "Resyner"). Pode
 * alimentar outros módulos no futuro (ex.: comparar com os nomes que vêm
 * do Zappy no módulo Sucesso do Cliente).
 *
 * Montar em server/index.js, junto dos outros routers:
 *   app.use('/api/analistas', require('./routes/analistas'));
 *
 * Endpoints:
 *   GET    /api/analistas?ativo=true   -> lista (todos, ou só ativos com ?ativo=true)
 *   POST   /api/analistas              -> cria { nome }  (reativa se já existir com esse nome)
 *   PATCH  /api/analistas/:id          -> ativa/desativa { ativo: true|false }
 *   DELETE /api/analistas/:id          -> apaga de vez (uso raro — prefira desativar)
 */
const express = require('express');
const router = express.Router();
const { pool } = require('../db');

let requireAuth, requireAdmin;
try {
  ({ requireAuth, requireAdmin } = require('../auth'));
} catch (e) {
  console.warn('[analistas] server/auth.js não encontrado — rotas SEM autenticação.');
  requireAuth = (req, res, next) => next();
  requireAdmin = (req, res, next) => next();
}

router.get('/', requireAuth, async (req, res) => {
  try {
    const somenteAtivos = req.query.ativo === 'true';
    const { rows } = await pool.query(
      somenteAtivos
        ? `SELECT id, nome, ativo FROM analistas WHERE ativo = TRUE ORDER BY nome`
        : `SELECT id, nome, ativo FROM analistas ORDER BY nome`
    );
    res.json({ analistas: rows });
  } catch (e) {
    console.error('[analistas] GET / falhou:', e);
    res.status(500).json({ error: e.message });
  }
});

router.post('/', requireAuth, requireAdmin, async (req, res) => {
  const nome = (req.body.nome || '').trim();
  if (!nome) return res.status(400).json({ error: 'Nome é obrigatório.' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO analistas (nome) VALUES ($1)
       ON CONFLICT (nome) DO UPDATE SET ativo = TRUE
       RETURNING id, nome, ativo`,
      [nome]
    );
    res.json({ analista: rows[0] });
  } catch (e) {
    console.error('[analistas] POST / falhou:', e);
    res.status(500).json({ error: e.message });
  }
});

router.patch('/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE analistas SET ativo = $1 WHERE id = $2 RETURNING id, nome, ativo`,
      [!!req.body.ativo, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Analista não encontrado.' });
    res.json({ analista: rows[0] });
  } catch (e) {
    console.error('[analistas] PATCH /:id falhou:', e);
    res.status(500).json({ error: e.message });
  }
});

router.delete('/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    await pool.query(`DELETE FROM analistas WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('[analistas] DELETE /:id falhou:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
