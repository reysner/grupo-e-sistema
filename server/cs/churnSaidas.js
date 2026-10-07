'use strict';
/**
 * Taxa de churn por SAÍDAS (Etapa 2 do painel de Risco, alinhamento de 05/10/2026 Reysner × Larissa).
 *
 * Regra do Reysner (06/10/2026): contam como churn as TRÊS saídas "Transferida por…" do Acessórias (conveniência, mau
 * atendimento e preço). "Baixada" (empresa fechou o CNPJ) NÃO conta.
 *
 * NINGUÉM decide "baixa ou saída" à mão (fluxo antigo, que nunca funcionou: o sistema gravava "Baixa de empresa" por padrão).
 * A classificação é automática, nesta ordem:
 *   1) motivo de cancelamento lido do Acessórias (clientes.motivo_cancelamento_acessorias) — se a API entregar o campo;
 *   2) motivo real gravado pelo sistema (ignora o padrão "Baixa de empresa" e "Pendente de revisão");
 *   3) situação do CNPJ na Receita (BrasilAPI/Minha Receita): BAIXADO = baixa; ATIVO = transferida (o Acessórias só tem 4
 *      motivos — Baixada e três "Transferida por…" — e as três transferências contam, então basta saber se a empresa fechou);
 *   4) sem nada disso: "A confirmar" (não entra na conta e aparece destacada).
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
const CHAVE_SYNC_RECEITA = 'churn_receita_sync';
const FONTES_CNPJ = [
  (d) => `https://brasilapi.com.br/api/cnpj/v1/${d}`,
  (d) => `https://minhareceita.org/${d}`,
];
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

/**
 * Tipo do documento da empresa: 'CNPJ' | 'CPF' | 'CAEPF' | 'CNO' | null (vazio/desconhecido).
 * CPF = 11 dígitos; CNO = 12; CNPJ e CAEPF têm 14 e se distinguem pela máscara do Acessórias
 * (CNPJ 00.000.000/0000-00; CAEPF 000.000.000/000-00).
 */
function tipoDocumento(bruto) {
  const texto = String(bruto || '').trim();
  const digitos = texto.replace(/\D/g, '');
  if (!digitos) return null;
  if (digitos.length === 11) return 'CPF';
  if (digitos.length === 12) return 'CNO';
  if (digitos.length === 14) return /^\d{3}\.\d{3}\.\d{3}\/\d{3}-\d{2}$/.test(texto) ? 'CAEPF' : 'CNPJ';
  return null;
}

/** Só CNPJ entra no churn (06/10/2026, Reysner: "vamos tratar somente CNPJs"): CPF, CAEPF, CNO e cadastro sem documento ficam de fora. */
function ehPessoaJuridica(bruto) {
  return tipoDocumento(bruto) === 'CNPJ';
}

const DIAS_BAIXA_RECEITA_APOS_SAIDA = 120;

/** Situação do CNPJ na Receita → 'transferida' | 'baixa' | null (não dá pra inferir: suspensa, inapta, nula...). */
function inferirPelaReceita(situacao, dataSituacao, dataSaida) {
  const s = normalizar(situacao);
  if (s === 'ativa') return 'transferida';
  if (s === 'baixada') {
    // o CNPJ só foi baixado bem DEPOIS de a empresa sair do escritório: ela saiu viva (foi pra outro contador)
    if (dataSituacao && dataSaida && dataSituacao > somarDias(dataSaida, DIAS_BAIXA_RECEITA_APOS_SAIDA)) return 'transferida';
    return 'baixa';
  }
  return null;
}

