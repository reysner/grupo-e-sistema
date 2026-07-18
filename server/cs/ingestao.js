'use strict';
/**
 * Módulo Sucesso do Cliente — Job de Ingestão
 * ------------------------------------------------------------------
 * Busca tickets no Zappy, traduz (tradutorZappy), calcula SLA (slaEngine),
 * resolve o vínculo telefone→empresa (vinculos/depara) e grava em cs_*.
 *
 * Decisão do PRD: SEM carga retroativa. Na primeira execução, trava a
 * "data de início da coleta" em cs_config e nunca processa ticket
 * aberto (createdAt) antes disso — mesmo que a API devolva mais.
 *
 * Toda a lógica de orquestração está em `ingerirTickets()`, que recebe
 * zappyClient/pool por injeção — dá para testar com mocks, sem rede nem
 * banco real (ver testes_ingestao.js).
 */
const { traduzirTicket } = require('./tradutorZappy');
const { calcularSLA } = require('./slaEngine');
const { garantirVinculo } = require('./vinculos');

const CHAVE_DATA_INICIO = 'ingestao_data_inicio';
const CHAVE_ULTIMA_EXECUCAO = 'ingestao_ultima_execucao';

/** Lê (e trava, se ainda não existir) a data de início da coleta — sem carga retroativa. */
async function obterDataInicio(pool) {
  const { rows } = await pool.query('SELECT valor FROM cs_config WHERE chave = $1', [CHAVE_DATA_INICIO]);
  if (rows.length) return new Date(rows[0].valor);
  const agora = new Date();
  await pool.query(
    `INSERT INTO cs_config (chave, valor) VALUES ($1, $2) ON CONFLICT (chave) DO NOTHING`,
    [CHAVE_DATA_INICIO, agora.toISOString()]
  );
  return agora;
}

async function obterUltimaExecucao(pool) {
  const { rows } = await pool.query('SELECT valor FROM cs_config WHERE chave = $1', [CHAVE_ULTIMA_EXECUCAO]);
  return rows.length ? new Date(rows[0].valor) : null;
}

async function marcarUltimaExecucao(pool, quando) {
  await pool.query(
    `INSERT INTO cs_config (chave, valor, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor, updated_at = NOW()`,
    [CHAVE_ULTIMA_EXECUCAO, quando.toISOString()]
  );
}

/** Primeira hora (ISO) de um tipo de evento, ou null. */
function primeiraHoraPorTipo(eventos, tipo) {
  const achados = eventos.filter(e => e.tipo === tipo).sort((a, b) => new Date(a.hora) - new Date(b.hora));
  return achados.length ? achados[0].hora : null;
}

/**
 * Monta a linha pronta para UPSERT em cs_tickets a partir do ticket
 * traduzido + resultado do motor de SLA + vínculo resolvido.
 * Função PURA (sem I/O) — fácil de testar isolada.
 */
function montarLinhaTicket(generico, sla, vinculo) {
  return {
    zappy_id: generico.zappy_id,
    telefone: generico.telefone,
    empresa_texto: generico.empresa_texto,
    vinculo_id: vinculo ? vinculo.id : null,
    departamento: generico.departamento,
    analista: generico.analista,
    status: generico.status,
    abertura: primeiraHoraPorTipo(generico.eventos, 'abertura'),
    aceite: primeiraHoraPorTipo(generico.eventos, 'aceite'),
    transferencia: primeiraHoraPorTipo(generico.eventos, 'transferencia'),
    encerramento: primeiraHoraPorTipo(generico.eventos, 'encerramento'),
    nota_avaliacao: generico.nota_avaliacao,
    sla: JSON.stringify({ relogios: sla.relogios, radar: sla.radar }),
    em_risco: !!(sla.radar && sla.radar.status && sla.radar.status !== 'verde'),
    pior_status: sla.radar ? sla.radar.status : null,
  };
}

/** Grava (upsert) um ticket + suas mensagens. Retorna o id interno (uuid) do cs_tickets. */
async function persistirTicket(pool, linha, mensagens) {
  const { rows } = await pool.query(
    `INSERT INTO cs_tickets (
       zappy_id, telefone, empresa_texto, vinculo_id, departamento, analista, status,
       abertura, aceite, transferencia, encerramento, nota_avaliacao, sla, em_risco,
       pior_status, calculado_em
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, NOW())
     ON CONFLICT (zappy_id) DO UPDATE SET
       telefone = EXCLUDED.telefone,
       empresa_texto = EXCLUDED.empresa_texto,
       vinculo_id = EXCLUDED.vinculo_id,
       departamento = EXCLUDED.departamento,
       analista = EXCLUDED.analista,
       status = EXCLUDED.status,
       abertura = EXCLUDED.abertura,
       aceite = EXCLUDED.aceite,
       transferencia = EXCLUDED.transferencia,
       encerramento = EXCLUDED.encerramento,
       nota_avaliacao = EXCLUDED.nota_avaliacao,
       sla = EXCLUDED.sla,
       em_risco = EXCLUDED.em_risco,
       pior_status = EXCLUDED.pior_status,
       calculado_em = NOW(),
       updated_at = NOW()
     RETURNING id`,
    [
      linha.zappy_id, linha.telefone, linha.empresa_texto, linha.vinculo_id,
      linha.departamento, linha.analista, linha.status, linha.abertura, linha.aceite,
      linha.transferencia, linha.encerramento, linha.nota_avaliacao, linha.sla,
      linha.em_risco, linha.pior_status,
    ]
  );
  const ticketId = rows[0].id;

  for (const m of mensagens) {
    await pool.query(
      `INSERT INTO cs_mensagens (ticket_id, zappy_msg_id, remetente, autor, hora, texto)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (ticket_id, zappy_msg_id) DO NOTHING`,
      [ticketId, m.zappy_msg_id, m.is_bot ? 'sistema' : m.remetente, null, m.hora, m.texto]
    );
  }
  return ticketId;
}

