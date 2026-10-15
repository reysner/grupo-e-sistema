'use strict';
// Rodar: node server/cs/testes_omie_honorarios.js  (validação da carga do honorário do Omie; sem banco)
const assert = require('assert');
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://x:x@localhost:5432/x';
const { validarCarga } = require('./omieHonorarios');

let ok = 0;
const teste = (nome, fn) => { fn(); ok++; console.log('  ok -', nome); };
const corpo = (itens) => ({ ate: '2026-10', itens });

teste('aceita a carga, limpa o CNPJ e arredonda', () => {
  const v = validarCarga(corpo([{ cnpj: '59.997.421/0001-81', anos: [{ ano: 2025, total: 3573, meses: 9, mensal: 397 }, { ano: 2026, total: 2941.004, meses: 7, mensal: 424 }] }]));
  assert.strictEqual(v.linhas.length, 2);
  assert.deepStrictEqual({ ...v.linhas[1] }, { doc: '59997421000181', ano: 2026, total: 2941, meses: 7, mensal: 424 });
});
teste('ignora documento inválido, zerado (00.000.000/0000-00) e ano repetido', () => {
  const v = validarCarga(corpo([
    { cnpj: '00000000000000', anos: [{ ano: 2025, total: 5499, meses: 10, mensal: 255 }] },
    { cnpj: '123', anos: [{ ano: 2025, total: 1, meses: 1, mensal: 1 }] },
    { cnpj: '09076689000102', anos: [{ ano: 2025, total: 10, meses: 1, mensal: 10 }, { ano: 2025, total: 99, meses: 1, mensal: 99 }] },
  ]));
  assert.strictEqual(v.linhas.length, 1);
  assert.strictEqual(v.linhas[0].total, 10);
});
teste('recusa período, lista vazia e valores inválidos', () => {
  assert.throws(() => validarCarga({ ate: '2026', itens: [{}] }), /ate/);
  assert.throws(() => validarCarga(corpo([])), /itens/);
  assert.throws(() => validarCarga(corpo([{ cnpj: '09076689000102', anos: [{ ano: 2025, total: 'x', meses: 1, mensal: 1 }] }])), /inválido/);
  assert.throws(() => validarCarga(corpo([{ cnpj: '09076689000102', anos: [{ ano: 2025, total: 1, meses: 13, mensal: 1 }] }])), /inválido/);
  assert.throws(() => validarCarga(corpo([{ cnpj: '123', anos: [] }])), /Nenhum documento/);
});

console.log(`\n${ok} testes passaram.`);
process.exit(0);
