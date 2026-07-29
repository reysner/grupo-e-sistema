'use strict';
/**
 * Testes da separação da PROMESSA em dois tipos (ver conversa com a Thais):
 *   - 'promessa'            -> avisou que VAI TRANSFERIR (frase-chave detectada), 15min.
 *   - 'promessa_resolucao'  -> vai RESOLVER DIRETO (sem transferir), até 2h de silêncio,
 *                              mas qualquer troca específica com o cliente > 30min já
 *                              vira vermelho mesmo dentro das 2h. Também não conta o
 *                              tempo em que o analista já respondeu e está esperando o
 *                              cliente se posicionar (ticket #46223, Thais).
 * Rodar: node testes_promessa.js
 */
const { calcularSLA, pareceIntencaoTransferir, pareceAguardandoCliente } = require('./slaEngine');
const T = require('./tempoUtil');

let ok = 0, falhou = 0;
function checa(nome, obtido, esperado) {
  const passou = JSON.stringify(obtido) === JSON.stringify(esperado);
  console.log(`${passou ? '✅' : '❌'} ${nome}`);
  if (!passou) console.log(`     esperado: ${JSON.stringify(esperado)}\n     obtido:   ${JSON.stringify(obtido)}`);
  passou ? ok++ : falhou++;
}
const H = (d, hhmm) => T.instante(d, hhmm).toISOString();
const D = '2026-07-02'; // quinta-feira normal

console.log('\n===================================================================');
console.log(' PROMESSA - separacao transferencia vs. resolucao direta');
console.log('===================================================================\n');

checa('"Vou te transferir para o departamento" = transferência', pareceIntencaoTransferir('Vou te transferir para o departamento'), true);
checa('"Vou direcionar sua solicitação para o setor responsável." = transferência', pareceIntencaoTransferir('Vou direcionar sua solicitação para o setor responsável.'), true);
checa('"Só um instante, por favor." = transferência', pareceIntencaoTransferir('Só um instante, por favor.'), true);
checa('"Vou analisar sua situação e te retorno com uma posição." = NÃO é transferência', pareceIntencaoTransferir('Vou analisar sua situação e te retorno com uma posição.'), false);
checa('Texto vazio = NÃO é transferência', pareceIntencaoTransferir(''), false);

checa(
  'Mensagem real do Bruno (#46223) pedindo comprovante = aguardando cliente',
  pareceAguardandoCliente('Após o pagamento, peço, por gentileza, que me encaminhe o comprovante para que eu possa dar andamento.'),
  true
);
checa('"Vou analisar sua situação e te retorno" = NÃO é aguardando cliente (bola continua com o analista)', pareceAguardandoCliente('Vou analisar sua situação e te retorno com uma posição.'), false);
checa('Texto vazio = NÃO é aguardando cliente', pareceAguardandoCliente(''), false);

{
  const ticket = {
    id: 1, empresa_texto: 'A',
    eventos: [{ tipo: 'abertura', hora: H(D, '09:00') }, { tipo: 'aceite', hora: H(D, '09:05') }],
    mensagens: [
      { hora: H(D, '09:00'), remetente: 'cliente', texto: 'Preciso de ajuda' },
      { hora: H(D, '09:05'), remetente: 'escritorio', texto: 'Vou te direcionar para o analista responsável.' },
    ],
  };
  const sla = calcularSLA(ticket, T.instante(D, '09:40'));
  const porTipo = Object.fromEntries(sla.relogios.map(r => [r.tipo, r]));
  checa('Avisou que vai transferir -> tipo "promessa" (não "promessa_resolucao")', !!porTipo.promessa && !porTipo.promessa_resolucao, true);
  checa('Limite continua 15min', porTipo.promessa.limite, 15);
  checa('35min > 2x15 -> vermelho', porTipo.promessa.status, 'vermelho');
}

{
  const ticket = {
    id: 2, empresa_texto: 'B',
    eventos: [{ tipo: 'abertura', hora: H(D, '09:00') }, { tipo: 'aceite', hora: H(D, '09:05') }],
    mensagens: [
      { hora: H(D, '09:00'), remetente: 'cliente', texto: 'Preciso da 2ª via do boleto' },
      { hora: H(D, '09:05'), remetente: 'escritorio', texto: 'Vou analisar sua situação e te retorno com uma posição.' },
    ],
  };
  const sla = calcularSLA(ticket, T.instante(D, '10:30'));
  const porTipo = Object.fromEntries(sla.relogios.map(r => [r.tipo, r]));
  checa('Vai resolver direto -> tipo "promessa_resolucao"', !!porTipo.promessa_resolucao, true);
  checa('Limite = 120min (2h)', porTipo.promessa_resolucao.limite, 120);
  checa('1h25 dentro de 2h, sem interação -> verde', porTipo.promessa_resolucao.status, 'verde');
}

