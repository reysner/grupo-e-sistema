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
const STATUS = ['aberto', 'em_tratamento', 'finalizada', 'resolvido', 'cancelado'];
const ROTULO_STATUS = { aberto: 'Aberto', em_tratamento: 'Em tratamento', finalizada: 'Finalizada (aguardando validação)', resolvido: 'Resolvido', cancelado: 'Cancelado' };
const MAX_DETALHE = 2000;   // "Descreva a tratativa" da ficha e "Descrição / Detalhes da ocorrência" (era 600; ampliado a pedido do Reysner, 17/10/2026)
const PRIORIDADES = ['Muito Alta', 'Alta', 'Média', 'Baixa'];
const PAPEIS_GESTOR = ['gestor', 'diretor'];
/**
 * Etapas do fluxo de uma ocorrência registrada no módulo (Portal do Gestor, 17/10/2026):
 *   registrada → (o gestor do departamento analisa e cria a tratativa: plano de ação, responsável e departamento) → tratativa_definida
 *   → (o gestor abre para o analista) com_analista → (o analista trata e deixa uma nota) validacao_gestor
 *   → (o gestor valida, "tudo ok", com nota) devolutiva_cliente → (o Sucesso do Cliente dá a devolutiva ao cliente e encerra) encerrada.
 * O risco de churn continua lendo o "status" (aberto, em tratamento, finalizada, resolvido): registrada e tratativa_definida = aberto,
 * com_analista = em tratamento, validacao_gestor e devolutiva_cliente = finalizada, encerrada = resolvido (aplicado nas telas das etapas 2 e 3).
 */
const ETAPAS = ['registrada', 'tratativa_definida', 'com_analista', 'validacao_gestor', 'devolutiva_cliente', 'encerrada'];
const MAX_ANEXO = 10 * 1024 * 1024;   // por arquivo (ficam no banco)
const MAX_ANEXOS = 5;               // por ocorrência
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
/** Tipo gravado nos planos de ação feitos na ficha (a ficha não pede tipo; tipo de verdade só existe nas ocorrências lançadas no módulo). */
const TIPO_PLANO = 'Plano de ação';

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

/** Responsáveis de um lançamento: `analistas_ids` (vários) ou `analista_id` (um), sem repetição nem vazios, no máximo 20. */
function idsResponsaveis(corpo) {
  const b = corpo || {};
  const bruto = Array.isArray(b.analistas_ids) ? b.analistas_ids : (b.analista_id ? [b.analista_id] : []);
  const ids = [];
  bruto.forEach((x) => { const t = texto(x, 80); if (t && !ids.includes(t)) ids.push(t); });
  return ids.slice(0, 20);
}

/**
 * Valida uma OCORRÊNCIA lançada no módulo Qualidade (empresa, assunto, tipo, prioridade, departamento, descrição).
 * Tem prazo para execução (obrigatório), mas ainda não tem responsável: quem trata é definido pelo gestor (Portal do Gestor, próxima etapa).
 */
function validarOcorrencia(corpo, tiposPermitidos, hoje) {
  const b = corpo || {};
  const cliente_id = texto(b.cliente_id, 80);
  if (!cliente_id) return { ok: false, erro: 'Escolha a empresa na lista que aparece enquanto você digita.' };
  const assunto = texto(b.assunto, 101);
  if (assunto.length < 3) return { ok: false, erro: 'Informe o assunto da ocorrência (mínimo de 3 caracteres).' };
  if (assunto.length > 100) return { ok: false, erro: 'O assunto passa de 100 caracteres.' };
  const tipo = (tiposPermitidos || TIPOS).find((t) => t === b.tipo);
  if (!tipo) return { ok: false, erro: 'Escolha o tipo de ocorrência.' };
  const prioridade = PRIORIDADES.find((p) => p === b.prioridade) || null;
  if (!prioridade) return { ok: false, erro: 'Escolha a prioridade.' };
  const departamento = DEPARTAMENTOS.find((d) => d === b.departamento);
  if (!departamento) return { ok: false, erro: 'Escolha o departamento.' };
  // a descrição guarda as quebras de linha (por isso não passa por texto())
  const detalhe = String(b.detalhe == null ? '' : b.detalhe).replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
  if (detalhe.length < 5) return { ok: false, erro: 'Descreva a ocorrência (mínimo de 5 caracteres).' };
  if (detalhe.length > MAX_DETALHE) return { ok: false, erro: 'A descrição passa de ' + MAX_DETALHE + ' caracteres.' };
  const h = hoje || hojeBrasilia();
  const prazo = texto(b.prazo, 10);
  if (!ISO.test(prazo) || isNaN(Date.parse(prazo + 'T12:00:00Z'))) return { ok: false, erro: 'Informe o prazo para execução.' };
  if (prazo < h) return { ok: false, erro: 'O prazo não pode ser uma data que já passou.' };
  if (prazo > somarDias(h, 365)) return { ok: false, erro: 'O prazo passa de um ano: escolha uma data mais próxima.' };
  return { ok: true, valores: { cliente_id, assunto, tipo, prioridade, departamento, detalhe, prazo } };
}

const rotuloDepto = (d) => (d === 'Sucesso' ? 'Sucesso do Cliente' : d);

