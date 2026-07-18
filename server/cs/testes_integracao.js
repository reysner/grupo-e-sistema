'use strict';
/**
 * Teste de integração ponta a ponta:
 * Ticket real #46072 (Zappy) → tradutor → máquina dos 5 relógios
 *
 * Dados extraídos dos prints reais da API do Zappy.
 * (nome/telefone do cliente omitidos — só a estrutura importa)
 */
const { traduzirTicket } = require('./tradutorZappy');
const { calcularSLA } = require('./slaEngine');

// ── Ticket #46072 como a API do Zappy devolve ────────────────────────────────
// createdAt 15:39:57Z = 12:39 horário de Brasília (o print mostra "12:39")
const ticketZappy = {
  id: 46072,
  status: 'pending',          // ainda não foi aceito
  queueId: 2,
  queue: { id: 2, name: 'Sucesso do Cliente', color: '#7806da' },
  user: null,                 // ninguém assumiu (userId: null)
  rate: null,                 // não avaliado (não encerrou)
  createdAt: '2026-07-18T15:39:57.000Z',
  updatedAt: '2026-07-18T15:40:04.000Z',
  contact: { id: 4863, name: 'CLIENTE_TESTE', number: '55XXXXXXXXXXX' },
  metas: [
    { type: 'duration:since:pending', value: '2026-07-18T15:39:57.509Z' },
  ],
};

// ── Mensagens (2 mensagens, conforme "count": 2) ─────────────────────────────
const mensagensZappy = [
  {
    id: '2A70DC063201ED30E8CF',
    fromMe: false,                              // CLIENTE
    body: 'Olá! Encontrei seu site através do Google e estou interessada...',
    createdAt: '2026-07-18T15:39:58.386Z',
    ack: 1, mediaType: 'text', responseSeconds: 6,
  },
  {
    id: '3EB0334D9AE370153E2612',
    fromMe: true,                               // ESCRITÓRIO (mensagem automática de aviso)
    body: '⚠️ Aviso: Devido à manutenção na rede de água e esgoto...',
    createdAt: '2026-07-18T15:40:04.316Z',
    ack: 2, mediaType: 'text',
  },
];

console.log('\n═══════════════════════════════════════════════════════════════');
console.log(' INTEGRAÇÃO PONTA A PONTA — Ticket real #46072');
console.log('═══════════════════════════════════════════════════════════════\n');

// Passo 1: traduzir
const generico = traduzirTicket(ticketZappy, mensagensZappy);
console.log('1) TRADUÇÃO Zappy → genérico:');
console.log('   empresa_texto:', generico.empresa_texto);
console.log('   departamento :', generico.departamento);
console.log('   status       :', generico.status);
console.log('   eventos      :', generico.eventos.map(e => `${e.tipo}@${e.hora.slice(11,19)}`).join(' · '));
console.log('   mensagens    :', generico.mensagens.map(m => `${m.remetente}@${m.hora.slice(11,19)}`).join(' · '));
console.log('');

// Passo 2: calcular SLA
// "agora" = momento da captura (18/07 ~12:40 BRT = 15:40Z). Ticket ainda pending.
const agora = new Date('2026-07-18T15:55:00.000Z'); // ~12:55 BRT, 16 min após abertura
const sla = calcularSLA(generico, agora);

console.log('2) CÁLCULO DE SLA:');
if (sla.relogios.length === 0) {
  console.log('   (nenhum relógio — verificar dados)');
}
sla.relogios.forEach(r => {
  console.log(`   ${(r.status||'').padEnd(8)} ${r.rotulo.padEnd(30)} ${r.minutos_uteis} min  (limite ${r.limite ?? '—'})  em_curso=${r.em_curso}`);
});
console.log('');
console.log('3) RADAR (o que está pegando fogo agora):');
if (sla.radar) {
  console.log(`   🔥 ${sla.radar.rotulo} — ${sla.radar.minutos_uteis} min (${sla.radar.status})`);
} else {
  console.log('   ✅ nada pendente');
}

console.log('\n───────────────────────────────────────────────────────────────');
console.log(' ANÁLISE');
console.log('───────────────────────────────────────────────────────────────');
console.log(`
 Este ticket entrou às 12:39 (BRT) e às 12:40 recebeu uma resposta
 AUTOMÁTICA (aviso de manutenção, fromMe=true). Ninguém ACEITOU ainda
 (status=pending, user=null).

 Ponto de atenção de design que este caso REAL levanta:
 → A mensagem automática (fromMe=true) NÃO é um atendente humano.
   Para o relógio de aceite, o que vale é o EVENTO 'aceite' (alguém
   clicou aceitar), não uma resposta automática do bot.
 → Como não houve aceite, o relógio de aceite deve seguir correndo.
   Se ele parou por causa da mensagem automática, precisamos, na
   ingestão real, distinguir mensagens de BOT das de atendente
   (o Zappy deve ter um campo para isso — a investigar no próximo JSON).
`);

console.log('═══════════════════════════════════════════════════════════════\n');
