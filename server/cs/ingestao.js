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
const { calcularSLA, calcularTrocas } = require('./slaEngine');
const { garantirVinculo } = require('./vinculos');
const { ensurePontuacaoSchema, recalcularPontosPendentes, persistirPontosTicket } = require('./pontuacao');

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
 * Detecta a TRANSFERÊNCIA por diferença entre coletas — a API pública do
 * Zappy não manda um histórico de troca de fila/responsável, só o dono
 * atual (ver nota em tradutorZappy.js). Então, a cada execução periódica
 * (a cada 5 min), comparamos o analista resolvido AGORA com o que estava
 * salvo na última vez que vimos esse ticket:
 *   - Se mudou de um analista JÁ definido pra outro analista -> é uma
 *     transferência de verdade (ex.: Elma aceitou e passou pra Maria
 *     Eduarda) -> marca `agora` como o instante aproximado (precisão
 *     limitada ao intervalo entre execuções).
 *   - Se já tinha uma transferência detectada antes, mantém a mesma hora
 *     (não fica "andando" a cada nova execução).
 *   - Se é a primeira vez que vemos o ticket, ou se o analista só saiu de
 *     "ninguém" pra alguém (isso é ACEITE, não transferência), não marca nada.
 * Limitação: só funciona pra transferências que aconteçam DEPOIS que esse
 * código foi ligado — não há como reconstruir isso pro passado.
 */
async function resolverHoraTransferencia(pool, zappyId, analistaNovo, agora) {
  const { rows } = await pool.query(
    `SELECT analista, analista_id, analista_anterior, analista_anterior_id, transferencia FROM cs_tickets WHERE zappy_id = $1`,
    [zappyId]
  );
  if (!rows.length) return null;
  const existente = rows[0];
  if (existente.transferencia) {
    // Já detectado antes — mantém tudo fixo (hora e quem transferiu), não
    // "anda" a cada nova execução nem troca de dono a cada re-transferência.
    return { hora: existente.transferencia, analistaAnterior: existente.analista_anterior, analistaAnteriorId: existente.analista_anterior_id };
  }
  if (existente.analista && analistaNovo && analistaNovo !== existente.analista) {
    return { hora: agora.toISOString(), analistaAnterior: existente.analista, analistaAnteriorId: existente.analista_id };
  }
  return null;
}

/**
 * Monta a linha pronta para UPSERT em cs_tickets a partir do ticket
 * traduzido + resultado do motor de SLA + vínculo resolvido.
 * Função PURA (sem I/O) — fácil de testar isolada.
 * `trocas` (opcional) = calcularTrocas(generico.mensagens) — tempo de
 * resposta em CADA turno do cliente, não só o primeiro (ver slaEngine.js).
 * `trocasPosTransferencia` (opcional) = a MESMA coisa, mas só contando
 * mensagens depois da transferência — é o que separa o trabalho de quem
 * aceita/transfere (ex.: recepção do Sucesso do Cliente) do trabalho de
 * quem recebe o ticket transferido (o analista de fato responsável pelo
 * atendimento dali em diante). Sem isso, um ticket aceito pela recepção e
 * depois transferido pra um analista jogaria o tempo de resposta da
 * recepção na conta do analista.
 */
