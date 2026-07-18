'use strict';
/**
 * Módulo Sucesso do Cliente — Tradutor Zappy → formato genérico
 * ------------------------------------------------------------------
 * Converte a resposta da API OFICIAL do Zappy Contábil (confirmada via
 * swagger.json — ver zappyClient.js) no formato genérico que a máquina
 * dos 5 relógios (slaEngine.js) entende.
 *
 * Estrutura real (API pública, NÃO a interna do site — ver zappyClient.js):
 *   Ticket:   { id, status, userId, contactId, queueId, whatsappId,
 *               unreadMessages, lastMessage, isGroup, createdAt, updatedAt }
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
 * instante exato do aceite/transferência (isso existia via `metas` na
 * API interna, que não está disponível aqui) — então:
 *   - abertura: ticket.createdAt (confirmado)
 *   - encerramento: se status='closed', usa ticket.updatedAt (aproximação
 *     razoável — normalmente é a última coisa que aconteceu no ticket)
 *   - aceite: SEM sinal direto. Fallback: 1ª mensagem do escritório
 *     já classificada como não-bot (ver ehMensagemBot) — funciona bem
 *     porque a ingestão pega a maioria dos tickets ainda 'pending'.
 *   - transferência: NÃO DÁ pra detectar com a API pública sozinha (não
 *     existe histórico de mudança de fila com timestamp). Fica como
 *     limitação conhecida — precisaria de um diff entre execuções da
 *     ingestão (comparar queueId salvo vs. o novo) para aproximar.
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

  const primEsc = mensagens
    .filter(m => m.remetente === 'escritorio' && !m.is_bot)
    .sort((a, b) => new Date(a.hora) - new Date(b.hora))[0];
  if (primEsc) eventos.push({ tipo: 'aceite', hora: primEsc.hora });

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
    status: ticketZappy.status || null,
    nota_avaliacao: null, // não disponível na API pública (ver nota no topo do arquivo)
    eventos,
    mensagens,
  };
}

module.exports = { traduzirTicket, traduzirMensagem, extrairEventos, ehMensagemBot };
