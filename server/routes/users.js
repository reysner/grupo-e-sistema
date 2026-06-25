'use strict';
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db');
const { requireAuth, requireAdmin, hashPassword, revokeAllUserTokens } = require('../auth');

const router = express.Router();
router.use(requireAuth, requireAdmin);

// GET /api/users
router.get('/', (req, res) => {
  const users = db.prepare(
    `SELECT id, name, email, role, active, created_at FROM users ORDER BY created_at ASC`
  ).all().map(r => ({ ...r }));
  res.json({ users });
});

// POST /api/users
router.post('/', async (req, res) => {
  const { name, email, password, role } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Nome, e-mail e senha são obrigatórios.' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Senha deve ter ao menos 8 caracteres.' });
  }
  const existing = db.prepare(`SELECT id FROM users WHERE email = ? COLLATE NOCASE`).get(email);
  if (existing) return res.status(409).json({ error: 'E-mail já cadastrado.' });

  const hashedPw = await hashPassword(password);
  const id = uuidv4();
  const allowedRoles = ['usuario', 'administrador'];
  const userRole = allowedRoles.includes(role) ? role : 'usuario';

  db.prepare(
    `INSERT INTO users (id, name, email, password, role) VALUES (?, ?, ?, ?, ?)`
  ).run(id, name.trim(), email.toLowerCase().trim(), hashedPw, userRole);

  res.status(201).json({ user: { id, name: name.trim(), email, role: userRole } });
});

// PATCH /api/users/:id/password
router.patch('/:id/password', async (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'Senha deve ter ao menos 8 caracteres.' });
  }
  const user = db.prepare(`SELECT id FROM users WHERE id = ?`).get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' });

  const hashedPw = await hashPassword(password);
  db.prepare(`UPDATE users SET password = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(hashedPw, req.params.id);
  revokeAllUserTokens(req.params.id);

  res.json({ ok: true });
});

// PATCH /api/users/:id/role
router.patch('/:id/role', (req, res) => {
  const { role } = req.body;
  if (!['usuario', 'administrador'].includes(role)) {
    return res.status(400).json({ error: 'Role inválida.' });
  }
  db.prepare(`UPDATE users SET role = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(role, req.params.id);
  res.json({ ok: true });
});

// DELETE /api/users/:id
router.delete('/:id', (req, res) => {
  if (req.params.id === req.user.id) {
    return res.status(400).json({ error: 'Não é possível excluir seu próprio usuário.' });
  }
  revokeAllUserTokens(req.params.id);
  db.prepare(`DELETE FROM users WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
