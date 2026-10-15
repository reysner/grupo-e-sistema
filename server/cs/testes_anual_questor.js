'use strict';
// Rodar: node server/cs/testes_anual_questor.js  (validação da carga e do percentual; sem banco)
const assert = require('assert');
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://x:x@localhost:5432/x';
const { validarCarga, validarPercentual, validarConfig } = require('./anualQuestor');

let ok = 0;
const teste = (nome, fn) => { fn(); ok++; console.log('  ok -', nome); };
const corpo = (itens) => ({ ate: '2026-08', ano_inicial: 2015, itens });

teste('aceita a carga, limpa o CNPJ, arredonda e limita meses_com_valor', () => {
  const v = validarCarga(corpo([{ cnpj: '09.076.689/0001-02', anos: [{ ano: 2025, faturamento: 14186517.074, meses: 12, meses_com_valor: 14 }, { ano: 2026, faturamento: 8904099.6, meses: 8, meses_com_valor: 8 }] }]));
  assert.strictEqual(v.linhas.length, 2);
  assert.deepStrictEqual({ ...v.linhas[0] }, { doc: '09076689000102', ano: 2025, fat: 14186517.07, meses: 12, mv: 12, fun: null, media: null, regime: null, fonte: null, aviso: null });
});
teste('aceita faturamento zero e negativo (devolução); ignora documento inválido e linha repetida', () => {
  const v = validarCarga(corpo([
    { cnpj: '09076689000102', anos: [{ ano: 2024, faturamento: 0, meses: 12 }, { ano: 2024, faturamento: 5, meses: 12 }, { ano: 2023, faturamento: -50.5, meses: 12 }] },
    { cnpj: '123', anos: [{ ano: 2024, faturamento: 1, meses: 12 }] },
  ]));
  assert.strictEqual(v.linhas.length, 2);
  assert.strictEqual(v.linhas.find((l) => l.ano === 2024).fat, 0);
});
teste('guarda funcionários e regime; faturamento nulo é aceito (não lido no ano)', () => {
  const v = validarCarga(corpo([{ cnpj: '09076689000102', anos: [{ ano: 2025, faturamento: null, meses: 0, funcionarios: 63, funcionarios_media: 58.46, regime: 'Simples Nacional' }] }]));
  assert.deepStrictEqual({ ...v.linhas[0] }, { doc: '09076689000102', ano: 2025, fat: null, meses: 0, mv: 0, fun: 63, media: 58.5, regime: 'Simples Nacional', fonte: null, aviso: null });
  assert.throws(() => validarCarga(corpo([{ cnpj: '09076689000102', anos: [{ ano: 2025, faturamento: 1, meses: 12, funcionarios: -3 }] }])), /inválido/);
  const av = validarCarga(corpo([{ cnpj: '09076689000102', anos: [{ ano: 2025, faturamento: null, meses: 0, regime_fonte: 'Receita (ECF 2023)', aviso: 'x'.repeat(400) }] }]));
  assert.strictEqual(av.linhas[0].aviso.length, 300);
  assert.strictEqual(av.linhas[0].fonte, 'Receita (ECF 2023)');
});
teste('recusa período, ano inicial, lista vazia e valores inválidos', () => {
  assert.throws(() => validarCarga({ ate: '2026', ano_inicial: 2015, itens: [{}] }), /ate/);
  assert.throws(() => validarCarga({ ate: '2026-08', ano_inicial: 'x', itens: [{}] }), /ano_inicial/);
  assert.throws(() => validarCarga(corpo([])), /itens/);
  assert.throws(() => validarCarga(corpo([{ cnpj: '09076689000102', anos: [{ ano: 2024, faturamento: 'abc', meses: 12 }] }])), /inválido/);
  assert.throws(() => validarCarga(corpo([{ cnpj: '09076689000102', anos: [{ ano: 2024, faturamento: 1, meses: 13 }] }])), /inválido/);
  assert.throws(() => validarCarga(corpo([{ cnpj: '123', anos: [] }])), /Nenhum documento/);
});
teste('percentual: aceita vírgula, recusa zero, negativo, texto e acima de 1000', () => {
  assert.strictEqual(validarPercentual('30').valor, 30);
  assert.strictEqual(validarPercentual('12,5').valor, 12.5);
  ['0', '-5', 'abc', '1001', ''].forEach((p) => assert.strictEqual(validarPercentual(p).ok, false, p));
});
teste('config: aceita percentual e/ou corte do reajuste; recusa vazio e valor inválido', () => {
  assert.deepStrictEqual({ ...validarConfig({ percentual: '25' }).valores }, { percentual: 25 });
  assert.deepStrictEqual({ ...validarConfig({ reajuste_min: '7,5' }).valores }, { reajuste_min: 7.5 });
  assert.deepStrictEqual({ ...validarConfig({ percentual: 30, reajuste_min: 5 }).valores }, { percentual: 30, reajuste_min: 5 });
  assert.strictEqual(validarConfig({}).ok, false);
  assert.strictEqual(validarConfig({ reajuste_min: 0 }).ok, false);
  assert.strictEqual(validarConfig({ percentual: 30, reajuste_min: 'abc' }).ok, false);
});

console.log(`\n${ok} testes passaram.`);
process.exit(0);
