'use strict';
// Rodar: node server/financeiro/testes_acesso_colaborador.js
// Confere, com o código REAL de autenticação, o que um COLABORADOR com a marca "Financeiro" (acesso_financeiro) alcança:
// a página /financeiro inteira, com valores, e mais nada. (Caso do bruno@escritorial.com.br, 15/10/2026.)
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://x:x@localhost:5432/x';
const assert = require('assert');
const http = require('http');
const express = require('express');
const { signAccess, requireAuth } = require('../auth');
const fin = require('./rotas');

let ok = 0;
const teste = async (nome, fn) => { await fn(); ok++; console.log('  ok -', nome); };

const app = express();
// mesmas barreiras do sistema: requireAuth global por prefixo + a regra da própria página
app.get('/api/financeiro/dados', requireAuth, fin.soFinanceiro, (req, res) => res.json({ ve_valores: fin.veValores(req.user) }));
app.get('/api/financeiro/ficha/123', requireAuth, fin.soFinanceiro, (req, res) => res.json({ ok: true }));
app.get('/api/cs/painel/dados', requireAuth, (req, res) => res.json({ ok: true }));
app.get('/api/cs/painel/anual', requireAuth, (req, res) => res.json({ ok: true }));
app.get('/api/data/clientes', requireAuth, (req, res) => res.json({ ok: true }));
app.get('/api/users', requireAuth, (req, res) => res.json({ ok: true }));
app.get('/api/data/legalizacao/painel', requireAuth, (req, res) => res.json({ ok: true }));
app.get('/api/gam/minha-nota', requireAuth, (req, res) => res.json({ ok: true }));
app.get('/api/qualidade/minhas', requireAuth, (req, res) => res.json({ ok: true }));
app.get('/api/cs/painel/qualidade/opcoes', requireAuth, (req, res) => res.json({ ok: true }));

const servidor = http.createServer(app);
const get = (porta, caminho, token) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port: porta, path: caminho, headers: token ? { Authorization: 'Bearer ' + token } : {} }, (r) => {
    const partes = []; r.on('data', (c) => partes.push(c));
    r.on('end', () => resolve({ status: r.statusCode, corpo: Buffer.concat(partes).toString('utf8') }));
  }).on('error', reject);
});

servidor.listen(0, '127.0.0.1', async () => {
  const porta = servidor.address().port;
  const colab = (extra) => signAccess(Object.assign({ id: 'u1', name: 'Bruno', role: 'colaborador' }, extra));
  const bruno = colab({ acesso_financeiro: true });
  try {
    await teste('colaborador com a marca Financeiro entra no /financeiro e vê valores em R$ (como o administrador)', async () => {
      const r = await get(porta, '/api/financeiro/dados', bruno);
      assert.strictEqual(r.status, 200);
      assert.strictEqual(JSON.parse(r.corpo).ve_valores, true);
      assert.strictEqual((await get(porta, '/api/financeiro/ficha/123', bruno)).status, 200);
    });
    await teste('o mesmo usuário NÃO alcança nenhuma outra área (CS, clientes, usuários, Legalização, Minha Nota)', async () => {
      for (const c of ['/api/cs/painel/dados', '/api/cs/painel/anual', '/api/data/clientes', '/api/users', '/api/data/legalizacao/painel']) {
        assert.strictEqual((await get(porta, c, bruno)).status, 403, c);
      }
    });
    await teste('colaborador SEM a marca é barrado também no /financeiro', async () => {
      assert.strictEqual((await get(porta, '/api/financeiro/dados', colab({}))).status, 403);
    });
    await teste('o administrador continua vendo tudo, e sem login ninguém entra', async () => {
      const adm = signAccess({ id: 'a1', name: 'Adm', role: 'administrador' });
      const r = await get(porta, '/api/financeiro/dados', adm);
      assert.strictEqual(r.status, 200);
      assert.strictEqual(JSON.parse(r.corpo).ve_valores, true);
      assert.strictEqual((await get(porta, '/api/financeiro/dados', null)).status, 401);
    });
    await teste('Financeiro sem valores: colaborador só com essa marca entra no /financeiro SEM valores e não abre o /cs', async () => {
      const sv = colab({ acesso_financeiro_sv: true });
      const r = await get(porta, '/api/financeiro/dados', sv);
      assert.strictEqual(r.status, 200);
      assert.strictEqual(JSON.parse(r.corpo).ve_valores, false);
      assert.strictEqual((await get(porta, '/api/cs/painel/dados', sv)).status, 403);
    });
    await teste('Minhas tratativas: colaborador com acesso_qualidade chega; Minha Nota sozinha, sem marca ou só com acesso_financeiro não', async () => {
      assert.strictEqual((await get(porta, '/api/qualidade/minhas', colab({ acesso_qualidade: true }))).status, 200);
      assert.strictEqual((await get(porta, '/api/qualidade/minhas', colab({ acesso_minha_nota: true }))).status, 403);
      assert.strictEqual((await get(porta, '/api/qualidade/minhas', colab({}))).status, 403);
      assert.strictEqual((await get(porta, '/api/qualidade/minhas', bruno)).status, 403);
    });
    await teste('Qualidade no /cs: gestor (acesso_gestor) e analista (acesso_qualidade) chegam às rotas de Qualidade, mas não ao resto do /cs; sem marca, não', async () => {
      const q = '/api/cs/painel/qualidade/opcoes';
      assert.strictEqual((await get(porta, q, colab({ acesso_gestor: true }))).status, 200);
      assert.strictEqual((await get(porta, q, colab({ acesso_qualidade: true }))).status, 200);
      assert.strictEqual((await get(porta, q, colab({}))).status, 403);
      assert.strictEqual((await get(porta, q, colab({ acesso_minha_nota: true }))).status, 403);
      for (const c of ['/api/cs/painel/dados', '/api/cs/painel/anual']) {
        assert.strictEqual((await get(porta, c, colab({ acesso_gestor: true }))).status, 403, c);
        assert.strictEqual((await get(porta, c, colab({ acesso_qualidade: true }))).status, 403, c);
      }
    });
    console.log(`\n${ok} testes passaram.`);
  } catch (e) { console.error('FALHOU:', e.message); process.exitCode = 1; }
  servidor.close(() => process.exit(process.exitCode || 0));
});
