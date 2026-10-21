'use strict';
/**
 * Sinais de e-mail por cliente (piloto do Sucesso do Cliente).
 *
 * Quem produz: o job LOCAL server/emailSinais/coletar.js (na máquina do Reysner; lê só cabeçalhos das caixas do domínio).
 * O que chega aqui: SÓ contagens por cliente (CNPJ) e por domínio. Nenhum endereço de e-mail, assunto ou texto é recebido
 * nem guardado, e a lista de e-mails aprendidos fica só na máquina do job.
 *
 *   POST /api/cs/email-sinais        (token de sincronização, X-Sync-Token) -> grava a leitura inteira (substitui a anterior)
 *   GET  /api/cs/painel/email-sinais (login; administrador, usuário ou acesso_cs) -> a última leitura
 */
const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../auth');

const soDigitos = (s) => String(s || '').replace(/\D/g, '');
const int = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? Math.min(n, 100000) : 0; };
const texto = (s, n) => String(s == null ? '' : s).slice(0, n);

/** Valida e limpa o corpo recebido. Descarta o que não tem o formato esperado e NUNCA aceita nada que pareça endereço de e-mail. */
function validarPayload(corpo) {
  const b = corpo || {};
  const clientes = [];
  const vistos = new Set();
  (Array.isArray(b.clientes) ? b.clientes : []).forEach((c) => {
    const cnpj = soDigitos(c && c.cnpj);
    if (![11, 14].includes(cnpj.length) || vistos.has(cnpj)) return;
    vistos.add(cnpj);
    clientes.push({
      cnpj, contatos_ativos: int(c.contatos_ativos), mensagens_recebidas: int(c.mensagens_recebidas),
      aguardando_4h: int(c.aguardando_4h), aguardando_24h: int(c.aguardando_24h), aguardando_48h: int(c.aguardando_48h), aguardando_7d: int(c.aguardando_7d),
      aguardando_compartilhado: int(c.aguardando_compartilhado), mais_antigo_h: int(c.mais_antigo_h),
      provaveis_encerramentos: int(c.provaveis_encerramentos), resolvidos_zappy: int(c.resolvidos_zappy),
      caixas: (Array.isArray(c.caixas) ? c.caixas : []).filter((x) => typeof x === 'string' && !/@/.test(x)).slice(0, 12).map((x) => texto(x, 80)),
    });
  });
  const dominios = [];
  (Array.isArray(b.nao_identificados) ? b.nao_identificados : []).slice(0, 300).forEach((d) => {
    const dom = texto(d && d.dominio, 120);
    if (!dom || /@/.test(dom)) return;
    dominios.push({ dominio: dom, pessoal: !!d.pessoal, contatos: int(d.contatos), aguardando: int(d.aguardando), mais_antigo_h: int(d.mais_antigo_h) });
  });
  const t = b.totais || {};
  const totais = {};
  ['contatos', 'identificados', 'nao_identificados', 'aguardando', 'aguardando_exclusivos', 'aguardando_compartilhados', 'aguardando_nao_identificados', 'provaveis_encerramentos', 'resolvidos_zappy']
    .forEach((k) => { totais[k] = int(t[k]); });
  return { janela_dias: int(b.janela_dias) || 14, caixas_lidas: int(b.caixas_lidas), caixas_com_erro: int(b.caixas_com_erro), totais, clientes, dominios };
}

/**
 * Histórico para o módulo Atendimento (janela longa, 180 dias): por cliente, quantos e-mails chegaram, quantos ficaram sem resposta e,
 * por destinatário INTERNO (pessoa ou grupo do escritório), a mesma contagem. Nenhum endereço de cliente, assunto ou texto é recebido.
 * Endereços só são aceitos se forem do próprio escritório (domínios abaixo): são os grupos citados (dptofiscal@ etc.).
 */
