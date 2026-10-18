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
const push = require('../push');
const acessos = require('./acessos');
const { calcularTempos, ACOES_DO_HISTORICO } = require('./temposEtapa');

const TIPOS = ['Multa', 'Erro', 'Reclamação', 'Atraso', 'Falha de atendimento', 'Falha técnica', 'Outros'];
const DEPARTAMENTOS = ['Comercial', 'Contábil', 'Financeiro', 'Fiscal', 'Legalização', 'Pessoal', 'Sucesso'];
const STATUS = ['aberto', 'em_tratamento', 'finalizada', 'resolvido', 'cancelado'];
const ROTULO_STATUS = { aberto: 'Aberto', em_tratamento: 'Em tratamento', finalizada: 'Finalizada (aguardando validação)', resolvido: 'Resolvido', cancelado: 'Cancelado' };
const MAX_DETALHE = 1500;   // "Descreva a tratativa" da ficha, "Descrição / Detalhes da ocorrência" e plano de ação do gestor (era 600; 2000 em 17/10/2026; 1500 em 18/10/2026 para a tela ficar mais curta)
const PRIORIDADES = ['Muito Alta', 'Alta', 'Média', 'Baixa'];
const PAPEIS_GESTOR = ['gestor', 'diretor', 'final'];   // final = o gestor que encerra o processo no portal do Sucesso do Cliente (etapa 3)
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
 * Tem prazo para execução (obrigatório). O responsável (analista) é opcional: quem registra pode sugerir, e o gestor confirma ou troca ao criar a tratativa.
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
  const analista_id = texto(b.analista_id, 80) || null;
  return { ok: true, valores: { cliente_id, assunto, tipo, prioridade, departamento, detalhe, prazo, analista_id } };
}

const rotuloDepto = (d) => (d === 'Sucesso' ? 'Sucesso do Cliente' : d);

/** Departamentos de um analista (vários, ex.: Financeiro e Legalização): só os da lista, sem repetir, na ordem da lista. */
function validarDepartamentosAnalista(corpo) {
  const b = corpo || {};
  if (!Array.isArray(b.departamentos)) return { ok: false, erro: 'Informe os departamentos como lista.' };
  const set = new Set(b.departamentos.map((d) => String(d)));
  return { ok: true, valores: { departamentos: DEPARTAMENTOS.filter((d) => set.has(d)) } };
}

/** Aviso (não bloqueia) quando o responsável escolhido não é do departamento da ocorrência. Vazio = tudo certo. */
function avisoResponsavel(analista, departamento) {
  if (!analista) return '';
  const ds = Array.isArray(analista.departamentos) ? analista.departamentos : [];
  if (!ds.length) return analista.nome + ' ainda não tem departamento cadastrado (Acessos > Analistas).';
  if (departamento && !ds.includes(departamento)) return analista.nome + ' não é do departamento ' + rotuloDepto(departamento) + ' (atende ' + ds.map(rotuloDepto).join(', ') + ').';
  return '';
}