/** { tipo: 'transferida'|'baixa'|'outra_saida'|'a_confirmar', origem: 'acessorias'|'sistema'|'receita'|null } */
function classificarSaidaDetalhe(motivoAcessorias, motivoSistema, padroes = PADROES_PADRAO, receita = null, dataSaida = null, manual = null) {
  if (manual === 'transferida' || manual === 'baixa') return { tipo: manual, origem: 'manual' };
  const doTexto = (texto) => (padroes.some((p) => p && texto.includes(normalizar(p))) ? 'transferida' : texto.includes('baixa') ? 'baixa' : 'outra_saida');
  const bruto = normalizar(motivoAcessorias);
  if (bruto) return { tipo: doTexto(bruto), origem: 'acessorias' };
  const doSistema = motivoDoSistemaConfiavel(motivoSistema);
  if (doSistema) return { tipo: doTexto(doSistema), origem: 'sistema' };
  const inf = receita ? inferirPelaReceita(receita.situacao, receita.data, dataSaida) : null;
  if (inf) return { tipo: inf, origem: 'receita' };
  return { tipo: 'a_confirmar', origem: null };
}

/** 'transferida' (conta) | 'baixa' | 'outra_saida' | 'a_confirmar'. */
function classificarSaida(motivoAcessorias, motivoSistema, padroes = PADROES_PADRAO, receita = null, dataSaida = null) {
  return classificarSaidaDetalhe(motivoAcessorias, motivoSistema, padroes, receita, dataSaida).tipo;
}

/**
 * clientes: [{ id, nome, cnpj, data_entrada:'AAAA-MM-DD'|null, data_saida:'AAAA-MM-DD'|null, motivo_saida, motivo_acessorias }]
 * Datas como texto ISO (comparação lexicográfica vale).
 */
