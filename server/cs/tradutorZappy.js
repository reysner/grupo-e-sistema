'use strict';
/**
 * Módulo Sucesso do Cliente — Tradutor Zappy → formato genérico
 * ------------------------------------------------------------------
 * Converte a resposta da API do Zappy Contábil no formato genérico que a
 * máquina dos 5 relógios (slaEngine.js) entende.
 *
 * Baseado na estrutura real da API (ticket #46072):
 *   Ticket:   { id, status, queueId, queue:{id,name}, contact:{...},
 *               createdAt, updatedAt, rate, metas:[...] }
 *   Mensagem: { id, fromMe (bool), body, createdAt, ack, mediaType, responseSeconds }
 *
 * Regras de mapeamento:
 *   - fromMe=false  -> remetente 'cliente'
 *   - fromMe=true   -> remetente 'escritorio'
 *   - eventos derivam de: createdAt (abertura), metas (duration:since:*),
 *     status/updatedAt (encerramento), e das próprias mensagens.
 */

/**
 * Decide se uma mensagem fromMe:true é BOT (automação) ou ATENDENTE HUMANO.
 * ------------------------------------------------------------------
 * RESOLVIDO (pendência 1 da Continuidade) sem precisar de novo F12: o
 * próprio ticket já traz o sinal — `ticket.user` (documentado na seção 4
 * do handoff: "null se ninguém assumiu"). O ticket #46072 real confirma:
 * status='pending', user=null, e a única mensagem fromMe:true daquele
 * ticket É a automática (aviso de manutenção) — exatamente o caso que
 * este código precisa pegar.
 *
 * Regra:
 *  1) Se NINGUÉM jamais assumiu o ticket (ticket.user null E nenhum meta
 *     de aceite) -> nenhuma mensagem fromMe:true pode ser de atendente;
 *     só pode ser bot/automação. (cobre o caso #46072 exatamente)
 *  2) Se sabemos o INSTANTE do aceite (via meta 'duration:since:open' /
 *     'accepted'), mensagens fromMe:true ANTES desse instante são bot;
 *     DEPOIS, são do atendente.
 *  3) Ticket foi aceito em algum momento mas não temos o instante exato
 *     (sem meta de aceite, só o ticket.user preenchido no snapshot) ->
 *     não dá para datar com certeza. Cai num fallback de baixa confiança
 *     (campos explícitos de bot, se existirem). ⚠️ Este é o ÚNICO caso
 *     que ainda pode se beneficiar de uma checagem no F12 — mas é a
 *     minoria (tickets já em andamento no momento da 1ª ingestão).
 *
 * @param {object} m           mensagem do Zappy (antes de traduzir)
 * @param {object} ticketZappy ticket do Zappy (para ler .user)
 * @param {Date|null} aceiteInstante  instante do aceite, se conhecido via meta
 */
function ehMensagemBot(m, ticketZappy, aceiteInstante) {
  if (!m.fromMe) return false; // mensagem do cliente nunca é "bot do escritório"

  const ticketFoiAceito = !!(ticketZappy && ticketZappy.user) || !!aceiteInstante;
  if (!ticketFoiAceito) return true; // regra 1 — caso #46072

  if (aceiteInstante) {
    return new Date(m.createdAt) < aceiteInstante; // regra 2
  }

  // regra 3 — fallback de baixa confiança (só entra se não achamos o instante do aceite)
  return !!(m.botOptionId || m.isBot || m.fromBot);
}

/** Converte uma mensagem do Zappy no formato genérico */
function traduzirMensagem(m, ticketZappy = null, aceiteInstante = null) {
  return {
    hora: m.createdAt,
    remetente: m.fromMe ? 'escritorio' : 'cliente',
    texto: m.body || '',
    zappy_msg_id: m.id || null,
    media_type: m.mediaType || 'text',
    is_bot: ehMensagemBot(m, ticketZappy, aceiteInstante),
  };
}

const MAPA_META = {
  'duration:since:open': 'aceite',
  'duration:since:accepted': 'aceite',
  'duration:since:pending': null, // "pending" = aguardando aceite; não é evento de aceite
  'duration:since:closed': 'encerramento',
  'duration:since:resolved': 'encerramento',
};

