'use strict';
/**
 * Análise Anual (/cs): faturamento por ano de cada cliente ativo, lido do Questor por rotina local (server/questor/extrairAnual.js).
 *
 *   POST /api/cs/questor/anual   (token de sincronização) -> { ate:'AAAA-MM', ano_inicial, itens:[{ cnpj, anos:[{ ano, faturamento, meses, meses_com_valor }] }] }
 *                                 substitui TODA a carga anterior.
 *   GET  /api/cs/painel/anual    (login) -> a última carga, só de clientes ATIVOS; só o administrador recebe valores (perfil Usuário: oculto)
 *   PUT  /api/cs/painel/anual    (administrador) { percentual?, reajuste_min? } -> limite de variação que destaca o cliente (padrão 30)
 *                                 e corte do "sem reajuste" do honorário do Omie (padrão 5); devolve a configuração inteira
 *
 * Funcionários por ano e regime por ano ainda não existem na API do Questor que usamos: ver memória do projeto (15/10/2026).
 */
const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../auth');

const soDigitos = (s) => String(s || '').replace(/\D/g, '');
const CHAVE_META = 'anual_leitura';
const CHAVE_CFG = 'analise_anual';
const PADRAO = { percentual: 30, reajuste_min: 5 };   // reajuste_min: % que o honorário do Omie precisa ter subido para não contar como "sem reajuste"

/** Valida o corpo do POST. Devolve { ate, ano_inicial, linhas:[{doc, ano, fat, meses, mv}] } ou lança Error com mensagem clara. */
function validarCarga(corpo) {
  const b = corpo || {};
  if (!/^\d{4}-\d{2}$/.test(b.ate || '')) throw new Error('Informe ate: "AAAA-MM".');
  const anoIni = parseInt(b.ano_inicial, 10);
  if (!(anoIni >= 1990 && anoIni <= 2100)) throw new Error('Informe ano_inicial.');
  if (!Array.isArray(b.itens) || !b.itens.length) throw new Error('Informe itens: [{ cnpj, anos: [...] }].');
  const linhas = []; const vistos = new Set();
  for (const it of b.itens) {
    const doc = soDigitos(it && it.cnpj);
    if (![11, 12, 14].includes(doc.length)) continue;
    for (const a of (Array.isArray(it.anos) ? it.anos : [])) {
      const ano = parseInt(a && a.ano, 10);
      const fat = a && a.faturamento != null ? Number(a.faturamento) : null;          // null = faturamento não lido para este ano
      const meses = a && a.meses != null ? parseInt(a.meses, 10) : 0, mv = parseInt(a && a.meses_com_valor, 10);
      const fun = a && a.funcionarios != null ? parseInt(a.funcionarios, 10) : null;
      const media = a && a.funcionarios_media != null ? Number(a.funcionarios_media) : null;
      const regime = a && a.regime ? String(a.regime).slice(0, 40) : null;
      const fonte = a && a.regime_fonte ? String(a.regime_fonte).slice(0, 80) : null;
      const aviso = a && a.aviso ? String(a.aviso).slice(0, 300) : null;
      if (!(ano >= 1990 && ano <= 2100) || (fat !== null && !Number.isFinite(fat)) || !(meses >= 0 && meses <= 12)
        || (fun !== null && !(fun >= 0 && fun <= 100000)) || (media !== null && !Number.isFinite(media))) throw new Error(`Valor inválido para o documento ${doc} no ano ${a && a.ano}.`);
      const chave = doc + '|' + ano;
      if (vistos.has(chave)) continue;
      vistos.add(chave);
      linhas.push({ doc, ano, fat: fat === null ? null : Math.round(fat * 100) / 100, meses, mv: Number.isFinite(mv) ? Math.min(Math.max(mv, 0), meses) : meses,
        fun, media: media === null ? null : Math.round(media * 10) / 10, regime, fonte, aviso });
    }
  }
  if (!linhas.length) throw new Error('Nenhum documento válido na carga.');
  return { ate: b.ate, ano_inicial: anoIni, linhas };
}

function validarPercentual(v) {
  const n = Number(String(v).replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0 || n > 1000) return { ok: false, erro: 'Informe um percentual maior que 0 e até 1000.' };
  return { ok: true, valor: Math.round(n * 10) / 10 };
}

