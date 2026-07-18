'use strict';
/**
 * Pool Postgres FALSO, só para os testes de ingestão rodarem sem banco real.
 * Reconhece (por prefixo) exatamente as queries que ingestao.js/vinculos.js
 * emitem hoje. Se algum desses arquivos mudar a query, este mock também
 * precisa mudar — não é um SQL engine de verdade.
 */
function criarPoolFake({ clientesSeed = [], configSeed = {} } = {}) {
  const db = {
    cs_config: new Map(Object.entries(configSeed).map(([k, v]) => [k, { valor: v }])),
    cs_vinculos: new Map(), // telefone -> row
    clientes: clientesSeed,
    cs_tickets: new Map(),  // zappy_id -> row
    cs_mensagens: [],
  };
  let seq = 1;
  const uuid = () => `fake-uuid-${seq++}`;

  async function query(sql, params = []) {
    const s = sql.replace(/\s+/g, ' ').trim();

    if (s.startsWith('SELECT valor FROM cs_config')) {
      const row = db.cs_config.get(params[0]);
      return { rows: row ? [{ valor: row.valor }] : [] };
    }
    if (s.startsWith('INSERT INTO cs_config')) {
      const [chave, valor] = params;
      db.cs_config.set(chave, { valor });
      return { rows: [] };
    }
    if (s.startsWith('SELECT id, nome_empresa, cnpj FROM clientes')) {
      return { rows: db.clientes };
    }
    if (s.startsWith('SELECT * FROM cs_vinculos WHERE telefone')) {
      const row = db.cs_vinculos.get(params[0]);
      return { rows: row ? [row] : [] };
    }
    if (s.startsWith('INSERT INTO cs_vinculos')) {
      const [telefone, cliente_id, empresa_nome, cnpj, confianca] = params;
      let row = db.cs_vinculos.get(telefone);
      if (!row) {
        row = {
          id: uuid(), telefone, cliente_id, empresa_nome, cnpj,
          tipo: 'pendente', confianca, confirmado_por: null, confirmado_em: null,
        };
        db.cs_vinculos.set(telefone, row);
      }
      return { rows: [row] };
    }
    if (s.startsWith('UPDATE cs_vinculos')) {
      const [clienteId, empresaNome, cnpj, tipo, confirmadoPor, vinculoId] = params;
      for (const row of db.cs_vinculos.values()) {
        if (row.id === vinculoId) {
          Object.assign(row, { cliente_id: clienteId, empresa_nome: empresaNome, cnpj, tipo, confirmado_por: confirmadoPor, confirmado_em: new Date().toISOString() });
          return { rows: [row] };
        }
      }
      return { rows: [] };
    }
    if (s.startsWith('INSERT INTO cs_tickets')) {
      const [
        zappy_id, telefone, empresa_texto, vinculo_id, departamento, analista, status,
        abertura, aceite, transferencia, encerramento, nota_avaliacao, sla, em_risco, pior_status,
      ] = params;
      const existente = db.cs_tickets.get(zappy_id);
      const id = existente ? existente.id : uuid();
      db.cs_tickets.set(zappy_id, {
        id, zappy_id, telefone, empresa_texto, vinculo_id, departamento, analista, status,
        abertura, aceite, transferencia, encerramento, nota_avaliacao, sla, em_risco, pior_status,
      });
      return { rows: [{ id }] };
    }
    if (s.startsWith('INSERT INTO cs_mensagens')) {
      const [ticket_id, zappy_msg_id, remetente, autor, hora, texto] = params;
      const duplicada = zappy_msg_id != null && db.cs_mensagens.some(
        m => m.ticket_id === ticket_id && m.zappy_msg_id === zappy_msg_id
      );
      if (!duplicada) db.cs_mensagens.push({ ticket_id, zappy_msg_id, remetente, autor, hora, texto });
      return { rows: [] };
    }
    if (s.startsWith('SELECT * FROM cs_vinculos WHERE tipo')) {
      return { rows: [...db.cs_vinculos.values()].filter(r => r.tipo === 'pendente') };
    }

    throw new Error('poolFake: query não reconhecida (ajuste o mock): ' + s.slice(0, 100));
  }

  return { query, _db: db };
}

module.exports = { criarPoolFake };
