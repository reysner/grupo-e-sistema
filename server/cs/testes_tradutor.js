'use strict';
/**
 * Testes do Tradutor Zappy — foco na PENDÊNCIA 1 (bot vs. atendente humano)
 * Rodar: node testes_tradutor.js
 *
 * Resolvida usando um campo que a API do Zappy JÁ confirmou entregar
 * (seção 4 da Continuidade): ticket.user, null enquanto ninguém assumiu.
 * Não foi preciso abrir um novo ticket no F12 para o caso principal.
 */
const { traduzirTicket, ehMensagemBot } = require('./tradutorZappy');

let ok = 0, falhou = 0;
function teste(nome, obtido, esperado) {
  const passou = JSON.stringify(obtido) === JSON.stringify(esperado);
  console.log(`${passou ? '✅' : '❌'} ${nome}`);
  if (!passou) console.log(`     esperado: ${JSON.stringify(esperado)}  |  obtido: ${JSON.stringify(obtido)}`);
  passou ? ok++ : falhou++;
}

console.log('\n════════════════════════════════════════════════════════════');
console.log(' CASO REAL #46072 — ticket pending, user=null, msg automática');
console.log('════════════════════════════════════════════════════════════\n');

const ticket46072 = {
  id: 46072,
  status: 'pending',
  queueId: 2,
  queue: { id: 2, name: 'Sucesso do Cliente' },
  user: null, // ninguém assumiu
  createdAt: '2026-07-16T15:39:57.000Z', // quinta-feira (dia útil)
  metas: [{ type: 'duration:since:pending', value: '2026-07-16T15:39:57.509Z' }],
  contact: { id: 4863, name: 'CLIENTE_TESTE', number: '55XXXXXXXXXXX' },
};
const msgs46072 = [
  { id: 'm1', fromMe: false, body: 'Olá! Encontrei seu site...', createdAt: '2026-07-16T15:39:58.386Z' },
  { id: 'm2', fromMe: true, body: '⚠️ Aviso: manutenção na rede...', createdAt: '2026-07-16T15:40:04.316Z' },
];

const g1 = traduzirTicket(ticket46072, msgs46072);
teste('Mensagem automática (fromMe=true, ticket.user=null) -> is_bot=true',
  g1.mensagens.find(m => m.zappy_msg_id === 'm2').is_bot, true);
teste('Nenhum evento de aceite é criado a partir da msg automática',
  g1.eventos.some(e => e.tipo === 'aceite'), false);

console.log('\n════════════════════════════════════════════════════════════');
console.log(' CASO SINTÉTICO — ticket JÁ aceito (user preenchido) e respondido');
console.log('════════════════════════════════════════════════════════════\n');

const ticketAceito = {
  id: 99001,
  status: 'open',
  queueId: 2,
  queue: { id: 2, name: 'Sucesso do Cliente' },
  user: { id: 6, name: 'Ana (atendente)' }, // alguém assumiu
  createdAt: '2026-07-16T13:00:00.000Z',
  metas: [
    { type: 'duration:since:pending', value: '2026-07-16T13:00:00.000Z' },
    { type: 'duration:since:open', value: '2026-07-16T13:10:00.000Z' }, // aceite explícito
  ],
  contact: { id: 1, name: 'Empresa X', number: '5534999999999' },
};
const msgsAceito = [
  { id: 'a1', fromMe: false, body: 'Bom dia', createdAt: '2026-07-16T13:00:05.000Z' },
  { id: 'a2', fromMe: true, body: 'Aguarde, já te atendo', createdAt: '2026-07-16T13:05:00.000Z' }, // ANTES do aceite -> bot
  { id: 'a3', fromMe: true, body: 'Oi! Como posso ajudar?', createdAt: '2026-07-16T13:12:00.000Z' }, // DEPOIS do aceite -> humano
];

const g2 = traduzirTicket(ticketAceito, msgsAceito);
teste('Mensagem ANTES do instante do aceite -> is_bot=true',
  g2.mensagens.find(m => m.zappy_msg_id === 'a2').is_bot, true);
teste('Mensagem DEPOIS do instante do aceite -> is_bot=false (atendente humano)',
  g2.mensagens.find(m => m.zappy_msg_id === 'a3').is_bot, false);
teste('Evento de aceite bate com o meta duration:since:open (13:10)',
  g2.eventos.find(e => e.tipo === 'aceite').hora, '2026-07-16T13:10:00.000Z');

console.log('\n════════════════════════════════════════════════════════════');
console.log(' CASO DE BORDA — ticket.user preenchido MAS sem meta de aceite');
console.log(' (fallback de baixa confiança — o único caso que ainda merece um F12)');
console.log('════════════════════════════════════════════════════════════\n');

const ticketSemMeta = {
  id: 99002, status: 'open', queueId: 2, queue: { id: 2, name: 'Sucesso do Cliente' },
  user: { id: 7, name: 'Bruno' }, createdAt: '2026-07-16T13:00:00.000Z', metas: [],
  contact: { id: 2, name: 'Empresa Y', number: '5534988888888' },
};
teste('Sem meta e sem flags de bot -> assume humano (fallback regra 3)',
  ehMensagemBot({ fromMe: true, createdAt: '2026-07-16T13:20:00.000Z' }, ticketSemMeta, null), false);
teste('Sem meta mas com botOptionId -> continua detectando como bot (fallback regra 3)',
  ehMensagemBot({ fromMe: true, createdAt: '2026-07-16T13:20:00.000Z', botOptionId: 3 }, ticketSemMeta, null), true);

console.log('\n════════════════════════════════════════════════════════════');
console.log(` RESULTADO: ${ok} passaram · ${falhou} falharam`);
console.log('════════════════════════════════════════════════════════════\n');
process.exit(falhou > 0 ? 1 : 0);
