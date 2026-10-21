'use strict';
/**
 * Acessos do painel /cs: quais módulos cada pessoa enxerga (administração, 18/10/2026).
 *
 *   GET  /api/cs/painel/acessos            -> (administrador) catálogo de módulos + cada usuário ativo com o que tem hoje
 *   PUT  /api/cs/painel/acessos/:userId    -> (administrador) { modulos: [...] } define os módulos da pessoa; { modulos: null } volta ao padrão do perfil
 *
 * Regras:
 *  - Administrador sempre vê tudo (e é o único que vê "Acessos").
 *  - Pessoa SEM configuração segue o padrão do perfil (equipe do painel, gestor, analista), como sempre foi.
 *  - Pessoa COM configuração vê exatamente os módulos marcados; as rotas do servidor de cada módulo recusam (403) quem não o tem.
 *  - Os dados da carteira (/dados) são compartilhados: basta um módulo de indicadores para chegar neles.
 */
const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../auth');

/** codigo = o que fica gravado; secao = o id da seção no painel; grupo = só para organizar a tela. */
const CATALOGO = [
  { codigo: 'visao', secao: 'visao', rotulo: 'Visão Geral', grupo: 'Indicadores da carteira', dados: true },
  { codigo: 'inteligente', secao: 'analise', rotulo: 'Análise Inteligente', grupo: 'Indicadores da carteira', dados: true },
  { codigo: 'anual', secao: 'anual', rotulo: 'Análise Anual', grupo: 'Indicadores da carteira', dados: true },
  { codigo: 'atendimento', secao: 'atendimento', rotulo: 'Atendimento', grupo: 'Indicadores da carteira', dados: true },
  { codigo: 'permanencia', secao: 'risco', rotulo: 'Gestão da Permanência', grupo: 'Indicadores da carteira', dados: true },
  { codigo: 'churn', secao: 'churn', rotulo: 'Churn', grupo: 'Indicadores da carteira', dados: true },
  { codigo: 'categorias', secao: 'categorias', rotulo: 'Categorias', grupo: 'Indicadores da carteira', dados: true },
  { codigo: 'qualidade_dados', secao: 'qualidade', rotulo: 'Qualidade dos Dados', grupo: 'Indicadores da carteira', dados: true },
  { codigo: 'qualidade', secao: 'consideracoes', rotulo: 'Qualidade', grupo: 'Qualidade e portais' },
  { codigo: 'gestor', secao: 'gestor', rotulo: 'Portal do Gestor', grupo: 'Qualidade e portais' },
  { codigo: 'analista', secao: 'analista', rotulo: 'Portal do Analista', grupo: 'Qualidade e portais' },
  { codigo: 'sucesso', secao: 'sucesso', rotulo: 'Portal do Sucesso do Cliente', grupo: 'Qualidade e portais' },
  // Minha área (analista): vieram do portal antigo /qualidade. Todo analista tem por padrão; cada tela mostra só os dados da própria pessoa.
  { codigo: 'minha_nota', secao: 'minhanota', rotulo: 'Minha nota', grupo: 'Minha área (analista)' },
  { codigo: 'meus_atendimentos', secao: 'meusatend', rotulo: 'Meus atendimentos', grupo: 'Minha área (analista)' },
  { codigo: 'meus_emails', secao: 'meusemails', rotulo: 'Meus e-mails', grupo: 'Minha área (analista)' },
  { codigo: 'minha_evolucao', secao: 'minhaevolucao', rotulo: 'Evolução semanal', grupo: 'Minha área (analista)' },
  { codigo: 'minhas_prioridades', secao: 'minhasprior', rotulo: 'Prioridades', grupo: 'Minha área (analista)' },
  // Ranking da Gamificação (Liga do Atendimento): era a página pública /gamificacao; agora é um item do menu, liberado a todos por padrão.
  { codigo: 'gamificacao', secao: 'gamificacao', rotulo: 'Gamificação (ranking)', grupo: 'Minha área (analista)' },
];
const MINHA_AREA = ['minha_nota', 'meus_atendimentos', 'meus_emails', 'minha_evolucao', 'minhas_prioridades'];
const ACESSOS = { codigo: 'acessos', secao: 'acessos', rotulo: 'Acessos', grupo: 'Administração' };   // só administrador; não é configurável
const CODIGOS = CATALOGO.map((m) => m.codigo);
const DADOS = CATALOGO.filter((m) => m.dados).map((m) => m.codigo);
const SO_PORTAIS = ['qualidade', 'gestor', 'analista', 'sucesso', 'gamificacao'].concat(MINHA_AREA);