/** Valida o cadastro de um gestor de departamento: pessoa, departamento da lista e papel (gestor ou diretor). */
function validarGestor(corpo) {
  const b = corpo || {};
  const user_id = texto(b.user_id, 80);
  if (!user_id) return { ok: false, erro: 'Escolha a pessoa.' };
  const departamento = DEPARTAMENTOS.find((d) => d === b.departamento);
  if (!departamento) return { ok: false, erro: 'Escolha o departamento.' };
  const papel = b.papel === undefined ? 'gestor' : PAPEIS_GESTOR.find((p) => p === b.papel);
  if (!papel) return { ok: false, erro: 'O papel é gestor ou diretor.' };
  return { ok: true, valores: { user_id, departamento, papel } };
}

/**
 * Para onde vai uma ocorrência: ao(s) GESTOR(es) do departamento escolhido; se o departamento ainda não tem gestor cadastrado, ao Sucesso do Cliente.
 * Diretor não recebe a fila (diretores são administradores e já enxergam tudo). entrada: lista de { papel, name }.
 */
function destinoDaOcorrencia(departamento, gestores) {
  const nomes = (gestores || []).filter((g) => g && g.papel === 'gestor').map((g) => g.name).filter(Boolean);
  return nomes.length ? { fila: 'gestor', gestores: nomes } : { fila: 'sucesso', gestores: [] };
}
function textoDestino(departamento, dest) {
  return dest.fila === 'gestor'
    ? 'Encaminhada ao gestor de ' + rotuloDepto(departamento) + ': ' + dest.gestores.join(', ') + '.'
    : rotuloDepto(departamento) + ' ainda não tem gestor cadastrado: encaminhada ao Sucesso do Cliente.';
}
/** Quem muda o prazo de uma ocorrência: a administração ou o gestor/diretor de um dos departamentos dela. */
function podeAlterarPrazo(user, departamentos, deptosDoUsuario) {
  if (user && user.role === 'administrador') return true;
  const meus = deptosDoUsuario || [];
  return (departamentos || []).some((d) => meus.includes(d));
}

