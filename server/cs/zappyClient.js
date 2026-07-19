'use strict';
/**
 * Módulo Sucesso do Cliente — Cliente HTTP da API do Zappy Contábil
 * ------------------------------------------------------------------
 * PENDÊNCIA 2 RESOLVIDA nesta sessão: achamos a documentação OFICIAL
 * (Swagger/OpenAPI) publicada pelo próprio Zappy em
 * https://api-{subdominio}.zapcontabil.chat/api-docs — "API ZapContábil"
 * v2.1.0. Isso substitui a hipótese anterior (baseada em semelhança com
 * o Whaticket) por endpoints 100% confirmados.
 *
 * IMPORTANTE — a API pública é mais enxuta do que os campos vistos por
 * F12 dentro do próprio site do Zappy (aquilo é a API INTERNA do
 * front-end deles, autenticada por sessão/cookie, não pela chave de API
 * Bearer). A API pública (esta aqui) NÃO tem: `metas`, `rate`
 * (avaliação), `botOptionId`, nem objetos aninhados `queue`/`contact`
 * dentro do ticket — só os IDs (`queueId`, `contactId`, `userId`). Por
 * isso este cliente busca fila/usuário/contato à parte.
 *
 * Endpoints usados (todos confirmados no swagger.json):
 *   GET  /api/tickets?page=&pageSize=        -> { tickets, count, page, pageSize, pageCount }
 *   GET  /api/tickets/:id                    -> Ticket { id, status, userId, contactId, queueId, whatsappId, createdAt, updatedAt, ... }
 *   GET  /api/messages?ticketId=&page=&pageSize= -> { messages, count, ... } (MessageObject: fromMe, ack, mediaType, body, createdAt, ...)
 *   GET  /api/contacts/:id                   -> Contact { id, name, number, tags, ... }
 *   GET  /api/queues?page=&pageSize=         -> { queues: [{id, name, color}] }
 *   GET  /api/users?page=&pageSize=          -> { users: [{id, name, email, ...}] }
 *
 * Autenticação: Authorization: Bearer <ZAPPY_TOKEN> (scheme "bearer" confirmado no swagger).
 *
 * NÃO CONFIRMADO / NÃO EXISTE na API pública: avaliação (rate) do
 * atendimento e histórico de transferência de fila com timestamp exato.
 * Isso limita um pouco os relógios 2 (transferência) e a nota de
 * satisfação do PRD — ver nota na Continuidade.
 *
 * Configuração via variáveis de ambiente (Render → Environment):
 *   ZAPPY_BASE_URL  ex.: https://api-escritorial.zapcontabil.chat  (SEM /api no final)
 *   ZAPPY_TOKEN     Bearer token gerado em Zappy → Configurações → Conexões
 */

