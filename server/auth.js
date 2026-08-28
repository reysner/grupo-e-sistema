'use strict';
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('./db');

// Achado na auditoria: antes, sem JWT_SECRET/JWT_REFRESH_SECRET configuradas
// no Render, o sistema caía silenciosamente pra uma string fixa e visível a
// qualquer um com acesso ao código no GitHub ('ge_access_secret_change_me')
// — dava pra forjar um login de administrador sabendo só isso. Mesmo
// cuidado que já existe pro ADMIN_PASS (recusa criar admin sem senha
// configurada), adaptado aqui pra não derrubar o servidor: se a variável
// não estiver definida, gera um segredo ALEATÓRIO a cada boot (nunca
// previsível) e avisa bem alto no log — sessões existentes são invalidadas
// a cada reinício nesse caso, mas ninguém consegue mais adivinhar o segredo.
function segredoOuAleatorio(nomeVar) {
  const valor = process.env[nomeVar];
  if (valor) return valor;
  console.error(
    `⚠️  ${nomeVar} não configurada — usando um valor aleatório gerado neste boot ` +
    `(todas as sessões serão invalidadas a cada reinício do servidor até isso ser corrigido). ` +
    `Configure ${nomeVar} no Render → Environment com um valor fixo e aleatório.`
  );
  return crypto.randomBytes(48).toString('hex');
}

const ACCESS_SECRET  = segredoOuAleatorio('JWT_SECRET');
const REFRESH_SECRET = segredoOuAleatorio('JWT_REFRESH_SECRET');
const ACCESS_TTL     = '2h';
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function signAccess(user) {
  return jwt.sign(
    { sub: user.id, name: user.name, role: user.role },
    ACCESS_SECRET,
    { expiresIn: ACCESS_TTL, issuer: 'grupo-e' }
  );
}

async function issueRefreshToken(userId) {
  const token     = uuidv4();
  const expiresAt = new Date(Date.now() + REFRESH_TTL_MS).toISOString();
  await pool.query(
    `INSERT INTO refresh_tokens (token, user_id, expires_at) VALUES ($1, $2, $3)`,
    [token, userId, expiresAt]
  );
  return { token, expiresAt };
}

async function revokeRefreshToken(token) {
  await pool.query(`DELETE FROM refresh_tokens WHERE token = $1`, [token]);
}

async function revokeAllUserTokens(userId) {
  await pool.query(`DELETE FROM refresh_tokens WHERE user_id = $1`, [userId]);
}

async function pruneExpiredTokens() {
  await pool.query(`DELETE FROM refresh_tokens WHERE expires_at < NOW()`);
}

const SALT_ROUNDS = 12;
async function hashPassword(plain) { return bcrypt.hash(plain, SALT_ROUNDS); }
async function checkPassword(plain, hash) { return bcrypt.compare(plain, hash); }

const IS_PROD = process.env.NODE_ENV === 'production';

function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  const token = auth && auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Não autenticado.' });
  try {
    const payload = jwt.verify(token, ACCESS_SECRET, { issuer: 'grupo-e' });
    req.user = { id: payload.sub, name: payload.name, role: payload.role };
    // Usuário contábil só pode acessar rotas de tickets — bloqueia o resto
    const isTicketRoute = req.path && (req.path.includes('/tickets') || req.path.includes('/auth') || req.path.includes('/perfil'));
    if (payload.role === 'contabil' && !isTicketRoute) {
      return res.status(403).json({ error: 'Acesso restrito ao portal contábil.' });
    }
    // Colaborador (28/08/2026, self-service da Gamificação): só pode ver a
    // própria nota — nunca dados de tickets, clientes, outros colaboradores
    // etc. Mesmo padrão do contabil acima, mas restrito às rotas
    // /gam/minha-* e /gam/meus-* (a nota/tickets da PRÓPRIA pessoa,
    // resolvida no backend a partir do login — nunca aceita um
    // colaborador_id vindo do cliente).
    const isMinhaNotaRoute = req.path && (req.path.includes('/gam/minha-') || req.path.includes('/gam/meus-') || req.path.includes('/auth') || req.path.includes('/perfil'));
    if (payload.role === 'colaborador' && !isMinhaNotaRoute) {
      return res.status(403).json({ error: 'Acesso restrito à sua nota da Gamificação.' });
    }
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