/**
 * Ingesta uma leva de tickets. Injeção de dependências para permitir teste
 * com mocks (zappyClient e pool falsos) sem rede nem Postgres reais.
 *
 * @param {object} deps
 * @param {object} deps.zappyClient  ver zappyClient.js (criarClienteZappy)
 * @param {object} deps.pool         pool pg (ou compatível com .query())
 * @param {Date}   [deps.agora]      instante de referência p/ SLA (default: now)
 * @param {number} [deps.maxPaginas] trava de segurança de paginação (default 100)
 * @returns {{processados: number, ignoradosPreDataInicio: number, erros: Array}}
 */
async function ingerirTickets({ zappyClient, pool, agora = new Date(), maxPaginas = 100 }) {
  const dataInicio = await obterDataInicio(pool);

  // Fila/usuário não vêm no ticket (a API pública só dá o ID) — busca uma
  // vez por execução e monta um mapa id->nome. Baixo volume (poucas
  // dezenas de filas/usuários), então cabe tudo numa página de 100.
  const [filas, usuarios] = await Promise.all([
    zappyClient.listarFilas().catch(() => []),
    zappyClient.listarUsuarios().catch(() => []),
  ]);
  const filaMap = Object.fromEntries(filas.map(f => [String(f.id), f.name]));
  const usuarioMap = Object.fromEntries(usuarios.map(u => [String(u.id), u.name]));
  const contatoCache = new Map(); // contactId -> contato (evita buscar 2x na mesma execução)

  let processados = 0;
  let ignoradosPreDataInicio = 0;
  const erros = [];

  let page = 1;
  let hasMore = true;
  while (hasMore && page <= maxPaginas) {
    const resp = await zappyClient.listarTickets({ page, pageSize: 100 });
    const tickets = resp.tickets || [];
    hasMore = !!resp.hasMore && tickets.length > 0;

    for (const ticketZappy of tickets) {
      try {
        // Sem carga retroativa: nunca processa ticket aberto antes do go-live,
        // mesmo que a API devolva (reabertura de ticket antigo, por ex.).
        if (ticketZappy.createdAt && new Date(ticketZappy.createdAt) < dataInicio) {
          ignoradosPreDataInicio++;
          continue;
        }

        let contato = null;
        if (ticketZappy.contactId != null) {
          const cid = String(ticketZappy.contactId);
          if (contatoCache.has(cid)) {
            contato = contatoCache.get(cid);
          } else {
            contato = await zappyClient.obterContato(ticketZappy.contactId).catch(() => null);
            contatoCache.set(cid, contato);
          }
        }

        const contexto = {
          contato,
          filaNome: filaMap[String(ticketZappy.queueId)] || null,
          analistaNome: usuarioMap[String(ticketZappy.userId)] || null,
        };

        const mensagensZappy = await zappyClient.obterMensagens(ticketZappy.id);
        const generico = traduzirTicket(ticketZappy, mensagensZappy, contexto);
        const sla = calcularSLA(generico, agora);

        const vinculo = await garantirVinculo(pool, {
          nome: contato ? contato.name : null,
          telefone: contato ? contato.number : null,
          tags: contato ? contato.tags : null,
        });

        const linha = montarLinhaTicket(generico, sla, vinculo);
        await persistirTicket(pool, linha, generico.mensagens);
        processados++;
      } catch (e) {
        erros.push({ ticketId: ticketZappy && ticketZappy.id, erro: e.message });
      }
    }
    page++;
  }

  await marcarUltimaExecucao(pool, agora);
  return { processados, ignoradosPreDataInicio, erros };
}

// ── Execução direta: `node server/cs/ingestao.js` ───────────────────────────
if (require.main === module) {
  (async () => {
    const { criarClienteZappy } = require('./zappyClient');
    const { obterPool } = require('./pool');
    const pool = obterPool();
    const zappyClient = criarClienteZappy();
    const resultado = await ingerirTickets({ zappyClient, pool });
    console.log('Ingestão concluída:', resultado);
    process.exit(resultado.erros.length ? 1 : 0);
  })().catch(e => {
    console.error('Falha na ingestão:', e);
    process.exit(1);
  });
}

module.exports = {
  ingerirTickets,
  montarLinhaTicket,
  primeiraHoraPorTipo,
  obterDataInicio,
  obterUltimaExecucao,
};
