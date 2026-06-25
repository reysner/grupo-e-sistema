'use strict';
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const rateLimit = require('express-rate-limit');
const { db } = require('../db');
const auth = require('../auth');

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Muitas tentativas. Tente novamente em 15 minutos.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// POST /api/auth/register
router.post('/register', loginLimiter, async (req, res) => {
  const { name, email, password, role } = req.body;
  if (!name || !email || !password)
    return res.status(400).json({ error: 'Nome, e-mail e senha são obrigatórios.' });
  if (password.length < 6)
    return res.status(400).json({ error: 'Senha deve ter ao menos 6 caracteres.' });

  const existing = db.prepare(`SELECT id FROM users WHERE email = ? COLLATE NOCASE`).get(email);
  if (existing) return res.status(409).json({ error: 'E-mail já cadastrado.' });

  const hashedPw = await auth.hashPassword(password);
  const id = uuidv4();
  const userRole = ['usuario','administrador'].includes(role) ? role : 'usuario';
  db.prepare(`INSERT INTO users (id, name, email, password, role) VALUES (?, ?, ?, ?, ?)`)
    .run(id, name.trim(), email.toLowerCase().trim(), hashedPw, userRole);

  const accessToken   = auth.signAccess({ id, name: name.trim(), role: userRole });
  const { token: refreshToken } = auth.issueRefreshToken(id);
  return res.status(201).json({
    token: accessToken,
    refreshToken,
    user: { id, name: name.trim(), email, role: userRole }
  });
});

// POST /api/auth/login
router.post('/login', loginLimiter, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: 'E-mail e senha são obrigatórios.' });

  const row = db.prepare(`SELECT * FROM users WHERE email = ? COLLATE NOCASE AND active = 1`).get(email);
  if (!row) return res.status(401).json({ error: 'E-mail ou senha incorretos.' });

  const match = await auth.checkPassword(password, row.password);
  if (!match) return res.status(401).json({ error: 'E-mail ou senha incorretos.' });

  const user = { id: row.id, name: row.name, role: row.role };
  const accessToken = auth.signAccess(user);
  const { token: refreshToken } = auth.issueRefreshToken(row.id);

  return res.json({
    token: accessToken,
    refreshToken,
    user: { id: row.id, name: row.name, email: row.email, role: row.role }
  });
});

// POST /api/auth/refresh
router.post('/refresh', (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(401).json({ error: 'Sem refresh token.' });

  const row = db.prepare(
    `SELECT rt.*, u.name, u.role, u.active
     FROM refresh_tokens rt
     JOIN users u ON u.id = rt.user_id
     WHERE rt.token = ? AND rt.expires_at > datetime('now')`
  ).get(refreshToken);

  if (!row || !row.active)
    return res.status(401).json({ error: 'Sessão expirada. Faça login novamente.' });

  auth.revokeRefreshToken(refreshToken);
  const user = { id: row.user_id, name: row.name, role: row.role };
  const accessToken = auth.signAccess(user);
  const { token: newRefresh } = auth.issueRefreshToken(row.user_id);

  return res.json({ token: accessToken, refreshToken: newRefresh, user });
});

// POST /api/auth/logout
router.post('/logout', auth.requireAuth, (req, res) => {
  const { refreshToken } = req.body;
  if (refreshToken) auth.revokeRefreshToken(refreshToken);
  return res.json({ ok: true });
});

// GET /api/auth/me
router.get('/me', auth.requireAuth, (req, res) => {
  const row = db.prepare(`SELECT id, name, email, role FROM users WHERE id = ?`).get(req.user.id);
  if (!row) return res.status(404).json({ error: 'Usuário não encontrado.' });
  return res.json({ user: { ...row } });
});

module.exports = router;