/** Valida a mudança de um registro: status, prazo e/ou tratativa. */
function validarMudanca(corpo, hoje, opts) {
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
  if (v.status === 'finalizada' && (v.tratativa || '').length < 5) return { ok: false, erro: 'Para finalizar, descreva o que foi feito (mínimo de 5 caracteres).' };
  if (v.status === 'resolvido' && (v.tratativa || '').length < 5 && !(opts && opts.jaTemTratativa)) return { ok: false, erro: 'Para resolver, descreva o que foi feito (mínimo de 5 caracteres).' };
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
      .then(() => pool.query('ALTER TABLE cs_qualidade_registros ADD COLUMN IF NOT EXISTS validado_em TIMESTAMPTZ'))
      .then(() => pool.query('ALTER TABLE cs_qualidade_registros ADD COLUMN IF NOT EXISTS validado_por TEXT'))
      // origem: 'ficha' = plano de ação escrito na ficha do cliente (informativo: não entra nos Sinais de atenção, no card Tratativa nem no risco);
      // 'modulo' = lançado no módulo Qualidade (aparece nos Sinais de atenção, alimenta o card Tratativa e pesa no risco de churn).
      .then(() => pool.query("ALTER TABLE cs_qualidade_registros ADD COLUMN IF NOT EXISTS origem TEXT NOT NULL DEFAULT 'ficha'"))
      // ocorrências do módulo: assunto e prioridade; ainda sem responsável nem prazo (a tratativa por departamento vem na próxima etapa)
      .then(() => pool.query('ALTER TABLE cs_qualidade_registros ADD COLUMN IF NOT EXISTS assunto TEXT'))
      .then(() => pool.query('ALTER TABLE cs_qualidade_registros ADD COLUMN IF NOT EXISTS prioridade TEXT'))
      .then(() => pool.query('ALTER TABLE cs_qualidade_registros ALTER COLUMN analista_id DROP NOT NULL'))
      .then(() => pool.query('ALTER TABLE cs_qualidade_registros ALTER COLUMN prazo DROP NOT NULL'))
      .then(() => pool.query(`CREATE TABLE IF NOT EXISTS cs_qualidade_anexos (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), registro_id UUID NOT NULL REFERENCES cs_qualidade_registros(id) ON DELETE CASCADE,
        nome TEXT NOT NULL, mime TEXT, tamanho INT NOT NULL, dados BYTEA NOT NULL, criado_por TEXT, criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW())`))
      .then(() => pool.query('ALTER TABLE cs_qualidade_anexos ENABLE ROW LEVEL SECURITY'))
      // fluxo do Portal do Gestor: etapa da ocorrência e para quem ela foi encaminhada ('gestor' do departamento, ou 'sucesso' se o departamento não tem gestor)
      .then(() => pool.query("ALTER TABLE cs_qualidade_registros ADD COLUMN IF NOT EXISTS etapa TEXT NOT NULL DEFAULT 'registrada'"))
      .then(() => pool.query('ALTER TABLE cs_qualidade_registros ADD COLUMN IF NOT EXISTS fila TEXT'))
      .then(() => pool.query(`CREATE TABLE IF NOT EXISTS cs_qualidade_gestores (
        id SERIAL PRIMARY KEY, user_id TEXT NOT NULL, departamento TEXT NOT NULL, papel TEXT NOT NULL DEFAULT 'gestor',
        criado_por TEXT, criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE (user_id, departamento))`))
      .then(() => pool.query('ALTER TABLE cs_qualidade_gestores ENABLE ROW LEVEL SECURITY'))
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
      .then(() => require('./limpezaTeste').aplicar(pool))     // limpeza única do registro de teste da Josiane (16/10/2026)
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
       to_char(r.prazo, 'YYYY-MM-DD') AS prazo, r.status, r.origem, r.etapa, r.fila, r.assunto, r.prioridade, r.criado_por, r.criado_em, r.resolvido_em, r.resolvido_por, r.tratativa, r.validado_em, r.validado_por`;
const DE = `FROM cs_qualidade_registros r LEFT JOIN analistas a ON a.id::text = r.analista_id`;
const comSituacao = (rows) => rows.map((r) => ({ ...r, situacao: situacao(r.status, r.prazo), status_rotulo: ROTULO_STATUS[r.status] }));

/** Anexa a cada registro a linha do tempo de notas e eventos (nota, iniciada, finalizada, devolvida, validada). */
async function anexarNotas(lista) {
  if (!lista.length) return lista;
  try {
    const { rows } = await pool.query(
      `SELECT registro_id, em, por, acao, texto FROM cs_qualidade_historico WHERE registro_id = ANY($1::uuid[]) AND acao IN ('nota', 'iniciada', 'finalizada', 'devolvida', 'validada') ORDER BY em ASC`,
      [lista.map((r) => r.id)]);
    const por = {}; rows.forEach((h) => { (por[h.registro_id] = por[h.registro_id] || []).push({ em: h.em, por: h.por, acao: h.acao, texto: h.texto }); });
    return lista.map((r) => ({ ...r, notas: por[r.id] || [] }));
  } catch (e) { return lista.map((r) => ({ ...r, notas: [] })); }
}

/** Anexa a cada registro a lista de arquivos (sem o conteúdo): [{ id, nome, tamanho }]. */
async function anexarAnexos(lista) {
  if (!lista.length) return lista;
  try {
    const { rows } = await pool.query('SELECT id, registro_id, nome, tamanho FROM cs_qualidade_anexos WHERE registro_id = ANY($1::uuid[]) ORDER BY criado_em', [lista.map((r) => r.id)]);
    const por = {}; rows.forEach((a) => { (por[a.registro_id] = por[a.registro_id] || []).push({ id: a.id, nome: a.nome, tamanho: a.tamanho }); });
    return lista.map((r) => ({ ...r, anexos: por[r.id] || [] }));
  } catch (e) { return lista.map((r) => ({ ...r, anexos: [] })); }
}

/**
 * Aviso no sino a TODOS os administradores quando alguém lança uma consideração de Qualidade. O sino é compartilhado: qualquer administrador
 * que abrir o aviso chega ao módulo Qualidade do /cs, onde todos podem interagir (validar, devolver, cancelar, ajustar prazo).
 */
async function notificarLancamento(reg, lancador, destino) {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS notificacoes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tipo TEXT NOT NULL, titulo TEXT NOT NULL, mensagem TEXT NOT NULL,
      lida BOOLEAN DEFAULT false, link_modulo TEXT, created_at TIMESTAMPTZ DEFAULT NOW())`);
    if (reg.origem === 'modulo') {   // ocorrência registrada no módulo
      await pool.query(
        `INSERT INTO notificacoes (tipo, titulo, mensagem, link_modulo) VALUES ('qualidade_lancada', $1, $2, 'cs-qualidade')`,
        ['Nova ocorrência registrada: ' + reg.tipo, (lancador || 'Alguém') + ' registrou uma ocorrência (' + reg.tipo + ', prioridade ' + (reg.prioridade || '—') + ') em "' + (reg.cliente_nome || 'cliente') + '": ' + (reg.assunto || '') + ' — ' + (reg.departamentos || []).join(', ') + ', prazo ' + String(reg.prazo || '').split('-').reverse().join('/') + '.' + (destino ? ' ' + destino : '')]);
      return;
    }
    const prazo = String(reg.prazo || '').split('-').reverse().join('/');
    await pool.query(
      `INSERT INTO notificacoes (tipo, titulo, mensagem, link_modulo) VALUES ('qualidade_lancada', $1, $2, 'cs-qualidade')`,
      [reg.tipo === TIPO_PLANO ? 'Novo plano de ação registrado' : 'Nova qualidade lançada: ' + reg.tipo, (lancador || 'Alguém') + ' lançou "' + reg.tipo + '" para ' + (reg.analista_nome || 'o analista') + ' sobre "' + (reg.cliente_nome || 'cliente') + '" (' + (reg.departamentos || []).join(', ') + '), prazo ' + prazo + '.']);
  } catch (e) { console.warn('[qualidade] aviso de lançamento não gravado:', e.message); }
}

