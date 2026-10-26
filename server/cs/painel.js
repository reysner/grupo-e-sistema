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
 *   GET /api/cs/painel/cliente/:id    -> ficha do cliente (por que está em risco, títulos, atendimentos, entregas, e-mails)
 *   GET /api/cs/painel/atendimentos   -> módulo Atendimento: clientes ativos com atendimentos e e-mails dos últimos 180 dias
 *   GET /api/cs/painel/atendimento/:id -> atendimentos de um cliente (180 dias) e e-mails por destinatário
 */
const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../auth');
const risco = require('./risco');
const categorias = require('./categorias');
const churn = require('./churnSaidas');
const questor = require('./questorDados');
const acessorias = require('../acessoriasClient');

const PAPEIS = ['administrador', 'usuario'];
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const soDigitos = (s) => String(s || '').replace(/\D/g, '');

/**
 * Perfil "Usuário" vê o painel SEM valores em R$ (decisão do Reysner, 08/10/2026): honorário, soma do grupo e valores de títulos saem do
 * servidor ocultos — quem decide é o servidor, não o navegador. Só o administrador recebe os valores (e pode ocultá-los na tela, para apresentações).
 */
const veValores = (role) => role === 'administrador';
const OCULTO = 'R$ ••••';
function mascararMotivo(m) { return m ? String(m).replace(/(honorário |empresas: )R\$ [\d.]+,\d{2}/g, '$1' + OCULTO) : m; }
function mascararBase(base) {
  const oculta = (c) => ({ ...c, honorario: null, categoria_motivo: mascararMotivo(c.categoria_motivo), questor: c.questor ? { ...c.questor, faturamento: null } : null });
  return { ...base, valores_ocultos: true, clientes: base.clientes.map(oculta), clientes_outros: (base.clientes_outros || []).map(oculta) };
}
function mascararFicha(ficha) {
  return { ...ficha, cliente: { ...ficha.cliente, honorario: null, categoria_motivo: mascararMotivo(ficha.cliente.categoria_motivo), questor: ficha.cliente.questor ? { ...ficha.cliente.questor, faturamento: null } : null }, valores_ocultos: true,
    financeiro: (ficha.financeiro || []).map((f) => ({ ...f, valor_aberto: null, valor_atrasado: null })),
    titulos: (ficha.titulos || []).map((t) => ({ ...t, valor_aberto: null, valor_doc: null })) };
}

function soEquipe(req, res, next) {
  if (!PAPEIS.includes(req.user && req.user.role) && !(req.user && req.user.acessoCs)) return res.status(403).json({ error: 'Acesso restrito à equipe do Sucesso do Cliente.' });
  next();
}

/** Consulta tolerante: se uma tabela opcional não existir, o painel segue sem ela. */
async function consultar(sql, params = [], rotulo = '') {
  try { return (await pool.query(sql, params)).rows; }
  catch (e) { console.warn(`[painel] consulta opcional falhou (${rotulo}):`, e.message); return null; }
}

// ── Cache curto: a página faz poucas chamadas seguidas e o cálculo percorre a carteira inteira ──
let _cache = null, _emAndamento = null, _geracao = 0;
const TTL_MS = 60 * 1000;
/** Esquece o cálculo guardado: a próxima chamada refaz a carteira (usado quando uma ocorrência de Qualidade é excluída, cancelada, reaberta ou encerrada). */
function invalidarCache() { _cache = null; _emAndamento = null; _geracao++; }

// A ficha de um cliente aceita uma base mais velha (a lista já foi calculada ao abrir o painel); abrir a ficha não deve recalcular a carteira.
const TTL_FICHA_MS = 10 * 60 * 1000;

