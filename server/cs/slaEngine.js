'use strict';
/**
 * Módulo Sucesso do Cliente — Máquina dos 5 Relógios (motor de SLA)
 * ------------------------------------------------------------------
 * Recebe a timeline de um ticket (eventos + mensagens) e calcula os 5 relógios,
 * usando SEMPRE tempo útil (tempoUtil.js). Zero IA.
 *
 * Formato de entrada (genérico — independente do Zappy):
 * {
 *   id, telefone, empresa_texto, departamento, analista, status,
 *   eventos:   [ { tipo, hora }, ... ]  // tipo: 'abertura'|'aceite'|'transferencia'|'encerramento'|'reabertura'
 *   mensagens: [ { hora, remetente, texto }, ... ]  // remetente: 'cliente' | 'escritorio'
 * }
 * (horas em ISO string ou Date)
 *
 * Quando o JSON real do Zappy chegar, escreve-se apenas um "tradutor"
 * (adaptador) que converte o formato deles neste formato genérico.
 */
const T = require('./tempoUtil');

const ROTULOS = {
  aceite: 'Aceite da recepção',
  transferencia: 'Transferência',
  departamento: 'Início no departamento',
  promessa: 'Promessa não cumprida',
  vez_cliente: 'Cliente aguardando resposta',
};

/** Ordena por hora (ascendente), tolerando Date ou ISO string */
function ordenarPorHora(arr) {
  return [...arr].sort((a, b) => new Date(a.hora) - new Date(b.hora));
}

function primeiroEvento(eventos, tipo) {
  const e = ordenarPorHora(eventos.filter(x => x.tipo === tipo))[0];
  return e ? new Date(e.hora) : null;
}

function primeiraMsg(mensagens, remetente, apos = null, inclusivo = false) {
  const passa = (h) => !apos || (inclusivo ? new Date(h) >= apos : new Date(h) > apos);
  const lista = ordenarPorHora(
    mensagens.filter(m => m.remetente === remetente && passa(m.hora))
  );
  return lista.length ? new Date(lista[0].hora) : null;
}

/**
 * Calcula todos os relógios de um ticket.
 * @param {object} ticket  no formato genérico
 * @param {Date}   agora   instante de referência (default: new Date()) — para relógios ainda correndo
 * @returns {object} { relogios: [...], radar: {...}|null }
 */
function calcularSLA(ticket, agora = new Date()) {
  const eventos = ticket.eventos || [];
  const mensagens = ticket.mensagens || [];

  const tAbertura      = primeiroEvento(eventos, 'abertura');
  const tAceite        = primeiroEvento(eventos, 'aceite');
  const tTransferencia = primeiroEvento(eventos, 'transferencia');
  const tEncerramento  = primeiroEvento(eventos, 'encerramento');

  const primeiraMsgCliente = primeiraMsg(mensagens, 'cliente');
  // marco inicial: a 1ª mensagem do cliente, ou a abertura se não houver mensagem
  const inicio = primeiraMsgCliente || tAbertura;

  const relogios = [];

  // ── Relógio 1 — ACEITE ──────────────────────────────────────────────────────
  if (inicio) {
    const fim = tAceite || agora;
    const min = T.minutosUteis(inicio, fim);
    relogios.push(montar('aceite', inicio, fim, min, !tAceite));
  }

  // ── Relógio 2 — TRANSFERÊNCIA ───────────────────────────────────────────────
  // Corre do aceite até a transferência. MAS: se o escritório já respondeu algo
  // após o aceite (fez uma promessa), o trecho parado vira PROMESSA, não transferência.
  const respAposAceite = tAceite ? primeiraMsg(mensagens, 'escritorio', tAceite, true) : null;
  if (tAceite) {
    if (tTransferencia) {
      // transferiu: mede aceite -> transferência (sempre vale)
      const min = T.minutosUteis(tAceite, tTransferencia);
      relogios.push(montar('transferencia', tAceite, tTransferencia, min, false));
    } else if (!tEncerramento && !respAposAceite) {
      // aberto, aceito, ninguém respondeu ainda e não transferiu -> transferência em curso
      const min = T.minutosUteis(tAceite, agora);
      relogios.push(montar('transferencia', tAceite, agora, min, true));
    }
    // se respAposAceite existe e não transferiu, o relógio que vale é o de PROMESSA (abaixo)
  }

  // ── Relógio 3 — DEPARTAMENTO ────────────────────────────────────────────────
  // Da transferência até a 1ª mensagem do escritório APÓS a transferência.
  if (tTransferencia) {
    const respDepto = primeiraMsg(mensagens, 'escritorio', tTransferencia);
    const fim = respDepto || (tEncerramento || agora);
    const emCurso = !respDepto && !tEncerramento;
    const min = T.minutosUteis(tTransferencia, fim);
    relogios.push(montar('departamento', tTransferencia, fim, min, emCurso));
  }

  // ── Relógio 5 — PROMESSA ────────────────────────────────────────────────────
  // Escritório respondeu ANTES de transferir e o ticket ficou parado (sem transferir
  // nem encerrar) por tempo demais. Pega o "vou direcionar" que não direcionou.
  if (tAceite && !tTransferencia && respAposAceite) {
    const fim = tEncerramento || agora;
    const emCurso = !tEncerramento;
    const min = T.minutosUteis(respAposAceite, fim);
    relogios.push(montar('promessa', respAposAceite, fim, min, emCurso));
  }

  // ── Relógio 4 — VEZ DO CLIENTE (ball in court) ──────────────────────────────
  // "De quem é a vez" no momento presente: se a última mensagem for do cliente
  // e o ticket não estiver encerrado, o cliente está aguardando -> relógio vivo.
  let vezCliente = null;
  if (!tEncerramento && mensagens.length) {
    const ult = ordenarPorHora(mensagens)[mensagens.length - 1];
    if (ult.remetente === 'cliente') {
      const min = T.minutosUteis(new Date(ult.hora), agora);
      vezCliente = montar('vez_cliente', new Date(ult.hora), agora, min, true);
    }
  }

  // ── Radar "Agora": o pior relógio que está EM CURSO ─────────────────────────
  const emCurso = relogios.filter(r => r.em_curso);
  if (vezCliente) emCurso.push(vezCliente);
  const radar = piorRelogio(emCurso);

  return {
    ticket_id: ticket.id,
    empresa: ticket.empresa_texto || null,
    relogios: vezCliente ? [...relogios, vezCliente] : relogios,
    radar, // o que está pegando fogo agora (ou null se tudo em ordem/encerrado)
  };
}

