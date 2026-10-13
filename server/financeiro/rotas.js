'use strict';
/**
 * Página /financeiro (login próprio, contas do Grupo-E): inadimplência por competência, clientes suspensos no Omie, cobranças feitas
 * pelo Bruno no Zappy e um dashboard da carteira. Só leitura para quem acessa; a leitura do Omie entra pela rotina diária das 11h.
 *
 * Quem entra (decidido no servidor, nunca no navegador):
 *   - administrador                       -> tudo, com valores em R$ (e o botão "Ocultar valores" na tela, para apresentações)
 *   - acesso_financeiro (Usuários)        -> tudo, com valores em R$
 *   - usuário ou acesso_cs                -> a mesma página SEM valores em R$ (os valores saem do servidor ocultos)
 *   - contábil/colaborador sem as marcas  -> 403
 *
 *   GET  /api/financeiro/dados           -> carteira inteira (KPIs, aging, clientes, suspensos, cobranças)
 *   GET  /api/financeiro/ficha/:doc      -> um cliente: títulos em aberto com "vezes cobrado" e a linha do tempo das cobranças
 *   POST /api/financeiro/titulos         -> (token de sincronização) títulos em aberto e pontualidade lidos do Omie
 */
const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../auth');
const calc = require('./calculo');

const PAPEIS = ['administrador', 'usuario'];
const soDigitos = (s) => String(s || '').replace(/\D/g, '');
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const hojeBrasilia = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const r2 = (x) => Math.round((Number(x) || 0) * 100) / 100;
// O Zappy só passou a ser lido a partir de maio/2026: antes disso não há como saber quem cobrou.
const COBRANCAS_DESDE = '2026-05-01';

const veValores = (user) => !!user && (user.role === 'administrador' || !!user.acessoFinanceiro);
const podeEntrar = (user) => !!user && (PAPEIS.includes(user.role) || !!user.acessoFinanceiro || !!user.acessoCs);

function soFinanceiro(req, res, next) {
  if (!podeEntrar(req.user)) return res.status(403).json({ error: 'Acesso restrito à equipe autorizada para o Financeiro.' });
  next();
}

// ── Banco ────────────────────────────────────────────────────────────────────
let _schema = null;
function garantirSchema() {
  if (!_schema) {
    // RLS ligado e sem policy: só o servidor lê (regra do projeto para tabela nova).
    _schema = pool.query(`CREATE TABLE IF NOT EXISTS financeiro_titulos (
        unidade TEXT NOT NULL, rec TEXT NOT NULL, cnpj TEXT NOT NULL, nome TEXT, vencimento DATE NOT NULL,
        valor_aberto NUMERIC(14,2) NOT NULL DEFAULT 0, valor_doc NUMERIC(14,2) NOT NULL DEFAULT 0, situacao TEXT NOT NULL,
        atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (unidade, rec))`)
      .then(() => pool.query(`CREATE INDEX IF NOT EXISTS idx_fin_titulos_cnpj ON financeiro_titulos (cnpj)`))
      .then(() => pool.query(`ALTER TABLE financeiro_titulos ENABLE ROW LEVEL SECURITY`))
      .then(() => pool.query(`CREATE TABLE IF NOT EXISTS financeiro_pontualidade (
        unidade TEXT NOT NULL, cnpj TEXT NOT NULL, pagos INT NOT NULL DEFAULT 0, media_dias NUMERIC(8,1) NOT NULL DEFAULT 0,
        max_dias INT NOT NULL DEFAULT 0, atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (unidade, cnpj))`))
      .then(() => pool.query(`ALTER TABLE financeiro_pontualidade ENABLE ROW LEVEL SECURITY`))
      .catch((e) => { _schema = null; throw e; });
  }
  return _schema;
}

/** Consulta tolerante: se uma tabela opcional não existir, a página segue sem ela. */
async function consultar(sql, params = [], rotulo = '') {
  try { return (await pool.query(sql, params)).rows; }
  catch (e) { console.warn(`[financeiro] consulta opcional falhou (${rotulo}):`, e.message); return null; }
}

