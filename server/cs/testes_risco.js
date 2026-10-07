'use strict';
// Rodar: node server/cs/testes_risco.js  (lógica pura, sem banco nem rede)
const assert = require('assert');
const { termometroFinanceiro, termometroAtendimento, termometroOperacional, calcularRisco, diasEntre } = require('./riscoCalculo');

let ok = 0;
const teste = (nome, fn) => { fn(); ok++; console.log('  ok -', nome); };
const HOJE = '2026-10-06';

teste('diasEntre', () => {
  assert.strictEqual(diasEntre('2026-09-06', '2026-10-06'), 30);
  assert.strictEqual(diasEntre('2026-10-06', '2026-10-06'), 0);
});

teste('financeiro: sem dado do Omie não é presumido em dia', () => {
  assert.strictEqual(termometroFinanceiro({ temDado: false }).pontos, null);
  assert.strictEqual(termometroFinanceiro(null).pontos, null);
});

teste('financeiro: em dia = 0; atraso cresce com os dias; 3+ títulos somam 10; crônico garante 70', () => {
  const base = { temDado: true, hoje: HOJE, valorAtrasado: 500 };
  assert.strictEqual(termometroFinanceiro({ ...base, qtdAtrasados: 0 }).pontos, 0);
  assert.strictEqual(termometroFinanceiro({ ...base, qtdAtrasados: 1, maisAntigo: '2026-10-01' }).pontos, 25);   // 5 dias
  assert.strictEqual(termometroFinanceiro({ ...base, qtdAtrasados: 1, maisAntigo: '2026-09-15' }).pontos, 40);   // 21 dias
  assert.strictEqual(termometroFinanceiro({ ...base, qtdAtrasados: 1, maisAntigo: '2026-08-25' }).pontos, 60);   // 42 dias
  assert.strictEqual(termometroFinanceiro({ ...base, qtdAtrasados: 1, maisAntigo: '2026-07-30' }).pontos, 75);   // 68 dias
  assert.strictEqual(termometroFinanceiro({ ...base, qtdAtrasados: 1, maisAntigo: '2026-05-01' }).pontos, 90);   // 158 dias
  assert.strictEqual(termometroFinanceiro({ ...base, qtdAtrasados: 3, maisAntigo: '2026-10-01' }).pontos, 35);   // 25 + 10
  assert.strictEqual(termometroFinanceiro({ ...base, qtdAtrasados: 6, maisAntigo: '2026-05-01' }).pontos, 100);  // limitado a 100
  assert.strictEqual(termometroFinanceiro({ ...base, qtdAtrasados: 0, cronico: true }).pontos, 70);
  assert.ok(termometroFinanceiro({ ...base, qtdAtrasados: 2, maisAntigo: '2026-09-15' }).detalhe[0].includes('2 títulos'));
});

teste('atendimento: sem ocorrências = 0 e explica', () => {
  const r = termometroAtendimento({ tickets90: 4 });
  assert.strictEqual(r.pontos, 0);
  assert.ok(r.detalhe[0].includes('Sem ocorrências'));
  assert.ok(termometroAtendimento({}).detalhe[0].includes('Sem atendimentos'));
});

teste('atendimento: insatisfação pesa pela gravidade e perde metade depois de 90 dias', () => {
  assert.strictEqual(termometroAtendimento({ insatisfacoes: [{ gravidade: 'Alta', dias: 10 }] }).pontos, 30);
  assert.strictEqual(termometroAtendimento({ insatisfacoes: [{ gravidade: 'Muito Alta', dias: 120 }] }).pontos, 20);
  assert.strictEqual(termometroAtendimento({ insatisfacoes: [{ gravidade: 'Média', dias: 200 }] }).pontos, 0); // fora da janela
  assert.strictEqual(termometroAtendimento({ insatisfacoes: [{ gravidade: 'Muito alta', dias: 5 }, { gravidade: 'Alta', dias: 5 }, { gravidade: 'Alta', dias: 5 }] }).pontos, 100);
});

teste('atendimento: notas baixas, SLA vermelho, detratores e sensíveis somam e respeitam o teto', () => {
  assert.strictEqual(termometroAtendimento({ notasBaixas: 2 }).pontos, 40);
  assert.strictEqual(termometroAtendimento({ slaVermelho: 10 }).pontos, 20);
  assert.strictEqual(termometroAtendimento({ detratores: 5 }).pontos, 30);
  assert.strictEqual(termometroAtendimento({ sensiveis: [{ gravidade: 'Alta', dias: 30 }] }).pontos, 22);
  assert.strictEqual(termometroAtendimento({ notasBaixas: 3, slaVermelho: 4, detratores: 2 }).pontos, 100); // 60+20+30 = 110 -> 100
});

teste('atendimento: abandonos (já revisados) somam 15 cada, com teto de 30', () => {
  assert.strictEqual(termometroAtendimento({ abandonos: 1 }).pontos, 15);
  assert.strictEqual(termometroAtendimento({ abandonos: 5 }).pontos, 30);
  assert.ok(termometroAtendimento({ abandonos: 2 }).detalhe[0].includes('2 abandonos'));
});

