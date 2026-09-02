'use strict';
/**
 * Módulo Sucesso do Cliente — ABANDONO DE ATENDIMENTO (Gamificação)
 * ------------------------------------------------------------------
 * Pedido do Reysner, 02/09/2026, a partir do ticket #47957 (Juliana - El
 * Festin de Babette): o cliente mandou 3 mensagens em dias diferentes sem
 * NENHUMA resposta, e só se soube porque o Reysner foi caçar manualmente
 * os atendimentos abertos — o Bruno (dono do ticket) faltou no trabalho e
 * ninguém redistribuiu os atendimentos dele.
 *
 * Regra definida pelo Reysner: se o cliente interagiu até 40min antes do fim
 * do expediente do dia (16:50 seg-qui, que fecham 17:30; 16:20 na sexta, que
 * fecha 17:00 — ver EXPEDIENTE_PADRAO em tempoUtil.js) e não teve NENHUMA
 * resposta do escritório até o fim do expediente daquele dia, é "abandono de
 * atendimento" — SALVO se:
 *   1) o colaborador deixou qualquer resposta antes do fim do expediente
 *      (mesmo um "vou ver pra você") — já está "respaldado", não conta.
 *   2) a última mensagem do cliente é só um fechamento de conversa (ok,
 *      entendido, obrigado...) — não tinha nada pendente de responder.
 *
 * Cada incidente é por (ticket, dia) — um ticket que fica "preso" por
 * vários dias gera um incidente por dia, cada um revisável separadamente
 * (Devida/Indevida), igual às outras regras de revisão. Vira bônus/desconto
 * MENSAL médio (bonusAbandono, ver executarAutoPreencher em routes/data.js),
 * mesmo estilo do /Finalizar: soma dos incidentes não-indevida ÷ atendimentos
 * avaliados no mês (exemplo do próprio Reysner: 3 incidentes ÷ 20 atendimentos
 * = -0,15 na nota final).
 */
const T = require('./tempoUtil');

