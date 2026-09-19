'use strict';

/**
 * Consulta de alvará (Licença e Localização = Funcionamento) da Prefeitura de UBERABA-MG.
 * Descoberto em 19/09/2026 — portal público, SEM login e SEM captcha, em duas etapas:
 *
 *   1) POST /tributos/alvaras.buscaEstabelecimento.logic   (identificacao=<CNPJ só dígitos>)
 *      → JSON { error, data: "[{estabelecimento, alvara, tipo_alvara ('D' definitivo / 'P' provisório), ...}]" }
 *      `alvara: null` = o estabelecimento existe mas não tem alvará.
 *   2) POST /tributos/reports.showAlvarasConsultas.logic   (estabelecimento=<código do passo 1>)
 *      → PDF "CONSULTA DE ALVARÁ DE LICENÇA E LOCALIZAÇÃO" com "Alvará nº. 3709 / 2023   Válido até: 04/05/2026".
 *
 * Devolve o mesmo formato de ciclo7Uberlandia.js (funcionamento/sanitario/vencimentoEncontrado/erros)
 * pra reaproveitar gravarResultadoConsultaAlvara. O alvará SANITÁRIO de Uberaba é da Vigilância
 * Sanitária (via Redesim/JUCEMG) e não passa por aqui — sanitário fica sempre "não encontrado".
 */

const https = require('https');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');

const HOST = 'www.uberaba.mg.gov.br';
const BASE = '/tributos/';
const UA = 'Mozilla/5.0 (compatible; GrupoE-Legalizacao)';
const TIMEOUT_MS = 30000;

// O servidor de Uberaba não envia o certificado intermediário (GoDaddy G2), então o Node recusa a
// conexão (UNABLE_TO_VERIFY_LEAF_SIGNATURE). Em vez de desligar a verificação, adicionamos o
// intermediário público às CAs confiáveis — só pra esta conexão.
const agente = new https.Agent({
  ca: [...tls.rootCertificates, fs.readFileSync(path.join(__dirname, 'certs', 'godaddy-secure-ca-g2.pem'), 'utf8')],
  keepAlive: false,
});

function requisitar(metodo, rota, corpo, cookie) {
  return new Promise((resolve, reject) => {
    const dados = corpo ? new URLSearchParams(corpo).toString() : null;
    const req = https.request({
      host: HOST, path: BASE + rota, method: metodo, agent: agente, timeout: TIMEOUT_MS,
      headers: {
        'User-Agent': UA,
        ...(dados ? { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'Content-Length': Buffer.byteLength(dados) } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
    }, (res) => {
      const partes = [];
      res.on('data', (c) => partes.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, buffer: Buffer.concat(partes) }));
    });
    req.on('timeout', () => req.destroy(new Error('Portal de Uberaba não respondeu a tempo.')));
    req.on('error', reject);
    if (dados) req.write(dados);
    req.end();
  });
}

async function abrirSessao() {
  const res = await requisitar('GET', 'alvaras.index.logic');
  if (res.status !== 200) throw new Error(`Portal de Uberaba indisponível (${res.status}).`);
  return String((res.headers['set-cookie'] || [])[0] || '').split(';')[0];
}

/** Lê "Alvará nº. 3709 / 2023" e "Válido até: DD/MM/AAAA" do PDF. */
function lerPdf(text) {
  const val = /lido\s+at.{0,3}:?\s*(\d{2})\/(\d{2})\/(\d{4})/i.exec(text);
  const num = /Alvar.{0,2}\s*n.{0,3}\.?\s*(\d+)\s*\/\s*(\d{4})/i.exec(text);
  return {
    vencimento: val ? `${val[3]}-${val[2]}-${val[1]}` : null,
    numero: num ? `${num[1]}/${num[2]}` : null,
  };
}

async function consultarAlvaraUberaba(cnpj) {
  const digitos = String(cnpj || '').replace(/\D/g, '');
  if (digitos.length !== 14) throw new Error('CNPJ inválido — preciso dos 14 dígitos.');
  const cookie = await abrirSessao();

  const r1 = await requisitar('POST', 'alvaras.buscaEstabelecimento.logic', { identificacao: digitos }, cookie);
  if (r1.status !== 200) throw new Error(`Uberaba: busca respondeu ${r1.status}.`);
  const j1 = JSON.parse(r1.buffer.toString('utf8'));
  if (j1.error) throw new Error('Uberaba: o portal recusou o CNPJ.');
  const lista = JSON.parse(j1.data || '[]').filter(e => String(e.cgc_cpf) === String(Number(digitos)) || String(e.cgc_cpf) === digitos);

  const base = { ano: new Date().getFullYear(), cnpj: digitos, anosVarridos: 1 };
  const comAlvara = lista.filter(e => e.alvara != null);
  if (!comAlvara.length) {
    const msg = lista.length ? 'Este estabelecimento não possui alvará de licença e localização em Uberaba.' : 'CNPJ não encontrado no cadastro mobiliário de Uberaba.';
    return { ...base, funcionamento: { encontrado: false }, sanitario: { encontrado: false }, erros: [msg], nadaEncontrado: true };
  }

  // Um CNPJ costuma ter 1 estabelecimento; se vier mais de um, fica com o alvará de validade mais longa.
  let melhor = null;
  for (const e of comAlvara) {
    const r2 = await requisitar('POST', 'reports.showAlvarasConsultas.logic', { estabelecimento: String(e.estabelecimento) }, cookie);
    if (r2.status !== 200 || !String(r2.headers['content-type'] || '').includes('pdf')) continue;
    const { text } = await pdfParse(r2.buffer);
    const p = lerPdf(text);
    if (!melhor || (p.vencimento && (!melhor.vencimento || p.vencimento > melhor.vencimento))) melhor = { ...p, tipo: e.tipo_alvara, numeroBanco: e.alvara };
  }

  // O portal antigo (tributos) não vê os alvarás emitidos pela Redesim/SINAL a partir de 2026 (ex.: Cardoso Adega
  // tem o nº 3709/2023 vencido lá e o MGP2600477807 vigente na Redesim). Data vencida NÃO é gravada como
  // vencimento (geraria aviso falso no sino): fica "sem data" com a explicação no resumo.
  if (melhor && melhor.vencimento && melhor.vencimento < new Date().toISOString().slice(0, 10)) {
    const fmt = melhor.vencimento.split('-').reverse().join('/');
    return { ...base, funcionamento: { encontrado: false }, sanitario: { encontrado: false }, nadaEncontrado: true,
      erros: [`Portal antigo de Uberaba mostra alvará ${melhor.numero || ''} vencido em ${fmt}; conferir se há alvará novo pela Redesim (JUCEMG/SINAL).`] };
  }

  const bloco = {
    encontrado: true,
    servico: 'Alvará de Licença e Localização',
    solicitacao: null,
    numeroPlanilha: melhor && melhor.numero ? melhor.numero : String(comAlvara[0].alvara),
    statusGeral: (melhor ? melhor.tipo : comAlvara[0].tipo_alvara) === 'P' ? 'Provisório' : 'Definitivo',
    pareceres: [],
  };
  return { ...base, funcionamento: bloco, sanitario: { encontrado: false }, erros: [], vencimentoEncontrado: melhor && melhor.vencimento ? melhor.vencimento : undefined };
}

module.exports = { consultarAlvaraUberaba, lerPdf };