function montarLinhaTicket(generico, sla, vinculo, trocas = null, trocasPosTransferencia = null) {
  return {
    zappy_id: generico.zappy_id,
    telefone: generico.telefone,
    empresa_texto: generico.empresa_texto,
    vinculo_id: vinculo ? vinculo.id : null,
    departamento: generico.departamento,
    analista: generico.analista,
    analista_id: generico.analista_id || null,
    analista_anterior: generico.analista_anterior || null,
    analista_anterior_id: generico.analista_anterior_id || null,
    status: generico.status,
    abertura: primeiraHoraPorTipo(generico.eventos, 'abertura'),
    aceite: primeiraHoraPorTipo(generico.eventos, 'aceite'),
    transferencia: primeiraHoraPorTipo(generico.eventos, 'transferencia'),
    encerramento: primeiraHoraPorTipo(generico.eventos, 'encerramento'),
    nota_avaliacao: generico.nota_avaliacao,
    sla: JSON.stringify({
      relogios: sla.relogios,
      radar: sla.radar,
      trocas: trocas || [],
      trocasPosTransferencia: trocasPosTransferencia || [],
    }),
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
       pior_status, analista_id, analista_anterior, analista_anterior_id, calculado_em
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18, NOW())
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
       analista_id = EXCLUDED.analista_id,
       analista_anterior = EXCLUDED.analista_anterior,
       analista_anterior_id = EXCLUDED.analista_anterior_id,
       calculado_em = NOW(),
       updated_at = NOW()
     RETURNING id`,
    [
      linha.zappy_id, linha.telefone, linha.empresa_texto, linha.vinculo_id,
      linha.departamento, linha.analista, linha.status, linha.abertura, linha.aceite,
      linha.transferencia, linha.encerramento, linha.nota_avaliacao, linha.sla,
      linha.em_risco, linha.pior_status, linha.analista_id, linha.analista_anterior, linha.analista_anterior_id,
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

/** Formata uma Date como AAAA-MM-DD (a API só filtra mensagens por dia, não por hora). */
function paraDataAPI(d) {
  return d.toISOString().slice(0, 10);
}

/**
 * Descobre quais tickets tiveram mensagem a partir de `dateFrom`, usando
 * GET /api/messages (que aceita filtro de data) em vez de paginar TODOS
 * os tickets. Essencial aqui: o Grupo-E já passa de 10.000 tickets no
 * histórico — listar tudo a cada execução seria lento e desnecessário,
 * já que só uns 20/dia têm mensagem nova.
 */
async function descobrirTicketsComAtividade(zappyClient, dateFrom, maxPaginas) {
  const ticketIds = new Set();
  let page = 1;
  let hasMore = true;
  while (hasMore && page <= maxPaginas) {
    const resp = await zappyClient.listarMensagensRecentes({ dateFrom, page, pageSize: 100 });
    for (const m of resp.messages || []) {
      if (m.ticketId != null) ticketIds.add(String(m.ticketId));
    }
    hasMore = resp.hasMore;
    page++;
  }
  return [...ticketIds];
}

/**
 * Ingesta os tickets com atividade recente. Injeção de dependências para
 * permitir teste com mocks (zappyClient e pool falsos) sem rede nem
 * Postgres reais.
 *
 * @param {object} deps
 * @param {object} deps.zappyClient  ver zappyClient.js (criarClienteZappy)
 * @param {object} deps.pool         pool pg (ou compatível com .query())
 * @param {Date}   [deps.agora]      instante de referência p/ SLA (default: now)
 * @param {number} [deps.maxPaginas] trava de segurança de paginação (default 100)
 * @param {string} [deps.dateFromForcado] AAAA-MM-DD — ignora o cursor normal (ultimaExecucao/dataInicio)
 *   e busca atividade a partir dessa data. Usado só pela carga retroativa (ver executarCargaRetroativa).
 * @returns {{processados: number, ignoradosPreDataInicio: number, erros: Array, ticketsComAtividade: number}}
 */
async function ingerirTickets({ zappyClient, pool, agora = new Date(), maxPaginas = 100, dateFromForcado = null }) {
  await ensurePontuacaoSchema(pool);
  const dataInicio = await obterDataInicio(pool);
  const ultimaExecucao = await obterUltimaExecucao(pool);
  // Um dia de folga pra trás, pra não perder mensagem que chegou perto da virada do dia
  // (a API só filtra por dia, não por hora).
  const cursor = ultimaExecucao && ultimaExecucao > dataInicio ? ultimaExecucao : dataInicio;
  const dateFrom = dateFromForcado || paraDataAPI(cursor);

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

  const ticketIds = await descobrirTicketsComAtividade(zappyClient, dateFrom, maxPaginas);

  for (const ticketId of ticketIds) {
    let ticketZappy = null;
    try {
      ticketZappy = await zappyClient.obterTicket(ticketId);

      // Sem carga retroativa: nunca processa ticket aberto antes do go-live,
      // mesmo que tenha tido mensagem nova (ex.: reabertura de ticket antigo).
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

      // Transferência detectada por diferença entre coletas (ver resolverHoraTransferencia acima).
      const transferenciaInfo = await resolverHoraTransferencia(pool, generico.zappy_id, generico.analista, agora);
      const horaTransferencia = transferenciaInfo ? transferenciaInfo.hora : null;
      if (horaTransferencia) generico.eventos.push({ tipo: 'transferencia', hora: horaTransferencia });
      generico.analista_anterior = transferenciaInfo ? transferenciaInfo.analistaAnterior : null;
      generico.analista_anterior_id = transferenciaInfo ? transferenciaInfo.analistaAnteriorId : null;

      const sla = calcularSLA(generico, agora);
      const trocas = calcularTrocas(generico.mensagens, agora);
      const mensagensPosTransferencia = horaTransferencia
        ? generico.mensagens.filter(m => new Date(m.hora) > new Date(horaTransferencia))
        : [];
      const trocasPosTransferencia = calcularTrocas(mensagensPosTransferencia, agora);

      const vinculo = await garantirVinculo(pool, {
        nome: contato ? contato.name : null,
        telefone: contato ? contato.number : null,
        tags: contato ? contato.tags : null,
      });

      const linha = montarLinhaTicket(generico, sla, vinculo, trocas, trocasPosTransferencia);
      await persistirTicket(pool, linha, generico.mensagens);
      processados++;
    } catch (e) {
      erros.push({ ticketId: ticketZappy ? ticketZappy.id : ticketId, erro: e.message });
    }
  }

  await marcarUltimaExecucao(pool, agora);

  // Preenche "trocas" (resposta em toda a conversa) em tickets antigos que
  // ainda não têm esse campo — SEM chamar o Zappy de novo, só reprocessando
  // mensagens já salvas em cs_mensagens. Roda um pouquinho a cada execução
  // (a cada 5 min) até alcançar todo o histórico. Falha aqui não deve
  // derrubar o resultado da ingestão normal.
  let trocasPreenchidas = 0;
  try {
    trocasPreenchidas = await preencherTrocasPendentes(pool, { agora });
  } catch (e) {
    console.error('[CS] preencherTrocasPendentes falhou (ingestão normal seguiu OK):', e.message);
  }

  // Pontuação automática da Gamificação (Modelo Atualizado) — calcula/atualiza
  // gam_tickets_pontos pra tickets que já têm nota do cliente (`rate`) e ainda
  // não foram pontuados. Mesmo espírito de preencherTrocasPendentes: lote
  // pequeno a cada ciclo, sem chamar o Zappy de novo, falha isolada não
  // derruba a ingestão normal.
  let pontuacao = { candidatos: 0, processados: 0 };
  try {
    pontuacao = await recalcularPontosPendentes(pool, { limite: 100 });
  } catch (e) {
    console.error('[CS] recalcularPontosPendentes falhou (ingestão normal seguiu OK):', e.message);
  }

  return { processados, ignoradosPreDataInicio, erros, ticketsComAtividade: ticketIds.length, trocasPreenchidas, pontuacao };
}

/**
 * Preenche os campos `trocas` e `trocasPosTransferencia` (ver
 * slaEngine.calcularTrocas) em tickets que já foram ingeridos mas ainda não
 * têm essas métricas — normal logo após o deploy de cada uma dessas
 * funcionalidades, já que não existiam antes. Usa só dados JÁ salvos
 * (cs_mensagens + a coluna `transferencia` do próprio ticket), sem depender
 * do Zappy, então é rápido e seguro de rodar a cada execução periódica.
 * Processa em lotes pequenos (`limite`) pra não pesar a execução normal.
 *
 * @param {object} pool
 * @param {object} [opts]
 * @param {Date}   [opts.agora]
 * @param {number} [opts.limite]  quantos tickets tenta por execução (default 50)
 * @returns {number} quantos tickets foram atualizados nesta chamada
 */
async function preencherTrocasPendentes(pool, { agora = new Date(), limite = 50 } = {}) {
  const { rows: pendentes } = await pool.query(
    `SELECT id, sla, transferencia FROM cs_tickets WHERE sla->'trocas' IS NULL OR sla->'trocasPosTransferencia' IS NULL ORDER BY abertura DESC NULLS LAST LIMIT $1`,
    [limite]
  );
  let atualizados = 0;
  for (const ticket of pendentes) {
    const { rows: mensagens } = await pool.query(
      `SELECT remetente, hora FROM cs_mensagens WHERE ticket_id = $1 ORDER BY hora ASC`,
      [ticket.id]
    );
    const slaAtual = typeof ticket.sla === 'string' ? JSON.parse(ticket.sla || '{}') : (ticket.sla || {});
    const trocas = slaAtual.trocas != null ? slaAtual.trocas : calcularTrocas(mensagens, agora);
    let trocasPosTransferencia = slaAtual.trocasPosTransferencia;
    if (trocasPosTransferencia == null) {
      const mensagensPosTransferencia = ticket.transferencia
        ? mensagens.filter(m => new Date(m.hora) > new Date(ticket.transferencia))
        : [];
      trocasPosTransferencia = calcularTrocas(mensagensPosTransferencia, agora);
    }
    const novoSla = JSON.stringify({ ...slaAtual, trocas, trocasPosTransferencia });
    await pool.query(`UPDATE cs_tickets SET sla = $1, updated_at = NOW() WHERE id = $2`, [novoSla, ticket.id]);
    atualizados++;
  }
  return atualizados;
}

/**
 * Recalcula os relógios de SLA de TODOS os tickets já salvos, usando o
 * calcularSLA() ATUAL (não a versão do motor que estava rodando quando cada
 * ticket foi ingerido pela primeira vez). Necessário sempre que a fórmula de
 * SLA muda (ex.: ajuste pros tickets #46296/#46251/#45963 — Aceite não
 * distinguia ticket aberto pelo escritório, e o "fim" caía em `agora`
 * quando faltava o evento formal de aceite). Sem isso, os tickets antigos
 * continuam com o valor calculado pela fórmula VELHA guardado pra sempre em
 * cs_tickets.sla — o Dashboard só LÊ o que já está salvo, não recalcula na
 * hora que a página é aberta.
 *
 * NÃO chama o Zappy — usa só o que já está salvo em cs_tickets/cs_mensagens,
 * então é rápido e seguro de rodar quantas vezes precisar. Pagina por id
 * (keyset, não OFFSET) pra aguentar milhares de tickets sem degradar.
 *
 * @param {object} pool
 * @param {object} [opts]
 * @param {Date}   [opts.agora]
 * @param {number} [opts.loteSize]  quantos tickets por lote (default 300)
 * @returns {number} total de tickets recalculados
 */
async function recalcularSlaTodos(pool, { agora = new Date(), loteSize = 300, onProgress = null, mes = null } = {}) {
  let totalRecalculados = 0;
  let ultimoId = '00000000-0000-0000-0000-000000000000';

  // `mes` (opcional, "AAAA-MM") restringe aos tickets daquele mês (por
  // encerramento, ou abertura se ainda não fechou) — pedido do Reysner: o
  // recálculo de TODO o histórico (~4000 tickets) vinha travando antes de
  // terminar, mais de uma vez, no plano gratuito do Render. Como o que
  // importa pra Gamificação é só o mês corrente, limitar o escopo evita
  // reprocessar meses inteiros que não vão ser usados de qualquer forma.
  // Sem `mes`, mantém o comportamento antigo (recalcula tudo). Validado com
  // regex (não é so-anti-injection: um valor errado aqui simplesmente não
  // bate com TO_CHAR nenhum e o filtro vira "não recalcula nada").
  if (mes != null && !/^\d{4}-\d{2}$/.test(mes)) throw new Error('mes deve estar no formato AAAA-MM');
  const condicaoMes = mes ? `AND TO_CHAR(COALESCE(encerramento, abertura), 'YYYY-MM') = $1` : '';
  const paramsMes = mes ? [mes] : [];

  // Pra status/progresso (ver GET /recalcular-sla/status) — pedido do
  // Reysner depois de perder a conta de quantas vezes o recálculo (que leva
  // mais de 1h com o volume atual) já tinha reiniciado sem querer, porque a
  // única forma de checar era tentando disparar de novo.
  const { rows: totalRows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM cs_tickets WHERE TRUE ${condicaoMes}`,
    paramsMes
  );
  const totalGeral = totalRows[0]?.n || 0;
  if (onProgress) onProgress({ processados: 0, total: totalGeral });

  for (;;) {
    const { rows: lote } = await pool.query(
      `SELECT id, zappy_id, empresa_texto, abertura, aceite, transferencia, encerramento
         FROM cs_tickets
        WHERE id > $1 ${mes ? `AND TO_CHAR(COALESCE(encerramento, abertura), 'YYYY-MM') = $3` : ''}
        ORDER BY id ASC
        LIMIT $2`,
      mes ? [ultimoId, loteSize, mes] : [ultimoId, loteSize]
    );
    if (!lote.length) break;

    for (const ticket of lote) {
      const eventos = [];
      if (ticket.abertura) eventos.push({ tipo: 'abertura', hora: ticket.abertura });
      if (ticket.aceite) eventos.push({ tipo: 'aceite', hora: ticket.aceite });
      if (ticket.transferencia) eventos.push({ tipo: 'transferencia', hora: ticket.transferencia });
      if (ticket.encerramento) eventos.push({ tipo: 'encerramento', hora: ticket.encerramento });

      const { rows: mensagens } = await pool.query(
        `SELECT remetente, hora, texto FROM cs_mensagens WHERE ticket_id = $1 ORDER BY hora ASC`,
        [ticket.id]
      );

      const generico = { id: ticket.zappy_id, empresa_texto: ticket.empresa_texto, eventos, mensagens };
      const sla = calcularSLA(generico, agora);
      const trocas = calcularTrocas(mensagens, agora);
      const mensagensPosTransferencia = ticket.transferencia
        ? mensagens.filter(m => new Date(m.hora) > new Date(ticket.transferencia))
        : [];
      const trocasPosTransferencia = calcularTrocas(mensagensPosTransferencia, agora);

      const novoSla = JSON.stringify({
        relogios: sla.relogios,
        radar: sla.radar,
        trocas,
        trocasPosTransferencia,
      });
      const emRisco = !!(sla.radar && sla.radar.status && sla.radar.status !== 'verde');
      const piorStatus = sla.radar ? sla.radar.status : null;

      await pool.query(
        `UPDATE cs_tickets SET sla = $1, em_risco = $2, pior_status = $3, calculado_em = NOW(), updated_at = NOW() WHERE id = $4`,
        [novoSla, emRisco, piorStatus, ticket.id]
      );
      totalRecalculados++;
    }

    ultimoId = lote[lote.length - 1].id;
    if (onProgress) onProgress({ processados: totalRecalculados, total: totalGeral });
  }

  return totalRecalculados;
}

