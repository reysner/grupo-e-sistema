'use strict';
/**
 * Regras do módulo Financeiro (/financeiro): funções PURAS (sem banco, sem rede), testadas em testes_financeiro.js.
 *
 *  - classificarMensagem: reconhece, no texto de uma mensagem do Bruno no Zappy, se é cobrança, aviso de suspensão, envio do boleto
 *    do mês ou baixa de pagamento, e quais vencimentos ele citou (dd/mm/aaaa).
 *  - contarCobrancas: "quantas vezes cada competência (vencimento) foi cobrada". Uma cobrança feita no dia D cobra todo título vencido até D
 *    e ainda não pago em D; se a mensagem cita datas, só conta os títulos citados.
 *  - proximoPasso: o que fazer com o cliente (cobrar, cobrar de novo, ligar, avaliar suspensão, levar à reunião...).
 */

const MS_DIA = 86400000;
const iso = (d) => d.toISOString().slice(0, 10);
const paraData = (s) => { const [y, m, d] = String(s).slice(0, 10).split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
/** Dias inteiros de a até b (b - a). */
const diasEntre = (a, b) => Math.round((paraData(b) - paraData(a)) / MS_DIA);

/** Quem escreve as cobranças: o texto da mensagem começa com "*Bruno Xavier:*" (o Zappy não grava o autor em campo próprio). */
const PREFIXO_COBRADOR = /^\s*\*Bruno Xavier:\*/i;
const ehDoCobrador = (texto) => PREFIXO_COBRADOR.test(String(texto || ''));

const RE_SUSPENSAO = /(suspens|suspend|interromp|paralis)/i;
const RE_COBRANCA = new RegExp([
  'honor[aá]rios?[^.\\n]{0,90}(em aberto|pendente|atras|vencid)',
  '(em aberto|pendente|atras|vencid)[^.\\n]{0,90}honor[aá]rios?',
  'valores?[^.\\n]{0,40}em aberto',
  'falta de pagamento',
  'encontra-?se\\s+pendente',
  'vencimento[s]?\\s+em\\s+atraso',
  'consta[m]?\\s+em\\s+nosso\\s+sistema',
  'restando\\s+em\\s+aberto',
].join('|'), 'i');
const RE_BOLETO = /(boleto[^.\n]{0,80}honor[aá]rio|honor[aá]rio[^.\n]{0,80}boleto)/i;
const RE_BAIXA = /(realizei a baixa|estou realizando a baixa|foi realizado o pagamento|pagamento (foi )?(identificado|confirmado|recebido)|baixa do valor recebido)/i;
const RE_DATA = /\b(\d{2})\/(\d{2})\/(\d{4}|\d{2})\b/g;   // dd/mm/aaaa e dd/mm/aa (o Bruno escreve das duas formas)

/**
 * @returns {null | {tipo: 'cobranca'|'suspensao'|'boleto'|'baixa', conta: boolean, datas: string[]}}
 *   conta = entra na contagem de "vezes cobrado" (cobrança e aviso de suspensão; boleto do mês e baixa são só informativos).
 */
function classificarMensagem(texto) {
  const t = String(texto || '');
  if (!ehDoCobrador(t)) return null;
  const datas = [];
  let m; RE_DATA.lastIndex = 0;
  while ((m = RE_DATA.exec(t))) { const d = `${m[3].length === 2 ? '20' + m[3] : m[3]}-${m[2]}-${m[1]}`; if (!datas.includes(d)) datas.push(d); }
  if (RE_BAIXA.test(t)) return { tipo: 'baixa', conta: false, datas };
  if (RE_SUSPENSAO.test(t) && /(honor|pagamento|aberto|inadimpl)/i.test(t)) return { tipo: 'suspensao', conta: true, datas };
  if (RE_COBRANCA.test(t)) return { tipo: 'cobranca', conta: true, datas };
  if (RE_BOLETO.test(t)) return { tipo: 'boleto', conta: false, datas };
  return null;
}

/** Junta as mensagens do mesmo dia (e do mesmo cliente) em um único evento: cobrar 3 vezes no mesmo dia conta 1. */
function eventosPorDia(mensagens) {
  const porDia = new Map();
  for (const x of mensagens || []) {
    const c = classificarMensagem(x.texto);
    if (!c) continue;
    const dia = String(x.dia).slice(0, 10);
    const e = porDia.get(dia) || { dia, tipos: new Set(), datas: new Set(), conta: false, tickets: new Set() };
    e.tipos.add(c.tipo); c.datas.forEach((d) => e.datas.add(d)); if (c.conta) e.conta = true; if (x.ticket) e.tickets.add(String(x.ticket));
    porDia.set(dia, e);
  }
  return [...porDia.values()].sort((a, b) => a.dia.localeCompare(b.dia)).map((e) => ({
    dia: e.dia, conta: e.conta, tickets: [...e.tickets],
    // tipo principal do dia: suspensão > cobrança > boleto > baixa
    tipo: ['suspensao', 'cobranca', 'boleto', 'baixa'].find((t) => e.tipos.has(t)),
    datas: [...e.datas].sort(),
  }));
}

/**
 * Para cada título em aberto, quantas vezes foi cobrado e quando foi a última.
 * @param titulos [{ vencimento:'AAAA-MM-DD', pago_em?:'AAAA-MM-DD'|null, ... }]
 * @param eventos saída de eventosPorDia (só os com conta=true entram)
 */
function contarCobrancas(titulos, eventos) {
  const cobrando = (eventos || []).filter((e) => e.conta);
  return (titulos || []).map((t) => {
    let vezes = 0, ultima = null, primeira = null;
    for (const e of cobrando) {
      if (!(t.vencimento < e.dia)) continue;                         // ainda não tinha vencido na data da cobrança
      if (t.pago_em && t.pago_em < e.dia) continue;                  // já estava pago
      if (e.datas.length && !e.datas.includes(t.vencimento)) continue; // a mensagem citou datas e esta não estava entre elas
      vezes++; ultima = e.dia; if (!primeira) primeira = e.dia;
    }
    return { ...t, cobrancas: vezes, ultima_cobranca: ultima, primeira_cobranca: primeira };
  });
}

const FAIXAS = [
  { id: 'ate15', rotulo: '1 a 15 dias', de: 1, ate: 15 },
  { id: 'ate30', rotulo: '16 a 30 dias', de: 16, ate: 30 },
  { id: 'ate60', rotulo: '31 a 60 dias', de: 31, ate: 60 },
  { id: 'ate90', rotulo: '61 a 90 dias', de: 61, ate: 90 },
  { id: 'mais90', rotulo: 'Mais de 90 dias', de: 91, ate: Infinity },
];
const faixaDeAtraso = (dias) => (dias >= 1 ? FAIXAS.find((f) => dias >= f.de && dias <= f.ate) : null);

/**
 * Próximo passo de um cliente do Financeiro.
 * @param c { suspenso, diasAtraso, qtdAtrasados, cobrancas, ultimaCobranca, cronico, hoje }
 */
function proximoPasso(c) {
  const hoje = c.hoje;
  const dias = c.diasAtraso || 0;
  const desdeUltima = c.ultimaCobranca ? diasEntre(c.ultimaCobranca, hoje) : null;
  if (c.suspenso && c.qtdAtrasados > 0) {
    return { codigo: 'suspenso_com_debito', texto: 'Contrato suspenso no Omie com débito em aberto: só reativar depois de regularizar. ' + (dias > 60 ? 'Passa de 60 dias: levar à reunião para decidir entre acordo ou encerramento.' : 'Combinar a regularização com o cliente.'), gravidade: 'alta' };
  }
  if (c.suspenso) return { codigo: 'suspenso', texto: 'Contrato suspenso no Omie: confirmar se o cliente continua ativo ou se é caso de encerramento.', gravidade: 'media' };
  if (!(c.qtdAtrasados > 0)) return { codigo: 'em_dia', texto: 'Em dia: sem ação.', gravidade: 'ok' };
  if (dias > 90) return { codigo: 'avaliar_suspensao', texto: `Atraso de ${dias} dias${c.cobrancas ? ` e ${c.cobrancas} cobrança(s)` : ''}: avaliar a suspensão do contrato e levar à reunião.`, gravidade: 'alta' };
  if (!c.cobrancas) return { codigo: 'cobrar_agora', texto: `Nunca foi cobrado no Zappy: cobrar agora (${c.qtdAtrasados} título(s), o mais antigo há ${dias} dias).`, gravidade: dias > 30 ? 'alta' : 'media' };
  if (desdeUltima != null && desdeUltima <= 7) return { codigo: 'aguardar', texto: `Cobrado há ${desdeUltima} dia(s): aguardar o retorno do cliente antes de cobrar de novo.`, gravidade: 'baixa' };
  if (c.cobrancas >= 3 || dias > 60) return { codigo: 'ligar', texto: `${c.cobrancas} cobrança(s) por mensagem sem pagamento (última há ${desdeUltima} dias): ligar para o cliente e registrar o retorno.`, gravidade: 'alta' };
  return { codigo: 'cobrar_de_novo', texto: `Última cobrança há ${desdeUltima} dias: cobrar de novo.`, gravidade: 'media' };
}

module.exports = { classificarMensagem, ehDoCobrador, eventosPorDia, contarCobrancas, proximoPasso, faixaDeAtraso, FAIXAS, diasEntre, iso, paraData };
