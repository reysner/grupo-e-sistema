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


// ── TICKET #50038 (Kelen): contato proativo e promessa de transferir não podem contar contra o analista ──
console.log('\n── #50038: fechamento pela pesquisa e transferência implícita ──');
const B = (d, hhmmss) => new Date(d + 'T' + hhmmss + '-03:00').toISOString();
const t50038 = {
  id: 50038,
  eventos: [{ tipo: 'abertura', hora: B('2026-10-15', '14:42:03') }, { tipo: 'aceite', hora: B('2026-10-15', '14:44:50') }],   // sem transferência e sem encerramento gravados
  mensagens: [
    { hora: B('2026-10-15', '14:42:05'), remetente: 'cliente', texto: 'Oi Kelen' },
    { hora: B('2026-10-15', '14:43:07'), remetente: 'cliente', texto: 'Kelen pode somar as guias da previdência pra mim ? Por favor' },
    { hora: B('2026-10-15', '14:45:22'), remetente: 'escritorio', texto: 'boa tarde!! um instante q vou transferir' },
    { hora: B('2026-10-15', '14:45:47'), remetente: 'escritorio', texto: '*Kelen:* Oi Boa tarde' },
    { hora: B('2026-10-15', '14:49:15'), remetente: 'escritorio', texto: '*Kelen:* sim só um minuto' },
    { hora: B('2026-10-15', '16:49:16'), remetente: 'escritorio', texto: '*Kelen:* Maria Antonia estou encerrando nosso atendimento precisando é só chamar' },
    { hora: B('2026-10-15', '16:49:26'), remetente: 'escritorio', texto: 'Por favor, informe *uma nota* entre *1 a 5* para *avaliar o atendimento*' },
    { hora: B('2026-10-15', '16:54:26'), remetente: 'cliente', texto: '5' },
    { hora: B('2026-10-20', '14:58:27'), remetente: 'escritorio', texto: '*Kelen:* Boa tarde Maria Antonia deu certo fazer o pagamento das guias que te enviei' },
  ],
};
const r50038 = calcularSLA(t50038, new Date(B('2026-10-21', '13:28:00')));
const relogioDe = (r, tipo) => r.relogios.find((x) => x.tipo === tipo);
checa('#50038: sem relógio em curso, então não fica vermelho', r50038.radar, null);
checa('#50038: não existe "promessa de transferir" correndo (a recepção passou o atendimento a um atendente assinado)', !!relogioDe(r50038, 'promessa'), false);
checa('#50038: transferência e departamento verdes', [relogioDe(r50038, 'transferencia').status, relogioDe(r50038, 'departamento').status], ['verde', 'verde']);

// o cliente volta a escrever depois da pesquisa: ele passa a esperar resposta (vez do cliente), sem acusar o atendimento antigo
const voltou = JSON.parse(JSON.stringify(t50038));
voltou.mensagens.push({ hora: B('2026-10-20', '15:30:00'), remetente: 'cliente', texto: 'Preciso de ajuda com outra guia, pode me ajudar?' });
const rVoltou = calcularSLA(voltou, new Date(B('2026-10-21', '13:28:00')));
checa('cliente voltou a escrever depois da pesquisa: só a vez do cliente corre', rVoltou.radar && rVoltou.radar.tipo, 'vez_cliente');

// "5" que NÃO responde a uma pesquisa (ninguém pediu nota) não encerra nada
const semPesquisa = { id: 1, eventos: [{ tipo: 'abertura', hora: B('2026-10-15', '14:00:00') }, { tipo: 'aceite', hora: B('2026-10-15', '14:02:00') }],
  mensagens: [{ hora: B('2026-10-15', '14:00:00'), remetente: 'cliente', texto: 'Quantas guias eu tenho?' }, { hora: B('2026-10-15', '14:03:00'), remetente: 'escritorio', texto: 'um instante vou transferir' }, { hora: B('2026-10-15', '14:10:00'), remetente: 'cliente', texto: '5' }] };
const rSemPesquisa = calcularSLA(semPesquisa, new Date(B('2026-10-16', '10:00:00')));
checa('"5" solto, sem pedido de nota, não fecha o atendimento (a promessa de transferir segue valendo)', !!relogioDe(rSemPesquisa, 'promessa'), true);

// ── TICKET #50388 (Polyanna): caso em tratativa, cliente escreve depois do expediente e a resposta vem no dia seguinte ──
console.log('\n── #50388: aviso de tratativa e resposta no dia seguinte ──');
const B2 = (d, hhmmss) => new Date(d + 'T' + hhmmss + '-03:00').toISOString();
const montar50388 = (avisoTexto) => ({
  id: 50388,
  eventos: [{ tipo: 'abertura', hora: B2('2026-10-21', '17:21:31') }, { tipo: 'aceite', hora: B2('2026-10-21', '17:25:27') }],
  mensagens: [
    { hora: B2('2026-10-21', '17:21:33'), remetente: 'cliente', texto: 'Polyanna, boa tarde!' },
    { hora: B2('2026-10-21', '17:25:41'), remetente: 'escritorio', texto: '*Elma:* oi, boa tarde' },
    { hora: B2('2026-10-21', '17:29:07'), remetente: 'cliente', texto: 'Preciso que tente dar baixa na CTPS digital' },
    { hora: B2('2026-10-21', '17:29:44'), remetente: 'escritorio', texto: '*Polyanna:* então Rosana, a baixa que tenho acesso é o esocial' },
    { hora: B2('2026-10-21', '17:36:22'), remetente: 'escritorio', texto: avisoTexto },
    { hora: B2('2026-10-21', '17:37:25'), remetente: 'cliente', texto: 'Fica faltando agora somente as guias do DCTFWEB' },
    { hora: B2('2026-10-22', '08:53:28'), remetente: 'escritorio', texto: '*Polyanna:* Bom dia, guias enviadas em 06/10' },
  ],
});
const agora50388 = new Date(B2('2026-10-22', '11:00:00'));
const comAviso = calcularSLA(montar50388('*Sua solicitação está em andamento* ⏳✨ Por se tratar de tratativa, encerraremos este atendimento por ora. Seguirei tratando e retornarei com uma atualização o mais breve possível.'), agora50388);
checa('#50388 com o aviso de tratativa: a resposta do dia seguinte não deixa o P. Resolver vermelho', (comAviso.relogios.find((x) => x.tipo === 'promessa_resolucao') || {}).status, 'verde');
const semAviso = calcularSLA(montar50388('*Polyanna:* Estou verificando.'), agora50388);
checa('#50388 sem o aviso (controle): a mesma demora vira vermelho pelo prazo de 30 min', (semAviso.relogios.find((x) => x.tipo === 'promessa_resolucao') || {}).status, 'vermelho');
const { calcularTrocas: trocas50388, avisoDeTratativa } = require('./slaEngine');
checa('aviso de tratativa reconhecido com ou sem acento', [avisoDeTratativa('Sua solicitacao esta em andamento'), avisoDeTratativa('retornarei com uma atualização'), avisoDeTratativa('Bom dia')], [true, true, false]);
checa('a troca depois do aviso é marcada como em tratativa', trocas50388(montar50388('Sua solicitação está em andamento').mensagens, agora50388).some((x) => x.em_tratativa === true), true);
console.log('\n═══════════════════════════════════════════════════════════════');
console.log(` RESULTADO: ${ok} passaram · ${falhou} falharam`);
console.log('═══════════════════════════════════════════════════════════════\n');
process.exit(falhou > 0 ? 1 : 0);