function montar(tipo, inicio, fim, minutos, emCurso) {
  const limite = T.LIMITES[tipo] || null;
  const status = limite ? T.statusSLA(minutos, limite) : 'neutro';
  return {
    tipo,
    rotulo: ROTULOS[tipo],
    inicio: new Date(inicio).toISOString(),
    fim: new Date(fim).toISOString(),
    minutos_uteis: minutos,
    limite,
    status,      // verde | amarelo | vermelho | neutro
    em_curso: !!emCurso,
  };
}

/** Escolhe o relógio mais grave (vermelho > amarelo > verde) e, no empate, o de maior tempo */
function piorRelogio(lista) {
  if (!lista.length) return null;
  const peso = { vermelho: 3, amarelo: 2, verde: 1, neutro: 0 };
  return [...lista].sort((a, b) => {
    const d = (peso[b.status] || 0) - (peso[a.status] || 0);
    if (d !== 0) return d;
    return b.minutos_uteis - a.minutos_uteis;
  })[0];
}

/**
 * "Trocas" — tempo de resposta do escritório em CADA turno do cliente ao
 * longo da conversa inteira, não só na primeira vez. Complementa os 5
 * relógios (que só olham a PRIMEIRA resposta de cada trecho — aceite e
 * departamento) com uma visão de "toda vez que a bola volta pro escritório,
 * quanto demora pra responder de novo".
 *
 * Regras:
 *  - Ignora mensagens 'sistema' (bot) — não contam como turno nem como resposta.
 *  - Um "turno do cliente" é o INÍCIO de uma sequência de 1+ mensagens dele
 *    (se manda 2 mensagens seguidas, conta só 1 turno, não 2).
 *  - Mede do início do turno até a próxima mensagem 'escritorio'. Se não
 *    respondeu ainda, em_curso=true e mede até `agora`.
 *  - Mesmo limite do relógio "departamento" (30 min úteis) — é o mesmo tipo
 *    de expectativa (analista responder), só que repetido a cada troca.
 * @param {Array} mensagens  [{ hora, remetente: 'cliente'|'escritorio'|'sistema' }]
 * @param {Date}  agora
 * @returns {Array} [{ inicio, fim, minutos_uteis, status, em_curso }]
 */
const LIMITE_TROCA = 30;

function calcularTrocas(mensagens, agora = new Date()) {
  const ordenadas = ordenarPorHora((mensagens || []).filter(m => m.remetente !== 'sistema'));
  const trocas = [];
  for (let i = 0; i < ordenadas.length; i++) {
    const m = ordenadas[i];
    if (m.remetente !== 'cliente') continue;
    if (i > 0 && ordenadas[i - 1].remetente === 'cliente') continue; // não é início de turno

    const prox = ordenadas.slice(i + 1).find(x => x.remetente === 'escritorio');
    const inicio = new Date(m.hora);
    const emCurso = !prox;
    const fim = prox ? new Date(prox.hora) : agora;
    const minutos = T.minutosUteis(inicio, fim);
    const status = T.statusSLA(minutos, LIMITE_TROCA);
    trocas.push({
      inicio: inicio.toISOString(),
      fim: fim.toISOString(),
      minutos_uteis: minutos,
      status,
      em_curso: emCurso,
    });
  }
  return trocas;
}

module.exports = { calcularSLA, calcularTrocas, ROTULOS, LIMITE_TROCA };
