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
    { sub: user.id, name: user.name, role: user.role, acesso_minha_nota: !!user.acesso_minha_nota, acesso_legalizacao: !!user.acesso_legalizacao, acesso_cs: !!user.acesso_cs, acesso_financeiro: !!user.acesso_financeiro, acesso_qualidade: !!user.acesso_qualidade, acesso_financeiro_sv: !!user.acesso_financeiro_sv, acesso_gestor: !!user.acesso_gestor },
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

/** Lê o token da requisição sem exigir login: devolve o conteúdo (sub, role, ...) ou null. Para barreiras que só complementam a rota (ela confere o resto). */
function lerPayload(req) {
  const auth = req.headers && req.headers.authorization;
  const token = auth && auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return null;
  try { return jwt.verify(token, ACCESS_SECRET, { issuer: 'grupo-e' }); } catch (e) { return null; }
}

function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  const token = auth && auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Não autenticado.' });
  try {
    const payload = jwt.verify(token, ACCESS_SECRET, { issuer: 'grupo-e' });
    req.user = { id: payload.sub, name: payload.name, role: payload.role, acessoMinhaNota: !!payload.acesso_minha_nota, acessoLegalizacao: !!payload.acesso_legalizacao, acessoCs: !!payload.acesso_cs, acessoFinanceiro: !!payload.acesso_financeiro, acessoQualidade: !!payload.acesso_qualidade, acessoFinanceiroSv: !!payload.acesso_financeiro_sv, acessoGestor: !!payload.acesso_gestor };
    // Páginas /cs e /financeiro (13/10/2026): Contábil e Colaborador só chegam nelas pela permissão própria (acesso_cs / acesso_financeiro).
    // O que cada pessoa VÊ lá dentro é decidido na própria rota (server/cs/painel.js e server/financeiro/), nunca no front-end.
    const rotaCompleta = (req.baseUrl || '') + (req.path || '');
    const isCsPainelRoute = rotaCompleta.startsWith('/api/cs/painel') && !!payload.acesso_cs;
    const isFinanceiroRoute = rotaCompleta.startsWith('/api/financeiro') && !!(payload.acesso_financeiro || payload.acesso_cs || payload.acesso_financeiro_sv);
    const isAuthOuPerfil = req.path && (req.path.includes('/auth') || req.path.includes('/perfil'));
    // Minhas tratativas (16/10/2026): o analista (login com acesso_qualidade) vê e trata só os registros de Qualidade dele; quem é "ele" a rota decide.
    const isQualidadeRoute = rotaCompleta.startsWith('/api/qualidade/') && !!payload.acesso_qualidade;
    // Módulo Qualidade dentro do /cs (17/10/2026): gestor (cadastrado em Gerenciar gestores) e analista (acesso_qualidade) só CHEGAM às rotas de Qualidade;
    // o que cada um alcança lá dentro é decidido pela própria rota (lista branca em server/cs/qualidade.js).
    const isCsQualidadeRoute = rotaCompleta.startsWith('/api/cs/painel/qualidade') && !!(payload.acesso_gestor || payload.acesso_qualidade);
    // Push do navegador: cada pessoa cadastra o próprio aparelho, seja qual for o perfil (a rota só mexe nos aparelhos dela).
    const isPushRoute = rotaCompleta.startsWith('/api/push/');
    // Minha Nota (28/08/2026, self-service da Gamificação): rotas
    // /gam/minha-* e /gam/meus-* — a nota/tickets da PRÓPRIA pessoa,
    // resolvida no backend a partir do login (nunca aceita um
    // colaborador_id vindo do cliente). Combinável com qualquer perfil via
    // `acesso_minha_nota` (checkbox em Administração de Usuários) — ex.:
    // alguém pode ser Contábil E ter acesso a Minha Nota ao mesmo tempo,
    // sem precisar de dois logins (pedido do Reysner: "tem como escolher
    // só minha nota e contábil pro mesmo usuário?").
    const isMinhaNotaRoute = req.path && (req.path.includes('/gam/minha-') || req.path.includes('/gam/meus-'));
    // Página pública de Legalização (18/09/2026, colaborador vê
    // Alvarás/Certificados e solicita inativação de cliente) — mesmo
    // esquema combinável de acesso_minha_nota, mas com acesso_legalizacao
    // (checkbox própria em Administração de Usuários). Endpoints que só o
    // admin pode chamar (excluir, editar direto, aprovar/rejeitar
    // solicitação) continuam atrás de requireAdmin normalmente — isso aqui
    // só libera o colaborador a CHEGAR nas rotas /legalizacao.
    // Só LEITURA + enviar solicitação de inativação: quem tem a flag mas não é
    // admin nunca edita datas/certificados pela API (PUT/POST/PATCH/DELETE).
    const isLegalizacaoRoute = req.path && req.path.includes('/legalizacao')
      && (req.method === 'GET' || req.path.includes('/solicitar-inativacao') || req.path.includes('/notificacoes/lidas')
          || (req.method === 'PATCH' && /\/clientes\/[^/]+\/(inscricao-municipal|municipio)$/.test(req.path))); // cadastrar inscrição municipal / município da empresa

    // Usuário contábil só pode acessar rotas de tickets (+ Minha Nota/Legalização, se as flags estiverem ligadas) — bloqueia o resto.
    if (payload.role === 'contabil') {
      const isTicketRoute = req.path && req.path.includes('/tickets');
      const permitido = isTicketRoute || isAuthOuPerfil
        || (payload.acesso_minha_nota && isMinhaNotaRoute)
        || (payload.acesso_legalizacao && isLegalizacaoRoute)
        || isCsPainelRoute || isFinanceiroRoute || isQualidadeRoute || isCsQualidadeRoute || isPushRoute;
      if (!permitido) return res.status(403).json({ error: 'Acesso restrito ao portal contábil.' });
    }
    // Colaborador: só pode ver a própria nota (ou Legalização, se
    // acesso_legalizacao estiver ligado) — nunca dados de tickets,
    // clientes, outros colaboradores etc. Papel "puro", pra quem não deve
    // ter NENHUM outro acesso (diferente dos checkboxes acima, que
    // ADICIONAM uma tela a um perfil que já tem outra coisa).
    if (payload.role === 'colaborador' && !(isMinhaNotaRoute || isAuthOuPerfil || (payload.acesso_legalizacao && isLegalizacaoRoute) || isCsPainelRoute || isFinanceiroRoute || isQualidadeRoute || isCsQualidadeRoute || isPushRoute)) {
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
  requireAuth, requireAdmin, lerPayload,
};
