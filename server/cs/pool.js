'use strict';
/**
 * Resolve o pool `pg` do resto do sistema (server/db.js), que NÃO está
 * neste pacote (ver CONTEXTO_PROJETO_GRUPO_E.md, seção 10). Aceita os
 * dois formatos comuns de export — ajuste aqui, e só aqui, se nenhum
 * dos dois bater com o `server/db.js` real.
 */
function obterPool() {
  const dbModule = require('../db');
  if (dbModule && typeof dbModule.query === 'function') return dbModule;
  if (dbModule && dbModule.pool && typeof dbModule.pool.query === 'function') return dbModule.pool;
  throw new Error(
    'server/cs/pool.js: não encontrei o pool em ../db (esperava module.exports = pool ' +
    'ou module.exports = { pool }). Ajuste obterPool() conforme o export real de server/db.js.'
  );
}
module.exports = { obterPool };
