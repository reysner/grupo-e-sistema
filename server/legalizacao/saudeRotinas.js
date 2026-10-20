'use strict';

/**
 * Decide se a última rodada de uma rotina da Legalização (consulta às prefeituras, leitura das pastas, CertiSeguro, procurações) FALHOU
 * e devolve o motivo em português para o aviso do sino — ou null se a rodada foi normal.
 * `r` = uma linha de situacaoRotinas(): { status, ultima: { total, ok, falhas, resumo } }.
 */
function motivoFalhaRotina(r) {
  const u = r && r.ultima;
  if (!u) return null;
  const resumo = u.resumo || {};
  if (resumo.erro) return String(resumo.erro).replace(/\s+/g, ' ').slice(0, 200);
  if (resumo.interrompida) return 'a rodada parou no meio (muitas falhas seguidas — pode ser bloqueio do portal)';
  if (r.status === 'com_falhas' || (u.total === 0 && u.falhas > 0)) return `${u.falhas} falha(s) em ${u.total} consulta(s)`;
  return null;
}

module.exports = { motivoFalhaRotina };
