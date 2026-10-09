'use strict';
/**
 * Período do faturamento: os 12 meses JÁ LANÇADOS (regra do Reysner, 08/10/2026). O faturamento só fica lançado logo após o dia 20,
 * então a extração roda no dia 25 (ou no 1º dia útil depois): a partir do dia 25 o último mês fechado é o mês anterior; antes do dia 25
 * é o mês retrasado. Ex.: 08/10/2026 → 09/2025 a 08/2026; 26/10/2026 → 10/2025 a 09/2026.
 */
const pad = (n) => String(n).padStart(2, '0');
function mesAnterior(ano, mes, n) { const d = new Date(Date.UTC(ano, mes - 1 - n, 1)); return { ano: d.getUTCFullYear(), mes: d.getUTCMonth() + 1 }; }
function ultimoDia(ano, mes) { return new Date(Date.UTC(ano, mes, 0)).getUTCDate(); }

/** hoje: { ano, mes, dia } (data de Brasília). Devolve { ini:'AAAA-MM', fim:'AAAA-MM', competIni:'MM/AAAA', competFim:'MM/AAAA', dataIni:'01/MM/AAAA', dataFim:'DD/MM/AAAA' }. */
function periodoDeExtracao(hoje) {
  const fim = mesAnterior(hoje.ano, hoje.mes, hoje.dia >= 25 ? 1 : 2);
  const ini = mesAnterior(fim.ano, fim.mes, 11);
  return {
    ini: `${ini.ano}-${pad(ini.mes)}`, fim: `${fim.ano}-${pad(fim.mes)}`,
    competIni: `${pad(ini.mes)}/${ini.ano}`, competFim: `${pad(fim.mes)}/${fim.ano}`,
    dataIni: `01/${pad(ini.mes)}/${ini.ano}`, dataFim: `${pad(ultimoDia(fim.ano, fim.mes))}/${pad(fim.mes)}/${fim.ano}`,
  };
}
function hojeBrasilia(agora = new Date()) {
  const [ano, mes, dia] = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(agora).split('-').map(Number);
  return { ano, mes, dia };
}
module.exports = { periodoDeExtracao, hojeBrasilia };
