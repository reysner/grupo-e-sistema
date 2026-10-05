'use strict';
// Rodar: node server/cs/testes_churn_saidas.js  (lógica pura, sem banco nem rede)
const assert = require('assert');
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://x:x@127.0.0.1:1/x';
const { classificarSaida, calcularChurn, presets, somarDias } = require('./churnSaidas');
const { extrairMotivoCancelamento } = require('../acessoriasClient');
const { requireAuth, requireAdmin } = require('../auth');

let ok = 0;
const teste = (nome, fn) => { fn(); ok++; console.log('  ok -', nome); };

teste('motivo do Acessórias manda: as três "Transferida por…" contam, baixada não', () => {
  assert.strictEqual(classificarSaida('Transferida por conveniência', null), 'transferida');
  assert.strictEqual(classificarSaida('TRANSFERIDA POR CONVENIENCIA', null), 'transferida');
  assert.strictEqual(classificarSaida('Transferida por mau atendimento', null), 'transferida');
  assert.strictEqual(classificarSaida('Transferida por preço', null), 'transferida');
  assert.strictEqual(classificarSaida('Baixada', null), 'baixa');
  assert.strictEqual(classificarSaida('Cliente encerrou por conta própria', null), 'outra_saida');
});

teste('o motivo do Acessórias vence o que o sistema gravou', () => {
  assert.strictEqual(classificarSaida('Transferida por preço', 'Baixa de empresa'), 'transferida');
  assert.strictEqual(classificarSaida('Baixada', 'Transferida por preço (automático — Acessórias)'), 'baixa');
});

teste('"Baixa de empresa" e "Pendente de revisão" do sistema NÃO são prova: ficam a confirmar', () => {
  assert.strictEqual(classificarSaida(null, 'Baixa de empresa'), 'a_confirmar');
  assert.strictEqual(classificarSaida('', 'Pendente de revisão — baixa/saída detectada no Acessórias'), 'a_confirmar');
  assert.strictEqual(classificarSaida(null, null), 'a_confirmar');
});

teste('sem leitura do Acessórias, motivo real gravado pelo sistema ainda serve de apoio', () => {
  assert.strictEqual(classificarSaida(null, 'Transferida por preço (automático — Acessórias)'), 'transferida');
});

const C = (id, entrada, saida, motivoAcess, motivoSis = null) => ({ id, nome: id, data_entrada: entrada, data_saida: saida, motivo_acessorias: motivoAcess, motivo_saida: motivoSis });

teste('taxa = saídas por transferência da base ÷ base ativa no início do período', () => {
  const clientes = [
    C('a', '2024-01-10', null, null),                                      // base, fica
    C('b', '2024-02-10', null, null),                                      // base, fica
    C('c', '2024-03-10', '2026-10-03', 'Transferida por conveniência'),    // base, conta
    C('d', '2024-04-10', '2026-10-04', 'Baixada'),                         // base, baixa (não conta)
    C('e', '2024-05-10', '2026-10-05', 'Transferida por preço'),           // base, conta
    C('h', '2024-06-10', '2026-10-07', 'Outro motivo qualquer'),           // base, outra saída (não conta)
    C('i', '2024-07-10', '2026-10-08', null, 'Baixa de empresa'),          // base, a confirmar (não conta)
    C('f', '2026-10-02', '2026-10-06', 'Transferida por conveniência'),    // entrou no período: fora da base
    C('g', '2025-01-01', '2026-09-20', 'Transferida por conveniência'),    // saiu ANTES do período: nem na base
  ];
  const r = calcularChurn(clientes, '2026-10-01', '2026-10-31');
  assert.strictEqual(r.base, 7);                 // a, b, c, d, e, h, i
  assert.strictEqual(r.saidas_contadas, 2);      // c e e
  assert.strictEqual(r.taxa, 28.57);
  assert.strictEqual(r.transferidas_fora_da_base, 1); // f
  assert.deepStrictEqual(r.fora_do_churn, { baixas: 1, outras_saidas: 1, a_confirmar: 1 });
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

teste('extrai o motivo de cancelamento do Acessórias mesmo com nome de campo diferente', () => {
  assert.strictEqual(extrairMotivoCancelamento({ MotivoDeCancelamento: 'Baixada' }), 'Baixada');
  assert.strictEqual(extrairMotivoCancelamento({ Razao: 'X', MotivoCancel: ' Transferida por preço ' }), 'Transferida por preço');
  assert.strictEqual(extrairMotivoCancelamento({ Razao: 'X', Motivo: '********' }), null);
  assert.strictEqual(extrairMotivoCancelamento({ Razao: 'X', ClienteAte: '2026-01-01' }), null);
  assert.strictEqual(extrairMotivoCancelamento(null), null);
});

teste('rotas de admin passam por requireAuth ANTES de requireAdmin', () => {
  const { router } = require('./churnSaidas');
  let achouAdmin = 0;
  for (const camada of router.stack.filter((l) => l.route)) {
    const h = camada.route.stack.map((s) => s.handle);
    const iAdmin = h.indexOf(requireAdmin);
    if (iAdmin === -1) continue;
    achouAdmin++;
    assert.ok(h.indexOf(requireAuth) !== -1 && h.indexOf(requireAuth) < iAdmin, camada.route.path);
  }
  assert.ok(achouAdmin >= 3, 'esperava as 3 rotas de admin (config, sincronizar-motivos, diagnostico)');
});

console.log(`\n${ok} testes passaram.`);
process.exit(0);
