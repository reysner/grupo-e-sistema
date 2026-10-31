'use strict';
// Confere, na pilha de rotas de server/routes/data.js, que as rotas sensíveis exigem administrador.
// Uso: node server/testes_rotas_so_admin.js   (não abre conexão com o banco)
process.env.JWT_SECRET = process.env.JWT_SECRET || 'segredo-de-teste-local';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'outro-segredo-de-teste-local';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://x:x@localhost:5432/x';
const assert = require('assert');
const router = require('./routes/data.js');
const { requireAdmin } = require('./auth.js');

const ROTAS = [
  ['get', '/sensiveis'], ['post', '/sensiveis'],
  ['get', '/clientes'], ['get', '/clientes/:id'], ['get', '/carteira/dashboard'],
  ['get', '/investimentos'], ['get', '/cac/dashboard'],
];
for (const [metodo, caminho] of ROTAS) {
  const camada = router.stack.find((l) => l.route && l.route.path === caminho && l.route.methods[metodo]);
  assert.ok(camada, `rota ${metodo.toUpperCase()} ${caminho} não encontrada`);
  assert.ok(camada.route.stack.some((s) => s.handle === requireAdmin), `${metodo.toUpperCase()} ${caminho} deveria exigir administrador`);
  console.log(`  ok - ${metodo.toUpperCase()} ${caminho} exige administrador`);
}
console.log(ROTAS.length + ' testes passaram.');
process.exit(0);
