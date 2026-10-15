'use strict';
// Rodar: node server/cs/testes_honorario_sugerido.js  (validação do percentual do honorário sugerido; sem banco)
const assert = require('assert');
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://x:x@localhost:5432/x';
const { validar } = require('./honorarioSugerido');

let ok = 0;
const teste = (nome, fn) => { fn(); ok++; console.log('  ok -', nome); };

teste('aceita percentual com vírgula ou ponto e arredonda', () => {
  assert.deepStrictEqual({ ...validar({ percentual: '0,5', limite_amarelo: 80 }).valor }, { percentual: 0.5, limite_amarelo: 80 });
  assert.deepStrictEqual({ ...validar({ percentual: 1.2345678, limite_amarelo: '75' }).valor }, { percentual: 1.235, limite_amarelo: 75 });
});
teste('sem limite informado usa 80', () => {
  assert.strictEqual(validar({ percentual: 0.4 }).valor.limite_amarelo, 80);
});
teste('percentual vazio apaga o valor (colunas voltam a mostrar "—")', () => {
  const v = validar({ percentual: null, limite_amarelo: 80 });
  assert.ok(v.ok);
  assert.strictEqual(v.valor.percentual, null);
  assert.strictEqual(validar({ percentual: '' }).valor.percentual, null);
});
teste('recusa percentual zero, negativo, acima de 100 ou texto', () => {
  ['0', -1, 101, 'abc', '1,2,3'].forEach((p) => assert.strictEqual(validar({ percentual: p, limite_amarelo: 80 }).ok, false, String(p)));
});
teste('recusa limite do amarelo fora de 1 a 99', () => {
  [0, 100, 150, 'x'].forEach((l) => assert.strictEqual(validar({ percentual: 0.5, limite_amarelo: l }).ok, false, String(l)));
});

console.log(`\n${ok} testes passaram.`);
process.exit(0);
