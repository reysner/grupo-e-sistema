'use strict';
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const rateLimit = require('express-rate-limit');
const { pool } = require('../db');
const auth = require('../auth');

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20,
  message: { error: 'Muitas tentativas. Tente em 15 minutos.' },
  standardHeaders: true, legacyHeaders: false,
});

// Cadastro público DESLIGADO (31/10/2026, pedido do Reysner): a conta nova entrava como 'usuario' e enxergava a Carteira (com honorários),
// o /cs e o /financeiro. Quem precisa de acesso é criado por um administrador (Administração → Usuários).
// Para reabrir de propósito, defina CADASTRO_PUBLICO=1 no ambiente.
const CADASTRO_PUBLICO = process.env.CADASTRO_PUBLICO === '1';

// POST /api/auth/register
router.post('/register', loginLimiter, async (req, res) => {
  if (!CADASTRO_PUBLICO) return res.status(403).json({ error: 'O cadastro está desativado. Peça a um administrador para criar o seu acesso.' });
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password)
      return res.status(400).json({ error: 'Nome, e-mail e senha são obrigatórios.' });
    if (password.length < 6)
      return res.status(400).json({ error: 'Senha deve ter ao menos 6 caracteres.' });

    const existing = await pool.query(`SELECT id FROM users WHERE LOWER(email) = LOWER($1)`, [email]);
    if (existing.rows.length > 0) return res.status(409).json({ error: 'E-mail já cadastrado.' });

    const hashedPw = await auth.hashPassword(password);
    const id = uuidv4();
    // SEGURANÇA: o cadastro público NUNCA aceita o perfil vindo do cliente — sempre
    // cria como 'usuario', ignorando qualquer valor de "role" que venha no corpo da
    // requisição. Virar administrador ou contábil só é possível depois, manualmente,
    // por um administrador já autenticado (tela de Administração → Usuários).
    const userRole = 'usuario';
    await pool.query(
      `INSERT INTO users (id, name, email, password, role) VALUES ($1, $2, $3, $4, $5)`,
      [id, name.trim(), email.toLowerCase().trim(), hashedPw, userRole]
    );

    const accessToken = auth.signAccess({ id, name: name.trim(), role: userRole });
    const { token: refreshToken } = await auth.issueRefreshToken(id);
    return res.status(201).json({ token: accessToken, refreshToken, user: { id, name: name.trim(), email, role: userRole } });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Erro ao registrar.' });
  }
});

/** Acessos do painel /cs definidos pela administração (Acessos): módulos de indicadores dão a marca acesso_cs; módulos de Qualidade/portais dão a marca acesso_gestor. Falha = sem acréscimo. */
async function marcasDoPainel(userId) {
  try { return await require('../cs/acessos').marcasDeAcesso(userId); } catch (e) { return { cs: false, portais: false }; }
}

/** Quem está cadastrado como gestor/diretor em algum departamento (Qualidade > Gerenciar gestores) ganha a marca acesso_gestor. Falha na consulta = sem a marca. */
async function ehGestorDeQualidade(userId) {
  try { return (await pool.query('SELECT 1 FROM cs_qualidade_gestores WHERE user_id = $1 LIMIT 1', [String(userId)])).rows.length > 0; }
  catch (e) { return false; }
}

// POST /api/auth/login
router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: 'E-mail e senha são obrigatórios.' });

    const result = await pool.query(
      `SELECT * FROM users WHERE LOWER(email) = LOWER($1) AND active = 1`, [email]
    );
    const row = result.rows[0];
    if (!row) return res.status(401).json({ error: 'E-mail ou senha incorretos.' });

    const match = await auth.checkPassword(password, row.password);
    if (!match) return res.status(401).json({ error: 'E-mail ou senha incorretos.' });

    const marcasCs = await marcasDoPainel(row.id);
    const user = { id: row.id, name: row.name, role: row.role, acesso_gestor: (await ehGestorDeQualidade(row.id)) || marcasCs.portais, acesso_minha_nota: !!row.acesso_minha_nota, acesso_legalizacao: !!row.acesso_legalizacao, acesso_cs: !!row.acesso_cs || marcasCs.cs, acesso_financeiro: !!row.acesso_financeiro, acesso_qualidade: !!row.acesso_qualidade, acesso_financeiro_sv: !!row.acesso_financeiro_sv };
    const accessToken = auth.signAccess(user);
    const { token: refreshToken } = await auth.issueRefreshToken(row.id);
    return res.json({ token: accessToken, refreshToken, user: { id: row.id, name: row.name, email: row.email, role: row.role, acesso_gestor: user.acesso_gestor, acesso_minha_nota: !!row.acesso_minha_nota, acesso_legalizacao: !!row.acesso_legalizacao, acesso_cs: !!row.acesso_cs || marcasCs.cs, acesso_financeiro: !!row.acesso_financeiro, acesso_qualidade: !!row.acesso_qualidade, acesso_financeiro_sv: !!row.acesso_financeiro_sv } });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Erro ao fazer login.' });
  }
});

// POST /api/auth/refresh
router.post('/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(401).json({ error: 'Sem refresh token.' });

    const result = await pool.query(
      `SELECT rt.*, u.name, u.role, u.active, u.acesso_minha_nota, u.acesso_legalizacao, u.acesso_cs, u.acesso_financeiro, u.acesso_qualidade, u.acesso_financeiro_sv
       FROM refresh_tokens rt
       JOIN users u ON u.id = rt.user_id
       WHERE rt.token = $1 AND rt.expires_at > NOW()`,
      [refreshToken]
    );
    const row = result.rows[0];
    if (!row || !row.active)
      return res.status(401).json({ error: 'Sessão expirada. Faça login novamente.' });

    await auth.revokeRefreshToken(refreshToken);
    const marcasCs = await marcasDoPainel(row.user_id);
    const user = { id: row.user_id, name: row.name, role: row.role, acesso_gestor: (await ehGestorDeQualidade(row.user_id)) || marcasCs.portais, acesso_minha_nota: !!row.acesso_minha_nota, acesso_legalizacao: !!row.acesso_legalizacao, acesso_cs: !!row.acesso_cs || marcasCs.cs, acesso_financeiro: !!row.acesso_financeiro, acesso_qualidade: !!row.acesso_qualidade, acesso_financeiro_sv: !!row.acesso_financeiro_sv };
    const accessToken = auth.signAccess(user);
    const { token: newRefresh } = await auth.issueRefreshToken(row.user_id);
    return res.json({ token: accessToken, refreshToken: newRefresh, user });
  } catch (err) {
    console.error('Refresh error:', err);
    res.status(500).json({ error: 'Erro ao renovar sessão.' });
  }
});

// POST /api/auth/logout
router.post('/logout', auth.requireAuth, async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (refreshToken) await auth.revokeRefreshToken(refreshToken);
    return res.json({ ok: true });
  } catch (err) {
    res.json({ ok: true });
  }
});

// GET /api/auth/me
router.get('/me', auth.requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`SELECT id, name, email, role FROM users WHERE id = $1`, [req.user.id]);
    const row = result.rows[0];
    if (!row) return res.status(404).json({ error: 'Usuário não encontrado.' });
    return res.json({ user: row });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar usuário.' });
  }
});

module.exports = router;
