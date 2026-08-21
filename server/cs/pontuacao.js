'use strict';
/**
 * Módulo Sucesso do Cliente — Pontuação automática por ticket (Gamificação)
 * ------------------------------------------------------------------------
 * "Modelo Atualizado" da Liga do Atendimento: calcula a nota de cada
 * analista TICKET A TICKET (não mais só a média mensal digitada à mão),
 * usando dados que já são coletados pela ingestão (cs_tickets/cs_mensagens)
 * + o campo `rate` (confirmado com o suporte do Zappy em 20/08/2026, fora
 * do swagger.json — ver nota em zappyClient.js).
 *
 * Regra geral (definida pelo Reysner, ver print da "As 4 métricas de
 * pontuação"): a nota do cliente é atribuída só a quem ENCERRA o
 * atendimento — NotaFinal = Avaliação do cliente + ajustes das métricas,
 * limitado a 5 pontos (soma simples, depois teto). Quem só TRANSFERE não
 * recebe a nota do cliente: o resultado dele naquele ticket é só o ajuste
 * de velocidade puro (+2/+1/−1), sem nota nem teto de 5 envolvidos.
 *
 * Um ticket pode gerar ATÉ 2 linhas de pontuação — uma pra quem transferiu
 * (só o ajuste de velocidade, avulso) e uma pra quem recebeu/resolveu
 * sozinho (nota do cliente + métricas 1+2+4, capada em 5).
 *
 * Média mensal (ver auto-preencher em data.js): só conta pontos de quem
 * TRANSFERIU se o analista também tiver pelo menos 1 nota real de cliente
 * (papel recebeu/unico) no mês — aí soma o bônus acumulado de velocidade na
 * média das notas, capado em 5. Sem nenhuma nota real, o bônus de
 * transferência fica "banco" e o analista continua sem nota nesse mês
 * (mesmo comportamento de "sem avaliação" que já existe pro resto do
 * sistema) — combinado com o Reysner: "o analista não teve avaliações, mas
 * transferiu rapidamente, permanece sem nota".
 *
 * SUPOSIÇÕES ASSUMIDAS (sem dado real pra confirmar ainda — avisar o
 * Reysner e ajustar se a calibração real mostrar outra coisa):
 *   - Métrica 2 (/Finalizar): olha a ÚLTIMA mensagem do escritório antes do
 *     encerramento do ticket.
 *   - Métrica 4 (reabertura): usa `encerramento` do ticket como o instante
 *     em que a pesquisa foi enviada (não temos o evento exato da pesquisa
 *     ainda) — se o CLIENTE mandar mensagem nos 30min seguintes e essa
 *     mensagem não for só um número de 1 a 5 (a própria nota), conta como
 *     "preso no processo" (-1). Sem reabertura = sem alteração (não dá
 *     bônus, só evita a penalidade — assim que o print definiu).
 */
// ── Detector de finalização correta (métrica 2) ─────────────────────────────
// Mesmo estilo de FRASES_TRANSFERENCIA/FRASES_AGUARDANDO_CLIENTE em
// slaEngine.js — calibrado com o exemplo real dado pelo Reysner ("Estou
// finalizando o atendimento. Fico à disposição para qualquer dúvida ou
// nova solicitação"). Lista pra crescer com exemplo real, não pra ficar
// fechada.
const FRASES_FINALIZAR = [
  'estou finalizando o atendimento',
  'vou finalizar o atendimento',
  'finalizando o atendimento',
  'finalizando seu atendimento',
  'finalizando esse atendimento',
  'vou encerrar o atendimento',
  'encerrando o atendimento',
  'encerrando seu atendimento',
  'esse atendimento sera encerrado',
  'este atendimento sera encerrado',
  'fico a disposicao para qualquer duvida',
  'fico a disposicao para qualquer duvida ou nova solicitacao',
  'qualquer duvida ou nova solicitacao',
  'qualquer duvida estamos a disposicao',
  'qualquer duvida, estou a disposicao',
  'a disposicao para novas solicitacoes',
  'ate a proxima',
  'tenha um otimo dia',
  'tenha uma otima semana',
];

