'use strict';
/**
 * Período do faturamento: os 12 meses JÁ LANÇADOS (regra do Reysner, 08/10/2026, reconfirmada em 26/10/2026). O faturamento só fica lançado
 * logo após o dia 20, então a extração mensal roda às 09:00 do 1º dia útil a partir do dia 25: dali em diante o último mês fechado é o mês
 * anterior; antes do dia 25 é o retrasado. Ex.: 08/10/2026 → 09/2025 a 08/2026; 26/10/2026 → 10/2025 a 09/2026; 25/11/2026 → 11/2025 a 10/2026.
 */
const pad = (n) => String(n).padStart(2, '0');
function mesAnterior(ano, mes, n) { const d = new Date(Date.UTC(ano, mes - 1 - n, 1)); return { ano: d.getUTCFullYear(), mes: d.getUTCMonth() + 1 }; }
function ultimoDia(ano, mes) { return new Date(Date.UTC(ano, mes, 0)).getUTCDate(); }

/** Feriados nacionais (fixos + Paixão de Cristo e Corpus Christi, pela Páscoa) no formato 'AAAA-MM-DD'. Carnaval é ponto facultativo: conta como útil. */
function feriadosNacionais(ano) {
  const a = ano % 19, b = Math.floor(ano / 100), c = ano % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const pascoa = Date.UTC(ano, Math.floor((h + l - 7 * m + 114) / 31) - 1, ((h + l - 7 * m + 114) % 31) + 1);
  const iso = (t) => new Date(t).toISOString().slice(0, 10);
  const moveis = [iso(pascoa - 2 * 86400000), iso(pascoa + 60 * 86400000)];
  return new Set(['01-01', '04-21', '05-01', '09-07', '10-12', '11-02', '11-15', '11-20', '12-25'].map((md) => `${ano}-${md}`).concat(moveis));
}

/** 1º dia útil (seg–sex, fora de feriado nacional) do mês a partir do dia `aPartirDe`: número do dia (pode passar do fim do mês). */
function diaDaExtracao(ano, mes, aPartirDe = 25) {
  const feriados = feriadosNacionais(ano);
  for (let dia = aPartirDe; ; dia++) {
    const sem = new Date(Date.UTC(ano, mes - 1, dia)).getUTCDay();
    if (sem !== 0 && sem !== 6 && !feriados.has(`${ano}-${pad(mes)}-${pad(dia)}`)) return dia;
  }
}

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
module.exports = { periodoDeExtracao, hojeBrasilia, diaDaExtracao, feriadosNacionais };