/**
 * Carga retroativa ÚNICA: reabre a "data de início da coleta" pra trás (nunca
 * pra frente — nunca esconde ticket já coletado) e roda a ingestão buscando
 * atividade desde essa nova data, em vez de só a partir da última execução.
 *
 * Uso pontual (ex.: botão admin "Carregar últimos 90 dias"), não roda
 * automaticamente. Como pode envolver bem mais tickets que a rodagem normal
 * de 5 em 5 min, quem chama isso deve considerar rodar em segundo plano
 * (ver server/cs/routes.js POST /backfill) em vez de esperar a resposta.
 *
 * @param {object} deps
 * @param {object} deps.zappyClient
 * @param {object} deps.pool
 * @param {number} [deps.dias]        quantos dias pra trás (default 90)
 * @param {Date}   [deps.agora]
 * @param {number} [deps.maxPaginas]  trava de paginação — maior que o default
 *   normal porque 90 dias tem bem mais mensagens que os ~5 min de uma rodagem comum.
 */
async function executarCargaRetroativa({ zappyClient, pool, dias = 90, agora = new Date(), maxPaginas = 500 }) {
  const dataInicioAtual = await obterDataInicio(pool);
  const novaDataInicio = new Date(agora.getTime() - dias * 24 * 60 * 60 * 1000);

  if (novaDataInicio < dataInicioAtual) {
    await pool.query(
      `UPDATE cs_config SET valor = $1, updated_at = NOW() WHERE chave = $2`,
      [novaDataInicio.toISOString(), CHAVE_DATA_INICIO]
    );
  }

  const dataEfetiva = novaDataInicio < dataInicioAtual ? novaDataInicio : dataInicioAtual;
  return ingerirTickets({ zappyClient, pool, agora, maxPaginas, dateFromForcado: paraDataAPI(dataEfetiva) });
}

