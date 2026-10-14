'use strict';
// Rodar: node server/testes_legalizacao_retrato.js  (lógica pura, sem banco)
const assert = require('assert');
const { semanaDe, retratoDeLinhas, itemDe } = require('./legalizacaoRetrato');

let ok = 0;
const teste = (nome, fn) => { fn(); ok++; console.log('  ok -', nome); };

teste('semana vai de segunda a domingo', () => {
  assert.strictEqual(semanaDe('2026-10-12'), '2026-10-12');
  assert.strictEqual(semanaDe('2026-10-14'), '2026-10-12');
  assert.strictEqual(semanaDe('2026-10-18'), '2026-10-12');
  assert.strictEqual(semanaDe('2026-10-19'), '2026-10-19');
  assert.strictEqual(semanaDe('2027-01-01'), '2026-12-28');
});

const linhas = [
  { func: { status: 'vencido' }, sanit: { status: 'ok' }, cert: { tipo: 'pj', status: 'vencendo' }, ecac: { status: 'ok' }, fgts: { status: 'sem_data' } },
  { func: { status: 'solicitacao' }, sanit: null, cert: { tipo: 'pf', status: 'vencido' }, ecac: { status: 'ok' }, fgts: { status: 'ok' } },
  { func: { status: 'ok' }, sanit: null, cert: { tipo: 'pj', status: 'ok' }, ecac: null, fgts: null },
];

teste('item: certificado PF e PJ saem do mesmo campo cert, separados pelo tipo', () => {
  assert.strictEqual(itemDe(linhas[0], 'cert_pj').status, 'vencendo');
  assert.strictEqual(itemDe(linhas[0], 'cert_pf'), null);
  assert.strictEqual(itemDe(linhas[1], 'cert_pf').status, 'vencido');
  assert.strictEqual(itemDe(linhas[2], 'sanit'), null);
});
teste('retrato conta documentos por tipo e situação', () => {
  const r = retratoDeLinhas(linhas, '2026-10-14');
  assert.strictEqual(r.semana, '2026-10-12');
  assert.strictEqual(r.clientes, 3);
  assert.deepStrictEqual([r.vencidos, r.vencendo, r.solicitacao, r.em_dia, r.sem_data], [2, 1, 1, 6, 1]);
  assert.deepStrictEqual(r.por_tipo.cert_pj, { total: 2, vencido: 0, vencendo: 1, solicitacao: 0, ok: 1, sem_data: 0 });
  assert.deepStrictEqual(r.por_tipo.cert_pf, { total: 1, vencido: 1, vencendo: 0, solicitacao: 0, ok: 0, sem_data: 0 });
  assert.strictEqual(r.por_tipo.func.total, 3);
});
teste('status desconhecido conta como sem data; lista vazia não quebra', () => {
  const r = retratoDeLinhas([{ func: { status: 'desativado' } }], '2026-10-14');
  assert.strictEqual(r.sem_data, 1);
  const v = retratoDeLinhas([], '2026-10-14');
  assert.deepStrictEqual([v.clientes, v.vencidos, v.em_dia], [0, 0, 0]);
});

console.log(`\n${ok} testes passaram.`);
process.exit(0);
