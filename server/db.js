'use strict';
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      email      TEXT NOT NULL UNIQUE,
      password   TEXT NOT NULL,
      role       TEXT NOT NULL DEFAULT 'usuario' CHECK(role IN ('administrador','usuario')),
      active     INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS refresh_tokens (
      token      TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function query(text, params) {
  const res = await pool.query(text, params);
  return res;
}

async function getOne(text, params) {
  const res = await pool.query(text, params);
  return res.rows[0] || null;
}

async function getAll(text, params) {
  const res = await pool.query(text, params);
  return res.rows;
}

async function pruneExpiredTokens() {
  await pool.query(`DELETE FROM refresh_tokens WHERE expires_at < NOW()`);
}

module.exports = { pool, init, query, getOne, getAll, pruneExpiredTokens };
