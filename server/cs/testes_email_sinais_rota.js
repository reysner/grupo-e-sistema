'use strict';
// Rodar: node server/cs/testes_email_sinais_rota.js  (validação do corpo recebido, sem banco)
const assert = require('assert');
// o módulo abre o pool ao ser carregado; um DATABASE_URL de mentira basta (nenhuma consulta é feita aqui)
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://x:x@localhost:5432/x';
const { validarPayload, validarAtendimento } = require('./emailSinais');

let ok = 0;
const teste = (nome, fn) => { fn(); ok++; console.log('  ok -', nome); };

teste('aceita contagens por CNPJ e limpa formato', () => {
  const v = validarPayload({ janela_dias: 14, caixas_lidas: 41, totais: { aguardando: 33, contatos: '303' },
    clientes: [{ cnpj: '11.222.333/0001-81', aguardando_4h: 2, aguardando_24h: '1', mais_antigo_h: 310.7, caixas: ['Bruno Xavier', 'Elma'] }] });
  assert.strictEqual(v.clientes.length, 1);
  assert.strictEqual(v.clientes[0].cnpj, '11222333000181');
  assert.strictEqual(v.clientes[0].aguardando_24h, 1);
  assert.strictEqual(v.clientes[0].mais_antigo_h, 310);
  assert.strictEqual(v.totais.contatos, 303);
  assert.strictEqual(v.caixas_lidas, 41);
});
teste('descarta CNPJ inválido e repetido', () => {
  const v = validarPayload({ clientes: [{ cnpj: '123' }, { cnpj: '11222333000181' }, { cnpj: '11222333000181' }, { cnpj: null }] });
  assert.strictEqual(v.clientes.length, 1);
});
teste('endereço de e-mail nunca passa: nem como "caixa", nem como domínio', () => {
  const v = validarPayload({
    clientes: [{ cnpj: '11222333000181', caixas: ['fulano@escritorial.com.br', 'Bruno'] }],
    nao_identificados: [{ dominio: 'joao@gmail.com', contatos: 1 }, { dominio: 'fornecedor.com.br', contatos: 2, aguardando: 1, mais_antigo_h: 50 }],
  });
  assert.deepStrictEqual([...v.clientes[0].caixas], ['Bruno']);
  assert.strictEqual(v.dominios.length, 1);
  assert.strictEqual(v.dominios[0].dominio, 'fornecedor.com.br');
  assert.ok(!/@/.test(JSON.stringify(v)));
});
teste('números ruins viram zero; corpo vazio não quebra', () => {
  const v = validarPayload({ clientes: [{ cnpj: '11222333000181', aguardando_4h: -5, aguardando_7d: 'abc', contatos_ativos: 1e12 }] });
  assert.strictEqual(v.clientes[0].aguardando_4h, 0);
  assert.strictEqual(v.clientes[0].aguardando_7d, 0);
  assert.strictEqual(v.clientes[0].contatos_ativos, 100000);
  const vazio = validarPayload(null);
  assert.deepStrictEqual([vazio.clientes.length, vazio.dominios.length, vazio.janela_dias], [0, 0, 14]);
});

teste('histórico 180 dias: aceita nomes e endereços do escritório; endereço de fora nunca entra', () => {
  const v = validarAtendimento({ janela_dias: 180, caixas_lidas: 41, clientes: [{ cnpj: '11.222.333/0001-81', recebidos: 9, sem_resposta: 2, destinatarios: [
    { nome: 'dptofiscal@escritorial.com.br', grupo: true, recebidos: 5, sem: 2 }, { nome: 'legalizacao@escritorialcontabil.com.br', grupo: true, recebidos: 1, sem: 0 },
    { nome: 'Guilherme', recebidos: 3, sem: 0 }, { nome: 'joao@padaria.com.br', recebidos: 4, sem: 1 }, { nome: '', recebidos: 1, sem: 0 }] },
    { cnpj: '123', recebidos: 1 }, { cnpj: '11222333000181', recebidos: 1 }] });
  assert.strictEqual(v.clientes.length, 1);                                  // CNPJ inválido e repetido saem
  assert.deepStrictEqual(v.clientes[0].destinatarios.map((d) => d.nome), ['dptofiscal@escritorial.com.br', 'legalizacao@escritorialcontabil.com.br', 'Guilherme']);
  assert.deepStrictEqual([v.clientes[0].recebidos, v.clientes[0].sem_resposta, v.janela_dias], [9, 2, 180]);
  assert.strictEqual(validarAtendimento(null).clientes.length, 0);
});

teste('histórico 180 dias: guarda os dias [recebidos, sem] de cada destinatário e descarta chave que não é data', () => {
  const v = validarAtendimento({ clientes: [{ cnpj: '11222333000181', recebidos: 3, sem_resposta: 1, destinatarios: [
    { nome: 'Guilherme', recebidos: 3, sem: 1, dias: { '2026-10-01': [2, 0], '2026-10-15': [1, 1], 'joao@padaria.com.br': [9, 9], 'x': [1, 1], '2026-10-16': 'texto' } }] }] });
  assert.deepStrictEqual(v.clientes[0].destinatarios[0].dias, { '2026-10-01': [2, 0], '2026-10-15': [1, 1] });
  assert.deepStrictEqual(validarAtendimento({ clientes: [{ cnpj: '11222333000181', destinatarios: [{ nome: 'Ana', recebidos: 1, sem: 0 }] }] }).clientes[0].destinatarios[0].dias, {}, 'leitura antiga, sem dias');
});
console.log(`\n${ok} testes passaram.`);
process.exit(0);