async function montarBase(forcar, ttl = TTL_MS) {
  if (!forcar && _cache && Date.now() - _cache.t < ttl) return _cache.v;
  if (!forcar && _emAndamento) return _emAndamento;   // chamadas ao mesmo tempo dividem o mesmo cálculo (a carteira inteira)
  const p = calcularBase(_geracao).finally(() => { if (_emAndamento === p) _emAndamento = null; });
  _emAndamento = p;
  return p;
}
async function calcularBase(geracao) {

  const [r, cat, clientes] = await Promise.all([
    risco.calcularTodos({ detalhes: true }),
    categorias.calcularCategorias(),
    consultar(`SELECT c.id, c.nome_empresa AS nome, c.cnpj, c.grupo_empresas AS grupo, c.unidade,
                      to_char(c.data_entrada, 'YYYY-MM-DD') AS entrada
                 FROM clientes c WHERE c.status = 'ativo'`, [], 'clientes').then((x) => x || []),
  ]);

  // Reclamações dos últimos 30 dias por cliente (insatisfação registrada + nota baixa, depois da revisão da Gamificação)
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

  // Quando a lista de contratos suspensos do Omie foi lida pela última vez (rotina de segunda de manhã).
  const suspLidos = ((await consultar(`SELECT to_char(MAX(atualizado_em) AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS d FROM omie_contratos_suspensos`, [], 'suspensos lidos em')) || [])[0];

  const q = await questor.carregar();   // faturamento 12 meses e funcionários (Questor)

  // Regime tributário (Gestão de Clientes): o registro mais recente por CNPJ. Tolerante: se a coluna/tabela não existir, segue sem regime.
  const regimes = new Map(((await consultar(
    `SELECT DISTINCT ON (regexp_replace(cnpj, '\\D', '', 'g')) regexp_replace(cnpj, '\\D', '', 'g') AS doc, regime_tributario AS regime
       FROM gestao_clientes WHERE regime_tributario IS NOT NULL AND regime_tributario <> '' ORDER BY regexp_replace(cnpj, '\\D', '', 'g'), created_at DESC NULLS LAST`, [], 'regime tributário')) || []).map((x) => [x.doc, x.regime]));

  const lista = [];
  for (const c of clientes) {
    if (!churn.ehPessoaJuridica(c.cnpj)) continue;           // só CNPJ
    const rk = r.data[c.id];
    if (!rk) continue;
    const ct = cat.data[c.id] || {};
    lista.push({
      id: c.id, nome: c.nome, cnpj: c.cnpj, grupo: c.grupo || null, unidade: c.unidade || null, entrada: c.entrada,
      categoria: ct.categoria || null, categoria_motivo: ct.motivo || null, honorario: ct.honorario != null ? ct.honorario : null,
      risco: { nivel: rk.nivel, pontos: rk.pontos, alerta: rk.alerta, suspenso: !!rk.suspenso, parcial: rk.parcial, sem_dado: rk.sem_dado, termometros: rk.termometros, detalhes: rk.detalhes, motivos: rk.motivos },
      questor: q.dados.has(soDigitos(c.cnpj)) ? q.dados.get(soDigitos(c.cnpj)) : null,
      regime: regimes.get(soDigitos(c.cnpj)) || null,
      reclamacoes30: (insat.get(soDigitos(c.cnpj)) || 0) + (notas.get(c.id) || 0),
    });
  }
  lista.sort((a, b) => (b.risco.pontos == null ? -1 : b.risco.pontos) - (a.risco.pontos == null ? -1 : a.risco.pontos) || a.nome.localeCompare(b.nome));

  // Só a Análise Inteligente lista também CPF, CAEPF e CNO (pedido do Reysner, 09/10/2026, com filtro por tipo de documento);
  // o resto do painel (risco, churn, categorias) continua só CNPJ. Esses clientes não têm termômetros de risco.
  lista.forEach((c) => { c.tipo_doc = 'CNPJ'; });
  const outros = [];
  for (const c of clientes) {
    const tipo = churn.tipoDocumento(c.cnpj);
    if (!tipo || tipo === 'CNPJ') continue;                      // sem documento fica de fora
    const ct = cat.data[c.id] || {}; const d = soDigitos(c.cnpj);
    outros.push({ id: c.id, nome: c.nome, cnpj: c.cnpj, tipo_doc: tipo, grupo: c.grupo || null, unidade: c.unidade || null, entrada: c.entrada,
      categoria: ct.categoria || null, honorario: ct.honorario != null ? ct.honorario : null, questor: q.dados.has(d) ? q.dados.get(d) : null, regime: regimes.get(d) || null });
  }
  outros.sort((a, b) => a.nome.localeCompare(b.nome));

  const resumoRisco = { Alto: 0, 'Médio': 0, Baixo: 0, Incompleto: 0, Suspenso: 0 };   // Suspenso não conta em risco (aparece à parte)
  const resumoCat = { Diamante: 0, Ouro: 0, Prata: 0, Bronze: 0, sem_categoria: 0 };
  for (const c of lista) { resumoRisco[c.risco.nivel]++; if (c.categoria) resumoCat[c.categoria]++; else resumoCat.sem_categoria++; }
  const termometros = {};
  for (const t of ['financeiro', 'atendimento', 'operacional', 'tratativas']) {
    const com = lista.filter((c) => c.risco.termometros[t] != null && !c.risco.suspenso);   // suspensos não entram nas estatísticas de risco
    termometros[t] = { com_dado: com.length, sem_dado: lista.length - com.length, em_alerta: com.filter((c) => c.risco.termometros[t] >= (r.config.cortes.alto)).length, medio_ou_mais: com.filter((c) => c.risco.termometros[t] >= r.config.cortes.medio).length };
  }

  const v = {
    gerado_em: new Date().toISOString(),
    config: r.config,
    totais: {
      clientes: lista.length, desconsiderados_nao_cnpj: r.desconsiderados_nao_cnpj,
      sem_reclamacao_30d: lista.filter((c) => !c.reclamacoes30).length,
      risco: resumoRisco, suspensos: lista.filter((c) => c.risco.suspenso).length, suspensos_lidos_em: suspLidos && suspLidos.d ? suspLidos.d : null, questor_periodo: q.periodo, questor_lido_em: q.lido_em, categorias: resumoCat, termometros, operacional_lido: r.operacional_lido,
    },
    clientes: lista,
    clientes_outros: outros,
  };
  if (geracao === _geracao) _cache = { t: Date.now(), v };   // se o cache foi invalidado no meio do cálculo, não guarda o resultado velho
  return v;
}

