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
app.use('/api/users',  usersRoutes);
app.use('/api/cs',     require('./cs/routes'));    // Sucesso do Cliente — radar de SLA
app.use('/api/analistas', require('./routes/analistas'));  // lista de analistas p/ dropdowns
app.use('/api/grupos-empresas', require('./routes/grupos-empresas'));  // lista de grupos de empresas p/ dropdown
app.use('/api/unidades', require('./routes/unidades'));  // lista de unidades (Escritorial Contadores/Soluções) p/ dropdown
app.use('/api/motivos-churn', require('./routes/motivos-churn'));  // lista de motivos de churn p/ dropdown (só em "Saída de empresa")

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

// ── Regras da Liga do Atendimento — como a nota de cada um é calculada,
// explicado pros analistas (sem login, mesmo espírito da página do ranking).
app.get('/gamificacao/regras', (req, res) => {
  res.sendFile(path.join(PUBLIC, 'gamificacao-regras.html'));
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
  const ADMIN_PASS  = process.env.ADMIN_PASS  || null;
  const ADMIN_NAME  = process.env.ADMIN_NAME  || 'Administrador';

  const existing = await pool.query(`SELECT id FROM users WHERE LOWER(email) = LOWER($1)`, [ADMIN_EMAIL]);
  if (existing.rows.length === 0) {
    // Sem ADMIN_PASS configurada no ambiente, NÃO cria admin com senha
    // previsível — antes disso o fallback era 'Admin@2024!' fixo no código,
    // visível a qualquer um com acesso ao repositório do GitHub. Melhor
    // recusar a criação e avisar claramente do que abrir uma porta óbvia.
    if (!ADMIN_PASS) {
      console.error(
        `⚠️  ADMIN_PASS não configurada — admin (${ADMIN_EMAIL}) NÃO foi criado. ` +
        `Defina a variável de ambiente ADMIN_PASS no Render (Settings > Environment) e reinicie o serviço.`
      );
    } else {
      const hash = await bcrypt.hash(ADMIN_PASS, 12);
      await pool.query(
        `INSERT INTO users (id, name, email, password, role) VALUES ($1, $2, $3, $4, $5)`,
        [uuidv4(), ADMIN_NAME, ADMIN_EMAIL.toLowerCase(), hash, 'administrador']
      );
      console.log(`✅ Admin criado: ${ADMIN_EMAIL}`);
    }
  } else {
    console.log(`✅ Admin verificado: ${ADMIN_EMAIL}`);
  }

  setInterval(() => pruneExpiredTokens().catch(console.error), 24 * 60 * 60 * 1000);

  // Sucesso do Cliente — ingestão automática periódica (não depende de ninguém clicar em nada)
  if (process.env.ZAPPY_BASE_URL && process.env.ZAPPY_TOKEN) {
    const { ingerirTickets } = require('./cs/ingestao');
    const { criarClienteZappy } = require('./cs/zappyClient');
    const rodarIngestaoCS = async () => {
      try {
        const resultado = await ingerirTickets({ zappyClient: criarClienteZappy(), pool });
        console.log('[CS] Ingestão automática:', resultado);
      } catch (e) {
        console.error('[CS] Falha na ingestão automática:', e.message);
      }
    };
    setInterval(rodarIngestaoCS, 5 * 60 * 1000); // a cada 5 min
    rodarIngestaoCS(); // já roda uma vez ao subir

    // Gamificação — atualização diária das notas (rate) de tickets fechados
    // recentemente que ainda estavam sem avaliação (o cliente pode demorar
    // pra responder a pesquisa). Pedido do Reysner: em vez de varrer 90 dias
    // toda vez, vai "colhendo D-1" — todo dia rebusca só quem fechou nos
    // últimos dias e segue sem nota. Mais leve que o /backfill manual.
    const { atualizarNotasPendentes } = require('./cs/ingestao');
    const rodarAtualizacaoNotasCS = async () => {
      try {
        const resultado = await atualizarNotasPendentes({ zappyClient: criarClienteZappy(), pool, dias: 5 });
        console.log('[CS] Atualização diária de notas:', resultado);
      } catch (e) {
        console.error('[CS] Falha na atualização diária de notas:', e.message);
      }
    };
    setInterval(rodarAtualizacaoNotasCS, 24 * 60 * 60 * 1000); // 1x por dia
    rodarAtualizacaoNotasCS(); // já roda uma vez ao subir
  }

  // Carteira — sincronização automática diária com o Sistema Acessórias
  // (clientes ativos de lá, SEM honorário — pedido do Reysner). Botão
  // "Atualizar agora" em Gestão de Clientes cobre o caso de querer rodar
  // na hora, sem esperar o ciclo de 24h.
  if (process.env.ACESSORIAS_API_TOKEN) {
    const { sincronizarAcessorias } = require('./routes/data');
    const rodarSyncAcessorias = async () => {
      try {
        const resultado = await sincronizarAcessorias();
        console.log('[Acessórias] Sincronização automática:', resultado);
      } catch (e) {
        console.error('[Acessórias] Falha na sincronização automática:', e.message);
      }
    };
    setInterval(rodarSyncAcessorias, 24 * 60 * 60 * 1000); // 1x por dia
    rodarSyncAcessorias(); // já roda uma vez ao subir
  }

  app.listen(PORT, () => console.log(`🚀 Grupo-E rodando na porta ${PORT}`));
}).catch(err => {
  console.error('❌ Erro ao conectar ao banco:', err);
  process.exit(1);
});