/**
 * Atualiza a nota (rate) de tickets JÁ CONHECIDOS que fecharam há poucos
 * dias mas ainda estão sem avaliação — mais leve e confiável que o backfill
 * de 90 dias (que depende de descobrir atividade via /api/messages, varrendo
 * milhares de mensagens). Aqui é direto: já sabemos o zappy_id de cada
 * ticket candidato (está em cs_tickets), então só rebusca CADA UM
 * individualmente em GET /api/tickets/:id pra ver se o cliente avaliou
 * desde a última vez. O cliente pode demorar horas/dias pra responder a
 * pesquisa, então um ticket fechado ontem (D-1) pode não ter nota hoje e
 * ganhar amanhã — por isso essa função roda todo dia (ver rodarAtualizacaoNotasCS
 * em index.js), sempre olhando os últimos `dias`, não só o D-1 exato.
 *
 * @param {object} deps
 * @param {object} deps.zappyClient
 * @param {object} deps.pool
 * @param {number} [deps.dias]    quantos dias pra trás olhar (default 5 —
 *   cobre o D-1 pedido pelo Reysner com uma folga pra cliente que demora a responder)
 * @param {number} [deps.limite]  trava de segurança de quantos tickets rebusca por vez
 * @returns {{candidatos: number, atualizados: number, erros: Array}}
 */
