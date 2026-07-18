'use strict';
const { calcularSLA } = require('./slaEngine');
const T = require('./tempoUtil');

let ok = 0, falhou = 0;
function checa(nome, obtido, esperado) {
  const passou = JSON.stringify(obtido) === JSON.stringify(esperado);
  console.log(`${passou ? '✅' : '❌'} ${nome}`);
  if (!passou) console.log(`     esperado: ${JSON.stringify(esperado)}\n     obtido:   ${JSON.stringify(obtido)}`);
  passou ? ok++ : falhou++;
}
const H = (d, hhmm) => T.instante(d, hhmm).toISOString();

console.log('\n═══════════════════════════════════════════════════════════════');
console.log(' MÁQUINA DOS 5 RELÓGIOS');
console.log('═══════════════════════════════════════════════════════════════\n');

// ── TICKET #46003 (Rodrigo) — completo ───────────────────────────────────────
// quinta 02/07/2026. Ticket encerrado logo após a transferência (para o teste).
const D = '2026-07-02';
const rodrigo = {
  id: 46003,
  empresa_texto: 'BRIDGE TECH E DIGITAL',
  status: 'encerrado',
  eventos: [
    { tipo: 'abertura',       hora: H(D, '11:59') },
    { tipo: 'aceite',         hora: H(D, '12:44') },
    { tipo: 'transferencia',  hora: H(D, '12:47') },
    { tipo: 'encerramento',   hora: H(D, '13:10') },
  ],
  mensagens: [
    { hora: H(D, '11:59'), remetente: 'cliente',    texto: 'Dia 20 tá aí, tem previsão da apuração?' },
    { hora: H(D, '12:44'), remetente: 'escritorio', texto: 'Boa tarde, Rodrigo! Tudo bem?' },
    { hora: H(D, '12:46'), remetente: 'cliente',    texto: 'Boa tarde' },
    { hora: H(D, '12:47'), remetente: 'escritorio', texto: 'Um momento vou te direcionar ao departamento!' },
    { hora: H(D, '12:55'), remetente: 'escritorio', texto: 'Sua apuração fica pronta dia 18.' }, // resposta do depto
  ],
};

const rSla = calcularSLA(rodrigo, T.instante(D, '13:10'));
const porTipo = Object.fromEntries(rSla.relogios.map(r => [r.tipo, r]));

console.log('Ticket #46003 — relógios calculados:');
rSla.relogios.forEach(r => {
  console.log(`   ${r.status.padEnd(8)} ${r.rotulo.padEnd(28)} ${r.minutos_uteis} min (limite ${r.limite})`);
});
console.log('');

checa('Aceite = 14 min (almoço congela)', porTipo.aceite.minutos_uteis, 14);
checa('Aceite = VERDE',                    porTipo.aceite.status, 'verde');
checa('Transferência = 3 min',             porTipo.transferencia.minutos_uteis, 3);
checa('Transferência = VERDE',             porTipo.transferencia.status, 'verde');
// Departamento: transferência 12:47 -> 1ª msg escritório após = 12:55 = 8 min
checa('Departamento = 8 min',              porTipo.departamento.minutos_uteis, 8);
checa('Departamento = VERDE',              porTipo.departamento.status, 'verde');
checa('Sem relógio de promessa (transferiu)', porTipo.promessa, undefined);
checa('Radar = null (encerrado, tudo verde)', rSla.radar, null);

console.log('\n─────────────────────────────────────────────────────────────');
console.log(' CENÁRIO 2 — Recepção prometeu e SUMIU (promessa estoura)');
console.log('─────────────────────────────────────────────────────────────\n');

// Aceitou, disse "vou verificar", nunca transferiu nem encerrou. Agora = 13:30.
const sumido = {
  id: 999,
  empresa_texto: 'CLIENTE SUMIDO LTDA',
  status: 'aberto',
  eventos: [
    { tipo: 'abertura', hora: H(D, '09:00') },
    { tipo: 'aceite',   hora: H(D, '09:05') },
  ],
  mensagens: [
    { hora: H(D, '09:00'), remetente: 'cliente',    texto: 'Preciso da guia do INSS' },
    { hora: H(D, '09:05'), remetente: 'escritorio', texto: 'Só um momento que já verifico!' },
  ],
};
const sSla = calcularSLA(sumido, T.instante(D, '10:05')); // 1h depois
const sTipo = Object.fromEntries(sSla.relogios.map(r => [r.tipo, r]));
sSla.relogios.forEach(r => console.log(`   ${r.status.padEnd(8)} ${r.rotulo.padEnd(28)} ${r.minutos_uteis} min em_curso=${r.em_curso}`));
console.log('');