{
  const ticket = {
    id: 3, empresa_texto: 'C',
    eventos: [{ tipo: 'abertura', hora: H(D, '09:00') }, { tipo: 'aceite', hora: H(D, '09:05') }],
    mensagens: [
      { hora: H(D, '09:00'), remetente: 'cliente', texto: 'Preciso da 2ª via do boleto' },
      { hora: H(D, '09:05'), remetente: 'escritorio', texto: 'Vou analisar sua situação e te retorno com uma posição.' },
      { hora: H(D, '09:20'), remetente: 'cliente', texto: 'aproveita e manda o comprovante também' },
      { hora: H(D, '10:10'), remetente: 'escritorio', texto: 'Aqui está, segue em anexo.' },
    ],
  };
  const sla = calcularSLA(ticket, T.instante(D, '10:30'));
  const porTipo = Object.fromEntries(sla.relogios.map(r => [r.tipo, r]));
  checa('Total (1h25) continua dentro das 2h', porTipo.promessa_resolucao.minutos_uteis <= 120, true);
  checa('Mas teve troca específica > 30min no meio -> vermelho mesmo assim', porTipo.promessa_resolucao.status, 'vermelho');
}

{
  const ticket = {
    id: 4, empresa_texto: 'D',
    eventos: [{ tipo: 'abertura', hora: H(D, '09:00') }, { tipo: 'aceite', hora: H(D, '09:05') }],
    mensagens: [
      { hora: H(D, '09:00'), remetente: 'cliente', texto: 'Preciso da 2ª via do boleto' },
      { hora: H(D, '09:05'), remetente: 'escritorio', texto: 'Vou analisar sua situação e te retorno com uma posição.' },
    ],
  };
  const sla = calcularSLA(ticket, T.instante(D, '13:10'));
  const porTipo = Object.fromEntries(sla.relogios.map(r => [r.tipo, r]));
  checa('Passou de 2h sem nenhuma interação e sem pedir nada ao cliente -> vermelho', porTipo.promessa_resolucao.status, 'vermelho');
  checa('aguardando_cliente = false (ele que deve a próxima ação)', porTipo.promessa_resolucao.aguardando_cliente, false);
}

{
  const ticket = {
    id: 46223, empresa_texto: 'João Pedro Capanema',
    eventos: [{ tipo: 'abertura', hora: H(D, '13:00') }, { tipo: 'aceite', hora: H(D, '13:02') }],
    mensagens: [
      { hora: H(D, '13:00'), remetente: 'cliente', texto: 'Bom dia, quero abrir uma empresa' },
      {
        hora: H(D, '13:24'), remetente: 'escritorio',
        texto: 'O pagamento pode ser realizado via PIX, utilizando a chave annaisa@escritorial.com.br. ' +
               'Após o pagamento, peço, por gentileza, que me encaminhe o comprovante para que eu possa ' +
               'dar andamento junto à nossa certificadora parceira.',
      },
    ],
  };
  const sla = calcularSLA(ticket, T.instante(D, '15:27'));
  const porTipo = Object.fromEntries(sla.relogios.map(r => [r.tipo, r]));
  checa('Ticket #46223 real: mais de 120min, mas esperando comprovante do cliente -> verde', porTipo.promessa_resolucao.status, 'verde');
  checa('aguardando_cliente = true', porTipo.promessa_resolucao.aguardando_cliente, true);
}

{
  // Ticket #46296 real (Diessica): o Bruno chamou a cliente primeiro (cobrança
  // de pendência financeira), ela nunca respondeu. Sem esse ajuste, o relógio
  // de Aceite contava da abertura até "agora" (sem tAceite) e virava um
  // vermelho gigante numa etapa que nem existe pra esse ticket.
  const ticket = {
    id: 46296, empresa_texto: 'Diessica - Uai Ceva E NR Bebidas',
    eventos: [{ tipo: 'abertura', hora: H(D, '08:41') }],
    mensagens: [
      {
        hora: H(D, '08:41'), remetente: 'escritorio',
        texto: 'Bom dia, Diessica! Estou entrando em contato para verificarmos a possibilidade de ' +
               'regularizar as pendências financeiras junto ao escritório.',
      },
    ],
  };
  const sla = calcularSLA(ticket, T.instante(D, '20:00')); // horas depois, cliente nunca respondeu
  const porTipo = Object.fromEntries(sla.relogios.map(r => [r.tipo, r]));
  checa('Ticket #46296 real: escritório chamou primeiro -> SEM relógio de Aceite', porTipo.aceite, undefined);
  checa('Não entra no radar "Agora" por causa do Aceite', !!(sla.radar && sla.radar.tipo === 'aceite'), false);
}

{
  // Confere que o caso normal (cliente chama primeiro) continua funcionando
  // do jeito de sempre — não pode ter quebrado nada com o ajuste acima.
  const ticket = {
    id: 999, empresa_texto: 'Cliente Normal',
    eventos: [{ tipo: 'abertura', hora: H(D, '09:00') }, { tipo: 'aceite', hora: H(D, '09:40') }],
    mensagens: [
      { hora: H(D, '09:00'), remetente: 'cliente', texto: 'Oi, preciso de ajuda' },
    ],
  };
  const sla = calcularSLA(ticket, T.instante(D, '09:45'));
  const porTipo = Object.fromEntries(sla.relogios.map(r => [r.tipo, r]));
  checa('Cliente chamou primeiro -> continua tendo relógio de Aceite', !!porTipo.aceite, true);
  checa('40min > 2x15min de limite -> vermelho', porTipo.aceite.status, 'vermelho');
}

console.log('\n===================================================================');
console.log(` RESULTADO: ${ok} passaram - ${falhou} falharam`);
console.log('===================================================================\n');
process.exit(falhou > 0 ? 1 : 0);
