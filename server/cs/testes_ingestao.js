'use strict';
/**
 * Teste ponta a ponta do job de ingestão — SEM rede e SEM Postgres reais.
 * Usa os mocks em mocks/ para simular a API do Zappy e o banco.
 * Rodar: node testes_ingestao.js
 *
 * Cobre: tradução -> SLA -> de-para automático contra a Carteira -> upsert
 * em cs_tickets/cs_mensagens -> regra de "sem carga retroativa".
 */
const { ingerirTickets } = require('./ingestao');
const { criarPoolFake } = require('./mocks/poolFake');
const { criarClienteFake } = require('./mocks/zappyClientFake');

let ok = 0, falhou = 0;
function teste(nome, obtido, esperado) {
  const passou = JSON.stringify(obtido) === JSON.stringify(esperado);
  console.log(`${passou ? '✅' : '❌'} ${nome}`);
  if (!passou) console.log(`     esperado: ${JSON.stringify(esperado)}  |  obtido: ${JSON.stringify(obtido)}`);
  passou ? ok++ : falhou++;
}

(async () => {
  console.log('\n════════════════════════════════════════════════════════════');
  console.log(' INGESTÃO — ticket dentro da janela de coleta, com de-para automático');
  console.log('════════════════════════════════════════════════════════════\n');

  const pool = criarPoolFake({
    clientesSeed: [{ id: 'c1', nome_empresa: 'CLIENTE_TESTE LTDA', cnpj: '00.000.000/0001-00' }],
    // trava "sem carga retroativa" numa data anterior à do fixture, simulando
    // um sistema já em produção há alguns dias.
    configSeed: { ingestao_data_inicio: '2026-07-01T00:00:00.000Z' },
  });

  const ticketDentro = {
    id: 46072, status: 'pending', queueId: 2, queue: { id: 2, name: 'Sucesso do Cliente' },
    user: null, rate: null,
    createdAt: '2026-07-16T15:39:57.000Z', updatedAt: '2026-07-16T15:40:04.000Z',
    contact: { id: 4863, name: 'CLIENTE_TESTE', number: '5534999990000' },
    metas: [{ type: 'duration:since:pending', value: '2026-07-16T15:39:57.509Z' }],
  };
  const msgsDentro = [
    { id: 'm1', fromMe: false, body: 'Olá!', createdAt: '2026-07-16T15:39:58.386Z' },
    { id: 'm2', fromMe: true, body: '⚠️ Aviso automático de manutenção', createdAt: '2026-07-16T15:40:04.316Z' },
  ];

  // ticket ANTES da data de início da coleta -> deve ser ignorado (sem carga retroativa)
  const ticketAntigo = {
    id: 40000, status: 'closed', queueId: 2, queue: { id: 2, name: 'Sucesso do Cliente' },
    user: { id: 1, name: 'Ana' }, rate: 5,
    createdAt: '2026-06-20T10:00:00.000Z', updatedAt: '2026-06-20T11:00:00.000Z',
    contact: { id: 1, name: 'Empresa Antiga', number: '5534988887777' },
    metas: [],
  };

  const zappyClient = criarClienteFake({
    tickets: [ticketDentro, ticketAntigo],
    mensagensPorId: { 46072: msgsDentro, 40000: [] },
  });

  const agora = new Date('2026-07-16T16:00:00.000Z');
  const resultado = await ingerirTickets({ zappyClient, pool, agora });

  teste('1 ticket processado (o de dentro da janela)', resultado.processados, 1);
  teste('1 ticket ignorado por ser anterior à data de início', resultado.ignoradosPreDataInicio, 1);
  teste('Nenhum erro', resultado.erros, []);

  const linha = pool._db.cs_tickets.get('46072');
  teste('Ticket gravado com zappy_id correto', linha.zappy_id, '46072');
  teste('Ticket antigo NÃO foi gravado', pool._db.cs_tickets.has('40000'), false);

  const vinculo = pool._db.cs_vinculos.get('5534999990000');
  teste('Vínculo criado automaticamente como "pendente"', vinculo.tipo, 'pendente');
  teste('De-para casou com a Carteira (CLIENTE_TESTE -> CLIENTE_TESTE LTDA)', vinculo.cliente_id, 'c1');
  teste('Ticket já sai gravado com o vinculo_id certo', linha.vinculo_id, vinculo.id);

  teste('Mensagem automática (bot) foi gravada como remetente "sistema", não "escritorio"',
    pool._db.cs_mensagens.find(m => m.zappy_msg_id === 'm2').remetente, 'sistema');
  teste('Mensagem do cliente foi gravada como remetente "cliente"',
    pool._db.cs_mensagens.find(m => m.zappy_msg_id === 'm1').remetente, 'cliente');

  console.log('\n════════════════════════════════════════════════════════════');
  console.log(' RODAR DE NOVO (idempotência) — não deve duplicar nem quebrar');
  console.log('════════════════════════════════════════════════════════════\n');
  const totalMsgsAntes = pool._db.cs_mensagens.length;
  const totalTicketsAntes = pool._db.cs_tickets.size;
  await ingerirTickets({ zappyClient, pool, agora });
  teste('Nº de tickets não duplicou numa 2ª execução', pool._db.cs_tickets.size, totalTicketsAntes);
  teste('Nº de mensagens não duplicou numa 2ª execução', pool._db.cs_mensagens.length, totalMsgsAntes);

  console.log('\n════════════════════════════════════════════════════════════');
  console.log(` RESULTADO: ${ok} passaram · ${falhou} falharam`);
  console.log('════════════════════════════════════════════════════════════\n');
  process.exit(falhou > 0 ? 1 : 0);
})();
