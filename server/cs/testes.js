'use strict';
/**
 * Testes do Motor de Tempo Útil — Módulo Sucesso do Cliente
 * Rodar: node testes.js
 */
const T = require('./tempoUtil');

let ok = 0, falhou = 0;

function teste(nome, obtido, esperado) {
  const passou = obtido === esperado;
  console.log(`${passou ? '✅' : '❌'} ${nome}`);
  console.log(`     esperado: ${esperado}  |  obtido: ${obtido}`);
  passou ? ok++ : falhou++;
}

console.log('\n════════════════════════════════════════════════════════════');
console.log(' TESTE DE ACEITAÇÃO — Ticket #46003 (Rodrigo / BRIDGE TECH)');
console.log('════════════════════════════════════════════════════════════\n');
console.log(' 11:59  Cliente: "Dia 20 tá aí, tem uma previsão da apuração?"');
console.log(' 12:44  Recepção: "Boa tarde, Rodrigo! Tudo bem?"');
console.log(' 12:47  Recepção: "Um momento vou te direcionar" + transfere\n');

// 2026-07-02 é quinta-feira (expediente 07:30–11:30 / 12:30–17:30)
const D = '2026-07-02';

teste(
  'Relógio 1 — ACEITE (11:59 → 12:44), almoço congela',
  T.minutosUteis(T.instante(D, '11:59'), T.instante(D, '12:44')),
  14 // 12:30 → 12:44 (os 31 min de almoço não contam)
);

teste(
  'Relógio 2 — TRANSFERÊNCIA (12:44 → 12:47)',
  T.minutosUteis(T.instante(D, '12:44'), T.instante(D, '12:47')),
  3
);

const minAceite = T.minutosUteis(T.instante(D, '11:59'), T.instante(D, '12:44'));
teste(
  'Status do aceite (14 min, limite 15) → VERDE',
  T.statusSLA(minAceite, T.LIMITES.aceite),
  'verde'
);

console.log('\n  ⚠️  Sem a regra de almoço, este caso apareceria como');
console.log('      "45 min → 3x estourado → VERMELHO" — acusando');
console.log('      injustamente um atendimento DENTRO do prazo.\n');

console.log('════════════════════════════════════════════════════════════');
console.log(' CENÁRIOS DE BORDA');
console.log('════════════════════════════════════════════════════════════\n');

// ── Almoço ───────────────────────────────────────────────────────────────────
teste(
  'Mensagem no almoço: 11:35 → 12:35 = 5 min úteis',
  T.minutosUteis(T.instante(D, '11:35'), T.instante(D, '12:35')),
  5 // só 12:30→12:35 conta
);

teste(
  'Totalmente dentro do almoço: 11:35 → 12:00 = 0 min',
  T.minutosUteis(T.instante(D, '11:35'), T.instante(D, '12:00')),
  0
);

// ── Virada de dia ────────────────────────────────────────────────────────────
teste(
  'Fim do dia → manhã seguinte: qui 17:00 → sex 08:30 = 60 min',
  T.minutosUteis(T.instante('2026-07-02', '17:00'), T.instante('2026-07-03', '08:30')),
  60 // qui 17:00–17:30 (30) + sex 08:00–08:30 (30)
);

teste(
  'Mensagem à noite: 22:00 qui → 08:15 sex = 15 min',
  T.minutosUteis(T.instante('2026-07-02', '22:00'), T.instante('2026-07-03', '08:15')),
  15 // sex abre 08:00 → 08:15
);

// ── Fim de semana ────────────────────────────────────────────────────────────
teste(
  'Fim de semana: sex 17:00 (fecha) → seg 07:45 = 15 min',
  T.minutosUteis(T.instante('2026-07-03', '17:00'), T.instante('2026-07-06', '07:45')),
  15 // sáb/dom não contam; seg abre 07:30 → 07:45
);

// ── Feriado ──────────────────────────────────────────────────────────────────
teste(
  'Feriado 07/09 (seg): sex 17:00 → ter 07:45 = 15 min',
  T.minutosUteis(T.instante('2026-09-04', '17:00'), T.instante('2026-09-08', '07:45')),
  15 // sáb, dom e o feriado de segunda não contam
);

teste(
  '07/09 é feriado → não é dia útil',
  T.ehDiaUtil('2026-09-07'),
  false
);

teste(
  'Ponto facultativo (Carnaval 16/02) → CONTA como dia útil',
  T.ehDiaUtil('2026-02-16'),
  true
);

// ── Expediente especial ──────────────────────────────────────────────────────
teste(
  '24/12 só manhã: 10:00 → 14:00 = 90 min',
  T.minutosUteis(T.instante('2026-12-24', '10:00'), T.instante('2026-12-24', '14:00')),
  90 // 10:00–11:30; à tarde não há expediente
);

teste(
  '24/12 (qui, só manhã) 12:00 → 26/12 (sáb) = 0 min',
  T.minutosUteis(T.instante('2026-12-24', '12:00'), T.instante('2026-12-26', '10:00')),
  0 // tarde do 24 não tem expediente, 25 é Natal, 26 é sábado
);

// ── Dia inteiro ──────────────────────────────────────────────────────────────
teste(
  'Quinta inteira (07:30→17:30) = 540 min (9h úteis)',
  T.minutosUteis(T.instante(D, '07:30'), T.instante(D, '17:30')),
  540 // 4h manhã + 5h tarde
);

teste(
  'Sexta inteira (08:00→17:00) = 480 min (8h úteis)',
  T.minutosUteis(T.instante('2026-07-03', '08:00'), T.instante('2026-07-03', '17:00')),
  480 // 3h30 manhã + 4h30 tarde
);

// ── Status SLA ───────────────────────────────────────────────────────────────
teste('Status: 10 min / limite 15 → verde',    T.statusSLA(10, 15), 'verde');
teste('Status: 15 min / limite 15 → verde',    T.statusSLA(15, 15), 'verde');
teste('Status: 20 min / limite 15 → amarelo',  T.statusSLA(20, 15), 'amarelo');
teste('Status: 30 min / limite 15 → amarelo',  T.statusSLA(30, 15), 'amarelo');
teste('Status: 31 min / limite 15 → vermelho', T.statusSLA(31, 15), 'vermelho');
teste('Status: 45 min / limite 15 → vermelho', T.statusSLA(45, 15), 'vermelho');

// ── proximoInstanteUtil ──────────────────────────────────────────────────────
teste(
  'Mensagem 11:59 (almoço) → relógio retoma 12:30',
  T.proximoInstanteUtil(T.instante(D, '11:59')).toISOString(),
  T.instante(D, '12:30').toISOString()
);

teste(
  'Mensagem 09:00 (expediente) → relógio corre agora',
  T.proximoInstanteUtil(T.instante(D, '09:00')).toISOString(),
  T.instante(D, '09:00').toISOString()
);

teste(
  'Mensagem sábado → retoma segunda 07:30',
  T.proximoInstanteUtil(T.instante('2026-07-04', '10:00')).toISOString(),
  T.instante('2026-07-06', '07:30').toISOString()
);

// ── Casos degenerados ────────────────────────────────────────────────────────
teste('Fim antes do início = 0', T.minutosUteis(T.instante(D, '12:00'), T.instante(D, '10:00')), 0);
teste('Início igual ao fim = 0', T.minutosUteis(T.instante(D, '10:00'), T.instante(D, '10:00')), 0);

console.log('\n════════════════════════════════════════════════════════════');
console.log(` RESULTADO: ${ok} passaram · ${falhou} falharam`);
console.log('════════════════════════════════════════════════════════════\n');

process.exit(falhou > 0 ? 1 : 0);
