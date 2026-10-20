'use strict';
// Rodar: node server/testes_legalizacao_pagina.js
// Carrega public/js/legalizacao.js num DOM de mentira (vm), injeta dados e confere o que cada seção desenha e exporta.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let ok = 0;
const teste = (nome, fn) => { fn(); ok++; console.log('  ok -', nome); };

const fonte = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'legalizacao.js'), 'utf8');
const marca = "  if (ls(K_TOKEN)) iniciar(); else mostrarLogin('');\n})();";
assert.ok(fonte.includes(marca), 'final do arquivo mudou: ajuste o gancho do teste');
const comGancho = fonte.replace(marca, "  window.__t = { estado: estado, desenharVisao: desenharVisao, desenharEvolucao: desenharEvolucao, desenharLista: desenharLista, dadosExport: dadosExport, SPECS: SPECS, norm: norm, diasAte: diasAte, prazoTxt: prazoTxt, docsPrioridade: docsPrioridade, linhasQualidade: linhasQualidade, desenharFicha: desenharFicha, desenharTudo: desenharTudo, contagem: contagem };\n})();");

// ── DOM de mentira ──
const elementos = {};
function el(id) {
  if (elementos[id]) return elementos[id];
  const e = {
    id, style: {}, value: '', innerHTML: '', textContent: '', hidden: false, children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {}, setAttribute() {}, getAttribute() { return null; }, appendChild() {}, focus() {}, scrollIntoView() {},
    querySelector() { return null; }, closest() { return null; },
  };
  return (elementos[id] = e);
}
const ctx = {
  console, setTimeout, setInterval, clearInterval, Date, Math, JSON, String, Number, Object, Array, Promise, parseInt, isFinite,
  document: {
    getElementById: el, querySelectorAll: () => [], addEventListener() {}, createElement: () => el('x' + Math.random()),
    body: { appendChild() {} },
  },
  localStorage: { getItem: (k) => (k === 'cs_user' ? (ctx.__user || null) : null), setItem() {}, removeItem() {} },
  fetch: async () => ({ ok: false, status: 500, json: async () => ({}) }),
  alert() {}, prompt() { return null; },
};
ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext(comGancho, ctx);
const T = ctx.__t;
assert.ok(T, 'gancho não instalado');

// ── dados de exemplo (datas relativas a hoje) ──
const hoje = new Date();
const iso = (dias) => { const d = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate() + dias); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const linhas = [
  { cliente_id: 'a1', nome_empresa: 'Padaria São João <Ltda>', cnpj: '11222333000181', codigo: '10', sem_cadastro_acessorias: false,
    func: { id: 'f1', vencimento: iso(-40), numero: '123/2025', observacoes: '', status: 'vencido', a_conferir: true },
    sanit: { id: 's1', vencimento: iso(60), numero: 'S-9', observacoes: 'ok', status: 'vencendo' },
    cert: { tipo: 'pj', vencimento: iso(5), status: 'vencendo' },
    ecac: { vencimento: iso(200), status: 'ok' }, fgts: { vencimento: null, status: 'sem_data' },
    municipio: 'Uberlândia', uf: 'MG', inscricao_municipal: '777', prefeitura_integrada: true, automacao: 'automatica' },
  { cliente_id: 'b2', nome_empresa: 'Maria da Silva', cnpj: '12345678909', sem_cadastro_acessorias: false,
    func: null, sanit: null, cert: { tipo: 'pf', vencimento: iso(300), status: 'ok' },
    ecac: { vencimento: iso(-2), status: 'vencido' }, fgts: { vencimento: iso(20), status: 'solicitacao', consulta_resumo: 'Em análise', consulta_data_solicitacao: iso(-3) },
    municipio: null, uf: null, prefeitura_integrada: null, automacao: 'pessoa_fisica' },
  { cliente_id: null, nome_empresa: 'Sem Cadastro ME', cnpj: '99888777000166', sem_cadastro_acessorias: true,
    func: null, sanit: null, cert: { tipo: 'pj', vencimento: null, status: 'sem_data' }, ecac: null, fgts: null,
    municipio: null, uf: null, prefeitura_integrada: null, automacao: 'sem_municipio' },
  { cliente_id: 'd4', nome_empresa: 'Oficina do Zé', cnpj: '55444333000122', sem_cadastro_acessorias: false,
    func: { id: 'f4', vencimento: iso(400), status: 'ok' }, sanit: null, cert: { tipo: 'pj', vencimento: iso(100), status: 'ok' },
    ecac: { vencimento: iso(90), status: 'ok' }, fgts: { vencimento: iso(90), status: 'ok' },
    municipio: 'Araguari', uf: 'MG', prefeitura_integrada: false, prefeitura_url: 'https://exemplo.gov.br', automacao: 'pasta' },
];
T.estado.linhas = linhas.map((l, ix) => { l._ix = ix; return l; });
T.estado.dias = { funcionamento: 30, sanitario: 120, certificado: 30, procuracao: 30 };
T.estado.historico = [
  { semana: '2026-10-05', atualizado_em: '2026-10-11T12:00:00Z', clientes: 4, vencidos: 3, vencendo: 2, solicitacao: 1, em_dia: 5, sem_data: 2, por_tipo: { func: { total: 2, vencido: 1, vencendo: 0, solicitacao: 0, ok: 1, sem_data: 0 } } },
  { semana: '2026-10-12', atualizado_em: '2026-10-14T12:00:00Z', clientes: 4, vencidos: 2, vencendo: 2, solicitacao: 1, em_dia: 6, sem_data: 2, por_tipo: { func: { total: 2, vencido: 1, vencendo: 0, solicitacao: 0, ok: 1, sem_data: 0 } } },
];

