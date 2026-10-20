'use strict';

/**
 * "Não possui": quando a lista de certificados (CertiSeguro) ou de procurações (e-CAC / FGTS Digital) foi lida POR COMPLETO há pouco tempo,
 * cliente que não aparece nela simplesmente NÃO TEM o documento — isso não é "Sem data" (indefinido). Pedido do Reysner, 20/10/2026.
 * `flags` = { cert, ecac, fgts }: true quando a última leitura completa é recente (≤ 15 dias) e sem falhas.
 * Muda a linha do painel no lugar e a devolve.
 *   - procuração e-CAC/FGTS sem data (inclusive as zeradas por já não constarem no portal) → 'nao_possui';
 *   - certificado PJ sem data e SEM registro (sem id) → 'nao_possui' (registro manual sem data continua "Sem data").
 */
function marcarNaoPossui(l, flags) {
  if (!l || !flags) return l;
  if (flags.ecac && l.ecac && l.ecac.status === 'sem_data') l.ecac.status = 'nao_possui';
  if (flags.fgts && l.fgts && l.fgts.status === 'sem_data') l.fgts.status = 'nao_possui';
  if (flags.cert && l.cert && l.cert.tipo === 'pj' && l.cert.status === 'sem_data' && !l.cert.id) l.cert.status = 'nao_possui';
  return l;
}

module.exports = { marcarNaoPossui };
