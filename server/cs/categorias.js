'use strict';
/**
 * Categorias de cliente (Diamante / Ouro / Prata / Bronze) — alinhamento de 05/10/2026 (Reysner × Larissa).
 *
 * A categoria é a MAIOR entre:
 *   1) honorário mensal atual da própria empresa;
 *   2) soma dos honorários do grupo (Grupo de Empresas de Gestão de Clientes, ou TAG do Acessórias marcada como "grupo");
 *   3) piso Ouro para empresas do próprio Grupo-E (TAGs Hands, Devia, Talentos... marcadas como "piso Ouro").
 * Toda categoria vem com o MOTIVO por escrito (pedido do Reysner: "sempre apresentar o motivo").
 *
 * Endpoints (montados em /api/cs/categorias):
 *   GET  /                    -> categoria + motivo de cada cliente ativo (qualquer usuário logado)
 *   GET  /config              -> faixas, TAGs do Acessórias e grupos pra revisão (admin)
 *   PUT  /config              -> grava faixas e o tratamento de cada TAG (admin)
 *   POST /sincronizar-tags    -> puxa as TAGs e as empresas de cada TAG do Acessórias (admin, roda em segundo plano)
 */
const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireAdmin } = require('../auth');
const acessorias = require('../acessoriasClient');

const CHAVE_CORTES = 'categoria_cortes';
const CHAVE_SYNC_TAGS = 'categoria_tags_sync';
const CORTES_PADRAO = { prata: 250, ouro: 500, diamante: 1000 };
const ORDEM = { Bronze: 0, Prata: 1, Ouro: 2, Diamante: 3 };
const TRATAMENTOS = ['ignorar', 'piso_ouro', 'grupo'];
// Empresas do Grupo-E: nascem como piso Ouro (o admin pode mudar na tela de Categorias).
const REGEX_TAG_GRUPO_E = /hands|devia|talentos/i;

const moeda = (v) => 'R$ ' + Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const inteiro = (v) => Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 0 });
const soDigitos = (s) => String(s || '').replace(/\D/g, '');

function categoriaPorValor(valor, cortes) {
  const v = Number(valor);
  if (!(v > 0)) return null;
  if (v >= cortes.diamante) return 'Diamante';
  if (v >= cortes.ouro) return 'Ouro';
  if (v >= cortes.prata) return 'Prata';
  return 'Bronze';
}

function faixaTexto(cat, cortes) {
  if (cat === 'Diamante') return `a partir de R$ ${inteiro(cortes.diamante)}`;
  if (cat === 'Ouro') return `R$ ${inteiro(cortes.ouro)} a ${inteiro(cortes.diamante - 1)}`;
  if (cat === 'Prata') return `R$ ${inteiro(cortes.prata)} a ${inteiro(cortes.ouro - 1)}`;
  return `abaixo de R$ ${inteiro(cortes.prata)}`;
}

/**
 * entrada: { honorario, grupos: [{ nome, origem: 'grupo'|'tag', soma, qtd }], tagsPiso: ['Hands', ...] }
 * Devolve { categoria, motivo, honorario, soma_grupo, grupo }.
 */
function categorizar(entrada, cortes = CORTES_PADRAO) {
  const honorario = Number(entrada.honorario) > 0 ? Number(entrada.honorario) : null;
  const candidatos = [];

  for (const tag of entrada.tagsPiso || []) {
    candidatos.push({ cat: 'Ouro', prec: 3, motivo: `TAG "${tag}" (empresa do Grupo-E): piso Ouro` });
  }
  for (const g of entrada.grupos || []) {
    if (!(g.qtd >= 2)) continue;
    const cat = categoriaPorValor(g.soma, cortes);
    if (!cat) continue;
    const rotulo = g.origem === 'tag' ? `grupo (TAG "${g.nome}")` : `grupo "${g.nome}"`;
    candidatos.push({
      cat, prec: 2, grupo: g,
      motivo: `soma do ${rotulo}, ${g.qtd} empresas: ${moeda(g.soma)} (faixa ${faixaTexto(cat, cortes)})`,
    });
  }
  const catInd = categoriaPorValor(honorario, cortes);
  if (catInd) {
    candidatos.push({ cat: catInd, prec: 1, motivo: `honorário ${moeda(honorario)} (faixa ${faixaTexto(catInd, cortes)})` });
  }

  if (!candidatos.length) {
    return { categoria: null, motivo: 'Sem honorário cadastrado e sem grupo ou TAG que defina a categoria', honorario, soma_grupo: null, grupo: null };
  }
  candidatos.sort((a, b) => ORDEM[b.cat] - ORDEM[a.cat] || b.prec - a.prec);
  const melhor = candidatos[0];
  return {
    categoria: melhor.cat,
    motivo: melhor.motivo,
    honorario,
    soma_grupo: melhor.grupo ? melhor.grupo.soma : null,
    grupo: melhor.grupo ? melhor.grupo.nome : null,
  };
}

