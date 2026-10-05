'use strict';
/**
 * Taxa de churn por SAÍDAS (Etapa 2 do painel de Risco, alinhamento de 05/10/2026 Reysner × Larissa).
 *
 * Regra do Reysner (06/10/2026): contam como churn as TRÊS saídas "Transferida por…" do Acessórias (conveniência, mau
 * atendimento e preço). "Baixada" (empresa fechou o CNPJ) NÃO conta.
 *
 * FONTE DA VERDADE = o motivo de cancelamento lido DIRETO do Acessórias (clientes.motivo_cancelamento_acessorias). O
 * motivo gravado pelo sistema (motivo_saida) não é confiável: o fluxo antigo, que dependia de alguém decidir "baixa ou
 * saída", nunca funcionou — o sistema gravou "Baixa de empresa" por padrão e ficou "Pendente de revisão". Sem o motivo do
 * Acessórias a saída fica "A confirmar" (não entra na conta e aparece destacada).
 *
 * Taxa = saídas contadas ÷ base ativa no início do período (quem já era cliente antes do início e ainda não tinha saído).
 *
 * Endpoints (montados em /api/cs/churn):
 *   GET  /                      -> presets (mês atual, mês anterior, 12 meses, ano) ou período livre (?ini=&fim=)
 *   PUT  /config                -> padrões de motivo que contam como churn (admin)
 *   POST /sincronizar-motivos   -> lê do Acessórias o motivo de cancelamento das empresas inativas (admin, segundo plano)
 *   GET  /diagnostico           -> mostra quais campos de motivo a API do Acessórias devolve pra uma empresa (admin)
 */
const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireAdmin } = require('../auth');
const acessorias = require('../acessoriasClient');

const CHAVE_PADROES = 'churn_padroes_motivo';
const CHAVE_SYNC_MOTIVOS = 'churn_motivos_sync';
const PADROES_PADRAO = ['transferida por', 'transferido por', 'transferencia por'];

