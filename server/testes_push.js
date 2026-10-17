'use strict';
// Rodar: node server/testes_push.js  (push do navegador: cadastro de aparelhos e envio, com banco e biblioteca de mentira)
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://x:x@localhost:5432/x';
const assert = require('assert');
const { criar, validarAssinatura, montarCarga, destinatarios } = require('./push');

let ok = 0;
const teste = async (nome, fn) => { await fn(); ok++; console.log('  ok -', nome); };

/** Banco de mentira: guarda as chamadas e responde às consultas que o módulo faz. */
function banco(assinaturas) {
  const chamadas = []; let vapid = null;
  return {
    chamadas,
    async query(sql, params) {
      chamadas.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
      if (/SELECT valor FROM cs_painel_config/.test(sql)) return { rows: vapid ? [{ valor: vapid }] : [] };
      if (/INSERT INTO cs_painel_config/.test(sql)) { vapid = JSON.parse(params[1]); return { rows: [] }; }
      if (/FROM push_assinaturas WHERE user_id = ANY/.test(sql)) return { rows: assinaturas.filter((a) => params[0].includes(a.user_id)) };
      return { rows: [] };
    },
  };
}
function lib(falhas) {
  const enviados = [], detalhes = [];
  return {
    enviados, detalhes,
    generateVAPIDKeys: () => ({ publicKey: 'PUB', privateKey: 'PRIV' }),
    setVapidDetails: (assunto, pub, priv) => detalhes.push([assunto, pub, priv]),
    async sendNotification(sub, carga, opcoes) {
      if (falhas && falhas[sub.endpoint]) { const e = new Error('falhou'); e.statusCode = falhas[sub.endpoint]; throw e; }
      enviados.push({ sub, carga: JSON.parse(carga), opcoes });
    },
  };
}
const SUB = { endpoint: 'https://push.exemplo/abc', keys: { p256dh: 'P', auth: 'A' } };