/** Corpo do PUT: aceita percentual e/ou reajuste_min; devolve { ok, valores } ou { ok:false, erro }. */
function validarConfig(corpo) {
  const b = corpo || {}, valores = {};
  for (const campo of ['percentual', 'reajuste_min']) {
    if (b[campo] === undefined) continue;
    const v = validarPercentual(b[campo]);
    if (!v.ok) return { ok: false, erro: v.erro };
    valores[campo] = v.valor;
  }
  if (!Object.keys(valores).length) return { ok: false, erro: 'Informe percentual ou reajuste_min.' };
  return { ok: true, valores };
}

let _schema = null;
function garantirSchema() {
  if (!_schema) {
    // RLS ligado e sem policy: só o servidor lê (regra do projeto para tabela nova).
    _schema = pool.query(`CREATE TABLE IF NOT EXISTS questor_cliente_anual (
        doc TEXT NOT NULL, ano INT NOT NULL, faturamento NUMERIC(16,2), meses INT NOT NULL DEFAULT 12, meses_com_valor INT NOT NULL DEFAULT 12,
        atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (doc, ano))`)
      .then(() => pool.query(`ALTER TABLE questor_cliente_anual ALTER COLUMN faturamento DROP NOT NULL`))
      .then(() => pool.query(`ALTER TABLE questor_cliente_anual ADD COLUMN IF NOT EXISTS funcionarios INT`))
      .then(() => pool.query(`ALTER TABLE questor_cliente_anual ADD COLUMN IF NOT EXISTS funcionarios_media NUMERIC(8,1)`))
      .then(() => pool.query(`ALTER TABLE questor_cliente_anual ADD COLUMN IF NOT EXISTS regime TEXT`))
      .then(() => pool.query(`ALTER TABLE questor_cliente_anual ADD COLUMN IF NOT EXISTS regime_fonte TEXT`))
      .then(() => pool.query(`ALTER TABLE questor_cliente_anual ADD COLUMN IF NOT EXISTS aviso TEXT`))
      .then(() => pool.query(`ALTER TABLE questor_cliente_anual ENABLE ROW LEVEL SECURITY`))
      .then(() => pool.query(`CREATE TABLE IF NOT EXISTS cs_painel_config (
        chave TEXT PRIMARY KEY, valor JSONB NOT NULL, atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(), atualizado_por TEXT)`))
      .then(() => pool.query(`ALTER TABLE cs_painel_config ENABLE ROW LEVEL SECURITY`))
      .catch((e) => { _schema = null; throw e; });
  }
  return _schema;
}

function tokenSyncOk(req, res) {
  const esperado = process.env.LEGALIZACAO_SYNC_TOKEN || process.env.CERTISEGURO_SYNC_TOKEN;
  if (!esperado) { res.status(503).json({ error: 'Sincronização não configurada no servidor.' }); return false; }
  if (req.get('X-Sync-Token') !== esperado) { res.status(401).json({ error: 'Token de sincronização inválido.' }); return false; }
  return true;
}

const PAPEIS = ['administrador', 'usuario'];
const router = express.Router();

router.post('/', async (req, res) => {
  if (!tokenSyncOk(req, res)) return;
  let v;
  try { v = validarCarga(req.body); } catch (e) { return res.status(400).json({ error: e.message }); }
  if (v.linhas.length > 60000) return res.status(413).json({ error: 'Carga grande demais.' });
  let client = null;
  try {
    await garantirSchema();
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query('DELETE FROM questor_cliente_anual');
    const L = v.linhas;
    await client.query(
      `INSERT INTO questor_cliente_anual (doc, ano, faturamento, meses, meses_com_valor, funcionarios, funcionarios_media, regime, regime_fonte, aviso)
       SELECT * FROM unnest($1::text[], $2::int[], $3::numeric[], $4::int[], $5::int[], $6::int[], $7::numeric[], $8::text[], $9::text[], $10::text[])`,
      [L.map((l) => l.doc), L.map((l) => l.ano), L.map((l) => l.fat), L.map((l) => l.meses), L.map((l) => l.mv), L.map((l) => l.fun), L.map((l) => l.media), L.map((l) => l.regime), L.map((l) => l.fonte), L.map((l) => l.aviso)]);
    await client.query(
      `INSERT INTO cs_painel_config (chave, valor, atualizado_em, atualizado_por) VALUES ($1, $2::jsonb, NOW(), 'extrairAnual')
       ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor, atualizado_em = NOW(), atualizado_por = EXCLUDED.atualizado_por`,
      [CHAVE_META, JSON.stringify({ ate: v.ate, ano_inicial: v.ano_inicial })]);
    await client.query('COMMIT');
    res.json({ ok: true, clientes: new Set(L.map((l) => l.doc)).size, linhas: L.length, ate: v.ate });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error('[anual] POST falhou:', err);
    res.status(500).json({ error: 'Erro ao gravar o faturamento anual.', detalhe: String(err && err.message).slice(0, 300) });
  } finally { if (client) client.release(); }
});