/** Valida o cadastro de um gestor de departamento: pessoa, departamento da lista e papel (gestor ou diretor). */
function validarGestor(corpo) {
  const b = corpo || {};
  const user_id = texto(b.user_id, 80);
  if (!user_id) return { ok: false, erro: 'Escolha a pessoa.' };
  const departamento = DEPARTAMENTOS.find((d) => d === b.departamento);
  if (!departamento) return { ok: false, erro: 'Escolha o departamento.' };
  const papel = b.papel === undefined ? 'gestor' : PAPEIS_GESTOR.find((p) => p === b.papel);
  if (!papel) return { ok: false, erro: 'O papel é gestor, diretor ou gestor final.' };
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

/**
 * Quem recebe o aviso de uma ocorrência nova: a administração (menos quem registrou); o gestor do departamento quando a ocorrência foi para o
 * gestor; e, quando foi para o Sucesso do Cliente (departamento sem gestor), quem é gestor do Sucesso do Cliente. Quem registrou nunca é avisado.
 */
function deveAvisar(user, reg, deptosGestor) {
  if (!user || !reg) return false;
  if (reg.criado_por_id && String(reg.criado_por_id) === String(user.id)) return false;
  if (user.role === 'administrador') return true;
  const meus = deptosGestor || [];
  if (reg.fila === 'gestor') return (reg.departamentos || []).some((d) => meus.includes(d));
  if (reg.fila === 'sucesso') return meus.includes('Sucesso');
  return false;
}

/** Etapa do fluxo → status que o risco de churn lê (aplicado quando a etapa muda). */
const JA_MUDOU = 'Esta ocorrência acabou de ser atualizada por outra pessoa. Atualize a tela e confira antes de continuar.';
const ETAPA_STATUS = { registrada: 'aberto', tratativa_definida: 'aberto', com_analista: 'em_tratamento', validacao_gestor: 'finalizada', devolutiva_cliente: 'finalizada', encerrada: 'resolvido', cancelada: 'cancelado' };

/** Cada passo do fluxo: de qual etapa sai e para qual vai. Quem pode dar o passo é conferido na rota. */
const TRANSICOES = {
  abrir: { de: ['tratativa_definida'], para: 'com_analista', erro: 'Defina a tratativa (plano de ação, responsável e prazo) antes de abrir para o analista.' },
  analista_encerrar: { de: ['com_analista'], para: 'validacao_gestor', erro: 'Esta ocorrência não está com o analista (ainda não foi aberta, ou já foi devolvida para validação).' },
  gestor_devolver: { de: ['validacao_gestor'], para: 'com_analista', erro: 'Esta ocorrência não está aguardando a validação do gestor.' },
  gestor_validar: { de: ['validacao_gestor'], para: 'devolutiva_cliente', erro: 'Esta ocorrência não está aguardando a validação do gestor.' },
  filha_validar: { de: ['validacao_gestor'], para: 'encerrada', erro: 'Esta ocorrência vinculada não está aguardando a validação do gestor.' },   // a filha não tem devolutiva ao cliente: validada, está encerrada
  cancelar: { de: ['registrada', 'tratativa_definida', 'com_analista', 'validacao_gestor', 'devolutiva_cliente'], para: 'cancelada', erro: 'Só dá para cancelar uma ocorrência que ainda não foi encerrada nem cancelada.' },
  reabrir_encerrada: { de: ['encerrada'], para: 'com_analista', erro: 'Só dá para reabrir uma ocorrência encerrada ou cancelada.' },
  final_encerrar: { de: ['devolutiva_cliente'], para: 'encerrada', erro: 'Esta ocorrência ainda não foi validada pelo gestor: não está na devolutiva ao cliente.' },
};
function transicao(acao, etapa) {
  const t = TRANSICOES[acao];
  if (!t) return { ok: false, erro: 'Ação desconhecida.' };
  if (!t.de.includes(etapa)) return { ok: false, erro: t.erro };
  return { ok: true, para: t.para, status: ETAPA_STATUS[t.para] };
}
/** Nota (obrigatória, 5 a 600) e observação (opcional, até 1000) de quem encerra, valida ou devolve. */
function validarEncerramento(corpo) {
  const b = corpo || {};
  const nota = String(b.nota == null ? '' : b.nota).replace(/\r\n/g, '\n').trim();
  if (nota.length < 5) return { ok: false, erro: 'Deixe a nota (mínimo de 5 caracteres).' };
  if (nota.length > MAX_TRATATIVA) return { ok: false, erro: 'A nota passa de ' + MAX_TRATATIVA + ' caracteres.' };
  const obs = String(b.obs == null ? '' : b.obs).replace(/\r\n/g, '\n').trim();
  if (obs.length > 1000) return { ok: false, erro: 'A observação passa de 1000 caracteres.' };
  return { ok: true, valores: { nota, obs: obs || null } };
}
const textoNota = (v) => v.nota + (v.obs ? ' — Observação: ' + v.obs : '');
/** Motivo de cancelar ou reabrir (obrigatório, 5 a 600 caracteres). */
function validarMotivo(corpo) {
  const b = corpo || {};
  const motivo = String(b.motivo == null ? '' : b.motivo).trim();
  if (motivo.length < 5) return { ok: false, erro: 'Informe o motivo (mínimo de 5 caracteres).' };
  if (motivo.length > MAX_TRATATIVA) return { ok: false, erro: 'O motivo passa de ' + MAX_TRATATIVA + ' caracteres.' };
  return { ok: true, valores: { motivo } };
}
/** Ao reabrir uma cancelada, volta para a etapa em que estava (se não souber, para o começo). */
function destinoDaReabertura(etapaAntes) {
  const para = ETAPAS.includes(etapaAntes) && etapaAntes !== 'encerrada' ? etapaAntes : 'registrada';
  return { para, status: ETAPA_STATUS[para] };
}

/**
 * Rotas do Qualidade abertas a quem é só gestor ou só analista (acesso_qualidade): registrar ocorrência, ver as próprias, perfil, gestores e,
 * para o gestor, o Portal do Gestor (a rota confere o escopo). Tudo o mais do módulo continua só da equipe do painel.
 */
function rotaAbertaGestorAnalista(metodo, caminho) {
  const m = String(metodo || '').toUpperCase();
  const c = String(caminho || '').split('?')[0].replace(/\/+$/, '') || '/';
  const p = c.split('/');   // '' + segmentos
  if (m === 'GET') return ['/opcoes', '/empresas', '/tempos', '/avisos', '/gestores', '/eu', '/analistas', '/ocorrencias/minhas', '/gestor/ocorrencias', '/analista/ocorrencias', '/sucesso/ocorrencias'].includes(c) || (p.length === 3 && p[1] === 'anexo');
  if (m === 'POST') return c === '/ocorrencias' || (p.length === 4 && p[1] === 'ocorrencias' && p[3] === 'anexo') || (p.length === 5 && p[1] === 'gestor' && p[2] === 'ocorrencias' && ['abrir', 'validar', 'devolver', 'filha', 'cancelar', 'reabrir', 'excluir'].includes(p[4])) || (p.length === 5 && p[1] === 'analista' && p[2] === 'ocorrencias' && ['nota', 'encerrar'].includes(p[4])) || (p.length === 5 && p[1] === 'sucesso' && p[2] === 'ocorrencias' && p[4] === 'encerrar');
  if (m === 'PUT') return p.length === 5 && p[1] === 'gestor' && p[2] === 'ocorrencias' && p[4] === 'tratativa';
  return false;
}

/** O que a pessoa enxerga no Portal do Gestor: a administração vê tudo; gestor/diretor, os departamentos dele (e, no Sucesso do Cliente, o que ficou sem gestor). */
function escopoDoUsuario(user, deptosGestor) {
  const deptos = Array.from(new Set(deptosGestor || []));
  return { todos: !!(user && user.role === 'administrador'), deptos, sucesso: deptos.includes('Sucesso') };
}
function ocorrenciaNoEscopo(esc, reg) {
  if (!esc || !reg) return false;
  if (esc.todos) return true;
  if ((reg.departamentos || []).some((d) => (esc.deptos || []).includes(d))) return true;
  return !!(esc.sucesso && reg.fila === 'sucesso');
}

/** Valida a tratativa que o gestor cria: plano de ação, responsável (analista), departamento que trata, prazo (SLA, o gestor pode mudar) e observação. */
function validarTratativaGestor(corpo, deptoDaOcorrencia, hoje, opts) {
  const b = corpo || {};
  const plano = String(b.plano == null ? '' : b.plano).replace(/\r\n/g, '\n').trim();
  if (plano.length < 5) return { ok: false, erro: 'Descreva o plano de ação (mínimo de 5 caracteres).' };
  if (plano.length > MAX_DETALHE) return { ok: false, erro: 'O plano de ação passa de ' + MAX_DETALHE + ' caracteres.' };
  const analistas_ids = idsResponsaveis(b);   // um ou vários analistas na mesma tratativa
  if (!analistas_ids.length && !(opts && opts.permiteSemResponsavel)) return { ok: false, erro: 'Escolha ao menos um responsável (analista) ou abra ocorrências vinculadas para os analistas.' };
  const analista_id = analistas_ids[0] || null;   // sem responsável próprio só quando a original é conduzida pelas ocorrências vinculadas
  const departamento = DEPARTAMENTOS.find((d) => d === (b.departamento || deptoDaOcorrencia));
  if (!departamento) return { ok: false, erro: 'Escolha o departamento que vai tratar.' };
  const h = hoje || hojeBrasilia();
  const prazo = texto(b.prazo, 10);
  if (!ISO.test(prazo) || isNaN(Date.parse(prazo + 'T12:00:00Z'))) return { ok: false, erro: 'Informe o prazo para execução.' };
  if (prazo < h) return { ok: false, erro: 'O prazo não pode ser uma data que já passou.' };
  if (prazo > somarDias(h, 365)) return { ok: false, erro: 'O prazo passa de um ano: escolha uma data mais próxima.' };
  const obs = String(b.obs == null ? '' : b.obs).replace(/\r\n/g, '\n').trim();
  if (obs.length > MAX_DETALHE) return { ok: false, erro: 'A observação passa de ' + MAX_DETALHE + ' caracteres.' };
  return { ok: true, valores: { plano, analista_id, analistas_ids, departamento, prazo, obs: obs || null } };
}

/** Ocorrência filha (de alinhamento) que o gestor abre a partir da original: assunto, plano, responsáveis (um ou vários), departamento e prazo próprios. */
function validarFilha(corpo, hoje) {
  const b = corpo || {};
  const assunto = texto(b.assunto, 101);
  if (assunto.length < 3) return { ok: false, erro: 'Informe o assunto da ocorrência vinculada (mínimo de 3 caracteres).' };
  if (assunto.length > 100) return { ok: false, erro: 'O assunto passa de 100 caracteres.' };
  const t = validarTratativaGestor(b, null, hoje);   // sem departamento padrão: a filha pode ser de outro departamento
  if (!t.ok) return t;
  // por padrão a filha NÃO aponta a original nem o analista do registro (o reclamado): isso fica só com o gestor, a não ser que ele queira mostrar
  const mostrar_pai = b.mostrar_pai === true || b.mostrar_pai === 'true';
  return { ok: true, valores: Object.assign({ assunto, mostrar_pai }, t.valores) };
}

/**
 * O que o analista pode ver de uma ocorrência: o analista indicado no registro (o reclamado) só aparece para o gestor, para o administrador e para ele mesmo;
 * a filha só mostra de qual ocorrência veio se o gestor quis. Quem trata não fica sabendo quem foi apontado.
 */
function mascararParaAnalista(reg, analistaId, ehLideranca) {
  if (ehLideranca) return reg;
  const r = Object.assign({}, reg);
  const mostra = !!r.mostrar_pai;
  if (!mostra && String(r.analista_origem_id || '') !== String(analistaId || '')) { r.analista_origem_id = null; r.analista_origem_nome = null; }
  if (r.origem === 'filha' && !mostra) { r.pai_id = null; r.pai = null; }
  return r;
}

/** A original só segue para a validação do gestor quando todos os responsáveis encerraram e as ocorrências vinculadas estão encerradas. */
function prontoParaValidacao(resp, filhas) {
  const pendentes = (resp || []).filter((x) => !x.encerrado_em).map((x) => String(x.analista_id));
  const filhasPendentes = (filhas || []).filter((f) => f.etapa !== 'encerrada').length;
  const temAlgo = !!((resp && resp.length) || (filhas && filhas.length));   // a original pode ser conduzida só pelas filhas
  return { pronto: temAlgo && !pendentes.length && !filhasPendentes, pendentes, filhasPendentes };
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
      // tratativa criada pelo gestor (plano de ação, departamento que trata, observação) e a liberação para o analista
      .then(() => pool.query('ALTER TABLE cs_qualidade_registros ADD COLUMN IF NOT EXISTS plano_acao TEXT'))
      .then(() => pool.query('ALTER TABLE cs_qualidade_registros ADD COLUMN IF NOT EXISTS tratativa_depto TEXT'))
      .then(() => pool.query('ALTER TABLE cs_qualidade_registros ADD COLUMN IF NOT EXISTS gestor_obs TEXT'))
      .then(() => pool.query('ALTER TABLE cs_qualidade_registros ADD COLUMN IF NOT EXISTS tratativa_definida_por TEXT'))
      .then(() => pool.query('ALTER TABLE cs_qualidade_registros ADD COLUMN IF NOT EXISTS tratativa_definida_em TIMESTAMPTZ'))
      .then(() => pool.query('ALTER TABLE cs_qualidade_registros ADD COLUMN IF NOT EXISTS liberada_em TIMESTAMPTZ'))
      .then(() => pool.query('ALTER TABLE cs_qualidade_registros ADD COLUMN IF NOT EXISTS liberada_por TEXT'))
      // devolutivas de cada etapa: o analista (nota e observação), a validação do gestor e o encerramento pelo gestor final
      .then(() => pool.query('ALTER TABLE cs_qualidade_registros ADD COLUMN IF NOT EXISTS analista_nota TEXT, ADD COLUMN IF NOT EXISTS analista_obs TEXT, ADD COLUMN IF NOT EXISTS analista_em TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS analista_por TEXT'))
      .then(() => pool.query('ALTER TABLE cs_qualidade_registros ADD COLUMN IF NOT EXISTS validacao_nota TEXT, ADD COLUMN IF NOT EXISTS validacao_obs TEXT, ADD COLUMN IF NOT EXISTS validacao_em TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS validacao_por TEXT'))
      .then(() => pool.query('ALTER TABLE cs_qualidade_registros ADD COLUMN IF NOT EXISTS final_nota TEXT, ADD COLUMN IF NOT EXISTS final_obs TEXT, ADD COLUMN IF NOT EXISTS encerrada_em TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS encerrada_por TEXT'))
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
      .then(() => pool.query("ALTER TABLE analistas ADD COLUMN IF NOT EXISTS departamentos TEXT[] NOT NULL DEFAULT '{}'"))
      // o analista indicado no registro nunca se perde (o gestor pode pôr outros para tratar); filhas = ocorrências de alinhamento (origem 'filha')
      .then(() => pool.query('ALTER TABLE cs_qualidade_registros ADD COLUMN IF NOT EXISTS analista_origem_id TEXT'))
      .then(() => pool.query('ALTER TABLE cs_qualidade_registros ADD COLUMN IF NOT EXISTS pai_id UUID REFERENCES cs_qualidade_registros(id) ON DELETE CASCADE'))
      .then(() => pool.query('ALTER TABLE cs_qualidade_registros ADD COLUMN IF NOT EXISTS etapa_antes TEXT'))   // etapa em que estava ao ser cancelada (para reabrir no mesmo ponto)
      .then(() => pool.query('ALTER TABLE cs_qualidade_registros ADD COLUMN IF NOT EXISTS mostrar_pai BOOLEAN NOT NULL DEFAULT false'))   // filha: o gestor escolheu mostrar a origem (e o analista do registro) a quem vai tratar
      .then(() => pool.query(`CREATE TABLE IF NOT EXISTS cs_qualidade_resp (
        registro_id UUID NOT NULL REFERENCES cs_qualidade_registros(id) ON DELETE CASCADE, analista_id TEXT NOT NULL,
        nota TEXT, obs TEXT, encerrado_em TIMESTAMPTZ, encerrado_por TEXT, PRIMARY KEY (registro_id, analista_id))`))
      .then(() => pool.query('ALTER TABLE cs_qualidade_resp ENABLE ROW LEVEL SECURITY'))   // departamentos que o analista atende (18/10/2026)
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

const COLUNAS = `r.id, r.cliente_id, r.cnpj, r.cliente_nome, r.tipo, r.departamentos, r.detalhe, r.analista_id, a.nome AS analista_nome, r.analista_origem_id, ao.nome AS analista_origem_nome, r.pai_id, r.mostrar_pai,
       to_char(r.prazo, 'YYYY-MM-DD') AS prazo, r.status, r.origem, r.etapa, r.fila, r.plano_acao, r.tratativa_depto, r.gestor_obs, r.tratativa_definida_por, r.tratativa_definida_em, r.liberada_em, r.liberada_por, r.analista_nota, r.analista_obs, r.analista_em, r.analista_por, r.validacao_nota, r.validacao_obs, r.validacao_em, r.validacao_por, r.final_nota, r.final_obs, r.encerrada_em, r.encerrada_por, r.assunto, r.prioridade, r.criado_por, r.criado_em, r.resolvido_em, r.resolvido_por, r.tratativa, r.validado_em, r.validado_por`;
const DE = `FROM cs_qualidade_registros r LEFT JOIN analistas a ON a.id::text = r.analista_id LEFT JOIN analistas ao ON ao.id::text = r.analista_origem_id`;
const comSituacao = (rows) => rows.map((r) => ({ ...r, situacao: situacao(r.status, r.prazo), status_rotulo: ROTULO_STATUS[r.status] }));

/** Anexa a cada registro a linha do tempo de notas e eventos (nota, iniciada, finalizada, devolvida, validada). */
async function anexarNotas(lista) {
  if (!lista.length) return lista;
  try {
    const { rows } = await pool.query(
      `SELECT registro_id, em, por, acao, texto FROM cs_qualidade_historico WHERE registro_id = ANY($1::uuid[]) AND acao IN ('nota', 'iniciada', 'finalizada', 'devolvida', 'validada', 'liberada', 'analista_encerrou', 'gestor_validou', 'encerrada', 'cancelada', 'reaberta') ORDER BY em ASC`,
      [lista.map((r) => r.id)]);
    const por = {}; rows.forEach((h) => { (por[h.registro_id] = por[h.registro_id] || []).push({ em: h.em, por: h.por, acao: h.acao, texto: h.texto }); });
    return lista.map((r) => ({ ...r, notas: por[r.id] || [] }));
  } catch (e) { return lista.map((r) => ({ ...r, notas: [] })); }
}

/**
 * Anexa a cada ocorrência: os responsáveis (um ou vários, cada um com a sua devolutiva), as ocorrências vinculadas (filhas) e, na filha, a original.
 * Registros anteriores a esta versão têm um responsável só: ele aparece com a devolutiva que já deixou.
 */
async function anexarVinculos(lista) {
  if (!lista.length) return lista;
  const ids = lista.map((r) => r.id);
  let resp = [], filhas = [], pais = [];
  try {
    resp = (await pool.query(`SELECT x.registro_id, x.analista_id, a.nome, x.nota, x.obs, x.encerrado_em, x.encerrado_por FROM cs_qualidade_resp x LEFT JOIN analistas a ON a.id::text = x.analista_id WHERE x.registro_id = ANY($1::uuid[]) ORDER BY a.nome`, [ids])).rows;
    filhas = (await pool.query(`SELECT f.id, f.pai_id, f.assunto, f.etapa, f.departamentos, to_char(f.prazo, 'YYYY-MM-DD') AS prazo, a.nome AS analista_nome FROM cs_qualidade_registros f LEFT JOIN analistas a ON a.id::text = f.analista_id WHERE f.pai_id = ANY($1::uuid[]) AND f.status <> 'cancelado' ORDER BY f.criado_em`, [ids])).rows;
    const paiIds = lista.map((r) => r.pai_id).filter(Boolean);
    if (paiIds.length) pais = (await pool.query('SELECT id, assunto, cliente_nome FROM cs_qualidade_registros WHERE id = ANY($1::uuid[])', [paiIds])).rows;
  } catch (e) { /* sem as tabelas novas ainda: segue sem os vínculos */ }
  const porResp = {}, porFilha = {};
  resp.forEach((x) => { (porResp[String(x.registro_id)] = porResp[String(x.registro_id)] || []).push({ analista_id: String(x.analista_id), nome: x.nome, nota: x.nota, obs: x.obs, encerrado_em: x.encerrado_em, encerrado_por: x.encerrado_por }); });
  filhas.forEach((f) => { (porFilha[String(f.pai_id)] = porFilha[String(f.pai_id)] || []).push({ id: f.id, assunto: f.assunto, etapa: f.etapa, departamentos: f.departamentos, prazo: f.prazo, analista_nome: f.analista_nome }); });
  const depois = ['validacao_gestor', 'devolutiva_cliente', 'encerrada'];
  return lista.map((r) => {
    let rs = porResp[String(r.id)] || [];
    if (!rs.length && r.analista_id) rs = [{ analista_id: String(r.analista_id), nome: r.analista_nome, nota: r.analista_nota || null, obs: r.analista_obs || null, encerrado_em: depois.includes(r.etapa) ? (r.analista_em || null) : null, encerrado_por: r.analista_por || null }];
    const pai = r.pai_id ? pais.find((p) => String(p.id) === String(r.pai_id)) : null;
    return { ...r, responsaveis: rs, filhas: porFilha[String(r.id)] || [], pai: pai ? { id: pai.id, assunto: pai.assunto, cliente_nome: pai.cliente_nome } : null };
  });
}
/** Lista completa para a tela: situação, notas, anexos, responsáveis e vínculos. */
async function completar(linhas) { const base = comSituacao(linhas); return anexarVinculos(await anexarAnexos(await anexarNotas(base))); }

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
router.use(require('./auditoria').middleware());   // anota nos Logs de atividades toda ação que muda algo e deu certo
function soQualidadeGeral(req, res, next) {
  if (podeEquipe(req.user)) return next();
  const u = req.user || {};
  if ((u.acessoGestor || u.acessoQualidade) && rotaAbertaGestorAnalista(req.method, req.path)) return next();
  return res.status(403).json({ error: 'Acesso restrito à equipe do Sucesso do Cliente.' });
}
router.use(requireAuth, soQualidadeGeral);

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

/** Departamentos que o analista atende (administrador). Servem para sugerir o responsável certo e avisar quando o escolhido não é do departamento. */
router.put('/analistas/:id/departamentos', async (req, res) => {
  if (!req.user || req.user.role !== 'administrador') return res.status(403).json({ error: 'Só o administrador define os departamentos do analista.' });
  const v = validarDepartamentosAnalista(req.body);
  if (!v.ok) return res.status(400).json({ error: v.erro });
  try {
    await garantirSchema();
    const up = await pool.query('UPDATE analistas SET departamentos = $1 WHERE id::text = $2 RETURNING id, nome, departamentos', [v.valores.departamentos, String(req.params.id)]);
    if (!up.rows.length) return res.status(404).json({ error: 'Analista não encontrado.' });
    res.json({ analista: up.rows[0] });
  } catch (e) { console.error('[qualidade] PUT /analistas/:id/departamentos falhou:', e); res.status(500).json({ error: 'Erro ao salvar os departamentos.' }); }
});
router.get('/analistas', async (req, res) => {
  try {
    await garantirSchema();
    const { rows } = await pool.query('SELECT id, nome, ativo, user_id, departamentos FROM analistas ORDER BY nome');
    const so = req.query.ativo === 'true';
    res.json({ analistas: rows.filter((a) => !so || a.ativo) });
  } catch (e) { console.error('[qualidade] GET /analistas falhou:', e); res.status(500).json({ error: 'Erro ao ler os analistas.' }); }
});

router.get('/cliente/:clienteId', async (req, res) => {
  try {
    await garantirSchema();
    const { rows } = await pool.query(`SELECT ${COLUNAS} ${DE} WHERE r.cliente_id = $1 ORDER BY r.criado_em DESC LIMIT 100`, [String(req.params.clienteId)]);
    res.json({ registros: await completar(rows) });
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

router.get('/analista/:id', async (req, res, next) => {
  if (req.params.id === 'ocorrencias') return next();   // é a rota do Portal do Analista (mais abaixo), não o id de um analista
  try {
    await garantirSchema();
    const a = await pool.query('SELECT id, nome, ativo, user_id FROM analistas WHERE id::text = $1', [String(req.params.id)]);
    if (!a.rows.length) return res.status(404).json({ error: 'Analista não encontrado.' });
    const { rows } = await pool.query(`SELECT ${COLUNAS} ${DE} WHERE r.analista_id = $1 ORDER BY r.criado_em DESC LIMIT 300`, [String(req.params.id)]);
    res.json({ analista: a.rows[0], registros: await anexarNotas(comSituacao(rows)) });
  } catch (e) { console.error('[qualidade] GET /analista falhou:', e); res.status(500).json({ error: 'Erro ao ler os registros do analista.' }); }
});

/** Gestores por departamento (a equipe vê quem é; só o administrador cadastra). O administrador também recebe a lista de pessoas para escolher. */
/** Nome completo de um login: o do analista ligado a ele, o do colaborador da Gamificação, o igual sem acento, ou o único analista que começa com o nome do login (ex.: "Josiane" → "Josiane Silva"). Sem par, fica o nome do login. */
function nomeCompletoDoLogin(user, analistas, colabs) {
  const id = String(user.id), nome = String(user.name || '').trim();
  const doAnalista = (analistas || []).find((a) => a.user_id != null && String(a.user_id) === id);
  if (doAnalista && doAnalista.nome) return String(doAnalista.nome).trim();
  const colab = (colabs || []).find((c) => c.user_id != null && String(c.user_id) === id);
  const livres = (analistas || []).filter((a) => a.user_id == null || String(a.user_id) === id);
  // tenta o nome do login e o do colaborador da Gamificação (muitas vezes só o primeiro nome) contra a lista de analistas
  for (const cand of [nome, colab && colab.nome]) {
    const alvo = semAcento(cand);
    if (!alvo) continue;
    const igual = livres.find((a) => semAcento(a.nome) === alvo);
    if (igual) return String(igual.nome).trim();
    const comecam = livres.filter((a) => semAcento(a.nome).startsWith(alvo + ' '));
    if (comecam.length === 1) return String(comecam[0].nome).trim();
  }
  // sem analista correspondente: o nome mais completo entre o do login e o do colaborador
  const cn = colab && colab.nome ? String(colab.nome).trim() : '';
  return cn.length > nome.length ? cn : nome;
}
/** Quem pode ser escolhido como gestor: a lista de analistas ativos (nome completo), cada um com o login vinculado (direto ou pelo nome); sem login não dá para ser gestor. Administradores sem analista correspondente entram também (diretor, gestor final). */
// Logins compartilhados/de sistema que não são pessoas: nunca aparecem nas escolhas de gestor (nem como administrador).
const LOGINS_OCULTOS = ['escritorial cs'];
const ehLoginOculto = (nome) => LOGINS_OCULTOS.includes(semAcento(nome));
function pessoasParaGestor(analistas, users, colabs) {
  const ativos = (analistas || []).filter((a) => a.ativo !== false && a.ativo !== 0 && !ehLoginOculto(a.nome));
  const logins = (users || []).filter((x) => !ehLoginOculto(x.name));
  const usados = new Set();
  const lista = ativos.map((a) => {
    let u = a.user_id != null ? logins.find((x) => String(x.id) === String(a.user_id)) : null;
    if (!u) {
      const alvo = semAcento(a.nome);
      const par = logins.filter((x) => !usados.has(String(x.id)) && semAcento(nomeCompletoDoLogin(x, analistas, colabs)) === alvo);
      if (par.length === 1) u = par[0];
    }
    if (u) usados.add(String(u.id));
    return { id: u ? String(u.id) : '', name: String(a.nome).trim(), sem_login: !u, analista_id: a.id != null ? String(a.id) : null, ja_ligado: !!(u && a.user_id != null && String(a.user_id) === String(u.id)) };
  });
  logins.filter((x) => x.role === 'administrador' && !usados.has(String(x.id))).forEach((x) => lista.push({ id: String(x.id), name: nomeCompletoDoLogin(x, analistas, colabs), sem_login: false, admin: true }));
  return lista.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
}
async function nomesCompletos() {
  const analistas = (await pool.query('SELECT nome, user_id FROM analistas')).rows;
  const colabs = await pool.query('SELECT nome, user_id FROM gam_colaboradores').then((r) => r.rows).catch(() => []);
  return (user) => nomeCompletoDoLogin(user, analistas, colabs);
}
router.get('/gestores', async (req, res) => {
  try {
    await garantirSchema();
    const completo = await nomesCompletos();
    const { rows: brutas } = await pool.query(`SELECT g.id, g.user_id, g.departamento, g.papel, u.id::text AS uid, u.name, u.email FROM cs_qualidade_gestores g JOIN users u ON u.id::text = g.user_id WHERE u.active = 1`);
    const rows = brutas.map((g) => Object.assign(g, { name: completo({ id: g.uid, name: g.name }) })).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
    const departamentos = DEPARTAMENTOS.map((d) => ({ codigo: d, rotulo: rotuloDepto(d), gestores: rows.filter((g) => g.departamento === d).map((g) => ({ id: g.id, user_id: g.user_id, nome: g.name, email: g.email, papel: g.papel })) }));
    const resp = { departamentos };
    if (req.user.role === 'administrador') {
      const analistas = (await pool.query('SELECT id, nome, user_id, ativo FROM analistas')).rows;
      const colabs = await pool.query('SELECT nome, user_id FROM gam_colaboradores').then((r) => r.rows).catch(() => []);
      const users = (await pool.query('SELECT id::text AS id, name, email, role FROM users WHERE active = 1')).rows;
      resp.usuarios = pessoasParaGestor(analistas, users, colabs);
    }
    res.json(resp);
  } catch (e) { console.error('[qualidade] GET /gestores falhou:', e); res.status(500).json({ error: 'Erro ao ler os gestores.' }); }
});
/** Liga de uma vez cada analista sem login ao login que casa com o nome (só os casos sem dúvida; os outros ficam para escolher à mão). */
router.post('/vinculos/automatico', async (req, res) => {
  if (!req.user || req.user.role !== 'administrador') return res.status(403).json({ error: 'Só o administrador liga o analista a um login.' });
  try {
    await garantirSchema();
    const analistas = (await pool.query('SELECT id, nome, user_id, ativo FROM analistas')).rows;
    const colabs = await pool.query('SELECT nome, user_id FROM gam_colaboradores').then((r) => r.rows).catch(() => []);
    const users = (await pool.query('SELECT id::text AS id, name, email, role FROM users WHERE active = 1')).rows;
    const pessoas = pessoasParaGestor(analistas, users, colabs);
    const ligados = [];
    for (const p of pessoas.filter((x) => x.analista_id && x.id && !x.sem_login && !x.ja_ligado)) {
      const up = await pool.query('UPDATE analistas SET user_id = $1 WHERE id::text = $2 AND user_id IS NULL RETURNING nome', [p.id, p.analista_id]);
      if (up.rows.length) ligados.push(up.rows[0].nome);
    }
    res.json({ ok: true, ligados, sem_par: pessoas.filter((x) => x.sem_login).map((x) => x.name) });
  } catch (e) { console.error('[qualidade] POST /vinculos/automatico falhou:', e); res.status(500).json({ error: 'Erro ao ligar os logins.' }); }
});
router.post('/gestores', async (req, res) => {
  if (!req.user || req.user.role !== 'administrador') return res.status(403).json({ error: 'Só o administrador cadastra gestores.' });
  const v = validarGestor(req.body);
  if (!v.ok) return res.status(400).json({ error: v.erro });
  try {
    await garantirSchema();
    const u = (await pool.query('SELECT id::text AS id, name FROM users WHERE id::text = $1 AND active = 1', [v.valores.user_id])).rows[0];
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

/**
 * Avisos para o navegador (notificação + som) de ocorrências NOVAS desde o ponto informado em ?desde= (o "agora" devolvido na chamada anterior).
 * A primeira chamada, sem desde, só devolve o ponto de partida. Não vai além das últimas 24 horas.
 */
router.get('/avisos', async (req, res) => {
  try {
    await garantirSchema();
    const agora = (await pool.query('SELECT NOW() AS t')).rows[0].t.toISOString();
    const d = Date.parse(req.query.desde || '');
    if (!Number.isFinite(d)) return res.json({ agora, itens: [] });
    const desde = new Date(Math.max(d, Date.now() - 24 * 3600 * 1000)).toISOString();
    const meus = (await pool.query('SELECT departamento FROM cs_qualidade_gestores WHERE user_id = $1', [String(req.user.id)])).rows.map((g) => g.departamento);
    const { rows } = await pool.query(
      `SELECT r.id, r.cliente_nome, r.tipo, r.prioridade, r.assunto, r.departamentos, r.fila, r.criado_por_id, r.criado_em
         FROM cs_qualidade_registros r WHERE r.origem = 'modulo' AND r.status <> 'cancelado' AND r.criado_em > $1 ORDER BY r.criado_em`, [desde]);
    const itens = rows.filter((r) => deveAvisar(req.user, r, meus)).map((r) => ({
      id: r.id, em: r.criado_em, titulo: 'Nova ocorrência: ' + r.tipo + ' (' + (r.prioridade || '—') + ')',
      texto: (r.cliente_nome || 'Empresa') + ' — ' + (r.assunto || '') + ' · ' + rotuloDepto((r.departamentos || [])[0]),
    }));
    res.json({ agora, itens });
  } catch (e) { console.error('[qualidade] GET /avisos falhou:', e); res.status(500).json({ error: 'Erro ao ler os avisos.' }); }
});

/** Quem recebe cada aviso push (as listas saem do cadastro de gestores e de usuários; nenhuma falha aqui derruba a ação). */
async function idsAdmins() { return (await pool.query("SELECT id::text AS id FROM users WHERE role = 'administrador' AND active = 1")).rows.map((r) => r.id); }
async function idsGestoresDe(departamentos) {
  return (await pool.query("SELECT g.user_id FROM cs_qualidade_gestores g JOIN users u ON u.id::text = g.user_id WHERE g.departamento = ANY($1::text[]) AND g.papel = 'gestor' AND u.active = 1", [departamentos || []])).rows.map((r) => r.user_id);
}
async function idsSucesso() {
  return (await pool.query("SELECT g.user_id FROM cs_qualidade_gestores g JOIN users u ON u.id::text = g.user_id WHERE (g.departamento = 'Sucesso' OR g.papel = 'final') AND u.active = 1")).rows.map((r) => r.user_id);
}
async function idsDoAnalista(analistaId) {
  const a = (await pool.query('SELECT nome, user_id FROM analistas WHERE id::text = $1', [String(analistaId)])).rows[0];
  if (!a) return [];
  if (a.user_id) return [a.user_id];
  return (await pool.query('SELECT id::text AS id, name FROM users WHERE active = 1')).rows.filter((u) => mesmoNome(u.name, a.nome)).map((u) => u.id);
}
/** O risco da carteira (Sinais de atenção, termômetro Tratativas) depende das ocorrências: pede para recalcular na próxima leitura. */
function refrescarRisco() { try { require('./painel').invalidarCache(); } catch (e) { /* o cálculo expira sozinho em poucos minutos */ } }
const curtoTexto = (t, n) => { const x = String(t || '').split(/\s+/).join(' ').trim(); return x.length <= n ? x : x.slice(0, n) + '…'; };
const idsDaFila = (reg) => (reg.fila === 'sucesso' ? idsSucesso() : idsGestoresDe(reg.departamentos));
/** Dispara o push sem esperar (e sem nunca lançar erro): buscarIds devolve as pessoas; quem fez a ação não é avisado. */
async function avisarPush(buscarIds, aviso, atorId) {
  try { await push.enviar(push.destinatarios([await buscarIds()], atorId), aviso); }
  catch (e) { console.warn('[qualidade] push não enviado:', e && e.message); }
}
/** Analistas responsáveis pela ocorrência (um ou vários); em registros antigos, só o analista_id. */
async function idsRespDe(regId, fallback) {
  const rs = regId ? (await pool.query('SELECT analista_id FROM cs_qualidade_resp WHERE registro_id = $1', [regId])).rows.map((r) => String(r.analista_id)) : [];
  return rs.length ? rs : (fallback ? [String(fallback)] : []);
}
/** Logins (users) de todos os responsáveis, para avisar cada um. */
async function idsDosResponsaveis(regId, fallback) {
  const out = [];
  for (const a of await idsRespDe(regId, fallback)) out.push(...(await idsDoAnalista(a)));
  return out;
}
/** Se todos os responsáveis encerraram e as ocorrências vinculadas estão encerradas, a original segue para a validação do gestor. */
async function tentarAvancarParaValidacao(regId, por, analistaNome, atorId) {
  const r = (await pool.query('SELECT id, etapa, departamentos, fila, assunto, cliente_nome, tipo, origem, pai_id FROM cs_qualidade_registros WHERE id = $1', [regId])).rows[0];
  if (!r || r.etapa !== 'com_analista') return { avancou: false, pendentes: [], filhasPendentes: 0 };
  const resp = (await pool.query('SELECT x.analista_id, a.nome, x.encerrado_em FROM cs_qualidade_resp x LEFT JOIN analistas a ON a.id::text = x.analista_id WHERE x.registro_id = $1', [regId])).rows;
  const filhas = (await pool.query("SELECT etapa FROM cs_qualidade_registros WHERE pai_id = $1 AND status <> 'cancelado'", [regId])).rows;
  const p = prontoParaValidacao(resp, filhas);
  const pendentes = resp.filter((x) => !x.encerrado_em).map((x) => x.nome || x.analista_id);
  if (!p.pronto) return { avancou: false, pendentes, filhasPendentes: p.filhasPendentes };
  if (r.origem === 'filha') {   // ocorrência vinculada: quando todos os responsáveis encerram, ela está encerrada; a original passa a poder seguir
    const upEtapa1 = await pool.query("UPDATE cs_qualidade_registros SET etapa = 'encerrada', status = $1, resolvido_em = NOW(), resolvido_por = $2, encerrada_em = NOW(), encerrada_por = $2, atualizado_em = NOW() WHERE id = $3 AND etapa = 'com_analista'", [ETAPA_STATUS.encerrada, por || null, regId]);
    if (!upEtapa1.rowCount) return { avancou: false, pendentes: [], filhasPendentes: 0 };   // outra chamada ao mesmo tempo já fez
    await registrar(regId, por || 'Sistema', 'nota', 'Todos os responsáveis encerraram: ocorrência vinculada encerrada.');
    if (r.pai_id) {
      await registrar(r.pai_id, por || 'Sistema', 'nota', 'Ocorrência vinculada encerrada: ' + (r.assunto || ''));
      await tentarAvancarParaValidacao(r.pai_id, por, null, atorId);
    }
    return { avancou: true, pendentes: [], filhasPendentes: 0 };
  }
  const t = transicao('analista_encerrar', r.etapa);
  const upEtapa2 = await pool.query("UPDATE cs_qualidade_registros SET etapa = $1, status = $2, resolvido_em = NOW(), resolvido_por = $3, atualizado_em = NOW() WHERE id = $4 AND etapa = 'com_analista'", [t.para, t.status, por || null, regId]);
    if (!upEtapa2.rowCount) return { avancou: false, pendentes: [], filhasPendentes: 0 };   // outra chamada ao mesmo tempo já fez
  await registrar(regId, por || 'Sistema', 'nota', 'Todos os responsáveis encerraram' + (filhas.length ? ' e as ocorrências vinculadas estão encerradas' : '') + ': segue para a validação do gestor.');
  await notificarFinalizacao(r, analistaNome || 'Os analistas', 'Tratativa encerrada pelos responsáveis');
  avisarPush(() => idsDaFila(r), { titulo: 'Tratativa para validar', texto: (r.cliente_nome || 'Empresa') + ' — ' + (r.assunto || ''), url: '/cs?aba=gestor', tag: 'val-' + regId }, atorId);
  return { avancou: true, pendentes: [], filhasPendentes: 0 };
}
async function ehGestorFinal(userId) {
  return (await pool.query("SELECT 1 FROM cs_qualidade_gestores WHERE user_id = $1 AND papel = 'final' LIMIT 1", [String(userId)])).rows.length > 0;
}
async function carregarOcorrencia(id, campos) {
  return (await pool.query('SELECT ' + campos + " FROM cs_qualidade_registros WHERE id::text = $1 AND origem IN ('modulo', 'filha')", [String(id)])).rows[0] || null;
}
async function registroCompleto(id) {
  const { rows } = await pool.query(`SELECT ${COLUNAS} ${DE} WHERE r.id = $1`, [id]);
  return (await completar(rows))[0];
}

/** Escopo da pessoa logada no Portal do Gestor (os departamentos em que ela é gestor/diretor/gestor final). */
async function escopoDaRequisicao(req) {
  const meus = (await pool.query('SELECT departamento FROM cs_qualidade_gestores WHERE user_id = $1', [String(req.user.id)])).rows.map((g) => g.departamento);
  return escopoDoUsuario(req.user, meus);
}

/** Perfil da pessoa no módulo: o que ela é (gestor, analista) e de quais departamentos. A tela usa para mostrar só os módulos dela; quem decide é o servidor, em cada rota. */
router.get('/eu', async (req, res) => {
  try {
    await garantirSchema();
    const g = (await pool.query('SELECT departamento, papel FROM cs_qualidade_gestores WHERE user_id = $1', [String(req.user.id)])).rows;
    const an = await analistaDoLogin(req.user).catch(() => null);
    res.json({ nome: req.user.name, papel: req.user.role, completo: podeEquipe(req.user), gestor: g.length > 0, departamentos: g.map((x) => x.departamento), papeis: g.map((x) => x.papel),
      analista: !!(req.user.acessoQualidade || an), analista_id: an ? an.id : null,
      final: g.some((x) => x.papel === 'final'), sucesso: g.some((x) => x.departamento === 'Sucesso' || x.papel === 'final'),
      modulos: acessos.modulosEfetivos({ admin: req.user.role === 'administrador', equipe: podeEquipe(req.user), gestor: g.length > 0 || !!req.user.acessoGestor, analista: !!(req.user.acessoQualidade || an), sucesso: g.some((x) => x.departamento === 'Sucesso' || x.papel === 'final') }, await acessos.lerConfig(req.user.id)),
      modulos_definidos: Array.isArray(await acessos.lerConfig(req.user.id)) });
  } catch (e) { console.error('[qualidade] GET /eu falhou:', e); res.status(500).json({ error: 'Erro ao ler o perfil.' }); }
});

/** As ocorrências que a própria pessoa registrou (com etapa, status e para onde foram). */
router.get('/ocorrencias/minhas', async (req, res) => {
  try {
    await garantirSchema();
    const { rows } = await pool.query(`SELECT ${COLUNAS} ${DE} WHERE r.origem = 'modulo' AND r.criado_por_id = $1 ORDER BY r.criado_em DESC LIMIT 100`, [String(req.user.id)]);
    res.json({ registros: await anexarAnexos(comSituacao(rows)) });
  } catch (e) { console.error('[qualidade] GET /ocorrencias/minhas falhou:', e); res.status(500).json({ error: 'Erro ao ler as suas ocorrências.' }); }
});

/** PORTAL DO GESTOR: as ocorrências do escopo da pessoa (administração: todas), com anexos e andamento. */
router.get('/gestor/ocorrencias', async (req, res) => {
  try {
    await garantirSchema();
    const esc = await escopoDaRequisicao(req);
    if (!esc.todos && !esc.deptos.length) return res.status(403).json({ error: 'Você não é gestor de nenhum departamento. A administração cadastra os gestores em Qualidade > Gerenciar gestores.' });
    const vals = []; let filtro = '';
    if (!esc.todos) { vals.push(esc.deptos); filtro = ` AND (r.departamentos && $1::text[]${esc.sucesso ? " OR r.fila = 'sucesso'" : ''})`; }
    const { rows } = await pool.query(`SELECT ${COLUNAS} ${DE} WHERE r.origem IN ('modulo', 'filha')${filtro} ORDER BY r.criado_em DESC LIMIT 500`, vals);
    res.json({ escopo: esc, registros: await completar(rows) });
  } catch (e) { console.error('[qualidade] GET /gestor/ocorrencias falhou:', e); res.status(500).json({ error: 'Erro ao ler as ocorrências do gestor.' }); }
});

/** O gestor cria (ou edita, enquanto não abriu para o analista) a tratativa: plano de ação, responsável, departamento e prazo. */
router.put('/gestor/ocorrencias/:id/tratativa', async (req, res) => {
  try {
    await garantirSchema();
    const esc = await escopoDaRequisicao(req);
    const reg = (await pool.query("SELECT id, etapa, origem, departamentos, fila FROM cs_qualidade_registros WHERE id::text = $1", [String(req.params.id)])).rows[0];
    if (!reg || reg.origem !== 'modulo') return res.status(404).json({ error: 'Ocorrência não encontrada.' });
    if (!ocorrenciaNoEscopo(esc, reg)) return res.status(403).json({ error: 'Esta ocorrência não é do seu departamento.' });
    if (!['registrada', 'tratativa_definida'].includes(reg.etapa)) return res.status(409).json({ error: 'A tratativa já foi aberta para o analista: não dá mais para editar por aqui.' });
    const nFilhas = (await pool.query("SELECT COUNT(*)::int AS n FROM cs_qualidade_registros WHERE pai_id = $1 AND status <> 'cancelado'", [reg.id])).rows[0].n;
    const v = validarTratativaGestor(req.body, (reg.departamentos || [])[0], undefined, { permiteSemResponsavel: nFilhas > 0 });
    if (!v.ok) return res.status(400).json({ error: v.erro });
    const x = v.valores;
    const ans = x.analistas_ids.length ? (await pool.query('SELECT id, nome, ativo FROM analistas WHERE id::text = ANY($1::text[])', [x.analistas_ids])).rows : [];
    if (ans.length !== x.analistas_ids.length) return res.status(404).json({ error: 'Responsável não encontrado na lista de analistas.' });
    const inativo = ans.find((a) => !a.ativo);
    if (inativo) return res.status(400).json({ error: inativo.nome + ' está desativado na lista de analistas.' });
    const nomes = x.analistas_ids.map((id) => (ans.find((a) => String(a.id) === String(id)) || {}).nome);
    const upEtapa3 = await pool.query(
      `UPDATE cs_qualidade_registros SET plano_acao = $1, analista_id = $2, tratativa_depto = $3, prazo = $4, gestor_obs = $5, etapa = 'tratativa_definida',
         tratativa_definida_por = $6, tratativa_definida_em = NOW(), atualizado_em = NOW() WHERE id = $7 AND etapa IN ('registrada', 'tratativa_definida')`,
      [x.plano, x.analistas_ids.length ? String(x.analistas_ids[0]) : null, x.departamento, x.prazo, x.obs, req.user.name || null, reg.id]);
    if (!upEtapa3.rowCount) return res.status(409).json({ error: JA_MUDOU });
    await pool.query('DELETE FROM cs_qualidade_resp WHERE registro_id = $1 AND analista_id <> ALL($2::text[])', [reg.id, x.analistas_ids]);
    for (const aid of x.analistas_ids) await pool.query('INSERT INTO cs_qualidade_resp (registro_id, analista_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [reg.id, String(aid)]);
    await registrar(reg.id, req.user.name, 'tratativa_definida', (nomes.length ? 'Responsáve' + (nomes.length > 1 ? 'is: ' : 'l: ') + nomes.join(', ') : 'Conduzida pelas ocorrências vinculadas') + ' · ' + x.departamento + ' · prazo ' + x.prazo);
    const { rows } = await pool.query(`SELECT ${COLUNAS} ${DE} WHERE r.id = $1`, [reg.id]);
    res.json({ registro: (await completar(rows))[0] });
  } catch (e) { console.error('[qualidade] PUT tratativa falhou:', e); res.status(500).json({ error: 'Erro ao salvar a tratativa.' }); }
});

/**
 * O gestor abre uma OCORRÊNCIA FILHA (de alinhamento) a partir da original: uma por situação, com assunto, plano, responsáveis, departamento e prazo próprios
 * (pode ser de outro departamento). Já nasce com os analistas; o gestor do departamento dela valida; ao encerrar, libera a original. Não pesa no risco (só a original pesa).
 */
router.post('/gestor/ocorrencias/:id/filha', async (req, res) => {
  try {
    await garantirSchema();
    const esc = await escopoDaRequisicao(req);
    const pai = (await pool.query('SELECT id, etapa, origem, departamentos, fila, cliente_id, cnpj, cliente_nome, tipo, prioridade, assunto, analista_origem_id FROM cs_qualidade_registros WHERE id::text = $1', [String(req.params.id)])).rows[0];
    if (!pai) return res.status(404).json({ error: 'Ocorrência não encontrada.' });
    if (pai.origem === 'filha') return res.status(400).json({ error: 'Só a ocorrência original recebe ocorrências vinculadas.' });
    if (pai.origem !== 'modulo') return res.status(404).json({ error: 'Ocorrência não encontrada.' });
    if (!ocorrenciaNoEscopo(esc, pai)) return res.status(403).json({ error: 'Esta ocorrência não é do seu departamento.' });
    if (!['registrada', 'tratativa_definida', 'com_analista'].includes(pai.etapa)) return res.status(409).json({ error: 'A ocorrência já está na validação ou na devolutiva: não dá mais para vincular outra.' });
    const v = validarFilha(req.body);
    if (!v.ok) return res.status(400).json({ error: v.erro });
    const x = v.valores;
    const ans = (await pool.query('SELECT id, nome, ativo FROM analistas WHERE id::text = ANY($1::text[])', [x.analistas_ids])).rows;
    if (ans.length !== x.analistas_ids.length) return res.status(404).json({ error: 'Responsável não encontrado na lista de analistas.' });
    const inativo = ans.find((a) => !a.ativo);
    if (inativo) return res.status(400).json({ error: inativo.nome + ' está desativado na lista de analistas.' });
    const nomes = x.analistas_ids.map((id) => (ans.find((a) => String(a.id) === String(id)) || {}).nome);
    const gest = (await pool.query(
      `SELECT g.papel, u.name FROM cs_qualidade_gestores g JOIN users u ON u.id::text = g.user_id WHERE g.departamento = $1 AND u.active = 1 ORDER BY u.name`, [x.departamento])).rows;
    const dest = destinoDaOcorrencia(x.departamento, gest);
    const ins = await pool.query(
      `INSERT INTO cs_qualidade_registros (cliente_id, cnpj, cliente_nome, tipo, departamentos, detalhe, assunto, prioridade, prazo, origem, fila, criado_por, criado_por_id,
         pai_id, etapa, status, plano_acao, tratativa_depto, gestor_obs, tratativa_definida_por, tratativa_definida_em, liberada_em, liberada_por, analista_id, mostrar_pai, analista_origem_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'filha', $10, $11, $12, $13, 'com_analista', 'em_tratamento', $6, $14, $15, $11, NOW(), NOW(), $11, $16, $17, $18) RETURNING id`,
      [pai.cliente_id, pai.cnpj, pai.cliente_nome, pai.tipo, [x.departamento], x.plano, x.assunto, pai.prioridade, x.prazo, dest.fila, req.user.name || null, req.user.id || null,
        pai.id, x.departamento, x.obs, String(x.analistas_ids[0]), x.mostrar_pai, x.mostrar_pai ? (pai.analista_origem_id || null) : null]);
    for (const aid of x.analistas_ids) await pool.query('INSERT INTO cs_qualidade_resp (registro_id, analista_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [ins.rows[0].id, String(aid)]);
    await registrar(ins.rows[0].id, req.user.name, 'criado', 'Ocorrência vinculada a "' + (pai.assunto || '') + '" · ' + nomes.join(', ') + ' · prazo ' + x.prazo);
    await registrar(pai.id, req.user.name, 'nota', 'Abriu a ocorrência vinculada "' + x.assunto + '" para ' + nomes.join(', ') + ' (prazo ' + x.prazo.split('-').reverse().join('/') + ')');
    avisarPush(() => idsDosResponsaveis(ins.rows[0].id, null), { titulo: 'Ocorrência aberta para você', texto: (pai.cliente_nome || 'Empresa') + ' — ' + x.assunto + ' · prazo ' + x.prazo.split('-').reverse().join('/'), url: '/cs?aba=analista', tag: 'fil-' + ins.rows[0].id }, req.user.id);
    res.status(201).json({ registro: await registroCompleto(ins.rows[0].id), original: await registroCompleto(pai.id) });
  } catch (e) { console.error('[qualidade] POST filha falhou:', e); res.status(500).json({ error: 'Erro ao abrir a ocorrência vinculada.' }); }
});

/** O gestor abre a ocorrência para o analista responsável (a partir daqui o analista trata; o risco passa a contar "em tratamento"). */
router.post('/gestor/ocorrencias/:id/abrir', async (req, res) => {
  try {
    await garantirSchema();
    const esc = await escopoDaRequisicao(req);
    const reg = (await pool.query("SELECT id, etapa, origem, departamentos, fila, plano_acao, analista_id, prazo, assunto, cliente_nome FROM cs_qualidade_registros WHERE id::text = $1", [String(req.params.id)])).rows[0];
    if (!reg || reg.origem !== 'modulo') return res.status(404).json({ error: 'Ocorrência não encontrada.' });
    if (!ocorrenciaNoEscopo(esc, reg)) return res.status(403).json({ error: 'Esta ocorrência não é do seu departamento.' });
    const nFilhasAb = (await pool.query("SELECT COUNT(*)::int AS n FROM cs_qualidade_registros WHERE pai_id = $1 AND status <> 'cancelado'", [reg.id])).rows[0].n;
    if (reg.etapa !== 'tratativa_definida' || !reg.plano_acao || (!reg.analista_id && !nFilhasAb) || !reg.prazo) return res.status(409).json({ error: 'Defina a tratativa (plano de ação, responsável e prazo) antes de abrir para o analista.' });
    const idsR = await idsRespDe(reg.id, reg.analista_id);
    const nomesR = (await pool.query('SELECT nome FROM analistas WHERE id::text = ANY($1::text[]) ORDER BY nome', [idsR])).rows.map((r) => r.nome);
    const temResp = nomesR.length > 0;
    const an = { nome: nomesR.join(', ') || 'as ocorrências vinculadas' };
    const upEtapa4 = await pool.query(`UPDATE cs_qualidade_registros SET etapa = 'com_analista', status = ${"'" + ETAPA_STATUS.com_analista + "'"}, liberada_em = NOW(), liberada_por = $1, atualizado_em = NOW() WHERE id = $2 AND etapa = 'tratativa_definida'`, [req.user.name || null, reg.id]);
    if (!upEtapa4.rowCount) return res.status(409).json({ error: JA_MUDOU });
    await registrar(reg.id, req.user.name, 'liberada', 'Aberta para ' + (an ? an.nome : 'o analista'));
    if (temResp) try {
      await pool.query(`INSERT INTO notificacoes (tipo, titulo, mensagem, link_modulo) VALUES ('qualidade_liberada', $1, $2, 'cs-qualidade')`,
        ['Ocorrência aberta para ' + (an ? an.nome : 'o analista'), (req.user.name || 'O gestor') + ' abriu a tratativa de "' + (reg.assunto || '') + '" (' + (reg.cliente_nome || 'cliente') + ') para ' + (an ? an.nome : 'o analista') + ', prazo ' + String(reg.prazo).slice(0, 10).split('-').reverse().join('/') + '.']);
    } catch (e) { console.warn('[qualidade] aviso de liberação não gravado:', e.message); }
    if (temResp) avisarPush(() => idsDosResponsaveis(reg.id, reg.analista_id), { titulo: 'Ocorrência aberta para você', texto: (reg.cliente_nome || 'Empresa') + ' — ' + (reg.assunto || '') + ' · prazo ' + String(reg.prazo).slice(0, 10).split('-').reverse().join('/'), url: '/cs?aba=analista', tag: 'lib-' + reg.id }, req.user.id);
    const { rows } = await pool.query(`SELECT ${COLUNAS} ${DE} WHERE r.id = $1`, [reg.id]);
    res.json({ registro: (await completar(rows))[0] });
  } catch (e) { console.error('[qualidade] POST abrir falhou:', e); res.status(500).json({ error: 'Erro ao abrir a ocorrência para o analista.' }); }
});

/** PORTAL DO ANALISTA: as ocorrências que o gestor abriu para o analista (o administrador vê todas, ou as de um analista com ?analista=). */
router.get('/analista/ocorrencias', async (req, res) => {
  try {
    await garantirSchema();
    const adm = PAPEIS.includes(req.user.role);
    let analista = null;
    if (adm && req.query.analista) analista = (await pool.query('SELECT id, nome FROM analistas WHERE id::text = $1', [String(req.query.analista)])).rows[0] || null;
    else if (!adm) analista = await analistaDoLogin(req.user);
    if (!adm && !analista) return res.status(403).json({ error: 'Seu login não está ligado a um analista. A administração liga em Qualidade > Gerenciar analistas.' });
    const vals = analista ? [String(analista.id)] : [];
    const { rows } = await pool.query(
      `SELECT ${COLUNAS} ${DE} WHERE r.origem IN ('modulo', 'filha') AND r.status <> 'cancelado' AND r.etapa NOT IN ('registrada', 'tratativa_definida')${analista ? ' AND (r.analista_id = $1 OR EXISTS (SELECT 1 FROM cs_qualidade_resp x WHERE x.registro_id = r.id AND x.analista_id = $1))' : ''}
        ORDER BY (r.etapa = 'encerrada') ASC, r.prazo ASC NULLS LAST LIMIT 300`, vals);
    // ocorrências registradas sobre este analista (o analista indicado no registro): ele acompanha, mesmo que o gestor ponha outros para tratar
    const sobre = analista ? (await pool.query(`SELECT ${COLUNAS} ${DE} WHERE r.origem = 'modulo' AND r.status <> 'cancelado' AND r.analista_origem_id = $1 ORDER BY r.criado_em DESC LIMIT 200`, vals)).rows : [];
    const lider = PAPEIS.includes(req.user.role), meuId = analista ? String(analista.id) : null;
    const mascarar = (lista) => lista.map((r) => mascararParaAnalista(r, meuId, lider));
    res.json({
      analista: analista ? { id: analista.id, nome: analista.nome } : null, todos: !analista, admin: adm,
      registros: mascarar(await completar(rows)),
      sobre_mim: (await completar(sobre)).map((r) => Object.assign({}, r, { filhas: [] })),   // o indicado acompanha a etapa; as ocorrências vinculadas ficam com o gestor
    });
  } catch (e) { console.error('[qualidade] GET /analista/ocorrencias falhou:', e); res.status(500).json({ error: 'Erro ao ler as ocorrências do analista.' }); }
});

/** O analista deixa uma nota no meio da tratativa (fica no histórico da ocorrência). */
router.post('/analista/ocorrencias/:id/nota', async (req, res) => {
  try {
    await garantirSchema();
    const reg = await carregarOcorrencia(req.params.id, 'id, etapa, analista_id');
    if (!reg) return res.status(404).json({ error: 'Ocorrência não encontrada.' });
    const ag = await autorizaAgir(req.user, reg);
    if (!ag.ok) return res.status(ag.status).json({ error: ag.erro });
    if (reg.etapa !== 'com_analista') return res.status(409).json({ error: 'Só dá para anotar enquanto a ocorrência está com o analista.' });
    const t = texto(req.body && req.body.texto, MAX_TRATATIVA + 1);
    if (t.length < 3) return res.status(400).json({ error: 'Escreva a nota (mínimo de 3 caracteres).' });
    if (t.length > MAX_TRATATIVA) return res.status(400).json({ error: 'A nota passa de ' + MAX_TRATATIVA + ' caracteres.' });
    await registrar(reg.id, ag.por, 'nota', t);
    res.json({ registro: await registroCompleto(reg.id) });
  } catch (e) { console.error('[qualidade] POST analista nota falhou:', e); res.status(500).json({ error: 'Erro ao guardar a nota.' }); }
});

/** O analista trata e clica em "Encerrada": nota e observação, e a ocorrência volta ao gestor para validar. */
router.post('/analista/ocorrencias/:id/encerrar', async (req, res) => {
  try {
    await garantirSchema();
    const reg = await carregarOcorrencia(req.params.id, 'id, etapa, analista_id, departamentos, fila, assunto, cliente_nome, tipo');
    if (!reg) return res.status(404).json({ error: 'Ocorrência não encontrada.' });
    const t = transicao('analista_encerrar', reg.etapa);
    if (!t.ok) return res.status(409).json({ error: t.erro });
    // o administrador age em nome de um responsável: o pedido (analista_id) ou o primeiro que ainda não encerrou
    let pedido = req.body && req.body.analista_id ? String(req.body.analista_id) : null;
    if (!pedido && PAPEIS.includes(req.user.role)) {
      const pend = (await pool.query('SELECT analista_id FROM cs_qualidade_resp WHERE registro_id = $1 AND encerrado_em IS NULL ORDER BY analista_id', [reg.id])).rows[0];
      if (pend) pedido = String(pend.analista_id);
    }
    const ag = await autorizaAgir(req.user, reg, pedido);
    if (!ag.ok) return res.status(ag.status).json({ error: ag.erro });
    const v = validarEncerramento(req.body);
    if (!v.ok) return res.status(400).json({ error: v.erro });
    await pool.query(
      `INSERT INTO cs_qualidade_resp (registro_id, analista_id, nota, obs, encerrado_em, encerrado_por) VALUES ($1, $2, $3, $4, NOW(), $5)
       ON CONFLICT (registro_id, analista_id) DO UPDATE SET nota = EXCLUDED.nota, obs = EXCLUDED.obs, encerrado_em = NOW(), encerrado_por = EXCLUDED.encerrado_por`,
      [reg.id, String(ag.analistaId), v.valores.nota, v.valores.obs, ag.por]);
    await pool.query('UPDATE cs_qualidade_registros SET analista_nota = $1, analista_obs = $2, analista_em = NOW(), analista_por = $3, tratativa = $1, atualizado_em = NOW() WHERE id = $4', [v.valores.nota, v.valores.obs, ag.por, reg.id]);
    await registrar(reg.id, ag.por, 'analista_encerrou', textoNota(v.valores));
    const seguiu = await tentarAvancarParaValidacao(reg.id, ag.por, ag.analistaNome, req.user.id);
    res.json({ registro: await registroCompleto(reg.id), avancou: seguiu.avancou, pendentes: seguiu.pendentes, filhas_pendentes: seguiu.filhasPendentes });
  } catch (e) { console.error('[qualidade] POST analista encerrar falhou:', e); res.status(500).json({ error: 'Erro ao encerrar a tratativa.' }); }
});

/** O gestor valida o que o analista tratou ("tudo ok", com nota e observação): a ocorrência segue para a devolutiva ao cliente, no Sucesso do Cliente. */
router.post('/gestor/ocorrencias/:id/validar', async (req, res) => {
  try {
    await garantirSchema();
    const esc = await escopoDaRequisicao(req);
    const reg = await carregarOcorrencia(req.params.id, 'id, etapa, departamentos, fila, assunto, cliente_nome, origem, pai_id');
    if (!reg) return res.status(404).json({ error: 'Ocorrência não encontrada.' });
    if (!ocorrenciaNoEscopo(esc, reg)) return res.status(403).json({ error: 'Esta ocorrência não é do seu departamento.' });
    if (reg.origem === 'filha') {   // ocorrência vinculada: validada, está encerrada; a original passa a poder seguir
      const tf = transicao('filha_validar', reg.etapa);
      if (!tf.ok) return res.status(409).json({ error: tf.erro });
      const vf = validarEncerramento(req.body);
      if (!vf.ok) return res.status(400).json({ error: vf.erro });
      const upEtapa5 = await pool.query(
        `UPDATE cs_qualidade_registros SET etapa = $1, status = $2, validacao_nota = $3, validacao_obs = $4, validacao_em = NOW(), validacao_por = $5,
           validado_em = NOW(), validado_por = $5, encerrada_em = NOW(), encerrada_por = $5, resolvido_em = COALESCE(resolvido_em, NOW()), atualizado_em = NOW() WHERE id = $6 AND etapa = 'validacao_gestor'`,
        [tf.para, tf.status, vf.valores.nota, vf.valores.obs, req.user.name || null, reg.id]);
    if (!upEtapa5.rowCount) return res.status(409).json({ error: JA_MUDOU });
      await registrar(reg.id, req.user.name, 'gestor_validou', textoNota(vf.valores));
      if (reg.pai_id) {
        await registrar(reg.pai_id, req.user.name, 'nota', 'Ocorrência vinculada encerrada: ' + (reg.assunto || ''));
        await tentarAvancarParaValidacao(reg.pai_id, req.user.name, null, req.user.id);
      }
      return res.json({ registro: await registroCompleto(reg.id) });
    }
    const t = transicao('gestor_validar', reg.etapa);
    if (!t.ok) return res.status(409).json({ error: t.erro });
    const v = validarEncerramento(req.body);
    if (!v.ok) return res.status(400).json({ error: v.erro });
    const upEtapa6 = await pool.query(
      `UPDATE cs_qualidade_registros SET etapa = $1, status = $2, validacao_nota = $3, validacao_obs = $4, validacao_em = NOW(), validacao_por = $5,
         validado_em = NOW(), validado_por = $5, atualizado_em = NOW() WHERE id = $6 AND etapa = 'validacao_gestor'`,
      [t.para, t.status, v.valores.nota, v.valores.obs, req.user.name || null, reg.id]);
    if (!upEtapa6.rowCount) return res.status(409).json({ error: JA_MUDOU });
    await registrar(reg.id, req.user.name, 'gestor_validou', textoNota(v.valores));
    avisarPush(async () => [].concat(await idsSucesso(), await idsAdmins()), { titulo: 'Devolutiva ao cliente', texto: (reg.cliente_nome || 'Empresa') + ' — ' + (reg.assunto || ''), url: '/cs?aba=sucesso', tag: 'dcli-' + reg.id }, req.user.id);
    res.json({ registro: await registroCompleto(reg.id) });
  } catch (e) { console.error('[qualidade] POST validar falhou:', e); res.status(500).json({ error: 'Erro ao validar a tratativa.' }); }
});

/** O gestor devolve ao analista (precisa ajustar): a nota diz o que falta; a ocorrência volta a "com o analista". */
router.post('/gestor/ocorrencias/:id/devolver', async (req, res) => {
  try {
    await garantirSchema();
    const esc = await escopoDaRequisicao(req);
    const reg = await carregarOcorrencia(req.params.id, 'id, etapa, departamentos, fila, analista_id, assunto, cliente_nome');
    if (!reg) return res.status(404).json({ error: 'Ocorrência não encontrada.' });
    if (!ocorrenciaNoEscopo(esc, reg)) return res.status(403).json({ error: 'Esta ocorrência não é do seu departamento.' });
    const t = transicao('gestor_devolver', reg.etapa);
    if (!t.ok) return res.status(409).json({ error: t.erro });
    const v = validarEncerramento(req.body);
    if (!v.ok) return res.status(400).json({ error: v.erro });
    const upEtapa7 = await pool.query("UPDATE cs_qualidade_registros SET etapa = $1, status = $2, resolvido_em = NULL, resolvido_por = NULL, atualizado_em = NOW() WHERE id = $3 AND etapa = 'validacao_gestor'", [t.para, t.status, reg.id]);
    if (!upEtapa7.rowCount) return res.status(409).json({ error: JA_MUDOU });
    await pool.query('UPDATE cs_qualidade_resp SET encerrado_em = NULL WHERE registro_id = $1', [reg.id]);   // cada responsável ajusta e encerra de novo (a nota anterior continua no histórico)
    await registrar(reg.id, req.user.name, 'devolvida', textoNota(v.valores));
    avisarPush(() => idsDosResponsaveis(reg.id, reg.analista_id), { titulo: 'Tratativa devolvida pelo gestor', texto: curtoTexto(v.valores.nota, 120), url: '/cs?aba=analista', tag: 'dev-' + reg.id + '-' + Date.now() }, req.user.id);
    res.json({ registro: await registroCompleto(reg.id) });
  } catch (e) { console.error('[qualidade] POST devolver falhou:', e); res.status(500).json({ error: 'Erro ao devolver ao analista.' }); }
});

/** Gestor do departamento, gestor final e administração cancelam e reabrem; sempre com motivo. */
async function podeCancelarOuReabrir(req, reg) {
  if (req.user && req.user.role === 'administrador') return true;
  const esc = await escopoDaRequisicao(req);
  if (ocorrenciaNoEscopo(esc, reg)) return true;
  return ehGestorFinal(req.user.id);
}
router.post('/gestor/ocorrencias/:id/cancelar', async (req, res) => {
  try {
    await garantirSchema();
    const reg = await carregarOcorrencia(req.params.id, 'id, etapa, departamentos, fila, assunto, cliente_nome, origem, pai_id, analista_id');
    if (!reg) return res.status(404).json({ error: 'Ocorrência não encontrada.' });
    if (!(await podeCancelarOuReabrir(req, reg))) return res.status(403).json({ error: 'Só o gestor do departamento, o gestor final ou a administração cancelam uma ocorrência.' });
    const t = transicao('cancelar', reg.etapa);
    if (!t.ok) return res.status(409).json({ error: t.erro });
    const v = validarMotivo(req.body);
    if (!v.ok) return res.status(400).json({ error: v.erro });
    const idsResp = await idsDosResponsaveis(reg.id, reg.analista_id);   // antes de mudar qualquer coisa
    const up = await pool.query("UPDATE cs_qualidade_registros SET etapa_antes = etapa, etapa = 'cancelada', status = 'cancelado', atualizado_em = NOW() WHERE id = $1 AND etapa = $2", [reg.id, reg.etapa]);
    if (!up.rowCount) return res.status(409).json({ error: JA_MUDOU });
    await pool.query("UPDATE cs_qualidade_registros SET etapa_antes = etapa, etapa = 'cancelada', status = 'cancelado', atualizado_em = NOW() WHERE pai_id = $1 AND etapa NOT IN ('encerrada', 'cancelada')", [reg.id]);   // as vinculadas abertas vão junto
    await registrar(reg.id, req.user.name, 'cancelada', v.valores.motivo);
    if (reg.pai_id) {   // cancelou uma vinculada: a original deixa de esperar por ela
      await registrar(reg.pai_id, req.user.name, 'nota', 'Ocorrência vinculada cancelada: ' + (reg.assunto || ''));
      await tentarAvancarParaValidacao(reg.pai_id, req.user.name, null, req.user.id);
    }
    avisarPush(async () => idsResp, { titulo: 'Ocorrência cancelada', texto: (reg.cliente_nome || 'Empresa') + ' — ' + (reg.assunto || '') + ': ' + curtoTexto(v.valores.motivo, 100), url: '/cs?aba=analista', tag: 'canc-' + reg.id }, req.user.id);
    refrescarRisco();
    res.json({ registro: await registroCompleto(reg.id) });
  } catch (e) { console.error('[qualidade] POST cancelar falhou:', e); res.status(500).json({ error: 'Erro ao cancelar a ocorrência.' }); }
});
/** EXCLUIR (gestor final e administração): a ocorrência e as vinculadas somem dos dashboards, dos analistas e do risco, como se nunca tivessem existido.
 *  Histórico, responsáveis, anexos e avisos de prazo saem junto (cascata); só o log de atividades guarda o que houve. Não tem volta. */
router.post('/gestor/ocorrencias/:id/excluir', async (req, res) => {
  try {
    await garantirSchema();
    if (!(req.user.role === 'administrador' || (await ehGestorFinal(req.user.id)))) return res.status(403).json({ error: 'Só o gestor final ou a administração excluem uma ocorrência.' });
    const reg = await carregarOcorrencia(req.params.id, 'id, etapa, assunto, cliente_nome, origem, pai_id');
    if (!reg) return res.status(404).json({ error: 'Ocorrência não encontrada.' });
    const v = validarMotivo(req.body);
    if (!v.ok) return res.status(400).json({ error: v.erro });
    const filhas = (await pool.query('SELECT assunto FROM cs_qualidade_registros WHERE pai_id = $1', [reg.id])).rows;
    const del = await pool.query('DELETE FROM cs_qualidade_registros WHERE id = $1 RETURNING id', [reg.id]);   // as vinculadas saem junto (pai_id ON DELETE CASCADE)
    if (!del.rowCount) return res.status(404).json({ error: 'Ocorrência não encontrada.' });
    try {   // os avisos do sino que citavam a ocorrência
      for (const assunto of [reg.assunto].concat(filhas.map((f) => f.assunto)).filter(Boolean)) {
        await pool.query("DELETE FROM notificacoes WHERE tipo LIKE 'qualidade%' AND position($1 in COALESCE(mensagem, '') || ' ' || COALESCE(titulo, '')) > 0", ['"' + assunto + '"']);
      }
    } catch (e) { console.warn('[qualidade] avisos do sino não limpos:', e.message); }
    require('./auditoria').logReq(req, 'excluir', 'cs-qualidade', 'Excluiu a ocorrência' + (filhas.length ? ' (e ' + filhas.length + ' vinculada(s))' : '') + ' — ' + [reg.cliente_nome, reg.assunto].filter(Boolean).join(' · ') + ' · motivo: ' + curtoTexto(v.valores.motivo, 300));
    if (reg.pai_id) await tentarAvancarParaValidacao(reg.pai_id, req.user.name, null, req.user.id);   // a original deixa de esperar por esta vinculada
    refrescarRisco();
    res.json({ ok: true, vinculadas: filhas.length });
  } catch (e) { console.error('[qualidade] POST excluir falhou:', e); res.status(500).json({ error: 'Erro ao excluir a ocorrência.' }); }
});
router.post('/gestor/ocorrencias/:id/reabrir', async (req, res) => {
  try {
    await garantirSchema();
    const reg = await carregarOcorrencia(req.params.id, 'id, etapa, etapa_antes, departamentos, fila, assunto, cliente_nome, origem, pai_id, analista_id');
    if (!reg) return res.status(404).json({ error: 'Ocorrência não encontrada.' });
    const reabreEncerrada = reg.etapa === 'encerrada';
    if (reabreEncerrada) {
      if (!(req.user.role === 'administrador' || (await ehGestorFinal(req.user.id)))) return res.status(403).json({ error: 'Só o gestor final ou a administração reabrem uma ocorrência encerrada.' });
    } else if (!(await podeCancelarOuReabrir(req, reg))) return res.status(403).json({ error: 'Só o gestor do departamento, o gestor final ou a administração reabrem uma ocorrência.' });
    let alvo;
    if (reabreEncerrada) { const t = transicao('reabrir_encerrada', reg.etapa); if (!t.ok) return res.status(409).json({ error: t.erro }); alvo = { para: t.para, status: t.status }; }
    else if (reg.etapa === 'cancelada') alvo = destinoDaReabertura(reg.etapa_antes);
    else return res.status(409).json({ error: 'Só dá para reabrir uma ocorrência encerrada ou cancelada.' });
    const v = validarMotivo(req.body);
    if (!v.ok) return res.status(400).json({ error: v.erro });
    if (reg.origem === 'filha' && reg.pai_id) {   // a vinculada só volta enquanto a original ainda está em tratamento
      const pai = (await pool.query('SELECT etapa FROM cs_qualidade_registros WHERE id = $1', [reg.pai_id])).rows[0];
      if (!pai || !['registrada', 'tratativa_definida', 'com_analista'].includes(pai.etapa)) return res.status(409).json({ error: 'A ocorrência original já passou da fase de tratamento (ou foi cancelada): reabra a original primeiro.' });
    }
    const limpar = reabreEncerrada ? ', resolvido_em = NULL, resolvido_por = NULL, encerrada_em = NULL, encerrada_por = NULL, final_nota = NULL, final_obs = NULL, validacao_nota = NULL, validacao_obs = NULL, validacao_em = NULL, validacao_por = NULL' : '';
    const up = await pool.query('UPDATE cs_qualidade_registros SET etapa = $1, status = $2, etapa_antes = NULL' + limpar + ', atualizado_em = NOW() WHERE id = $3 AND etapa = $4', [alvo.para, alvo.status, reg.id, reg.etapa]);
    if (!up.rowCount) return res.status(409).json({ error: JA_MUDOU });
    if (reabreEncerrada) await pool.query('UPDATE cs_qualidade_resp SET encerrado_em = NULL WHERE registro_id = $1', [reg.id]);   // cada responsável trata e encerra de novo
    await registrar(reg.id, req.user.name, 'reaberta', v.valores.motivo);
    if (alvo.para === 'com_analista') avisarPush(() => idsDosResponsaveis(reg.id, reg.analista_id), { titulo: 'Ocorrência reaberta', texto: (reg.cliente_nome || 'Empresa') + ' — ' + (reg.assunto || '') + ': ' + curtoTexto(v.valores.motivo, 100), url: '/cs?aba=analista', tag: 'reab-' + reg.id + '-' + Date.now() }, req.user.id);
    refrescarRisco();
    res.json({ registro: await registroCompleto(reg.id) });
  } catch (e) { console.error('[qualidade] POST reabrir falhou:', e); res.status(500).json({ error: 'Erro ao reabrir a ocorrência.' }); }
});

/** PORTAL DO SUCESSO DO CLIENTE: todas as ocorrências (o dashboard de todos). Vê a equipe do painel e quem é do Sucesso do Cliente; só o gestor final encerra. */
async function podeVerSucesso(req) {
  if (podeEquipe(req.user)) return true;
  if ((await acessos.lerConfig(req.user.id)) && (await acessos.lerConfig(req.user.id)).includes('sucesso')) return true;   // liberado em Acessos
  return (await pool.query("SELECT 1 FROM cs_qualidade_gestores WHERE user_id = $1 AND (departamento = 'Sucesso' OR papel = 'final') LIMIT 1", [String(req.user.id)])).rows.length > 0;
}
router.get('/sucesso/ocorrencias', async (req, res) => {
  try {
    await garantirSchema();
    if (!(await podeVerSucesso(req))) return res.status(403).json({ error: 'O portal do Sucesso do Cliente é da equipe do Sucesso do Cliente.' });
    const { rows } = await pool.query(`SELECT ${COLUNAS} ${DE} WHERE r.origem IN ('modulo', 'filha') ORDER BY (r.etapa = 'devolutiva_cliente') DESC, r.criado_em DESC LIMIT 500`);
    res.json({ final: await ehGestorFinal(req.user.id), registros: await completar(rows) });
  } catch (e) { console.error('[qualidade] GET /sucesso/ocorrencias falhou:', e); res.status(500).json({ error: 'Erro ao ler as ocorrências do Sucesso do Cliente.' }); }
});
/** Encerra o processo: SÓ o gestor final (para um diretor administrador não encerrar achando que está encerrando no departamento dele). */
router.post('/sucesso/ocorrencias/:id/encerrar', async (req, res) => {
  try {
    await garantirSchema();
    if (!(await ehGestorFinal(req.user.id))) return res.status(403).json({ error: 'Só o gestor final encerra o processo. A administração define quem é em Qualidade > Gerenciar gestores.' });
    const reg = await carregarOcorrencia(req.params.id, 'id, etapa, assunto, cliente_nome, criado_por_id');
    if (!reg) return res.status(404).json({ error: 'Ocorrência não encontrada.' });
    const t = transicao('final_encerrar', reg.etapa);
    if (!t.ok) return res.status(409).json({ error: t.erro });
    const v = validarEncerramento(req.body);
    if (!v.ok) return res.status(400).json({ error: v.erro });
    const upEtapa8 = await pool.query(
      `UPDATE cs_qualidade_registros SET etapa = $1, status = $2, final_nota = $3, final_obs = $4, encerrada_em = NOW(), encerrada_por = $5,
         validado_em = COALESCE(validado_em, NOW()), resolvido_em = COALESCE(resolvido_em, NOW()), atualizado_em = NOW() WHERE id = $6 AND etapa = 'devolutiva_cliente'`,
      [t.para, t.status, v.valores.nota, v.valores.obs, req.user.name || null, reg.id]);
    if (!upEtapa8.rowCount) return res.status(409).json({ error: JA_MUDOU });
    await registrar(reg.id, req.user.name, 'encerrada', textoNota(v.valores));
    avisarPush(async () => [reg.criado_por_id], { titulo: 'Ocorrência encerrada', texto: (reg.cliente_nome || 'Empresa') + ' — ' + (reg.assunto || ''), url: '/cs?aba=consideracoes', tag: 'enc-' + reg.id }, req.user.id);
    refrescarRisco();
    res.json({ registro: await registroCompleto(reg.id) });
  } catch (e) { console.error('[qualidade] POST sucesso encerrar falhou:', e); res.status(500).json({ error: 'Erro ao encerrar o processo.' }); }
});

/**
 * Tempo médio por etapa (ver temposEtapa.js). Administração, equipe e Sucesso do Cliente veem todas as ocorrências; o gestor, as dos departamentos dele.
 * Filtros: de e ate (data do registro, AAAA-MM-DD) e departamento.
 */
router.get('/tempos', async (req, res) => {
  try {
    await garantirSchema();
    const todos = await podeVerSucesso(req);
    const esc = await escopoDaRequisicao(req);
    if (!todos && !esc.todos && !esc.deptos.length) return res.status(403).json({ error: 'Os tempos por etapa são do gestor, do Sucesso do Cliente e da administração.' });
    const vals = [], w = ["r.origem = 'modulo'", "r.status <> 'cancelado'"];
    if (!todos && !esc.todos) { vals.push(esc.deptos); w.push('r.departamentos && $' + vals.length + '::text[]'); }
    const de = String(req.query.de || ''), ate = String(req.query.ate || ''), dep = String(req.query.departamento || '');
    if (ISO.test(de)) { vals.push(de); w.push("(r.criado_em AT TIME ZONE 'America/Sao_Paulo')::date >= $" + vals.length + '::date'); }
    if (ISO.test(ate)) { vals.push(ate); w.push("(r.criado_em AT TIME ZONE 'America/Sao_Paulo')::date <= $" + vals.length + '::date'); }
    if (DEPARTAMENTOS.includes(dep)) { vals.push(dep); w.push('$' + vals.length + ' = ANY(r.departamentos)'); }
    const regs = (await pool.query('SELECT r.id, r.departamentos, r.criado_em FROM cs_qualidade_registros r WHERE ' + w.join(' AND ') + ' ORDER BY r.criado_em DESC LIMIT 3000', vals)).rows;
    const ids = regs.map((r) => r.id);
    const evs = ids.length ? (await pool.query('SELECT registro_id, acao, em FROM cs_qualidade_historico WHERE registro_id = ANY($1::uuid[]) AND acao = ANY($2::text[]) ORDER BY em', [ids, ACOES_DO_HISTORICO])).rows : [];
    const porReg = {};
    evs.forEach((e) => { (porReg[String(e.registro_id)] = porReg[String(e.registro_id)] || []).push({ acao: e.acao, em: e.em }); });
    res.json(calcularTempos(regs.map((r) => ({ criado_em: r.criado_em, departamentos: r.departamentos, eventos: porReg[String(r.id)] || [] }))));
  } catch (e) { console.error('[qualidade] GET /tempos falhou:', e); res.status(500).json({ error: 'Erro ao calcular os tempos por etapa.' }); }
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
    let avisoResp = '';
    if (x.analista_id) {   // responsável sugerido: tem de estar na lista de analistas e ativo; se não for do departamento, só avisa
      const an = (await pool.query('SELECT nome, ativo, departamentos FROM analistas WHERE id::text = $1', [x.analista_id])).rows[0];
      if (!an) return res.status(404).json({ error: 'Responsável não encontrado na lista de analistas.' });
      if (!an.ativo) return res.status(400).json({ error: an.nome + ' está desativado na lista de analistas.' });
      avisoResp = avisoResponsavel(an, x.departamento);
    }
    // encaminhamento: gestor(es) do departamento escolhido; sem gestor cadastrado, vai para o Sucesso do Cliente
    const gest = (await pool.query(
      `SELECT g.papel, u.name FROM cs_qualidade_gestores g JOIN users u ON u.id::text = g.user_id WHERE g.departamento = $1 AND u.active = 1 ORDER BY u.name`, [x.departamento])).rows;
    const dest = destinoDaOcorrencia(x.departamento, gest), textoDest = textoDestino(x.departamento, dest);
    const ins = await pool.query(
      `INSERT INTO cs_qualidade_registros (cliente_id, cnpj, cliente_nome, tipo, departamentos, detalhe, assunto, prioridade, prazo, origem, fila, criado_por, criado_por_id, analista_origem_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'modulo', $10, $11, $12, $13) RETURNING id`,
      [c.id, soDigitos(c.cnpj), c.nome_empresa, x.tipo, [x.departamento], x.detalhe, x.assunto, x.prioridade, x.prazo, dest.fila, req.user.name || null, req.user.id || null, x.analista_id]);
    await registrar(ins.rows[0].id, req.user.name, 'criado', x.tipo + ' · ' + x.prioridade + ' · ' + x.assunto);
    const { rows } = await pool.query(`SELECT ${COLUNAS} ${DE} WHERE r.id = $1`, [ins.rows[0].id]);
    await notificarLancamento(rows[0], req.user.name, textoDest);
    avisarPush(async () => [].concat(await idsAdmins(), dest.fila === 'gestor' ? await idsGestoresDe([x.departamento]) : [], await idsSucesso()),   // o Sucesso do Cliente acompanha todos os casos: é avisado de toda ocorrência nova, vá ela para o gestor ou não
      { titulo: 'Nova ocorrência: ' + x.tipo + ' (' + (x.prioridade || '—') + ')', texto: (rows[0].cliente_nome || 'Empresa') + ' — ' + (x.assunto || '') + ' · ' + rotuloDepto(x.departamento), url: '/cs?aba=gestor', tag: String(rows[0].id) }, req.user.id);
    res.status(201).json({ registro: comSituacao(rows)[0], destino: textoDest, fila: dest.fila, aviso_responsavel: avisoResp || null });
  } catch (e) { console.error('[qualidade] POST /ocorrencias falhou:', e); res.status(500).json({ error: 'Erro ao registrar a ocorrência.' }); }
});

/** Anexo de uma ocorrência: o arquivo vai no corpo da requisição (bytes) e o nome em ?nome=. Até 5 arquivos de 10 MB por ocorrência. */
router.post('/ocorrencias/:id/anexo', express.raw({ type: () => true, limit: MAX_ANEXO + 1024 }), async (req, res) => {
  try {
    await garantirSchema();
    const reg = (await pool.query("SELECT id, criado_por_id FROM cs_qualidade_registros WHERE id::text = $1 AND origem = 'modulo'", [String(req.params.id)])).rows[0];
    if (!reg) return res.status(404).json({ error: 'Ocorrência não encontrada.' });
    if (!podeEquipe(req.user) && String(reg.criado_por_id) !== String(req.user.id)) return res.status(403).json({ error: 'Só quem registrou a ocorrência anexa arquivos a ela.' });
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
    const a = (await pool.query('SELECT a.nome, a.mime, a.dados, r.criado_por_id, r.departamentos, r.fila FROM cs_qualidade_anexos a JOIN cs_qualidade_registros r ON r.id = a.registro_id WHERE a.id::text = $1', [String(req.params.anexoId)])).rows[0];
    if (!a) return res.status(404).json({ error: 'Anexo não encontrado.' });
    if (!podeEquipe(req.user) && String(a.criado_por_id) !== String(req.user.id) && !ocorrenciaNoEscopo(await escopoDaRequisicao(req), a)) return res.status(403).json({ error: 'Esse anexo não é de uma ocorrência sua nem do seu departamento.' });
    res.set({ 'Content-Type': a.mime || 'application/octet-stream', 'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(a.nome), 'X-Content-Type-Options': 'nosniff' });
    res.send(a.dados);
  } catch (e) { console.error('[qualidade] GET anexo falhou:', e); res.status(500).json({ error: 'Erro ao baixar o anexo.' }); }
});

/** Ocorrências lançadas no módulo (as mais recentes primeiro; canceladas ficam de fora). */
router.get('/ocorrencias', async (req, res) => {
  try {
    await garantirSchema();
    const { rows } = await pool.query(`SELECT ${COLUNAS} ${DE} WHERE r.origem = 'modulo' AND r.status <> 'cancelado' ORDER BY r.criado_em DESC LIMIT 200`);
    res.json({ registros: await completar(rows) });
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
  const exato = todos.rows.find((a) => semAcento(a.nome) === alvo);
  if (exato) return exato;
  // login só com o primeiro nome (ex.: "João" para "Joao Victor ..."): serve quando é um único analista ainda sem login que começa assim
  const completo = nomeCompletoDoLogin({ id: user.id, name: user.name }, todos.rows.map((a) => ({ nome: a.nome, user_id: null })), []);
  return todos.rows.find((a) => semAcento(a.nome) === semAcento(completo)) || null;
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

    const regs = (await pool.query(`SELECT ${COLUNAS} ${DE} WHERE r.analista_id = $1 AND r.origem <> 'modulo' AND r.status <> 'cancelado' ORDER BY r.prazo ASC LIMIT 300`, [String(analista.id)])).rows;
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
    const { rows } = await pool.query(`SELECT ${COLUNAS} ${DE} WHERE r.analista_id = $1 AND r.origem <> 'modulo' AND r.status <> 'cancelado' ORDER BY (r.status IN ('resolvido')) ASC, r.prazo ASC LIMIT 300`, [String(analista.id)]);
    res.json({ analista, registros: await anexarNotas(comSituacao(rows)) });
  } catch (e) { console.error('[qualidade] GET /minhas falhou:', e); res.status(500).json({ error: 'Erro ao carregar suas tratativas.' }); }
});

/**
 * Quem pode agir num registro pelo portal: o próprio analista (login ligado a ele) ou administrador/usuário "em nome de" (modo Ver como).
 * Devolve { ok, analistaNome, por } ou { ok:false, status, erro }.
 */
async function autorizaAgir(user, reg, analistaPedido) {
  const ids = await idsRespDe(reg.id, reg.analista_id);
  if (PAPEIS.includes(user.role)) {
    const alvo = analistaPedido && ids.includes(String(analistaPedido)) ? String(analistaPedido) : (ids[0] || String(reg.analista_id));
    const a = (await pool.query('SELECT nome FROM analistas WHERE id::text = $1', [alvo])).rows[0];
    return { ok: true, analistaId: alvo, analistaNome: a ? a.nome : 'o analista', por: (user.name || 'Liderança') + (a ? ' (em nome de ' + a.nome + ')' : '') };
  }
  const analista = await analistaDoLogin(user);
  if (!analista) return { ok: false, status: 403, erro: 'Seu login não está ligado a um analista.' };
  if (!ids.includes(String(analista.id))) return { ok: false, status: 403, erro: 'Esse registro é de outro analista.' };
  return { ok: true, analistaId: String(analista.id), analistaNome: analista.nome, por: user.name || analista.nome };
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
    const r = await pool.query('SELECT id, analista_id, status, tipo, cliente_nome, origem FROM cs_qualidade_registros WHERE id::text = $1', [String(req.params.id)]);
    if (!r.rows.length) return res.status(404).json({ error: 'Registro não encontrado.' });
    if (r.rows[0].origem === 'modulo') return res.status(409).json({ error: 'Ocorrência do módulo Qualidade: a tratativa segue o fluxo do Portal do Gestor e do Portal do Analista.' });
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
    const r = await pool.query('SELECT id, analista_id, status, origem FROM cs_qualidade_registros WHERE id::text = $1', [String(req.params.id)]);
    if (!r.rows.length) return res.status(404).json({ error: 'Registro não encontrado.' });
    if (r.rows[0].origem === 'modulo') return res.status(409).json({ error: 'Ocorrência do módulo Qualidade: a tratativa segue o fluxo do Portal do Gestor e do Portal do Analista.' });
    const ag = await autorizaAgir(req.user, r.rows[0]);
    if (!ag.ok) return res.status(ag.status).json({ error: ag.erro });
    if (['resolvido', 'cancelado'].includes(r.rows[0].status)) return res.status(409).json({ error: 'Esse registro já foi encerrado.' });
    await registrar(r.rows[0].id, ag.por, 'nota', t);
    await pool.query('UPDATE cs_qualidade_registros SET atualizado_em = NOW() WHERE id = $1', [r.rows[0].id]);
    const { rows } = await pool.query(`SELECT ${COLUNAS} ${DE} WHERE r.id = $1`, [r.rows[0].id]);
    res.status(201).json({ registro: (await anexarNotas(comSituacao(rows)))[0] });
  } catch (e) { console.error('[qualidade] POST /nota falhou:', e); res.status(500).json({ error: 'Erro ao salvar a nota.' }); }
});

/** Alerta de prazo das ocorrências (o agendador do index.js chama todo dia de manhã; ver alertasPrazo.js). */
async function rodarAlertasPrazo() {
  await garantirSchema();
  return require('./alertasPrazo').rodar({
    pool, hoje: hojeBrasilia(), idsGestoresDe, idsDosResponsaveis, idsSucesso, avisarPush,
    notificar: async (titulo, mensagem) => { try { await pool.query("INSERT INTO notificacoes (tipo, titulo, mensagem, link_modulo) VALUES ('qualidade_prazo', $1, $2, 'cs-qualidade')", [titulo, mensagem]); } catch (e) { /* sem a tabela do sino ainda: segue só com o push */ } },
    registrarLog: (texto) => require('./auditoria').registrar({ id: 'sistema', name: 'Sistema' }, 'alerta', 'cs-alertas', texto, null),
  });
}

module.exports = { rodarAlertasPrazo, validarMotivo, destinoDaReabertura, mascararParaAnalista, validarFilha, prontoParaValidacao, validarDepartamentosAnalista, avisoResponsavel, nomeCompletoDoLogin, pessoasParaGestor, router, routerAnalista, validarTipo, validarOcorrencia, validarGestor, transicao, validarEncerramento, TRANSICOES, rotaAbertaGestorAnalista, escopoDoUsuario, ocorrenciaNoEscopo, validarTratativaGestor, ETAPA_STATUS, deveAvisar, destinoDaOcorrencia, textoDestino, podeAlterarPrazo, ETAPAS, PRIORIDADES, idsResponsaveis, TIPO_PLANO, TIPOS, DEPARTAMENTOS, STATUS, validarRegistro, validarMudanca, situacao, semAcento, hojeBrasilia, mesmoNome, montarPrioridades, segundaDe };