/** minúsculas, sem acento, espaços normalizados. */
function normalizar(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Motivo gravado pelo sistema só vale se for uma decisão de verdade (não o padrão "Baixa de empresa" nem "Pendente"). */
function motivoDoSistemaConfiavel(m) {
  const n = normalizar(m);
  if (!n || n === 'baixa de empresa' || n.startsWith('pendente de revisao')) return '';
  return n;
}

/** 'transferida' (conta) | 'baixa' | 'outra_saida' | 'a_confirmar' (sem motivo lido do Acessórias). */
function classificarSaida(motivoAcessorias, motivoSistema, padroes = PADROES_PADRAO) {
  const texto = normalizar(motivoAcessorias) || motivoDoSistemaConfiavel(motivoSistema);
  if (!texto) return 'a_confirmar';
  if (padroes.some((p) => p && texto.includes(normalizar(p)))) return 'transferida';
  if (texto.includes('baixa')) return 'baixa';
  return 'outra_saida';
}

/**
 * clientes: [{ id, nome, cnpj, data_entrada:'AAAA-MM-DD'|null, data_saida:'AAAA-MM-DD'|null, motivo_saida, motivo_acessorias }]
 * Datas como texto ISO (comparação lexicográfica vale).
 */
function calcularChurn(clientes, ini, fim, padroes = PADROES_PADRAO) {
  const base = clientes.filter((c) => (!c.data_entrada || c.data_entrada < ini) && (!c.data_saida || c.data_saida >= ini));
  const baseIds = new Set(base.map((c) => c.id));
  const saidas = clientes
    .filter((c) => c.data_saida && c.data_saida >= ini && c.data_saida <= fim)
    .map((c) => ({ ...c, tipo: classificarSaida(c.motivo_acessorias, c.motivo_saida, padroes), na_base: baseIds.has(c.id) }))
    .sort((a, b) => (a.data_saida < b.data_saida ? 1 : -1));

  const contadas = saidas.filter((s) => s.tipo === 'transferida' && s.na_base);
  const contagem = (tipo) => saidas.filter((s) => s.tipo === tipo).length;
  return {
    ini, fim,
    base: base.length,
    saidas_contadas: contadas.length,
    taxa: base.length ? +(100 * contadas.length / base.length).toFixed(2) : null,
    // saídas por transferência de quem entrou DENTRO do período: fora do cálculo, mas mostradas
    transferidas_fora_da_base: saidas.filter((s) => s.tipo === 'transferida' && !s.na_base).length,
    fora_do_churn: { baixas: contagem('baixa'), outras_saidas: contagem('outra_saida'), a_confirmar: contagem('a_confirmar') },
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
let _colunaPronta = null;
function garantirColuna() {
  if (!_colunaPronta) {
    _colunaPronta = pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS motivo_cancelamento_acessorias TEXT`)
      .catch((e) => { _colunaPronta = null; throw e; });
  }
  return _colunaPronta;
}

async function lerPadroes() {
  const { rows } = await pool.query(`SELECT valor FROM cs_config WHERE chave = $1`, [CHAVE_PADROES]);
  if (!rows.length) return [...PADROES_PADRAO];
  try {
    const p = JSON.parse(rows[0].valor);
    if (Array.isArray(p) && p.length && p.every((x) => typeof x === 'string' && x.trim())) return p;
  } catch (e) { /* cai no padrão */ }
  return [...PADROES_PADRAO];
}

async function lerUltimaLeituraMotivos() {
  const { rows } = await pool.query(`SELECT valor FROM cs_config WHERE chave = $1`, [CHAVE_SYNC_MOTIVOS]);
  try { return rows.length ? JSON.parse(rows[0].valor) : null; } catch (e) { return null; }
}

async function carregarClientes() {
  await garantirColuna();
  const { rows } = await pool.query(
    `SELECT id, nome_empresa AS nome, cnpj, to_char(data_entrada, 'YYYY-MM-DD') AS data_entrada,
            to_char(data_saida, 'YYYY-MM-DD') AS data_saida, motivo_saida,
            motivo_cancelamento_acessorias AS motivo_acessorias
       FROM clientes`
  );
  return rows;
}

// ── Leitura do motivo de cancelamento direto do Acessórias ───────────────────
let _sincronizando = false;
async function sincronizarMotivos({ desde = '2025-01-01' } = {}) {
  const token = process.env.ACESSORIAS_API_TOKEN;
  if (!token) throw new Error('ACESSORIAS_API_TOKEN não configurado.');
  if (_sincronizando) throw new Error('Já existe uma leitura de motivos em andamento.');
  _sincronizando = true;
  try {
    await garantirColuna();
    const inativas = await acessorias.listarEmpresasInativasDesde({ token, desde });
    let comMotivo = 0, semMotivo = 0, atualizados = 0;
    const exemplos = new Set();
    for (const e of inativas) {
      const cnpj = String(e.cnpj || '').replace(/\D/g, '');
      if (!cnpj) continue;
      const motivo = e.motivoCancelamentoBruto;
      if (!motivo) { semMotivo++; continue; }
      comMotivo++;
      if (exemplos.size < 6) exemplos.add(motivo);
      const r = await pool.query(
        `UPDATE clientes SET motivo_cancelamento_acessorias = $1
          WHERE regexp_replace(cnpj, '\\D', '', 'g') = $2 AND motivo_cancelamento_acessorias IS DISTINCT FROM $1`,
        [motivo, cnpj]
      );
      atualizados += r.rowCount;
    }
    const resumo = { em: new Date().toISOString(), desde, inativas: inativas.length, com_motivo: comMotivo, sem_motivo: semMotivo, atualizados, exemplos_de_motivo: [...exemplos] };
    await pool.query(
      `INSERT INTO cs_config (chave, valor, updated_at) VALUES ($1,$2,NOW())
       ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor, updated_at = NOW()`,
      [CHAVE_SYNC_MOTIVOS, JSON.stringify(resumo)]
    );
    return resumo;
  } finally { _sincronizando = false; }
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
  try {
    const [clientes, padroes, leitura] = await Promise.all([carregarClientes(), lerPadroes(), lerUltimaLeituraMotivos()]);
    const base = { padroes, leitura_motivos: leitura, lendo_motivos: _sincronizando };
    const hoje = hojeBrasilia();
    const { ini, fim } = req.query;
    if (ini || fim) {
      if (!ISO.test(ini || '') || !ISO.test(fim || '') || ini > fim) return res.status(400).json({ error: 'Informe ini e fim no formato AAAA-MM-DD, com ini <= fim.' });
      return res.json({ ...base, periodo: { rotulo: 'Período', ...calcularChurn(clientes, ini, fim, padroes) } });
    }
    const resultado = {};
    for (const [chave, p] of Object.entries(presets(hoje))) resultado[chave] = { rotulo: p.rotulo, ...calcularChurn(clientes, p.ini, p.fim, padroes) };
    res.json({ ...base, periodos: resultado });
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

router.post('/sincronizar-motivos', requireAuth, requireAdmin, (req, res) => {
  if (_sincronizando) return res.status(409).json({ error: 'Já existe uma leitura de motivos em andamento.' });
  if (!process.env.ACESSORIAS_API_TOKEN) return res.status(400).json({ error: 'ACESSORIAS_API_TOKEN não configurado.' });
  sincronizarMotivos()
    .then((r) => console.log('[churn] Motivos lidos do Acessórias:', r))
    .catch((e) => console.error('[churn] Falha ao ler motivos do Acessórias:', e.message));
  res.json({ ok: true, mensagem: 'Leitura iniciada em segundo plano (pode levar alguns minutos). Reabra esta janela depois para ver o resultado.' });
});

// Mostra o que a API do Acessórias devolve pra uma empresa: nomes de todos os campos e o valor dos que parecem ser de motivo/cancelamento.
router.get('/diagnostico', requireAuth, requireAdmin, async (req, res) => {
  try {
    const token = process.env.ACESSORIAS_API_TOKEN;
    if (!token) return res.status(400).json({ error: 'ACESSORIAS_API_TOKEN não configurado.' });
    let cnpj = String(req.query.cnpj || '').trim();
    if (!cnpj) {
      const { rows } = await pool.query(`SELECT cnpj FROM clientes WHERE status = 'encerrado' AND data_saida IS NOT NULL ORDER BY data_saida DESC LIMIT 1`);
      cnpj = rows[0] ? rows[0].cnpj : '';
    }
    if (!cnpj) return res.status(404).json({ error: 'Nenhuma empresa encerrada para testar.' });
    const empresa = await acessorias.buscarEmpresaBruta(cnpj, token);
    if (!empresa || typeof empresa !== 'object') return res.status(404).json({ error: 'Empresa não encontrada no Acessórias.' });
    const candidatos = {};
    Object.keys(empresa).filter((k) => /motiv|cancel|saida|inativ|baixa|obs/i.test(k)).forEach((k) => { candidatos[k] = typeof empresa[k] === 'string' ? empresa[k] : typeof empresa[k]; });
    res.json({
      cnpj, status: empresa.Status || null, cliente_ate: empresa.ClienteAte || null,
      motivo_lido: acessorias.extrairMotivoCancelamento(empresa),
      campos_que_parecem_motivo: candidatos,
      todos_os_campos: Object.keys(empresa),
    });
  } catch (err) {
    console.error('[churn] GET /diagnostico falhou:', err);
    res.status(500).json({ error: 'Erro ao consultar o Acessórias: ' + err.message });
  }
});

module.exports = {
  router, classificarSaida, calcularChurn, presets, somarDias, normalizar, sincronizarMotivos, PADROES_PADRAO,
};
