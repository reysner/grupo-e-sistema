'use strict';
/**
 * Qualidade (Sucesso do Cliente / Time Operacional): considerações registradas na ficha do cliente (multa, erro, reclamação, atraso,
 * falha de atendimento ou técnica) com analista responsável e prazo. Alimenta o módulo Qualidade do painel /cs, a página "Minhas
 * tratativas" do analista e o termômetro de Atendimento do risco de churn.
 *
 *   /api/cs/painel/qualidade  (equipe do painel; administrador, usuário ou acesso_cs)
 *     GET  /opcoes                -> tipos, departamentos e status válidos
 *     GET  /analistas             -> analistas ativos (lista canônica do módulo Atendimento)
 *     GET  /cliente/:clienteId    -> registros de um cliente
 *     POST /                      -> cria um registro
 *     GET  /resumo                -> uma linha por analista (abertos, vencidos...)
 *     GET  /analista/:id          -> registros de um analista (com o nome da empresa)
 *     PATCH /:id                  -> status, prazo e tratativa
 *     PUT  /vinculo/:analistaId   -> (administrador) liga o analista a um login para a página "Minhas tratativas"
 *   /api/qualidade  (analista logado, com acesso_minha_nota)
 *     GET   /minhas               -> os registros do próprio analista
 *     PATCH /:id/tratar           -> inicia ou conclui a tratativa de um registro dele
 *
 * O nome do analista nunca é copiado para o registro: vem sempre da lista de analistas (renomear lá renomeia aqui).
 */
const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../auth');

const TIPOS = ['Multa', 'Erro', 'Reclamação', 'Atraso', 'Falha de atendimento', 'Falha técnica', 'Outros'];
const DEPARTAMENTOS = ['Comercial', 'Contábil', 'Financeiro', 'Fiscal', 'Legalização', 'Pessoal', 'Sucesso'];
const STATUS = ['aberto', 'em_tratamento', 'resolvido', 'cancelado'];
const ROTULO_STATUS = { aberto: 'Aberto', em_tratamento: 'Em tratamento', resolvido: 'Resolvido', cancelado: 'Cancelado' };
const MAX_DETALHE = 600;
const MAX_TRATATIVA = 600;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const PAPEIS = ['administrador', 'usuario'];