function calcularChurn(todosClientes, ini, fim, padroes = PADROES_PADRAO) {
  // CPF, CAEPF e CNO não entram no churn (06/10/2026, Reysner): saem da base e das saídas.
  const clientes = todosClientes.filter((c) => ehPessoaJuridica(c.cnpj));
  const desconsiderados = {
    base: todosClientes.filter((c) => !ehPessoaJuridica(c.cnpj) && (!c.data_entrada || c.data_entrada < ini) && (!c.data_saida || c.data_saida >= ini)).length,
    saidas: todosClientes.filter((c) => !ehPessoaJuridica(c.cnpj) && c.data_saida && c.data_saida >= ini && c.data_saida <= fim).length,
  };
  const base = clientes.filter((c) => (!c.data_entrada || c.data_entrada < ini) && (!c.data_saida || c.data_saida >= ini));
  const baseIds = new Set(base.map((c) => c.id));
  const saidas = clientes
    .filter((c) => c.data_saida && c.data_saida >= ini && c.data_saida <= fim)
    .map((c) => ({
      ...c,
      ...classificarSaidaDetalhe(c.motivo_acessorias, c.motivo_saida, padroes, c.situacao_receita ? { situacao: c.situacao_receita, data: c.data_situacao_receita } : null, c.data_saida, c.classificacao_manual),
      na_base: baseIds.has(c.id),
    }))
    .sort((a, b) => (a.data_saida < b.data_saida ? 1 : -1));

  const contadas = saidas.filter((s) => s.tipo === 'transferida' && s.na_base);
  const contagem = (tipo) => saidas.filter((s) => s.tipo === tipo).length;
  const aConfirmarNaBase = saidas.filter((s) => s.tipo === 'a_confirmar' && s.na_base).length;
  return {
    ini, fim,
    base: base.length,
    saidas_contadas: contadas.length,
    taxa: base.length ? +(100 * contadas.length / base.length).toFixed(2) : null,
    // teto: se TODAS as saídas ainda sem motivo lido do Acessórias fossem transferências (só pra dar a ordem de grandeza)
    taxa_teto: base.length ? +(100 * (contadas.length + aConfirmarNaBase) / base.length).toFixed(2) : null,
    // saídas por transferência de quem entrou DENTRO do período: fora do cálculo, mas mostradas
    transferidas_fora_da_base: saidas.filter((s) => s.tipo === 'transferida' && !s.na_base).length,
    fora_do_churn: { baixas: contagem('baixa'), outras_saidas: contagem('outra_saida'), a_confirmar: contagem('a_confirmar') },
    inferidas_pela_receita: saidas.filter((s) => s.origem === 'receita').length,
    desconsiderados_cpf_caepf_cno: desconsiderados,
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
    _colunaPronta = (async () => {
      await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS motivo_cancelamento_acessorias TEXT`);
      await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS situacao_receita TEXT`);
      await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS data_situacao_receita DATE`);
      await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS situacao_receita_em TIMESTAMPTZ`);
      // Exceção manual (só pras saídas que o automático não resolveu): 'transferida' | 'baixa'. Vale acima de tudo.
      await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS classificacao_manual TEXT`);
      await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS classificacao_manual_por TEXT`);
      await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS classificacao_manual_em TIMESTAMPTZ`);
      // O fluxo manual "foi baixa ou saída?" acabou (06/10/2026): limpa do sino os avisos antigos que pediam essa decisão.
      await pool.query(`UPDATE notificacoes SET lida = true WHERE tipo = 'churn_acessorias' AND lida = false`).catch(() => {});
    })().catch((e) => { _colunaPronta = null; throw e; });
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

async function lerUltimaClassificacao() {
  const { rows } = await pool.query(`SELECT valor FROM cs_config WHERE chave = $1`, [CHAVE_SYNC_RECEITA]);
  try { return rows.length ? JSON.parse(rows[0].valor) : null; } catch (e) { return null; }
}

async function carregarClientes() {
  await garantirColuna();
  const { rows } = await pool.query(
    `SELECT id, nome_empresa AS nome, cnpj, to_char(data_entrada, 'YYYY-MM-DD') AS data_entrada,
            to_char(data_saida, 'YYYY-MM-DD') AS data_saida, motivo_saida,
            motivo_cancelamento_acessorias AS motivo_acessorias, situacao_receita, classificacao_manual,
            to_char(data_situacao_receita, 'YYYY-MM-DD') AS data_situacao_receita
       FROM clientes`
  );
  return rows;
}

// ── Situação do CNPJ na Receita (fontes abertas: BrasilAPI e, se falhar, Minha Receita) ──
async function consultarSituacaoCnpj(cnpj) {
  const d = String(cnpj || '').replace(/\D/g, '');
  if (d.length !== 14) return null; // CPF: não existe baixa na Receita
  let ultimoErro = null;
  for (const url of FONTES_CNPJ) {
    try {
      const res = await fetch(url(d), { signal: AbortSignal.timeout(15000), headers: { Accept: 'application/json' } });
      if (!res.ok) { ultimoErro = new Error(res.status + ' em ' + new URL(url(d)).hostname); continue; }
      const j = await res.json();
      const situacao = String(j.descricao_situacao_cadastral || '').trim().toUpperCase();
      if (!situacao) { ultimoErro = new Error('resposta sem situação cadastral'); continue; }
      const data = /^\d{4}-\d{2}-\d{2}/.test(String(j.data_situacao_cadastral || '')) ? String(j.data_situacao_cadastral).slice(0, 10) : null;
      return { situacao, data };
    } catch (e) { ultimoErro = e; }
  }
  throw ultimoErro || new Error('nenhuma fonte respondeu');
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
let _classificando = false;
/** Consulta a Receita pras saídas dos últimos ~15 meses que ainda não têm motivo (do Acessórias ou real do sistema). */
async function classificarSaidasPelaReceita({ limite = 150 } = {}) {
  if (_classificando) throw new Error('Já existe uma classificação em andamento.');
  _classificando = true;
  try {
    await garantirColuna();
    const { rows } = await pool.query(
      `SELECT id, cnpj FROM clientes
        WHERE status = 'encerrado' AND data_saida IS NOT NULL AND data_saida >= CURRENT_DATE - INTERVAL '460 days'
          AND motivo_cancelamento_acessorias IS NULL AND classificacao_manual IS NULL
          AND (motivo_saida IS NULL OR lower(motivo_saida) = 'baixa de empresa' OR lower(motivo_saida) LIKE 'pendente de revis%')
          AND length(regexp_replace(cnpj, '\\D', '', 'g')) = 14
          AND cnpj !~ '^[0-9]{3}[.][0-9]{3}[.][0-9]{3}/[0-9]{3}-[0-9]{2}$'
          AND (situacao_receita_em IS NULL
               OR situacao_receita_em < NOW() - (CASE WHEN situacao_receita = 'INDISPONIVEL' THEN INTERVAL '7 days' ELSE INTERVAL '90 days' END))
        ORDER BY data_saida DESC LIMIT $1`, [limite]
    );
    const r = { em: new Date().toISOString(), consultadas: 0, baixadas: 0, ativas: 0, outras: 0, indisponiveis: 0 };
    for (const c of rows) {
      let achado = null;
      try { achado = await consultarSituacaoCnpj(c.cnpj); } catch (e) { achado = null; }
      r.consultadas++;
      if (!achado) {
        r.indisponiveis++;
        await pool.query(`UPDATE clientes SET situacao_receita = 'INDISPONIVEL', data_situacao_receita = NULL, situacao_receita_em = NOW() WHERE id = $1`, [c.id]);
      } else {
        if (achado.situacao === 'BAIXADA') r.baixadas++; else if (achado.situacao === 'ATIVA') r.ativas++; else r.outras++;
        await pool.query(`UPDATE clientes SET situacao_receita = $1, data_situacao_receita = $2, situacao_receita_em = NOW() WHERE id = $3`, [achado.situacao, achado.data, c.id]);
      }
      await esperar(800);
    }
    await pool.query(
      `INSERT INTO cs_config (chave, valor, updated_at) VALUES ($1,$2,NOW())
       ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor, updated_at = NOW()`,
      [CHAVE_SYNC_RECEITA, JSON.stringify(r)]
    );
    return r;
  } finally { _classificando = false; }
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
    const [clientes, padroes, leitura, classificacao] = await Promise.all([carregarClientes(), lerPadroes(), lerUltimaLeituraMotivos(), lerUltimaClassificacao()]);
    const base = { padroes, leitura_motivos: leitura, lendo_motivos: _sincronizando, classificacao_receita: classificacao, classificando: _classificando };
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

// Exceção manual: o admin define "transferida" ou "baixa" numa saída que o automático não conseguiu resolver.
router.put('/saidas/:id/classificacao', requireAuth, requireAdmin, async (req, res) => {
  try {
    const tipo = req.body && req.body.tipo;
    if (tipo !== 'transferida' && tipo !== 'baixa') return res.status(400).json({ error: 'tipo precisa ser "transferida" ou "baixa".' });
    await garantirColuna();
    const r = await pool.query(
      `UPDATE clientes SET classificacao_manual = $1, classificacao_manual_por = $2, classificacao_manual_em = NOW()
        WHERE id = $3 AND status = 'encerrado'`,
      [tipo, req.user.name || null, req.params.id]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'Saída não encontrada (o cliente precisa estar encerrado).' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[churn] PUT /saidas/:id/classificacao falhou:', err);
    res.status(500).json({ error: 'Erro ao salvar a classificação.' });
  }
});

router.post('/classificar-saidas', requireAuth, requireAdmin, (req, res) => {
  if (_classificando) return res.status(409).json({ error: 'Já existe uma classificação em andamento.' });
  classificarSaidasPelaReceita()
    .then((r) => console.log('[churn] Saídas classificadas pela Receita:', r))
    .catch((e) => console.error('[churn] Falha ao classificar saídas pela Receita:', e.message));
  res.json({ ok: true, mensagem: 'Classificação automática iniciada em segundo plano (alguns minutos). Reabra esta janela depois.' });
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
  router, classificarSaida, classificarSaidaDetalhe, inferirPelaReceita, calcularChurn, presets, somarDias, normalizar,
  tipoDocumento, ehPessoaJuridica,
  sincronizarMotivos, classificarSaidasPelaReceita, consultarSituacaoCnpj, garantirColuna, PADROES_PADRAO,
  carregarClientes, lerPadroes, hojeBrasilia,
};
