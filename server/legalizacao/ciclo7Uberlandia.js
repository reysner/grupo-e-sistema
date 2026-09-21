'use strict';

/**
 * Consulta de andamento de Alvará (Funcionamento + Sanitário) no portal
 * Ciclo7 da Prefeitura de Uberlândia-MG — pedido do Reysner, 17/09/2026.
 *
 * ATUALIZADO no mesmo dia (17/09/2026): o Reysner descobriu que o botão
 * "Imprimir" do resultado da busca gera uma CERTIDÃO (PDF, via relatório
 * BIRT/jCompany) que TEM a data de vencimento de verdade (ex.:
 * "Vencimento: 07/05/2030"). Então dá sim pra automatizar a data — não só
 * o status do protocolo — CONFIRMADO funcionando (testado contra o portal
 * real, ver `vencimentoEncontrado` no resultado):
 *   1) busca normal (evento=F9-Pesquisar) acha o alvará;
 *   2) na MESMA sessão, um 2º POST com evento="Gerar Certidão" devolve um
 *      campo oculto `relatorioGravacao` com a URL do relatório (às vezes
 *      entre aspas simples, cuidado ao trocar o regex);
 *   3) baixa esse relatório em __format=pdf e lê o texto com pdf-parse —
 *      o texto sai FORA de ordem visual (o rótulo "Vencimento" e a data
 *      em si podem ficar ~60 caracteres separados, com outro campo no
 *      meio), por isso testa cada ocorrência da palavra até achar uma
 *      data por perto (ver extrairVencimentoDoPdf).
 * SÓ tenta isso quando exatamente UM tipo (Funcionamento OU Sanitário) foi
 * encontrado nesse ano — o botão "Gerar Certidão" não recebe parâmetro
 * dizendo qual tipo, então com os dois juntos não dá pra saber com certeza
 * qual PDF ele geraria; nesse caso ambíguo fica só no status do protocolo,
 * pra nunca gravar a data no tipo errado.
 * Isso só funciona quando o portal ACHA o alvará (raro pra quem não é de
 * Uberlândia) — nesses casos a função devolve só o status do protocolo,
 * como antes. A extração do PDF é tratada como best-effort (try/catch) —
 * se o layout do relatório mudar ou o texto não aparecer, cai pra status
 * de protocolo sem quebrar a consulta inteira.
 *
 * Isso continua sendo um ATALHO DE PESQUISA/PREENCHIMENTO — não substitui
 * a data cadastrada em legalizacao_alvaras (o admin sempre pode corrigir).
 *
 * Portal é uma aplicação Java antiga (framework "jCompany"/"PLC") — não tem
 * API, só HTML renderizado no servidor. Reproduz aqui os mesmos POSTs que o
 * navegador faz (campos descobertos inspecionando o form real em
 * ciclo7.uberlandia.mg.gov.br), com sessão via cookie JSESSIONID.
 */

const pdfParse = require('pdf-parse');

const BASE_URL = 'https://ciclo7.uberlandia.mg.gov.br/ciclo7';
const TIMEOUT_MS = 15000;
const TIMEOUT_PDF_MS = 25000;

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
    identificacao: identificacao || null, // "CMC/CNPJ" da linha — o CMC é a inscrição municipal
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
 * 2º POST na MESMA sessão (mesmo cookie, mesmos dados de busca) trocando
 * `evento` pra "Gerar Certidão" — é o que o botão "Imprimir" da tela de
 * resultado dispara (achado inspecionando `onclick="btgerarCertidao.click()"`
 * no HTML). O portal usa o alvará que ficou "atual" na sessão do passo
 * anterior (não tem parâmetro explícito de qual linha — por isso os dois
 * POSTs precisam ser sequenciais, mesma sessão, sem pular a busca antes).
 * Devolve a URL do relatório (do campo oculto `relatorioGravacao`) ou null.
 */
