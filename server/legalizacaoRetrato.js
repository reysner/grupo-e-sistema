'use strict';
/**
 * Retrato semanal da Legalização (alvarás, certificados e procurações): funções PURAS, testadas em
 * server/testes_legalizacao_retrato.js. Uma linha por semana (segunda a domingo); a última leitura da semana vale.
 * Alimenta a seção "Evolução" da página /legalizacao.
 */
const TIPOS = ['func', 'sanit', 'cert_pf', 'cert_pj', 'ecac', 'fgts'];
const STATUS = ['vencido', 'vencendo', 'solicitacao', 'ok', 'sem_data'];

/** Segunda-feira da semana de uma data AAAA-MM-DD. */
function semanaDe(iso) {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = dt.getUTCDay();
  dt.setUTCDate(dt.getUTCDate() - (dow === 0 ? 6 : dow - 1));
  return dt.toISOString().slice(0, 10);
}

/** O documento (func, sanit, cert_pf, cert_pj, ecac, fgts) de uma linha do painel; null se a linha não tem. */
function itemDe(l, tipo) {
  if (tipo === 'cert_pj') return l.cert && l.cert.tipo === 'pj' ? l.cert : null;
  if (tipo === 'cert_pf') return l.cert && l.cert.tipo === 'pf' ? l.cert : null;
  return l[tipo] || null;
}

/** Conta documentos por tipo e por situação a partir das linhas do painel. Um cliente pode ter vários documentos. */
function retratoDeLinhas(linhas, hoje) {
  const por_tipo = {};
  TIPOS.forEach((t) => { por_tipo[t] = { total: 0 }; STATUS.forEach((s) => { por_tipo[t][s] = 0; }); });
  const totais = { vencido: 0, vencendo: 0, solicitacao: 0, ok: 0, sem_data: 0 };
  (linhas || []).forEach((l) => {
    TIPOS.forEach((t) => {
      const i = itemDe(l, t);
      if (!i) return;
      const st = STATUS.includes(i.status) ? i.status : 'sem_data';
      por_tipo[t][st]++; por_tipo[t].total++; totais[st]++;
    });
  });
  return {
    semana: semanaDe(hoje),
    clientes: (linhas || []).length,
    vencidos: totais.vencido, vencendo: totais.vencendo, solicitacao: totais.solicitacao, em_dia: totais.ok, sem_data: totais.sem_data,
    por_tipo,
  };
}

module.exports = { semanaDe, itemDe, retratoDeLinhas, TIPOS, STATUS };
