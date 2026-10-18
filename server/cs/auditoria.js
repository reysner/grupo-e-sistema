'use strict';
/**
 * Logs de atividades e Backup do painel /cs (administração, 18/10/2026).
 *
 *   GET /api/cs/painel/admin/logs          -> (administrador) o que foi feito, por quem e quando (filtros: módulo, pessoa, ação, texto, datas)
 *   GET /api/cs/painel/admin/backup/info   -> (administrador) quantos registros há em cada tabela e os últimos backups baixados
 *   GET /api/cs/painel/admin/backup        -> (administrador) baixa um arquivo JSON com Qualidade, analistas, gestores, acessos e logs
 *
 * O registro das ações é automático: um filtro nas rotas de Qualidade, Acessos e Analistas anota toda ação que muda algo e deu certo
 * (quem, o quê, quando, de que IP). Usa a mesma tabela do "Log de Atividades" do sistema (log_atividades), com o módulo começando por "cs-".
 * O log nunca derruba a operação principal: se falhar, só deixa de anotar.
 */
const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../auth');

// ── tabela ────────────────────────────────────────────────────────────────────────
let tabelaPronta = null;
function garantirTabela() {
  if (!tabelaPronta) {
    tabelaPronta = pool.query(`CREATE TABLE IF NOT EXISTS log_atividades (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id TEXT NOT NULL, user_name TEXT NOT NULL,
      acao TEXT NOT NULL, modulo TEXT NOT NULL, descricao TEXT,
      ip TEXT, created_at TIMESTAMPTZ DEFAULT NOW()
    )`).then(() => pool.query('CREATE INDEX IF NOT EXISTS idx_log_atividades_data ON log_atividades (created_at DESC)'))
      .catch((e) => { tabelaPronta = null; throw e; });
  }
  return tabelaPronta;
}

async function registrar(quem, acao, modulo, descricao, ip) {
  try {
    await garantirTabela();
    await pool.query('INSERT INTO log_atividades (user_id, user_name, acao, modulo, descricao, ip) VALUES ($1, $2, $3, $4, $5, $6)',
      [String(quem && quem.id != null ? quem.id : 'sistema'), String((quem && quem.name) || 'Sistema'), acao, modulo, descricao ? String(descricao).slice(0, 1000) : null, ip || null]);
  } catch (e) { /* o log não pode quebrar a operação principal */ }
}
const quemDe = (req) => ({ id: req.user && req.user.id, name: req.user && req.user.name });
function ipDe(req) {
  const h = req.headers && req.headers['x-forwarded-for'];
  return (h ? String(h).split(',')[0].trim() : req.ip) || null;
}
const logReq = (req, acao, modulo, descricao) => registrar(quemDe(req), acao, modulo, descricao, ipDe(req));

// ── descrição das ações (pura, testável) ──────────────────────────────────────────
const curto = (t, n) => { const x = String(t == null ? '' : t).split(' ').filter(Boolean).join(' '); return x.length <= n ? x : x.slice(0, n) + '…'; };

/**
 * Traduz uma chamada (método + endereço + corpo) em { acao, modulo, texto, registroId?, analistaId?, usuarioId? }, ou null quando não é uma ação a registrar.
 * O que vem depois do texto (nome da empresa, assunto, nome do analista) é completado por enriquecer().
 */