(async () => {
  await teste('inscrição: só https, com as duas chaves de segurança', async () => {
    assert.strictEqual(validarAssinatura(SUB).ok, true);
    assert.strictEqual(validarAssinatura({ endpoint: 'http://x', keys: SUB.keys }).ok, false);
    assert.strictEqual(validarAssinatura({ endpoint: SUB.endpoint, keys: { p256dh: 'P' } }).ok, false);
    assert.strictEqual(validarAssinatura(null).ok, false);
    assert.strictEqual(validarAssinatura({ endpoint: 'https://' + 'a'.repeat(1001), keys: SUB.keys }).ok, false);
  });
  await teste('destinatários: sem repetidos, sem vazios e sem quem fez a ação', async () => {
    assert.deepStrictEqual(destinatarios([['1', '2', '2'], [3, '', null, '1']], '2'), ['1', '3']);
    assert.deepStrictEqual(destinatarios([[], []], null), []);
    assert.deepStrictEqual(destinatarios(null, null), []);
  });
  await teste('carga do aviso: título, texto e endereço; corta o excesso', async () => {
    const c = JSON.parse(montarCarga({ titulo: 'T'.repeat(200), texto: 'x', url: '/cs?aba=gestor', tag: 'o1' }));
    assert.strictEqual(c.titulo.length, 120);
    assert.deepStrictEqual([c.texto, c.url, c.tag], ['x', '/cs?aba=gestor', 'o1']);
    assert.strictEqual(JSON.parse(montarCarga({})).url, '/cs');
  });
  await teste('chaves: geradas uma vez e guardadas no banco; a segunda vez só lê', async () => {
    const b = banco([]), l = lib();
    const p = criar(b, l);
    assert.strictEqual(await p.preparar(), 'PUB');
    assert.strictEqual(b.chamadas.filter((c) => /INSERT INTO cs_painel_config/.test(c.sql)).length, 1);
    assert.deepStrictEqual(l.detalhes[0].slice(1), ['PUB', 'PRIV']);
    assert.ok(/^https?:\/\//.test(l.detalhes[0][0]), 'o assunto do envio é um endereço, não o e-mail de alguém');
    const p2 = criar(b, lib());          // outra instância do servidor: lê as chaves que já existem
    assert.strictEqual(await p2.preparar(), 'PUB');
    assert.strictEqual(b.chamadas.filter((c) => /INSERT INTO cs_painel_config/.test(c.sql)).length, 1);
  });
  await teste('cadastrar o aparelho: grava para a pessoa; inscrição inválida não grava; descadastrar só apaga o dela', async () => {
    const b = banco([]), p = criar(b, lib());
    assert.strictEqual((await p.assinar('u1', SUB, 'Chrome')).ok, true);
    const ins = b.chamadas.filter((c) => /INSERT INTO push_assinaturas/.test(c.sql));
    assert.strictEqual(ins.length, 1);
    assert.deepStrictEqual(ins[0].params, ['u1', SUB.endpoint, 'P', 'A', 'Chrome']);
    assert.strictEqual((await p.assinar('u1', { endpoint: 'x' })).ok, false);
    assert.strictEqual(b.chamadas.filter((c) => /INSERT INTO push_assinaturas/.test(c.sql)).length, 1);
    await p.cancelar('u1', SUB.endpoint);
    const del = b.chamadas.filter((c) => /DELETE FROM push_assinaturas WHERE endpoint/.test(c.sql));
    assert.deepStrictEqual(del[0].params, [SUB.endpoint, 'u1']);
  });
  await teste('enviar: um envio por aparelho das pessoas indicadas, com título, texto e endereço', async () => {
    const assin = [{ id: 1, user_id: 'u1', endpoint: 'https://a', p256dh: 'p1', auth: 'a1' }, { id: 2, user_id: 'u1', endpoint: 'https://b', p256dh: 'p2', auth: 'a2' }, { id: 3, user_id: 'u9', endpoint: 'https://c', p256dh: 'p3', auth: 'a3' }];
    const b = banco(assin), l = lib(), p = criar(b, l);
    const r = await p.enviar(['u1', 'u1'], { titulo: 'Nova ocorrência', texto: 'ALFA — guia', url: '/cs?aba=gestor', tag: 'o1' });
    assert.deepStrictEqual([r.enviados, r.removidos], [2, 0]);
    assert.deepStrictEqual(l.enviados.map((e) => e.sub.endpoint).sort(), ['https://a', 'https://b']);
    assert.deepStrictEqual(l.enviados[0].carga, { titulo: 'Nova ocorrência', texto: 'ALFA — guia', url: '/cs?aba=gestor', tag: 'o1' });
    assert.strictEqual(l.enviados[0].opcoes.urgency, 'high');
  });
  await teste('aparelho que não existe mais (404/410) sai do cadastro; outra falha só é registrada; nada disso lança erro', async () => {
    const assin = [{ id: 1, user_id: 'u1', endpoint: 'https://velho', p256dh: 'p', auth: 'a' }, { id: 2, user_id: 'u1', endpoint: 'https://lento', p256dh: 'p', auth: 'a' }, { id: 3, user_id: 'u1', endpoint: 'https://bom', p256dh: 'p', auth: 'a' }];
    const b = banco(assin), p = criar(b, lib({ 'https://velho': 410, 'https://lento': 500 }));
    const avisoAntes = console.warn; console.warn = () => {};
    const r = await p.enviar(['u1'], { titulo: 'x' });
    console.warn = avisoAntes;
    assert.deepStrictEqual([r.enviados, r.removidos], [1, 1]);
    const del = b.chamadas.filter((c) => /DELETE FROM push_assinaturas WHERE id = ANY/.test(c.sql));
    assert.deepStrictEqual(del[0].params, [[1]]);
  });
  await teste('sem destinatário nem aparelho: não envia; erro do banco não derruba quem chamou', async () => {
    const b = banco([]), l = lib(), p = criar(b, l);
    assert.deepStrictEqual(await p.enviar([], { titulo: 'x' }), { enviados: 0, removidos: 0 });
    assert.strictEqual((await p.enviar(['u1'], { titulo: 'x' })).enviados, 0);
    const quebrado = criar({ query: async () => { throw new Error('banco fora'); } }, lib());
    const avisoAntes = console.warn; console.warn = () => {};
    const r = await quebrado.enviar(['u1'], { titulo: 'x' });
    console.warn = avisoAntes;
    assert.strictEqual(r.erro, true);
  });
  console.log(`\n${ok} testes passaram.`);
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e); process.exit(1); });