/** Monta, para cada cliente ativo, a entrada de `categorizar` (grupos por Gestão de Clientes e por TAG). */
function montarEntradas(clientes, vinculosTags) {
  const porGrupo = new Map(); // chave minúscula -> { nome, soma, ids:Set }
  const porTag = new Map();   // tag_id -> { nome, soma, ids:Set }
  const tagsDoCnpj = new Map(); // cnpj (dígitos) -> [{ id, nome, tratamento }]
  for (const v of vinculosTags) {
    if (!tagsDoCnpj.has(v.cnpj)) tagsDoCnpj.set(v.cnpj, []);
    tagsDoCnpj.get(v.cnpj).push({ id: v.tag_id, nome: v.tag_nome, tratamento: v.tratamento });
  }

  for (const c of clientes) {
    const h = Number(c.honorario) > 0 ? Number(c.honorario) : 0;
    const nomeGrupo = String(c.grupo_empresas || '').trim();
    if (nomeGrupo) {
      const k = nomeGrupo.toLowerCase();
      if (!porGrupo.has(k)) porGrupo.set(k, { nome: nomeGrupo, soma: 0, ids: new Set() });
      const g = porGrupo.get(k); g.soma += h; g.ids.add(c.id);
    }
    for (const t of tagsDoCnpj.get(soDigitos(c.cnpj)) || []) {
      if (t.tratamento !== 'grupo') continue;
      if (!porTag.has(t.id)) porTag.set(t.id, { nome: t.nome, soma: 0, ids: new Set() });
      const g = porTag.get(t.id); g.soma += h; g.ids.add(c.id);
    }
  }

  return clientes.map((c) => {
    const grupos = [];
    const nomeGrupo = String(c.grupo_empresas || '').trim();
    if (nomeGrupo) {
      const g = porGrupo.get(nomeGrupo.toLowerCase());
      grupos.push({ nome: g.nome, origem: 'grupo', soma: g.soma, qtd: g.ids.size });
    }
    const tags = tagsDoCnpj.get(soDigitos(c.cnpj)) || [];
    for (const t of tags) {
      if (t.tratamento !== 'grupo') continue;
      const g = porTag.get(t.id);
      grupos.push({ nome: g.nome, origem: 'tag', soma: g.soma, qtd: g.ids.size });
    }
    return {
      cliente_id: c.id,
      entrada: { honorario: c.honorario, grupos, tagsPiso: tags.filter((t) => t.tratamento === 'piso_ouro').map((t) => t.nome) },
    };
  });
}

// ── Banco ────────────────────────────────────────────────────────────────────
let _schemaPronto = null;
function garantirSchema() {
  if (!_schemaPronto) {
    _schemaPronto = (async () => {
      await pool.query(`CREATE TABLE IF NOT EXISTS acessorias_tags (
        id TEXT PRIMARY KEY, nome TEXT NOT NULL, status TEXT,
        tratamento TEXT NOT NULL DEFAULT 'ignorar', atualizado_em TIMESTAMPTZ DEFAULT NOW())`);
      await pool.query(`CREATE TABLE IF NOT EXISTS cliente_tags (
        cnpj TEXT NOT NULL, tag_id TEXT NOT NULL REFERENCES acessorias_tags(id) ON DELETE CASCADE,
        PRIMARY KEY (cnpj, tag_id))`);
    })().catch((e) => { _schemaPronto = null; throw e; });
  }
  return _schemaPronto;
}