// ── Composição (pura) ────────────────────────────────────────────────────────
/**
 * Junta tudo em uma estrutura só. Entradas já lidas do banco:
 *  clientes   [{ id, nome, cnpj, grupo, cronico }]            clientes ATIVOS no Acessórias
 *  categorias { [idCliente]: { categoria } }
 *  honorarios Map doc -> valor mensal (Omie)                   quem tem entrada aqui fatura no Omie
 *  abertoAgg  Map doc -> { qtd, aberto, atrasado, qtd_atrasados, mais_antigo }
 *  titulos    [{ doc, rec, venc, aberto, doc_valor, sit }]      títulos em aberto (A atrasado, P parcial, V a vencer)
 *  pontual    Map doc -> { pagos, media_dias, max_dias }
 *  suspensos  Map doc -> { contrato }
 *  mensagens  [{ doc, dia, texto, ticket }]                     mensagens do Bruno que parecem cobrança
 */
function compor({ clientes, categorias = {}, honorarios = new Map(), abertoAgg = new Map(), titulos = [], pontual = new Map(), suspensos = new Map(), mensagens = [], hoje, lidoEm = {} }) {
  const titulosPorDoc = new Map();
  for (const t of titulos) { if (!titulosPorDoc.has(t.doc)) titulosPorDoc.set(t.doc, []); titulosPorDoc.get(t.doc).push(t); }
  const msgsPorDoc = new Map();
  for (const m of mensagens) { if (!msgsPorDoc.has(m.doc)) msgsPorDoc.set(m.doc, []); msgsPorDoc.get(m.doc).push(m); }

  const lista = [];
  const eventosDe = new Map();
  for (const c of clientes) {
    const doc = soDigitos(c.cnpj);
    const hon = honorarios.has(doc) ? honorarios.get(doc) : null;
    const ag = abertoAgg.get(doc) || null;
    const susp = suspensos.has(doc);
    const eventos = calc.eventosPorDia(msgsPorDoc.get(doc) || []);
    eventosDe.set(doc, eventos);

    // títulos em aberto, com "vezes cobrado" por competência
    const brutos = (titulosPorDoc.get(doc) || []).map((t) => ({ vencimento: t.venc, valor: r2(t.aberto), valor_doc: r2(t.doc_valor), situacao: t.sit, pago_em: null }));
    const abertos = calc.contarCobrancas(brutos, eventos).sort((a, b) => a.vencimento.localeCompare(b.vencimento)).map((t) => ({
      vencimento: t.vencimento, valor: t.valor, situacao: t.situacao, vencido: t.vencimento < hoje,
      dias_atraso: t.vencimento < hoje ? calc.diasEntre(t.vencimento, hoje) : 0,
      cobrancas: t.cobrancas, ultima_cobranca: t.ultima_cobranca,
    }));
    const vencidos = abertos.filter((t) => t.vencido);
    const temDetalhe = abertos.length > 0;

    // totais do atraso: dos títulos quando existem; senão do agregado que o Financeiro já guardava
    const qtdAtrasados = temDetalhe ? vencidos.length : (ag ? ag.qtd_atrasados : 0);
    const valorAtrasado = temDetalhe ? r2(vencidos.reduce((s, t) => s + t.valor, 0)) : (ag ? r2(ag.atrasado) : 0);
    const maisAntigo = temDetalhe ? (vencidos[0] ? vencidos[0].vencimento : null) : (ag && ag.mais_antigo ? ag.mais_antigo : null);
    const diasAtraso = maisAntigo && qtdAtrasados > 0 ? Math.max(0, calc.diasEntre(maisAntigo, hoje)) : 0;

    // cobranças do atraso ATUAL: dias de cobrança feitos depois do vencimento mais antigo em aberto
    const doAtraso = maisAntigo ? eventos.filter((e) => e.conta && e.dia > maisAntigo) : [];
    const cobrancas = doAtraso.length;
    const ultimaCobranca = doAtraso.length ? doAtraso[doAtraso.length - 1].dia : null;
    const inadimplente = qtdAtrasados > 0;
    const passo = calc.proximoPasso({ suspenso: susp, diasAtraso, qtdAtrasados, cobrancas, ultimaCobranca, cronico: !!c.cronico, hoje });
    const p = pontual.get(doc) || null;
    const faixa = inadimplente ? calc.faixaDeAtraso(diasAtraso) : null;

    lista.push({
      id: c.id, doc, nome: c.nome, cnpj: c.cnpj, grupo: c.grupo || null,
      tipo_doc: doc.length === 14 ? 'CNPJ' : doc.length === 11 ? 'CPF' : 'Outro',
      categoria: (categorias[c.id] && categorias[c.id].categoria) || null,
      cronico: !!c.cronico, honorario: hon, fatura_no_omie: hon != null,
      suspenso: susp,
      situacao: inadimplente ? 'inadimplente' : susp ? 'suspenso' : hon != null ? 'em_dia' : 'sem_honorario',
      qtd_atrasados: qtdAtrasados, valor_atrasado: valorAtrasado, valor_aberto: temDetalhe ? r2(abertos.reduce((s, t) => s + t.valor, 0)) : (ag ? r2(ag.aberto) : 0),
      mais_antigo: maisAntigo, dias_atraso: diasAtraso, faixa: faixa ? faixa.id : null,
      detalhe_titulos: temDetalhe, abertos,
      cobrancas, ultima_cobranca: ultimaCobranca,
      dias_desde_cobranca: ultimaCobranca ? calc.diasEntre(ultimaCobranca, hoje) : null,
      cobrancas_total: eventos.filter((e) => e.conta).length,
      pontualidade: p ? { pagos: p.pagos, media_dias: p.media_dias, max_dias: p.max_dias } : null,
      proximo_passo: passo,
    });
  }

  // ── KPIs ──
  const inad = lista.filter((c) => c.situacao === 'inadimplente');
  const comHon = lista.filter((c) => c.fatura_no_omie);
  const aging = calc.FAIXAS.map((f) => ({ id: f.id, rotulo: f.rotulo, clientes: 0, valor: 0 }));
  const faixaPor = new Map(aging.map((a) => [a.id, a]));
  for (const c of inad) {
    const tocadas = new Set();
    if (c.detalhe_titulos) {
      for (const t of c.abertos.filter((x) => x.vencido)) { const f = calc.faixaDeAtraso(t.dias_atraso); if (f) { faixaPor.get(f.id).valor = r2(faixaPor.get(f.id).valor + t.valor); tocadas.add(f.id); } }
    } else if (c.faixa) { faixaPor.get(c.faixa).valor = r2(faixaPor.get(c.faixa).valor + c.valor_atrasado); tocadas.add(c.faixa); }
    tocadas.forEach((id) => { faixaPor.get(id).clientes++; });
  }
  const semMais30 = (d) => d != null && d <= 30;
  const todasEventos = [...eventosDe.values()].flat().filter((e) => e.conta);
  const em7 = (d) => d >= hoje && calc.diasEntre(hoje, d) <= 7;
  const aVencer = lista.flatMap((c) => c.abertos.filter((t) => !t.vencido && em7(t.vencimento)));
  const mesAtual = hoje.slice(0, 7);
  const kpis = {
    hoje,
    clientes_ativos: lista.length,
    clientes_com_honorario: comHon.length,
    honorario_mensal: r2(comHon.reduce((s, c) => s + c.honorario, 0)),
    inadimplentes: inad.length,
    pct_inadimplentes: comHon.length ? Math.round((inad.length / comHon.length) * 1000) / 10 : 0,
    valor_atrasado: r2(inad.reduce((s, c) => s + c.valor_atrasado, 0)),
    titulos_atrasados: inad.reduce((s, c) => s + c.qtd_atrasados, 0),
    cronicos: lista.filter((c) => c.cronico).length,
    mais_90_dias: inad.filter((c) => c.dias_atraso > 90).length,
    suspensos: lista.filter((c) => c.suspenso).length,
    suspensos_com_debito: lista.filter((c) => c.suspenso && c.qtd_atrasados > 0).length,
    honorario_suspenso: r2(lista.filter((c) => c.suspenso && c.honorario != null).reduce((s, c) => s + c.honorario, 0)),
    nunca_cobrados: inad.filter((c) => !c.cobrancas).length,
    cobrados_3_ou_mais: inad.filter((c) => c.cobrancas >= 3).length,
    cobrancas_30_dias: todasEventos.filter((e) => semMais30(calc.diasEntre(e.dia, hoje))).length,
    a_vencer_7_dias: { titulos: aVencer.length, valor: r2(aVencer.reduce((s, t) => s + t.valor, 0)) },
    vencendo_no_mes: { titulos: lista.flatMap((c) => c.abertos.filter((t) => t.vencimento.slice(0, 7) === mesAtual)).length },
    maus_pagadores: lista.filter((c) => c.pontualidade && c.pontualidade.pagos >= 3 && c.pontualidade.media_dias >= 10).length,
    aging,
    qualidade: {
      sem_honorario_no_omie: lista.filter((c) => !c.fatura_no_omie).length,
      inadimplentes_sem_detalhe: inad.filter((c) => !c.detalhe_titulos).length,
      titulos_lidos_em: lidoEm.titulos || null, financeiro_lido_em: lidoEm.financeiro || null, suspensos_lidos_em: lidoEm.suspensos || null,
      cobrancas_desde: COBRANCAS_DESDE,
    },
  };
  return { kpis, clientes: lista, eventos: eventosDe };
}

