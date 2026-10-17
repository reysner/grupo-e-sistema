'use strict';
// Rodar: node server/testes_avisos.js  (avisos do navegador: notificação + som; navegador de mentira)
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let ok = 0;
const teste = async (nome, fn) => { await fn(); ok++; console.log('  ok -', nome); };

function criar({ permissao = 'default', respostaPedido = 'granted', hidden = false } = {}) {
  const armazem = {}, notificacoes = [], toques = [], balcoes = [];
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
  };
  janela.window = janela;
  vm.createContext(janela);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'avisos.js'), 'utf8'), janela);
  return { A: janela.window.Avisos, notificacoes, toques, balcoes, armazem, janela };
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
  console.log(`\n${ok} testes passaram.`);
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e); process.exit(1); });
