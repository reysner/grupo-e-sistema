'use strict';
/**
 * Painel do Sucesso do Cliente (página pública /cs, com login das contas do Grupo-E).
 * Junta, em um lugar só e só para leitura, o que já existe: Risco (3 termômetros), Categorias e Churn.
 *
 * Acesso: administrador e usuário (equipe interna). Contábil e colaborador nunca chegam aqui.
 * Só CNPJ (decisão do Reysner, 07/10/2026): CPF, CAEPF, CNO e cadastro sem documento ficam de fora de tudo.
 *
 *   GET /api/cs/painel/dados          -> tudo que a página precisa para abrir (clientes, risco, categoria, churn)
 *   GET /api/cs/painel/churn?ini&fim  -> churn de um período livre
 *   GET /api/cs/painel/cliente/:id    -> ficha do cliente (por que está em risco, títulos, atendimentos, entregas)
 */
const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../auth');
const risco = require('./risco');
const categorias = require('./categorias');
const churn = require('./churnSaidas');

const PAPEIS = ['administrador', 'usuario'];
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const soDigitos = (s) => String(s || '').replace(/\D/g, '');

function soEquipe(req, res, next) {
  if (!PAPEIS.includes(req.user && req.user.role)) return res.status(403).json({ error: 'Acesso restrito à equipe do Sucesso do Cliente.' });
  next();
}

/** Consulta tolerante: se uma tabela opcional não existir, o painel segue sem ela. */
async function consultar(sql, params = [], rotulo = '') {
  try { return (await pool.query(sql, params)).rows; }
  catch (e) { console.warn(`[painel] consulta opcional falhou (${rotulo}):`, e.message); return null; }
}

// ── Cache curto: a página faz poucas chamadas seguidas e o cálculo percorre a carteira inteira ──
let _cache = null;
const TTL_MS = 60 * 1000;

async function montarBase(forcar) {
  if (!forcar && _cache && Date.now() - _cache.t < TTL_MS) return _cache.v;

  const [r, cat, clientes] = await Promise.all([
    risco.calcularTodos({ detalhes: true }),
    categorias.calcularCategorias(),
    consultar(`SELECT c.id, c.nome_empresa AS nome, c.cnpj, c.grupo_empresas AS grupo, c.unidade,
                      to_char(c.data_entrada, 'YYYY-MM-DD') AS entrada
                 FROM clientes c WHERE c.status = 'ativo'`, [], 'clientes').then((x) => x || []),
  ]);

  // Reclamações dos últimos 30 dias por cliente (insatisfação registrada + nota baixa + abandono, depois da revisão da Gamificação)
  const insat = new Map(((await consultar(
    `SELECT regexp_replace(cnpj, '\\D', '', 'g') AS doc, COUNT(*)::int AS n FROM insatisfacoes WHERE created_at >= NOW() - INTERVAL '30 days' GROUP BY 1`, [], 'insatisfacoes 30d')) || []).map((x) => [x.doc, x.n]));
  const notas = new Map(((await consultar(
    `SELECT v.cliente_id, COUNT(*)::int AS n FROM cs_tickets t JOIN cs_vinculos v ON v.id = t.vinculo_id
      WHERE v.tipo = 'cliente' AND v.cliente_id IS NOT NULL AND t.abertura >= NOW() - INTERVAL '30 days'
        AND t.nota_avaliacao <= 2 AND COALESCE(t.revisao_nota_status, 'pendente') <> 'indevida' GROUP BY v.cliente_id`, [], 'notas 30d'))
    || (await consultar(
      `SELECT v.cliente_id, COUNT(*)::int AS n FROM cs_tickets t JOIN cs_vinculos v ON v.id = t.vinculo_id
        WHERE v.tipo = 'cliente' AND v.cliente_id IS NOT NULL AND t.abertura >= NOW() - INTERVAL '30 days' AND t.nota_avaliacao <= 2 GROUP BY v.cliente_id`, [], 'notas 30d (sem revisão)'))
    || []).map((x) => [x.cliente_id, x.n]));
  const aband = new Map(((await consultar(
    `SELECT v.cliente_id, COUNT(*)::int AS n FROM gam_abandono_incidentes a JOIN cs_tickets t ON t.id = a.ticket_id JOIN cs_vinculos v ON v.id = t.vinculo_id
      WHERE v.tipo = 'cliente' AND v.cliente_id IS NOT NULL AND a.data >= CURRENT_DATE - 30 AND a.status <> 'indevida' GROUP BY v.cliente_id`, [], 'abandonos 30d')) || []).map((x) => [x.cliente_id, x.n]));

  const lista = [];
  for (const c of clientes) {
    if (!churn.ehPessoaJuridica(c.cnpj)) continue;           // só CNPJ
    const rk = r.data[c.id];
    if (!rk) continue;
    const ct = cat.data[c.id] || {};
    lista.push({
      id: c.id, nome: c.nome, cnpj: c.cnpj, grupo: c.grupo || null, unidade: c.unidade || null, entrada: c.entrada,
      categoria: ct.categoria || null, categoria_motivo: ct.motivo || null, honorario: ct.honorario != null ? ct.honorario : null,
      risco: { nivel: rk.nivel, pontos: rk.pontos, alerta: rk.alerta, parcial: rk.parcial, sem_dado: rk.sem_dado, termometros: rk.termometros, detalhes: rk.detalhes, motivos: rk.motivos },
      reclamacoes30: (insat.get(soDigitos(c.cnpj)) || 0) + (notas.get(c.id) || 0) + (aband.get(c.id) || 0),
    });
  }
  lista.sort((a, b) => (b.risco.pontos == null ? -1 : b.risco.pontos) - (a.risco.pontos == null ? -1 : a.risco.pontos) || a.nome.localeCompare(b.nome));

  const resumoRisco = { Alto: 0, 'Médio': 0, Baixo: 0, Incompleto: 0 };
  const resumoCat = { Diamante: 0, Ouro: 0, Prata: 0, Bronze: 0, sem_categoria: 0 };
  for (const c of lista) { resumoRisco[c.risco.nivel]++; if (c.categoria) resumoCat[c.categoria]++; else resumoCat.sem_categoria++; }
  const termometros = {};
  for (const t of ['financeiro', 'atendimento', 'operacional']) {
    const com = lista.filter((c) => c.risco.termometros[t] != null);
    termometros[t] = { com_dado: com.length, sem_dado: lista.length - com.length, em_alerta: com.filter((c) => c.risco.termometros[t] >= (r.config.cortes.alto)).length, medio_ou_mais: com.filter((c) => c.risco.termometros[t] >= r.config.cortes.medio).length };
  }

  const v = {
    gerado_em: new Date().toISOString(),
    config: r.config,
    totais: {
      clientes: lista.length, desconsiderados_nao_cnpj: r.desconsiderados_nao_cnpj,
      sem_reclamacao_30d: lista.filter((c) => !c.reclamacoes30).length,
      risco: resumoRisco, categorias: resumoCat, termometros, operacional_lido: r.operacional_lido,
    },
    clientes: lista,
  };
  _cache = { t: Date.now(), v };
  return v;
}

