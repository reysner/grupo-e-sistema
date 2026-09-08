'use strict';
/**
 * node --test server/arquivoMorto/nomes.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizar, faixaDeLetra } = require('./nomes');

test('normalizar: acento, cedilha e til somem', () => {
  assert.equal(normalizar('Ótica São João Ltda'), 'OTICA SAO JOAO LTDA');
  assert.equal(normalizar('CONSTRUÇÃO CIVIL'), 'CONSTRUCAO CIVIL');
});

test('normalizar: "&" e "E" ficam equivalentes', () => {
  assert.equal(normalizar('M&F Participações Ltda'), normalizar('M E F PARTICIPACOES LTDA'));
  assert.equal(normalizar('PITTELLI & PITTELLI'), 'PITTELLI E PITTELLI');
});

test('normalizar: espaços colapsados e trim', () => {
  assert.equal(normalizar('  ACADEMIA   VIDATIVA  LTDA  '), 'ACADEMIA VIDATIVA LTDA');
});

test('normalizar: mantém sufixo/filial (desambigua)', () => {
  assert.equal(normalizar('Cardoso Adega Ltda - Filial Uberaba'), 'CARDOSO ADEGA LTDA - FILIAL UBERABA');
});

test('faixaDeLetra: intervalos', () => {
  assert.equal(faixaDeLetra('ACADEMIA'), 'A a D');
  assert.equal(faixaDeLetra('DELTA'), 'A a D');
  assert.equal(faixaDeLetra('ESCRITORIAL'), 'E a L');
  assert.equal(faixaDeLetra('LUME'), 'E a L');
  assert.equal(faixaDeLetra('MERCADO'), 'M a R');
  assert.equal(faixaDeLetra('RASA'), 'M a R');
  assert.equal(faixaDeLetra('SIGMA'), 'S a T');
  assert.equal(faixaDeLetra('TOTAL'), 'S a T');
  assert.equal(faixaDeLetra('UNIAO'), 'U a Z');
  assert.equal(faixaDeLetra('ZEN'), 'U a Z');
});

test('faixaDeLetra: número/símbolo cai em "A a D"', () => {
  assert.equal(faixaDeLetra(normalizar('3 Corações Alimentos')), 'A a D');
  assert.equal(faixaDeLetra(normalizar('@ Publicidade')), 'A a D');
  assert.equal(faixaDeLetra(''), 'A a D');
});
