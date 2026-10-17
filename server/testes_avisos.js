'use strict';
// Rodar: node server/testes_avisos.js  (avisos do navegador: notificação + som; navegador de mentira)
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let ok = 0;
const teste = async (nome, fn) => { await fn(); ok++; console.log('  ok -', nome); };

function criar({ permissao = 'default', respostaPedido = 'granted', hidden = false, push = false } = {}) {
  const armazem = {}, notificacoes = [], toques = [], balcoes = [], chamadasFetch = [], ouvintes = {};
  let assinatura = null;
  const reg = { pushManager: {
    getSubscription: async () => assinatura,
    subscribe: async (o) => { assinatura = { endpoint: 'https://push.exemplo/x', opcoes: o, toJSON() { return { endpoint: this.endpoint, keys: { p256dh: 'P', auth: 'A' } }; }, unsubscribe: async () => { assinatura = null; return true; } }; return assinatura; },
  } };
  const servico = { register: async () => reg, ready: Promise.resolve(reg), getRegistration: async () => reg, addEventListener: (t, fn) => { ouvintes[t] = fn; } };
  const resposta = (corpo) => ({ ok: true, status: 200, json: async () => corpo });
  class Notificacao { constructor(t, o) { this.t = t; this.o = o; notificacoes.push(this); } close() {} }
  Notificacao.permission = permissao;
  Notificacao.requestPermission = async () => { Notificacao.permission = respostaPedido; return respostaPedido; };
  class Audio { constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {}; }
    createOscillator() { toques.push(1); return { frequency: {}, connect() {}, start() {}, stop() {} }; }
    createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; } }
  const el = (id) => ({ id, innerHTML: '', style: {}, querySelector: () => null, addEventListener() {}, appendChild() {}, setAttribute() {}, textContent: '' });
  const janela = {
    document: {
      hidden, title: 'Painel', head: { appendChild() {} }, body: { appendChild(n) { balcoes.push(n); } },
      getElementById: () => null, createElement: () => el('x'), addEventListener() {},
    },
    localStorage: { getItem: (k) => (k in armazem ? armazem[k] : null), setItem: (k, v) => { armazem[k] = String(v); }, removeItem: (k) => { delete armazem[k]; } },
    Notification: Notificacao, AudioContext: Audio, alert() {}, focus() {}, setTimeout: () => 0,
    navigator: push ? { serviceWorker: servico } : {}, PushManager: push ? function PushManager() {} : undefined,
    atob: (b64) => Buffer.from(b64, 'base64').toString('binary'), Uint8Array,
    fetch: async (url, opt) => { chamadasFetch.push({ url, opt }); return resposta(url === '/api/push/chave' ? { chave: 'BPdTkQ0M3nS0c0pIu8QmYV1b5Yf9o8Zy7gJmQxFhQ1Jb9VbT8sXv7L2wq3m0Nn1dQeJk4dQp0z7bQe9xT5Hf2sI' } : { ok: true }); },
  };
  janela.window = janela;
  vm.createContext(janela);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'avisos.js'), 'utf8'), janela);
  return { A: janela.window.Avisos, notificacoes, toques, balcoes, armazem, janela, chamadasFetch, ouvintes, assinatura: () => assinatura };
}

