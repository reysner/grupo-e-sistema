'use strict';
/**
 * Módulo Sucesso do Cliente — Rotas HTTP
 * ------------------------------------------------------------------
 * Como montar em server/index.js (arquivo que NÃO está neste pacote —
 * ver CONTEXTO_PROJETO_GRUPO_E.md seção 10). Ao lado de onde os outros
 * routers são registrados (ex.: perto de `app.use('/api/data', ...)`),
 * adicionar:
 *
 *     app.use('/api/cs', require('./cs/routes'));
 *
 * Endpoints:
 *   GET  /api/cs/agora                    -> radar de tickets em risco (só vínculos tipo='cliente')
 *   POST /api/cs/ingerir                   -> dispara a ingestão manualmente (admin)
 *   GET  /api/cs/vinculos/pendentes        -> fila de de-para aguardando confirmação humana
 *   POST /api/cs/vinculos/:id/confirmar    -> confirma um vínculo (empresa/tipo)
 *
 * Autenticação: reusa server/auth.js (requireAuth/requireAdmin), no mesmo
 * padrão descrito no handoff. Se esse require falhar neste ambiente
 * (ex.: rodando fora do repo completo), cai num passthrough — isso é só
 * para não travar testes locais; NÃO deve acontecer em produção.
 */
const express = require('express');
const router = express.Router();
const { obterPool } = require('./pool');
const { ingerirTickets } = require('./ingestao');
const { criarClienteZappy } = require('./zappyClient');
const { listarPendentes, confirmarVinculo } = require('./vinculos');

let requireAuth, requireAdmin;
try {
  ({ requireAuth, requireAdmin } = require('../auth'));
} catch (e) {
  console.warn('[cs/routes] server/auth.js não encontrado — rotas SEM autenticação. Corrigir antes de subir ao Render.');
  requireAuth = (req, res, next) => next();
  requireAdmin = (req, res, next) => next();
}

/** GET /api/cs/agora — radar de tickets fora do SLA, ordenado por gravidade. */
router.get('/agora', requireAuth, async (req, res) => {
  try {
    const pool = obterPool();
    const { rows } = await pool.query(`
      SELECT t.id, t.zappy_id, t.empresa_texto, v.empresa_nome, t.departamento,
             t.analista, t.status, t.pior_status, t.sla, t.abertura, t.updated_at
        FROM cs_tickets t
        JOIN cs_vinculos v ON v.id = t.vinculo_id
       WHERE t.em_risco = TRUE
         AND v.tipo = 'cliente'
       ORDER BY CASE t.pior_status
                  WHEN 'vermelho' THEN 3
                  WHEN 'amarelo'  THEN 2
                  ELSE 1
                END DESC,
                t.updated_at DESC
    `);
    res.json({ tickets: rows });
  } catch (e) {
    console.error('[cs] GET /agora falhou:', e);
    res.status(500).json({ error: 'Falha ao carregar o radar de tickets.' });
  }
});

/** POST /api/cs/ingerir — dispara a ingestão manualmente (uso: botão "Atualizar agora" / debug). */
router.post('/ingerir', requireAuth, requireAdmin, async (req, res) => {
  try {
    const pool = obterPool();
    const zappyClient = criarClienteZappy();
    const resultado = await ingerirTickets({ zappyClient, pool });
    res.json(resultado);
  } catch (e) {
    console.error('[cs] POST /ingerir falhou:', e);
    res.status(500).json({ error: e.message });
  }
});

/** GET /api/cs/vinculos/pendentes — fila de de-para aguardando confirmação humana. */
router.get('/vinculos/pendentes', requireAuth, async (req, res) => {
  try {
    const pool = obterPool();
    const vinculos = await listarPendentes(pool);
    res.json({ vinculos });
  } catch (e) {
    console.error('[cs] GET /vinculos/pendentes falhou:', e);
    res.status(500).json({ error: e.message });
  }
});

/** POST /api/cs/vinculos/:id/confirmar — confirma manualmente empresa + tipo do vínculo. */
router.post('/vinculos/:id/confirmar', requireAuth, async (req, res) => {
  try {
    const pool = obterPool();
    const { clienteId, empresaNome, cnpj, tipo } = req.body || {};
    const confirmadoPor = (req.user && (req.user.name || req.user.email || req.user.id)) || 'desconhecido';
    const atualizado = await confirmarVinculo(pool, req.params.id, {
      clienteId: clienteId ?? null, empresaNome, cnpj: cnpj ?? null, tipo, confirmadoPor,
    });
    if (!atualizado) return res.status(404).json({ error: 'Vínculo não encontrado.' });
    res.json({ vinculo: atualizado });
  } catch (e) {
    console.error('[cs] POST /vinculos/:id/confirmar falhou:', e);
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