/** Aviso no sino do administrador quando o analista finaliza: a liderança valida para encerrar o processo. */
async function notificarFinalizacao(reg, analistaNome, tratativa) {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS notificacoes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tipo TEXT NOT NULL, titulo TEXT NOT NULL, mensagem TEXT NOT NULL,
      lida BOOLEAN DEFAULT false, link_modulo TEXT, created_at TIMESTAMPTZ DEFAULT NOW())`);
    await pool.query(
      `INSERT INTO notificacoes (tipo, titulo, mensagem, link_modulo) VALUES ('qualidade_finalizada', $1, $2, 'cs-qualidade')`,
      ['Tratativa finalizada: ' + reg.tipo, analistaNome + ' finalizou a tratativa de "' + (reg.cliente_nome || 'cliente') + '" (' + reg.tipo + '). Valide para encerrar o processo.' + (tratativa ? ' Resumo: ' + String(tratativa).slice(0, 160) : '')]);
  } catch (e) { console.warn('[qualidade] aviso de finalização não gravado:', e.message); }
}

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
    res.json({ tipos: tipos.map((t) => t.nome), departamentos: DEPARTAMENTOS, prioridades: PRIORIDADES, status: STATUS, max_detalhe: MAX_DETALHE, max_tratativa: MAX_TRATATIVA, max_anexo: MAX_ANEXO, max_anexos: MAX_ANEXOS });
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
    res.json({ registros: await anexarAnexos(await anexarNotas(comSituacao(rows))) });
  } catch (e) { console.error('[qualidade] GET /cliente falhou:', e); res.status(500).json({ error: 'Erro ao ler os registros do cliente.' }); }
});

router.post('/', async (req, res) => {
  try {
    // A ficha não envia tipo: o registro vira "Plano de ação" (origem 'ficha'). Quem ainda enviar um tipo (página antiga em cache) segue validado pela lista.
    const comTipo = !!(req.body && req.body.tipo);
    const tipos = comTipo ? (await tiposAtivos()).map((t) => t.nome) : [TIPO_PLANO];
    // Mais de um responsável: um registro para cada um (cada responsável trata o seu, com status e prazo próprios).
    const ids = idsResponsaveis(req.body);
    const corpo = Object.assign({}, comTipo ? req.body : Object.assign({}, req.body, { tipo: TIPO_PLANO }), { analista_id: ids[0] || '' });
    const v = validarRegistro(corpo, undefined, tipos);
    if (!v.ok) return res.status(400).json({ error: v.erro });
    const cli = await pool.query(`SELECT id::text AS id, nome_empresa, regexp_replace(cnpj, '\\D', '', 'g') AS cnpj FROM clientes WHERE id::text = $1`, [v.valores.cliente_id]);
    if (!cli.rows.length) return res.status(404).json({ error: 'Cliente não encontrado.' });
    for (const aid of ids) {   // confere todos antes de gravar qualquer um
      const an = await pool.query('SELECT id, nome, ativo FROM analistas WHERE id::text = $1', [aid]);
      if (!an.rows.length) return res.status(404).json({ error: 'Responsável não encontrado.' });
      if (!an.rows[0].ativo) return res.status(400).json({ error: an.rows[0].nome + ' está desativado na lista.' });
    }
    const c = cli.rows[0], x = v.valores, criados = [];
    for (const aid of ids) {
      const ins = await pool.query(
        `INSERT INTO cs_qualidade_registros (cliente_id, cnpj, cliente_nome, tipo, departamentos, detalhe, analista_id, prazo, criado_por, criado_por_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [c.id, soDigitos(c.cnpj), c.nome_empresa, x.tipo, x.departamentos, x.detalhe, aid, x.prazo, req.user.name || null, req.user.id || null]);
      await registrar(ins.rows[0].id, req.user.name, 'criado', x.tipo + ' · prazo ' + x.prazo);
      const { rows } = await pool.query(`SELECT ${COLUNAS} ${DE} WHERE r.id = $1`, [ins.rows[0].id]);
      await notificarLancamento(rows[0], req.user.name);
      criados.push(comSituacao(rows)[0]);
    }
    res.status(201).json({ registro: criados[0], registros: criados });
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
              COUNT(r.id) FILTER (WHERE r.status = 'finalizada')::int AS a_validar,
              COUNT(r.id) FILTER (WHERE r.status <> 'cancelado')::int AS total,
              to_char(MAX(r.criado_em) AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS ultimo_lancamento,
              to_char(MIN(r.prazo) FILTER (WHERE r.status IN ('aberto', 'em_tratamento')), 'YYYY-MM-DD') AS proximo_prazo
         FROM analistas a LEFT JOIN cs_qualidade_registros r ON r.analista_id = a.id::text
        GROUP BY a.id, a.nome, a.ativo, a.user_id ORDER BY a.nome`, [hoje]);
    const orfaos = await pool.query(`SELECT COUNT(*)::int AS n FROM cs_qualidade_registros r WHERE NOT EXISTS (SELECT 1 FROM analistas a WHERE a.id::text = r.analista_id)`);
    res.json({ hoje, analistas: rows, sem_analista: orfaos.rows[0].n });
  } catch (e) { console.error('[qualidade] GET /resumo falhou:', e); res.status(500).json({ error: 'Erro ao montar o módulo Qualidade.' }); }
});

/** Lançamentos dos últimos dias (todos os analistas), para o aviso de "novos" no módulo Qualidade. */
router.get('/recentes', async (req, res) => {
  try {
    await garantirSchema();
    const dias = Math.min(30, Math.max(1, parseInt(req.query.dias, 10) || 7));
    const { rows } = await pool.query(
      `SELECT ${COLUNAS} ${DE} WHERE r.criado_em >= NOW() - ($1 || ' days')::interval AND r.status <> 'cancelado' ORDER BY r.criado_em DESC LIMIT 30`, [String(dias)]);
    res.json({ dias, registros: comSituacao(rows) });
  } catch (e) { console.error('[qualidade] GET /recentes falhou:', e); res.status(500).json({ error: 'Erro ao ler os lançamentos recentes.' }); }
});

router.get('/analista/:id', async (req, res) => {
  try {
    await garantirSchema();
    const a = await pool.query('SELECT id, nome, ativo, user_id FROM analistas WHERE id::text = $1', [String(req.params.id)]);
    if (!a.rows.length) return res.status(404).json({ error: 'Analista não encontrado.' });
    const { rows } = await pool.query(`SELECT ${COLUNAS} ${DE} WHERE r.analista_id = $1 ORDER BY r.criado_em DESC LIMIT 300`, [String(req.params.id)]);
    res.json({ analista: a.rows[0], registros: await anexarNotas(comSituacao(rows)) });
  } catch (e) { console.error('[qualidade] GET /analista falhou:', e); res.status(500).json({ error: 'Erro ao ler os registros do analista.' }); }
});

/** Gestores por departamento (a equipe vê quem é; só o administrador cadastra). O administrador também recebe a lista de pessoas para escolher. */
router.get('/gestores', async (req, res) => {
  try {
    await garantirSchema();
    const { rows } = await pool.query(`SELECT g.id, g.user_id, g.departamento, g.papel, u.name, u.email FROM cs_qualidade_gestores g JOIN users u ON u.id::text = g.user_id WHERE u.active = true ORDER BY u.name`);
    const departamentos = DEPARTAMENTOS.map((d) => ({ codigo: d, rotulo: rotuloDepto(d), gestores: rows.filter((g) => g.departamento === d).map((g) => ({ id: g.id, user_id: g.user_id, nome: g.name, email: g.email, papel: g.papel })) }));
    const resp = { departamentos };
    if (req.user.role === 'administrador') resp.usuarios = (await pool.query('SELECT id::text AS id, name, email, role FROM users WHERE active = true ORDER BY name')).rows;
    res.json(resp);
  } catch (e) { console.error('[qualidade] GET /gestores falhou:', e); res.status(500).json({ error: 'Erro ao ler os gestores.' }); }
});
router.post('/gestores', async (req, res) => {
  if (!req.user || req.user.role !== 'administrador') return res.status(403).json({ error: 'Só o administrador cadastra gestores.' });
  const v = validarGestor(req.body);
  if (!v.ok) return res.status(400).json({ error: v.erro });
  try {
    await garantirSchema();
    const u = (await pool.query('SELECT id::text AS id, name FROM users WHERE id::text = $1 AND active = true', [v.valores.user_id])).rows[0];
    if (!u) return res.status(404).json({ error: 'Pessoa não encontrada entre os usuários ativos.' });
    const ins = await pool.query(
      `INSERT INTO cs_qualidade_gestores (user_id, departamento, papel, criado_por) VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, departamento) DO UPDATE SET papel = EXCLUDED.papel RETURNING id`,
      [v.valores.user_id, v.valores.departamento, v.valores.papel, req.user.name || null]);
    res.status(201).json({ ok: true, id: ins.rows[0].id });
  } catch (e) { console.error('[qualidade] POST /gestores falhou:', e); res.status(500).json({ error: 'Erro ao cadastrar o gestor.' }); }
});
router.delete('/gestores/:id', async (req, res) => {
  if (!req.user || req.user.role !== 'administrador') return res.status(403).json({ error: 'Só o administrador retira gestores.' });
  try {
    await garantirSchema();
    const del = await pool.query('DELETE FROM cs_qualidade_gestores WHERE id = $1 RETURNING id', [parseInt(req.params.id, 10) || 0]);
    if (!del.rows.length) return res.status(404).json({ error: 'Gestor não encontrado.' });
    res.json({ ok: true });
  } catch (e) { console.error('[qualidade] DELETE /gestores falhou:', e); res.status(500).json({ error: 'Erro ao retirar o gestor.' }); }
});

/** Sugestão de empresas ao digitar: as que COMEÇAM com o texto (nome ou CNPJ) vêm primeiro; se couberem mais, as que apenas contêm. */
router.get('/empresas', async (req, res) => {
  try {
    const q = texto(req.query.q, 60);
    if (q.length < 1) return res.json({ empresas: [] });
    const esc = q.replace(/[\\%_]/g, '\\$&');
    const dig = soDigitos(q);
    const prefixo = (await pool.query(
      `SELECT id::text AS id, nome_empresa AS nome, cnpj FROM clientes
        WHERE status = 'ativo' AND (nome_empresa ILIKE $1 OR ($2 <> '' AND regexp_replace(COALESCE(cnpj, ''), '\\D', '', 'g') LIKE $2 || '%'))
        ORDER BY nome_empresa LIMIT 15`, [esc + '%', dig.length >= 2 ? dig : ''])).rows;
    let lista = prefixo;
    if (lista.length < 15 && q.length >= 3) {
      const ja = lista.map((e) => e.id);
      const contem = (await pool.query(
        `SELECT id::text AS id, nome_empresa AS nome, cnpj FROM clientes WHERE status = 'ativo' AND nome_empresa ILIKE $1 AND NOT (id::text = ANY($2::text[])) ORDER BY nome_empresa LIMIT $3`,
        ['%' + esc + '%', ja, 15 - lista.length])).rows;
      lista = lista.concat(contem);
    }
    res.json({ empresas: lista });
  } catch (e) { console.error('[qualidade] GET /empresas falhou:', e); res.status(500).json({ error: 'Erro ao buscar as empresas.' }); }
});

/** REGISTRAR OCORRÊNCIA: lança no módulo Qualidade (aparece nos Sinais de atenção da empresa, alimenta o card Tratativas e pesa no risco de churn). */
router.post('/ocorrencias', async (req, res) => {
  try {
    const tipos = (await tiposAtivos()).map((t) => t.nome);
    const v = validarOcorrencia(req.body, tipos);
    if (!v.ok) return res.status(400).json({ error: v.erro });
    const x = v.valores;
    const cli = await pool.query(`SELECT id::text AS id, nome_empresa, regexp_replace(cnpj, '\\D', '', 'g') AS cnpj FROM clientes WHERE id::text = $1 AND status = 'ativo'`, [x.cliente_id]);
    if (!cli.rows.length) return res.status(404).json({ error: 'Empresa não encontrada entre os clientes ativos.' });
    const c = cli.rows[0];
    // encaminhamento: gestor(es) do departamento escolhido; sem gestor cadastrado, vai para o Sucesso do Cliente
    const gest = (await pool.query(
      `SELECT g.papel, u.name FROM cs_qualidade_gestores g JOIN users u ON u.id::text = g.user_id WHERE g.departamento = $1 AND u.active = true ORDER BY u.name`, [x.departamento])).rows;
    const dest = destinoDaOcorrencia(x.departamento, gest), textoDest = textoDestino(x.departamento, dest);
    const ins = await pool.query(
      `INSERT INTO cs_qualidade_registros (cliente_id, cnpj, cliente_nome, tipo, departamentos, detalhe, assunto, prioridade, prazo, origem, fila, criado_por, criado_por_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'modulo', $10, $11, $12) RETURNING id`,
      [c.id, soDigitos(c.cnpj), c.nome_empresa, x.tipo, [x.departamento], x.detalhe, x.assunto, x.prioridade, x.prazo, dest.fila, req.user.name || null, req.user.id || null]);
    await registrar(ins.rows[0].id, req.user.name, 'criado', x.tipo + ' · ' + x.prioridade + ' · ' + x.assunto);
    const { rows } = await pool.query(`SELECT ${COLUNAS} ${DE} WHERE r.id = $1`, [ins.rows[0].id]);
    await notificarLancamento(rows[0], req.user.name, textoDest);
    res.status(201).json({ registro: comSituacao(rows)[0], destino: textoDest, fila: dest.fila });
  } catch (e) { console.error('[qualidade] POST /ocorrencias falhou:', e); res.status(500).json({ error: 'Erro ao registrar a ocorrência.' }); }
});

/** Anexo de uma ocorrência: o arquivo vai no corpo da requisição (bytes) e o nome em ?nome=. Até 5 arquivos de 10 MB por ocorrência. */
router.post('/ocorrencias/:id/anexo', express.raw({ type: () => true, limit: MAX_ANEXO + 1024 }), async (req, res) => {
  try {
    await garantirSchema();
    const reg = (await pool.query("SELECT id FROM cs_qualidade_registros WHERE id::text = $1 AND origem = 'modulo'", [String(req.params.id)])).rows[0];
    if (!reg) return res.status(404).json({ error: 'Ocorrência não encontrada.' });
    const dados = Buffer.isBuffer(req.body) ? req.body : null;
    if (!dados || !dados.length) return res.status(400).json({ error: 'Arquivo vazio.' });
    if (dados.length > MAX_ANEXO) return res.status(413).json({ error: 'O arquivo passa de ' + Math.round(MAX_ANEXO / 1048576) + ' MB.' });
    const n = (await pool.query('SELECT COUNT(*)::int AS n FROM cs_qualidade_anexos WHERE registro_id = $1', [reg.id])).rows[0].n;
    if (n >= MAX_ANEXOS) return res.status(400).json({ error: 'No máximo ' + MAX_ANEXOS + ' arquivos por ocorrência.' });
    const nome = texto(req.query.nome, 150).replace(/[\\/:*?"<>|]/g, '_') || 'arquivo';
    const mime = texto(req.query.tipo, 100) || 'application/octet-stream';   // o arquivo sempre chega como binário; o tipo original vem em ?tipo=
    const ins = await pool.query('INSERT INTO cs_qualidade_anexos (registro_id, nome, mime, tamanho, dados, criado_por) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, nome, tamanho', [reg.id, nome, mime, dados.length, dados, req.user.name || null]);
    res.status(201).json({ anexo: ins.rows[0] });
  } catch (e) { console.error('[qualidade] POST anexo falhou:', e); res.status(500).json({ error: 'Erro ao guardar o anexo.' }); }
});

/** Baixa um anexo (sempre como arquivo para salvar; nunca é aberto dentro do sistema). */
router.get('/anexo/:anexoId', async (req, res) => {
  try {
    await garantirSchema();
    const a = (await pool.query('SELECT nome, mime, dados FROM cs_qualidade_anexos WHERE id::text = $1', [String(req.params.anexoId)])).rows[0];
    if (!a) return res.status(404).json({ error: 'Anexo não encontrado.' });
    res.set({ 'Content-Type': a.mime || 'application/octet-stream', 'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(a.nome), 'X-Content-Type-Options': 'nosniff' });
    res.send(a.dados);
  } catch (e) { console.error('[qualidade] GET anexo falhou:', e); res.status(500).json({ error: 'Erro ao baixar o anexo.' }); }
});

/** Ocorrências lançadas no módulo (as mais recentes primeiro; canceladas ficam de fora). */
router.get('/ocorrencias', async (req, res) => {
  try {
    await garantirSchema();
    const { rows } = await pool.query(`SELECT ${COLUNAS} ${DE} WHERE r.origem = 'modulo' AND r.status <> 'cancelado' ORDER BY r.criado_em DESC LIMIT 200`);
    res.json({ registros: await anexarAnexos(await anexarNotas(comSituacao(rows))) });
  } catch (e) { console.error('[qualidade] GET /ocorrencias falhou:', e); res.status(500).json({ error: 'Erro ao ler as ocorrências.' }); }
});

router.patch('/:id', async (req, res) => {
  try {
    await garantirSchema();
    const atual = (await pool.query('SELECT id, status, tratativa, origem, departamentos FROM cs_qualidade_registros WHERE id::text = $1', [String(req.params.id)])).rows[0];
    if (!atual) return res.status(404).json({ error: 'Registro não encontrado.' });
    // o prazo de uma ocorrência do módulo é do gestor do departamento (ou da administração)
    if (atual.origem === 'modulo' && req.body && req.body.prazo !== undefined && req.user.role !== 'administrador') {
      const meus = (await pool.query('SELECT departamento FROM cs_qualidade_gestores WHERE user_id = $1', [String(req.user.id)])).rows.map((g) => g.departamento);
      if (!podeAlterarPrazo(req.user, atual.departamentos, meus)) return res.status(403).json({ error: 'Só o gestor do departamento ou a administração altera o prazo.' });
    }
    const v = validarMudanca(req.body, undefined, { jaTemTratativa: !!(atual.tratativa && atual.tratativa.length >= 5) });
    if (!v.ok) return res.status(400).json({ error: v.erro });
    const x = v.valores, sets = [], vals = [];
    const add = (col, val) => { vals.push(val); sets.push(col + ' = $' + vals.length); };
    if (x.status) {
      add('status', x.status);
      if (x.status === 'resolvido') { add('validado_em', new Date()); add('validado_por', req.user.name || null); sets.push('resolvido_em = COALESCE(resolvido_em, NOW())'); }
      if (x.status === 'em_tratamento' && atual.status === 'finalizada') { sets.push('resolvido_em = NULL', 'resolvido_por = NULL'); }   // devolvida ao analista
    }
    if (x.prazo) add('prazo', x.prazo);
    if (x.tratativa !== undefined) add('tratativa', x.tratativa);
    sets.push('atualizado_em = NOW()');
    vals.push(atual.id);
    await pool.query(`UPDATE cs_qualidade_registros SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    const acao = x.status === 'resolvido' ? 'validada' : (x.status === 'em_tratamento' && atual.status === 'finalizada' ? 'devolvida' : (x.status ? 'status:' + x.status : (x.prazo ? 'prazo' : 'tratativa')));
    await registrar(atual.id, req.user.name, acao, x.tratativa || x.prazo || (req.body && req.body.motivo ? texto(req.body.motivo, MAX_TRATATIVA) : null));
    const { rows } = await pool.query(`SELECT ${COLUNAS} ${DE} WHERE r.id = $1`, [atual.id]);
    res.json({ registro: (await anexarNotas(comSituacao(rows)))[0] });
  } catch (e) { console.error('[qualidade] PATCH falhou:', e); res.status(500).json({ error: 'Erro ao atualizar o registro.' }); }
});

