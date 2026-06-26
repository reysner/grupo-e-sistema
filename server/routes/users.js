'use strict';
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db');
const { requireAuth, requireAdmin, hashPassword, revokeAllUserTokens } = require('../auth');

const router = express.Router();
router.use(requireAuth, requireAdmin);

// GET /api/users
router.get('/', (req, res) => {
  try {
    const users = db.prepare(
      `SELECT id, name, email, role, active, created_at FROM users ORDER BY created_at ASC`
    ).all().map(r => ({ ...r }));
    res.json({ users });
  } catch (err) {
    console.error('GET /users error:', err);
    res.status(500).json({ error: 'Erro ao buscar usuários.' });
  }
});

// POST /api/users
router.post('/', async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    if (!name || !email || !password)
      return res.status(400).json({ error: 'Nome, e-mail e senha são obrigatórios.' });
    if (password.length < 6)
      return res.status(400).json({ error: 'Senha deve ter ao menos 6 caracteres.' });

    const existing = db.prepare(`SELECT id FROM users WHERE email = ? COLLATE NOCASE`).get(email);
    if (existing) return res.status(409).json({ error: 'E-mail já cadastrado.' });

    const hashedPw = await hashPassword(password);
    const id = uuidv4();
    const userRole = ['usuario', 'administrador'].includes(role) ? role : 'usuario';

    db.prepare(`INSERT INTO users (id, name, email, password, role) VALUES (?, ?, ?, ?, ?)`)
      .run(id, name.trim(), email.toLowerCase().trim(), hashedPw, userRole);

    res.status(201).json({ user: { id, name: name.trim(), email, role: userRole } });
  } catch (err) {
    console.error('POST /users error:', err);
    if (err.code === 'ERR_SQLITE_ERROR' && err.errstr === 'constraint failed') {
      return res.status(409).json({ error: 'E-mail já cadastrado.' });
    }
    res.status(500).json({ error: 'Erro ao criar usuário.' });
  }
});

// PATCH /api/users/:id/password
router.patch('/:id/password', async (req, res) => {
  try {
    const { password } = req.body;
    if (!password || password.length < 6)
      return res.status(400).json({ error: 'Senha deve ter ao menos 6 caracteres.' });

    const user = db.prepare(`SELECT id FROM users WHERE id = ?`).get(req.params.id);
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' });

    const hashedPw = await hashPassword(password);
    db.prepare(`UPDATE users SET password = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(hashedPw, req.params.id);
    revokeAllUserTokens(req.params.id);

    res.json({ ok: true });
  } catch (err) {
    console.error('PATCH /users password error:', err);
    res.status(500).json({ error: 'Erro ao atualizar senha.' });
  }
});

// PATCH /api/users/:id/role
router.patch('/:id/role', (req, res) => {
  try {
    const { role } = req.body;
    if (!['usuario', 'administrador'].includes(role))
      return res.status(400).json({ error: 'Perfil inválido.' });
    db.prepare(`UPDATE users SET role = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(role, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao atualizar perfil.' });
  }
});

// DELETE /api/users/:id
router.delete('/:id', (req, res) => {
  try {
    if (req.params.id === req.user.id)
      return res.status(400).json({ error: 'Não é possível excluir seu próprio usuário.' });
    revokeAllUserTokens(req.params.id);
    db.prepare(`DELETE FROM users WHERE id = ?`).run(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao excluir usuário.' });
  }
});

module.exports = router;