checa('Promessa em curso = 60 min (09:05→10:05)', sTipo.promessa.minutos_uteis, 60);
checa('Promessa = VERMELHO (60 > 2x15)',           sTipo.promessa.status, 'vermelho');
checa('Radar aponta a PROMESSA',                   sSla.radar.tipo, 'promessa');

console.log('\n─────────────────────────────────────────────────────────────');
console.log(' CENÁRIO 3 — Cliente aguardando resposta AGORA (ball in court)');
console.log('─────────────────────────────────────────────────────────────\n');

// Cliente mandou a última mensagem e ninguém respondeu. Agora = 09:40.
const aguardando = {
  id: 1001,
  empresa_texto: 'AGUARDANDO SA',
  status: 'aberto',
  eventos: [
    { tipo: 'abertura', hora: H(D, '09:00') },
    { tipo: 'aceite',   hora: H(D, '09:03') },
    { tipo: 'transferencia', hora: H(D, '09:05') },
  ],
  mensagens: [
    { hora: H(D, '09:00'), remetente: 'cliente',    texto: 'Bom dia' },
    { hora: H(D, '09:03'), remetente: 'escritorio', texto: 'Bom dia! Como posso ajudar?' },
    { hora: H(D, '09:20'), remetente: 'cliente',    texto: 'Preciso do balancete de junho' },
  ],
};
const aSla = calcularSLA(aguardando, T.instante(D, '09:40'));
const aTipo = Object.fromEntries(aSla.relogios.map(r => [r.tipo, r]));
aSla.relogios.forEach(r => console.log(`   ${r.status.padEnd(8)} ${r.rotulo.padEnd(28)} ${r.minutos_uteis} min em_curso=${r.em_curso}`));
console.log('');

checa('Vez do cliente = 20 min (09:20→09:40)', aTipo.vez_cliente.minutos_uteis, 20);
checa('Departamento em curso (sem resposta pós-transf.)', aTipo.departamento.em_curso, true);
checa('Radar não é null (algo pendente)', aSla.radar !== null, true);

console.log('\n─────────────────────────────────────────────────────────────');
console.log(' CENÁRIO 4 — Ninguém aceitou ainda (aceite estourando)');
console.log('─────────────────────────────────────────────────────────────\n');

const semAceite = {
  id: 1002,
  empresa_texto: 'NOVO CONTATO',
  status: 'aberto',
  eventos: [ { tipo: 'abertura', hora: H(D, '09:00') } ],
  mensagens: [ { hora: H(D, '09:00'), remetente: 'cliente', texto: 'Olá, preciso de ajuda' } ],
};
const nSla = calcularSLA(semAceite, T.instante(D, '09:25'));
const nTipo = Object.fromEntries(nSla.relogios.map(r => [r.tipo, r]));
nSla.relogios.forEach(r => console.log(`   ${r.status.padEnd(8)} ${r.rotulo.padEnd(28)} ${r.minutos_uteis} min em_curso=${r.em_curso}`));
console.log('');

checa('Aceite em curso = 25 min', nTipo.aceite.minutos_uteis, 25);
checa('Aceite = AMARELO (25, entre 15 e 30)', nTipo.aceite.status, 'amarelo');
checa('Aceite em_curso = true', nTipo.aceite.em_curso, true);
checa('Radar aponta o ACEITE', nSla.radar.tipo, 'aceite');

console.log('\n═══════════════════════════════════════════════════════════════');
console.log(` RESULTADO: ${ok} passaram · ${falhou} falharam`);
console.log('═══════════════════════════════════════════════════════════════\n');
process.exit(falhou > 0 ? 1 : 0);