function criarClienteZappy(opts = {}) {
  const baseUrl = (opts.baseUrl ?? process.env.ZAPPY_BASE_URL ?? '').replace(/\/+$/, '');
  const token = opts.token ?? process.env.ZAPPY_TOKEN;

  async function chamar(path, init = {}) {
    if (!baseUrl || !token) {
      throw new Error('zappyClient: faltam ZAPPY_BASE_URL/ZAPPY_TOKEN. Configure no Render → Environment.');
    }
    // Timeout de segurança: sem isso, um fetch() que trava (Zappy não responde
    // nem dá erro) fica pendurado PARA SEMPRE — e como o backfill roda em
    // segundo plano numa Promise sem await, ele nunca solta a trava
    // `backfillEmAndamento` nem loga conclusão. 30s é generoso pra uma API
    // interna, mas corta qualquer travamento real.
    const controle = new AbortController();
    const timeoutId = setTimeout(() => controle.abort(), 30000);
    let resp;
    try {
      resp = await fetch(`${baseUrl}${path}`, {
        ...init,
        signal: controle.signal,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...(init.headers || {}),
        },
      });
    } catch (e) {
      if (e.name === 'AbortError') {
        throw new Error(`zappyClient: ${init.method || 'GET'} ${path} não respondeu em 30s (timeout).`);
      }
      throw e;
    } finally {
      clearTimeout(timeoutId);
    }
    // Lê como texto primeiro — nunca resp.json() direto. Se o caminho estiver
    // errado (ex.: sem o prefixo /api), o servidor pode devolver a página
    // HTML do site em vez de um erro estruturado, e isso dá um erro claro.
    const texto = await resp.text();
    let corpo;
    try {
      corpo = texto ? JSON.parse(texto) : {};
    } catch (e) {
      const err = new Error(
        `zappyClient: resposta de ${init.method || 'GET'} ${path} não é JSON (status HTTP ${resp.status}). ` +
        `Provável ZAPPY_BASE_URL errado ou o caminho não existe. Início da resposta: ${texto.slice(0, 150).replace(/\s+/g, ' ')}`
      );
      err.status = resp.status;
      err.notJson = true;
      err.body = texto;
      throw err;
    }
    if (!resp.ok) {
      const err = new Error(
        `zappyClient: ${init.method || 'GET'} ${path} -> HTTP ${resp.status}: ${corpo.message || corpo.error || texto.slice(0, 200)}`
      );
      err.status = resp.status;
      err.body = corpo;
      throw err;
    }
    return corpo;
  }

  /** GET /api/tickets/:id */
  async function obterTicket(id) {
    return chamar(`/api/tickets/${id}`);
  }

  /**
   * GET /api/tickets?page=&pageSize= — máx. 100 por página (limite do Zappy).
   * @returns {{ tickets: Array, count: number, page: number, pageSize: number, hasMore: boolean }}
   */
  async function listarTickets({ page = 1, pageSize = 100 } = {}) {
    const resp = await chamar(`/api/tickets?page=${page}&pageSize=${pageSize}`);
    const tickets = resp.tickets || [];
    const count = resp.count ?? tickets.length;
    const hasMore = page * pageSize < count;
    return { tickets, count, page: resp.page ?? page, pageSize: resp.pageSize ?? pageSize, hasMore };
  }

  /** GET /api/messages?ticketId=&page=&pageSize= — pagina até esgotar. */
  async function obterMensagens(ticketId) {
    const todas = [];
    let page = 1;
    const pageSize = 100;
    for (; page <= 50; page++) { // trava de segurança
      const resp = await chamar(`/api/messages?ticketId=${ticketId}&page=${page}&pageSize=${pageSize}`);
      const pagina = resp.messages || [];
      todas.push(...pagina);
      if (!pagina.length || todas.length >= (resp.count ?? Infinity)) break;
    }
    return todas;
  }

  /** GET /api/contacts/:id */
  async function obterContato(id) {
    return chamar(`/api/contacts/${id}`);
  }

  /**
   * GET /api/messages?dateFrom=&page=&pageSize= — SEM filtro de ticketId,
   * lista mensagens de TODOS os tickets a partir de uma data. Usado pra
   * descobrir rapidamente quais tickets tiveram atividade recente, em vez
   * de paginar a lista inteira de tickets (que no Grupo-E já passa de
   * 10.000 — listar tudo a cada execução seria lento e desnecessário).
   * `dateFrom` é só data (AAAA-MM-DD), a API não aceita hora.
   */
  async function listarMensagensRecentes({ dateFrom, page = 1, pageSize = 100 } = {}) {
    const qs = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (dateFrom) qs.set('dateFrom', dateFrom);
    const resp = await chamar(`/api/messages?${qs.toString()}`);
    const messages = resp.messages || [];
    const count = resp.count ?? messages.length;
    return { messages, count, hasMore: page * pageSize < count };
  }

  /** GET /api/queues?page=&pageSize= — usado pra montar o mapa id->nome do setor. */
  async function listarFilas() {
    const resp = await chamar(`/api/queues?page=1&pageSize=100`);
    return resp.queues || [];
  }

  /** GET /api/users?page=&pageSize= — usado pra montar o mapa id->nome do atendente. */
  async function listarUsuarios() {
    const resp = await chamar(`/api/users?page=1&pageSize=100`);
    return resp.users || [];
  }

  return {
    obterTicket, obterMensagens, listarTickets, obterContato, listarFilas, listarUsuarios,
    listarMensagensRecentes,
  };
}

module.exports = { criarClienteZappy };
