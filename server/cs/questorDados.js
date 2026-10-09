'use strict';
/**
 * Dados do Questor por cliente, para o painel /cs: faturamento dos últimos 12 meses já lançados (módulo Fiscal) e quantidade de
 * funcionários ativos (Folha). Lidos do Questor pelo nWeb por uma rotina LOCAL (dentro da VPN do escritório, a Render não alcança o
 * Questor) e enviados aqui — só totais por CNPJ, nunca dados de funcionário.
 *
 *   POST /api/cs/questor   (token de sincronização, X-Sync-Token) -> { periodo: { ini:'AAAA-MM', fim:'AAAA-MM' }, itens: [{ cnpj, faturamento?, funcionarios? }] }
 *                             substitui TODA a carga anterior (cliente que saiu da lista deixa de ter dado do Questor).
 * Decisões do Reysner (09/10/2026): cliente sem funcionário no Questor = 0; só clientes ativos (CNPJ) entram no painel;
 * o faturamento (R$) é visível só para administrador (o perfil Usuário recebe oculto do servidor).
 */
const express = require('express');
const { pool } = require('../db');

const CHAVE_PERIODO = 'questor_periodo';
const soDigitos = (s) => String(s || '').replace(/\D/g, '');

let _schema = null;
function garantirSchema() {
  if (!_schema) {
    _schema = pool.query(`CREATE TABLE IF NOT EXISTS questor_cliente_dados (
      doc TEXT PRIMARY KEY, faturamento_12m NUMERIC(16,2), funcionarios INT, atualizado_em TIMESTAMPTZ DEFAULT NOW())`)
      // RLS ligado e sem policy: só o servidor lê (regra do projeto para tabela nova).
      .then(() => pool.query(`ALTER TABLE questor_cliente_dados ENABLE ROW LEVEL SECURITY`))
      .catch((e) => { _schema = null; throw e; });
  }
  return _schema;
}

/** Valida e normaliza a carga; devolve { periodo, itens } ou lança Error com mensagem clara. */
function validarCarga(corpo) {
  const p = corpo && corpo.periodo;
  if (!p || !/^\d{4}-\d{2}$/.test(p.ini || '') || !/^\d{4}-\d{2}$/.test(p.fim || '') || p.ini > p.fim) throw new Error('Informe periodo: { ini: "AAAA-MM", fim: "AAAA-MM" }.');
  if (!Array.isArray(corpo.itens) || !corpo.itens.length) throw new Error('Informe itens: [{ cnpj, faturamento, funcionarios }].');
  const vistos = new Map();
  for (const x of corpo.itens) {
    const doc = soDigitos(x && x.cnpj);
    if (![11, 12, 14].includes(doc.length)) continue;                 // CPF (11), CNO (12), CNPJ e CAEPF (14); a Análise Inteligente lista todos os tipos
    const fat = x.faturamento == null ? null : Number(x.faturamento);
    const fun = x.funcionarios == null ? null : Number(x.funcionarios);
    if ((fat != null && !Number.isFinite(fat)) || (fun != null && (!Number.isInteger(fun) || fun < 0))) throw new Error(`Valor inválido para o CNPJ ${doc}.`);
    vistos.set(doc, { faturamento: fat, funcionarios: fun });
  }
  if (!vistos.size) throw new Error('Nenhum documento válido (CPF, CNO, CNPJ ou CAEPF) na carga.');
  return { periodo: { ini: p.ini, fim: p.fim }, itens: vistos };
}

async function gravar(corpo) {
  const { periodo, itens } = validarCarga(corpo);
  await garantirSchema();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM questor_cliente_dados`);
    for (const [doc, v] of itens) await client.query(`INSERT INTO questor_cliente_dados (doc, faturamento_12m, funcionarios) VALUES ($1,$2,$3)`, [doc, v.faturamento, v.funcionarios]);
    await client.query(`INSERT INTO cs_config (chave, valor, updated_at) VALUES ($1,$2,NOW()) ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor, updated_at = NOW()`, [CHAVE_PERIODO, JSON.stringify(periodo)]);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  return { clientes: itens.size, periodo };
}

/** Map doc -> { faturamento, funcionarios } e o período/data da última carga. Tolerante: sem tabela, devolve vazio. */
async function carregar() {
  try {
    const { rows } = await pool.query(`SELECT doc, faturamento_12m::float AS faturamento, funcionarios FROM questor_cliente_dados`);
    const cfg = await pool.query(`SELECT valor, to_char(updated_at AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS lido_em FROM cs_config WHERE chave = $1`, [CHAVE_PERIODO]);
    let periodo = null; try { periodo = cfg.rows[0] ? JSON.parse(cfg.rows[0].valor) : null; } catch (e) { /* sem período */ }
    return { dados: new Map(rows.map((r) => [r.doc, { faturamento: r.faturamento, funcionarios: r.funcionarios }])), periodo, lido_em: cfg.rows[0] ? cfg.rows[0].lido_em : null };
  } catch (e) { console.warn('[questor] leitura opcional falhou:', e.message); return { dados: new Map(), periodo: null, lido_em: null }; }
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
  try { res.json({ ok: true, ...(await gravar(req.body)) }); }
  catch (e) {
    if (/^Informe|^Nenhum|^Valor inválido/.test(e.message)) return res.status(400).json({ error: e.message });
    console.error('[questor] POST / falhou:', e); res.status(500).json({ error: 'Erro ao gravar os dados do Questor.' });
  }
});

module.exports = { router, gravar, carregar, validarCarga };
