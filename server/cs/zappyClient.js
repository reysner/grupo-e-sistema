'use strict';
/**
 * Módulo Sucesso do Cliente — Cliente HTTP da API do Zappy Contábil
 * ------------------------------------------------------------------
 * Isola TODAS as chamadas de rede num único lugar, para que, quando a
 * documentação oficial do Zappy chegar (pendência 2 da Continuidade),
 * o ajuste seja só aqui — nada no resto do módulo muda.
 *
 * O QUE JÁ ESTÁ CONFIRMADO (seção 4 do handoff, testado com o ticket real
 * #46072):
 *   - GET {baseUrl}/tickets/:id                  -> dados do ticket
 *   - GET {baseUrl}/tickets/:id?pageNumber=N      -> { count, messages:[...] }
 *   - Autenticação: Authorization: Bearer <token>
 *
 * O QUE É HIPÓTESE (pendência 2 — a confirmar com o suporte do Zappy):
 *   A estrutura do ticket (queueId, botOptionId, botListId, metas,
 *   feedbackScaleUsed, rate, fromMe, ack, mediaType, responseSeconds) é
 *   IDÊNTICA à família de sistemas "Whaticket" (open source, muito usado
 *   como base white-label de multiatendimento WhatsApp no Brasil). Se o
 *   Zappy for um fork dessa base — o que os campos fortemente sugerem —
 *   o endpoint de LISTAGEM em lote (que falta pra ingestão) deve ser um
 *   destes dois padrões conhecidos dessa família:
 *
 *     (A) POST {baseUrl}/tickets/get
 *         body: { userId, queueIds, pageNumber, status, tags, date, updatedAt, searchParam }
 *         (padrão "Whaticket SaaS")
 *
 *     (B) GET {baseUrl}/tickets?pageNumber=N&status=...&searchParam=...&showAll=true&queueIds=[...]
 *         resposta: { tickets:[...], count, hasMore }
 *         (padrão "Whaticket Community")
 *
 *   Este cliente tenta (A) e, se dermos 404/405, cai para (B) — mas o
 *   ideal é a Thais perguntar direto ao suporte do Zappy (mensagem pronta
 *   no CONTINUIDADE_SUCESSO_DO_CLIENTE.md, seção 5) e travar em UM só.
 *
 * Configuração via variáveis de ambiente (Render → Environment):
 *   ZAPPY_BASE_URL  ex.: https://api.seudominio.zappy.com.br
 *   ZAPPY_TOKEN     Bearer token (NUNCA commitar no código/GitHub)
 */

function criarClienteZappy(opts = {}) {
  const baseUrl = (opts.baseUrl ?? process.env.ZAPPY_BASE_URL ?? '').replace(/\/+$/, '');
  const token = opts.token ?? process.env.ZAPPY_TOKEN;

  if (!baseUrl || !token) {
    // Não lança erro aqui: permite instanciar o módulo em testes/dry-run
    // sem credenciais. Só falha quando alguém tentar de fato chamar a rede.
  }

  async function chamar(path, init = {}) {
    if (!baseUrl || !token) {
      throw new Error(
        'zappyClient: faltam ZAPPY_BASE_URL/ZAPPY_TOKEN. Configure no Render → Environment.'
      );
    }
    const resp = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(init.headers || {}),
      },
    });
    if (!resp.ok) {
      const texto = await resp.text().catch(() => '');
      const err = new Error(`zappyClient: ${init.method || 'GET'} ${path} -> HTTP ${resp.status}`);
      err.status = resp.status;
      err.body = texto;
      throw err;
    }
    return resp.json();
  }

  /** CONFIRMADO — GET /tickets/:id */
  async function obterTicket(id) {
    return chamar(`/tickets/${id}`);
  }

  /**
   * CONFIRMADO — GET /tickets/:id?pageNumber=N -> { count, messages }
   * Pagina até esgotar (o Zappy pagina mensagens junto com o ticket).
   */
  async function obterMensagens(id) {
    const todas = [];
    let pageNumber = 1;
    // trava de segurança: nunca mais que 50 páginas por ticket (evita loop infinito
    // se a paginação real não bater com essa hipótese)
    for (; pageNumber <= 50; pageNumber++) {
      const resp = await chamar(`/tickets/${id}?pageNumber=${pageNumber}`);
      const pagina = resp.messages || [];
      todas.push(...pagina);
      if (!pagina.length || todas.length >= (resp.count ?? Infinity)) break;
    }
    return todas;
  }

  /**
   * HIPÓTESE (pendência 2) — lista tickets em lote.
   * Tenta o padrão (A) POST /tickets/get; se não existir, cai para (B) GET /tickets.
   * @param {object} filtros { pageNumber, status, queueIds, updatedAt }
   * @returns {{ tickets: Array, count: number, hasMore: boolean }}
   */
  async function listarTickets(filtros = {}) {
    const { pageNumber = 1, status = null, queueIds = null, updatedAt = null } = filtros;
    try {
      const resp = await chamar('/tickets/get', {
        method: 'POST',
        body: JSON.stringify({
          userId: null,
          queueIds: queueIds ?? null,
          pageNumber,
          status,
          tags: null,
          date: null,
          updatedAt,
          searchParam: null,
        }),
      });
      return normalizarListaTickets(resp);
    } catch (e) {
      if (e.status !== 404 && e.status !== 405) throw e;
      // fallback padrão (B)
      const qs = new URLSearchParams({ pageNumber: String(pageNumber), showAll: 'true' });
      if (status) qs.set('status', status);
      if (updatedAt) qs.set('updatedAt', updatedAt);
      if (queueIds) qs.set('queueIds', JSON.stringify(queueIds));
      const resp = await chamar(`/tickets?${qs.toString()}`);
      return normalizarListaTickets(resp);
    }
  }

  function normalizarListaTickets(resp) {
    return {
      tickets: resp.tickets || resp.data || [],
      count: resp.count ?? (resp.tickets || resp.data || []).length,
      hasMore: resp.hasMore ?? false,
    };
  }

  return { obterTicket, obterMensagens, listarTickets };
}

module.exports = { criarClienteZappy };