/** Os módulos que a pessoa teria sem configuração: administrador tudo; equipe do painel os indicadores + Qualidade + Sucesso do Cliente; os demais, só o que o perfil dá. */
function modulosPadrao(p) {
  p = p || {};
  if (p.admin) return CODIGOS.concat(['acessos']);
  const m = ['qualidade', 'gamificacao'];   // o ranking da Gamificação é de todos (antes era uma página pública)
  if (p.equipe) DADOS.forEach((c) => m.push(c)), m.push('sucesso');
  else if (p.sucesso) m.push('sucesso');
  if (p.gestor) m.push('gestor');
  if (p.analista) m.push('analista', ...MINHA_AREA);   // analista: o portal e a Minha área (nota, atendimentos, e-mails, evolução, prioridades)
  return CODIGOS.filter((c) => m.includes(c));
}

/** Lista válida a gravar: só códigos do catálogo, sem repetir, na ordem do catálogo. null = voltar ao padrão. */
function limparModulos(m) {
  if (m === null || m === undefined) return null;
  if (!Array.isArray(m)) return undefined;
  const set = new Set(m.map((x) => String(x)));
  return CODIGOS.filter((c) => set.has(c));
}

/** O que a pessoa vê de fato. cfg = módulos gravados (array) ou null/undefined quando não há configuração. */
function modulosEfetivos(perfil, cfg) {
  if (perfil && perfil.admin) return CODIGOS.concat(['acessos']);
  if (Array.isArray(cfg)) return CODIGOS.filter((c) => cfg.includes(c));
  return modulosPadrao(perfil);
}

/** Quais módulos liberam uma rota do painel (caminho depois de /api/cs/painel). null = a rota não é de um módulo só (ou tem controle próprio). */
function modulosDaRota(caminho) {
  const p = String(caminho || '').split('?')[0];
  const comeca = (x) => p === x || p.startsWith(x + '/');
  if (comeca('/qualidade') || comeca('/acessos')) return null;   // controle próprio (server/cs/qualidade.js e este arquivo)
  if (comeca('/anual')) return ['anual', 'inteligente'];
  if (comeca('/honorario-sugerido')) return ['inteligente', 'anual'];
  if (comeca('/atendimentos') || comeca('/atendimento')) return ['atendimento'];
  if (comeca('/churn-motivos') || comeca('/churn')) return ['churn', 'visao'];
  if (comeca('/categorias')) return ['categorias', 'permanencia', 'visao'];
  if (comeca('/dados') || comeca('/cliente') || comeca('/email-sinais')) return DADOS.slice();   // dados da carteira: um módulo de indicadores basta
  return null;
}

/** Decide uma rota para quem tem configuração. */
function rotaPermitida(caminho, modulos) {
  const exigidos = modulosDaRota(caminho);
  if (!exigidos) return true;
  return exigidos.some((c) => (modulos || []).includes(c));
}

/** Bastam estes módulos para a pessoa CHEGAR no painel como equipe (dados da carteira) ou só nos módulos de Qualidade/portais. */
const temModuloDeDados = (modulos) => (modulos || []).some((c) => DADOS.includes(c));
const temModuloDePortal = (modulos) => (modulos || []).some((c) => SO_PORTAIS.includes(c));