async function lerCortes() {
  const { rows } = await pool.query(`SELECT valor FROM cs_config WHERE chave = $1`, [CHAVE_CORTES]);
  if (!rows.length) return { ...CORTES_PADRAO };
  try {
    const c = JSON.parse(rows[0].valor);
    if (c.prata > 0 && c.ouro > c.prata && c.diamante > c.ouro) return { prata: +c.prata, ouro: +c.ouro, diamante: +c.diamante };
  } catch (e) { /* cai no padrão */ }
  return { ...CORTES_PADRAO };
}

async function carregarClientesEVinculos() {
  await garantirSchema();
  const { rows: clientes } = await pool.query(
    `SELECT c.id, c.nome_empresa, c.cnpj, c.grupo_empresas,
            (SELECT valor FROM honorarios h WHERE h.cliente_id = c.id ORDER BY data_vigencia DESC LIMIT 1) AS honorario
       FROM clientes c WHERE c.status = 'ativo'`
  );
  const { rows: vinculos } = await pool.query(
    `SELECT ct.cnpj, ct.tag_id, t.nome AS tag_nome, t.tratamento
       FROM cliente_tags ct JOIN acessorias_tags t ON t.id = ct.tag_id
      WHERE t.tratamento IN ('piso_ouro', 'grupo')`
  );
  return { clientes, vinculos };
}

async function calcularCategorias() {
  const cortes = await lerCortes();
  const { clientes, vinculos } = await carregarClientesEVinculos();
  const resultado = {};
  const resumo = { Diamante: 0, Ouro: 0, Prata: 0, Bronze: 0, sem_categoria: 0 };
  for (const { cliente_id, entrada } of montarEntradas(clientes, vinculos)) {
    const r = categorizar(entrada, cortes);
    resultado[cliente_id] = r;
    if (r.categoria) resumo[r.categoria]++; else resumo.sem_categoria++;
  }
  return { cortes, data: resultado, resumo };
}