// ── Valores ocultos (feito no servidor) ──────────────────────────────────────
function mascarar(dados) {
  const k = dados.kpis;
  const clientes = dados.clientes.map((c) => ({
    ...c, honorario: null, valor_atrasado: null, valor_aberto: null,
    abertos: c.abertos.map((t) => ({ ...t, valor: null })),
  }));
  return {
    ...dados, valores_ocultos: true, clientes,
    kpis: { ...k, honorario_mensal: null, valor_atrasado: null, honorario_suspenso: null, a_vencer_7_dias: { ...k.a_vencer_7_dias, valor: null }, aging: k.aging.map((a) => ({ ...a, valor: null })) },
  };
}

// ── Leitura do banco ─────────────────────────────────────────────────────────
let _cache = null;
const TTL_MS = 60 * 1000;

async function carregar(forcar) {
  if (!forcar && _cache && Date.now() - _cache.t < TTL_MS) return _cache.v;
  await garantirSchema();
  const hoje = hojeBrasilia();

  let clientes = await consultar(`SELECT id, nome_empresa AS nome, cnpj, grupo_empresas AS grupo, COALESCE(inadimplente_cronico, false) AS cronico FROM clientes WHERE status = 'ativo'`, [], 'clientes');
  if (!clientes) clientes = (await consultar(`SELECT id, nome_empresa AS nome, cnpj, grupo_empresas AS grupo, false AS cronico FROM clientes WHERE status = 'ativo'`, [], 'clientes (sem crônico)')) || [];

  let categorias = {};
  try { categorias = (await require('../cs/categorias').calcularCategorias()).data || {}; } catch (e) { console.warn('[financeiro] categorias indisponíveis:', e.message); }

  const honorarios = new Map(((await consultar(`SELECT regexp_replace(cnpj, '\\D', '', 'g') AS doc, SUM(honorario_atual)::float AS v FROM financeiro_clientes GROUP BY 1`, [], 'financeiro_clientes')) || []).map((r) => [r.doc, r.v]));
  const abertoAgg = new Map(((await consultar(
    `SELECT regexp_replace(cnpj, '\\D', '', 'g') AS doc, SUM(qtd)::int AS qtd, SUM(valor_aberto)::float AS aberto, SUM(valor_atrasado)::float AS atrasado,
            SUM(qtd_atrasados)::int AS qtd_atrasados, to_char(MIN(mais_antigo), 'YYYY-MM-DD') AS mais_antigo FROM financeiro_aberto GROUP BY 1`, [], 'financeiro_aberto')) || []).map((r) => [r.doc, r]));
  const titulos = ((await consultar(
    `SELECT cnpj AS doc, rec, to_char(vencimento, 'YYYY-MM-DD') AS venc, valor_aberto::float AS aberto, valor_doc::float AS doc_valor, situacao AS sit FROM financeiro_titulos`, [], 'financeiro_titulos')) || []);
  const pontual = new Map(((await consultar(
    `SELECT cnpj AS doc, SUM(pagos)::int AS pagos, (SUM(media_dias * pagos) / NULLIF(SUM(pagos), 0))::float AS media_dias, MAX(max_dias)::int AS max_dias
       FROM financeiro_pontualidade GROUP BY 1`, [], 'financeiro_pontualidade')) || []).map((r) => [r.doc, { pagos: r.pagos, media_dias: Math.round((r.media_dias || 0) * 10) / 10, max_dias: r.max_dias }]));
  const suspensos = new Map(((await consultar(`SELECT doc, contrato FROM omie_contratos_suspensos`, [], 'suspensos do Omie')) || []).map((r) => [r.doc, { contrato: r.contrato }]));

  // Mensagens do Bruno que PARECEM cobrança (o filtro fino é do calculo.js). O cliente vem do vínculo do telefone com a Carteira.
  const mensagens = ((await consultar(
    `SELECT t.zappy_id AS ticket, to_char(m.hora AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS dia, m.texto,
            COALESCE(NULLIF(regexp_replace(COALESCE(c.cnpj, v.cnpj, ''), '\\D', '', 'g'), ''), '') AS doc
       FROM cs_mensagens m
       JOIN cs_tickets t ON t.id = m.ticket_id
       JOIN cs_vinculos v ON v.id = t.vinculo_id
       LEFT JOIN clientes c ON c.id::text = v.cliente_id
      WHERE m.remetente = 'escritorio' AND m.hora >= $1 AND m.texto ILIKE '*Bruno Xavier:*%'
        AND m.texto ~* '(honor|boleto|aberto|vencid|atras|pendent|suspens|paralis|inadimpl|baixa|pagamento)'`, [COBRANCAS_DESDE], 'mensagens de cobrança')) || []).filter((m) => m.doc);

  const [lt, lf, ls] = [
    (await consultar(`SELECT to_char(MAX(atualizado_em) AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD HH24:MI') AS d FROM financeiro_titulos`, [], 'titulos lidos em')) || [],
    (await consultar(`SELECT to_char(MAX(importado_em) AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD HH24:MI') AS d FROM financeiro_importacoes`, [], 'financeiro lido em')) || [],
    (await consultar(`SELECT to_char(MAX(atualizado_em) AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS d FROM omie_contratos_suspensos`, [], 'suspensos lidos em')) || [],
  ];
  const v = compor({ clientes, categorias, honorarios, abertoAgg, titulos, pontual, suspensos, mensagens, hoje, lidoEm: { titulos: lt[0] && lt[0].d, financeiro: lf[0] && lf[0].d, suspensos: ls[0] && ls[0].d } });
  _cache = { t: Date.now(), v };
  return v;
}

