'use strict';
// Rodar: node server/cs/testes_churn_saidas.js  (lógica pura, sem banco nem rede)
const assert = require('assert');
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://x:x@127.0.0.1:1/x';
const { classificarSaida, calcularChurn, presets, somarDias } = require('./churnSaidas');
const { requireAuth, requireAdmin } = require('../auth');

let ok = 0;
const teste = (nome, fn) => { fn(); ok++; console.log('  ok -', nome); };

teste('classifica o motivo: as três "Transferida por…" contam, baixada não', () => {
  assert.strictEqual(classificarSaida('Transferida por conveniência'), 'transferida');
  assert.strictEqual(classificarSaida('Transferida por conveniência (automático — Acessórias)'), 'transferida');
  assert.strictEqual(classificarSaida('TRANSFERIDA POR CONVENIENCIA'), 'transferida');
  assert.strictEqual(classificarSaida('Baixa de empresa'), 'baixa');
  assert.strictEqual(classificarSaida('Baixada'), 'baixa');
  assert.strictEqual(classificarSaida('Transferida por preço (automático — Acessórias)'), 'transferida');
  assert.strictEqual(classificarSaida('Transferida por mau atendimento'), 'transferida');
  assert.strictEqual(classificarSaida('Cliente encerrou por conta própria'), 'outra_saida');
  assert.strictEqual(classificarSaida('Pendente de revisão — baixa/saída detectada no Acessórias'), 'pendente');
  assert.strictEqual(classificarSaida(null), 'pendente');
});

const C = (id, entrada, saida, motivo) => ({ id, nome: id, data_entrada: entrada, data_saida: saida, motivo_saida: motivo });

teste('taxa = saídas por transferência da base ÷ base ativa no início do período', () => {
  const clientes = [
    C('a', '2024-01-10', null, null),                                   // base, fica
    C('b', '2024-02-10', null, null),                                   // base, fica
    C('c', '2024-03-10', '2026-10-03', 'Transferida por conveniência'), // base, sai (conta)
    C('d', '2024-04-10', '2026-10-04', 'Baixa de empresa'),             // base, baixa (não conta)
    C('e', '2024-05-10', '2026-10-05', 'Transferida por preço'),        // base, transferida (conta)
    C('h', '2024-06-10', '2026-10-07', 'Cliente encerrou por conta própria'), // base, outra saída (não conta)
    C('f', '2026-10-02', '2026-10-06', 'Transferida por conveniência'), // entrou no período: fora da base
    C('g', '2025-01-01', '2026-09-20', 'Transferida por conveniência'), // saiu ANTES do período: nem na base
  ];
  const r = calcularChurn(clientes, '2026-10-01', '2026-10-31');
  assert.strictEqual(r.base, 6);                 // a, b, c, d, e, h
  assert.strictEqual(r.saidas_contadas, 2);      // c (conveniência) e e (preço)
  assert.strictEqual(r.taxa, 33.33);
  assert.strictEqual(r.transferidas_fora_da_base, 1); // f
  assert.deepStrictEqual(r.fora_do_churn, { baixas: 1, outras_saidas: 1, pendentes: 0 });
});

teste('sem base, a taxa é nula (não divide por zero)', () => {
  assert.strictEqual(calcularChurn([], '2026-10-01', '2026-10-31').taxa, null);
});

teste('padrões editáveis: dá pra restringir só a conveniência', () => {
  const clientes = [C('a', '2024-01-01', '2026-10-05', 'Transferida por preço'), C('b', '2024-01-01', null, null)];
  assert.strictEqual(calcularChurn(clientes, '2026-10-01', '2026-10-31').saidas_contadas, 1);
  assert.strictEqual(calcularChurn(clientes, '2026-10-01', '2026-10-31', ['transferida por conveniencia']).saidas_contadas, 0);
});

teste('períodos prontos (mês atual, anterior, 12 meses, ano)', () => {
  const p = presets('2026-10-05');
  assert.deepStrictEqual([p.mes_atual.ini, p.mes_atual.fim], ['2026-10-01', '2026-10-05']);
  assert.deepStrictEqual([p.mes_anterior.ini, p.mes_anterior.fim], ['2026-09-01', '2026-09-30']);
  assert.strictEqual(p.ultimos_12_meses.ini, '2025-10-05');
  assert.strictEqual(p.ano.ini, '2026-01-01');
  assert.strictEqual(presets('2026-01-15').mes_anterior.ini, '2025-12-01');
  assert.strictEqual(somarDias('2026-03-01', -1), '2026-02-28');
});

teste('rota PUT /config exige requireAuth antes de requireAdmin', () => {
  const { router } = require('./churnSaidas');
  for (const camada of router.stack.filter((l) => l.route)) {
    const h = camada.route.stack.map((s) => s.handle);
    const iAdmin = h.indexOf(requireAdmin);
    if (iAdmin !== -1) assert.ok(h.indexOf(requireAuth) !== -1 && h.indexOf(requireAuth) < iAdmin, camada.route.path);
  }
});

console.log(`\n${ok} testes passaram.`);
process.exit(0);
