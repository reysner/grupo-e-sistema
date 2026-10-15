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

const { parseAtivos, parseOptantes, funcionariosDoAno, rotuloRegime } = require('./anual');
teste('parseAtivos lê o total de empregados por empresa e competência', () => {
  const csv = [
    '"Relação de Empregados Ativos";"14/10/2026 22:31";"Pág:0001"', '"Código Empresa";"Nome Empresa";;', '',
    '1271;"CARDOSO ADEGA LTDA";', '"Compet.";"Total Empregados"', '05/2025;"       61";', '12/2025;"       63";', '',
    '1272;"OUTRA LTDA";', '"Compet.";"Total Empregados"', '12/2025;"        2";',
  ].join('\n');
  const r = parseAtivos(csv);
  assert.deepStrictEqual({ ...r['1271'] }, { '2025-05': 61, '2025-12': 63 });
  assert.deepStrictEqual({ ...r['1272'] }, { '2025-12': 2 });
});
teste('funcionariosDoAno: último mês com folha do ano e média; sem folha = null', () => {
  const m = { '2025-05': 61, '2025-06': 59, '2025-12': 63, '2024-12': 40 };
  assert.deepStrictEqual({ ...funcionariosDoAno(m, 2025) }, { funcionarios: 63, funcionarios_media: 61, meses_com_folha: 3 });
  assert.strictEqual(funcionariosDoAno(m, 2023).funcionarios, null);
});
teste('parseOptantes pega só quem tem opção "Sim" e o documento da linha da empresa', () => {
  const csv = [
    '"Fiscal";"14/10/2026 22:27 Pág:0001"', '"Data Base: 31/12/2025"',
    '"Empresa: 0003  LUZIA REGINA DE OLIVEIRA DOMINGUES - ME, CNPJ: 21.266.796/0001-07"',
    '"Sim";01/01/2018;"6106/3  SIMPLES Nacional";"Competência";"Microempresa";"Junto SIMPLES";;"Junto SIMPLES";', '""',
    '"Empresa: 0008  OUTRA - ME, CNPJ: 23.922.390/0001-52"',
    '"Não";01/01/2018;"6106/3  SIMPLES Nacional";"Competência";"Microempresa";"Junto SIMPLES";;"Junto SIMPLES";',
  ].join('\n');
  const r = parseOptantes(csv);
  assert.deepStrictEqual([...r], ['21266796000107']);
});
teste('rotuloRegime: Simples vence; depois Real, Presumido; senão "Fora do Simples"', () => {
  const c = { simples: new Set(['1']), real: new Set(['2']), presumido: new Set(['3']) };
  assert.strictEqual(rotuloRegime('1', c), 'Simples Nacional');
  assert.strictEqual(rotuloRegime('2', c), 'Lucro Real');
  assert.strictEqual(rotuloRegime('3', c), 'Lucro Presumido');
  assert.strictEqual(rotuloRegime('4', c), 'Fora do Simples');
});

const { regimeDaReceita } = require('./anual');
teste('regime pela Receita: ECF do ano; senão Simples; senão a última ECF; senão "saiu do Simples"; senão nada', () => {
  const j = { opcao_pelo_simples: false, data_opcao_pelo_simples: '2018-01-01', data_exclusao_do_simples: '2021-06-30', opcao_pelo_mei: false,
    regime_tributario: [{ ano: 2022, forma_de_tributacao: 'LUCRO PRESUMIDO', cnpj_da_scp: null }, { ano: 2023, forma_de_tributacao: 'LUCRO REAL', cnpj_da_scp: null }, { ano: 2023, forma_de_tributacao: 'LUCRO PRESUMIDO', cnpj_da_scp: '99999999000100' }] };
  assert.deepStrictEqual({ ...regimeDaReceita(j, 2022) }, { regime: 'Lucro Presumido', fonte: 'Receita (ECF 2022)' });
  assert.strictEqual(regimeDaReceita(j, 2023).regime, 'Lucro Real');                 // a SCP não vale
  assert.deepStrictEqual({ ...regimeDaReceita(j, 2019) }, { regime: 'Simples Nacional', fonte: 'Receita (Simples)' });
  assert.deepStrictEqual({ ...regimeDaReceita(j, 2021) }, { regime: 'Lucro (Presumido/Real)', fonte: 'Receita (saiu do Simples em 2021)' });   // saiu do Simples em 06/2021, sem ECF de 2021
  assert.strictEqual(regimeDaReceita(j, 2016), null);                                // antes da opção, sem ECF anterior
  // 2025 ainda sem ECF publicada: vale a última conhecida (2023), indicada
  assert.deepStrictEqual({ ...regimeDaReceita(j, 2025) }, { regime: 'Lucro Real', fonte: 'Receita (última ECF: 2023)' });
  // Simples hoje e sem exclusão: Simples nos anos cobertos
  assert.deepStrictEqual({ ...regimeDaReceita({ opcao_pelo_simples: true, opcao_pelo_mei: true, data_opcao_pelo_simples: '2020-03-01', data_exclusao_do_simples: null, regime_tributario: [] }, 2024) }, { regime: 'Simples Nacional', fonte: 'Receita (MEI, dentro do Simples)' });
  // opção e exclusão no mesmo dia (período zerado): não é Simples
  assert.strictEqual(regimeDaReceita({ opcao_pelo_simples: false, data_opcao_pelo_simples: '2007-07-01', data_exclusao_do_simples: '2007-07-01', regime_tributario: [] }, 2015), null);
  assert.strictEqual(regimeDaReceita(null, 2024), null);
});
teste('regime: ECF antiga + saída do Simples depois dela = genérico; carry-forward só sem Simples no meio', () => {
  const saiu = { data_opcao_pelo_simples: '2020-01-01', data_exclusao_do_simples: '2023-12-31', regime_tributario: [{ ano: 2018, forma_de_tributacao: 'LUCRO PRESUMIDO', cnpj_da_scp: null }] };
  assert.strictEqual(regimeDaReceita(saiu, 2025).regime, 'Lucro (Presumido/Real)');   // esteve no Simples depois da ECF e saiu: só se sabe que não é Simples
  assert.strictEqual(regimeDaReceita(saiu, 2021).regime, 'Simples Nacional');
  const semSimples = { data_opcao_pelo_simples: null, data_exclusao_do_simples: null, regime_tributario: [{ ano: 2019, forma_de_tributacao: 'LUCRO PRESUMIDO', cnpj_da_scp: null }] };
  assert.deepStrictEqual({ ...regimeDaReceita(semSimples, 2026) }, { regime: 'Lucro Presumido', fonte: 'Receita (última ECF: 2019)' });
});

console.log(`\n${ok} testes passaram.`);
process.exit(0);