// ── Rotas ────────────────────────────────────────────────────────────────────
const router = express.Router();

function tokenSyncOk(req, res) {
  const esperado = process.env.LEGALIZACAO_SYNC_TOKEN || process.env.CERTISEGURO_SYNC_TOKEN;
  if (!esperado) { res.status(503).json({ error: 'Sincronização não configurada no servidor.' }); return false; }
  if (req.get('X-Sync-Token') !== esperado) { res.status(401).json({ error: 'Token de sincronização inválido.' }); return false; }
  return true;
}

router.get('/dados', requireAuth, soFinanceiro, async (req, res) => {
  try {
    const d = await carregar(req.query.forcar === '1');
    const base = { kpis: d.kpis, clientes: d.clientes, valores_ocultos: false };
    const saida = veValores(req.user) ? base : mascarar(base);
    res.json({ ...saida, usuario: { nome: req.user.name, papel: req.user.role, ve_valores: veValores(req.user) } });
  } catch (err) {
    console.error('[financeiro] GET /dados falhou:', err);
    res.status(500).json({ error: 'Erro ao montar o Financeiro.' });
  }
});

router.get('/ficha/:doc', requireAuth, soFinanceiro, async (req, res) => {
  try {
    const doc = soDigitos(req.params.doc);
    if (![11, 14].includes(doc.length)) return res.status(400).json({ error: 'Documento inválido.' });
    const d = await carregar(false);
    const cliente = d.clientes.find((c) => c.doc === doc);
    if (!cliente) return res.status(404).json({ error: 'Cliente não encontrado entre os ativos.' });
    // a linha do tempo mostra só o tipo e as datas citadas — o texto das mensagens (que traz valores) nunca sai daqui
    const eventos = (d.eventos.get(doc) || []).map((e) => ({ dia: e.dia, tipo: e.tipo, conta: e.conta, tickets: e.tickets, datas: e.datas }));
    const ficha = { cliente, eventos, valores_ocultos: false };
    if (veValores(req.user)) return res.json(ficha);
    const m = mascarar({ kpis: d.kpis, clientes: [cliente] });
    res.json({ cliente: m.clientes[0], eventos, valores_ocultos: true });
  } catch (err) {
    console.error('[financeiro] GET /ficha falhou:', err);
    res.status(500).json({ error: 'Erro ao montar a ficha.' });
  }
});

