'use strict';
// Rodar: node server/cs/testes_analistas_nomes.js  (plano do ajuste único dos nomes; sem banco)
const assert = require('assert');
const { planejar, RENOMEAR } = require('./analistasNomes');
let ok = 0;
const teste = (nome, fn) => { fn(); ok++; console.log('  ok -', nome); };
const lista = [
  { id: 1, nome: 'Bruno Cortez' }, { id: 2, nome: 'Bruno Xavier' }, { id: 3, nome: 'Daniel' }, { id: 4, nome: 'Denisa- Diretora Dpto Pessoal ' },
  { id: 5, nome: 'Nathânia' }, { id: 6, nome: 'Maira Soares' }, { id: 7, nome: 'Joao Victor' }, { id: 8, nome: 'Thais' },
];

teste('renomeia casando sem acento, caixa nem espaço sobrando; quem já está completo fica', () => {
  const p = planejar(lista);
  const por = Object.fromEntries(p.renomear.map((r) => [r.id, r.para]));
  assert.strictEqual(por[1], 'Bruno Henrique Cortez');
  assert.strictEqual(por[2], 'Bruno Cesar Xavier');
  assert.strictEqual(por[4], 'Denisa Maria Ribeiro Souza Xavier');
  assert.strictEqual(por[5], 'Nathania Andrade Conceição');
  assert.strictEqual(por[7], 'Joao Victor Moraes de Almeida Vasconcelos');
  assert.strictEqual(por[6], undefined);                         // Maira Soares já está igual
});
teste('inclui a Annaisa e tira o Daniel; segunda rodada não repete nada', () => {
  const p = planejar(lista);
  assert.deepStrictEqual(p.incluir, ['Annaisa Alves de Oliveira']);
  assert.deepStrictEqual(p.sairam, [{ id: 3, nome: 'Daniel' }]);
  const depois = lista.filter((a) => a.id !== 3).map((a) => ({ id: a.id, nome: (p.renomear.find((r) => r.id === a.id) || {}).para || a.nome })).concat([{ id: 9, nome: 'Annaisa Alves de Oliveira' }]);
  const p2 = planejar(depois);
  assert.deepStrictEqual([p2.renomear.length, p2.incluir.length, p2.sairam.length], [0, 0, 0]);
});
teste('não duplica: se já existe alguém com o nome completo, o renomear é pulado', () => {
  const p = planejar([{ id: 1, nome: 'Guilherme' }, { id: 2, nome: 'Guilherme de Barros Amaro' }]);
  assert.strictEqual(p.renomear.length, 0);
});
teste('a planilha tem 27 pares (26 renomeações e a Maira já completa)', () => { assert.strictEqual(RENOMEAR.length, 27); });

console.log(`\n${ok} testes passaram.`);
process.exit(0);
