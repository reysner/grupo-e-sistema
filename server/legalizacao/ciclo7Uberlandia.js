'use strict';

/**
 * Consulta de andamento de Alvará (Funcionamento + Sanitário) no portal
 * Ciclo7 da Prefeitura de Uberlândia-MG — pedido do Reysner, 17/09/2026.
 *
 * IMPORTANTE — o que isso NÃO é: não existe uma "data de vencimento"
 * consultável nesse portal. Ele mostra o STATUS do último protocolo/
 * solicitação de cada tipo de alvará (ex.: "Renovação Alvará de
 * Funcionamento" — Secretaria de Planejamento: Liberado, Secretaria de
 * Posturas: Em Andamento), filtrado por ANO da solicitação — não dá pra
 * saber de cara em qual ano está o protocolo mais recente, por isso a busca
 * varre os últimos N anos (do atual pra trás) até achar alguma coisa.
 *
 * Isso é só um ATALHO DE PESQUISA pro admin conferir rapidamente o status —
 * NÃO substitui a data de vencimento cadastrada manualmente em
 * legalizacao_alvaras (essa continua sendo a fonte usada pros alertas de
 * cor do painel).
 *
 * Portal é uma aplicação Java/Struts antiga (framework "PLC") — não tem API,
 * só HTML renderizado no servidor. Reproduz aqui o mesmo POST que o
 * navegador faz (campos descobertos inspecionando o form real em
 * ciclo7.uberlandia.mg.gov.br), com sessão via cookie JSESSIONID.
 */

const BASE_URL = 'https://ciclo7.uberlandia.mg.gov.br/ciclo7';
const TIMEOUT_MS = 15000;

/** Separa um CNPJ (com ou sem máscara) nas 3 partes que o formulário pede. */
function partesCnpj(cnpjBruto) {
  const digitos = String(cnpjBruto || '').replace(/\D/g, '');
  if (digitos.length !== 14) return null;
  return {
    base: digitos.slice(0, 8),
    filial: digitos.slice(8, 12),
    dv: digitos.slice(12, 14),
  };
}

/**
 * GET inicial só pra ganhar um JSESSIONID válido (o POST sozinho não
 * funciona sem sessão). `headers.get('set-cookie')` do fetch nativo do
 * Node (undici) sempre devolve null — Set-Cookie é tratado à parte pelo
 * spec do Fetch; o jeito certo é `headers.getSetCookie()` (array, Node
 * >=18.14). Mantém o `.get()` como fallback pra runtime mais antigo.
 */
