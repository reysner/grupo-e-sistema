'use strict';
/**
 * Taxa de churn por SAÍDAS (Etapa 2 do painel de Risco, alinhamento de 05/10/2026 Reysner × Larissa).
 *
 * Regra do Reysner: só conta como churn a saída com motivo "Transferida por conveniência".
 * "Baixada" (empresa fechou o CNPJ) NÃO conta. As demais saídas (ex.: "Transferida por preço" ou "por mau atendimento")
 * não contam pela regra atual, mas aparecem separadas pra decisão — os padrões de motivo que contam são editáveis.
 *
 * Taxa = saídas contadas ÷ base ativa no início do período (quem já era cliente antes do início e ainda não tinha saído).
 *
 * Endpoints (montados em /api/cs/churn):
 *   GET /         -> presets (mês atual, mês anterior, últimos 12 meses, ano) ou período livre (?ini=&fim=), com lista das saídas
 *   PUT /config   -> padrões de motivo que contam como churn (admin)
 */
const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireAdmin } = require('../auth');

const CHAVE_PADROES = 'churn_padroes_motivo';
const PADROES_PADRAO = ['transferida por conveniencia', 'transferencia por conveniencia', 'transferido por conveniencia'];

/** minúsculas, sem acento, espaços normalizados. */
function normalizar(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** 'conveniencia' (conta) | 'baixa' | 'outra_saida' | 'pendente' (ainda sem motivo definido). */
function classificarSaida(motivo, padroes = PADROES_PADRAO) {
  const m = normalizar(motivo);
  if (!m || m.startsWith('pendente de revisao')) return 'pendente';
  if (padroes.some((p) => p && m.includes(normalizar(p)))) return 'conveniencia';
  if (m.includes('baixa')) return 'baixa';
  return 'outra_saida';
}

/**
 * clientes: [{ id, nome, data_entrada:'AAAA-MM-DD'|null, data_saida:'AAAA-MM-DD'|null, motivo_saida }]
 * Datas como texto ISO (comparação lexicográfica vale).
 */
function calcularChurn(clientes, ini, fim, padroes = PADROES_PADRAO) {
  const base = clientes.filter((c) => (!c.data_entrada || c.data_entrada < ini) && (!c.data_saida || c.data_saida >= ini));
  const baseIds = new Set(base.map((c) => c.id));
  const saidas = clientes
    .filter((c) => c.data_saida && c.data_saida >= ini && c.data_saida <= fim)
    .map((c) => ({ ...c, tipo: classificarSaida(c.motivo_saida, padroes), na_base: baseIds.has(c.id) }))
    .sort((a, b) => (a.data_saida < b.data_saida ? 1 : -1));

  const contadas = saidas.filter((s) => s.tipo === 'conveniencia' && s.na_base);
  const contagem = (tipo) => saidas.filter((s) => s.tipo === tipo).length;
  return {
    ini, fim,
    base: base.length,
    saidas_contadas: contadas.length,
    taxa: base.length ? +(100 * contadas.length / base.length).toFixed(2) : null,
    // saídas de conveniência de quem entrou DENTRO do período: fora do cálculo, mas mostradas
    conveniencia_fora_da_base: saidas.filter((s) => s.tipo === 'conveniencia' && !s.na_base).length,
    fora_do_churn: { baixas: contagem('baixa'), outras_saidas: contagem('outra_saida'), pendentes: contagem('pendente') },
    saidas,
  };
}

// ── Datas (horário de Brasília) ──────────────────────────────────────────────
function hojeBrasilia() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date()); // AAAA-MM-DD
}
function somarDias(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
function presets(hoje) {
  const [y, m] = hoje.split('-').map(Number);
  const primeiroMes = `${y}-${String(m).padStart(2, '0')}-01`;
  const mAnt = m === 1 ? { y: y - 1, m: 12 } : { y, m: m - 1 };
  const primeiroAnt = `${mAnt.y}-${String(mAnt.m).padStart(2, '0')}-01`;
  return {
    mes_atual: { rotulo: 'Mês atual', ini: primeiroMes, fim: hoje },
    mes_anterior: { rotulo: 'Mês anterior', ini: primeiroAnt, fim: somarDias(primeiroMes, -1) },
    ultimos_12_meses: { rotulo: 'Últimos 12 meses', ini: somarDias(hoje, -365), fim: hoje },
    ano: { rotulo: `Ano ${y}`, ini: `${y}-01-01`, fim: hoje },
  };
}

// ── Banco ────────────────────────────────────────────────────────────────────
async function lerPadroes() {
  const { rows } = await pool.query(`SELECT valor FROM cs_config WHERE chave = $1`, [CHAVE_PADROES]);
  if (!rows.length) return [...PADROES_PADRAO];
  try {
    const p = JSON.parse(rows[0].valor);
    if (Array.isArray(p) && p.length && p.every((x) => typeof x === 'string' && x.trim())) return p;
  } catch (e) { /* cai no padrão */ }
  return [...PADROES_PADRAO];
}

async function carregarClientes() {
  const { rows } = await pool.query(
    `SELECT id, nome_empresa AS nome, to_char(data_entrada, 'YYYY-MM-DD') AS data_entrada,
            to_char(data_saida, 'YYYY-MM-DD') AS data_saida, motivo_saida
       FROM clientes`
  );
  return rows;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
  try {
    const [clientes, padroes] = await Promise.all([carregarClientes(), lerPadroes()]);
    const hoje = hojeBrasilia();
    const { ini, fim } = req.query;
    if (ini || fim) {
      if (!ISO.test(ini || '') || !ISO.test(fim || '') || ini > fim) return res.status(400).json({ error: 'Informe ini e fim no formato AAAA-MM-DD, com ini <= fim.' });
      return res.json({ padroes, periodo: { rotulo: 'Período', ...calcularChurn(clientes, ini, fim, padroes) } });
    }
    const resultado = {};
    for (const [chave, p] of Object.entries(presets(hoje))) resultado[chave] = { rotulo: p.rotulo, ...calcularChurn(clientes, p.ini, p.fim, padroes) };
    res.json({ padroes, periodos: resultado });
  } catch (err) {
    console.error('[churn] GET / falhou:', err);
    res.status(500).json({ error: 'Erro ao calcular o churn.' });
  }
});

router.put('/config', requireAuth, requireAdmin, async (req, res) => {
  try {
    const padroes = req.body && req.body.padroes;
    if (!Array.isArray(padroes) || !padroes.length || !padroes.every((p) => typeof p === 'string' && normalizar(p))) {
      return res.status(400).json({ error: 'Informe ao menos um motivo (texto) que conta como churn.' });
    }
    await pool.query(
      `INSERT INTO cs_config (chave, valor, updated_at) VALUES ($1,$2,NOW())
       ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor, updated_at = NOW()`,
      [CHAVE_PADROES, JSON.stringify(padroes.map((p) => p.trim()))]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[churn] PUT /config falhou:', err);
    res.status(500).json({ error: 'Erro ao salvar a regra de churn.' });
  }
});

module.exports = { router, classificarSaida, calcularChurn, presets, somarDias, normalizar, PADROES_PADRAO };
