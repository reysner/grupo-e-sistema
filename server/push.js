'use strict';
/**
 * Notificações push do navegador (Web Push): avisam a pessoa mesmo com a página fechada.
 *
 *   GET  /api/push/chave     -> chave pública (VAPID) para o navegador se inscrever
 *   POST /api/push/assinar   -> { subscription } cadastra este aparelho para a pessoa logada
 *   POST /api/push/cancelar  -> { endpoint } descadastra
 *
 * As chaves VAPID são geradas uma vez e ficam no banco (cs_painel_config, chave "webpush_vapid"): não precisa configurar nada no Render.
 * enviar() nunca lança erro: aviso que falha não pode derrubar quem registrou a ocorrência. Aparelho que não existe mais (404/410) sai do cadastro.
 */
const express = require('express');
const webpushLib = require('web-push');
const { pool: poolPadrao } = require('./db');
const { requireAuth } = require('./auth');

const CHAVE_VAPID = 'webpush_vapid';

/** Valida a inscrição enviada pelo navegador (PushSubscription.toJSON). */
function validarAssinatura(sub) {
  const s = sub || {};
  const endpoint = typeof s.endpoint === 'string' ? s.endpoint.trim() : '';
  const k = s.keys || {};
  if (!endpoint.startsWith('https://') || endpoint.length > 1000) return { ok: false, erro: 'Inscrição inválida.' };
  if (typeof k.p256dh !== 'string' || !k.p256dh || typeof k.auth !== 'string' || !k.auth) return { ok: false, erro: 'Inscrição sem as chaves de segurança.' };
  return { ok: true, valores: { endpoint, p256dh: k.p256dh, auth: k.auth } };
}

/** Monta o texto do aviso que o navegador recebe. */
function montarCarga(aviso) {
  const a = aviso || {};
  return JSON.stringify({
    titulo: String(a.titulo || 'Aviso').slice(0, 120),
    texto: String(a.texto || '').slice(0, 300),
    url: String(a.url || '/cs'),
    tag: a.tag ? String(a.tag).slice(0, 80) : undefined,
  });
}

/** Junta listas de ids de pessoas: sem repetidos, sem vazios e sem quem fez a ação (ninguém é avisado do que ele mesmo fez). */
function destinatarios(listas, excetoId) {
  const fora = excetoId == null ? null : String(excetoId);
  const out = [];
  [].concat(...(listas || [])).forEach((id) => { const t = id == null ? '' : String(id); if (t && t !== fora && !out.includes(t)) out.push(t); });
  return out;
}

function criar(pool, webpush) {
  let pronto = null;
  /** Cria as tabelas, gera (uma vez) as chaves e configura a biblioteca. Devolve a chave pública. */
  function preparar() {
    if (!pronto) {
      pronto = (async () => {
        await pool.query(`CREATE TABLE IF NOT EXISTS push_assinaturas (
          id SERIAL PRIMARY KEY, user_id TEXT NOT NULL, endpoint TEXT NOT NULL UNIQUE, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
          agente TEXT, criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(), ultimo_envio_em TIMESTAMPTZ)`);
        await pool.query('ALTER TABLE push_assinaturas ENABLE ROW LEVEL SECURITY');
        await pool.query(`CREATE TABLE IF NOT EXISTS cs_painel_config (
          chave TEXT PRIMARY KEY, valor JSONB NOT NULL, atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(), atualizado_por TEXT)`);
        let linha = (await pool.query('SELECT valor FROM cs_painel_config WHERE chave = $1', [CHAVE_VAPID])).rows[0];
        if (!linha) {
          await pool.query('INSERT INTO cs_painel_config (chave, valor, atualizado_por) VALUES ($1, $2::jsonb, $3) ON CONFLICT (chave) DO NOTHING', [CHAVE_VAPID, JSON.stringify(webpush.generateVAPIDKeys()), 'push']);
          linha = (await pool.query('SELECT valor FROM cs_painel_config WHERE chave = $1', [CHAVE_VAPID])).rows[0];
        }
        const k = typeof linha.valor === 'string' ? JSON.parse(linha.valor) : linha.valor;
        webpush.setVapidDetails(process.env.APP_URL || 'https://grupo-e-sistema-uc2w.onrender.com', k.publicKey, k.privateKey);
        return k.publicKey;
      })().catch((e) => { pronto = null; throw e; });
    }
    return pronto;
  }

  async function assinar(userId, sub, agente) {
    const v = validarAssinatura(sub);
    if (!v.ok) return v;
    await preparar();
    await pool.query(
      `INSERT INTO push_assinaturas (user_id, endpoint, p256dh, auth, agente) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, agente = EXCLUDED.agente`,
      [String(userId), v.valores.endpoint, v.valores.p256dh, v.valores.auth, String(agente || '').slice(0, 200) || null]);
    return { ok: true };
  }
  async function cancelar(userId, endpoint) {
    await preparar();
    await pool.query('DELETE FROM push_assinaturas WHERE endpoint = $1 AND user_id = $2', [String(endpoint || ''), String(userId)]);
    return { ok: true };
  }

  /** Envia o aviso a todos os aparelhos das pessoas indicadas. Nunca lança erro. */
  async function enviar(userIds, aviso) {
    try {
      const ids = destinatarios([userIds]);
      if (!ids.length) return { enviados: 0, removidos: 0 };
      await preparar();
      const { rows } = await pool.query('SELECT id, endpoint, p256dh, auth FROM push_assinaturas WHERE user_id = ANY($1::text[])', [ids]);
      const carga = montarCarga(aviso);
      let enviados = 0; const remover = [];
      await Promise.all(rows.map(async (r) => {
        try {
          await webpush.sendNotification({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } }, carga, { TTL: 6 * 3600, urgency: 'high' });
          enviados++;
        } catch (e) {
          if (e && (e.statusCode === 404 || e.statusCode === 410)) remover.push(r.id);
          else console.warn('[push] envio falhou:', e && e.statusCode, e && e.message);
        }
      }));
      if (remover.length) await pool.query('DELETE FROM push_assinaturas WHERE id = ANY($1::int[])', [remover]);
      return { enviados, removidos: remover.length };
    } catch (e) {
      console.warn('[push] falhou:', e && e.message);
      return { enviados: 0, removidos: 0, erro: true };
    }
  }

  const router = express.Router();
  router.use(requireAuth);
  router.get('/chave', async (req, res) => {
    try { res.json({ chave: await preparar() }); }
    catch (e) { console.error('[push] GET /chave falhou:', e); res.status(500).json({ error: 'Notificações push indisponíveis no momento.' }); }
  });
  router.post('/assinar', async (req, res) => {
    try {
      const r = await assinar(req.user.id, req.body && req.body.subscription, req.get('user-agent'));
      if (!r.ok) return res.status(400).json({ error: r.erro });
      res.json({ ok: true });
    } catch (e) { console.error('[push] POST /assinar falhou:', e); res.status(500).json({ error: 'Não foi possível cadastrar este aparelho.' }); }
  });
  router.post('/cancelar', async (req, res) => {
    try { await cancelar(req.user.id, req.body && req.body.endpoint); res.json({ ok: true }); }
    catch (e) { console.error('[push] POST /cancelar falhou:', e); res.status(500).json({ error: 'Não foi possível descadastrar este aparelho.' }); }
  });

  return { preparar, assinar, cancelar, enviar, router };
}

const padrao = criar(poolPadrao, webpushLib);
module.exports = { ...padrao, criar, validarAssinatura, montarCarga, destinatarios };
