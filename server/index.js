'use strict';
require('dotenv').config();

const express      = require('express');
const cors         = require('cors');
const cookieParser = require('cookie-parser');
const rateLimit    = require('express-rate-limit');
const path         = require('path');

const { init: initDB, pruneExpiredTokens } = require('./db');
const authRoutes  = require('./routes/auth');
const dataRoutes  = require('./routes/data');
const usersRoutes = require('./routes/users');
const gamificacaoRoutes = require('./routes/gamificacao');
const resetRoutes = require('./reset');
const csRoutes = require('./cs/routes');


const app    = express();
const PUBLIC = path.join(__dirname, '..', 'public');

// Headers de segurança básicos
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : ['http://localhost:3000'];

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error('CORS não permitido.'));
  },
  credentials: true,
}));

app.use(cookieParser());
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: false }));
app.set('trust proxy', 1);
app.use(rateLimit({ windowMs: 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false }));

// Keep-alive
const APP_URL = process.env.APP_URL;
if (APP_URL) {
  const https = require('https');
  const http  = require('http');
  const requester = APP_URL.startsWith('https') ? https : http;
  setInterval(() => { requester.get(`${APP_URL}/health`, () => {}).on('error', () => {}); }, 14 * 60 * 1000);
  console.log(`🏓 Keep-alive ativado → ${APP_URL}`);
}

// ── API Routes ────────────────────────────────────────────────────────────────
app.use('/api/public', dataRoutes.publicRouter);   // sem autenticação
app.use('/api/auth',   resetRoutes);               // recuperação de senha (forgot/reset) — sem login
app.use('/api/auth',   authRoutes);
app.use('/api/data',   dataRoutes);
app.use('/api/cs',     csRoutes);
app.use('/api/users',  usersRoutes);

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// ── Página pública da pesquisa (sem login) ────────────────────────────────────
app.get('/pesquisa', (req, res) => {
  res.sendFile(path.join(PUBLIC, 'pesquisa.html'));
});

// ── Página pública da gamificação (sem login) ─────────────────────────────────
app.get('/gamificacao', (req, res) => {
  res.sendFile(path.join(PUBLIC, 'gamificacao.html'));
});

// ── Página do contábil (login próprio) ────────────────────────────────────────
app.get('/contabil', (req, res) => {
  res.sendFile(path.join(PUBLIC, 'contabil.html'));
});

// ── Arquivos estáticos com MIME correto ───────────────────────────────────────
app.get('/js/:file', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.sendFile(path.join(PUBLIC, 'js', req.params.file));
});
app.get('/css/:file', (req, res) => {
  res.setHeader('Content-Type', 'text/css');
  res.sendFile(path.join(PUBLIC, 'css', req.params.file));
});
app.use(express.static(PUBLIC, { maxAge: '0', etag: false }));

// ── SPA fallback (deve ser o ÚLTIMO) ─────────────────────────────────────────
app.get('*', (req, res) => res.sendFile(path.join(PUBLIC, 'index.html')));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Erro interno do servidor.' });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

initDB().then(async () => {
  const bcrypt = require('bcryptjs');
  const { v4: uuidv4 } = require('uuid');
  const { pool } = require('./db');

  const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@grupoe.com.br';
  const ADMIN_PASS  = process.env.ADMIN_PASS  || 'Admin@2024!';
  const ADMIN_NAME  = process.env.ADMIN_NAME  || 'Administrador';

  const existing = await pool.query(`SELECT id FROM users WHERE LOWER(email) = LOWER($1)`, [ADMIN_EMAIL]);
  if (existing.rows.length === 0) {
    const hash = await bcrypt.hash(ADMIN_PASS, 12);
    await pool.query(
      `INSERT INTO users (id, name, email, password, role) VALUES ($1, $2, $3, $4, $5)`,
      [uuidv4(), ADMIN_NAME, ADMIN_EMAIL.toLowerCase(), hash, 'administrador']
    );
    console.log(`✅ Admin criado: ${ADMIN_EMAIL}`);
  } else {
    console.log(`✅ Admin verificado: ${ADMIN_EMAIL}`);
  }

  setInterval(() => pruneExpiredTokens().catch(console.error), 24 * 60 * 60 * 1000);
  app.listen(PORT, () => console.log(`🚀 Grupo-E rodando na porta ${PORT}`));
}).catch(err => {
  console.error('❌ Erro ao conectar ao banco:', err);
  process.exit(1);
});