(async () => {
  await teste('desligado por padrão: aviso não faz nada (nem som, nem notificação, nem balão)', async () => {
    const t = criar();
    assert.strictEqual(t.A.ativo(), false);
    assert.strictEqual(t.A.alertar({ titulo: 'Oi' }), false);
    assert.strictEqual(t.notificacoes.length + t.toques.length + t.balcoes.length, 0);
  });
  await teste('ligar: pede a permissão do navegador, guarda a escolha e toca um teste (libera o som)', async () => {
    const t = criar();
    const r = await t.A.ativar();
    assert.deepStrictEqual([r.permissao, r.ativo], ['granted', true]);
    assert.strictEqual(t.A.ativo(), true);
    assert.ok(t.toques.length >= 2, 'toca dois toques de teste');
  });
  await teste('ligado e com permissão: notificação do sistema + som + balão na página; tag e texto vão junto', async () => {
    const t = criar();
    await t.A.ativar(); const antes = t.toques.length;
    assert.strictEqual(t.A.alertar({ titulo: 'Nova ocorrência: Erro (Alta)', texto: 'ALFA LTDA — guia errada', tag: 'o1' }), true);
    assert.strictEqual(t.notificacoes.length, 1);
    assert.deepStrictEqual([t.notificacoes[0].t, t.notificacoes[0].o.body, t.notificacoes[0].o.tag], ['Nova ocorrência: Erro (Alta)', 'ALFA LTDA — guia errada', 'o1']);
    assert.ok(t.toques.length > antes, 'tocou o som');
    assert.strictEqual(t.balcoes.length, 1);
  });
  await teste('som desligado: só notificação e balão', async () => {
    const t = criar();
    await t.A.ativar(); t.A.ligarSom && t.A.ligarSom(false);
    t.janela.localStorage.setItem('ge_avisos_som', '0');
    const antes = t.toques.length;
    t.A.alertar({ titulo: 'x' });
    assert.strictEqual(t.toques.length, antes);
    assert.strictEqual(t.notificacoes.length, 1);
  });
  await teste('permissão negada: sem notificação do sistema, mas som e balão continuam', async () => {
    const t = criar({ permissao: 'denied' });
    await t.A.ativar(); const antes = t.toques.length;
    t.A.alertar({ titulo: 'x', texto: 'y' });
    assert.strictEqual(t.notificacoes.length, 0);
    assert.ok(t.toques.length > antes);
    assert.strictEqual(t.balcoes.length, 1);
  });
  await teste('desligar de novo: deixa de avisar', async () => {
    const t = criar();
    await t.A.ativar(); t.A.desativar();
    assert.strictEqual(t.A.alertar({ titulo: 'x' }), false);
    assert.strictEqual(t.notificacoes.length, 0);
  });
  await teste('aba escondida: o título da aba ganha o contador', async () => {
    const t = criar({ hidden: true });
    await t.A.ativar();
    t.A.alertar({ titulo: 'a' }); t.A.alertar({ titulo: 'b' });
    assert.strictEqual(t.janela.document.title, '(2) Painel');
  });
  const elFalso = () => ({ innerHTML: '', querySelector: () => null });
  await teste('push: ao ligar, registra o service worker, busca a chave, inscreve o aparelho e cadastra no servidor (com o login da página)', async () => {
    const t = criar({ push: true });
    t.A.montarControle(elFalso(), { token: () => 'JWT-DA-PAGINA' });
    const r = await t.A.ativar();
    assert.strictEqual(r.push, 'ok');
    assert.strictEqual(t.A.pushAtivo(), true);
    assert.deepStrictEqual(t.chamadasFetch.map((c) => c.url), ['/api/push/chave', '/api/push/assinar']);
    assert.strictEqual(t.chamadasFetch[0].opt.headers.Authorization, 'Bearer JWT-DA-PAGINA');
    const corpo = JSON.parse(t.chamadasFetch[1].opt.body);
    assert.deepStrictEqual([corpo.subscription.endpoint, corpo.subscription.keys.auth], ['https://push.exemplo/x', 'A']);
    assert.strictEqual(t.assinatura().opcoes.userVisibleOnly, true, 'o navegador exige aviso visível');
    assert.ok(t.assinatura().opcoes.applicationServerKey instanceof t.janela.Uint8Array || t.assinatura().opcoes.applicationServerKey.length > 40, 'a chave pública vai como bytes');
  });
  await teste('push: desligar descadastra o aparelho no servidor e esquece a marca', async () => {
    const t = criar({ push: true });
    t.A.montarControle(elFalso(), { token: () => 'J' });
    await t.A.ativar();
    await t.A.desativar();
    assert.strictEqual(t.A.pushAtivo(), false);
    assert.strictEqual(t.A.ativo(), false);
    const c = t.chamadasFetch[t.chamadasFetch.length - 1];
    assert.strictEqual(c.url, '/api/push/cancelar');
    assert.strictEqual(JSON.parse(c.opt.body).endpoint, 'https://push.exemplo/x');
    assert.strictEqual(t.assinatura(), null);
  });
  await teste('push: sem permissão ou sem suporte do navegador, não cadastra e os avisos seguem só com a página aberta', async () => {
    const negado = criar({ push: true, permissao: 'denied' });
    negado.A.montarControle(elFalso(), { token: () => 'J' });
    assert.strictEqual((await negado.A.ativar()).push, 'sem-permissao');
    assert.strictEqual(negado.chamadasFetch.length, 0);
    const antigo = criar({ push: false });
    antigo.A.montarControle(elFalso(), { token: () => 'J' });
    const r = await antigo.A.ativar();
    assert.strictEqual(r.push, 'indisponivel');
    assert.strictEqual(antigo.A.pushAtivo(), false);
    assert.strictEqual(antigo.A.alertar({ titulo: 'x' }), true, 'o aviso com a página aberta continua');
  });
  await teste('push: o service worker manda o aviso para a página aberta (balão e som), e o mesmo fato não repete', async () => {
    const t = criar({ push: true });
    t.A.montarControle(elFalso(), { token: () => 'J' });
    await t.A.ativar(); const antes = t.toques.length, bal = t.balcoes.length;
    assert.ok(typeof t.ouvintes.message === 'function', 'a página ouve o service worker');
    const msg = { data: { tipo: 'push', aviso: { titulo: 'Nova ocorrência: Erro (Alta)', texto: 'ALFA', tag: 'o1', url: '/cs?aba=gestor' } } };
    t.ouvintes.message(msg);
    assert.strictEqual(t.balcoes.length, bal + 1);
    assert.ok(t.toques.length > antes, 'tocou o som');
    t.ouvintes.message(msg);
    assert.strictEqual(t.balcoes.length, bal + 1, 'mesma tag: não repete');
    assert.strictEqual(t.A.alertar({ titulo: 'Nova ocorrência: Erro (Alta)', tag: 'o1' }), false, 'a consulta periódica também não repete o que o push já avisou');
    t.ouvintes.message({ data: { tipo: 'outra-coisa' } });
    assert.strictEqual(t.balcoes.length, bal + 1);
  });
  await teste('abrir um aviso usa a navegação da página (sem recarregar) quando ela define uma', async () => {
    const t = criar({ push: true });
    const abertos = [];
    t.A.montarControle(elFalso(), { token: () => 'J', navegar: (u) => abertos.push(u) });
    t.A.abrir('/cs?aba=gestor');
    assert.deepStrictEqual(abertos, ['/cs?aba=gestor']);
  });
  console.log(`\n${ok} testes passaram.`);
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e); process.exit(1); });