teste('operacional: sem entregas = sem dado; 50% de problema = 100', () => {
  assert.strictEqual(termometroOperacional({ temDado: false }).pontos, null);
  assert.strictEqual(termometroOperacional({ temDado: true, total: 0 }).pontos, null);
  assert.strictEqual(termometroOperacional({ temDado: true, total: 20, atrasadasEntregues: 0, vencidasPendentes: 0 }).pontos, 0);
  assert.strictEqual(termometroOperacional({ temDado: true, total: 20, atrasadasEntregues: 1, vencidasPendentes: 1 }).pontos, 20);
  assert.strictEqual(termometroOperacional({ temDado: true, total: 10, atrasadasEntregues: 3, vencidasPendentes: 2 }).pontos, 100);
});

teste('risco: média ponderada dos termômetros com dado (pesos iguais) e níveis', () => {
  const t = (f, a, o) => ({ financeiro: { pontos: f, detalhe: ['f'] }, atendimento: { pontos: a, detalhe: ['a'] }, operacional: { pontos: o, detalhe: ['o'] } });
  assert.strictEqual(calcularRisco(t(0, 0, 0)).nivel, 'Baixo');
  const medio = calcularRisco(t(40, 40, 40)); assert.deepStrictEqual([medio.pontos, medio.nivel], [40, 'Médio']);
  const alto = calcularRisco(t(70, 70, 70)); assert.deepStrictEqual([alto.pontos, alto.nivel], [70, 'Alto']);
});

teste('risco: termômetro sem dado fica de fora (não vira zero) e o risco é parcial', () => {
  const r = calcularRisco({ financeiro: { pontos: 60, detalhe: ['f'] }, atendimento: { pontos: 20, detalhe: ['a'] }, operacional: { pontos: null, detalhe: ['sem dado'] } });
  assert.strictEqual(r.pontos, 40);      // (60+20)/2, não (60+20+0)/3
  assert.strictEqual(r.parcial, true);
  assert.deepStrictEqual(r.sem_dado, ['operacional']);
});

teste('risco: um termômetro muito alto sozinho dá alerta e sobe pra Médio', () => {
  const r = calcularRisco({ financeiro: { pontos: 90, detalhe: ['f'] }, atendimento: { pontos: 0, detalhe: ['a'] }, operacional: { pontos: 0, detalhe: ['o'] } });
  assert.strictEqual(r.pontos, 30);      // 90/3 = 30 -> já seria Médio
  assert.strictEqual(r.alerta, true);
  const r2 = calcularRisco({ financeiro: { pontos: 80, detalhe: ['f'] }, atendimento: { pontos: 0, detalhe: ['a'] }, operacional: { pontos: 0, detalhe: ['o'] }, }, { financeiro: 1, atendimento: 1, operacional: 5 });
  assert.strictEqual(r2.pontos, 11);     // pesos mudam a conta: 80/7
  assert.strictEqual(r2.nivel, 'Médio'); // mas o alerta impede de ficar Baixo
});

teste('risco: sem nenhum dado = Incompleto', () => {
  const r = calcularRisco({ financeiro: { pontos: null }, atendimento: { pontos: null }, operacional: { pontos: null } });
  assert.deepStrictEqual([r.nivel, r.pontos], ['Incompleto', null]);
});

teste('risco: motivos vêm dos termômetros que pesam, do maior pro menor', () => {
  const r = calcularRisco({ financeiro: { pontos: 25, detalhe: ['fin'] }, atendimento: { pontos: 60, detalhe: ['atend1', 'atend2'] }, operacional: { pontos: 0, detalhe: ['oper ok'] } });
  assert.deepStrictEqual(r.motivos, ['atend1', 'atend2', 'fin']);
});

teste('entregas: usa o Status do Acessórias (PzTéc não é atraso; dispensada não conta; Atrasada! e pendente vencida são problema)', () => {
  const { classificarEntregas } = require('./risco');
  const lista = [
    { status: 'Ent. antecipada', prazo: '2026-07-10', atraso: '2026-07-15', entrega: '2026-07-09' },
    { status: 'Ent. PzTéc', prazo: '2026-08-09', atraso: '2026-08-14', entrega: '2026-08-11' },
    { status: 'Ent. atrasada', prazo: '2026-08-09', atraso: '2026-08-14', entrega: '2026-08-20' },
    { status: 'Atrasada!', prazo: '2026-07-26', atraso: '2026-07-31', entrega: null },
    { status: 'Dispensada', prazo: '2026-08-07', atraso: '2026-08-14', entrega: null },
    { status: 'Pendente', prazo: '2026-09-01', atraso: '2026-09-05', entrega: null },
    { status: 'Pendente', prazo: '2026-10-20', atraso: '2026-10-25', entrega: null },
  ];
  assert.deepStrictEqual(classificarEntregas(lista, HOJE), { total: 6, atrasadasEntregues: 1, vencidasPendentes: 2 });
  assert.deepStrictEqual(classificarEntregas([], HOJE), { total: 0, atrasadasEntregues: 0, vencidasPendentes: 0 });
});

console.log(`\n${ok} testes passaram.`);
process.exit(0);