async function abrirSessao() {
  const resp = await fetch(`${BASE_URL}/consultaalvaracon.do?evento=x`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const cookies = typeof resp.headers.getSetCookie === 'function'
    ? resp.headers.getSetCookie()
    : (resp.headers.get('set-cookie') ? [resp.headers.get('set-cookie')] : []);
  const bruto = cookies.join('; ');
  const match = bruto.match(/JSESSIONID=[^;]+/);
  if (!match) throw new Error('Não consegui abrir sessão no portal da Prefeitura (JSESSIONID não veio).');
  return match[0];
}

/** POST da consulta em si, pro ano informado — devolve o HTML bruto da resposta. */
async function consultarAno({ base, filial, dv }, ano, cookie) {
  const body = new URLSearchParams({
    detCorrPlc: '', detCorrPlcPaginado: '', lookupCorrentePlc: '', navSetaFocoPlc: '',
    inputTituloPagina: 'Consulta Acompanhamento de Alvará',
    modoPlc: 'consultaPlc', indExcDetPlc: '', ordenacaoPlc: '', classeLookupAtualizar: '',
    evento: 'F9-Pesquisar',
    codigoEstabelecimento_Arg: '',
    numeroCgcCpfPessoaStr: base,
    numeroCgcFilialStr: filial,
    dvCgcCpfPessoaStr: dv,
    ano: String(ano),
    relatorioGravacao: '',
  });
  const resp = await fetch(`${BASE_URL}/consultaalvaracon.do`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: cookie,
    },
    body: body.toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return resp.text();
}

/**
 * Extrai, pra um tipo de alvará ("Funcionamento" ou "Sanitário"), o bloco de
 * HTML entre o título dele e o próximo marco conhecido (o outro tipo, o
 * quadro de telefones, ou fim do documento) — delimitação simples baseada
 * nos textos fixos que o portal sempre usa.
 */
function recortarBloco(html, tituloTipo) {
  const inicioRe = new RegExp(`Alvará de ${tituloTipo}<\\/span>`, 'i');
  const inicioMatch = inicioRe.exec(html);
  if (!inicioMatch) return null;
  const inicio = inicioMatch.index;
  const marcos = ['Alvará de Funcionamento</span>', 'Alvará de Sanitário</span>', 'Telefone para contato']
    .map(m => html.indexOf(m, inicio + 10))
    .filter(i => i > inicio);
  const fim = marcos.length ? Math.min(...marcos) : html.length;
  return html.slice(inicio, fim);
}

/** Dentro do bloco de um tipo, lê a linha de dados (solicitação/planilha/serviço) e as pareceres por secretaria. */
function parseBloco(bloco) {
  if (!bloco) return null;
  const campos = [...bloco.matchAll(/class="campo">\s*([^<]*?)\s*<\/td>/g)].map(m => m[1].trim());
  // As 4 primeiras "campo" são da linha de dados (CMC/CNPJ, Solicitação, Nº Planilha, Serviço);
  // as seguintes vêm em pares (Secretaria, Parecer).
  const [identificacao, solicitacao, numeroPlanilha, servico, ...resto] = campos;
  const pareceres = [];
  for (let i = 0; i < resto.length - 1; i += 2) {
    pareceres.push({ secretaria: resto[i], parecer: resto[i + 1] });
  }
  const statusMatch = /#AA0000[^"]*"[^>]*>\s*([^<]+?)\s*<\/div>/.exec(bloco);
  return {
    encontrado: !!identificacao,
    solicitacao: solicitacao || null,
    numeroPlanilha: numeroPlanilha || null,
    servico: servico || null,
    pareceres,
    statusGeral: statusMatch ? statusMatch[1].trim() : (identificacao ? 'Liberado' : null),
  };
}

/** Mensagens de erro do portal (ex.: "Alvará sanitário não encontrado.") — uma por tipo, quando não acha nada. */
function parseErros(html) {
  return [...html.matchAll(/class="msgVermelho">\s*(?:<img[^>]*>\s*)?([^<]+?)<br\s*\/?>/g)].map(m => m[1].trim());
}

/**
 * Busca no Ciclo7 os últimos `anos` (padrão 5) a partir do ano atual, ano a
 * ano, PARANDO no primeiro ano em que achar QUALQUER dado (Funcionamento
 * OU Sanitário) — mesmo critério que o Reysner descreveu usando o portal na
 * mão. Se não achar nada em nenhum ano, devolve o resultado do ano mais
 * recente mesmo assim (pra mostrar a mensagem de erro do próprio portal).
 */
async function consultarAlvaraUberlandia(cnpj, { anos = 5 } = {}) {
  const partes = partesCnpj(cnpj);
  if (!partes) throw new Error('CNPJ inválido — preciso dos 14 dígitos.');

  const cookie = await abrirSessao();
  const anoAtual = new Date().getFullYear();
  let ultimoResultado = null;

  for (let i = 0; i < anos; i++) {
    const ano = anoAtual - i;
    const html = await consultarAno(partes, ano, cookie);
    const funcionamento = parseBloco(recortarBloco(html, 'Funcionamento'));
    const sanitario = parseBloco(recortarBloco(html, 'Sanitário'));
    const erros = parseErros(html);
    const achouAlgo = (funcionamento && funcionamento.encontrado) || (sanitario && sanitario.encontrado);
    ultimoResultado = { ano, funcionamento, sanitario, erros };
    if (achouAlgo) return { ...ultimoResultado, cnpj, anosVarridos: i + 1 };
  }
  return { ...ultimoResultado, cnpj, anosVarridos: anos, nadaEncontrado: true };
}

module.exports = { consultarAlvaraUberlandia, partesCnpj };
