'use strict';
/** Textos de justificativa do SLA a partir do campo sla do ticket (relogios + radar). Sem banco, sem dependências. */

const ETAPA_SLA = { aceite: 'Aceite', transferencia: 'Transferência', departamento: 'Departamento', promessa: 'P. Transferir', promessa_resolucao: 'P. Resolver', vez_cliente: 'Vez do cliente' };

function minutosTexto(m) {
  m = Math.round(Number(m) || 0);
  if (m < 60) return m + ' min';
  const h = Math.floor(m / 60), r = m % 60;
  return h + ' h' + (r ? ' ' + r + ' min' : '');
}

function lerSla(sla) {
  if (typeof sla === 'string') { try { return JSON.parse(sla); } catch (e) { return null; } }
  return sla || null;
}

/** Hora (HH:MM, horário de Brasília) de um instante ISO. */
function horaBrasilia(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
}

/** "Aceite: 48 min úteis (prazo 15 min)" — a etapa que deixou o atendimento no vermelho (radar = pior relógio em curso). */
function justificativaSla(sla) {
  const o = lerSla(sla);
  const r = o && o.radar;
  if (!r || !r.tipo) return '';
  const etapa = ETAPA_SLA[r.tipo] || r.tipo;
  const min = Number(r.minutos_uteis) || 0, lim = Number(r.limite) || 0;
  if (r.tipo === 'promessa_resolucao') return etapa + ': a resposta ao cliente demorou mais de 30 min úteis (prazo 30 min)';   // só esta forma deixa o P. Resolver vermelho (o prazo de 2 h foi desconsiderado)
  if (!lim) return etapa + ': ' + minutosTexto(min) + ' úteis';
  return etapa + ': ' + minutosTexto(min) + ' úteis (prazo ' + minutosTexto(lim) + ')';
}

/**
 * Para a revisão de descontos: todas as etapas do ticket que passaram do prazo (amarelo ou vermelho), com os horários.
 * Ex.: "Departamento: 31 min úteis (prazo 30 min), das 15:33 às 16:04". Lista vazia = nenhuma etapa estourada.
 */
function justificativasRelogios(sla) {
  const o = lerSla(sla);
  const rels = (o && o.relogios) || [];
  return rels.filter((r) => r && (r.status === 'amarelo' || r.status === 'vermelho')).map((r) => {
    const etapa = ETAPA_SLA[r.tipo] || r.tipo;
    const min = Number(r.minutos_uteis) || 0, lim = Number(r.limite) || 0;
    const quando = r.inicio && r.fim ? ', das ' + horaBrasilia(r.inicio) + ' às ' + horaBrasilia(r.fim) : '';
    if (r.tipo === 'promessa_resolucao') return etapa + ': a resposta ao cliente demorou mais de 30 min úteis' + quando;
    return etapa + ': ' + minutosTexto(min) + ' úteis' + (lim ? ' (prazo ' + minutosTexto(lim) + ')' : '') + quando;
  });
}

module.exports = { ETAPA_SLA, minutosTexto, justificativaSla, justificativasRelogios, horaBrasilia };
