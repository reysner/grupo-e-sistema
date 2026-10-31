'use strict';
// Testes do filtro de acesso por perfil (server/auth.js) e do cadastro público desligado (server/routes/auth.js).
// Sem banco: o pool é simulado. Uso: node server/testes_acesso_perfis.js
process.env.JWT_SECRET = 'segredo-de-teste-local';
process.env.JWT_REFRESH_SECRET = 'outro-segredo-de-teste-local';
delete process.env.CADASTRO_PUBLICO;
const assert = require('assert');
const path = require('path');
const http = require('http');
const bcrypt = require('bcryptjs');
const express = require('express');

const consultas = [];
const hash = bcrypt.hashSync('SenhaDeTeste1', 4);
const poolFalso = {
  query: async (sql, params) => {
    consultas.push(String(sql).replace(/\s+/g, ' ').trim().slice(0, 60));
    if (/FROM users WHERE LOWER\(email\)/.test(sql) && /active = 1/.test(sql)) {
      return { rows: params[0] === 'ana@teste.com' ? [{ id: 'u1', name: 'Ana', email: 'ana@teste.com', role: 'usuario', password: hash }] : [] };
    }
    return { rows: [] };
  },
};
require.cache[require.resolve('./db.js')] = { id: 'db', filename: 'db.js', loaded: true, exports: { pool: poolFalso, init: async () => {}, pruneExpiredTokens: async () => {} } };
const auth = require('./auth.js');

let total = 0;
function ok(msg) { total++; console.log('  ok - ' + msg); }

// ── 1. requireAuth: o que colaborador e contábil alcançam ────────────────────
function chama(user, method, baseUrl, p) {
  const tk = auth.signAccess(user); let st = null, passou = false;
  const req = { headers: { authorization: 'Bearer ' + tk }, method, baseUrl, path: p, query: {} };
  const res = { status(c) { st = c; return this; }, json() { return this; } };
  auth.requireAuth(req, res, () => { passou = true; });
  return passou ? 200 : st;
}
const B = '/api/data';
const colab = { id: 'c1', name: 'Col', role: 'colaborador', acesso_legalizacao: true };
const semMarca = { id: 'c2', name: 'Col2', role: 'colaborador' };
const contabil = { id: 'c3', name: 'Cont', role: 'contabil', acesso_legalizacao: true };

assert.strictEqual(chama(colab, 'POST', B, '/legalizacao/solicitar-desativacao-certificado'), 200); ok('colaborador com a marca pede desativação de certificado');
assert.strictEqual(chama(colab, 'POST', B, '/legalizacao/alvaras/123/funcionamento/protocolo'), 200); ok('colaborador informa protocolo do alvará de funcionamento');
assert.strictEqual(chama(colab, 'POST', B, '/legalizacao/alvaras/123/sanitario/protocolo'), 200); ok('colaborador informa protocolo do alvará sanitário');
assert.strictEqual(chama(contabil, 'POST', B, '/legalizacao/solicitar-desativacao-certificado'), 200); ok('contábil com a marca também passa');
assert.strictEqual(chama(colab, 'PUT', B, '/legalizacao/alvaras/123/funcionamento'), 403); ok('editar alvará segue bloqueado');
assert.strictEqual(chama(colab, 'POST', B, '/legalizacao/alvaras/123/funcionamento/consultar-prefeitura'), 403); ok('consultar prefeitura segue bloqueado');
assert.strictEqual(chama(colab, 'POST', B, '/legalizacao/alvaras/123/outro/protocolo'), 403); ok('tipo de alvará inválido não passa');
assert.strictEqual(chama(semMarca, 'POST', B, '/legalizacao/solicitar-desativacao-certificado'), 403); ok('sem a marca de Legalização continua 403');
assert.strictEqual(chama(colab, 'GET', B, '/clientes'), 403); ok('colaborador não lê a Carteira');
assert.strictEqual(chama(colab, 'GET', B, '/cac/dashboard'), 403); ok('colaborador não lê o CAC');

// ── 2. Cadastro público desligado ────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use('/api/auth', require('./routes/auth.js'));
const srv = http.createServer(app).listen(0, async () => {
  const porta = srv.address().port;
  const post = (rota, corpo) => new Promise((resolve, reject) => {
    const dados = JSON.stringify(corpo);
    const r = http.request({ host: '127.0.0.1', port: porta, path: rota, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(dados) } }, (res) => {
      let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => resolve({ status: res.statusCode, corpo: JSON.parse(t || '{}') }));
    });
    r.on('error', reject); r.write(dados); r.end();
  });
  try {
    const reg = await post('/api/auth/register', { name: 'Intruso', email: 'novo@teste.com', password: 'abc12345' });
    assert.strictEqual(reg.status, 403);
    assert.ok(/desativado/i.test(reg.corpo.error));
    assert.ok(!consultas.some((q) => /INSERT INTO users/.test(q)));
    assert.strictEqual(consultas.length, 0);
    ok('POST /register devolve 403 e não toca o banco');

    const bom = await post('/api/auth/login', { email: 'ana@teste.com', password: 'SenhaDeTeste1' });
    assert.strictEqual(bom.status, 200);
    assert.ok(bom.corpo.token && bom.corpo.refreshToken && bom.corpo.user.role === 'usuario');
    ok('login com a senha certa devolve token');

    const ruim = await post('/api/auth/login', { email: 'ana@teste.com', password: 'errada' });
    assert.strictEqual(ruim.status, 401);
    ok('login com senha errada continua dando 401');
    console.log(total + ' testes passaram.');
  } catch (e) { console.error('FALHOU:', e.message); process.exitCode = 1; }
  srv.close();
});