/**
 * Troca os títulos em aberto e a pontualidade de UMA unidade do Omie (snapshot completo, como o resto do Financeiro).
 * Corpo: { unidade, titulos: [{ rec, cnpj, venc:'AAAA-MM-DD', aberto, doc, sit:'A'|'P'|'V' }], pontualidade: [{ cnpj, pagos, media, max }] }
 */
router.post('/titulos', async (req, res) => {
  if (!tokenSyncOk(req, res)) return;
  const { unidade, titulos, pontualidade } = req.body || {};
  if (!unidade || !Array.isArray(titulos) || !Array.isArray(pontualidade)) return res.status(400).json({ error: 'Informe unidade, titulos e pontualidade.' });
  if (titulos.length > 30000 || pontualidade.length > 5000) return res.status(413).json({ error: 'Lista grande demais.' });
  let client = null;
  try {
    await garantirSchema();
    client = await pool.connect();
    const T = { rec: [], cnpj: [], venc: [], aberto: [], doc: [], sit: [] };
    const vistos = new Set();
    for (const t of titulos) {
      const cnpj = soDigitos(t && t.cnpj); const rec = String((t && t.rec) || '').slice(0, 40);
      if (![11, 14].includes(cnpj.length) || !rec || vistos.has(rec) || !ISO.test((t && t.venc) || '') || !['A', 'P', 'V'].includes(t.sit)) continue;
      vistos.add(rec);
      T.rec.push(rec); T.cnpj.push(cnpj); T.venc.push(t.venc); T.aberto.push(r2(t.aberto)); T.doc.push(r2(t.doc)); T.sit.push(t.sit);
    }
    const P = { cnpj: [], pagos: [], media: [], max: [] };
    const jaP = new Set();
    for (const p of pontualidade) {
      const cnpj = soDigitos(p && p.cnpj); if (![11, 14].includes(cnpj.length) || !(+p.pagos > 0) || jaP.has(cnpj)) continue;
      jaP.add(cnpj);
      P.cnpj.push(cnpj); P.pagos.push(parseInt(p.pagos, 10)); P.media.push(Math.round((+p.media || 0) * 10) / 10); P.max.push(parseInt(p.max, 10) || 0);
    }
    await client.query('BEGIN');
    await client.query(`DELETE FROM financeiro_titulos WHERE unidade = $1`, [unidade]);
    await client.query(`DELETE FROM financeiro_pontualidade WHERE unidade = $1`, [unidade]);
    if (T.rec.length) {
      await client.query(
        `INSERT INTO financeiro_titulos (unidade, rec, cnpj, vencimento, valor_aberto, valor_doc, situacao)
         SELECT $1::text, rec, cnpj, venc::date, aberto, doc, sit FROM unnest($2::text[], $3::text[], $4::text[], $5::numeric[], $6::numeric[], $7::text[]) AS x(rec, cnpj, venc, aberto, doc, sit)`,
        [unidade, T.rec, T.cnpj, T.venc, T.aberto, T.doc, T.sit]);
    }
    if (P.cnpj.length) {
      await client.query(
        `INSERT INTO financeiro_pontualidade (unidade, cnpj, pagos, media_dias, max_dias)
         SELECT $1::text, cnpj, pagos, media, max FROM unnest($2::text[], $3::int[], $4::numeric[], $5::int[]) AS x(cnpj, pagos, media, max)
         ON CONFLICT (unidade, cnpj) DO UPDATE SET pagos = EXCLUDED.pagos, media_dias = EXCLUDED.media_dias, max_dias = EXCLUDED.max_dias, atualizado_em = NOW()`,
        [unidade, P.cnpj, P.pagos, P.media, P.max]);
    }
    await client.query('COMMIT');
    _cache = null;
    res.json({ ok: true, unidade, titulos: T.rec.length, pontualidade: P.cnpj.length, ignorados: titulos.length - T.rec.length });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error('[financeiro] POST /titulos falhou:', err);
    res.status(500).json({ error: 'Erro ao gravar os títulos.' });
  } finally { if (client) client.release(); }
});

module.exports = { router, compor, mascarar, veValores, podeEntrar, soFinanceiro };
