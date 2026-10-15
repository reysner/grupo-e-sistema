'use strict';
/**
 * Evolução do honorário cobrado por cliente, ano a ano, lida do Omie (categoria "SERVIÇOS HONORÁRIOS CONTÁBEIS", títulos a receber
 * por data de emissão, os dois ambientes consolidados). Alimenta a ficha da Análise Anual (/cs).
 *
 *   POST /api/cs/omie/honorarios  (token de sincronização)
 *        { ate:'AAAA-MM', itens:[{ cnpj, anos:[{ ano, total, meses, mensal }] }] }   substitui TODA a carga anterior.
 *
 * Por ano: total = soma cobrada no ano; meses = meses com cobrança; mensal = valor típico (mediana) dos meses cobrados.
 * O Omie só guarda a partir de set/2023 e 2026 é parcial; a leitura da tela diz isso. Quem lê (GET) é o /api/cs/painel/anual.
 */
const express = require('express');
const { pool } = require('../db');

const soDigitos = (s) => String(s || '').replace(/\D/g, '');

/** Valida o corpo do POST. Devolve { ate, linhas:[{doc, ano, total, meses, mensal}] } ou lança Error com mensagem clara. */
function validarCarga(corpo) {
  const b = corpo || {};
  if (!/^\d{4}-\d{2}$/.test(b.ate || '')) throw new Error('Informe ate: "AAAA-MM".');
  if (!Array.isArray(b.itens) || !b.itens.length) throw new Error('Informe itens: [{ cnpj, anos: [...] }].');
  const linhas = []; const vistos = new Set();
  for (const it of b.itens) {
    const doc = soDigitos(it && it.cnpj);
    if (![11, 12, 14].includes(doc.length) || /^0+$/.test(doc)) continue;          // sem CNPJ/CPF válido (ex.: 00.000.000/0000-00) não casa com cliente
    for (const a of (Array.isArray(it.anos) ? it.anos : [])) {
      const ano = parseInt(a && a.ano, 10), total = Number(a && a.total), meses = parseInt(a && a.meses, 10), mensal = Number(a && a.mensal);
      if (!(ano >= 2000 && ano <= 2100) || !Number.isFinite(total) || !(meses >= 0 && meses <= 12) || !Number.isFinite(mensal) || mensal < 0)
        throw new Error(`Valor inválido para o documento ${doc} no ano ${a && a.ano}.`);
      const chave = doc + '|' + ano;
      if (vistos.has(chave)) continue;
      vistos.add(chave);
      linhas.push({ doc, ano, total: Math.round(total * 100) / 100, meses, mensal: Math.round(mensal * 100) / 100 });
    }
  }
  if (!linhas.length) throw new Error('Nenhum documento válido na carga.');
  return { ate: b.ate, linhas };
}

let _schema = null;
function garantirSchema() {
  if (!_schema) {
    // RLS ligado e sem policy: só o servidor lê (regra do projeto para tabela nova).
    _schema = pool.query(`CREATE TABLE IF NOT EXISTS omie_honorario_anual (
        doc TEXT NOT NULL, ano INT NOT NULL, total NUMERIC(16,2) NOT NULL, meses INT NOT NULL, mensal NUMERIC(14,2) NOT NULL,
        atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (doc, ano))`)
      .then(() => pool.query(`ALTER TABLE omie_honorario_anual ENABLE ROW LEVEL SECURITY`))
      .then(() => pool.query(`CREATE TABLE IF NOT EXISTS cs_painel_config (
        chave TEXT PRIMARY KEY, valor JSONB NOT NULL, atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(), atualizado_por TEXT)`))
      .then(() => pool.query(`ALTER TABLE cs_painel_config ENABLE ROW LEVEL SECURITY`))
      .catch((e) => { _schema = null; throw e; });
  }
  return _schema;
}

/** { doc: [{ano, total, meses, mensal}] } para os documentos pedidos (já em ordem de ano). */
async function lerPorDocs(docs) {
  await garantirSchema();
  const { rows } = await pool.query(
    `SELECT doc, ano, total::float AS total, meses, mensal::float AS mensal FROM omie_honorario_anual WHERE doc = ANY($1) ORDER BY doc, ano`, [docs]);
  const por = {};
  rows.forEach((r) => { (por[r.doc] || (por[r.doc] = [])).push({ ano: r.ano, total: r.total, meses: r.meses, mensal: r.mensal }); });
  return por;
}

function tokenSyncOk(req, res) {
  const esperado = process.env.LEGALIZACAO_SYNC_TOKEN || process.env.CERTISEGURO_SYNC_TOKEN;
  if (!esperado) { res.status(503).json({ error: 'Sincronização não configurada no servidor.' }); return false; }
  if (req.get('X-Sync-Token') !== esperado) { res.status(401).json({ error: 'Token de sincronização inválido.' }); return false; }
  return true;
}

const router = express.Router();

router.post('/', async (req, res) => {
  if (!tokenSyncOk(req, res)) return;
  let v;
  try { v = validarCarga(req.body); } catch (e) { return res.status(400).json({ error: e.message }); }
  if (v.linhas.length > 20000) return res.status(413).json({ error: 'Carga grande demais.' });
  let client = null;
  try {
    await garantirSchema();
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query('DELETE FROM omie_honorario_anual');
    const L = v.linhas;
    await client.query(
      `INSERT INTO omie_honorario_anual (doc, ano, total, meses, mensal)
       SELECT * FROM unnest($1::text[], $2::int[], $3::numeric[], $4::int[], $5::numeric[])`,
      [L.map((l) => l.doc), L.map((l) => l.ano), L.map((l) => l.total), L.map((l) => l.meses), L.map((l) => l.mensal)]);
    await client.query(
      `INSERT INTO cs_painel_config (chave, valor, atualizado_em, atualizado_por) VALUES ('omie_honorarios_leitura', $1::jsonb, NOW(), 'omie')
       ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor, atualizado_em = NOW(), atualizado_por = EXCLUDED.atualizado_por`,
      [JSON.stringify({ ate: v.ate })]);
    await client.query('COMMIT');
    res.json({ ok: true, clientes: new Set(L.map((l) => l.doc)).size, linhas: L.length, ate: v.ate });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error('[omie-honorarios] POST falhou:', err);
    res.status(500).json({ error: 'Erro ao gravar os honorários do Omie.', detalhe: String(err && err.message).slice(0, 300) });
  } finally { if (client) client.release(); }
});

module.exports = { router, validarCarga, lerPorDocs, garantirSchema };