// ── Churn ────────────────────────────────────────────────────────────────────
const enxuto = (p) => ({
  ...p,
  saidas: p.saidas.map((s) => ({ id: s.id, nome: s.nome, cnpj: s.cnpj, data_entrada: s.data_entrada, data_saida: s.data_saida, tipo: s.tipo, origem: s.origem, na_base: s.na_base, motivo_churn: s.motivo_churn || null, motivo_saida: s.motivo_saida || null })),
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
    const visivel = veValores(req.user.role) ? base : mascararBase(base);
    res.json({ ...visivel, usuario: { nome: req.user.name, papel: req.user.role }, churn: { padroes, periodos, evolucao } });
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
  if (c.risco.suspenso) return 'Contrato suspenso no Omie: a ação é de cobrança. Combinar a regularização com o financeiro e, se o cliente pagar, reativar o contrato no Omie para retomar as entregas.';
  const dom = ['financeiro', 'atendimento', 'operacional', 'tratativas'].sort((a, b) => pontos(b) - pontos(a))[0];
  if (dom === 'financeiro') {
    const f = extra.financeiro[0];
    return f && f.qtd_atrasados
      ? `Combinar a regularização com o financeiro: ${f.qtd_atrasados} título(s) em atraso. Reportar o retorno do cliente na reunião de segunda.`
      : 'Conferir a situação financeira com o financeiro e reportar na reunião de segunda.';
  }
  if (dom === 'atendimento') return 'Ligar para o cliente: houve falha de atendimento (insatisfação, nota baixa ou prazo estourado). Registrar o retorno como insatisfação, se for o caso.';
  if (dom === 'tratativas') return 'Cobrar o responsável pela tratativa: há ocorrência de qualidade em aberto (erro, multa, reclamação, atraso...). Conferir o prazo no módulo Qualidade e combinar o retorno ao cliente.';
  return 'Conferir com a equipe responsável as entregas atrasadas ou vencidas no Acessórias e combinar a regularização.';
}

/** Tickets do Zappy por cliente nos últimos N dias (com a revisão da nota da Gamificação, se a coluna existir). */
async function ticketsPorCliente(dias) {
  const sql = (comRevisao) => `SELECT v.cliente_id, COUNT(*)::int AS atendimentos,
        COUNT(*) FILTER (WHERE t.pior_status = 'vermelho')::int AS sla_vermelho,
        COUNT(*) FILTER (WHERE t.nota_avaliacao <= 2${comRevisao ? " AND COALESCE(t.revisao_nota_status, 'pendente') <> 'indevida'" : ''})::int AS notas_baixas,
        to_char(MAX(t.abertura) AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS ultimo
      FROM cs_tickets t JOIN cs_vinculos v ON v.id = t.vinculo_id
     WHERE v.tipo = 'cliente' AND v.cliente_id IS NOT NULL AND t.abertura >= NOW() - ($1 || ' days')::interval
     GROUP BY v.cliente_id`;
  const linhas = (await consultar(sql(true), [String(dias)], 'atendimentos')) || (await consultar(sql(false), [String(dias)], 'atendimentos (sem revisão)')) || [];
  return new Map(linhas.map((r) => [r.cliente_id, r]));
}

const JANELA_ATENDIMENTO = 180;

/** Módulo Atendimento: uma linha por cliente ativo, com os atendimentos do Zappy e os e-mails (recebidos e sem resposta, por destinatário). */
router.get('/atendimentos', async (req, res) => {
  try {
    const base = await montarBase(false, TTL_FICHA_MS);
    const tk = await ticketsPorCliente(JANELA_ATENDIMENTO);
    const emRows = (await consultar('SELECT cnpj, recebidos, sem_resposta, destinatarios, comp_recebidos, comp_sem, comp_destinatarios FROM cs_email_atendimento', [], 'email atendimento')) || [];
    const em = new Map(emRows.map((r) => [r.cnpj, r]));
    const leitura = ((await consultar('SELECT lido_em, janela_dias FROM cs_email_atendimento_leitura WHERE id = 1', [], 'email atendimento leitura')) || [])[0] || null;
    const clientes = base.clientes.concat(base.clientes_outros || []).map((c) => {
      const t = tk.get(c.id) || {}, e = em.get(soDigitos(c.cnpj));
      return {
        id: c.id, nome: c.nome, cnpj: c.cnpj, tipo_doc: c.tipo_doc || 'CNPJ', categoria: c.categoria || null, grupo: c.grupo || null,
        atendimentos: t.atendimentos || 0, sla_vermelho: t.sla_vermelho || 0, notas_baixas: t.notas_baixas || 0, ultimo: t.ultimo || null,
        email: e ? { recebidos: e.recebidos, sem_resposta: e.sem_resposta, destinatarios: e.destinatarios, comp_recebidos: e.comp_recebidos || 0, comp_sem: e.comp_sem || 0, comp_destinatarios: e.comp_destinatarios || [] } : null,
      };
    });
    res.json({ janela_dias: JANELA_ATENDIMENTO, email_lido_em: leitura ? leitura.lido_em : null, email_janela_dias: leitura ? leitura.janela_dias : null, clientes });
  } catch (err) {
    console.error('[painel] GET /atendimentos falhou:', err);
    res.status(500).json({ error: 'Erro ao montar o módulo Atendimento.' });
  }
});

/** Detalhe de um cliente no módulo Atendimento: os atendimentos dos últimos 180 dias (data, setor, atendente, nota, SLA) e os e-mails por destinatário. */
router.get('/atendimento/:id', async (req, res) => {
  try {
    const base = await montarBase(false, TTL_FICHA_MS);
    const c = base.clientes.concat(base.clientes_outros || []).find((x) => x.id === req.params.id);
    if (!c) return res.status(404).json({ error: 'Cliente não encontrado (o painel só mostra clientes ativos).' });
    const doc = soDigitos(c.cnpj);
    const tickets = (await consultar(
      `SELECT t.id, t.abertura, t.departamento, t.analista, t.status, t.nota_avaliacao, t.pior_status
         FROM cs_tickets t JOIN cs_vinculos v ON v.id = t.vinculo_id
        WHERE v.tipo = 'cliente' AND v.cliente_id = $1 AND t.abertura >= NOW() - INTERVAL '180 days'
        ORDER BY t.abertura DESC LIMIT 500`, [c.id], 'tickets 180d')) || [];
    const e = ((await consultar('SELECT recebidos, sem_resposta, destinatarios, comp_recebidos, comp_sem, comp_destinatarios FROM cs_email_atendimento WHERE cnpj = $1', [doc], 'email atendimento cliente')) || [])[0] || null;
    const leitura = ((await consultar('SELECT lido_em, janela_dias FROM cs_email_atendimento_leitura WHERE id = 1', [], 'email atendimento leitura')) || [])[0] || null;
    res.json({
      cliente: { id: c.id, nome: c.nome, cnpj: c.cnpj, grupo: c.grupo || null, unidade: c.unidade || null, entrada: c.entrada, categoria: c.categoria || null },
      janela_dias: JANELA_ATENDIMENTO, tickets,
      email: e ? { recebidos: e.recebidos, sem_resposta: e.sem_resposta, destinatarios: e.destinatarios, comp_recebidos: e.comp_recebidos || 0, comp_sem: e.comp_sem || 0, comp_destinatarios: e.comp_destinatarios || [] } : null,
      email_lido_em: leitura ? leitura.lido_em : null, email_janela_dias: leitura ? leitura.janela_dias : null,
    });
  } catch (err) {
    console.error('[painel] GET /atendimento/:id falhou:', err);
    res.status(500).json({ error: 'Erro ao carregar o atendimento do cliente.' });
  }
});

router.get('/cliente/:id', async (req, res) => {
  try {
    const base = await montarBase(false, TTL_FICHA_MS);
    const c = base.clientes.find((x) => x.id === req.params.id);
    if (!c) return res.status(404).json({ error: 'Cliente não encontrado (o painel só mostra CNPJ ativo).' });
    const doc = soDigitos(c.cnpj);

    const financeiro = (await consultar(
      `SELECT unidade, qtd, valor_aberto::float AS valor_aberto, qtd_atrasados, valor_atrasado::float AS valor_atrasado, to_char(mais_antigo, 'YYYY-MM-DD') AS mais_antigo
         FROM financeiro_aberto WHERE regexp_replace(cnpj, '\\D', '', 'g') = $1`, [doc], 'financeiro_aberto')) || [];
    // os títulos em aberto, um a um (lidos do Omie pela rotina do Financeiro); tolerante: sem a tabela ou sem leitura, a lista vem vazia
    const titulos = (await consultar(
      `SELECT unidade, to_char(vencimento, 'YYYY-MM-DD') AS venc, valor_aberto::float AS valor_aberto, valor_doc::float AS valor_doc, situacao AS sit,
              to_char(atualizado_em AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS lido
         FROM financeiro_titulos WHERE regexp_replace(cnpj, '\\D', '', 'g') = $1 ORDER BY vencimento ASC, unidade`, [doc], 'financeiro_titulos')) || [];
    const tickets = (await consultar(
      `SELECT t.id, t.abertura, t.departamento, t.analista, t.status, t.nota_avaliacao, t.pior_status
         FROM cs_tickets t JOIN cs_vinculos v ON v.id = t.vinculo_id
        WHERE v.tipo = 'cliente' AND v.cliente_id = $1 AND t.abertura >= NOW() - INTERVAL '90 days'
        ORDER BY t.abertura DESC LIMIT 30`, [c.id], 'tickets')) || [];
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
    // e-mails: pedidos esperando resposta (leitura semanal, 14 dias) e o histórico de 180 dias; ausentes se o job ainda não rodou
    const emailSinais = ((await consultar(
      `SELECT mensagens_recebidas, aguardando_4h, aguardando_24h, aguardando_48h, aguardando_7d, aguardando_compartilhado, mais_antigo_h, provaveis_encerramentos FROM cs_email_sinais WHERE cnpj = $1`, [doc], 'email sinais')) || [])[0] || null;
    const emailHist = ((await consultar('SELECT recebidos, sem_resposta, destinatarios FROM cs_email_atendimento WHERE cnpj = $1', [doc], 'email atendimento')) || [])[0] || null;

    const ficha = { cliente: c, proximo_passo: proximoPasso(c, { financeiro }), financeiro, titulos, tickets, insatisfacoes, sensiveis, pesquisas, entregas, emails: (emailSinais || emailHist) ? { sinais: emailSinais, historico: emailHist } : null };
    res.json(veValores(req.user.role) ? ficha : mascararFicha(ficha));
  } catch (err) {
    console.error('[painel] GET /cliente falhou:', err);
    res.status(500).json({ error: 'Erro ao carregar a ficha do cliente.' });
  }
});

/**
 * Seção "Acessórias" da ficha: quais obrigações estão em aberto (venceram sem entrega) ou foram entregues com atraso nos últimos 90 dias.
 * A lista vem do Acessórias na hora de abrir a ficha (o painel só guarda os totais); só entram as entregas que chegam ao cliente.
 */
router.get('/cliente/:id/acessorias', async (req, res) => {
  try {
    const base = await montarBase(false, TTL_FICHA_MS);
    const c = base.clientes.find((x) => x.id === req.params.id);
    if (!c) return res.status(404).json({ error: 'Cliente não encontrado (o painel só mostra CNPJ ativo).' });
    const token = process.env.ACESSORIAS_API_TOKEN;
    if (!token) return res.status(503).json({ error: 'A leitura do Acessórias não está configurada.' });
    const hoje = churn.hojeBrasilia();
    const lista = await acessorias.listarEntregasEmpresa(c.cnpj, { token, ini: churn.somarDias(hoje, -90), fim: hoje });
    res.json({ janela_dias: 90, consultado_em: new Date().toISOString(), suspenso: !!(c.risco && c.risco.suspenso), itens: risco.detalharEntregas(lista, hoje) });
  } catch (err) {
    console.error('[painel] GET /cliente/:id/acessorias falhou:', err.message);
    res.status(502).json({ error: 'Não foi possível consultar o Acessórias agora.' });
  }
});

module.exports = { router, invalidarCache, montarBase, proximoPasso, ultimosMeses, PAPEIS, mascararBase, mascararFicha, mascararMotivo, veValores };