// ── Churn ────────────────────────────────────────────────────────────────────
const enxuto = (p) => ({
  ...p,
  saidas: p.saidas.map((s) => ({ id: s.id, nome: s.nome, cnpj: s.cnpj, data_entrada: s.data_entrada, data_saida: s.data_saida, tipo: s.tipo, origem: s.origem, na_base: s.na_base })),
  menos_de_90_dias: p.saidas.filter((s) => s.data_entrada && s.data_saida && churn.somarDias(s.data_entrada, 90) >= s.data_saida).length,
});

function ultimosMeses(hoje, n) {
  const [y, m] = hoje.split('-').map(Number);
  const meses = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    const ini = d.toISOString().slice(0, 10);
    const fimMes = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
    meses.push({ mes: ini.slice(0, 7), ini, fim: fimMes > hoje ? hoje : fimMes });
  }
  return meses;
}

const router = express.Router();
router.use(requireAuth, soEquipe);

router.get('/dados', async (req, res) => {
  try {
    const base = await montarBase(req.query.forcar === '1');
    const [clientesChurn, padroes] = await Promise.all([churn.carregarClientes(), churn.lerPadroes()]);
    const hoje = churn.hojeBrasilia();
    const periodos = {};
    for (const [chave, p] of Object.entries(churn.presets(hoje))) periodos[chave] = { rotulo: p.rotulo, ...enxuto(churn.calcularChurn(clientesChurn, p.ini, p.fim, padroes)) };
    const evolucao = ultimosMeses(hoje, 12).map((m) => {
      const c = churn.calcularChurn(clientesChurn, m.ini, m.fim, padroes);
      return { mes: m.mes, base: c.base, saidas: c.saidas_contadas, taxa: c.taxa };
    });
    res.json({ ...base, usuario: { nome: req.user.name, papel: req.user.role }, churn: { padroes, periodos, evolucao } });
  } catch (err) {
    console.error('[painel] GET /dados falhou:', err);
    res.status(500).json({ error: 'Erro ao montar o painel.' });
  }
});

router.get('/churn', async (req, res) => {
  try {
    const { ini, fim } = req.query;
    if (!ISO.test(ini || '') || !ISO.test(fim || '') || ini > fim) return res.status(400).json({ error: 'Informe ini e fim no formato AAAA-MM-DD, com ini <= fim.' });
    const [clientesChurn, padroes] = await Promise.all([churn.carregarClientes(), churn.lerPadroes()]);
    res.json({ rotulo: 'Período', ...enxuto(churn.calcularChurn(clientesChurn, ini, fim, padroes)) });
  } catch (err) {
    console.error('[painel] GET /churn falhou:', err);
    res.status(500).json({ error: 'Erro ao calcular o churn.' });
  }
});

