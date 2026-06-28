'use strict';
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../db');
const { requireAuth, requireAdmin, hashPassword, revokeAllUserTokens } = require('../auth');

const router = express.Router();
router.use(requireAuth, requireAdmin);

router.get('/', async (req, res) => {
  try {
    const result = await pool.query(`SELECT id, name, email, role, active, created_at FROM users ORDER BY created_at ASC`);
    const users = result.rows.map(u => ({ ...u, ativo: u.active !== false }));
    res.json({ users });
  } catch (err) { res.status(500).json({ error: 'Erro ao listar usuários.' }); }
});

router.post('/', async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    if (!name || !email || !password)
      return res.status(400).json({ error: 'Nome, e-mail e senha são obrigatórios.' });
    if (password.length < 6)
      return res.status(400).json({ error: 'Senha deve ter ao menos 6 caracteres.' });

    const existing = await pool.query(`SELECT id FROM users WHERE LOWER(email) = LOWER($1)`, [email]);
    if (existing.rows.length > 0) return res.status(409).json({ error: 'E-mail já cadastrado.' });

    const hashedPw = await hashPassword(password);
    const id = uuidv4();
    const userRole = ['usuario','administrador'].includes(role) ? role : 'usuario';
    await pool.query(
      `INSERT INTO users (id, name, email, password, role) VALUES ($1, $2, $3, $4, $5)`,
      [id, name.trim(), email.toLowerCase().trim(), hashedPw, userRole]
    );
    res.status(201).json({ user: { id, name: name.trim(), email, role: userRole } });
  } catch (err) {
    console.error('Create user error:', err);
    res.status(500).json({ error: 'Erro ao criar usuário.' });
  }
});

router.patch('/:id/password', async (req, res) => {
  try {
    const { password } = req.body;
    if (!password || password.length < 6)
      return res.status(400).json({ error: 'Senha deve ter ao menos 6 caracteres.' });
    const hashedPw = await hashPassword(password);
    await pool.query(`UPDATE users SET password = $1, updated_at = NOW() WHERE id = $2`, [hashedPw, req.params.id]);
    await revokeAllUserTokens(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao atualizar senha.' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    if (req.params.id === req.user.id)
      return res.status(400).json({ error: 'Não é possível excluir seu próprio usuário.' });
    await revokeAllUserTokens(req.params.id);
    await pool.query(`DELETE FROM users WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao excluir usuário.' });
  }
});

// Toggle ativo/inativo
router.patch('/:id/toggle', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT active FROM users WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Usuário não encontrado.' });
    const newActive = !rows[0].active;
    await pool.query('UPDATE users SET active = $1 WHERE id = $2', [newActive, req.params.id]);
    res.json({ ok: true, active: newActive });
  } catch (err) { res.status(500).json({ error: 'Erro ao alterar status.' }); }
});

module.exports = router;

// PATCH /api/users/:id/profile (name + email)
router.patch('/:id/profile', async (req, res) => {
  try {
    const { name, email } = req.body;
    if (!name || !email) return res.status(400).json({ error: 'Nome e e-mail são obrigatórios.' });

    // Check email not taken by another user
    const existing = await pool.query(
      `SELECT id FROM users WHERE LOWER(email) = LOWER($1) AND id != $2`, [email, req.params.id]
    );
    if (existing.rows.length > 0) return res.status(409).json({ error: 'E-mail já usado por outro usuário.' });

    await pool.query(
      `UPDATE users SET name = $1, email = $2, updated_at = NOW() WHERE id = $3`,
      [name.trim(), email.toLowerCase().trim(), req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('PATCH profile error:', err);
    res.status(500).json({ error: 'Erro ao atualizar perfil.' });
  }
});