router.get('/', requireAuth, async (req, res) => {
  const u = req.user || {};
  if (!PAPEIS.includes(u.role) && !u.acessoCs) return res.status(403).json({ error: 'Acesso restrito à equipe do Sucesso do Cliente.' });
  try {
    await garantirSchema();
    const cfg = await pool.query(`SELECT chave, valor, atualizado_em FROM cs_painel_config WHERE chave = ANY($1)`, [[CHAVE_META, CHAVE_CFG]]);
    const por = {}; cfg.rows.forEach((r) => { por[r.chave] = r; });
    const meta = por[CHAVE_META] ? por[CHAVE_META].valor : null;
    const config = { ...PADRAO, ...(por[CHAVE_CFG] ? por[CHAVE_CFG].valor : {}), pode_editar: u.role === 'administrador' };
    if (u.role !== 'administrador') return res.json({ valores_ocultos: true, ate: meta && meta.ate, ano_inicial: meta && meta.ano_inicial, config, itens: [] });
    // só clientes ATIVOS: quem foi inativado no Acessórias não aparece, mesmo tendo histórico
    const { rows } = await pool.query(
      `SELECT a.doc, a.ano, a.faturamento::float AS faturamento, a.meses, a.meses_com_valor, a.funcionarios, a.funcionarios_media::float AS funcionarios_media, a.regime, a.regime_fonte, a.aviso
         FROM questor_cliente_anual a
        WHERE EXISTS (SELECT 1 FROM clientes c WHERE c.status = 'ativo' AND regexp_replace(c.cnpj, '\\D', '', 'g') = a.doc)
        ORDER BY a.doc, a.ano`);
    // honorário cobrado por ano (Omie); sem a carga, a tela só não mostra a evolução
    const honPor = await require('./omieHonorarios').lerPorDocs([...new Set(rows.map((r) => r.doc))]).catch(() => ({}));
    const itens = []; let atual = null;
    rows.forEach((r) => {
      if (!atual || atual.cnpj !== r.doc) { atual = { cnpj: r.doc, anos: [], honorarios: honPor[r.doc] || [] }; itens.push(atual); }
      atual.anos.push({ ano: r.ano, faturamento: r.faturamento, meses: r.meses, meses_com_valor: r.meses_com_valor, funcionarios: r.funcionarios, funcionarios_media: r.funcionarios_media, regime: r.regime, regime_fonte: r.regime_fonte, aviso: r.aviso });
    });
    res.json({ valores_ocultos: false, ate: meta && meta.ate, ano_inicial: meta && meta.ano_inicial, lido_em: por[CHAVE_META] ? por[CHAVE_META].atualizado_em : null, config, itens });
  } catch (err) {
    console.error('[anual] GET falhou:', err);
    res.status(500).json({ error: 'Erro ao ler o faturamento anual.' });
  }
});

router.put('/', requireAuth, async (req, res) => {
  if (!req.user || req.user.role !== 'administrador') return res.status(403).json({ error: 'Só o administrador altera o percentual.' });
  const r = validarConfig(req.body);
  if (!r.ok) return res.status(400).json({ error: r.erro });
  try {
    await garantirSchema();
    const atual = await pool.query(`SELECT valor FROM cs_painel_config WHERE chave = $1`, [CHAVE_CFG]);
    const novo = { ...(atual.rows[0] ? atual.rows[0].valor : {}), ...r.valores };           // quem não veio no corpo mantém o valor salvo
    await pool.query(
      `INSERT INTO cs_painel_config (chave, valor, atualizado_em, atualizado_por) VALUES ($1, $2::jsonb, NOW(), $3)
       ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor, atualizado_em = NOW(), atualizado_por = EXCLUDED.atualizado_por`,
      [CHAVE_CFG, JSON.stringify(novo), req.user.name || req.user.id || null]);
    res.json({ ...PADRAO, ...novo, pode_editar: true });
  } catch (err) {
    console.error('[anual] PUT falhou:', err);
    res.status(500).json({ error: 'Erro ao salvar o percentual.' });
  }
});

module.exports = { router, validarCarga, validarPercentual, validarConfig };
