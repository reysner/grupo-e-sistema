'use strict';
/**
 * Módulo Sucesso do Cliente — Tradutor Zappy → formato genérico
 * ------------------------------------------------------------------
 * Converte a resposta da API OFICIAL do Zappy Contábil (confirmada via
 * swagger.json — ver zappyClient.js) no formato genérico que a máquina
 * dos 5 relógios (slaEngine.js) entende.
 *
 * Estrutura real (API pública, NÃO a interna do site — ver zappyClient.js).
 * O swagger.json só documenta um SUBCONJUNTO dos campos — a resposta real
 * de GET /api/tickets/:id tem bem mais coisa (confirmado em 20/08/2026 via
 * /api/cs/diagnostico), incluindo o que este tradutor de fato usa:
 *   Ticket:   { id, status, userId, contactId, queueId, whatsappId,
 *               unreadMessages, lastMessage, isGroup, createdAt, updatedAt,
 *               rate (nota do cliente 1-5, fora do swagger — ver zappyClient.js),
 *               metas: [{ type, value, userId, createdAt }, ...] (fora do
 *               swagger — histórico de eventos tipo 'acceptTicket', ainda
 *               não totalmente mapeado) }
 *   Mensagem: { id, createdAt, updatedAt, body, mediaUrl, mediaType,
 *               fromMe, ack, read, ticketId, contactId, ... }
 *
 * A API pública NÃO manda nome/telefone do contato nem nome da
 * fila/atendente dentro do ticket (só os IDs) — por isso `traduzirTicket`
 * recebe um `contexto` já resolvido (contato, filaNome, analistaNome),
 * montado pelo ingestao.js a partir de GET /contacts, /queues, /users.
 *
 * Regras de mapeamento:
 *   - fromMe=false  -> remetente 'cliente'
 *   - fromMe=true   -> remetente 'escritorio' (ou 'sistema', se for bot — ver ehMensagemBot)
 */

/**
 * Decide se uma mensagem fromMe:true é BOT (automação) ou ATENDENTE HUMANO.
 * ------------------------------------------------------------------
 * A API pública não tem `metas` nem `botOptionId` (isso só existe na API
 * interna do site, vista via F12). O sinal que sobrou — e que já resolve
 * o caso real que motivou essa investigação (ticket #46072: status
 * 'pending', ninguém assumiu, e uma mensagem automática apareceu como
 * fromMe:true) — é `ticket.userId`, null enquanto ninguém assumiu:
 *
 *   - `userId` null  -> ninguém assumiu ainda -> toda fromMe:true é bot.
 *   - `userId` preenchido -> alguém já assumiu -> fromMe:true é do atendente.
 *
 * Sem timestamp exato de quando o "aceite" aconteceu, não dá pra saber se
 * uma mensagem fromMe:true ANTES do aceite (mas já com userId preenchido
 * no momento da consulta) foi bot ou humano — mas isso só é um problema
 * na PRIMEIRA vez que um ticket é capturado depois de já aceito. Como a
 * ingestão roda periodicamente e grava cada mensagem só uma vez (ON
 * CONFLICT DO NOTHING em cs_mensagens), o normal é capturar o ticket
 * ainda 'pending' antes de alguém aceitar, então o is_bot fica certo e
 * não é recalculado depois.
 */
function ehMensagemBot(m, ticketZappy) {
  if (!m.fromMe) return false; // mensagem do cliente nunca é "bot do escritório"
  return !ticketZappy.userId; // sem atendente designado ainda -> só pode ser automação
}

/** Converte uma mensagem do Zappy no formato genérico */
function traduzirMensagem(m, ticketZappy) {
  return {
    hora: m.createdAt,
    remetente: m.fromMe ? 'escritorio' : 'cliente',
    texto: m.body || '',
    zappy_msg_id: m.id != null ? String(m.id) : null,
    media_type: m.mediaType || 'text',
    is_bot: ehMensagemBot(m, ticketZappy),
  };
}