/**
 * Instante do aceite conforme os metas do Zappy, se vier explícito.
 * Calculado ANTES de traduzir as mensagens, para alimentar ehMensagemBot()
 * sem depender de nenhuma mensagem já classificada (evita circularidade).
 */
function extrairAceiteMeta(ticketZappy) {
  const metas = ticketZappy.metas || [];
  for (const meta of metas) {
    if (MAPA_META[meta.type] === 'aceite' && meta.value) return new Date(meta.value);
  }
  return null;
}

/**
 * Extrai eventos de SLA a partir do ticket + metas do Zappy (mensagens já
 * traduzidas, com is_bot já resolvido).
 */
function extrairEventos(ticketZappy, mensagens, aceiteMeta = null) {
  const eventos = [];

  // Abertura = createdAt do ticket
  if (ticketZappy.createdAt) {
    eventos.push({ tipo: 'abertura', hora: ticketZappy.createdAt });
  }

  const metas = ticketZappy.metas || [];
  for (const meta of metas) {
    const tipo = MAPA_META[meta.type];
    if (tipo && meta.value) {
      eventos.push({ tipo, hora: meta.value });
    }
  }

  // Encerramento: se status indica fechado e temos updatedAt, usa como fallback
  const st = (ticketZappy.status || '').toLowerCase();
  if ((st === 'closed' || st === 'resolved') && !eventos.some(e => e.tipo === 'encerramento')) {
    eventos.push({ tipo: 'encerramento', hora: ticketZappy.updatedAt || ticketZappy.closedAt });
  }

  // Aceite (fallback quando não veio explícito nos metas, mas o ticket já
  // tem .user preenchido): usa a 1ª mensagem do escritório JÁ classificada
  // como não-bot (ehMensagemBot cobre isso com a regra 3 do arquivo).
  if (!eventos.some(e => e.tipo === 'aceite') && !aceiteMeta) {
    const primEsc = mensagens
      .filter(m => m.remetente === 'escritorio' && !m.is_bot)
      .sort((a, b) => new Date(a.hora) - new Date(b.hora))[0];
    if (primEsc) eventos.push({ tipo: 'aceite', hora: primEsc.hora });
  }

  return eventos.sort((a, b) => new Date(a.hora) - new Date(b.hora));
}

/**
 * Traduz um ticket completo do Zappy (dados do ticket + lista de mensagens)
 * para o formato genérico do slaEngine.
 *
 * @param {object} ticketZappy  objeto do ticket (resposta de GET /tickets/:id)
 * @param {Array}  mensagensZappy  array de mensagens (resposta de GET /tickets/:id?pageNumber=...)
 * @returns {object} ticket no formato genérico
 */
function traduzirTicket(ticketZappy, mensagensZappy = []) {
  const contato = ticketZappy.contact || {};

  // 1) instante do aceite (se os metas derem, com certeza) ANTES de classificar
  //    as mensagens — é o que permite ehMensagemBot() decidir sem circularidade.
  const aceiteMeta = extrairAceiteMeta(ticketZappy);

  // 2) traduz mensagens já com is_bot resolvido (regras 1/2/3 de ehMensagemBot)
  const mensagens = (mensagensZappy || [])
    .map(m => traduzirMensagem(m, ticketZappy, aceiteMeta))
    .sort((a, b) => new Date(a.hora) - new Date(b.hora));

  // 3) eventos (aceite/transferência/encerramento), reaproveitando aceiteMeta
  const eventos = extrairEventos(ticketZappy, mensagens, aceiteMeta);

  // Só entra no SLA se a fila for de atendimento a cliente.
  // A fila "Sucesso do Cliente" (id 2) e outras de atendimento contam;
  // filas internas/software podem ser excluídas depois via cs_vinculos.tipo.
  const fila = ticketZappy.queue || {};

  return {
    id: ticketZappy.id,
    zappy_id: String(ticketZappy.id),
    telefone: contato.number || null,
    empresa_texto: contato.name || null,
    departamento: fila.name || null,
    queue_id: ticketZappy.queueId ?? fila.id ?? null,
    analista: ticketZappy.user?.name || null,
    status: ticketZappy.status || null,
    nota_avaliacao: ticketZappy.rate ?? null,   // 1-5 (null se não avaliado)
    eventos,
    mensagens,
  };
}

module.exports = { traduzirTicket, traduzirMensagem, extrairEventos, ehMensagemBot, extrairAceiteMeta };
