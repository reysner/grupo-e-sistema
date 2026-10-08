'use strict';
/**
 * Risco de perda do cliente — regras de cálculo (Etapa 3 do painel de Risco, alinhamento Reysner × Larissa 05/10/2026).
 * Lógica PURA (sem banco, sem rede) pra poder testar; a leitura dos dados fica em risco.js.
 *
 * Três termômetros, cada um de 0 a 100 (quanto maior, pior):
 *   - Financeiro:   inadimplência (títulos em atraso no Omie, inadimplente crônico);
 *   - Atendimento:  insatisfações registradas, clientes sensíveis, pesquisas, notas baixas e SLA vermelho no Zappy;
 *   - Operacional:  entregas do Acessórias atrasadas ou vencidas sem entrega.
 * Risco = média ponderada dos termômetros que TÊM dado (pesos iniciais iguais, "vamos fixar mais adiante").
 * Dado ausente não é presumido: termômetro sem dado fica de fora e o risco é marcado como parcial.
 */

const PESOS_PADRAO = { financeiro: 1, atendimento: 1, operacional: 1 };
const CORTES_PADRAO = { medio: 30, alto: 60 };
const ALERTA_TERMOMETRO = 75; // um termômetro sozinho nessa faixa já puxa o cliente pra, no mínimo, Médio
const TERMOMETROS = ['financeiro', 'atendimento', 'operacional'];

const PESO_GRAVIDADE_INSATISFACAO = { 'muito alta': 40, alta: 30, media: 20, baixa: 10, 'muito baixa': 5 };
const PESO_GRAVIDADE_SENSIVEL = { 'muito alta': 30, alta: 22, media: 15, baixa: 8, 'muito baixa': 4 };

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const limitar = (v) => Math.max(0, Math.min(100, Math.round(v)));
const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;

/** Diferença em dias entre duas datas AAAA-MM-DD (b - a). */
function diasEntre(a, b) {
  const [ya, ma, da] = String(a).slice(0, 10).split('-').map(Number);
  const [yb, mb, db] = String(b).slice(0, 10).split('-').map(Number);
  return Math.round((Date.UTC(yb, mb - 1, db) - Date.UTC(ya, ma - 1, da)) / 86400000);
}

/**
 * Financeiro. entrada: { temDado, qtdAtrasados, valorAtrasado, maisAntigo:'AAAA-MM-DD'|null, cronico, hoje }.
 * Sem dado do Omie → pontos null.
 */
function termometroFinanceiro(e) {
  if (!e || !e.temDado) return { pontos: null, detalhe: ['Sem dado do Financeiro (cliente fora da leitura do Omie)'] };
  const qtd = Number(e.qtdAtrasados) || 0;
  const detalhe = [];
  let pontos = 0;
  if (qtd > 0) {
    const dias = e.maisAntigo ? Math.max(0, diasEntre(e.maisAntigo, e.hoje)) : 0;
    pontos = dias > 90 ? 90 : dias > 60 ? 75 : dias > 30 ? 60 : dias > 15 ? 40 : 25;
    if (qtd >= 3) pontos += 10;
    detalhe.push(`Inadimplente: ${plural(qtd, 'título', 'títulos')} em atraso${e.maisAntigo ? `, o mais antigo há ${dias} dias` : ''}`);
  } else {
    detalhe.push('Em dia no Financeiro');
  }
  if (e.cronico) { pontos = Math.max(pontos, 70); detalhe.push('Marcado como inadimplente crônico'); }
  return { pontos: limitar(pontos), detalhe };
}

/**
 * Atendimento. entrada: {
 *   insatisfacoes:[{gravidade, dias}], sensiveis:[{gravidade, dias}], notasBaixas:n (≤2 nos últimos 90d),
 *   slaVermelho:n (tickets com SLA vermelho nos últimos 90d), abandonos:n (cliente sem resposta, últimos 90d),
 *   detratores:n (NPS ≤ 6 nos últimos 180d), tickets90:n }
 * Notas baixas, SLA vermelho e abandonos chegam JÁ DEPOIS da revisão da Gamificação (o que foi marcado "indevida" não entra).
 * Sempre tem dado: ausência de ocorrências = 0 pontos.
 */
function termometroAtendimento(e) {
  const x = e || {};
  const detalhe = [];
  let pontos = 0;

  const ins = (x.insatisfacoes || []).filter((i) => i.dias <= 180);
  let pIns = 0;
  ins.forEach((i) => { pIns += (PESO_GRAVIDADE_INSATISFACAO[norm(i.gravidade)] ?? 15) * (i.dias <= 90 ? 1 : 0.5); });
  if (ins.length) { pontos += pIns; detalhe.push(`${plural(ins.length, 'insatisfação registrada', 'insatisfações registradas')} nos últimos 180 dias`); }

  const sen = (x.sensiveis || []).filter((i) => i.dias <= 90);
  let pSen = 0;
  sen.forEach((i) => { pSen += PESO_GRAVIDADE_SENSIVEL[norm(i.gravidade)] ?? 12; });
  if (sen.length) { pontos += pSen; detalhe.push(`Cliente sensível: ${plural(sen.length, 'registro', 'registros')} nos últimos 90 dias`); }

  const notas = Number(x.notasBaixas) || 0;
  if (notas) { pontos += notas * 20; detalhe.push(`${plural(notas, 'nota baixa', 'notas baixas')} (até 2) no atendimento nos últimos 90 dias`); }

  const sla = Number(x.slaVermelho) || 0;
  if (sla) { pontos += Math.min(20, sla * 5); detalhe.push(`${plural(sla, 'ticket', 'tickets')} com SLA vermelho nos últimos 90 dias`); }

  const aband = Number(x.abandonos) || 0;
  if (aband) { pontos += Math.min(30, aband * 15); detalhe.push(`${plural(aband, 'abandono de atendimento', 'abandonos de atendimento')} (cliente ficou sem resposta) nos últimos 90 dias`); }

  const det = Number(x.detratores) || 0;
  if (det) { pontos += Math.min(30, det * 15); detalhe.push(`${plural(det, 'pesquisa de detrator', 'pesquisas de detrator')} (NPS até 6) nos últimos 180 dias`); }

  if (!detalhe.length) detalhe.push(x.tickets90 ? 'Sem ocorrências no atendimento' : 'Sem atendimentos nem ocorrências nos últimos 90 dias');
  return { pontos: limitar(pontos), detalhe };
}

