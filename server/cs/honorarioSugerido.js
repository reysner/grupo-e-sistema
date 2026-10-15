'use strict';
/**
 * Configuração do "Honorário sugerido" da Análise Inteligente (/cs).
 *
 *   Honorário sugerido (mensal) = percentual × faturamento médio mensal (faturamento de 12 meses ÷ 12)
 *   Análise: verde  = cobrado ≥ sugerido
 *            amarelo = cobrado entre `limite_amarelo`% e 100% do sugerido (tomando distância)
 *            vermelho = cobrado abaixo de `limite_amarelo`% do sugerido (muito abaixo)
 *
 * O percentual vale para a equipe toda (um valor só); só o administrador altera.
 *
 *   GET /api/cs/painel/honorario-sugerido   (administrador, usuário ou acesso_cs)
 *   PUT /api/cs/painel/honorario-sugerido   (administrador)  { percentual, limite_amarelo }
 */
const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../auth');

const PADRAO = { percentual: null, limite_amarelo: 80 };
const CHAVE = 'honorario_sugerido';

function numero(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : NaN;
}

/** Valida o corpo do PUT. Devolve { ok, valor } ou { ok:false, erro }. */
function validar(corpo) {
  const b = corpo || {};
  const p = numero(b.percentual);
  const l = numero(b.limite_amarelo === undefined ? PADRAO.limite_amarelo : b.limite_amarelo);
  if (p === null) return { ok: true, valor: { percentual: null, limite_amarelo: Number.isNaN(l) || l === null ? PADRAO.limite_amarelo : l } };   // apagar o percentual
  if (Number.isNaN(p) || p <= 0 || p > 100) return { ok: false, erro: 'Informe um percentual maior que 0 e até 100.' };
  if (l === null || Number.isNaN(l) || l < 1 || l > 99) return { ok: false, erro: 'O limite do amarelo deve ficar entre 1 e 99% do sugerido.' };
  return { ok: true, valor: { percentual: Math.round(p * 1000) / 1000, limite_amarelo: Math.round(l * 10) / 10 } };
}

let _schema = null;
function garantirSchema() {
  if (!_schema) {
    // RLS ligado e sem policy: só o servidor lê (regra do projeto para tabela nova).
    _schema = pool.query(`CREATE TABLE IF NOT EXISTS cs_painel_config (
        chave TEXT PRIMARY KEY, valor JSONB NOT NULL, atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(), atualizado_por TEXT)`)
      .then(() => pool.query(`ALTER TABLE cs_painel_config ENABLE ROW LEVEL SECURITY`))
      .catch((e) => { _schema = null; throw e; });
  }
  return _schema;
}

const PAPEIS = ['administrador', 'usuario'];
const router = express.Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  if (!PAPEIS.includes(req.user && req.user.role) && !(req.user && req.user.acessoCs)) return res.status(403).json({ error: 'Acesso restrito à equipe do Sucesso do Cliente.' });
  try {
    await garantirSchema();
    const r = await pool.query(`SELECT valor, atualizado_em, atualizado_por FROM cs_painel_config WHERE chave = $1`, [CHAVE]);
    const v = r.rows[0];
    res.json({ ...PADRAO, ...(v ? v.valor : {}), atualizado_em: v ? v.atualizado_em : null, atualizado_por: v ? v.atualizado_por : null, pode_editar: req.user.role === 'administrador' });
  } catch (err) {
    console.error('[painel] GET honorario-sugerido falhou:', err);
    res.status(500).json({ error: 'Erro ao ler o percentual do honorário sugerido.' });
  }
});

router.put('/', async (req, res) => {
  if (req.user.role !== 'administrador') return res.status(403).json({ error: 'Só o administrador altera o percentual.' });
  const v = validar(req.body);
  if (!v.ok) return res.status(400).json({ error: v.erro });
  try {
    await garantirSchema();
    await pool.query(
      `INSERT INTO cs_painel_config (chave, valor, atualizado_em, atualizado_por) VALUES ($1, $2::jsonb, NOW(), $3)
       ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor, atualizado_em = NOW(), atualizado_por = EXCLUDED.atualizado_por`,
      [CHAVE, JSON.stringify(v.valor), req.user.name || req.user.id || null]);
    res.json({ ...PADRAO, ...v.valor, pode_editar: true });
  } catch (err) {
    console.error('[painel] PUT honorario-sugerido falhou:', err);
    res.status(500).json({ error: 'Erro ao salvar o percentual.' });
  }
});

module.exports = { router, validar, PADRAO };
