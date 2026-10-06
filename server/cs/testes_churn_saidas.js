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

const C = (id, entrada, saida, motivoAcess, motivoSis = null) => ({ id, nome: id, cnpj: '11.222.333/0001-81', data_entrada: entrada, data_saida: saida, motivo_acessorias: motivoAcess, motivo_saida: motivoSis });

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
  assert.strictEqual(r.taxa_teto, 42.86); // + 1 'a confirmar' (i) na base: 3/7
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

teste('sem motivo, a situação do CNPJ na Receita decide: baixado = baixa, ativo = transferida', () => {
  const { classificarSaidaDetalhe, inferirPelaReceita } = require('./churnSaidas');
  assert.strictEqual(inferirPelaReceita('ATIVA', null, '2026-05-10'), 'transferida');
  assert.strictEqual(inferirPelaReceita('BAIXADA', '2026-05-02', '2026-05-10'), 'baixa');
  assert.strictEqual(inferirPelaReceita('BAIXADA', '2026-01-10', '2026-05-10'), 'baixa'); // fechou antes de sair do escritório
  assert.strictEqual(inferirPelaReceita('BAIXADA', '2027-03-01', '2026-05-10'), 'transferida'); // saiu vivo, CNPJ só baixou muito depois
  assert.strictEqual(inferirPelaReceita('SUSPENSA', null, '2026-05-10'), null);
  assert.strictEqual(inferirPelaReceita(null, null, '2026-05-10'), null);
  const sem = classificarSaidaDetalhe(null, 'Baixa de empresa', undefined, { situacao: 'ATIVA', data: null }, '2026-05-10');
  assert.deepStrictEqual(sem, { tipo: 'transferida', origem: 'receita' });
  assert.strictEqual(classificarSaidaDetalhe('Baixada', null, undefined, { situacao: 'ATIVA' }, '2026-05-10').origem, 'acessorias');
  assert.strictEqual(classificarSaidaDetalhe(null, 'Transferida por preço (automático — Acessórias)').origem, 'sistema');
  assert.deepStrictEqual(classificarSaidaDetalhe(null, null, undefined, { situacao: 'INDISPONIVEL' }, '2026-05-10'), { tipo: 'a_confirmar', origem: null });
});

teste('calcularChurn usa a Receita e informa quantas saídas foram inferidas', () => {
  const clientes = [
    { id: 'a', nome: 'a', cnpj: '11.222.333/0001-81', data_entrada: '2024-01-01', data_saida: null, motivo_saida: null, motivo_acessorias: null },
    { id: 'b', nome: 'b', cnpj: '11.222.333/0001-81', data_entrada: '2024-01-01', data_saida: '2026-10-03', motivo_saida: 'Baixa de empresa', motivo_acessorias: null, situacao_receita: 'ATIVA', data_situacao_receita: null },
    { id: 'c', nome: 'c', cnpj: '11.222.333/0001-81', data_entrada: '2024-01-01', data_saida: '2026-10-04', motivo_saida: 'Baixa de empresa', motivo_acessorias: null, situacao_receita: 'BAIXADA', data_situacao_receita: '2026-10-01' },
  ];
  const r = calcularChurn(clientes, '2026-10-01', '2026-10-31');
  assert.strictEqual(r.saidas_contadas, 1);   // b (CNPJ ativo = transferida)
  assert.strictEqual(r.fora_do_churn.baixas, 1); // c (CNPJ baixado)
  assert.strictEqual(r.inferidas_pela_receita, 2);
  assert.strictEqual(r.fora_do_churn.a_confirmar, 0);
});

teste('tipo do documento: CNPJ, CPF, CAEPF e CNO', () => {
  const { tipoDocumento, ehPessoaJuridica } = require('./churnSaidas');
  assert.strictEqual(tipoDocumento('45.459.079/0001-51'), 'CNPJ');
  assert.strictEqual(tipoDocumento('45459079000151'), 'CNPJ');
  assert.strictEqual(tipoDocumento('014.158.526-93'), 'CPF');
  assert.strictEqual(tipoDocumento('01415852693'), 'CPF');
  assert.strictEqual(tipoDocumento('123.456.789/001-12'), 'CAEPF');
  assert.strictEqual(tipoDocumento('12.345.67890/12'), 'CNO');
  assert.strictEqual(tipoDocumento('123456789012'), 'CNO');
  assert.strictEqual(tipoDocumento(''), null);
  assert.strictEqual(tipoDocumento(null), null);
  assert.strictEqual(ehPessoaJuridica('45.459.079/0001-51'), true);
  assert.strictEqual(ehPessoaJuridica('014.158.526-93'), false);
  assert.strictEqual(ehPessoaJuridica('123.456.789/001-12'), false);
  assert.strictEqual(ehPessoaJuridica('12.345.67890/12'), false);
  assert.strictEqual(ehPessoaJuridica(null), false); // só CNPJ entra: sem documento também fica de fora
  assert.strictEqual(ehPessoaJuridica(''), false);
});

teste('CPF, CAEPF e CNO ficam fora da base e das saídas do churn', () => {
  const mk = (id, doc, saida, motivo) => ({ id, nome: id, cnpj: doc, data_entrada: '2024-01-01', data_saida: saida, motivo_saida: null, motivo_acessorias: motivo });
  const clientes = [
    mk('pj1', '45.459.079/0001-51', null, null),
    mk('pj2', '11.222.333/0001-81', '2026-10-05', 'Transferida por preço'),
    mk('cpf', '014.158.526-93', '2026-10-06', 'Transferida por preço'),
    mk('caepf', '123.456.789/001-12', '2026-10-07', 'Transferida por preço'),
    mk('cno', '12.345.67890/12', '2026-10-08', 'Transferida por preço'),
  ];
  const r = calcularChurn(clientes, '2026-10-01', '2026-10-31');
  assert.strictEqual(r.base, 2);               // só pj1 e pj2
  assert.strictEqual(r.saidas_contadas, 1);    // só pj2
  assert.strictEqual(r.taxa, 50);
  assert.deepStrictEqual(r.desconsiderados_cpf_caepf_cno, { base: 3, saidas: 3 });
  assert.ok(!r.saidas.some((s) => ['cpf', 'caepf', 'cno'].includes(s.id)));
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
  assert.ok(achouAdmin >= 4, 'esperava as 4 rotas de admin (config, classificar-saidas, sincronizar-motivos, diagnostico)');
});

console.log(`\n${ok} testes passaram.`);
process.exit(0);