async function gerarCertidaoUrl({ base, filial, dv }, ano, cookie) {
  const body = new URLSearchParams({
    detCorrPlc: '', detCorrPlcPaginado: '', lookupCorrentePlc: '', navSetaFocoPlc: '',
    inputTituloPagina: 'Consulta Acompanhamento de Alvará',
    modoPlc: 'consultaPlc', indExcDetPlc: '', ordenacaoPlc: '', classeLookupAtualizar: '',
    evento: 'Gerar Certidão',
    codigoEstabelecimento_Arg: '',
    numeroCgcCpfPessoaStr: base,
    numeroCgcFilialStr: filial,
    dvCgcCpfPessoaStr: dv,
    ano: String(ano),
    relatorioGravacao: '',
  });
  const resp = await fetch(`${BASE_URL}/consultaalvaracon.do`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    body: body.toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const html = await resp.text();
  // Esse campo às vezes vem entre aspas simples ('...'), não duplas — achado
  // testando de verdade (regex só com aspas duplas nunca batia). E a URL vem
  // com "&amp;" (HTML-encoded), precisa decodificar antes de usar.
  const match = /name="relatorioGravacao"[^>]*value=(?:"([^"]*)"|'([^']*)')/.exec(html);
  const url = match ? (match[1] || match[2]) : null;
  if (!url) return null;
  const urlDecodificada = url.replace(/&amp;/g, '&');
  // O portal gera a URL em http:// — força https:// (o site todo já serve
  // por https, e fetch de http a partir daqui pode cair em redirecionamento
  // estranho ou, num navegador, em bloqueio de conteúdo misto).
  return urlDecodificada.replace(/^http:\/\//, 'https://');
}

/** Baixa o relatório em PDF e tenta achar "Vencimento: DD/MM/AAAA" no texto extraído. Devolve AAAA-MM-DD ou null. */
let ultimaInscricao = null; // inscrição (C.M.C.) lida no último PDF de certidão — lida logo após extrairVencimentoDoPdf
async function extrairVencimentoDoPdf(urlRelatorio, cookie) {
  ultimaInscricao = null;
  const url = urlRelatorio.includes('__format=') ? urlRelatorio : urlRelatorio + '&__format=pdf';
  const resp = await fetch(url, {
    headers: { Cookie: cookie },
    signal: AbortSignal.timeout(TIMEOUT_PDF_MS),
  });
  if (process.env.DEBUG_CICLO7) console.error('[ciclo7] pdf resp:', resp.status, resp.headers.get('content-type'));
  if (!resp.ok) return null;
  const buf = Buffer.from(await resp.arrayBuffer());
  if (resp.headers.get('content-type') && !resp.headers.get('content-type').includes('pdf')) return null;
  const { text } = await pdfParse(buf);
  if (process.env.DEBUG_CICLO7) console.error('[ciclo7] texto pdf (primeiros 500):', text.slice(0,500));
  // pdf-parse extrai o texto na ordem em que os glyphs foram desenhados no
  // PDF, não necessariamente na ordem visual — testado com a certidão de
  // Funcionamento real: o rótulo "Vencimento" sai numa linha, e a DATA em
  // si só aparece ~60 caracteres depois, sozinha na própria linha (com
  // "Pessoa/CNPJ/Emissão" de outro campo da tabela no meio, fora de ordem).
  // "vencimento" também aparece solto em frases do rodapé (ex.: "...até no
  // mínimo 30 dias antes do vencimento") — por isso testa TODA ocorrência
  // da palavra, não só a primeira, até achar uma data por perto. Em cada
  // uma: 1º tenta o caso simples ("Vencimento: DD/MM/AAAA" direto, pra
  // outros relatórios/templates, ex. Sanitário, que podem sair diferente);
  // se não achar, cai pra "primeira data sozinha numa linha dentro de uma
  // janela depois da palavra".
  let match = null;
  for (const m of text.matchAll(/Vencimento/gi)) {
    const idx = m.index;
    const direto = /Vencimento:?\s*(\d{2})\/(\d{2})\/(\d{4})/i.exec(text.slice(idx, idx + 40));
    if (direto) { match = direto; break; }
    const janela = text.slice(idx, idx + 300);
    const isolada = /(?:^|\n)\s*(\d{2})\/(\d{2})\/(\d{4})\s*(?:\n|$)/.exec(janela);
    if (isolada) { match = isolada; break; }
  }
  // C.M.C. (Cadastro Mobiliário do Contribuinte) = inscrição municipal; sai no cabeçalho do PDF ("C.M.C.:601.290-00")
  const cmc = /C\.M\.C\.\s*:?\s*(\d[\d.\-]{2,18}\d)/i.exec(text);
  ultimaInscricao = cmc ? cmc[1] : null;
  if (!match) return null;
  const [, dia, mes, anoV] = match;
  return `${anoV}-${mes}-${dia}`;
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
    if (achouAlgo) {
      // Best-effort: tenta pegar a data de vencimento REAL via "Gerar
      // Certidão" (PDF) na mesma sessão que acabou de achar o resultado.
      // Nunca deixa isso quebrar a resposta — se falhar (layout mudou,
      // timeout, o alvará não tem certidão gerável), segue só com o status
      // do protocolo, que já é útil sozinho.
      //
      // IMPORTANTE (achado do Reysner, 17/09/2026): o botão "Gerar
      // Certidão" do portal NÃO recebe parâmetro dizendo qual tipo de
      // alvará — ele gera o relatório do que "está na tela" pro servidor,
      // e isso não dá pra confirmar com certeza de fora quando os DOIS
      // tipos (Funcionamento E Sanitário) aparecem juntos na mesma busca.
      // Por segurança, SÓ tenta a extração quando exatamente UM dos dois
      // foi encontrado nesse ano — ambíguo (os dois juntos) fica só com o
      // status do protocolo mesmo, pra nunca arriscar gravar a data errada
      // no tipo errado.
      const ambiguo = !!(funcionamento && funcionamento.encontrado) && !!(sanitario && sanitario.encontrado);
      if (!ambiguo) try {
        const urlCertidao = await gerarCertidaoUrl(partes, ano, cookie);
        if (process.env.DEBUG_CICLO7) console.error('[ciclo7] urlCertidao:', urlCertidao);
        if (urlCertidao) {
          const vencimento = await extrairVencimentoDoPdf(urlCertidao, cookie);
          if (process.env.DEBUG_CICLO7) console.error('[ciclo7] vencimento extraido:', vencimento);
          if (vencimento) ultimoResultado.vencimentoEncontrado = vencimento;
          if (ultimaInscricao) ultimoResultado.inscricaoMunicipal = ultimaInscricao;
        }
      } catch (e) { if (process.env.DEBUG_CICLO7) console.error('[ciclo7] certidão falhou:', e); }
      return { ...ultimoResultado, cnpj, anosVarridos: i + 1 };
    }
  }
  return { ...ultimoResultado, cnpj, anosVarridos: anos, nadaEncontrado: true };
}

module.exports = { consultarAlvaraUberlandia, partesCnpj };