/** Texto do "Próximo passo", pelo termômetro que mais pesa. */
function proximoPasso(c, extra) {
  const t = c.risco.termometros;
  const pontos = (k) => (t[k] == null ? -1 : t[k]);
  if (c.risco.nivel === 'Baixo' || c.risco.nivel === 'Incompleto') return 'Sem ação por enquanto: acompanhar nas próximas semanas.';
  const dom = ['financeiro', 'atendimento', 'operacional'].sort((a, b) => pontos(b) - pontos(a))[0];
  if (dom === 'financeiro') {
    const f = extra.financeiro[0];
    return f && f.qtd_atrasados
      ? `Combinar a regularização com o financeiro: ${f.qtd_atrasados} título(s) em atraso. Reportar o retorno do cliente na reunião de segunda.`
      : 'Conferir a situação financeira com o financeiro e reportar na reunião de segunda.';
  }
  if (dom === 'atendimento') return 'Ligar para o cliente: houve falha de atendimento (insatisfação, abandono, nota baixa ou prazo estourado). Registrar o retorno como insatisfação, se for o caso.';
  return 'Conferir com a equipe responsável as entregas atrasadas ou vencidas no Acessórias e combinar a regularização.';
}

router.get('/cliente/:id', async (req, res) => {
  try {
    const base = await montarBase(false);
    const c = base.clientes.find((x) => x.id === req.params.id);
    if (!c) return res.status(404).json({ error: 'Cliente não encontrado (o painel só mostra CNPJ ativo).' });
    const doc = soDigitos(c.cnpj);

    const financeiro = (await consultar(
      `SELECT unidade, qtd, valor_aberto::float AS valor_aberto, qtd_atrasados, valor_atrasado::float AS valor_atrasado, to_char(mais_antigo, 'YYYY-MM-DD') AS mais_antigo
         FROM financeiro_aberto WHERE regexp_replace(cnpj, '\\D', '', 'g') = $1`, [doc], 'financeiro_aberto')) || [];
    const tickets = (await consultar(
      `SELECT t.id, t.abertura, t.departamento, t.analista, t.status, t.nota_avaliacao, t.pior_status
         FROM cs_tickets t JOIN cs_vinculos v ON v.id = t.vinculo_id
        WHERE v.tipo = 'cliente' AND v.cliente_id = $1 AND t.abertura >= NOW() - INTERVAL '90 days'
        ORDER BY t.abertura DESC LIMIT 30`, [c.id], 'tickets')) || [];
    const abandonos = (await consultar(
      `SELECT a.data, a.analista, a.status FROM gam_abandono_incidentes a JOIN cs_tickets t ON t.id = a.ticket_id JOIN cs_vinculos v ON v.id = t.vinculo_id
        WHERE v.tipo = 'cliente' AND v.cliente_id = $1 AND a.data >= CURRENT_DATE - 90 AND a.status <> 'indevida' ORDER BY a.data DESC`, [c.id], 'abandonos')) || [];
    const insatisfacoes = (await consultar(
      `SELECT created_at, analista, reclamado, reclamacao, gravidade FROM insatisfacoes
        WHERE regexp_replace(cnpj, '\\D', '', 'g') = $1 AND created_at >= NOW() - INTERVAL '180 days' ORDER BY created_at DESC LIMIT 20`, [doc], 'insatisfacoes')) || [];
    const sensiveis = (await consultar(
      `SELECT created_at, analista, demonstrou, gravidade FROM clientes_sensiveis
        WHERE regexp_replace(cnpj, '\\D', '', 'g') = $1 AND created_at >= NOW() - INTERVAL '90 days' ORDER BY created_at DESC LIMIT 20`, [doc], 'sensiveis')) || [];
    const pesquisas = (await consultar(
      `SELECT created_at, nps, csat, ces, pontos FROM pesquisas
        WHERE regexp_replace(cnpj, '\\D', '', 'g') = $1 AND created_at >= NOW() - INTERVAL '180 days' ORDER BY created_at DESC LIMIT 10`, [doc], 'pesquisas')) || [];
    const entregas = ((await consultar(
      `SELECT total, atrasadas_entregues, vencidas_pendentes, atualizado_em, janela_ini, janela_fim FROM cliente_entregas_resumo WHERE doc = $1`, [doc], 'entregas')) || [])[0] || null;

    res.json({
      cliente: c,
      proximo_passo: proximoPasso(c, { financeiro }),
      financeiro, tickets, abandonos, insatisfacoes, sensiveis, pesquisas, entregas,
    });
  } catch (err) {
    console.error('[painel] GET /cliente falhou:', err);
    res.status(500).json({ error: 'Erro ao carregar a ficha do cliente.' });
  }
});

module.exports = { router, montarBase, proximoPasso, ultimosMeses, PAPEIS };