const texto = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const soDigitos = (s) => String(s || '').replace(/\D/g, '');
const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
function hojeBrasilia() {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  return p;   // AAAA-MM-DD
}
function somarDias(iso, n) { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

/** Valida o corpo de um novo registro. Devolve { ok, valores } ou { ok:false, erro }. */
function validarRegistro(corpo, hoje, tiposPermitidos) {
  const b = corpo || {};
  const h = hoje || hojeBrasilia();
  const cliente_id = texto(b.cliente_id, 80);
  if (!cliente_id) return { ok: false, erro: 'Escolha o cliente.' };
  const tipo = (tiposPermitidos || TIPOS).find((t) => t === b.tipo);
  if (!tipo) return { ok: false, erro: 'Escolha o tipo de registro.' };
  let deps = Array.isArray(b.departamentos) ? b.departamentos.map((d) => String(d)) : [];
  if (deps.includes('Todos')) deps = DEPARTAMENTOS.slice();
  deps = DEPARTAMENTOS.filter((d) => deps.includes(d));
  if (!deps.length) return { ok: false, erro: 'Escolha ao menos um departamento envolvido.' };
  const detalhe = texto(b.detalhe, MAX_DETALHE + 1);
  if (detalhe.length < 5) return { ok: false, erro: 'Descreva a ocorrência (mínimo de 5 caracteres).' };
  if (detalhe.length > MAX_DETALHE) return { ok: false, erro: 'A descrição passa de ' + MAX_DETALHE + ' caracteres.' };
  const analista_id = texto(b.analista_id, 80);
  if (!analista_id) return { ok: false, erro: 'Escolha o analista responsável.' };
  const prazo = texto(b.prazo, 10);
  if (!ISO.test(prazo) || isNaN(Date.parse(prazo + 'T12:00:00Z'))) return { ok: false, erro: 'Informe o prazo para execução.' };
  if (prazo < h) return { ok: false, erro: 'O prazo não pode ser uma data que já passou.' };
  if (prazo > somarDias(h, 365)) return { ok: false, erro: 'O prazo passa de um ano: escolha uma data mais próxima.' };
  return { ok: true, valores: { cliente_id, tipo, departamentos: deps, detalhe, analista_id, prazo } };
}

/** Valida a mudança de um registro: status, prazo e/ou tratativa. */
function validarMudanca(corpo, hoje) {
  const b = corpo || {};
  const v = {};
  if (b.status !== undefined) {
    if (!STATUS.includes(b.status)) return { ok: false, erro: 'Status inválido.' };
    v.status = b.status;
  }
  if (b.prazo !== undefined) {
    const p = texto(b.prazo, 10);
    if (!ISO.test(p) || isNaN(Date.parse(p + 'T12:00:00Z'))) return { ok: false, erro: 'Prazo inválido.' };
    if (p < (hoje || hojeBrasilia())) return { ok: false, erro: 'O prazo não pode ser uma data que já passou.' };
    v.prazo = p;
  }
  if (b.tratativa !== undefined) {
    const t = texto(b.tratativa, MAX_TRATATIVA + 1);
    if (t.length > MAX_TRATATIVA) return { ok: false, erro: 'A tratativa passa de ' + MAX_TRATATIVA + ' caracteres.' };
    v.tratativa = t;
  }
  if (!Object.keys(v).length) return { ok: false, erro: 'Nada para alterar.' };
  if (v.status === 'resolvido' && (v.tratativa || '').length < 5) return { ok: false, erro: 'Para resolver, descreva o que foi feito (mínimo de 5 caracteres).' };
  return { ok: true, valores: v };
}

/** Situação para a tela: aberto/em tratamento com prazo vencido vira "vencido". */
function situacao(status, prazoIso, hoje) {
  if ((status === 'aberto' || status === 'em_tratamento') && prazoIso && prazoIso < (hoje || hojeBrasilia())) return 'vencido';
  return status;
}

/** Dois nomes de pessoa são "o mesmo" quando iguais sem acento e caixa, ou um contém o outro (ex.: "Guilherme" e "Guilherme de Barros Amaro"). */
function mesmoNome(a, b) {
  const x = semAcento(a), y = semAcento(b);
  if (!x || !y) return false;
  return x === y || (x.length >= 4 && y.startsWith(x + ' ')) || (y.length >= 4 && x.startsWith(y + ' '));
}

/**
 * Prioridades do analista (o que pede ação hoje), da mais urgente para a menos:
 *  - tratativa vencida (alta) ou com prazo em até 3 dias (média);
 *  - cliente com e-mail sem resposta (alta a partir de 3 e-mails, média abaixo);
 *  - atendimento com SLA vermelho nos últimos 30 dias (média).
 */
function montarPrioridades(ent, hoje) {
  const h = hoje || hojeBrasilia(), lim = somarDias(h, 3);
  const out = [];
  (ent.registros || []).forEach((r) => {
    if (r.status !== 'aberto' && r.status !== 'em_tratamento') return;
    if (r.prazo < h) out.push({ tipo: 'tratativa', nivel: 'alta', titulo: 'Tratativa vencida: ' + r.tipo, detalhe: (r.cliente_nome || 'Cliente') + ' · prazo ' + r.prazo, ref: r.id, ordem: 0 });
    else if (r.prazo <= lim) out.push({ tipo: 'tratativa', nivel: 'media', titulo: 'Tratativa perto do prazo: ' + r.tipo, detalhe: (r.cliente_nome || 'Cliente') + ' · prazo ' + r.prazo, ref: r.id, ordem: 1 });
  });
  (ent.emails || []).forEach((c) => {
    if (!(c.sem > 0)) return;
    out.push({ tipo: 'email', nivel: c.sem >= 3 ? 'alta' : 'media', titulo: c.sem + ' e-mail(s) sem resposta', detalhe: c.nome || c.cnpj, ref: c.cnpj, ordem: c.sem >= 3 ? 0.5 : 2 });
  });
  (ent.slaVermelho || []).forEach((t) => {
    out.push({ tipo: 'sla', nivel: 'media', titulo: 'SLA vermelho no atendimento', detalhe: (t.cliente_nome || t.empresa_texto || 'Cliente') + ' · ' + String(t.abertura || '').slice(0, 10), ref: t.id, ordem: 3 });
  });
  return out.sort((a, b) => a.ordem - b.ordem || String(a.detalhe).localeCompare(String(b.detalhe)));
}

/** Semana (segunda-feira, AAAA-MM-DD) de uma data ISO. */
function segundaDe(iso) {
  const d = new Date(iso + 'T12:00:00Z'); const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow); return d.toISOString().slice(0, 10);
}