function descreverAcao(metodo, url, corpo) {
  const m = String(metodo || '').toUpperCase();
  const b = corpo || {};
  const p = String(url || '').split('?')[0].split('/').filter(Boolean);
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return null;

  // lista de analistas (/api/analistas)
  if (p[0] === 'api' && p[1] === 'analistas') {
    if (m === 'POST') return { acao: 'criar', modulo: 'cs-analistas', texto: 'Incluiu o analista "' + curto(b.nome, 80) + '"' };
    if (m === 'PATCH') {
      const partes = [];
      if (b.nome !== undefined) partes.push('nome para "' + curto(b.nome, 80) + '"');
      if (b.ativo !== undefined) partes.push(b.ativo ? 'reativou' : 'desativou');
      return { acao: 'editar', modulo: 'cs-analistas', texto: 'Alterou o analista (' + (partes.join(', ') || 'dados') + ')', analistaId: p[2] };
    }
    if (m === 'DELETE') return { acao: 'excluir', modulo: 'cs-analistas', texto: 'Excluiu um analista da lista', analistaId: p[2] };
    return null;
  }
  // acessos por módulo (/api/cs/painel/acessos/:userId)
  if (p.includes('acessos') && p[0] === 'api') {
    if (m === 'PUT') {
      const mods = Array.isArray(b.modulos) ? b.modulos : null;
      return { acao: 'editar', modulo: 'cs-acessos', usuarioId: p[p.length - 1], texto: mods === null ? 'Voltou os módulos ao padrão do perfil' : 'Definiu os módulos de acesso: ' + (mods.length ? mods.join(', ') : 'nenhum') };
    }
    return null;
  }
  const i = p.indexOf('qualidade');
  if (p[0] !== 'api' || i < 0) return null;
  const r = p.slice(i + 1);
  const M = 'cs-qualidade';
  const id = (k) => r[k];
  if (m === 'POST' && r.length === 1 && r[0] === 'ocorrencias') return { acao: 'criar', modulo: M, texto: 'Registrou uma ocorrência: ' + curto(b.assunto, 100) + (b.tipo ? ' (' + b.tipo + (b.departamento ? ' · ' + b.departamento : '') + ')' : '') };
  if (m === 'POST' && r[0] === 'ocorrencias' && r[2] === 'anexo') return { acao: 'anexar', modulo: M, texto: 'Anexou um arquivo à ocorrência', registroId: id(1) };
  if (m === 'PUT' && r[0] === 'gestor' && r[1] === 'ocorrencias' && r[3] === 'tratativa') return { acao: 'editar', modulo: M, texto: 'Definiu a tratativa (plano, responsáveis e prazo)', registroId: id(2) };
  if (m === 'POST' && r[0] === 'gestor' && r[1] === 'ocorrencias') {
    const ac = { abrir: ['abrir', 'Abriu a ocorrência para os analistas'], validar: ['validar', 'Validou a tratativa'], devolver: ['devolver', 'Devolveu ao analista para ajustar'], filha: ['criar', 'Abriu uma ocorrência vinculada: ' + curto(b.assunto, 100)], cancelar: ['cancelar', 'Cancelou a ocorrência: ' + curto(b.motivo, 120)], mensagem: ['editar', 'Deixou uma mensagem para quem está tratando: ' + curto(b.texto, 120)], 'resposta-final': ['editar', 'Deixou a nota para o Gestor final (resposta final)'], reabrir: ['reabrir', 'Reabriu a ocorrência: ' + curto(b.motivo, 120)] }[r[3]];
    return ac ? { acao: ac[0], modulo: M, texto: ac[1], registroId: id(2) } : null;
  }
  if (m === 'POST' && r[0] === 'analista' && r[1] === 'ocorrencias') {
    if (r[3] === 'nota') return { acao: 'editar', modulo: M, texto: 'Anotou no meio da tratativa', registroId: id(2) };
    if (r[3] === 'encerrar') return { acao: 'encerrar', modulo: M, texto: 'Encerrou a sua parte da tratativa', registroId: id(2) };
    return null;
  }
  if (m === 'POST' && r[0] === 'sucesso' && r[1] === 'ocorrencias' && r[3] === 'encerrar') return { acao: 'encerrar', modulo: M, texto: 'Encerrou o processo (gestor final)', registroId: id(2) };
  if (m === 'POST' && r[0] === 'sucesso' && r[1] === 'ocorrencias' && r[3] === 'apontar') return { acao: 'editar', modulo: M, texto: b.analista_id === '__nenhum' ? 'Tirou o analista apontado (ninguém)' : b.analista_id ? 'Corrigiu o analista apontado para' : 'Voltou ao analista apontado no registro', registroId: id(2), analistaId: b.analista_id && b.analista_id !== '__nenhum' ? b.analista_id : undefined };
  if (r[0] === 'tipos') {
    if (m === 'POST') return { acao: 'criar', modulo: 'cs-qualidade', texto: 'Incluiu o tipo de registro "' + curto(b.nome, 40) + '" (peso ' + (b.peso == null ? '—' : b.peso) + ')' };
    if (m === 'PATCH') return { acao: 'editar', modulo: 'cs-qualidade', texto: 'Alterou um tipo de registro' + (b.nome ? ' (nome: "' + curto(b.nome, 40) + '")' : '') + (b.peso != null ? ' (peso ' + b.peso + ')' : '') + (b.ativo !== undefined ? (b.ativo ? ' (reativou)' : ' (desativou)') : '') };
    if (m === 'DELETE') return { acao: 'excluir', modulo: 'cs-qualidade', texto: 'Excluiu um tipo de registro' };
    return null;
  }
  if (r[0] === 'gestores') {
    if (m === 'POST') return { acao: 'criar', modulo: 'cs-acessos', usuarioId: b.user_id, texto: 'Cadastrou gestor(a): ' + (b.departamento || '—') + ' · ' + (b.papel || 'gestor') };
    if (m === 'DELETE') return { acao: 'excluir', modulo: 'cs-acessos', texto: 'Retirou um(a) gestor(a) de um departamento' };
    return null;
  }
  if (m === 'PUT' && r[0] === 'vinculo') return { acao: 'editar', modulo: 'cs-acessos', analistaId: id(1), usuarioId: b.user_id, texto: b.user_id ? 'Ligou o analista a um login' : 'Desligou o login do analista' };
  if (m === 'POST' && r[0] === 'vinculos' && r[1] === 'automatico') return { acao: 'editar', modulo: 'cs-acessos', texto: 'Ligou os logins aos analistas automaticamente' };
  if (m === 'PUT' && r[0] === 'analistas' && r[2] === 'departamentos') return { acao: 'editar', modulo: 'cs-acessos', analistaId: id(1), texto: 'Definiu os departamentos do analista: ' + ((b.departamentos || []).join(', ') || 'nenhum') };
  if (m === 'POST' && r.length === 0) return { acao: 'criar', modulo: M, texto: 'Lançou um plano de ação na ficha da empresa' };
  if (m === 'PATCH' && r.length === 1) return { acao: 'editar', modulo: M, texto: 'Alterou um registro' + (b.status ? ' (status: ' + b.status + ')' : '') + (b.prazo ? ' (prazo ' + b.prazo + ')' : ''), registroId: id(0) };
  if (m === 'DELETE' && r.length === 1) return { acao: 'excluir', modulo: M, texto: 'Excluiu um registro', registroId: id(0) };
  return null;
}

