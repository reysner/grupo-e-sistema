'use strict';
/**
 * Módulo Sucesso do Cliente — Motor de Tempo Útil
 * ------------------------------------------------------------------
 * Coração de todos os 5 relógios de SLA.
 * Calcula minutos ÚTEIS entre dois instantes, congelando o relógio:
 *   - fora do expediente
 *   - no almoço (11:30–12:30)
 *   - em fins de semana
 *   - em feriados
 * Pontos facultativos CONTAM normalmente (decisão do escritório).
 *
 * Sem dependências externas. Timezone: America/Sao_Paulo (-03:00 fixo —
 * o Brasil aboliu o horário de verão em 2019; se voltar, revisar TZ_OFFSET).
 */

const TZ_OFFSET = '-03:00';

// ── Expediente padrão por dia da semana (0=dom … 6=sáb) ───────────────────────
const EXPEDIENTE_PADRAO = {
  0: [],                                       // domingo
  1: [['07:30', '11:30'], ['12:30', '17:30']], // segunda
  2: [['07:30', '11:30'], ['12:30', '17:30']], // terça
  3: [['07:30', '11:30'], ['12:30', '17:30']], // quarta
  4: [['07:30', '11:30'], ['12:30', '17:30']], // quinta
  5: [['08:00', '11:30'], ['12:30', '17:00']], // sexta
  6: [],                                       // sábado
};

// ── Feriados (não contam) — apenas os que caem em dia útil ────────────────────
// ATENÇÃO: datas móveis mudam todo ano. Manutenção anual obrigatória.
const FERIADOS = new Set([
  // 2026
  '2026-01-01', // Confraternização Universal
  '2026-04-03', // Paixão de Cristo
  '2026-04-21', // Tiradentes
  '2026-05-01', // Dia do Trabalho
  '2026-06-04', // Corpus Christi
  '2026-08-31', // São Raimundo (Aniversário de Uberlândia)
  '2026-09-07', // Independência
  '2026-10-12', // N. Sra. Aparecida
  '2026-11-02', // Finados
  '2026-11-20', // Consciência Negra
  '2026-12-25', // Natal
  // 2026-08-15 (sáb) e 2026-11-15 (dom) caem em fim de semana → sem efeito
]);

// ── Expediente especial (sobrescreve o padrão) ────────────────────────────────
const EXPEDIENTE_ESPECIAL = {
  '2026-12-24': [['07:30', '11:30']], // véspera de Natal — só manhã
  '2026-12-31': [['07:30', '11:30']], // véspera de Ano Novo — só manhã
};

// ── Helpers de data em São Paulo ──────────────────────────────────────────────

/** Retorna a data local em SP no formato YYYY-MM-DD */
function diaISO(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

/** Dia da semana (0=dom … 6=sáb) de uma data YYYY-MM-DD */
function diaSemana(dataISO) {
  return new Date(`${dataISO}T12:00:00${TZ_OFFSET}`).getUTCDay();
}

/** Constrói um Date a partir de YYYY-MM-DD + HH:MM no fuso de SP */
function instante(dataISO, hhmm) {
  return new Date(`${dataISO}T${hhmm}:00${TZ_OFFSET}`);
}

/** Soma N dias a uma data YYYY-MM-DD */
function somaDias(dataISO, n) {
  const d = new Date(`${dataISO}T12:00:00${TZ_OFFSET}`);
  d.setUTCDate(d.getUTCDate() + n);
  return diaISO(d);
}

// ── Janelas de expediente de um dia ───────────────────────────────────────────

/**
 * Retorna as janelas de expediente de um dia como pares de Date.
 * Ordem de precedência: feriado → expediente especial → padrão do dia da semana.
 */
function janelasDoDia(dataISO) {
  if (FERIADOS.has(dataISO)) return [];
  const faixas = EXPEDIENTE_ESPECIAL[dataISO] || EXPEDIENTE_PADRAO[diaSemana(dataISO)] || [];
  return faixas.map(([ini, fim]) => [instante(dataISO, ini), instante(dataISO, fim)]);
}

/** É dia útil? (tem ao menos uma janela de expediente) */
function ehDiaUtil(dataISO) {
  return janelasDoDia(dataISO).length > 0;
}

// ── Núcleo: minutos úteis entre dois instantes ────────────────────────────────

/**
 * Calcula os minutos ÚTEIS decorridos entre `inicio` e `fim`.
 * @param {Date|string} inicio
 * @param {Date|string} fim
 * @returns {number} minutos úteis (0 se fim <= inicio)
 */
function minutosUteis(inicio, fim) {
  const ini = inicio instanceof Date ? inicio : new Date(inicio);
  const end = fim instanceof Date ? fim : new Date(fim);
  if (!(end > ini)) return 0;

  let totalMs = 0;
  let dia = diaISO(ini);
  const diaFinal = diaISO(end);
  let guarda = 0; // proteção contra loop infinito

  while (dia <= diaFinal && guarda++ < 400) {
    for (const [jIni, jFim] of janelasDoDia(dia)) {
      const a = ini > jIni ? ini : jIni;   // max(inicio, janela.inicio)
      const b = end < jFim ? end : jFim;   // min(fim, janela.fim)
      if (b > a) totalMs += (b - a);
    }
    dia = somaDias(dia, 1);
  }
  return Math.round(totalMs / 60000);
}

/**
 * Retorna o próximo instante útil a partir de `date`.
 * Se `date` já está dentro do expediente, devolve o próprio `date`.
 * Útil para saber quando o relógio retoma (ex.: mensagem no almoço).
 */
function proximoInstanteUtil(date) {
  const d = date instanceof Date ? date : new Date(date);
  let dia = diaISO(d);
  for (let i = 0; i < 400; i++) {
    for (const [jIni, jFim] of janelasDoDia(dia)) {
      if (d < jIni) return jIni;          // antes da janela → abre na janela
      if (d >= jIni && d < jFim) return d; // dentro da janela → agora mesmo
    }
    dia = somaDias(dia, 1);
  }
  return null;
}

/**
 * Classifica o status de um relógio conforme os minutos úteis e o limite.
 * 🟢 dentro do prazo · 🟡 estourou · 🔴 passou de 2x o limite
 */
function statusSLA(minutos, limite) {
  if (minutos <= limite) return 'verde';
  if (minutos <= limite * 2) return 'amarelo';
  return 'vermelho';
}

// ── Limites de SLA (os 5 relógios) ────────────────────────────────────────────
const LIMITES = {
  aceite: 15,         // 1ª msg do cliente → alguém aceita
  transferencia: 15,  // aceite → transferência efetiva
  departamento: 30,   // chegou no depto → analista interage
  promessa: 15,       // respondeu sem resolver → transferir/encerrar/nova msg
};

module.exports = {
  minutosUteis,
  proximoInstanteUtil,
  statusSLA,
  janelasDoDia,
  ehDiaUtil,
  diaISO,
  diaSemana,
  instante,
  somaDias,
  LIMITES,
  FERIADOS,
  EXPEDIENTE_PADRAO,
  EXPEDIENTE_ESPECIAL,
};
