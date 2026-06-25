'use strict';
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { db } = require('./db');

const ACCESS_SECRET  = process.env.JWT_SECRET        || 'ge_access_secret_change_me';
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'ge_refresh_secret_change_me';
const ACCESS_TTL     = '2h';
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function signAccess(user) {
  return jwt.sign(
    { sub: user.id, name: user.name, role: user.role },
    ACCESS_SECRET,
    { expiresIn: ACCESS_TTL, issuer: 'grupo-e' }
  );
}

function issueRefreshToken(userId) {
  const token     = uuidv4();
  const expiresAt = new Date(Date.now() + REFRESH_TTL_MS).toISOString();
  db.prepare(`INSERT INTO refresh_tokens (token, user_id, expires_at) VALUES (?, ?, ?)`)
    .run(token, userId, expiresAt);
  return { token, expiresAt };
}

function revokeRefreshToken(token) {
  db.prepare(`DELETE FROM refresh_tokens WHERE token = ?`).run(token);
}

function revokeAllUserTokens(userId) {
  db.prepare(`DELETE FROM refresh_tokens WHERE user_id = ?`).run(userId);
}

function pruneExpiredTokens() {
  db.prepare(`DELETE FROM refresh_tokens WHERE expires_at < datetime('now')`).run();
}

const SALT_ROUNDS = 12;
async function hashPassword(plain) { return bcrypt.hash(plain, SALT_ROUNDS); }
async function checkPassword(plain, hash) { return bcrypt.compare(plain, hash); }

// Sem cookies — token vai no corpo da resposta, frontend guarda no localStorage
function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  const token = auth && auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Não autenticado.' });
  try {
    const payload = jwt.verify(token, ACCESS_SECRET, { issuer: 'grupo-e' });
    req.user = { id: payload.sub, name: payload.name, role: payload.role };
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') return res.status(401).json({ error: 'token_expired' });
    return res.status(401).json({ error: 'Token inválido.' });
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'administrador')
    return res.status(403).json({ error: 'Acesso restrito a administradores.' });
  next();
}

module.exports = {
  signAccess, issueRefreshToken, revokeRefreshToken, revokeAllUserTokens,
  pruneExpiredTokens, hashPassword, checkPassword,
  requireAuth, requireAdmin,
};