/** Completa o texto com o nome da empresa e do assunto, do analista ou da pessoa. */
async function enriquecer(d) {
  let t = d.texto;
  try {
    if (d.registroId) {
      const r = (await pool.query('SELECT assunto, cliente_nome FROM cs_qualidade_registros WHERE id::text = $1', [String(d.registroId)])).rows[0];
      if (r) t += ' — ' + [r.cliente_nome, r.assunto].filter(Boolean).join(' · ');
    }
    if (d.analistaId) {
      const a = (await pool.query('SELECT nome FROM analistas WHERE id::text = $1', [String(d.analistaId)])).rows[0];
      if (a) t += ' — ' + a.nome;
    }
    if (d.usuarioId) {
      const u = (await pool.query('SELECT name FROM users WHERE id::text = $1', [String(d.usuarioId)])).rows[0];
      if (u) t += ' — ' + u.name;
    }
  } catch (e) { /* segue com o texto simples */ }
  return t;
}

/** Filtro das rotas: depois que a resposta sai (e deu certo), anota a ação. */
function middleware() {
  return function (req, res, next) {
    const metodo = req.method;
    if (metodo === 'GET' || metodo === 'HEAD' || metodo === 'OPTIONS') return next();
    res.on('finish', () => {
      try {
        if (res.statusCode >= 400 || !req.user) return;
        const d = descreverAcao(metodo, req.originalUrl, req.body);
        if (!d) return;
        enriquecer(d).then((texto) => registrar(quemDe(req), d.acao, d.modulo, texto, ipDe(req)));
      } catch (e) { /* nunca atrapalha */ }
    });
    next();
  };
}