// ── banco ───────────────────────────────────────────────────────────────────────────
let schemaPronto = null;
/** 21/10/2026: quem já tinha lista de módulos gravada (Acessos) e é analista não ganhava os módulos novos (Minha área e Gamificação), porque lista gravada vence o padrão.
 *  Uma única vez, soma esses módulos às listas que têm o portal do analista; depois disso valem as escolhas feitas em Acessos. */
async function migrarMinhaArea() {
  await pool.query('CREATE TABLE IF NOT EXISTS cs_acessos_migracoes (nome TEXT PRIMARY KEY, feita_em TIMESTAMPTZ NOT NULL DEFAULT NOW())');
  const marca = await pool.query("INSERT INTO cs_acessos_migracoes (nome) VALUES ('minha_area_analista') ON CONFLICT (nome) DO NOTHING RETURNING nome");
  if (!marca.rows.length) return;
  const novos = MINHA_AREA.concat(['gamificacao']);
  await pool.query(
    "UPDATE cs_acessos SET modulos = modulos || $1::jsonb, atualizado_em = NOW() WHERE modulos @> '[\"analista\"]'::jsonb AND NOT (modulos ?| $2::text[])",
    [JSON.stringify(novos), novos]);
  cache.clear();
}

function garantirSchema() {
  if (!schemaPronto) {
    schemaPronto = pool.query(`CREATE TABLE IF NOT EXISTS cs_acessos (
      user_id TEXT PRIMARY KEY,
      modulos JSONB NOT NULL,
      atualizado_por TEXT,
      atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`).then(migrarMinhaArea).catch((e) => { schemaPronto = null; throw e; });
  }
  return schemaPronto;
}

const cache = new Map();   // user_id -> { em, modulos }; vale 20 s e é limpo ao gravar
const VALE_MS = 20000;
/** Os módulos gravados para a pessoa (array) ou null quando não há configuração. Falha de banco = null (cai no padrão do perfil). */
async function lerConfig(userId) {
  const id = String(userId);
  const c = cache.get(id);
  if (c && Date.now() - c.em < VALE_MS) return c.modulos;
  let modulos = null;
  try {
    await garantirSchema();
    const r = await pool.query('SELECT modulos FROM cs_acessos WHERE user_id = $1', [id]);
    modulos = r.rows.length && Array.isArray(r.rows[0].modulos) ? limparModulos(r.rows[0].modulos) : null;
  } catch (e) { return null; }
  cache.set(id, { em: Date.now(), modulos });
  return modulos;
}

/** Para o login: o que a configuração acrescenta às marcas do token (chegar nas rotas do painel e nas de Qualidade/portais). */
async function marcasDeAcesso(userId) {
  const cfg = await lerConfig(userId);
  return { configurado: Array.isArray(cfg), cs: Array.isArray(cfg) && temModuloDeDados(cfg), portais: Array.isArray(cfg) && temModuloDePortal(cfg) };
}

/** Barreira das rotas do painel: quem tem configuração só passa nas rotas dos módulos que tem. Sem token válido ou sem configuração, segue (a rota confere o resto). */
function restringir(lerToken) {
  return async function (req, res, next) {
    try {
      const u = lerToken(req);
      if (!u || u.role === 'administrador') return next();
      const cfg = await lerConfig(u.sub);
      if (!Array.isArray(cfg)) return next();
      if (!rotaPermitida(req.path, cfg)) return res.status(403).json({ error: 'Você não tem acesso a este módulo. Peça à administração em Acessos.' });
      next();
    } catch (e) { next(); }
  };
}

// ── rotas (administrador) ─────────────────────────────────────────────────────────────
const router = express.Router();
router.use(require('./auditoria').middleware());
router.use(requireAuth, (req, res, next) => {
  if (!req.user || req.user.role !== 'administrador') return res.status(403).json({ error: 'Só o administrador define os acessos.' });
  next();
});

