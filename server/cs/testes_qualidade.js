'use strict';
// Rodar: node server/cs/testes_qualidade.js  (validação dos registros de Qualidade; sem banco)
const assert = require('assert');
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://x:x@localhost:5432/x';
const { validarRegistro, validarMudanca, situacao, semAcento, TIPOS, DEPARTAMENTOS } = require('./qualidade');

let ok = 0;
const teste = (nome, fn) => { fn(); ok++; console.log('  ok -', nome); };
const HOJE = '2026-10-16';
const base = { cliente_id: '123', tipo: 'Erro', departamentos: ['Fiscal'], detalhe: 'Guia enviada com valor errado ao cliente.', analista_id: '7', prazo: '2026-10-20' };

teste('aceita um registro completo e limpa os espaços', () => {
  const v = validarRegistro(Object.assign({}, base, { detalhe: '  Guia   enviada com valor errado  ' }), HOJE);
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.valores.detalhe, 'Guia enviada com valor errado');
  assert.deepStrictEqual(v.valores.departamentos, ['Fiscal']);
});
teste('tipos aceitos são os sete combinados; qualquer outro é recusado', () => {
  assert.deepStrictEqual(TIPOS, ['Multa', 'Erro', 'Reclamação', 'Atraso', 'Falha de atendimento', 'Falha técnica', 'Outros']);
  TIPOS.forEach((t) => assert.strictEqual(validarRegistro(Object.assign({}, base, { tipo: t }), HOJE).ok, true, t));
  assert.strictEqual(validarRegistro(Object.assign({}, base, { tipo: 'Elogio' }), HOJE).ok, false);
});
teste('"Todos" vira todos os departamentos; departamento desconhecido é ignorado; vazio é recusado', () => {
  assert.deepStrictEqual(validarRegistro(Object.assign({}, base, { departamentos: ['Todos'] }), HOJE).valores.departamentos, DEPARTAMENTOS);
  assert.deepStrictEqual(validarRegistro(Object.assign({}, base, { departamentos: ['Fiscal', 'Marte', 'Contábil'] }), HOJE).valores.departamentos, ['Contábil', 'Fiscal']);
  assert.strictEqual(validarRegistro(Object.assign({}, base, { departamentos: ['Marte'] }), HOJE).ok, false);
  assert.strictEqual(validarRegistro(Object.assign({}, base, { departamentos: [] }), HOJE).ok, false);
});
teste('descrição: mínimo de 5 e máximo de 600 caracteres', () => {
  assert.strictEqual(validarRegistro(Object.assign({}, base, { detalhe: 'oi' }), HOJE).ok, false);
  assert.strictEqual(validarRegistro(Object.assign({}, base, { detalhe: 'a'.repeat(600) }), HOJE).ok, true);
  assert.strictEqual(validarRegistro(Object.assign({}, base, { detalhe: 'a'.repeat(601) }), HOJE).ok, false);
});
teste('prazo: hoje vale, ontem não, além de um ano não; cliente e analista são obrigatórios', () => {
  assert.strictEqual(validarRegistro(Object.assign({}, base, { prazo: '2026-10-16' }), HOJE).ok, true);
  assert.strictEqual(validarRegistro(Object.assign({}, base, { prazo: '2026-10-15' }), HOJE).ok, false);
  assert.strictEqual(validarRegistro(Object.assign({}, base, { prazo: '2027-10-17' }), HOJE).ok, false);
  assert.strictEqual(validarRegistro(Object.assign({}, base, { prazo: '16/10/2026' }), HOJE).ok, false);
  assert.strictEqual(validarRegistro(Object.assign({}, base, { cliente_id: '' }), HOJE).ok, false);
  assert.strictEqual(validarRegistro(Object.assign({}, base, { analista_id: '' }), HOJE).ok, false);
});
teste('mudança: status válido; resolver exige a tratativa; prazo no passado é recusado', () => {
  assert.strictEqual(validarMudanca({ status: 'em_tratamento' }, HOJE).ok, true);
  assert.strictEqual(validarMudanca({ status: 'resolvido' }, HOJE).ok, false);
  assert.strictEqual(validarMudanca({ status: 'resolvido', tratativa: 'Guia reenviada e cliente avisado' }, HOJE).ok, true);
  assert.strictEqual(validarMudanca({ status: 'sumiu' }, HOJE).ok, false);
  assert.strictEqual(validarMudanca({ prazo: '2026-10-01' }, HOJE).ok, false);
  assert.strictEqual(validarMudanca({}, HOJE).ok, false);
});
teste('situação: aberto ou em tratamento com prazo vencido vira "vencido"; resolvido nunca', () => {
  assert.strictEqual(situacao('aberto', '2026-10-15', HOJE), 'vencido');
  assert.strictEqual(situacao('em_tratamento', '2026-10-16', HOJE), 'em_tratamento');
  assert.strictEqual(situacao('resolvido', '2026-10-01', HOJE), 'resolvido');
});
teste('o nome do login casa com o analista sem acento nem caixa', () => {
  assert.strictEqual(semAcento('  Denísa  XAVIER '), 'denisa xavier');
});

console.log(`\n${ok} testes passaram.`);
process.exit(0);