// ── consulta dos logs (pura, testável) ────────────────────────────────────────────
const ISO = /^\d{4}-\d{2}-\d{2}$/;
function montarConsulta(f) {
  f = f || {};
  const w = [], v = [];
  const modulo = f.modulo ? String(f.modulo) : 'cs';
  if (modulo === 'cs') w.push("modulo LIKE 'cs-%'");
  else if (modulo !== 'todos') { v.push(modulo); w.push('modulo = $' + v.length); }
  if (f.user && f.user !== 'todos') { v.push(String(f.user)); w.push('user_name = $' + v.length); }
  if (f.acao && f.acao !== 'todas') { v.push(String(f.acao)); w.push('acao = $' + v.length); }
  if (f.busca && String(f.busca).trim()) { v.push('%' + String(f.busca).trim() + '%'); w.push('(descricao ILIKE $' + v.length + ' OR user_name ILIKE $' + v.length + ')'); }
  if (f.de && ISO.test(String(f.de))) { v.push(String(f.de)); w.push("(created_at AT TIME ZONE 'America/Sao_Paulo')::date >= $" + v.length + '::date'); }
  if (f.ate && ISO.test(String(f.ate))) { v.push(String(f.ate)); w.push("(created_at AT TIME ZONE 'America/Sao_Paulo')::date <= $" + v.length + '::date'); }
  const pedido = parseInt(f.limite, 10);
  const limite = pedido > 0 ? Math.min(pedido, 1000) : 300;   // inválido ou negativo volta ao padrão
  return { sql: 'SELECT id, user_id, user_name, acao, modulo, descricao, ip, created_at FROM log_atividades' + (w.length ? ' WHERE ' + w.join(' AND ') : '') + ' ORDER BY created_at DESC LIMIT ' + limite, valores: v, limite };
}

// ── backup ────────────────────────────────────────────────────────────────────────
/**
 * O que entra no backup do módulo. Fora de propósito: os bytes dos arquivos anexados (só os nomes e tamanhos; podem ser centenas de MB),
 * as chaves privadas do aviso do navegador e os aparelhos cadastrados (dados pessoais de cada pessoa).
 */
const TABELAS_BACKUP = [
  ['analistas', 'SELECT * FROM analistas ORDER BY nome'],
  ['cs_acessos', 'SELECT * FROM cs_acessos ORDER BY user_id'],
  ['cs_qualidade_registros', 'SELECT * FROM cs_qualidade_registros ORDER BY criado_em'],
  ['cs_qualidade_resp', 'SELECT * FROM cs_qualidade_resp ORDER BY registro_id, analista_id'],
  ['cs_qualidade_historico', 'SELECT * FROM cs_qualidade_historico ORDER BY em'],
  ['cs_qualidade_tipos', 'SELECT * FROM cs_qualidade_tipos ORDER BY ordem'],
  ['cs_qualidade_gestores', 'SELECT * FROM cs_qualidade_gestores ORDER BY departamento'],
  ['cs_qualidade_anexos (só nomes)', 'SELECT id, registro_id, nome, mime, tamanho, criado_por, criado_em FROM cs_qualidade_anexos ORDER BY criado_em'],
  ['cs_painel_config', "SELECT chave, valor, atualizado_em, atualizado_por FROM cs_painel_config WHERE chave NOT ILIKE '%vapid%' AND chave NOT ILIKE '%secret%' AND chave NOT ILIKE '%private%'"],
  ['log_atividades (cs)', "SELECT * FROM log_atividades WHERE modulo LIKE 'cs-%' ORDER BY created_at"],
];
const vazio = () => ({ rows: [] });

