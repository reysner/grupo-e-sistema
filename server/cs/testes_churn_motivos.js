'use strict';
// Rodar: node server/cs/testes_churn_motivos.js  (motivo efetivo e fechamento do mês; sem banco)
const assert = require('assert');
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://x:x@localhost:5432/x';
const { validarNovoMotivo, montarFechamento, motivoEfetivo, ultimoDia, mesAnterior } = require('./churnMotivos');
const { PADROES_PADRAO } = require('./churnSaidas');

let ok = 0;
const teste = (nome, fn) => { fn(); ok++; console.log('  ok -', nome); };
const MOTIVOS = ['Churn financeiro por inadimplência', 'Churn por experiência técnica', 'Churn motivado por decisão pessoal'];
const cnpj = (n) => String(n).padStart(14, '0').replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
const ativo = (n, entrada) => ({ id: 'a' + n, nome: 'ATIVO ' + n, cnpj: cnpj(10000000000000 + n), data_entrada: entrada || '2020-01-01', data_saida: null, motivo_saida: null, motivo_acessorias: null });
const saiu = (n, saida, extra) => Object.assign({ id: 's' + n, nome: 'SAIU ' + n, cnpj: cnpj(20000000000000 + n), data_entrada: '2020-01-01', data_saida: saida, motivo_saida: null, motivo_acessorias: 'Transferida por preço' }, extra || {});

teste('motivo efetivo: o do painel vale; senão o da Gestão de Clientes, se for da lista (sem acento/caixa); senão vazio', () => {
  assert.strictEqual(motivoEfetivo({ motivo_churn: 'Churn por experiência técnica', motivo_saida: 'x' }, MOTIVOS), 'Churn por experiência técnica');
  assert.strictEqual(motivoEfetivo({ motivo_churn: null, motivo_saida: 'churn financeiro por inadimplencia' }, MOTIVOS), 'Churn financeiro por inadimplência');
  assert.strictEqual(motivoEfetivo({ motivo_churn: null, motivo_saida: 'Baixa de empresa' }, MOTIVOS), null);
  assert.strictEqual(motivoEfetivo({}, MOTIVOS), null);
});
teste('"Outro": o motivo novo precisa de 3 a 120 letras, espaços sobrando saem e "Outro" sozinho não vale', () => {
  assert.deepStrictEqual(validarNovoMotivo('  Churn por   mudança de contador  '), { ok: true, nome: 'Churn por mudança de contador' });
  assert.strictEqual(validarNovoMotivo('ab').ok, false);
  assert.strictEqual(validarNovoMotivo('').ok, false);
  assert.strictEqual(validarNovoMotivo(null).ok, false);
  assert.strictEqual(validarNovoMotivo('x'.repeat(121)).ok, false);
  assert.strictEqual(validarNovoMotivo('x'.repeat(120)).ok, true);
  assert.strictEqual(validarNovoMotivo(' OUTRO ').ok, false);
  assert.strictEqual(validarNovoMotivo('Outro motivo qualquer').ok, true);
});

teste('datas do mês', () => {
  assert.strictEqual(ultimoDia('2026-09'), '2026-09-30');
  assert.strictEqual(ultimoDia('2026-02'), '2026-02-28');
  assert.strictEqual(mesAnterior('2026-01'), '2025-12');
});
teste('fechamento: taxa, retenção, menos de 90 dias, motivos, sem motivo e comparação com o mês anterior', () => {
  const c = [];
  for (let i = 1; i <= 100; i++) c.push(ativo(i));
  // setembro: 3 saídas que contam (uma com motivo no painel, uma pela Gestão, uma sem motivo; uma é de casa há 30 dias)
  c.push(saiu(1, '2026-09-10', { motivo_churn: 'Churn por experiência técnica' }));
  c.push(saiu(2, '2026-09-12', { motivo_saida: 'Churn motivado por decisão pessoal' }));
  c.push(saiu(3, '2026-09-20', { data_entrada: '2026-08-21' }));
  // agosto: 1 saída
  c.push(saiu(4, '2026-08-15'));
  const f = montarFechamento(c, '2026-09', '2026-10-15', PADROES_PADRAO, MOTIVOS);
  assert.strictEqual(f.saidas, 3);
  assert.strictEqual(f.base, 103);                                   // 100 ativos + as 3 de setembro que estavam na base (a de agosto já tinha saído)
  assert.strictEqual(f.taxa, 2.91);
  assert.strictEqual(f.retencao, 97.1);
  assert.strictEqual(f.menos_de_90_dias, 1);                         // a que entrou em 21/08 e saiu em 20/09
  assert.deepStrictEqual(f.motivos.map((m) => [m.nome, m.qtd]), [['Churn motivado por decisão pessoal', 1], ['Churn por experiência técnica', 1]]);
  assert.strictEqual(f.sem_motivo, 1);
  assert.strictEqual(f.classificadas, 2);
  assert.strictEqual(f.taxa_anterior, 0.97);                         // agosto: 1 de 103
  assert.strictEqual(f.delta_pp, 1.9);
  assert.strictEqual(f.parcial, false);
  assert.ok(f.leitura.some((l) => l.includes('1 saída(s) ainda sem motivo')));
});
teste('mês em andamento é parcial e termina em hoje', () => {
  const f = montarFechamento([ativo(1), saiu(1, '2026-10-05')], '2026-10', '2026-10-15', PADROES_PADRAO, MOTIVOS);
  assert.strictEqual(f.parcial, true);
  assert.strictEqual(f.fim, '2026-10-15');
  assert.strictEqual(f.saidas, 1);
});
console.log(`\n${ok} testes passaram.`);
process.exit(0);
