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
function validarRegistro(corpo, hoje) {
  const b = corpo || {};
  const h = hoje || hojeBrasilia();
  const cliente_id = texto(b.cliente_id, 80);
  if (!cliente_id) return { ok: false, erro: 'Escolha o cliente.' };
  const tipo = TIPOS.find((t) => t === b.tipo);
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
      .then(() => pool.query('ALTER TABLE analistas ADD COLUMN IF NOT EXISTS user_id TEXT'))
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

router.get('/opcoes', (req, res) => res.json({ tipos: TIPOS, departamentos: DEPARTAMENTOS, status: STATUS, max_detalhe: MAX_DETALHE, max_tratativa: MAX_TRATATIVA }));

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
  const v = validarRegistro(req.body);
  if (!v.ok) return res.status(400).json({ error: v.erro });
  try {
    await garantirSchema();
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

module.exports = { router, routerAnalista, TIPOS, DEPARTAMENTOS, STATUS, validarRegistro, validarMudanca, situacao, semAcento, hojeBrasilia };