const DOMINIOS_INTERNOS = ['escritorial.com.br', 'escritorialcontabil.com.br'];
const enderecoInterno = (n) => { const m = /^[a-z0-9._%+'-]+@([a-z0-9.-]+\.[a-z]{2,})$/i.exec(n); return !!m && DOMINIOS_INTERNOS.includes(m[1].toLowerCase()); };

function validarAtendimento(corpo) {
  const b = corpo || {};
  const clientes = []; const vistos = new Set();
  (Array.isArray(b.clientes) ? b.clientes : []).forEach((c) => {
    const cnpj = soDigitos(c && c.cnpj);
    if (![11, 14].includes(cnpj.length) || vistos.has(cnpj)) return;
    vistos.add(cnpj);
    const limpar = (lista) => (Array.isArray(lista) ? lista : []).slice(0, 60).map((d) => {
      const nome = texto(d && d.nome, 80).trim();
      if (!nome || (/@/.test(nome) && !enderecoInterno(nome))) return null;     // endereço de fora do escritório nunca entra
      const dias = {};   // por dia (AAAA-MM-DD): [recebidos, sem resposta]; só datas e números
      if (d && d.dias && typeof d.dias === 'object') {
        Object.keys(d.dias).slice(0, 400).forEach((k) => { const v = d.dias[k]; if (/^\d{4}-\d{2}-\d{2}$/.test(k) && Array.isArray(v)) dias[k] = [int(v[0]), int(v[1])]; });
      }
      return { nome, grupo: !!d.grupo, recebidos: int(d.recebidos), sem: int(d.sem), dias };
    }).filter(Boolean);
    clientes.push({ cnpj, recebidos: int(c.recebidos), sem_resposta: int(c.sem_resposta), comp_recebidos: int(c.compartilhados_recebidos), comp_sem: int(c.compartilhados_sem), destinatarios: limpar(c.destinatarios), comp_destinatarios: limpar(c.compartilhados_destinatarios) });
  });
  return { janela_dias: int(b.janela_dias) || 180, caixas_lidas: int(b.caixas_lidas), caixas_com_erro: int(b.caixas_com_erro), clientes };
}

let _schemaAt = null;
function garantirSchemaAtend() {
  if (!_schemaAt) {
    // RLS ligado e sem policy: só o servidor lê (regra do projeto para tabela nova).
    _schemaAt = pool.query(`CREATE TABLE IF NOT EXISTS cs_email_atendimento (
        cnpj TEXT PRIMARY KEY, recebidos INT NOT NULL DEFAULT 0, sem_resposta INT NOT NULL DEFAULT 0, destinatarios JSONB NOT NULL DEFAULT '[]')`)
      .then(() => pool.query('ALTER TABLE cs_email_atendimento ADD COLUMN IF NOT EXISTS comp_recebidos INT NOT NULL DEFAULT 0'))
      .then(() => pool.query('ALTER TABLE cs_email_atendimento ADD COLUMN IF NOT EXISTS comp_sem INT NOT NULL DEFAULT 0'))
      .then(() => pool.query("ALTER TABLE cs_email_atendimento ADD COLUMN IF NOT EXISTS comp_destinatarios JSONB NOT NULL DEFAULT '[]'"))
      .then(() => pool.query('ALTER TABLE cs_email_atendimento ENABLE ROW LEVEL SECURITY'))
      .then(() => pool.query(`CREATE TABLE IF NOT EXISTS cs_email_atendimento_leitura (
        id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1), lido_em TIMESTAMPTZ NOT NULL DEFAULT NOW(), janela_dias INT NOT NULL DEFAULT 180, caixas_lidas INT NOT NULL DEFAULT 0)`))
      .then(() => pool.query('ALTER TABLE cs_email_atendimento_leitura ENABLE ROW LEVEL SECURITY'))
      .catch((e) => { _schemaAt = null; throw e; });
  }
  return _schemaAt;
}

let _schema = null;
function garantirSchema() {
  if (!_schema) {
    // RLS ligado e sem policy: só o servidor lê (regra do projeto para tabela nova).
    _schema = pool.query(`CREATE TABLE IF NOT EXISTS cs_email_sinais (
        cnpj TEXT PRIMARY KEY, contatos_ativos INT NOT NULL DEFAULT 0, mensagens_recebidas INT NOT NULL DEFAULT 0,
        aguardando_4h INT NOT NULL DEFAULT 0, aguardando_24h INT NOT NULL DEFAULT 0, aguardando_48h INT NOT NULL DEFAULT 0, aguardando_7d INT NOT NULL DEFAULT 0,
        aguardando_compartilhado INT NOT NULL DEFAULT 0, mais_antigo_h INT NOT NULL DEFAULT 0,
        provaveis_encerramentos INT NOT NULL DEFAULT 0, resolvidos_zappy INT NOT NULL DEFAULT 0, caixas TEXT[] NOT NULL DEFAULT '{}')`)
      .then(() => pool.query(`ALTER TABLE cs_email_sinais ENABLE ROW LEVEL SECURITY`))
      .then(() => pool.query(`CREATE TABLE IF NOT EXISTS cs_email_sinais_leitura (
        id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1), lido_em TIMESTAMPTZ NOT NULL DEFAULT NOW(), janela_dias INT NOT NULL DEFAULT 14,
        caixas_lidas INT NOT NULL DEFAULT 0, caixas_com_erro INT NOT NULL DEFAULT 0, totais JSONB NOT NULL DEFAULT '{}', dominios JSONB NOT NULL DEFAULT '[]')`))
      .then(() => pool.query(`ALTER TABLE cs_email_sinais_leitura ENABLE ROW LEVEL SECURITY`))
      .catch((e) => { _schema = null; throw e; });
  }
  return _schema;
}

function tokenSyncOk(req, res) {
  const esperado = process.env.LEGALIZACAO_SYNC_TOKEN || process.env.CERTISEGURO_SYNC_TOKEN;
  if (!esperado) { res.status(503).json({ error: 'Sincronização não configurada no servidor.' }); return false; }
  if (req.get('X-Sync-Token') !== esperado) { res.status(401).json({ error: 'Token de sincronização inválido.' }); return false; }
  return true;
}
const PAPEIS = ['administrador', 'usuario'];
const podeVer = (u) => !!u && (PAPEIS.includes(u.role) || !!u.acessoCs);

const router = express.Router();

router.post('/', async (req, res) => {
  if (!tokenSyncOk(req, res)) return;
  const b = req.body || {};
  if (!Array.isArray(b.clientes)) return res.status(400).json({ error: 'Informe a lista de clientes.' });
  if (b.clientes.length > 5000) return res.status(413).json({ error: 'Lista grande demais.' });
  // leitura incompleta nunca substitui a anterior: com caixa sem ler, os números ficariam menores do que a realidade
  if (int(b.caixas_com_erro) > 0) return res.status(422).json({ error: 'Leitura incompleta: há caixas com erro. Nada foi gravado.' });
  const v = validarPayload(b);
  let client = null;
  try {
    await garantirSchema();
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query('DELETE FROM cs_email_sinais');
    if (v.clientes.length) {
      const C = v.clientes;
      await client.query(
        `INSERT INTO cs_email_sinais (cnpj, contatos_ativos, mensagens_recebidas, aguardando_4h, aguardando_24h, aguardando_48h, aguardando_7d,
                                      aguardando_compartilhado, mais_antigo_h, provaveis_encerramentos, resolvidos_zappy, caixas)
         SELECT cnpj, ca, mr, a4, a24, a48, a7, ac, mh, pe, rz, COALESCE(string_to_array(NULLIF(cx, ''), '|'), '{}'::text[])
           FROM unnest($1::text[], $2::int[], $3::int[], $4::int[], $5::int[], $6::int[], $7::int[], $8::int[], $9::int[], $10::int[], $11::int[], $12::text[])
                AS x(cnpj, ca, mr, a4, a24, a48, a7, ac, mh, pe, rz, cx)`,
        [C.map((c) => c.cnpj), C.map((c) => c.contatos_ativos), C.map((c) => c.mensagens_recebidas), C.map((c) => c.aguardando_4h), C.map((c) => c.aguardando_24h),
          C.map((c) => c.aguardando_48h), C.map((c) => c.aguardando_7d), C.map((c) => c.aguardando_compartilhado), C.map((c) => c.mais_antigo_h),
          C.map((c) => c.provaveis_encerramentos), C.map((c) => c.resolvidos_zappy), C.map((c) => c.caixas.join('|'))]);
    }
    await client.query(
      `INSERT INTO cs_email_sinais_leitura (id, lido_em, janela_dias, caixas_lidas, caixas_com_erro, totais, dominios)
       VALUES (1, NOW(), $1, $2, $3, $4::jsonb, $5::jsonb)
       ON CONFLICT (id) DO UPDATE SET lido_em = NOW(), janela_dias = EXCLUDED.janela_dias, caixas_lidas = EXCLUDED.caixas_lidas,
         caixas_com_erro = EXCLUDED.caixas_com_erro, totais = EXCLUDED.totais, dominios = EXCLUDED.dominios`,
      [v.janela_dias, v.caixas_lidas, v.caixas_com_erro, JSON.stringify(v.totais), JSON.stringify(v.dominios)]);
    await client.query('COMMIT');
    res.json({ ok: true, clientes: v.clientes.length, descartados: b.clientes.length - v.clientes.length });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error('[email-sinais] POST falhou:', err);
    res.status(500).json({ error: 'Erro ao gravar os sinais de e-mail.', detalhe: String(err && err.message).slice(0, 300) });   // rota máquina-a-máquina (token): o detalhe ajuda a achar a causa
  } finally { if (client) client.release(); }
});

/** Grava o histórico de 180 dias (token de sincronização). Leitura incompleta nunca substitui a anterior. */
router.post('/atendimento', async (req, res) => {
  if (!tokenSyncOk(req, res)) return;
  const b = req.body || {};
  if (!Array.isArray(b.clientes)) return res.status(400).json({ error: 'Informe a lista de clientes.' });
  if (b.clientes.length > 5000) return res.status(413).json({ error: 'Lista grande demais.' });
  if (int(b.caixas_com_erro) > 0) return res.status(422).json({ error: 'Leitura incompleta: há caixas com erro. Nada foi gravado.' });
  const v = validarAtendimento(b);
  let client = null;
  try {
    await garantirSchemaAtend();
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query('DELETE FROM cs_email_atendimento');
    if (v.clientes.length) {
      const C = v.clientes;
      await client.query(
        `INSERT INTO cs_email_atendimento (cnpj, recebidos, sem_resposta, destinatarios, comp_recebidos, comp_sem, comp_destinatarios)
         SELECT cnpj, r, s, d::jsonb, cr, cs, cd::jsonb FROM unnest($1::text[], $2::int[], $3::int[], $4::text[], $5::int[], $6::int[], $7::text[]) AS x(cnpj, r, s, d, cr, cs, cd)`,
        [C.map((c) => c.cnpj), C.map((c) => c.recebidos), C.map((c) => c.sem_resposta), C.map((c) => JSON.stringify(c.destinatarios)), C.map((c) => c.comp_recebidos), C.map((c) => c.comp_sem), C.map((c) => JSON.stringify(c.comp_destinatarios))]);
    }
    await client.query(
      `INSERT INTO cs_email_atendimento_leitura (id, lido_em, janela_dias, caixas_lidas) VALUES (1, NOW(), $1, $2)
       ON CONFLICT (id) DO UPDATE SET lido_em = NOW(), janela_dias = EXCLUDED.janela_dias, caixas_lidas = EXCLUDED.caixas_lidas`,
      [v.janela_dias, v.caixas_lidas]);
    await client.query('COMMIT');
    res.json({ ok: true, clientes: v.clientes.length });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error('[email-atendimento] POST falhou:', err);
    res.status(500).json({ error: 'Erro ao gravar o histórico de e-mails.', detalhe: String(err && err.message).slice(0, 300) });
  } finally { if (client) client.release(); }
});

router.get('/', requireAuth, async (req, res) => {
  if (!podeVer(req.user)) return res.status(403).json({ error: 'Acesso restrito à equipe autorizada.' });
  try {
    await garantirSchema();
    const l = await pool.query(`SELECT lido_em, janela_dias, caixas_lidas, caixas_com_erro, totais, dominios FROM cs_email_sinais_leitura WHERE id = 1`);
    if (!l.rows.length) return res.json({ lido_em: null, clientes: [], dominios: [], totais: {} });
    const c = await pool.query(
      `SELECT s.cnpj, cl.nome_empresa AS nome, s.contatos_ativos, s.mensagens_recebidas, s.aguardando_4h, s.aguardando_24h, s.aguardando_48h, s.aguardando_7d,
              s.aguardando_compartilhado, s.mais_antigo_h, s.provaveis_encerramentos, s.resolvidos_zappy, s.caixas
         FROM cs_email_sinais s
         LEFT JOIN clientes cl ON regexp_replace(cl.cnpj, '\\D', '', 'g') = s.cnpj AND cl.status = 'ativo'
        ORDER BY (s.aguardando_4h + s.aguardando_compartilhado) DESC, s.mais_antigo_h DESC`);
    const r = l.rows[0];
    res.json({ lido_em: r.lido_em, janela_dias: r.janela_dias, caixas_lidas: r.caixas_lidas, totais: r.totais, dominios: r.dominios, clientes: c.rows });
  } catch (err) {
    console.error('[email-sinais] GET falhou:', err);
    res.status(500).json({ error: 'Erro ao ler os sinais de e-mail.' });
  }
});

module.exports = { router, validarPayload, validarAtendimento, garantirSchemaAtend };