/**
 * Operacional. entrada: { temDado, total, atrasadasEntregues, vencidasPendentes, suspenso } (entregas com prazo nos últimos 90 dias).
 * Taxa de problema = (entregues com atraso + vencidas sem entrega) ÷ total; 50% de problema já é 100 pontos.
 * Decisões do Reysner (08/10/2026):
 *  - empresa SUSPENSA por falta de pagamento (TAG no Acessórias): o escritório não entrega, então o atraso é efeito da
 *    inadimplência, que o Financeiro já mede. Operacional fica sem dado (não conta duas vezes) e o painel mostra o selo "Suspenso";
 *  - amostra mínima: com menos de MIN_ENTREGAS_OPERACIONAL entregas ("1 de 2") a taxa não diz nada → sem dado.
 */
const MIN_ENTREGAS_OPERACIONAL = 5;
// Nome da TAG de suspensão no Acessórias ("SUSPENSÃO DOS SERVIÇOS POR FALTA DE PAGAMENTO"). Mesmo padrão no SQL (~*) e no JS.
const PADRAO_TAG_SUSPENSAO = 'suspens.o.*servi.os';
const REGEX_TAG_SUSPENSAO = new RegExp(PADRAO_TAG_SUSPENSAO, 'i');

function termometroOperacional(e) {
  if (e && e.suspenso) return { pontos: null, detalhe: ['Serviços suspensos por falta de pagamento: as entregas não entram no Operacional (o atraso já aparece no Financeiro)'] };
  if (!e || !e.temDado || !(Number(e.total) > 0)) return { pontos: null, detalhe: ['Sem dado de entregas do Acessórias'] };
  if (Number(e.total) < MIN_ENTREGAS_OPERACIONAL) {
    return { pontos: null, detalhe: [`Só ${plural(Number(e.total), 'entrega', 'entregas')} nos últimos 90 dias: poucas para avaliar (mínimo ${MIN_ENTREGAS_OPERACIONAL})`] };
  }
  const problema = (Number(e.atrasadasEntregues) || 0) + (Number(e.vencidasPendentes) || 0);
  const taxa = problema / Number(e.total);
  const detalhe = problema
    ? [`${problema} de ${e.total} entregas com problema (${e.atrasadasEntregues || 0} entregues com atraso, ${e.vencidasPendentes || 0} vencidas sem entrega)`]
    : [`${e.total} entregas no prazo`];
  return { pontos: limitar(taxa * 200), detalhe };
}

/** Junta os três termômetros. pesos/cortes opcionais (config do admin). */
function calcularRisco(termometros, pesos = PESOS_PADRAO, cortes = CORTES_PADRAO) {
  const usados = TERMOMETROS.filter((t) => termometros[t] && termometros[t].pontos != null && (pesos[t] ?? 1) > 0);
  const semDado = TERMOMETROS.filter((t) => !termometros[t] || termometros[t].pontos == null);
  if (!usados.length) return { pontos: null, nivel: 'Incompleto', parcial: true, sem_dado: semDado, alerta: false, motivos: [], termometros };

  const somaPesos = usados.reduce((s, t) => s + (pesos[t] ?? 1), 0);
  const pontos = limitar(usados.reduce((s, t) => s + termometros[t].pontos * (pesos[t] ?? 1), 0) / somaPesos);
  const alerta = usados.some((t) => termometros[t].pontos >= ALERTA_TERMOMETRO);
  let nivel = pontos >= cortes.alto ? 'Alto' : pontos >= cortes.medio ? 'Médio' : 'Baixo';
  if (alerta && nivel === 'Baixo') nivel = 'Médio';

  // motivos: detalhes dos termômetros que pesam, do mais pontuado pro menos
  const motivos = usados
    .filter((t) => termometros[t].pontos > 0)
    .sort((a, b) => termometros[b].pontos - termometros[a].pontos)
    .flatMap((t) => termometros[t].detalhe);
  return { pontos, nivel, parcial: semDado.length > 0, sem_dado: semDado, alerta, motivos, termometros };
}

module.exports = {
  PESOS_PADRAO, CORTES_PADRAO, ALERTA_TERMOMETRO, TERMOMETROS, diasEntre,
  MIN_ENTREGAS_OPERACIONAL, PADRAO_TAG_SUSPENSAO, REGEX_TAG_SUSPENSAO,
  termometroFinanceiro, termometroAtendimento, termometroOperacional, calcularRisco,
};