let _schema = null;
function garantirSchema() {
  if (!_schema) {
    // RLS ligado e sem policy: só o servidor lê (regra do projeto para tabela nova).
    _schema = pool.query(`CREATE TABLE IF NOT EXISTS cs_qualidade_registros (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        cliente_id TEXT NOT NULL, cnpj TEXT, cliente_nome TEXT,
        tipo TEXT NOT NULL, departamentos TEXT[] NOT NULL DEFAULT '{}', detalhe TEXT NOT NULL,
        analista_id TEXT NOT NULL, prazo DATE NOT NULL, status TEXT NOT NULL DEFAULT 'aberto',
        criado_por TEXT, criado_por_id TEXT, criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(), resolvido_em TIMESTAMPTZ, resolvido_por TEXT, tratativa TEXT)`)
      .then(() => pool.query('ALTER TABLE cs_qualidade_registros ENABLE ROW LEVEL SECURITY'))
      .then(() => pool.query('CREATE INDEX IF NOT EXISTS cs_qualidade_cliente_idx ON cs_qualidade_registros (cliente_id)'))
      .then(() => pool.query('CREATE INDEX IF NOT EXISTS cs_qualidade_analista_idx ON cs_qualidade_registros (analista_id)'))
      .then(() => pool.query(`CREATE TABLE IF NOT EXISTS cs_qualidade_historico (
        id BIGSERIAL PRIMARY KEY, registro_id UUID NOT NULL REFERENCES cs_qualidade_registros(id) ON DELETE CASCADE,
        em TIMESTAMPTZ NOT NULL DEFAULT NOW(), por TEXT, acao TEXT NOT NULL, texto TEXT)`))
      .then(() => pool.query('ALTER TABLE cs_qualidade_historico ENABLE ROW LEVEL SECURITY'))
      .then(() => pool.query(`CREATE TABLE IF NOT EXISTS cs_qualidade_tipos (
        id SERIAL PRIMARY KEY, nome TEXT NOT NULL, peso INT NOT NULL DEFAULT 10, ativo BOOLEAN NOT NULL DEFAULT TRUE, ordem INT NOT NULL DEFAULT 0)`))
      .then(() => pool.query('CREATE UNIQUE INDEX IF NOT EXISTS cs_qualidade_tipos_nome_idx ON cs_qualidade_tipos (lower(nome))'))
      .then(() => pool.query('ALTER TABLE cs_qualidade_tipos ENABLE ROW LEVEL SECURITY'))
      .then(async () => {
        // sementes: os sete tipos combinados, com o peso que entra no termômetro de Atendimento do risco
        const iniciais = [['Multa', 25], ['Erro', 15], ['Reclamação', 20], ['Atraso', 10], ['Falha de atendimento', 20], ['Falha técnica', 10], ['Outros', 5]];
        const n = (await pool.query('SELECT COUNT(*)::int AS n FROM cs_qualidade_tipos')).rows[0].n;
        if (!n) for (let i = 0; i < iniciais.length; i++) await pool.query('INSERT INTO cs_qualidade_tipos (nome, peso, ordem) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [iniciais[i][0], iniciais[i][1], i + 1]);
      })
      .then(() => pool.query('ALTER TABLE analistas ADD COLUMN IF NOT EXISTS user_id TEXT'))
      .then(() => require('./analistasNomes').aplicar(pool))   // ajuste único dos nomes completos (planilha de 15/10/2026)
      .catch((e) => { _schema = null; throw e; });
  }
  return _schema;
}

const podeEquipe = (u) => !!u && (PAPEIS.includes(u.role) || !!u.acessoCs);
function soEquipe(req, res, next) {
  if (!podeEquipe(req.user)) return res.status(403).json({ error: 'Acesso restrito à equipe do Sucesso do Cliente.' });
  next();
}

const COLUNAS = `r.id, r.cliente_id, r.cnpj, r.cliente_nome, r.tipo, r.departamentos, r.detalhe, r.analista_id, a.nome AS analista_nome,
       to_char(r.prazo, 'YYYY-MM-DD') AS prazo, r.status, r.criado_por, r.criado_em, r.resolvido_em, r.resolvido_por, r.tratativa`;
const DE = `FROM cs_qualidade_registros r LEFT JOIN analistas a ON a.id::text = r.analista_id`;
const comSituacao = (rows) => rows.map((r) => ({ ...r, situacao: situacao(r.status, r.prazo), status_rotulo: ROTULO_STATUS[r.status] }));

async function registrar(registroId, por, acao, txt) {
  await pool.query('INSERT INTO cs_qualidade_historico (registro_id, por, acao, texto) VALUES ($1, $2, $3, $4)', [registroId, por || null, acao, txt || null]);
}

// ── Equipe do painel ─────────────────────────────────────────────────────────────
const router = express.Router();
router.use(requireAuth, soEquipe);

/** Tipos de registro ativos, na ordem de exibição. */
async function tiposAtivos() {
  await garantirSchema();
  return (await pool.query('SELECT id, nome, peso, ativo, ordem FROM cs_qualidade_tipos WHERE ativo ORDER BY ordem, nome')).rows;
}
/** Valida nome e peso de um tipo. */
function validarTipo(b) {
  const o = {};
  if (b.nome !== undefined) {
    const nome = texto(b.nome, 41);
    if (nome.length < 2) return { ok: false, erro: 'O nome do tipo precisa de ao menos 2 caracteres.' };
    if (nome.length > 40) return { ok: false, erro: 'O nome do tipo passa de 40 caracteres.' };
    o.nome = nome;
  }
  if (b.peso !== undefined) {
    const p = Math.round(Number(String(b.peso).replace(',', '.')));
    if (!Number.isFinite(p) || p < 0 || p > 50) return { ok: false, erro: 'O peso no risco vai de 0 a 50 pontos.' };
    o.peso = p;
  }
  if (b.ativo !== undefined) o.ativo = !!b.ativo;
  return { ok: true, valores: o };
}
const soAdmin = (req, res, next) => {
  if (!req.user || req.user.role !== 'administrador') return res.status(403).json({ error: 'Só o administrador gerencia os tipos de registro.' });
  next();
};

router.get('/opcoes', async (req, res) => {
  try {
    const tipos = await tiposAtivos();
    res.json({ tipos: tipos.map((t) => t.nome), departamentos: DEPARTAMENTOS, status: STATUS, max_detalhe: MAX_DETALHE, max_tratativa: MAX_TRATATIVA });
  } catch (e) { console.error('[qualidade] GET /opcoes falhou:', e); res.status(500).json({ error: 'Erro ao ler as opções.' }); }
});

router.get('/tipos', soAdmin, async (req, res) => {
  try {
    await garantirSchema();
    const { rows } = await pool.query(`SELECT t.id, t.nome, t.peso, t.ativo, t.ordem, (SELECT COUNT(*)::int FROM cs_qualidade_registros r WHERE r.tipo = t.nome) AS usos FROM cs_qualidade_tipos t ORDER BY t.ordem, t.nome`);
    res.json({ tipos: rows });
  } catch (e) { console.error('[qualidade] GET /tipos falhou:', e); res.status(500).json({ error: 'Erro ao ler os tipos.' }); }
});

router.post('/tipos', soAdmin, async (req, res) => {
  const v = validarTipo({ nome: req.body && req.body.nome, peso: req.body && req.body.peso !== undefined ? req.body.peso : 10 });
  if (!v.ok) return res.status(400).json({ error: v.erro });
  try {
    await garantirSchema();
    const ordem = (await pool.query('SELECT COALESCE(MAX(ordem), 0) + 1 AS o FROM cs_qualidade_tipos')).rows[0].o;
    const { rows } = await pool.query('INSERT INTO cs_qualidade_tipos (nome, peso, ordem) VALUES ($1, $2, $3) RETURNING id, nome, peso, ativo, ordem', [v.valores.nome, v.valores.peso, ordem]);
    res.status(201).json({ tipo: rows[0] });
  } catch (e) {
    if (e && e.code === '23505') return res.status(409).json({ error: 'Já existe um tipo com esse nome.' });
    console.error('[qualidade] POST /tipos falhou:', e); res.status(500).json({ error: 'Erro ao criar o tipo.' });
  }
});

router.patch('/tipos/:id', soAdmin, async (req, res) => {
  const v = validarTipo(req.body || {});
  if (!v.ok) return res.status(400).json({ error: v.erro });
  if (!Object.keys(v.valores).length) return res.status(400).json({ error: 'Nada para alterar.' });
  const client = await pool.connect();
  try {
    await garantirSchema();
    await client.query('BEGIN');
    const atual = (await client.query('SELECT id, nome FROM cs_qualidade_tipos WHERE id = $1 FOR UPDATE', [parseInt(req.params.id, 10) || 0])).rows[0];
    if (!atual) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Tipo não encontrado.' }); }
    const sets = [], vals = [];
    Object.keys(v.valores).forEach((k) => { vals.push(v.valores[k]); sets.push(k + ' = $' + vals.length); });
    vals.push(atual.id);
    await client.query('UPDATE cs_qualidade_tipos SET ' + sets.join(', ') + ' WHERE id = $' + vals.length, vals);
    // renomear leva junto os registros que já usam o nome antigo
    if (v.valores.nome && v.valores.nome !== atual.nome) await client.query('UPDATE cs_qualidade_registros SET tipo = $1 WHERE tipo = $2', [v.valores.nome, atual.nome]);
    await client.query('COMMIT');
    const { rows } = await pool.query('SELECT id, nome, peso, ativo, ordem FROM cs_qualidade_tipos WHERE id = $1', [atual.id]);
    res.json({ tipo: rows[0] });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (e && e.code === '23505') return res.status(409).json({ error: 'Já existe um tipo com esse nome.' });
    console.error('[qualidade] PATCH /tipos falhou:', e); res.status(500).json({ error: 'Erro ao atualizar o tipo.' });
  } finally { client.release(); }
});

router.delete('/tipos/:id', soAdmin, async (req, res) => {
  try {
    await garantirSchema();
    const t = (await pool.query('SELECT id, nome FROM cs_qualidade_tipos WHERE id = $1', [parseInt(req.params.id, 10) || 0])).rows[0];
    if (!t) return res.status(404).json({ error: 'Tipo não encontrado.' });
    const usos = (await pool.query('SELECT COUNT(*)::int AS n FROM cs_qualidade_registros WHERE tipo = $1', [t.nome])).rows[0].n;
    if (usos > 0) return res.status(409).json({ error: 'Esse tipo tem ' + usos + ' registro(s). Desative-o em vez de excluir, para não perder o histórico.' });
    await pool.query('DELETE FROM cs_qualidade_tipos WHERE id = $1', [t.id]);
    res.json({ ok: true });
  } catch (e) { console.error('[qualidade] DELETE /tipos falhou:', e); res.status(500).json({ error: 'Erro ao excluir o tipo.' }); }
});

router.get('/analistas', async (req, res) => {
  try {
    await garantirSchema();
    const { rows } = await pool.query('SELECT id, nome, ativo, user_id FROM analistas ORDER BY nome');
    const so = req.query.ativo === 'true';
    res.json({ analistas: rows.filter((a) => !so || a.ativo) });
  } catch (e) { console.error('[qualidade] GET /analistas falhou:', e); res.status(500).json({ error: 'Erro ao ler os analistas.' }); }
});

router.get('/cliente/:clienteId', async (req, res) => {
  try {
    await garantirSchema();
    const { rows } = await pool.query(`SELECT ${COLUNAS} ${DE} WHERE r.cliente_id = $1 ORDER BY r.criado_em DESC LIMIT 100`, [String(req.params.clienteId)]);
    res.json({ registros: comSituacao(rows) });
  } catch (e) { console.error('[qualidade] GET /cliente falhou:', e); res.status(500).json({ error: 'Erro ao ler os registros do cliente.' }); }
});

router.post('/', async (req, res) => {
  try {
    const tipos = (await tiposAtivos()).map((t) => t.nome);
    const v = validarRegistro(req.body, undefined, tipos);
    if (!v.ok) return res.status(400).json({ error: v.erro });
    const cli = await pool.query(`SELECT id::text AS id, nome_empresa, regexp_replace(cnpj, '\\D', '', 'g') AS cnpj FROM clientes WHERE id::text = $1`, [v.valores.cliente_id]);
    if (!cli.rows.length) return res.status(404).json({ error: 'Cliente não encontrado.' });
    const an = await pool.query('SELECT id, nome, ativo FROM analistas WHERE id::text = $1', [v.valores.analista_id]);
    if (!an.rows.length) return res.status(404).json({ error: 'Analista não encontrado.' });
    if (!an.rows[0].ativo) return res.status(400).json({ error: 'Esse analista está desativado na lista.' });
    const c = cli.rows[0], x = v.valores;
    const ins = await pool.query(
      `INSERT INTO cs_qualidade_registros (cliente_id, cnpj, cliente_nome, tipo, departamentos, detalhe, analista_id, prazo, criado_por, criado_por_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [c.id, soDigitos(c.cnpj), c.nome_empresa, x.tipo, x.departamentos, x.detalhe, x.analista_id, x.prazo, req.user.name || null, req.user.id || null]);
    await registrar(ins.rows[0].id, req.user.name, 'criado', x.tipo + ' · prazo ' + x.prazo);
    const { rows } = await pool.query(`SELECT ${COLUNAS} ${DE} WHERE r.id = $1`, [ins.rows[0].id]);
    res.status(201).json({ registro: comSituacao(rows)[0] });
  } catch (e) { console.error('[qualidade] POST falhou:', e); res.status(500).json({ error: 'Erro ao salvar o registro.' }); }
});

router.get('/resumo', async (req, res) => {
  try {
    await garantirSchema();
    const hoje = hojeBrasilia();
    const { rows } = await pool.query(
      `SELECT a.id, a.nome, a.ativo, a.user_id,
              COUNT(r.id) FILTER (WHERE r.status = 'aberto')::int AS abertos,
              COUNT(r.id) FILTER (WHERE r.status = 'em_tratamento')::int AS em_tratamento,
              COUNT(r.id) FILTER (WHERE r.status IN ('aberto', 'em_tratamento') AND r.prazo < $1::date)::int AS vencidos,
              COUNT(r.id) FILTER (WHERE r.status = 'resolvido')::int AS resolvidos,
              COUNT(r.id) FILTER (WHERE r.status <> 'cancelado')::int AS total,
              to_char(MAX(r.criado_em) AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS ultimo_lancamento,
              to_char(MIN(r.prazo) FILTER (WHERE r.status IN ('aberto', 'em_tratamento')), 'YYYY-MM-DD') AS proximo_prazo
         FROM analistas a LEFT JOIN cs_qualidade_registros r ON r.analista_id = a.id::text
        GROUP BY a.id, a.nome, a.ativo, a.user_id ORDER BY a.nome`, [hoje]);
    const orfaos = await pool.query(`SELECT COUNT(*)::int AS n FROM cs_qualidade_registros r WHERE NOT EXISTS (SELECT 1 FROM analistas a WHERE a.id::text = r.analista_id)`);
    res.json({ hoje, analistas: rows, sem_analista: orfaos.rows[0].n });
  } catch (e) { console.error('[qualidade] GET /resumo falhou:', e); res.status(500).json({ error: 'Erro ao montar o módulo Qualidade.' }); }
});

router.get('/analista/:id', async (req, res) => {
  try {
    await garantirSchema();
    const a = await pool.query('SELECT id, nome, ativo, user_id FROM analistas WHERE id::text = $1', [String(req.params.id)]);
    if (!a.rows.length) return res.status(404).json({ error: 'Analista não encontrado.' });
    const { rows } = await pool.query(`SELECT ${COLUNAS} ${DE} WHERE r.analista_id = $1 ORDER BY r.criado_em DESC LIMIT 300`, [String(req.params.id)]);
    res.json({ analista: a.rows[0], registros: comSituacao(rows) });
  } catch (e) { console.error('[qualidade] GET /analista falhou:', e); res.status(500).json({ error: 'Erro ao ler os registros do analista.' }); }
});

router.patch('/:id', async (req, res) => {
  const v = validarMudanca(req.body);
  if (!v.ok) return res.status(400).json({ error: v.erro });
  try {
    await garantirSchema();
    const x = v.valores, sets = [], vals = [];
    const add = (col, val) => { vals.push(val); sets.push(col + ' = $' + vals.length); };
    if (x.status) { add('status', x.status); if (x.status === 'resolvido') { add('resolvido_em', new Date()); add('resolvido_por', req.user.name || null); } }
    if (x.prazo) add('prazo', x.prazo);
    if (x.tratativa !== undefined) add('tratativa', x.tratativa);
    sets.push('atualizado_em = NOW()');
    vals.push(String(req.params.id));
    const up = await pool.query(`UPDATE cs_qualidade_registros SET ${sets.join(', ')} WHERE id::text = $${vals.length} RETURNING id`, vals);
    if (!up.rows.length) return res.status(404).json({ error: 'Registro não encontrado.' });
    await registrar(up.rows[0].id, req.user.name, x.status ? 'status:' + x.status : (x.prazo ? 'prazo' : 'tratativa'), x.tratativa || x.prazo || null);
    const { rows } = await pool.query(`SELECT ${COLUNAS} ${DE} WHERE r.id = $1`, [up.rows[0].id]);
    res.json({ registro: comSituacao(rows)[0] });
  } catch (e) { console.error('[qualidade] PATCH falhou:', e); res.status(500).json({ error: 'Erro ao atualizar o registro.' }); }
});

router.put('/vinculo/:analistaId', async (req, res) => {
  if (!req.user || req.user.role !== 'administrador') return res.status(403).json({ error: 'Só o administrador liga o analista a um login.' });
  try {
    await garantirSchema();
    const userId = req.body && req.body.user_id ? String(req.body.user_id) : null;
    const up = await pool.query('UPDATE analistas SET user_id = $1 WHERE id::text = $2 RETURNING id, nome, user_id', [userId, String(req.params.analistaId)]);
    if (!up.rows.length) return res.status(404).json({ error: 'Analista não encontrado.' });
    res.json({ analista: up.rows[0] });
  } catch (e) { console.error('[qualidade] PUT /vinculo falhou:', e); res.status(500).json({ error: 'Erro ao ligar o analista ao login.' }); }
});

// ── Analista logado ("Minhas tratativas") ────────────────────────────────────────
const routerAnalista = express.Router();
routerAnalista.use(requireAuth);

/** Quem é o analista deste login: pelo vínculo explícito (analistas.user_id) ou, na falta dele, pelo mesmo nome (sem acento e caixa). */
async function analistaDoLogin(user) {
  const porId = await pool.query('SELECT id, nome, ativo FROM analistas WHERE user_id = $1 ORDER BY ativo DESC LIMIT 1', [String(user.id)]);
  if (porId.rows.length) return porId.rows[0];
  const todos = await pool.query('SELECT id, nome, ativo FROM analistas WHERE user_id IS NULL');
  const alvo = semAcento(user.name);
  return todos.rows.find((a) => semAcento(a.nome) === alvo) || null;
}

/** Quem é o analista (lista de Qualidade) e o colaborador da Gamificação (Zappy) deste login; administrador ou usuário podem pedir outro analista. */
async function identidade(user, analistaId) {
  let analista = null;
  if (analistaId && PAPEIS.includes(user.role)) {
    const a = await pool.query('SELECT id, nome, ativo, user_id FROM analistas WHERE id::text = $1', [String(analistaId)]);
    analista = a.rows[0] || null;
  } else analista = await analistaDoLogin(user);
  let colab = null;
  const donoLogin = analista && !(analistaId && PAPEIS.includes(user.role)) ? user.id : (analista && analista.user_id) || null;
  try {
    if (donoLogin) colab = ((await pool.query('SELECT nome, zappy_user_id FROM gam_colaboradores WHERE user_id = $1', [String(donoLogin)])).rows[0]) || null;
    if (!colab && analista) {
      const todos = (await pool.query('SELECT nome, zappy_user_id FROM gam_colaboradores')).rows;
      colab = todos.find((c) => mesmoNome(c.nome, analista.nome)) || null;
    }
  } catch (e) { colab = null; }
  return { analista, colab };
}

routerAnalista.get('/painel', async (req, res) => {
  try {
    await garantirSchema();
    const hoje = hojeBrasilia();
    const { analista, colab } = await identidade(req.user, req.query.analista);
    if (!analista) return res.json({ analista: null, aviso: 'Seu login ainda não está ligado a um analista da lista. Peça à liderança para ligar (Qualidade > seu nome > Login).' });

    const regs = (await pool.query(`SELECT ${COLUNAS} ${DE} WHERE r.analista_id = $1 AND r.status <> 'cancelado' ORDER BY r.prazo ASC LIMIT 300`, [String(analista.id)])).rows;
    const registros = comSituacao(regs);

    // Atendimentos do Zappy (180 dias) do analista, pelo usuário do Zappy ligado na Gamificação
    let atend = { vinculado: !!(colab && colab.zappy_user_id), colaborador: colab ? colab.nome : null, janela_dias: 180, lista: [], semanas: [], total: 0, sla_vermelho: 0, notas_baixas: 0, media_nota: null };
    let slaVermelho30 = [];
    if (colab && colab.zappy_user_id) {
      try {
        const t = (await pool.query(
          `SELECT t.id, t.abertura, t.departamento, t.nota_avaliacao, t.pior_status, t.empresa_texto, c.nome_empresa AS cliente_nome
             FROM cs_tickets t
             LEFT JOIN cs_vinculos v ON v.id = t.vinculo_id AND v.tipo = 'cliente'
             LEFT JOIN clientes c ON c.id::text = v.cliente_id
            WHERE t.analista_id = $1 AND t.abertura >= NOW() - INTERVAL '180 days'
            ORDER BY t.abertura DESC LIMIT 600`, [String(colab.zappy_user_id)])).rows;
        const notas = t.filter((x) => x.nota_avaliacao != null).map((x) => Number(x.nota_avaliacao));
        const por = {};
        t.forEach((x) => { const s = segundaDe(new Date(x.abertura).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })); por[s] = (por[s] || 0) + 1; });
        const semanas = []; const ini = segundaDe(hoje);
        for (let i = 11; i >= 0; i--) { const s = somarDias(ini, -7 * i); semanas.push({ semana: s, n: por[s] || 0 }); }
        atend = Object.assign(atend, {
          lista: t.slice(0, 300), semanas, total: t.length,
          sla_vermelho: t.filter((x) => x.pior_status === 'vermelho').length, notas_baixas: t.filter((x) => x.nota_avaliacao != null && x.nota_avaliacao <= 2).length,
          media_nota: notas.length ? Math.round(notas.reduce((s, n) => s + n, 0) / notas.length * 100) / 100 : null,
        });
        const corte = new Date(Date.now() - 30 * 86400000);
        slaVermelho30 = t.filter((x) => x.pior_status === 'vermelho' && new Date(x.abertura) >= corte);
      } catch (e) { console.warn('[qualidade] painel: atendimentos indisponíveis:', e.message); }
    }

    // E-mails: o analista aparece como destinatário (nome do diretório do Google) nas contagens por cliente
    let emails = { lido_em: null, janela_dias: null, recebidos: 0, sem_resposta: 0, clientes: [] };
    try {
      const l = (await pool.query('SELECT lido_em, janela_dias FROM cs_email_atendimento_leitura WHERE id = 1')).rows[0];
      const rows = (await pool.query('SELECT a.cnpj, a.destinatarios, c.nome_empresa AS nome FROM cs_email_atendimento a LEFT JOIN clientes c ON regexp_replace(c.cnpj, \'\\D\', \'\', \'g\') = a.cnpj AND c.status = \'ativo\'')).rows;
      const meus = [];
      rows.forEach((r) => {
        (r.destinatarios || []).forEach((d) => {
          if (!d.grupo && mesmoNome(d.nome, analista.nome)) meus.push({ cnpj: r.cnpj, nome: r.nome, recebidos: d.recebidos, sem: d.sem });
        });
      });
      meus.sort((a, b) => b.sem - a.sem || b.recebidos - a.recebidos);
      emails = { lido_em: l ? l.lido_em : null, janela_dias: l ? l.janela_dias : null, recebidos: meus.reduce((s, c) => s + c.recebidos, 0), sem_resposta: meus.reduce((s, c) => s + c.sem, 0), clientes: meus.slice(0, 150) };
    } catch (e) { console.warn('[qualidade] painel: e-mails indisponíveis:', e.message); }

    // Evolução semanal das tratativas (lançadas e resolvidas nas últimas 12 semanas)
    const ini = segundaDe(hoje); const evol = [];
    const lancadas = {}, resolvidas = {};
    registros.forEach((r) => {
      const c = segundaDe(String(r.criado_em instanceof Date ? r.criado_em.toISOString() : r.criado_em).slice(0, 10)); lancadas[c] = (lancadas[c] || 0) + 1;
      if (r.resolvido_em) { const s = segundaDe(String(r.resolvido_em instanceof Date ? r.resolvido_em.toISOString() : r.resolvido_em).slice(0, 10)); resolvidas[s] = (resolvidas[s] || 0) + 1; }
    });
    for (let i = 11; i >= 0; i--) { const s = somarDias(ini, -7 * i); evol.push({ semana: s, lancadas: lancadas[s] || 0, resolvidas: resolvidas[s] || 0, atendimentos: (atend.semanas.find((x) => x.semana === s) || {}).n || 0 }); }

    const prioridades = montarPrioridades({ registros, emails: emails.clientes, slaVermelho: slaVermelho30 }, hoje);
    res.json({ hoje, analista: { id: analista.id, nome: analista.nome }, registros, atendimentos: atend, emails, evolucao: evol, prioridades });
  } catch (e) { console.error('[qualidade] GET /painel falhou:', e); res.status(500).json({ error: 'Erro ao montar o seu painel.' }); }
});

routerAnalista.get('/minhas', async (req, res) => {
  try {
    await garantirSchema();
    let analista = null;
    const verTodos = PAPEIS.includes(req.user.role);
    if (req.query.analista && verTodos) {
      const a = await pool.query('SELECT id, nome, ativo FROM analistas WHERE id::text = $1', [String(req.query.analista)]);
      analista = a.rows[0] || null;
    } else analista = await analistaDoLogin(req.user);
    if (!analista) return res.json({ analista: null, registros: [], aviso: 'Seu login ainda não está ligado a um analista da lista. Peça à liderança para ligar (Qualidade > seu nome > Login).' });
    const { rows } = await pool.query(`SELECT ${COLUNAS} ${DE} WHERE r.analista_id = $1 AND r.status <> 'cancelado' ORDER BY (r.status IN ('resolvido')) ASC, r.prazo ASC LIMIT 300`, [String(analista.id)]);
    res.json({ analista, registros: comSituacao(rows) });
  } catch (e) { console.error('[qualidade] GET /minhas falhou:', e); res.status(500).json({ error: 'Erro ao carregar suas tratativas.' }); }
});

routerAnalista.patch('/:id/tratar', async (req, res) => {
  const b = req.body || {};
  if (!['em_tratamento', 'resolvido'].includes(b.status)) return res.status(400).json({ error: 'Escolha iniciar a tratativa ou resolver.' });
  const v = validarMudanca({ status: b.status, tratativa: b.tratativa });
  if (!v.ok) return res.status(400).json({ error: v.erro });
  try {
    await garantirSchema();
    const analista = await analistaDoLogin(req.user);
    if (!analista) return res.status(403).json({ error: 'Seu login não está ligado a um analista.' });
    const r = await pool.query('SELECT id, analista_id, status FROM cs_qualidade_registros WHERE id::text = $1', [String(req.params.id)]);
    if (!r.rows.length) return res.status(404).json({ error: 'Registro não encontrado.' });
    if (String(r.rows[0].analista_id) !== String(analista.id)) return res.status(403).json({ error: 'Esse registro é de outro analista.' });
    if (['resolvido', 'cancelado'].includes(r.rows[0].status)) return res.status(409).json({ error: 'Esse registro já foi encerrado.' });
    const x = v.valores, sets = ['status = $1', 'atualizado_em = NOW()'], vals = [x.status];
    if (x.tratativa !== undefined) { vals.push(x.tratativa); sets.push('tratativa = $' + vals.length); }
    if (x.status === 'resolvido') { vals.push(req.user.name || analista.nome); sets.push('resolvido_em = NOW()', 'resolvido_por = $' + vals.length); }
    vals.push(r.rows[0].id);
    await pool.query(`UPDATE cs_qualidade_registros SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    await registrar(r.rows[0].id, req.user.name || analista.nome, 'status:' + x.status, x.tratativa || null);
    const { rows } = await pool.query(`SELECT ${COLUNAS} ${DE} WHERE r.id = $1`, [r.rows[0].id]);
    res.json({ registro: comSituacao(rows)[0] });
  } catch (e) { console.error('[qualidade] PATCH /tratar falhou:', e); res.status(500).json({ error: 'Erro ao registrar a tratativa.' }); }
});

module.exports = { router, routerAnalista, validarTipo, TIPOS, DEPARTAMENTOS, STATUS, validarRegistro, validarMudanca, situacao, semAcento, hojeBrasilia, mesmoNome, montarPrioridades, segundaDe };
