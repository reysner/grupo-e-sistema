'use strict';
// Rodar: node server/questor/testes_questor.js  (lógica pura, sem rede nem banco)
const assert = require('assert');
const { periodoDeExtracao } = require('./periodo');
const { parseFaturamento, entradaValida } = require('./faturamentoParse');

let ok = 0;
const teste = (nome, fn) => { fn(); ok++; console.log('  ok -', nome); };

teste('período: antes do dia 25 o último mês fechado é o retrasado (08/10/2026 → 09/2025 a 08/2026)', () => {
  const p = periodoDeExtracao({ ano: 2026, mes: 10, dia: 8 });
  assert.deepStrictEqual([p.competIni, p.competFim, p.ini, p.fim, p.dataIni, p.dataFim], ['09/2025', '08/2026', '2025-09', '2026-08', '01/09/2025', '31/08/2026']);
});
teste('período: a partir do dia 25 o último mês fechado é o anterior (26/10/2026 → 10/2025 a 09/2026)', () => {
  const p = periodoDeExtracao({ ano: 2026, mes: 10, dia: 26 });
  assert.deepStrictEqual([p.competIni, p.competFim, p.dataFim], ['10/2025', '09/2026', '30/09/2026']);
  assert.strictEqual(periodoDeExtracao({ ano: 2026, mes: 10, dia: 25 }).competFim, '09/2026');   // dia 25 já vale
  assert.strictEqual(periodoDeExtracao({ ano: 2026, mes: 10, dia: 24 }).competFim, '08/2026');
});
teste('período: virada de ano e fevereiro bissexto', () => {
  const j = periodoDeExtracao({ ano: 2027, mes: 1, dia: 26 });
  assert.deepStrictEqual([j.competIni, j.competFim, j.dataFim], ['01/2026', '12/2026', '31/12/2026']);
  const j2 = periodoDeExtracao({ ano: 2027, mes: 1, dia: 10 });
  assert.deepStrictEqual([j2.competIni, j2.competFim], ['12/2025', '11/2026']);
  assert.strictEqual(periodoDeExtracao({ ano: 2028, mes: 3, dia: 26 }).dataFim, '29/02/2028');  // fim = fevereiro bissexto
});

const CSV = [
  '', '"1014  2S RIBEIROSERVICOS ADMINISTRATIVOS LTDA";"09/10/2026 08:11 Pág:0001"', '"CNPJ: 45.459.079/0001-51";"Período: 01/09/2025 a 31/08/2026"', '', '"Demonstrativo Mensal do Faturamento"', '',
  '"MÊS";"ANO";"FATURADO (R$)"', '"SETEMBRO";2025;17.693,54', '"OUTUBRO";2025;17.693,54', '"NOVEMBRO";2025;17.693,54', '"DEZEMBRO";2025;17.693,54',
  '"JANEIRO";2026;18.447,28', '"FEVEREIRO";2026;18.447,28', '"MARÇO";2026;18.447,28', '"ABRIL";2026;18.447,28', '"MAIO";2026;18.447,28', '"JUNHO";2026;18.447,28',
  '"JULHO";2026;18.447,28', '"AGOSTO";2026;18.447,28', '"TOTAL";;218.352,40',
  '"9992  Empresa Padrão";"09/10/2026 08:11 Pág:0002"', '"CNPJ: 04.300.645/0001-09";"Período: 01/09/2025 a 31/08/2026"', '"SETEMBRO";2025;0,00', '"TOTAL";;0,00',
].join('\r\n');

teste('relatório: lê empresa, CNPJ, 12 meses e total; valida a soma', () => {
  const e = parseFaturamento(CSV);
  assert.strictEqual(e.length, 2);
  assert.deepStrictEqual([e[0].codigo, e[0].cnpj, e[0].meses.length, e[0].total], ['1014', '45459079000151', 12, 218352.4]);
  assert.strictEqual(entradaValida(e[0]), true);
});
teste('relatório: página incompleta (sem 12 meses) não vale; total que não bate com a soma não vale', () => {
  const e = parseFaturamento(CSV);
  assert.strictEqual(entradaValida(e[1]), false);
  const errada = { ...e[0], total: 218000 };
  assert.strictEqual(entradaValida(errada), false);
  assert.strictEqual(entradaValida({ ...e[0], cnpj: null }), false);
});

teste('avisos do Questor: naturezas sem configuração de faturamento por empresa/filial', () => {
  const { avisosPorEstab } = require('./faturamentoParse');
  const m = avisosPorEstab([
    'Empresa: 0010 BRASTRUCK LTDA-MATRIZ - Existem Naturezas com movimentação: 6103002, mas sem a configuração de Faturamento. Para configurar, acesse: Operações > Configurações.',
    'Empresa: 0406 HEMMER, RIBEIRO, FINOTTI E FERREIRA SOCIEDADE DE ADVOGADOS-Filial 2 - Existem Naturezas com movimentação: 9000002, 9000003, mas sem a configuração de Faturamento. Para configurar',
    'Empresa: 0406 HEMMER, RIBEIRO, FINOTTI E FERREIRA SOCIEDADE DE ADVOGADOS-Filial 2 - Existem Naturezas com movimentação: 9000002, mas sem a configuração de Faturamento.',
    'mensagem qualquer que não é desse tipo',
  ]);
  assert.deepStrictEqual(m.get('10|1'), ['6103002']);
  assert.deepStrictEqual(m.get('406|2'), ['9000002', '9000003']);
  assert.strictEqual(m.size, 2);
});

console.log(`\n${ok} testes passaram.`);
process.exit(0);