router.get('/', async (req, res) => {
  try {
    await garantirSchema();
    const users = (await pool.query('SELECT id::text AS id, name, email, role, acesso_cs, acesso_qualidade FROM users WHERE active = 1 ORDER BY name')).rows;
    const gestores = new Set((await pool.query('SELECT DISTINCT user_id FROM cs_qualidade_gestores').then((r) => r.rows).catch(() => [])).map((g) => String(g.user_id)));
    const sucessos = new Set((await pool.query("SELECT DISTINCT user_id FROM cs_qualidade_gestores WHERE departamento = 'Sucesso' OR papel = 'final'").then((r) => r.rows).catch(() => [])).map((g) => String(g.user_id)));
    const cfgs = new Map((await pool.query('SELECT user_id, modulos, atualizado_por, atualizado_em FROM cs_acessos').then((r) => r.rows)).map((c) => [String(c.user_id), c]));
    const itens = users.map((u) => {
      const perfil = { admin: u.role === 'administrador', equipe: u.role === 'usuario' || !!u.acesso_cs, gestor: gestores.has(u.id), analista: !!u.acesso_qualidade, sucesso: sucessos.has(u.id) };
      const c = cfgs.get(u.id);
      const cfg = c && Array.isArray(c.modulos) ? limparModulos(c.modulos) : null;
      return {
        id: u.id, nome: u.name, email: u.email, papel: u.role, admin: perfil.admin,
        definido: Array.isArray(cfg), modulos: modulosEfetivos(perfil, cfg), padrao: modulosPadrao(perfil),
        atualizado_por: c ? c.atualizado_por : null, atualizado_em: c ? c.atualizado_em : null,
        entra_padrao: perfil.admin || perfil.equipe || perfil.gestor || perfil.analista,
        entra_no_painel: perfil.admin || perfil.equipe || perfil.gestor || perfil.analista || Array.isArray(cfg),
      };
    });
    res.json({ catalogo: CATALOGO.map(({ codigo, rotulo, grupo }) => ({ codigo, rotulo, grupo })), usuarios: itens });
  } catch (e) { console.error('[acessos] GET falhou:', e); res.status(500).json({ error: 'Erro ao ler os acessos.' }); }
});

router.put('/:userId', async (req, res) => {
  try {
    await garantirSchema();
    const id = String(req.params.userId);
    const u = (await pool.query('SELECT id::text AS id, name, role FROM users WHERE id::text = $1 AND active = 1', [id])).rows[0];
    if (!u) return res.status(404).json({ error: 'Pessoa não encontrada entre os usuários ativos.' });
    if (u.role === 'administrador') return res.status(400).json({ error: 'Administrador sempre vê todos os módulos.' });
    const lista = limparModulos(req.body ? req.body.modulos : undefined);
    if (lista === undefined) return res.status(400).json({ error: 'Informe modulos como lista (ou null para voltar ao padrão).' });
    if (lista === null) await pool.query('DELETE FROM cs_acessos WHERE user_id = $1', [id]);
    else await pool.query(
      `INSERT INTO cs_acessos (user_id, modulos, atualizado_por, atualizado_em) VALUES ($1, $2::jsonb, $3, NOW())
       ON CONFLICT (user_id) DO UPDATE SET modulos = EXCLUDED.modulos, atualizado_por = EXCLUDED.atualizado_por, atualizado_em = NOW()`,
      [id, JSON.stringify(lista), req.user.name || null]);
    cache.delete(id);
    res.json({ ok: true, modulos: lista });
  } catch (e) { console.error('[acessos] PUT falhou:', e); res.status(500).json({ error: 'Erro ao salvar os acessos.' }); }
});

module.exports = {
  router, restringir, lerConfig, marcasDeAcesso, modulosPadrao, modulosEfetivos, modulosDaRota, rotaPermitida, limparModulos,
  temModuloDeDados, temModuloDePortal, CATALOGO, ACESSOS, CODIGOS, DADOS,
};
