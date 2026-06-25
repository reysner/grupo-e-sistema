'use strict';
// Node.js 22+ built-in SQLite — zero external dependency
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'grupoe.db');
const db = new DatabaseSync(DB_PATH);

// Suppress experimental warning in production
process.removeAllListeners('warning');

function init() {
  db.exec(`PRAGMA journal_mode=WAL;`);
  db.exec(`PRAGMA foreign_keys=ON;`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      email      TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password   TEXT NOT NULL,
      role       TEXT NOT NULL DEFAULT 'usuario' CHECK(role IN ('administrador','usuario')),
      active     INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS refresh_tokens (
      token      TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS atendimentos (
      id           TEXT PRIMARY KEY,
      user_id      TEXT NOT NULL REFERENCES users(id),
      analista     TEXT NOT NULL,
      cliente      TEXT NOT NULL,
      cnpj         TEXT NOT NULL,
      empresa      TEXT NOT NULL,
      departamento TEXT NOT NULL,
      procurado    TEXT NOT NULL,
      demanda      TEXT NOT NULL,
      resumo       TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS gestao_clientes (
      id           TEXT PRIMARY KEY,
      user_id      TEXT NOT NULL REFERENCES users(id),
      analista     TEXT NOT NULL,
      solicitacao  TEXT NOT NULL,
      cnpj         TEXT NOT NULL,
      empresa      TEXT NOT NULL,
      data_sol     TEXT NOT NULL,
      competencia  TEXT NOT NULL,
      canal        TEXT NOT NULL,
      motivo       TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS insatisfacoes (
      id           TEXT PRIMARY KEY,
      user_id      TEXT NOT NULL REFERENCES users(id),
      analista     TEXT NOT NULL,
      cliente      TEXT NOT NULL,
      cnpj         TEXT NOT NULL,
      empresa      TEXT NOT NULL,
      reclamado    TEXT,
      reclamacao   TEXT NOT NULL,
      gravidade    TEXT NOT NULL,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS clientes_sensiveis (
      id           TEXT PRIMARY KEY,
      user_id      TEXT NOT NULL REFERENCES users(id),
      analista     TEXT NOT NULL,
      cliente      TEXT NOT NULL,
      cnpj         TEXT NOT NULL,
      empresa      TEXT NOT NULL,
      demonstrou   TEXT NOT NULL,
      gravidade    TEXT NOT NULL,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS pesquisas (
      id           TEXT PRIMARY KEY,
      user_id      TEXT NOT NULL REFERENCES users(id),
      analista     TEXT NOT NULL,
      cliente      TEXT NOT NULL,
      cnpj         TEXT NOT NULL,
      empresa      TEXT NOT NULL,
      nps          INTEGER NOT NULL,
      csat         INTEGER NOT NULL,
      ces          INTEGER NOT NULL,
      pontos       TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS recuperacoes (
      id           TEXT PRIMARY KEY,
      user_id      TEXT NOT NULL REFERENCES users(id),
      analista     TEXT NOT NULL,
      cliente      TEXT NOT NULL,
      cnpj         TEXT NOT NULL,
      empresa      TEXT NOT NULL,
      demonstrou   TEXT NOT NULL,
      gravidade    TEXT NOT NULL,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

// Helper: convert query result rows (null prototype objects) to plain objects
function rows(stmt, ...args) {
  const result = stmt.all(...args);
  return result.map(r => ({ ...r }));
}

function get(stmt, ...args) {
  const r = stmt.get(...args);
  return r ? { ...r } : null;
}

module.exports = { db, init, rows, get };
