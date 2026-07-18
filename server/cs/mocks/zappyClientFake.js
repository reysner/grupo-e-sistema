'use strict';
/** Cliente Zappy FALSO — devolve tickets/mensagens fixos, sem rede. */
function criarClienteFake({ tickets = [], mensagensPorId = {} } = {}) {
  return {
    async listarTickets({ pageNumber }) {
      if (pageNumber > 1) return { tickets: [], count: 0, hasMore: false };
      return { tickets, count: tickets.length, hasMore: false };
    },
    async obterMensagens(id) {
      return mensagensPorId[id] || [];
    },
  };
}
module.exports = { criarClienteFake };