teste('norm tira acentos e caixa', () => {
  assert.strictEqual(T.norm('Uberlândia'), 'uberlandia');
  assert.strictEqual(T.norm('SÃO JOÃO'), 'sao joao');
});
teste('prazo em dias: venceu, hoje, vence em', () => {
  assert.strictEqual(T.diasAte(iso(0)), 0);
  assert.strictEqual(T.diasAte(iso(-3)), -3);
  assert.strictEqual(T.diasAte(iso(10)), 10);
  assert.strictEqual(T.prazoTxt({ vencimento: iso(-3) }), 'venceu há 3 d');
  assert.strictEqual(T.prazoTxt({ vencimento: iso(0) }), 'vence hoje');
  assert.strictEqual(T.prazoTxt({ vencimento: iso(7) }), 'vence em 7 d');
  assert.strictEqual(T.prazoTxt({ vencimento: null }), '—');
});
teste('prioridades: vencidos primeiro, do mais antigo ao mais novo; depois vencendo por data', () => {
  const p = T.docsPrioridade();
  assert.deepStrictEqual([...p.map((r) => r.st + ':' + r.tipo)], ['vencido:func', 'vencido:ecac', 'vencendo:cert_pj', 'vencendo:sanit']);
});
teste('contagem por documento separa certificado PF e PJ', () => {
  const pj = T.contagem('cert_pj'), pf = T.contagem('cert_pf');
  assert.strictEqual(pj.total, 3);
  assert.strictEqual(pf.total, 1);
  assert.strictEqual(pj.vencendo, 1);
  assert.strictEqual(pj.sem_data, 1);
});
teste('qualidade lista cada pendência', () => {
  const q = T.linhasQualidade().map((r) => r.pend + ':' + r.l.cliente_id);
  assert.ok(q.includes('sem_cadastro:null'));
  assert.ok(q.includes('sem_municipio:null'));
  assert.ok(q.includes('pasta:d4'));
  assert.ok(q.includes('conferir:a1'));
  assert.ok(q.filter((x) => x.startsWith('sem_data:')).length === 2);
});
teste('alvará sem data já consultado vira "consultado, nada localizado" (não é pendência); sem consulta continua pendente', () => {
  const n = T.estado.linhas.length;
  T.estado.linhas.push(
    { _ix: n, cliente_id: 'c1', nome_empresa: 'Consultada Ltda', cnpj: '11111111000111', func: { id: 'x1', vencimento: null, status: 'sem_data', consulta_em: iso(-1) }, sanit: null, cert: { tipo: 'pj', vencimento: iso(200), status: 'ok' }, ecac: null, fgts: null, automacao: 'automatica' },
    { _ix: n + 1, cliente_id: 'c2', nome_empresa: 'Nunca Consultada Ltda', cnpj: '22222222000122', func: { id: 'x2', vencimento: null, status: 'sem_data', consulta_em: null }, sanit: null, cert: { tipo: 'pj', vencimento: iso(200), status: 'ok' }, ecac: null, fgts: null, automacao: 'automatica' },
    { _ix: n + 2, cliente_id: 'c3', nome_empresa: 'Cert sem data', cnpj: '33333333000133', func: null, sanit: null, cert: { tipo: 'pj', vencimento: null, status: 'sem_data', consulta_em: iso(-1) }, ecac: null, fgts: null, automacao: 'automatica' },
  );
  try {
    const q = T.linhasQualidade().map((r) => r.pend + ':' + r.l.cliente_id);
    assert.ok(q.includes('consultado:c1'), 'consultado e sem alvará');
    assert.ok(q.includes('sem_data:c2'), 'nunca consultado segue pendente');
    assert.ok(q.includes('sem_data:c3'), 'certificado sem data nunca vira "consultado" (só alvarás)');
    assert.ok(!q.includes('sem_data:c1'));
    T.desenharVisao();
    assert.ok(el('sec-visao').innerHTML.includes('Consultado, nada localizado'), 'a visão geral mostra a separação');
  } finally { T.estado.linhas.length = n; }
});
teste('todas as seções desenham sem undefined/NaN e escapam HTML do nome', () => {
  T.desenharVisao(); T.desenharEvolucao();
  ['prioridades', 'funcionamento', 'sanitario', 'certificados', 'procuracoes', 'carteira', 'solicitacoes', 'qualidade'].forEach((s) => T.desenharLista(s));
  ['visao', 'evolucao', 'prioridades', 'funcionamento', 'sanitario', 'certificados', 'procuracoes', 'carteira', 'solicitacoes', 'qualidade'].forEach((s) => {
    const h = el('sec-' + s).innerHTML;
    assert.ok(h.length > 50, s + ' vazia');
    assert.ok(!/undefined|NaN|\[object/.test(h), s + ' tem lixo: ' + (h.match(/.{30}(undefined|NaN|\[object).{30}/) || [''])[0]);
  });
  assert.ok(!el('sec-carteira').innerHTML.includes('<Ltda>'), 'nome não escapado');
  assert.ok(el('sec-carteira').innerHTML.includes('&lt;Ltda&gt;'));
});
teste('exportação: toda linha tem o mesmo número de colunas do cabeçalho, sem undefined', () => {
  ['visao', 'evolucao', 'prioridades', 'funcionamento', 'sanitario', 'certificados', 'procuracoes', 'carteira', 'solicitacoes', 'qualidade'].forEach((s) => {
    const e = T.dadosExport(s);
    assert.ok(e, s + ' sem exportação');
    assert.ok(e.linhas.length > 0, s + ' sem linhas');
    e.linhas.forEach((l) => {
      assert.strictEqual(l.length, e.colunas.length, s + ': colunas diferentes');
      l.forEach((v) => assert.ok(v !== undefined && v !== null && !/undefined|NaN/.test(String(v)), s + ': valor ruim ' + v));
    });
  });
});
teste('exportação respeita o filtro atual', () => {
  T.estado.f.prioridades.sit = 'vencido';
  assert.strictEqual(T.dadosExport('prioridades').linhas.length, 2);
  T.estado.f.prioridades.sit = '';
  T.estado.f.certificados.tipo = 'cert_pf';
  assert.strictEqual(T.dadosExport('certificados').linhas.length, 1);
  T.estado.f.certificados.tipo = '';
  T.estado.f.carteira.busca = 'maria';
  assert.strictEqual(T.dadosExport('carteira').linhas.length, 1);
  T.estado.f.carteira.busca = '';
  T.estado.f.carteira.busca = '11222333';
  assert.strictEqual(T.dadosExport('carteira').linhas.length, 1);
  T.estado.f.carteira.busca = '';
});
teste('carteira: filtro de pior situação e coluna CNPJ no relatório', () => {
  T.estado.f.carteira.sit = 'vencido';
  const e = T.dadosExport('carteira');
  assert.strictEqual(e.linhas.length, 2);          // Padaria (func vencido) e Maria (ecac vencido)
  assert.strictEqual(e.colunas[1], 'CNPJ/CPF');
  T.estado.f.carteira.sit = '';
});
teste('ficha abre para empresa sem cadastro no Acessórias sem botão de inativar', () => {
  T.desenharFicha(2);
  const h = el('ficha-corpo').innerHTML;
  assert.ok(h.includes('não tem cadastro no Acessórias'));
  assert.ok(!h.includes('data-acao="inativar"'));
  T.desenharFicha(0);
  assert.ok(el('ficha-corpo').innerHTML.includes('data-acao="inativar"'));
  assert.ok(el('ficha-corpo').innerHTML.includes('data-acao="municipio"'));
});
teste('certificado que o cliente não renova: analista pede, administrador desativa; desativado sai de tudo', () => {
  ctx.__user = JSON.stringify({ name: 'Analista', role: 'colaborador', acesso_legalizacao: true });
  T.desenharLista('certificados');
  let h = el('sec-certificados').innerHTML;
  assert.ok(h.includes('data-acao="cert-sol"') && !h.includes('data-acao="cert-desat"'), 'analista vê só o pedido');
  T.desenharFicha(0);
  assert.ok(el('ficha-corpo').innerHTML.includes('data-acao="cert-sol"'));
  ctx.__user = JSON.stringify({ name: 'Admin', role: 'administrador' });
  T.desenharLista('certificados');
  h = el('sec-certificados').innerHTML;
  assert.ok(h.includes('data-acao="cert-desat"') && !h.includes('data-acao="cert-sol"'), 'administrador desativa direto');
  assert.ok(!T.dadosExport('certificados').colunas.includes('Ação'), 'a coluna de ação não vai para a exportação');
  const antes = T.contagem('cert_pj').total;
  T.estado.linhas[0].cert.desativado = true;
  assert.strictEqual(T.contagem('cert_pj').total, antes - 1, 'certificado desativado não é contado');
  assert.ok(!T.docsPrioridade().some((r) => r.tipo === 'cert_pj' && r.l.cliente_id === 'a1'), 'nem aparece nas prioridades');
  T.estado.linhas[0].cert.desativado = false; ctx.__user = null;
});
teste('evolução vazia não quebra', () => {
  T.estado.historico = [];
  T.desenharEvolucao();
  assert.ok(el('sec-evolucao').innerHTML.includes('Ainda não há retrato'));
});

console.log(`\n${ok} testes passaram.`);
process.exit(0);
