'use strict';
// Rotas públicas de recuperação de senha (sem login)
// Monte no index.js com:  app.use('/api/auth', require('./reset'));
const express = require('express');
const crypto = require('crypto');
const { pool } = require('./db');
const { hashPassword, revokeAllUserTokens } = require('./auth');
const { enviarEmailRecuperacao } = require('./mailer');

const router = express.Router();

async function ensureResetTable() {
  await pool.query(`CREATE TABLE IF NOT EXISTS reset_tokens (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`).catch(()=>{});
}

// POST /api/auth/forgot-password  { email }
router.post('/forgot-password', async (req, res) => {
  try {
    await ensureResetTable();
    const { email } = req.body;
    // Resposta genérica SEMPRE (não revela se o e-mail existe)
    const respostaPadrao = { ok: true, message: 'Se o e-mail estiver cadastrado, enviaremos as instruções de recuperação.' };
    if (!email) return res.json(respostaPadrao);

    const u = await pool.query(`SELECT id, name, email FROM users WHERE LOWER(email) = LOWER($1) AND (active IS NULL OR active <> 0)`, [email]);
    if (!u.rows.length) return res.json(respostaPadrao); // não vaza que o e-mail não existe

    const user = u.rows[0];
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hora

    // Invalida tokens anteriores desse usuário e cria o novo
    await pool.query(`DELETE FROM reset_tokens WHERE user_id = $1`, [user.id]).catch(()=>{});
    await pool.query(
      `INSERT INTO reset_tokens (token, user_id, expires_at) VALUES ($1, $2, $3)`,
      [token, user.id, expiresAt]
    );

    // Responde IMEDIATAMENTE (não espera o e-mail sair) — evita travar a requisição
    res.json(respostaPadrao);

    // Envia o e-mail em segundo plano; qualquer falha vai só para o log
    enviarEmailRecuperacao(user.email, user.name, token)
      .then(() => console.log('[forgot-password] e-mail enviado para', user.email))
      .catch(e => console.error('[forgot-password] falha ao enviar e-mail:', e.message));
    return;
  } catch (err) {
    console.error('forgot-password error:', err);
    if (!res.headersSent) return res.json({ ok: true, message: 'Se o e-mail estiver cadastrado, enviaremos as instruções de recuperação.' });
  }
});

// Removido: GET /api/auth/testar-email — era uma rota de diagnóstico deixada
// pública sem querer (achado na auditoria: qualquer um podia mandar e-mail
// de verdade pela conta Gmail do sistema pra qualquer destinatário, sem
// login). O envio de e-mail já está confirmado funcionando pelo fluxo real
// de recuperação de senha — não precisa mais dessa rota de teste.

// GET /api/auth/reset-valido?token=...  -> confere se o token é válido (para a página de reset)
router.get('/reset-valido', async (req, res) => {
  try {
    await ensureResetTable();
    const { token } = req.query;
    if (!token) return res.json({ valido: false });
    const r = await pool.query(
      `SELECT user_id FROM reset_tokens WHERE token = $1 AND used = false AND expires_at > NOW()`,
      [token]
    );
    res.json({ valido: r.rows.length > 0 });
  } catch (err) { res.json({ valido: false }); }
});

// POST /api/auth/reset-password  { token, senha }
router.post('/reset-password', async (req, res) => {
  try {
    await ensureResetTable();
    const { token, senha } = req.body;
    if (!token || !senha) return res.status(400).json({ error: 'Token e nova senha são obrigatórios.' });
    if (senha.length < 6) return res.status(400).json({ error: 'A senha deve ter ao menos 6 caracteres.' });

    const r = await pool.query(
      `SELECT user_id FROM reset_tokens WHERE token = $1 AND used = false AND expires_at > NOW()`,
      [token]
    );
    if (!r.rows.length) return res.status(400).json({ error: 'Link inválido ou expirado. Solicite um novo.' });

    const userId = r.rows[0].user_id;
    const novoHash = await hashPassword(senha);

    // Atualiza a senha (a coluna pode ser password_hash ou password, dependendo do schema)
    const col = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name='users' AND column_name IN ('password_hash','password')`);
    const nomes = col.rows.map(c => c.column_name);
    if (nomes.includes('password_hash')) {
      await pool.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [novoHash, userId]);
    } else {
      await pool.query(`UPDATE users SET password = $1 WHERE id = $2`, [novoHash, userId]);
    }

    // Marca o token como usado e revoga sessões ativas do usuário
    await pool.query(`UPDATE reset_tokens SET used = true WHERE token = $1`, [token]);
    await revokeAllUserTokens(userId).catch(()=>{});

    res.json({ ok: true, message: 'Senha redefinida com sucesso. Você já pode entrar com a nova senha.' });
  } catch (err) {
    console.error('reset-password error:', err);
    res.status(500).json({ error: 'Erro ao redefinir a senha.' });
  }
});

module.exports = router;