function normalizarTexto(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** true se o texto parece uma mensagem de encerramento correta (métrica 2). */
function pareceFinalizacaoCorreta(texto) {
  const t = normalizarTexto(texto);
  if (!t) return false;
  return FRASES_FINALIZAR.some(frase => t.includes(frase));
}

/** true se o texto é só um número de 1 a 5 (a própria nota sendo respondida, não uma reabertura). */
function pareceRespostaDeNota(texto) {
  const t = String(texto || '').trim();
  return /^[1-5]$/.test(t);
}

/** Tier de velocidade (métrica 1): <=30min +2 | 30-60min +1 | >60min -1. null se não há relógio pra medir. */
function tierVelocidade(minutosUteis) {
  if (minutosUteis == null) return null;
  if (minutosUteis <= 30) return 2;
  if (minutosUteis <= 60) return 1;
  return -1;
}

/**
 * Calcula a(s) linha(s) de pontuação de UM ticket já fechado e avaliado.
 * Função PURA — recebe tudo já carregado, não faz I/O (fácil de testar).
 *
 * @param {object} ticket    linha de cs_tickets (precisa de: analista,
 *   analista_anterior, analista_id, analista_anterior_id, transferencia,
 *   encerramento, nota_avaliacao, sla — sla pode vir como objeto ou string JSON)
 * @param {Array}  mensagens [{ remetente, hora, texto }] ordenadas ou não
 * @returns {Array<object>} 1 ou 2 linhas: { papel, analista, analistaId,
 *   ajusteVelocidade, ajusteFinalizar, ajusteReabertura, notaFinal }
 */
function calcularPontosTicket(ticket, mensagens = []) {
  const notaCliente = ticket.nota_avaliacao != null ? Number(ticket.nota_avaliacao) : null;
  if (notaCliente == null) return []; // ainda sem avaliação — nada pra pontuar

  const sla = typeof ticket.sla === 'string' ? JSON.parse(ticket.sla || '{}') : (ticket.sla || {});
  const relogios = sla.relogios || [];
  const porTipo = (tipo) => relogios.find(r => r.tipo === tipo) || null;

  const linhas = [];
  const foiTransferido = !!ticket.transferencia && !!ticket.analista_anterior;

  // ── Papel "transferiu" — só métrica 1 (velocidade até transferir) ────────
  // A nota do cliente é atribuída só a quem ENCERRA o atendimento — quem só
  // transfere não recebe a nota, o resultado dele é só o ajuste de
  // velocidade puro (+2/+1/−1), sem nota_cliente somada nem teto de 5.
  if (foiTransferido) {
    const relTransf = porTipo('transferencia'); // aceite -> transferência
    const ajusteVelocidade = tierVelocidade(relTransf ? relTransf.minutos_uteis : null);
    linhas.push({
      papel: 'transferiu',
      analista: ticket.analista_anterior,
      analistaId: ticket.analista_anterior_id || null,
      ajusteVelocidade: ajusteVelocidade ?? 0,
      ajusteFinalizar: 0,
      ajusteReabertura: 0,
      notaFinal: ajusteVelocidade ?? 0,
    });
  }

  // ── Papel "recebeu" (se transferido) ou "unico" (se não) ─────────────────
  // Métricas 1 (velocidade de resposta desse papel) + 2 (/Finalizar) + 4 (reabertura).
  const relVelocidade = foiTransferido ? porTipo('departamento') : porTipo('aceite');
  const ajusteVelocidade2 = tierVelocidade(relVelocidade ? relVelocidade.minutos_uteis : null);

  const msgsOrdenadas = [...mensagens].sort((a, b) => new Date(a.hora) - new Date(b.hora));
  const ultimaDoEscritorio = [...msgsOrdenadas].reverse().find(m => m.remetente === 'escritorio');
  const ajusteFinalizar = ultimaDoEscritorio && pareceFinalizacaoCorreta(ultimaDoEscritorio.texto) ? 1 : 0;

  let ajusteReabertura = 0;
  if (ticket.encerramento) {
    const fimJanela = new Date(new Date(ticket.encerramento).getTime() + 30 * 60 * 1000);
    const naJanela = msgsOrdenadas.filter(m =>
      m.remetente === 'cliente' &&
      new Date(m.hora) > new Date(ticket.encerramento) &&
      new Date(m.hora) <= fimJanela
    );
    const presoNoProcesso = naJanela.some(m => !pareceRespostaDeNota(m.texto));
    if (presoNoProcesso) ajusteReabertura = -1;
  }

  linhas.push({
    papel: foiTransferido ? 'recebeu' : 'unico',
    analista: ticket.analista,
    analistaId: ticket.analista_id || null,
    ajusteVelocidade: ajusteVelocidade2 ?? 0,
    ajusteFinalizar,
    ajusteReabertura,
    notaFinal: clamp(notaCliente + (ajusteVelocidade2 ?? 0) + ajusteFinalizar + ajusteReabertura, 0, 5),
  });

  return linhas.map(l => ({ ...l, notaCliente }));
}

function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }

