'use strict';
// Rodar: node server/cs/testes_hoje_tela.js
// Extrai do public/js/app.js o bloco "Hoje" do módulo Sucesso do Cliente e confere o que ele desenha (DOM de mentira).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let ok = 0;
const teste = (nome, fn) => Promise.resolve().then(fn).then(() => { ok++; console.log('  ok -', nome); });

const fonte = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'app.js'), 'utf8');
const ini = fonte.indexOf('// ── HOJE: pedidos por e-mail');
const fim = fonte.indexOf('    _authHeaders() {', ini);
assert.ok(ini > 0 && fim > ini, 'bloco Hoje não encontrado em app.js');
const bloco = fonte.slice(ini, fim);

const alvo = { innerHTML: '' };
const ctx = {
  document: { getElementById: (id) => (id === 'hoje-container' ? alvo : null) },
  localStorage: { getItem: () => 'tok' },
  console, Date, Math, String, Number, Object, Array, JSON, Promise,
  fetch: async () => ({ ok: true, status: 200, json: async () => ctx.__resposta }),
};
vm.createContext(ctx);
vm.runInContext(`
  var SucessoCliente = {
    _authHeaders() { return {}; },
    _esc(s) { const m = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }; return String(s == null ? '' : s).replace(/[&<>"']/g, c => m[c]); },
    ${bloco}
  };
  this.SucessoCliente = SucessoCliente;
`, ctx);
const S = ctx.SucessoCliente;

const agora = new Date().toISOString();
const resposta = {
  lido_em: agora, janela_dias: 14, caixas_lidas: 41,
  totais: { aguardando: 39, aguardando_exclusivos: 29, aguardando_compartilhados: 10, resolvidos_zappy: 14, aguardando_nao_identificados: 66 },
  dominios: [{ dominio: '(e-mail pessoal)', pessoal: true, contatos: 57, aguardando: 34, mais_antigo_h: 336 }, { dominio: 'zacinformatica.com.br', pessoal: false, contatos: 1, aguardando: 1, mais_antigo_h: 120 }],
  clientes: [
    { cnpj: '11222333000181', nome: 'MTC Drive <Locações>', aguardando_4h: 1, aguardando_24h: 1, aguardando_48h: 1, aguardando_7d: 1, aguardando_compartilhado: 0, mais_antigo_h: 312, caixas: ['Douglas da Silva Nascimento', 'Eduardo Queiroz'] },
    { cnpj: '55444333000122', nome: 'Empresa do Grupo', aguardando_4h: 0, aguardando_24h: 0, aguardando_48h: 0, aguardando_7d: 0, aguardando_compartilhado: 1, mais_antigo_h: 60, caixas: ['Leila Palmieri'] },
    { cnpj: '99888777000166', nome: 'Sem pedido', aguardando_4h: 0, aguardando_compartilhado: 0, mais_antigo_h: 0, caixas: [] },
  ],
};

(async () => {
  await teste('desenha os quatro números, a lista e escapa HTML do nome', async () => {
    ctx.__resposta = resposta;
    await S.carregarHoje();
    const h = alvo.innerHTML;
    assert.ok(h.includes('Esperando por e-mail'));
    assert.ok(h.includes('>39<'));
    assert.ok(h.includes('29 de uma empresa, 10 de grupo'));
    assert.ok(h.includes('MTC Drive &lt;Locações&gt;'));
    assert.ok(!h.includes('<Locações>'));
    assert.ok(h.includes('13 dias'), 'idade em dias');
    assert.ok(h.includes('Douglas, Eduardo'), 'só o primeiro nome de cada caixa');
    assert.ok(h.includes('hoje-pill'), 'pedido de grupo marcado');
    assert.ok(!h.includes('Sem pedido'), 'empresa sem pedido não entra na lista');
    assert.ok(!/undefined|NaN|\[object/.test(h), 'lixo na tela');
  });
  await teste('sem leitura ainda: explica em vez de mostrar zeros', async () => {
    ctx.__resposta = { lido_em: null, clientes: [], dominios: [], totais: {} };
    await S.carregarHoje();
    assert.ok(alvo.innerHTML.includes('Ainda não há leitura de e-mails'));
  });
  await teste('leitura com mais de 8 dias é marcada como desatualizada; a de 5 dias não', async () => {
    ctx.__resposta = Object.assign({}, resposta, { lido_em: new Date(Date.now() - 9 * 24 * 3600000).toISOString() });
    await S.carregarHoje();
    assert.ok(alvo.innerHTML.includes('desatualizada'));
    ctx.__resposta = Object.assign({}, resposta, { lido_em: new Date(Date.now() - 5 * 24 * 3600000).toISOString() });
    await S.carregarHoje();
    assert.ok(!alvo.innerHTML.includes('desatualizada'));
  });
  await teste('erro do servidor aparece como aviso, sem quebrar a página', async () => {
    ctx.fetch = async () => ({ ok: false, status: 403, json: async () => ({ error: 'Acesso restrito à equipe autorizada.' }) });
    await S.carregarHoje();
    assert.ok(alvo.innerHTML.includes('Não foi possível carregar o bloco Hoje'));
    assert.ok(alvo.innerHTML.includes('Acesso restrito'));
  });
  await teste('mais de 12 empresas: mostra 12 e oferece "Ver as N empresas"', async () => {
    ctx.fetch = async () => ({ ok: true, status: 200, json: async () => ctx.__resposta });
    const muitas = Array.from({ length: 20 }, (_, i) => ({ cnpj: String(10000000000000 + i), nome: 'Empresa ' + i, aguardando_4h: 1, aguardando_7d: 0, aguardando_compartilhado: 0, mais_antigo_h: 10 + i, caixas: ['Ana'] }));
    ctx.__resposta = Object.assign({}, resposta, { clientes: muitas });
    S._hojeTodos = false;
    await S.carregarHoje();
    assert.strictEqual((alvo.innerHTML.match(/<tr><td>/g) || []).length, 12);
    assert.ok(alvo.innerHTML.includes('Ver as 20 empresas'));
    S.alternarHojeTodos();
    assert.strictEqual((alvo.innerHTML.match(/<tr><td>/g) || []).length, 20);
  });
  console.log(`\n${ok} testes passaram.`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