/** Exclui um registro de vez (lançamento de teste ou errado). Só administrador; para manter o histórico, use cancelar. */
router.delete('/:id', async (req, res) => {
  if (!req.user || req.user.role !== 'administrador') return res.status(403).json({ error: 'Só o administrador exclui um registro.' });
  try {
    await garantirSchema();
    const del = await pool.query('DELETE FROM cs_qualidade_registros WHERE id::text = $1 RETURNING id', [String(req.params.id)]);
    if (!del.rows.length) return res.status(404).json({ error: 'Registro não encontrado.' });
    res.json({ ok: true });
  } catch (e) { console.error('[qualidade] DELETE falhou:', e); res.status(500).json({ error: 'Erro ao excluir o registro.' }); }
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
    const registros = await anexarNotas(comSituacao(regs));

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
    res.json({ analista, registros: await anexarNotas(comSituacao(rows)) });
  } catch (e) { console.error('[qualidade] GET /minhas falhou:', e); res.status(500).json({ error: 'Erro ao carregar suas tratativas.' }); }
});

/**
 * Quem pode agir num registro pelo portal: o próprio analista (login ligado a ele) ou administrador/usuário "em nome de" (modo Ver como).
 * Devolve { ok, analistaNome, por } ou { ok:false, status, erro }.
 */
