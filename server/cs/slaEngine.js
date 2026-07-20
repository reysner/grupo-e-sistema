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
  promessa: 'Promessa de transferência não cumprida',
  promessa_resolucao: 'Resolvendo direto (sem transferir)',
  vez_cliente: 'Cliente aguardando resposta',
};

/**
 * Frases (normalizadas, sem acento) que indicam que quem respondeu está
 * avisando que VAI TRANSFERIR o atendimento — em vez de resolver a demanda
 * diretamente. Lista calibrada com exemplos reais de como o time escreve
 * (ver conversa com a Thais). Casamento é por trecho (substring), então
 * pequenas variações de frase ainda batem.
 */
const FRASES_TRANSFERENCIA = [
  'vou te transferir',
  'vou transferir',
  'vou te direcionar',
  'vou direcionar',
  'vou te enviar',
  'vou enviar voce',
  'vou encaminhar',
  'vou conectar',
  'so um momento',
  'so um instante',
  'um momento, por gentileza',
  'analista responsavel dara continuidade',
  'responsavel por essa demanda',
  'dara continuidade ao seu atendimento',
  'especialista dara sequencia',
  'equipe responsavel assumira',
  'enquanto realizo a transferencia',
  'enquanto direciono',
  'em instantes voce sera atendido',
  'sera atendido pelo analista',
  'setor responsavel',
];

function normalizarTexto(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** true se o texto parece avisar que a pessoa VAI TRANSFERIR (em vez de resolver direto). */
function pareceIntencaoTransferir(texto) {
  const t = normalizarTexto(texto);
  if (!t) return false;
  return FRASES_TRANSFERENCIA.some(frase => t.includes(frase));
}

/**
 * Frases (normalizadas, sem acento) que indicam que o CLIENTE está
 * sinalizando risco de cancelamento — intenção explícita de trocar de
 * contabilidade, ou reclamação forte de padrão de erro/atendimento. São
 * frases de várias palavras (não palavras soltas tipo "erro" ou "ruim")
 * de propósito: mensagem de chat do dia a dia é muito mais barulhenta que
 * comentário de pesquisa (ex.: "deu erro no boleto" é rotina, não é
 * sinal de churn) — casar só frase composta reduz falso positivo.
 * Calibrada com exemplos reais da Thais: "já não aguento tanto erros, vou
 * procurar outra contabilidade, vocês erram demais" e "Estou cansado dos
 * erros de vocês" (testado direto numa conversa real do Zappy).
 */
const FRASES_CHURN = [
  // Intenção explícita de trocar/cancelar
  'vou procurar outra contabilidade',
  'vou procurar outro contador',
  'vou procurar outra empresa de contabilidade',
  'vou procurar outro escritorio',
  'procurar outra contabilidade',
  'procurar outro contador',
  'vou trocar de contabilidade',
  'vou trocar de contador',
  'quero trocar de contador',
  'quero trocar de contabilidade',
  'trocar de contabilidade',
  'trocar de contador',
  'quero cancelar',
  'vou cancelar',
  'quero encerrar o contrato',
  'quero encerrar a parceria',
  'quero rescindir',
  'vou rescindir',
  'nao quero mais ser cliente',
  'nao quero mais continuar com voces',
  'nao quero mais trabalhar com voces',
  // Frustração repetida / padrão de erros (frase composta, não palavra solta)
  'nao aguento mais',
  'ja nao aguento',
  'erram demais',
  'erram muito',
  'tanto erro',
  'muito erro',
  'cansei de erro',
  'cansado de tanto erro',
  'cansada de tanto erro',
  'cansado dos erros',
  'cansada dos erros',
  'cansado com os erros',
  'cansada com os erros',
  'cansado de tantos erros',
  'cansada de tantos erros',
  'estou cansado de voces',
  'estou cansada de voces',
  'sempre um problema',
  'toda hora um erro',
  'descaso total',
  'descaso completo',
  // Insatisfação forte / recomendação negativa
  'pessimo atendimento',
  'nunca mais indico',
  'nao recomendo',
  'nao indico',
  'muito insatisfeito',
  'muito insatisfeita',
  'extremamente insatisfeito',
  'extremamente insatisfeita',
  'isso e um absurdo',
  'um absurdo isso',
];

/**
 * Se o texto tiver algum sinal de churn, devolve a frase que bateu (útil
 * pra mostrar o motivo na tela); senão, devolve null. Casamento por
 * substring, então pequenas variações da frase ainda batem.
 */
function detectarSinalChurn(texto) {
  const t = normalizarTexto(texto);
  if (!t) return null;
  return FRASES_CHURN.find(frase => t.includes(frase)) || null;
}

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

/** Igual a primeiraMsg, mas devolve a mensagem inteira (pra ler o texto), não só a hora. */
function primeiraMsgObjeto(mensagens, remetente, apos = null, inclusivo = false) {
  const passa = (h) => !apos || (inclusivo ? new Date(h) >= apos : new Date(h) > apos);
  const lista = ordenarPorHora(
    mensagens.filter(m => m.remetente === remetente && passa(m.hora))
  );
  return lista.length ? lista[0] : null;
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
  const respAposAceiteObj = tAceite ? primeiraMsgObjeto(mensagens, 'escritorio', tAceite, true) : null;
  const respAposAceite = respAposAceiteObj ? new Date(respAposAceiteObj.hora) : null;
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
  // nem encerrar). Duas situações bem diferentes, separadas pelo TEXTO da resposta:
  //   - Avisou que VAI TRANSFERIR (ex.: "vou te direcionar") e não transferiu ainda
  //     -> tipo 'promessa', prazo curto (15min, mesmo padrão da transferência real).
  //   - Não falou em transferir (interpretado como "vou resolver isso eu mesma(o)")
  //     -> tipo 'promessa_resolucao', prazo maior (2h de silêncio é aceitável).
  //     MAS: mesmo dentro das 2h, se o cliente mandou mensagem nesse meio tempo e a
  //     resposta a ELA especificamente passou de 30min, já conta negativo — não dá
  //     pra esconder uma demora pontual atrás do prazo geral mais folgado.
  if (tAceite && !tTransferencia && respAposAceite) {
    const fim = tEncerramento || agora;
    const emCurso = !tEncerramento;
    const min = T.minutosUteis(respAposAceite, fim);
    if (pareceIntencaoTransferir(respAposAceiteObj.texto)) {
      relogios.push(montar('promessa', respAposAceite, fim, min, emCurso));
    } else {
      const mensagensDepoisDaResposta = mensagens.filter(m => new Date(m.hora) >= respAposAceite);
      const trocasNaJanela = calcularTrocas(mensagensDepoisDaResposta, agora);
      const teveTrocaLenta = trocasNaJanela.some(t => t.status !== 'verde');
      const status = (min > T.LIMITES.promessa_resolucao || teveTrocaLenta) ? 'vermelho' : 'verde';
      relogios.push(montar('promessa_resolucao', respAposAceite, fim, min, emCurso, status));
    }
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

function montar(tipo, inicio, fim, minutos, emCurso, statusForcado = null) {
  const limite = T.LIMITES[tipo] || null;
  const status = statusForcado || (limite ? T.statusSLA(minutos, limite) : 'neutro');
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

module.exports = { calcularSLA, calcularTrocas, ROTULOS, LIMITE_TROCA, pareceIntencaoTransferir, FRASES_TRANSFERENCIA, detectarSinalChurn, FRASES_CHURN };