// ── Sincronização das TAGs do Acessórias ─────────────────────────────────────
let _sincronizando = false;
async function sincronizarTags() {
  const token = process.env.ACESSORIAS_API_TOKEN;
  if (!token) throw new Error('ACESSORIAS_API_TOKEN não configurado.');
  if (_sincronizando) throw new Error('Já existe uma sincronização de TAGs em andamento.');
  _sincronizando = true;
  try {
    await garantirSchema();
    const tags = await acessorias.listarTags({ token });
    const vinculos = [];
    for (const t of tags) {
      const cnpjs = await acessorias.listarEmpresasDaTag(t.id, { token });
      cnpjs.forEach((c) => { const d = soDigitos(c); if (d) vinculos.push([d, t.id]); });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const t of tags) {
        await client.query(
          `INSERT INTO acessorias_tags (id, nome, status, tratamento) VALUES ($1,$2,$3,$4)
           ON CONFLICT (id) DO UPDATE SET nome = EXCLUDED.nome, status = EXCLUDED.status, atualizado_em = NOW()`,
          [t.id, t.nome, t.status || null, REGEX_TAG_GRUPO_E.test(t.nome) ? 'piso_ouro' : 'ignorar']
        );
      }
      await client.query(`DELETE FROM cliente_tags`);
      for (const [cnpj, tagId] of vinculos) {
        await client.query(`INSERT INTO cliente_tags (cnpj, tag_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [cnpj, tagId]);
      }
      await client.query(
        `INSERT INTO cs_config (chave, valor, updated_at) VALUES ($1,$2,NOW())
         ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor, updated_at = NOW()`,
        [CHAVE_SYNC_TAGS, new Date().toISOString()]
      );
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    return { tags: tags.length, vinculos: vinculos.length };
  } finally { _sincronizando = false; }
}

// ── Rotas ────────────────────────────────────────────────────────────────────
const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
  try {
    res.json(await calcularCategorias());
  } catch (err) {
    console.error('[categorias] GET / falhou:', err);
    res.status(500).json({ error: 'Erro ao calcular categorias.' });
  }
});

router.get('/config', requireAdmin, async (req, res) => {
  try {
    const cortes = await lerCortes();
    const { clientes, vinculos } = await carregarClientesEVinculos();
    const { rows: tags } = await pool.query(`SELECT id, nome, status, tratamento FROM acessorias_tags ORDER BY nome`);
    const ativosPorCnpj = new Set(clientes.map((c) => soDigitos(c.cnpj)));
    const { rows: todosVinculos } = await pool.query(`SELECT cnpj, tag_id FROM cliente_tags`);
    const contagem = {};
    todosVinculos.forEach((v) => { if (ativosPorCnpj.has(v.cnpj)) contagem[v.tag_id] = (contagem[v.tag_id] || 0) + 1; });
    const gruposMap = new Map();
    clientes.forEach((c) => {
      const nome = String(c.grupo_empresas || '').trim(); if (!nome) return;
      const k = nome.toLowerCase();
      if (!gruposMap.has(k)) gruposMap.set(k, { nome, qtd: 0, soma: 0 });
      const g = gruposMap.get(k); g.qtd++; g.soma += Number(c.honorario) > 0 ? Number(c.honorario) : 0;
    });
    const { rows: sync } = await pool.query(`SELECT valor FROM cs_config WHERE chave = $1`, [CHAVE_SYNC_TAGS]);
    res.json({
      cortes,
      ultima_sincronizacao_tags: sync[0] ? sync[0].valor : null,
      sincronizando: _sincronizando,
      tags: tags.map((t) => ({ ...t, empresas_ativas: contagem[t.id] || 0 })),
      grupos: [...gruposMap.values()].sort((a, b) => b.qtd - a.qtd || a.nome.localeCompare(b.nome, 'pt-BR')),
      vinculos_total: vinculos.length,
    });
  } catch (err) {
    console.error('[categorias] GET /config falhou:', err);
    res.status(500).json({ error: 'Erro ao carregar a configuração de categorias.' });
  }
});

router.put('/config', requireAdmin, async (req, res) => {
  try {
    const { cortes, tags } = req.body || {};
    if (cortes) {
      const c = { prata: Number(cortes.prata), ouro: Number(cortes.ouro), diamante: Number(cortes.diamante) };
      if (!(c.prata > 0 && c.ouro > c.prata && c.diamante > c.ouro)) {
        return res.status(400).json({ error: 'As faixas precisam estar em ordem crescente: Prata < Ouro < Diamante.' });
      }
      await pool.query(
        `INSERT INTO cs_config (chave, valor, updated_at) VALUES ($1,$2,NOW())
         ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor, updated_at = NOW()`,
        [CHAVE_CORTES, JSON.stringify(c)]
      );
    }
    if (Array.isArray(tags)) {
      await garantirSchema();
      for (const t of tags) {
        if (!TRATAMENTOS.includes(t.tratamento)) return res.status(400).json({ error: 'Tratamento de TAG inválido.' });
        await pool.query(`UPDATE acessorias_tags SET tratamento = $1 WHERE id = $2`, [t.tratamento, String(t.id)]);
      }
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[categorias] PUT /config falhou:', err);
    res.status(500).json({ error: 'Erro ao salvar a configuração de categorias.' });
  }
});

router.post('/sincronizar-tags', requireAdmin, (req, res) => {
  if (_sincronizando) return res.status(409).json({ error: 'Já existe uma sincronização de TAGs em andamento.' });
  if (!process.env.ACESSORIAS_API_TOKEN) return res.status(400).json({ error: 'ACESSORIAS_API_TOKEN não configurado.' });
  sincronizarTags()
    .then((r) => console.log('[categorias] TAGs sincronizadas:', r))
    .catch((e) => console.error('[categorias] Falha ao sincronizar TAGs:', e.message));
  res.json({ ok: true, mensagem: 'Sincronização das TAGs iniciada em segundo plano. Reabra esta tela em alguns minutos.' });
});

module.exports = {
  router, categorizar, categoriaPorValor, montarEntradas, calcularCategorias, sincronizarTags,
  CORTES_PADRAO,
};