function normalizarTexto(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

// Frases curtas que indicam que o cliente só está encerrando a troca
// (agradecendo/confirmando), sem pedir nada novo — a mensagem inteira
// precisa ser curta E bater num desses padrões, pra não confundir com
// "obrigado, mas ainda preciso de ajuda com..." (isso continua pendente).
const FRASES_FECHAMENTO = [
  'ok', 'okay', 'blz', 'beleza', 'certo', 'perfeito', 'show', 'entendido', 'entendi',
  'obrigado', 'obrigada', 'obg', 'valeu', 'agradeco', 'agradecida', 'agradecido',
  'muito obrigado', 'muito obrigada', 'tudo bem obrigado', 'tudo bem obrigada',
  'ok obrigado', 'ok obrigada', 'de nada', 'por nada', 'bom dia', 'boa tarde', 'boa noite',
  'figurinha', // rótulo que o próprio Zappy usa pra sticker sem legenda — mesmo espírito de um 👍
  '👍', '🙏', '✅',
];
const LIMITE_TAMANHO_FECHAMENTO = 40; // caracteres — mensagem curta, sem pedido novo junto

/** true se a mensagem parece só um agradecimento/encerramento, sem pedido pendente. */
function pareceMensagemDeFechamento(texto) {
  const limpo = normalizarTexto(texto);
  if (!limpo) return true; // vazio (ex.: só áudio/figurinha, sem texto) — não força resposta
  // Só um número de 1 a 5 = a nota da pesquisa de satisfação, não um pedido
  // novo — mesmo critério já usado na regra de reabertura (ver pontuacao.js).
  if (/^[1-5]$/.test(limpo)) return true;
  if (limpo.length > LIMITE_TAMANHO_FECHAMENTO) return false;
  return FRASES_FECHAMENTO.some(f => limpo === f || limpo.startsWith(f + ' ') || limpo.startsWith(f + ',') || limpo.startsWith(f + '!'));
}

// Cortes por dia da semana — segunda a quinta fecha às 17:30, sexta às
// 17:00 (ver EXPEDIENTE_PADRAO em tempoUtil.js), então o corte do cliente é
// sempre 40min antes do fim do expediente e a resposta precisa vir até o
// fim do expediente daquele dia. Pedido do Reysner, 02/09/2026.
const CORTES_POR_DIA = {
  1: { cliente: '16:50', resposta: '17:30' }, // segunda
  2: { cliente: '16:50', resposta: '17:30' }, // terça
  3: { cliente: '16:50', resposta: '17:30' }, // quarta
  4: { cliente: '16:50', resposta: '17:30' }, // quinta
  5: { cliente: '16:20', resposta: '17:00' }, // sexta
};

/**
 * Detecta incidentes de abandono num ticket já ACEITO (não olha o tempo em
 * aguardando/bot — isso já é coberto pela regra de Aceite). Devolve um
 * incidente por dia coberto em que a condição bateu, mais antigo primeiro.
 */
function detectarIncidentesAbandono(ticket, mensagens) {
  if (!ticket.aceite) return []; // nunca foi aceito por ninguém — não é "atendimento preso com alguém"
  const msgs = (mensagens || [])
    .filter(m => new Date(m.hora) >= new Date(ticket.aceite))
    .map(m => ({ ...m, horaDate: new Date(m.hora) }))
    .sort((a, b) => a.horaDate - b.horaDate);
  if (!msgs.length) return [];

  const dias = [...new Set(msgs.map(m => T.diaISO(m.horaDate)))].sort();
  const incidentes = [];

  for (const dia of dias) {
    const cortes = CORTES_POR_DIA[T.diaSemana(dia)];
    if (!cortes) continue; // fim de semana — não coberto
    if (T.FERIADOS.has(dia)) continue;
    const corteCliente = T.instante(dia, cortes.cliente);
    const corteResposta = T.instante(dia, cortes.resposta);

    const ateOCorte = msgs.filter(m => m.horaDate <= corteCliente);
    if (!ateOCorte.length) continue;
    const ultima = ateOCorte[ateOCorte.length - 1];
    if (ultima.remetente !== 'cliente') continue; // já não tinha nada pendente do cliente
    if (pareceMensagemDeFechamento(ultima.texto)) continue; // só um "ok, obrigado"

    // Só uma resposta de VERDADE (humana) respalda — mensagem automática do
    // bot/sistema (ex.: pesquisa de satisfação) não conta.
    const respondeuAntesDoFechamento = msgs.some(m =>
      m.remetente === 'escritorio' && m.horaDate > ultima.horaDate && m.horaDate <= corteResposta
    );
    if (respondeuAntesDoFechamento) continue;

    incidentes.push({
      data: dia,
      ultimaMensagemCliente: ultima.hora,
      ultimaMensagemTexto: ultima.texto,
    });
  }
  return incidentes;
}

async function ensureAbandonoSchema(pool) {
  // Marca quando cada ticket foi checado pela última vez pra abandono — sem
  // isso não dá pra saber quais tickets estão "pendentes" de checagem (não
  // basta olhar gam_abandono_incidentes: a maioria dos tickets nunca gera
  // incidente nenhum, então "não tem linha lá" não distingue "nunca checado"
  // de "checado e limpo"). Mesmo padrão de calculado_em em gam_tickets_pontos.
  await pool.query(`ALTER TABLE cs_tickets ADD COLUMN IF NOT EXISTS abandono_calculado_em TIMESTAMPTZ`).catch(() => {});
  await pool.query(`CREATE TABLE IF NOT EXISTS gam_abandono_incidentes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id UUID NOT NULL REFERENCES cs_tickets(id) ON DELETE CASCADE,
    data DATE NOT NULL,
    mes VARCHAR(7) NOT NULL,
    analista TEXT,
    analista_id TEXT,
    ultima_mensagem_cliente TIMESTAMPTZ,
    ultima_mensagem_texto TEXT,
    status TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','devida','indevida')),
    revisado_por TEXT,
    revisado_em TIMESTAMPTZ,
    detectado_em TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (ticket_id, data)
  )`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_gam_abandono_mes_analista ON gam_abandono_incidentes (mes, analista_id)`).catch(() => {});
}

/**
 * Detecta e grava os incidentes de abandono de UM ticket (upsert),
 * preservando o status de revisão humana já feita em incidentes que
 * continuam batendo, e removendo os que não batem mais (ex.: mensagens
 * novas mudaram o cenário). Roda pra QUALQUER ticket de cliente, mesmo sem
 * nota do cliente ainda — diferente de persistirPontosTicket, abandono não
 * depende do ticket ter sido avaliado (o #47957 que motivou isso nem tinha
 * sido encerrado ainda).
 */
async function persistirAbandonoTicket(pool, ticketId) {
  const { rows } = await pool.query(
    `SELECT t.*, v.tipo AS vinculo_tipo
       FROM cs_tickets t
       LEFT JOIN cs_vinculos v ON v.id = t.vinculo_id
      WHERE t.id = $1`,
    [ticketId]
  );
  if (!rows.length) return 0;
  const ticket = rows[0];
  if (ticket.vinculo_tipo !== 'cliente') {
    await pool.query(`DELETE FROM gam_abandono_incidentes WHERE ticket_id = $1`, [ticketId]);
    return 0;
  }

  const { rows: mensagens } = await pool.query(
    `SELECT remetente, hora, texto FROM cs_mensagens WHERE ticket_id = $1 ORDER BY hora ASC`,
    [ticketId]
  );
  const incidentes = detectarIncidentesAbandono(ticket, mensagens);

  const datasAtuais = incidentes.map(i => i.data);
  if (datasAtuais.length) {
    await pool.query(
      `DELETE FROM gam_abandono_incidentes WHERE ticket_id = $1 AND NOT (data = ANY($2::date[]))`,
      [ticketId, datasAtuais]
    );
  } else {
    await pool.query(`DELETE FROM gam_abandono_incidentes WHERE ticket_id = $1`, [ticketId]);
  }

  for (const inc of incidentes) {
    await pool.query(
      `INSERT INTO gam_abandono_incidentes
         (ticket_id, data, mes, analista, analista_id, ultima_mensagem_cliente, ultima_mensagem_texto)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (ticket_id, data) DO UPDATE SET
         mes = $3, analista = $4, analista_id = $5,
         ultima_mensagem_cliente = $6, ultima_mensagem_texto = $7`,
      [ticketId, inc.data, inc.data.slice(0, 7), ticket.analista, ticket.analista_id,
       inc.ultimaMensagemCliente, inc.ultimaMensagemTexto]
    );
  }
  await pool.query(`UPDATE cs_tickets SET abandono_calculado_em = NOW() WHERE id = $1`, [ticketId]);
  return incidentes.length;
}

/**
 * Roda um lote de tickets pendentes de checagem de abandono — mesmo padrão
 * de recalcularPontosPendentes em pontuacao.js, chamado a cada ciclo de
 * ingestão. "Pendente" = já foi aceito por alguém e (nunca foi checado OU
 * mudou depois da última checagem).
 */
async function recalcularAbandonoPendentes(pool, { limite = 30 } = {}) {
  await ensureAbandonoSchema(pool);
  const { rows: pendentes } = await pool.query(
    `SELECT id FROM cs_tickets
      WHERE aceite IS NOT NULL
        AND (abandono_calculado_em IS NULL OR updated_at > abandono_calculado_em)
      ORDER BY updated_at DESC NULLS LAST
      LIMIT $1`,
    [limite]
  );
  let processados = 0;
  for (const t of pendentes) {
    try {
      // Trava de segurança: se um ticket específico travar (ex.: lock de
      // banco), não pode derrubar o lote inteiro pros próximos ciclos —
      // acontecido em 02/09/2026 quando isso rodava junto com o recálculo
      // de SLA (os dois brigando pelas mesmas linhas, sem nunca terminar).
      await Promise.race([
        persistirAbandonoTicket(pool, t.id),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout de 20s')), 20000)),
      ]);
      processados++;
    } catch (e) {
      console.error('[CS] persistirAbandonoTicket falhou/travou pro ticket', t.id, '-', e.message);
    }
  }
  return { candidatos: pendentes.length, processados };
}

module.exports = {
  detectarIncidentesAbandono, pareceMensagemDeFechamento, FRASES_FECHAMENTO,
  ensureAbandonoSchema, persistirAbandonoTicket, recalcularAbandonoPendentes,
};