async function atualizarNotasPendentes({ zappyClient, pool, dias = 5, limite = 500 }) {
  const cutoff = new Date(Date.now() - dias * 24 * 60 * 60 * 1000);
  const { rows: candidatos } = await pool.query(
    `SELECT id, zappy_id FROM cs_tickets
     WHERE status = 'closed' AND nota_avaliacao IS NULL
       AND encerramento IS NOT NULL AND encerramento >= $1
     ORDER BY encerramento DESC
     LIMIT $2`,
    [cutoff.toISOString(), limite]
  );

  let atualizados = 0;
  const erros = [];
  for (const c of candidatos) {
    try {
      const ticketZappy = await zappyClient.obterTicket(c.zappy_id);
      if (ticketZappy.rate == null) continue; // cliente ainda não avaliou — tenta de novo amanhã
      await pool.query(
        `UPDATE cs_tickets SET nota_avaliacao = $1, updated_at = NOW() WHERE id = $2`,
        [Number(ticketZappy.rate), c.id]
      );
      await persistirPontosTicket(pool, c.id); // pontua na hora, não espera o próximo ciclo de ingestão
      atualizados++;
    } catch (e) {
      erros.push({ zappyId: c.zappy_id, erro: e.message });
    }
  }
  return { candidatos: candidatos.length, atualizados, erros };
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
  executarCargaRetroativa,
  montarLinhaTicket,
  primeiraHoraPorTipo,
  obterDataInicio,
  obterUltimaExecucao,
  preencherTrocasPendentes,
  resolverHoraTransferencia,
  recalcularSlaTodos,
  atualizarNotasPendentes,
};