/**
 * Extrai eventos de SLA a partir do ticket. A API pública não dá o
 * instante exato do aceite/transferência VIA SWAGGER — mas confirmado em
 * 27/08/2026 (via /api/cs/diagnostico num ticket real, #47868, da Elma)
 * que o campo `metas` (fora do swagger, mas presente na resposta real —
 * mesma situação do `rate`) TEM o evento formal:
 *   { type: 'acceptTicket', userId, value, createdAt }
 * — exatamente quando alguém aceitou o ticket saindo do aguardando/bot, e
 * quem foi. É isso que o próprio Zappy usa no relatório dele "Tempo médio
 * de Aceite do Aguardando" (confirmado pelo texto do tooltip: "tempo médio
 * que um usuário levou a aceitar um atendimento do aguardando ou bot").
 * Muito mais preciso que o fallback antigo (1ª msg não-bot do escritório),
 * que mede quando alguém RESPONDEU — não quando aceitou. Um atendente pode
 * aceitar rápido e demorar pra responder (ou vice-versa), e isso mistura
 * as duas coisas em uma só métrica.
 *
 *   - abertura: ticket.createdAt (confirmado)
 *   - encerramento: se status='closed', usa ticket.updatedAt (aproximação
 *     razoável — normalmente é a última coisa que aconteceu no ticket)
 *   - aceite: preferência pro meta 'acceptTicket' (mais antigo, se houver
 *     mais de um — mantém o sentido de "abertura -> 1º aceite"). Sem meta
 *     (tickets mais antigos, ou se o Zappy parar de mandar isso): fallback
 *     pra 1ª mensagem do escritório já classificada como não-bot.
 *   - transferência: NÃO DÁ pra detectar com a API pública sozinha (não
 *     existe histórico de mudança de fila com timestamp nem em `metas`,
 *     só o aceite). Fica como limitação conhecida — precisaria de um diff
 *     entre execuções da ingestão (comparar queueId salvo vs. o novo) para
 *     aproximar (é isso que resolverHoraTransferencia em ingestao.js já faz).
 */
function extrairEventos(ticketZappy, mensagens) {
  const eventos = [];

  if (ticketZappy.createdAt) {
    eventos.push({ tipo: 'abertura', hora: ticketZappy.createdAt });
  }

  const st = (ticketZappy.status || '').toLowerCase();
  if (st === 'closed' && ticketZappy.updatedAt) {
    eventos.push({ tipo: 'encerramento', hora: ticketZappy.updatedAt });
  }

  const acceptMetas = (ticketZappy.metas || [])
    .filter(m => m.type === 'acceptTicket' && m.createdAt)
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  if (acceptMetas.length) {
    eventos.push({ tipo: 'aceite', hora: acceptMetas[0].createdAt });
  } else {
    const primEsc = mensagens
      .filter(m => m.remetente === 'escritorio' && !m.is_bot)
      .sort((a, b) => new Date(a.hora) - new Date(b.hora))[0];
    if (primEsc) eventos.push({ tipo: 'aceite', hora: primEsc.hora });
  }

  return eventos.sort((a, b) => new Date(a.hora) - new Date(b.hora));
}

/**
 * Traduz um ticket completo do Zappy (dados do ticket + mensagens + nomes
 * já resolvidos) para o formato genérico do slaEngine.
 *
 * @param {object} ticketZappy     objeto do ticket (GET /api/tickets/:id)
 * @param {Array}  mensagensZappy  mensagens (GET /api/messages?ticketId=...)
 * @param {object} contexto        { contato:{name,number}, filaNome, analistaNome }
 *                                 (resolvidos à parte pelo ingestao.js — a API
 *                                 pública do ticket só traz os IDs)
 * @returns {object} ticket no formato genérico
 */
function traduzirTicket(ticketZappy, mensagensZappy = [], contexto = {}) {
  const contato = contexto.contato || {};

  const mensagens = (mensagensZappy || [])
    .map(m => traduzirMensagem(m, ticketZappy))
    .sort((a, b) => new Date(a.hora) - new Date(b.hora));

  const eventos = extrairEventos(ticketZappy, mensagens);

  return {
    id: ticketZappy.id,
    zappy_id: String(ticketZappy.id),
    telefone: contato.number || null,
    empresa_texto: contato.name || null,
    departamento: contexto.filaNome || null,
    queue_id: ticketZappy.queueId ?? null,
    analista: contexto.analistaNome || null,
    analista_id: ticketZappy.userId != null ? String(ticketZappy.userId) : null,
    status: ticketZappy.status || null,
    // CONFIRMADO com o suporte do Zappy (20/08/2026): GET /api/tickets/:id
    // devolve um campo `rate` com a avaliação do cliente — não documentado
    // no swagger.json (que só lista um subconjunto dos campos reais), mas
    // presente na resposta de verdade (visto em /api/cs/diagnostico). Não
    // existe webhook ainda — só aparece quando a ingestão periódica
    // re-busca o ticket (dispara quando o cliente manda mensagem nova,
    // ex.: respondendo a pesquisa — ver descobrirTicketsComAtividade).
    nota_avaliacao: ticketZappy.rate != null ? Number(ticketZappy.rate) : null,
    eventos,
    mensagens,
  };
}

module.exports = { traduzirTicket, traduzirMensagem, extrairEventos, ehMensagemBot };
