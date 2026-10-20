'use strict';
// Testes do aviso de falha das rotinas da Legalização (sino) e da regra "CPF/CNO/CAEPF não mostra Sem data": node testes_saude_rotinas.js
const assert = require('assert');
const { motivoFalhaRotina } = require('./legalizacao/saudeRotinas');
const { limparSemDataSeNaoCnpj } = require('./legalizacao/naoSeAplica');

let ok = 0;
const teste = (nome, fn) => { try { fn(); ok++; console.log('  ok - ' + nome); } catch (e) { console.error('  FALHOU - ' + nome + '\n    ' + e.message); process.exitCode = 1; } };

teste('rodada normal não gera aviso', () => {
  assert.strictEqual(motivoFalhaRotina({ status: 'ok', ultima: { total: 170, ok: 170, falhas: 0, resumo: {} } }), null);
  assert.strictEqual(motivoFalhaRotina({ status: 'sem_registro', ultima: null }), null);
});
teste('erro registrado (ex.: IP não liberado no CertiSeguro) vira aviso com a mensagem', () => {
  const m = motivoFalhaRotina({ status: 'ok', ultima: { total: 0, ok: 0, falhas: 1, resumo: { erro: 'CertiSeguro devolveu HTTP 400: IP não liberado. 191.248.176.20' } } });
  assert.ok(m.includes('IP não liberado'));
});
teste('rodada interrompida por falhas seguidas avisa', () => {
  assert.ok(/parou no meio/.test(motivoFalhaRotina({ status: 'ok', ultima: { total: 170, ok: 60, falhas: 4, resumo: { interrompida: true } } })));
});
teste('muitas falhas avisa com a contagem; poucas falhas não', () => {
  assert.strictEqual(motivoFalhaRotina({ status: 'com_falhas', ultima: { total: 100, ok: 70, falhas: 30, resumo: {} } }), '30 falha(s) em 100 consulta(s)');
  assert.strictEqual(motivoFalhaRotina({ status: 'ok', ultima: { total: 100, ok: 95, falhas: 5, resumo: {} } }), null);
});
teste('falha sem nenhuma consulta feita avisa', () => {
  assert.strictEqual(motivoFalhaRotina({ status: 'ok', ultima: { total: 0, ok: 0, falhas: 2, resumo: {} } }), '2 falha(s) em 0 consulta(s)');
});

const linha = () => ({
  func: { status: 'sem_data' }, sanit: { status: 'sem_data' }, ecac: { status: 'sem_data' }, fgts: { status: 'ok', vencimento: '2030-01-01' },
  cert: { tipo: 'pj', status: 'sem_data' }, sem_cadastro_acessorias: false,
});
teste('documento que não é CNPJ: some o "Sem data", mantém o que tem data', () => {
  const l = limparSemDataSeNaoCnpj(linha(), true);
  assert.strictEqual(l.func, null); assert.strictEqual(l.sanit, null); assert.strictEqual(l.ecac, null); assert.strictEqual(l.cert, null);
  assert.strictEqual(l.fgts.status, 'ok', 'procuração com data continua');
});
teste('documento que não é CNPJ: solicitação em andamento e vencido continuam aparecendo', () => {
  const l = limparSemDataSeNaoCnpj({ func: { status: 'solicitacao' }, sanit: { status: 'vencido' }, ecac: null, fgts: null, cert: { tipo: 'pf', status: 'sem_data' } }, true);
  assert.strictEqual(l.func.status, 'solicitacao'); assert.strictEqual(l.sanit.status, 'vencido');
  assert.strictEqual(l.cert.tipo, 'pf', 'certificado PF sem data não é tocado (só o PJ)');
});
teste('CNPJ válido segue como está; linha "sem cadastro" também', () => {
  const a = limparSemDataSeNaoCnpj(linha(), false);
  assert.strictEqual(a.func.status, 'sem_data');
  const b = limparSemDataSeNaoCnpj(Object.assign(linha(), { sem_cadastro_acessorias: true }), true);
  assert.strictEqual(b.func.status, 'sem_data');
});
const { casarCertificadosPF, cnpjValido } = require('./legalizacao/casarCertificadoPF');
const cli = (nome, cnpj, codigo, cert) => ({ nome_empresa: nome, cnpj, codigo, sem_cadastro_acessorias: false, cert: cert || null });
const avulso = (nome, cpf, cert) => ({ nome_empresa: nome, cnpj: cpf, codigo: null, sem_cadastro_acessorias: true, cert: Object.assign({ tipo: 'pf', id: 'c1', status: 'ok', vencimento: '2027-02-09' }, cert || {}) });
teste('certificado PF avulso vai para o cliente de mesmo CPF/CAEPF (prefere o cadastro do Acessórias)', () => {
  assert.ok(!cnpjValido('06278763600119'), 'o CAEPF não é um CNPJ válido');
  const caepf = cli('GABRIEL ABREU REIS', '062.787.636/001-19', '1399', { tipo: 'pj', status: 'sem_data' });
  const cpf = cli('GABRIEL ABREU REIS', '062.787.636-64', null, null);
  const r = casarCertificadosPF([cpf, caepf, avulso('GABRIEL ABREU REIS', '06278763664')]);
  assert.strictEqual(r.length, 2, 'a linha avulsa sumiu');
  assert.strictEqual(caepf.cert.tipo, 'pf'); assert.strictEqual(caepf.cert.vencimento, '2027-02-09'); assert.strictEqual(caepf.cert.id, 'c1');
  assert.strictEqual(cpf.cert, null, 'o cadastro sem código não recebe');
});
teste('sem cliente correspondente a linha avulsa fica; certificado com data do cliente não é pisado', () => {
  const a = avulso('FULANO', '12345678909');
  assert.strictEqual(casarCertificadosPF([cli('OUTRO', '99999999999', '1', null), a]).length, 2);
  const c = cli('FULANO', '123.456.789-09', '2', { tipo: 'pf', status: 'ok', id: 'outro' });
  const r = casarCertificadosPF([c, avulso('FULANO', '12345678909')]);
  assert.strictEqual(r.length, 2); assert.strictEqual(c.cert.id, 'outro');
});
teste('CNPJ válido com os mesmos 9 primeiros dígitos do CPF NÃO casa (só CPF e CAEPF)', () => {
  const emp = cli('EMPRESA LTDA', '11.222.333/0001-81', '3', null);
  assert.ok(cnpjValido('11222333000181'));
  assert.strictEqual(casarCertificadosPF([emp, avulso('PESSOA', '11222333081')]).length, 2);
  assert.strictEqual(emp.cert, null);
});
console.log(`\n${ok} testes passaram.`);