/** Garante as tabelas/colunas usadas pela pontuação — idempotente, chamado a cada ciclo (mesmo padrão de ensureGamTables). */
async function ensurePontuacaoSchema(pool) {
  await pool.query(`ALTER TABLE cs_tickets ADD COLUMN IF NOT EXISTS analista_id TEXT`).catch(()=>{});
  await pool.query(`ALTER TABLE cs_tickets ADD COLUMN IF NOT EXISTS analista_anterior TEXT`).catch(()=>{});
  await pool.query(`ALTER TABLE cs_tickets ADD COLUMN IF NOT EXISTS analista_anterior_id TEXT`).catch(()=>{});
  // Revisão de nota baixa é do TICKET, não de cada papel — a nota do cliente
  // é atribuída só a quem ENCERROU o atendimento (não a quem transferiu).
  // Fica em cs_tickets (não em gam_tickets_pontos) porque é uma propriedade
  // do ticket; quem calcula os pontos filtra por papel na hora de aplicar
  // (ver auto-preencher em data.js: só o papel 'recebeu'/'unico' é afetado
  // pela revisão — 'transferiu' conta sempre, não é dono da nota).
  await pool.query(`ALTER TABLE cs_tickets ADD COLUMN IF NOT EXISTS revisao_nota_status TEXT DEFAULT 'pendente'`).catch(()=>{});
  await pool.query(`ALTER TABLE cs_tickets ADD COLUMN IF NOT EXISTS revisao_nota_por TEXT`).catch(()=>{});
  await pool.query(`ALTER TABLE cs_tickets ADD COLUMN IF NOT EXISTS revisao_nota_em TIMESTAMPTZ`).catch(()=>{});
  await pool.query(`CREATE TABLE IF NOT EXISTS gam_tickets_pontos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id UUID NOT NULL REFERENCES cs_tickets(id) ON DELETE CASCADE,
    papel TEXT NOT NULL CHECK (papel IN ('transferiu','recebeu','unico')),
    analista TEXT,
    analista_id TEXT,
    mes VARCHAR(7) NOT NULL,
    nota_cliente SMALLINT NOT NULL,
    ajuste_velocidade NUMERIC(3,1) DEFAULT 0,
    ajuste_finalizar NUMERIC(3,1) DEFAULT 0,
    ajuste_reabertura NUMERIC(3,1) DEFAULT 0,
    nota_final NUMERIC(3,2) NOT NULL,
    calculado_em TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (ticket_id, papel)
  )`).catch(()=>{});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_gam_pontos_mes_analista ON gam_tickets_pontos (mes, analista_id)`).catch(()=>{});
}

/** Calcula e grava a pontuação de UM ticket (upsert), preservando revisão humana já feita. */
async function persistirPontosTicket(pool, ticketId) {
  const { rows } = await pool.query(`SELECT * FROM cs_tickets WHERE id = $1`, [ticketId]);
  if (!rows.length) return 0;
  const ticket = rows[0];
  if (ticket.nota_avaliacao == null) return 0;

  const { rows: mensagens } = await pool.query(
    `SELECT remetente, hora, texto FROM cs_mensagens WHERE ticket_id = $1 ORDER BY hora ASC`,
    [ticketId]
  );

  const linhas = calcularPontosTicket(ticket, mensagens);
  if (!linhas.length) return 0;

  const referencia = ticket.encerramento || ticket.abertura || new Date();
  const mes = new Date(referencia).toISOString().slice(0, 7);

  for (const l of linhas) {
    await pool.query(
      `INSERT INTO gam_tickets_pontos (
         ticket_id, papel, analista, analista_id, mes, nota_cliente,
         ajuste_velocidade, ajuste_finalizar, ajuste_reabertura, nota_final, calculado_em
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
       ON CONFLICT (ticket_id, papel) DO UPDATE SET
         analista = $3, analista_id = $4, mes = $5, nota_cliente = $6,
         ajuste_velocidade = $7, ajuste_finalizar = $8, ajuste_reabertura = $9,
         nota_final = $10, calculado_em = NOW()`,
      [ticketId, l.papel, l.analista, l.analistaId, mes, l.notaCliente,
       l.ajusteVelocidade, l.ajusteFinalizar, l.ajusteReabertura, l.notaFinal]
    );
  }
  return linhas.length;
}

/**
 * Roda um lote de tickets pendentes de pontuação — chamado a cada ciclo de
 * ingestão (mesmo padrão de preencherTrocasPendentes em ingestao.js), e
 * também pelo botão admin de recálculo/backfill com um limite maior.
 * "Pendente" = tem nota do cliente (rate) mas ainda não foi pontuado, OU o
 * ticket mudou depois da última pontuação (reprocessa).
 */
async function recalcularPontosPendentes(pool, { limite = 50 } = {}) {
  await ensurePontuacaoSchema(pool);
  const { rows: pendentes } = await pool.query(
    `SELECT t.id FROM cs_tickets t
     LEFT JOIN (
       SELECT ticket_id, MAX(calculado_em) AS calculado_em FROM gam_tickets_pontos GROUP BY ticket_id
     ) p ON p.ticket_id = t.id
     WHERE t.nota_avaliacao IS NOT NULL
       AND (p.ticket_id IS NULL OR t.updated_at > p.calculado_em)
     ORDER BY t.encerramento DESC NULLS LAST
     LIMIT $1`,
    [limite]
  );
  let processados = 0;
  for (const t of pendentes) {
    processados += await persistirPontosTicket(pool, t.id) > 0 ? 1 : 0;
  }
  return { candidatos: pendentes.length, processados };
}

module.exports = {
  FRASES_FINALIZAR, pareceFinalizacaoCorreta, pareceRespostaDeNota,
  tierVelocidade, clamp,
  calcularPontosTicket,
  ensurePontuacaoSchema, persistirPontosTicket, recalcularPontosPendentes,
};