async function autorizaAgir(user, reg) {
  if (PAPEIS.includes(user.role)) {
    const a = (await pool.query('SELECT nome FROM analistas WHERE id::text = $1', [String(reg.analista_id)])).rows[0];
    return { ok: true, analistaNome: a ? a.nome : 'o analista', por: (user.name || 'Liderança') + (a ? ' (em nome de ' + a.nome + ')' : '') };
  }
  const analista = await analistaDoLogin(user);
  if (!analista) return { ok: false, status: 403, erro: 'Seu login não está ligado a um analista.' };
  if (String(reg.analista_id) !== String(analista.id)) return { ok: false, status: 403, erro: 'Esse registro é de outro analista.' };
  return { ok: true, analistaNome: analista.nome, por: user.name || analista.nome };
}

routerAnalista.patch('/:id/tratar', async (req, res) => {
  const b = req.body || {};
  // "resolvido" vindo de páginas antigas vale como finalizar: quem encerra de fato é a liderança
  const status = b.status === 'resolvido' ? 'finalizada' : b.status;
  if (!['em_tratamento', 'finalizada'].includes(status)) return res.status(400).json({ error: 'Escolha iniciar a tratativa ou finalizar.' });
  const v = validarMudanca({ status, tratativa: b.tratativa });
  if (!v.ok) return res.status(400).json({ error: v.erro });
  try {
    await garantirSchema();
    const r = await pool.query('SELECT id, analista_id, status, tipo, cliente_nome FROM cs_qualidade_registros WHERE id::text = $1', [String(req.params.id)]);
    if (!r.rows.length) return res.status(404).json({ error: 'Registro não encontrado.' });
    const ag = await autorizaAgir(req.user, r.rows[0]);
    if (!ag.ok) return res.status(ag.status).json({ error: ag.erro });
    if (['finalizada', 'resolvido', 'cancelado'].includes(r.rows[0].status)) return res.status(409).json({ error: 'Esse registro já foi finalizado ou encerrado.' });
    const x = v.valores, sets = ['status = $1', 'atualizado_em = NOW()'], vals = [x.status];
    if (x.tratativa !== undefined) { vals.push(x.tratativa); sets.push('tratativa = $' + vals.length); }
    if (x.status === 'finalizada') { vals.push(ag.por); sets.push('resolvido_em = NOW()', 'resolvido_por = $' + vals.length); }
    vals.push(r.rows[0].id);
    await pool.query(`UPDATE cs_qualidade_registros SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    await registrar(r.rows[0].id, ag.por, x.status === 'finalizada' ? 'finalizada' : 'iniciada', x.tratativa || null);
    if (x.status === 'finalizada') await notificarFinalizacao(r.rows[0], ag.analistaNome, x.tratativa);
    const { rows } = await pool.query(`SELECT ${COLUNAS} ${DE} WHERE r.id = $1`, [r.rows[0].id]);
    res.json({ registro: (await anexarNotas(comSituacao(rows)))[0] });
  } catch (e) { console.error('[qualidade] PATCH /tratar falhou:', e); res.status(500).json({ error: 'Erro ao registrar a tratativa.' }); }
});

/** Nota ou observação do analista durante a tratativa (fica no histórico, visível para a liderança). */
routerAnalista.post('/:id/nota', async (req, res) => {
  const t = texto(req.body && req.body.texto, MAX_TRATATIVA + 1);
  if (t.length < 3) return res.status(400).json({ error: 'Escreva a nota (mínimo de 3 caracteres).' });
  if (t.length > MAX_TRATATIVA) return res.status(400).json({ error: 'A nota passa de ' + MAX_TRATATIVA + ' caracteres.' });
  try {
    await garantirSchema();
    const r = await pool.query('SELECT id, analista_id, status FROM cs_qualidade_registros WHERE id::text = $1', [String(req.params.id)]);
    if (!r.rows.length) return res.status(404).json({ error: 'Registro não encontrado.' });
    const ag = await autorizaAgir(req.user, r.rows[0]);
    if (!ag.ok) return res.status(ag.status).json({ error: ag.erro });
    if (['resolvido', 'cancelado'].includes(r.rows[0].status)) return res.status(409).json({ error: 'Esse registro já foi encerrado.' });
    await registrar(r.rows[0].id, ag.por, 'nota', t);
    await pool.query('UPDATE cs_qualidade_registros SET atualizado_em = NOW() WHERE id = $1', [r.rows[0].id]);
    const { rows } = await pool.query(`SELECT ${COLUNAS} ${DE} WHERE r.id = $1`, [r.rows[0].id]);
    res.status(201).json({ registro: (await anexarNotas(comSituacao(rows)))[0] });
  } catch (e) { console.error('[qualidade] POST /nota falhou:', e); res.status(500).json({ error: 'Erro ao salvar a nota.' }); }
});

module.exports = { router, routerAnalista, validarTipo, validarOcorrencia, validarGestor, destinoDaOcorrencia, textoDestino, podeAlterarPrazo, ETAPAS, PRIORIDADES, idsResponsaveis, TIPO_PLANO, TIPOS, DEPARTAMENTOS, STATUS, validarRegistro, validarMudanca, situacao, semAcento, hojeBrasilia, mesmoNome, montarPrioridades, segundaDe };