async function montarBackup() {
  const dados = {}, totais = {};
  for (const [nome, sql] of TABELAS_BACKUP) {
    const r = await pool.query(sql).catch(vazio);
    dados[nome] = r.rows; totais[nome] = r.rows.length;
  }
  return { meta: { sistema: 'Grupo-E', tipo: 'Qualidade, analistas, gestores, acessos e logs do painel /cs', gerado_em: new Date().toISOString(), totais, observacao: 'Os arquivos anexados entram só com nome e tamanho; chaves privadas e aparelhos de aviso ficam de fora.' }, dados };
}
function carimbo() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' }).split(' ').join('_').split(':').join('-');
}

// ── começar do zero: limpar os dados de teste ────────────────────────────────────────
/**
 * Apaga as ocorrências do módulo Qualidade (e o que depende delas: histórico, responsáveis, anexos, avisos de prazo), os avisos do sino da Qualidade
 * e os Logs de atividades do painel. NÃO mexe em analistas, gestores, tipos de registro, acessos, configurações nem nos planos de ação da ficha das empresas.
 * Antes de apagar, guarda uma cópia do que vai sair (tabela cs_limpezas) e tudo corre numa transação: ou apaga tudo, ou nada.
 */
const CONFIRMA_LIMPEZA = 'LIMPAR';
const confirmacaoValida = (t) => String(t || '').trim() === CONFIRMA_LIMPEZA;
const DO_MODULO = "origem IN ('modulo', 'filha')";
const IDS_DO_MODULO = 'SELECT id FROM cs_qualidade_registros WHERE ' + DO_MODULO;
const CONTAGENS_LIMPEZA = {   // chave: [tabela, consulta da contagem]
  ocorrencias: ['cs_qualidade_registros', 'SELECT COUNT(*)::int AS n FROM cs_qualidade_registros WHERE ' + DO_MODULO],
  historico: ['cs_qualidade_historico', 'SELECT COUNT(*)::int AS n FROM cs_qualidade_historico WHERE registro_id IN (' + IDS_DO_MODULO + ')'],
  responsaveis: ['cs_qualidade_resp', 'SELECT COUNT(*)::int AS n FROM cs_qualidade_resp WHERE registro_id IN (' + IDS_DO_MODULO + ')'],
  anexos: ['cs_qualidade_anexos', 'SELECT COUNT(*)::int AS n FROM cs_qualidade_anexos WHERE registro_id IN (' + IDS_DO_MODULO + ')'],
  avisos_de_prazo: ['cs_qualidade_alertas', 'SELECT COUNT(*)::int AS n FROM cs_qualidade_alertas WHERE registro_id IN (' + IDS_DO_MODULO + ')'],
  sino: ['notificacoes', "SELECT COUNT(*)::int AS n FROM notificacoes WHERE tipo LIKE 'qualidade%'"],
  logs: ['log_atividades', "SELECT COUNT(*)::int AS n FROM log_atividades WHERE modulo LIKE 'cs-%'"],
};
/** Quais tabelas existem hoje (algumas só nascem no primeiro uso). */
async function tabelasQueExistem(db) {
  const nomes = ['cs_qualidade_registros', 'cs_qualidade_historico', 'cs_qualidade_resp', 'cs_qualidade_anexos', 'cs_qualidade_alertas', 'notificacoes', 'log_atividades'];
  const out = {};
  for (const n of nomes) out[n] = !!(((await db.query('SELECT to_regclass($1) IS NOT NULL AS ok', [n])).rows[0]) || {}).ok;
  return out;
}
async function contarParaLimpar(db, existe) {
  existe = existe || await tabelasQueExistem(db);
  const out = {};
  for (const k of Object.keys(CONTAGENS_LIMPEZA)) {
    const [tabela, sql] = CONTAGENS_LIMPEZA[k];
    out[k] = existe[tabela] ? (((await db.query(sql)).rows[0]) || { n: 0 }).n : 0;
  }
  return out;
}
async function executarLimpeza(pool, quem) {
  const c = pool.connect ? await pool.connect() : pool;
  try {
    const existe = await tabelasQueExistem(c);   // antes de abrir a transação: consultar tabela que não existe a deixaria abortada
    if (pool.connect) await c.query('BEGIN');
    const antes = await contarParaLimpar(c, existe);
    const copiar = async (tabela, sql) => (existe[tabela] ? (await c.query(sql)).rows : []);
    const copia = {
      ocorrencias: await copiar('cs_qualidade_registros', 'SELECT * FROM cs_qualidade_registros WHERE ' + DO_MODULO),
      historico: await copiar('cs_qualidade_historico', 'SELECT * FROM cs_qualidade_historico WHERE registro_id IN (' + IDS_DO_MODULO + ')'),
      responsaveis: await copiar('cs_qualidade_resp', 'SELECT * FROM cs_qualidade_resp WHERE registro_id IN (' + IDS_DO_MODULO + ')'),
      anexos_so_nomes: await copiar('cs_qualidade_anexos', 'SELECT id, registro_id, nome, mime, tamanho, criado_por, criado_em FROM cs_qualidade_anexos WHERE registro_id IN (' + IDS_DO_MODULO + ')'),
      avisos_de_prazo: await copiar('cs_qualidade_alertas', 'SELECT * FROM cs_qualidade_alertas WHERE registro_id IN (' + IDS_DO_MODULO + ')'),
      sino: await copiar('notificacoes', "SELECT * FROM notificacoes WHERE tipo LIKE 'qualidade%'"),
      logs: await copiar('log_atividades', "SELECT * FROM log_atividades WHERE modulo LIKE 'cs-%'"),
    };
    await c.query('CREATE TABLE IF NOT EXISTS cs_limpezas (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), feita_em TIMESTAMPTZ NOT NULL DEFAULT NOW(), feita_por TEXT, contagens JSONB NOT NULL, dados JSONB NOT NULL)');
    await c.query('INSERT INTO cs_limpezas (feita_por, contagens, dados) VALUES ($1, $2::jsonb, $3::jsonb)', [(quem && quem.name) || null, JSON.stringify(antes), JSON.stringify(copia)]);
    if (existe.cs_qualidade_anexos) await c.query('DELETE FROM cs_qualidade_anexos WHERE registro_id IN (' + IDS_DO_MODULO + ')');
    if (existe.cs_qualidade_registros) await c.query('DELETE FROM cs_qualidade_registros WHERE ' + DO_MODULO);   // histórico, responsáveis e avisos de prazo saem junto (cascata)
    if (existe.notificacoes) await c.query("DELETE FROM notificacoes WHERE tipo LIKE 'qualidade%'");
    if (existe.log_atividades) await c.query("DELETE FROM log_atividades WHERE modulo LIKE 'cs-%'");
    if (pool.connect) await c.query('COMMIT');
    return antes;
  } catch (e) {
    if (pool.connect) await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { if (c.release) c.release(); }
}

// ── rotas (administrador) ─────────────────────────────────────────────────────────
const router = express.Router();
router.use(requireAuth, (req, res, next) => {
  if (!req.user || req.user.role !== 'administrador') return res.status(403).json({ error: 'Só o administrador vê os logs e baixa o backup.' });
  next();
});

router.get('/logs', async (req, res) => {
  try {
    await garantirTabela();
    const c = montarConsulta(req.query);
    const { rows } = await pool.query(c.sql, c.valores);
    const modulos = (await pool.query('SELECT modulo, COUNT(*)::int AS n FROM log_atividades GROUP BY modulo ORDER BY modulo')).rows;
    const usuarios = (await pool.query("SELECT DISTINCT user_name FROM log_atividades WHERE modulo LIKE 'cs-%' ORDER BY user_name")).rows.map((x) => x.user_name);
    const acoes = (await pool.query("SELECT DISTINCT acao FROM log_atividades WHERE modulo LIKE 'cs-%' ORDER BY acao")).rows.map((x) => x.acao);
    res.json({ logs: rows, limite: c.limite, modulos, usuarios, acoes });
  } catch (e) { console.error('[auditoria] GET /logs falhou:', e); res.status(500).json({ error: 'Erro ao ler os logs.' }); }
});

router.get('/limpar-teste/previa', async (req, res) => {
  try { await garantirTabela(); res.json({ contagens: await contarParaLimpar(pool) }); }
  catch (e) { console.error('[auditoria] GET /limpar-teste/previa falhou:', e); res.status(500).json({ error: 'Erro ao contar o que será apagado.' }); }
});
router.post('/limpar-teste', async (req, res) => {
  if (!confirmacaoValida(req.body && req.body.confirmacao)) return res.status(400).json({ error: 'Para apagar, digite LIMPAR na confirmação.' });
  try {
    await garantirTabela();
    const apagado = await executarLimpeza(pool, quemDe(req));
    await logReq(req, 'limpar', 'cs-admin', 'Limpou os dados de teste do módulo Qualidade: ' + apagado.ocorrencias + ' ocorrência(s) e ' + apagado.logs + ' registro(s) de log (uma cópia ficou guardada no banco)');
    try { require('./painel').invalidarCache(); } catch (e) { /* expira sozinho */ }   // o risco não pode continuar contando o que foi apagado
    res.json({ ok: true, apagado });
  } catch (e) { console.error('[auditoria] POST /limpar-teste falhou:', e); res.status(500).json({ error: 'Erro ao limpar: nada foi apagado.' }); }
});

router.get('/backup/info', async (req, res) => {
  try {
    await garantirTabela();
    const totais = {};
    for (const [nome] of TABELAS_BACKUP) {
      const tabela = nome.split(' ')[0];
      if (tabela === 'log_atividades') totais[nome] = (await pool.query("SELECT COUNT(*)::int AS n FROM log_atividades WHERE modulo LIKE 'cs-%'").catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n;
      else totais[nome] = (await pool.query('SELECT COUNT(*)::int AS n FROM ' + tabela).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n;
    }
    const ultimos = (await pool.query("SELECT user_name, descricao, created_at FROM log_atividades WHERE modulo = 'cs-backup' OR (modulo = 'admin' AND descricao ILIKE 'Backup%') ORDER BY created_at DESC LIMIT 8")).rows;
    res.json({ totais, ultimos });
  } catch (e) { console.error('[auditoria] GET /backup/info falhou:', e); res.status(500).json({ error: 'Erro ao ler o backup.' }); }
});

router.get('/backup', async (req, res) => {
  try {
    const b = await montarBackup();
    await logReq(req, 'backup', 'cs-backup', 'Baixou o backup de Qualidade, analistas, gestores, acessos e logs');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="backup-qualidade-' + carimbo() + '.json"');
    res.send(JSON.stringify(b));
  } catch (e) { console.error('[auditoria] GET /backup falhou:', e); res.status(500).json({ error: 'Erro ao gerar o backup.' }); }
});

module.exports = { confirmacaoValida, executarLimpeza, contarParaLimpar, CONTAGENS_LIMPEZA, router, middleware, registrar, logReq, descreverAcao, montarConsulta, TABELAS_BACKUP, enriquecer };
