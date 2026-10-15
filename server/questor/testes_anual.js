'use strict';
// Rodar: node server/questor/testes_anual.js  (lógica pura, sem nWeb)
const assert = require('assert');
const { agregarPorAno, mesesEsperados } = require('./anual');
const { parseFaturamento } = require('./faturamentoParse');

let ok = 0;
const teste = (nome, fn) => { fn(); ok++; console.log('  ok -', nome); };

// CSV no formato do nFisRRFaturamento, em duas páginas (a primeira sem TOTAL, a última com o TOTAL do período todo)
const csv = [
  '"0428  BELL ACO LTDA - MATRIZ";"14/10/2026 21:43 Pág:0001"',
  '"CNPJ: 09.076.689/0001-02";"Período: 01/01/2024 a 31/03/2025"', '',
  '"MÊS";"ANO";"FATURADO (R$)"', '',
  '"JANEIRO";2024;1.000,00', '', '"FEVEREIRO";2024;2.000,50', '', '"MARÇO";2024;0,00', '', '',
  '"0428  BELL ACO LTDA - MATRIZ";"14/10/2026 21:43 Pág:0002"',
  '"CNPJ: 09.076.689/0001-02";"Período: 01/01/2024 a 31/03/2025"', '',
  '"MÊS";"ANO";"FATURADO (R$)"', '',
  '"JANEIRO";2025;3.000,00', '', '"FEVEREIRO";2025;-100,00', '',
  '"TOTAL";;5.900,50',
].join('\n');

teste('soma os meses por ano, junta as páginas e confere o TOTAL', () => {
  const r = agregarPorAno(parseFaturamento(csv), '09076689000102');
  assert.strictEqual(r.ok, true, r.motivo);
  assert.deepStrictEqual(r.anos['2024'], { faturamento: 3000.5, meses: 3, meses_com_valor: 2 });
  assert.deepStrictEqual(r.anos['2025'], { faturamento: 2900, meses: 2, meses_com_valor: 2 });   // devolução (-100) entra
  assert.strictEqual(r.total, 5900.5);
  assert.strictEqual(r.meses, 5);
});
teste('recusa quando a soma dos meses não bate com o TOTAL', () => {
  const r = agregarPorAno(parseFaturamento(csv.replace('5.900,50', '6.000,00')), '09076689000102');
  assert.strictEqual(r.ok, false);
  assert.ok(/não bate/.test(r.motivo));
});
teste('recusa relatório sem a página final (sem TOTAL) e documento que não aparece', () => {
  const semFim = csv.split('\n').slice(0, 12).join('\n');
  assert.strictEqual(agregarPorAno(parseFaturamento(semFim), '09076689000102').ok, false);
  assert.strictEqual(agregarPorAno(parseFaturamento(csv), '11111111000191').ok, false);
});
teste('mesesEsperados conta de janeiro do ano inicial até o mês final', () => {
  assert.strictEqual(mesesEsperados(2015, '2026-08'), 140);   // 11 anos × 12 + 8 (confere com o teste real na Bell Aço)
  assert.strictEqual(mesesEsperados(2025, '2025-12'), 12);
});

console.log(`\n${ok} testes passaram.`);
process.exit(0);
