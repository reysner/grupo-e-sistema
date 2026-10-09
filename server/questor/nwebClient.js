'use strict';
/**
 * Cliente mínimo do nWeb do Questor (API do Questor Desktop na Voecloud). Só funciona com a VPN conectada e o nWeb aberto/logado
 * no servidor. O nWeb usa GET COM CORPO JSON (o fetch do Node não permite), por isso usamos o módulo http.
 * Endereço: QUESTOR_NWEB no server/legalizacao/.env (padrão http://192.168.251.72:6072). Token opcional: QUESTOR_TOKEN_API (se a Voecloud configurar).
 */
const http = require('http');
const BASE = (process.env.QUESTOR_NWEB || 'http://192.168.251.72:6072').replace(/\/$/, '');

function chamar(caminho, corpo, { timeoutMs = 600000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(BASE + caminho);
    if (process.env.QUESTOR_TOKEN_API) u.searchParams.set('TokenApi', process.env.QUESTOR_TOKEN_API);
    const dados = corpo ? Buffer.from(JSON.stringify(corpo)) : null;
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET', timeout: timeoutMs,
      headers: dados ? { 'Content-Type': 'application/json', 'Content-Length': dados.length } : {} }, (res) => {
      const partes = []; res.on('data', (c) => partes.push(c));
      res.on('end', () => {
        const texto = Buffer.concat(partes).toString('utf8');
        if (res.statusCode !== 200) return reject(new Error(`nWeb respondeu ${res.statusCode} em ${u.pathname}`));
        try { resolve(JSON.parse(texto)); } catch (e) { reject(new Error('resposta do nWeb não é JSON em ' + u.pathname)); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('tempo esgotado em ' + u.pathname)));
    req.on('error', reject);
    if (dados) req.write(dados);
    req.end();
  });
}

/** Teste de vida (sem login, só com VPN + nWeb aberto). Lança Error com a orientação certa se não responder. */
async function testarNweb() {
  try { const r = await chamar('/TnWebDMDadosGerais/PegarVersaoQuestor', null, { timeoutMs: 15000 }); return r.Versao; }
  catch (e) { throw new Error('O nWeb não respondeu (' + e.message + '). Conecte a VPN (OpenVPN) e, se continuar sem resposta, abra e logue o nWeb no servidor da Voecloud (atalho "nWeb - Atalho", porta 6072).'); }
}

/** Consulta paginada de uma tela do Questor: devolve { colunas, linhas, total }. Corpo com Filter vazio = sem filtro. */
async function consultar(acao, filtro = {}) {
  const j = await chamar(`/TnWebDMConsulta/Pegar?_AActionName=${acao}&_AsEcho=Asc&_AiDisplayStart=0&_AiDisplayLength=50000&_AOrderBy=1`, { Filter: filtro });
  return { colunas: j.aoColumns || [], linhas: j.aaData || [], total: j.RecordCount };
}

/** Relatório em CSV (texto): devolve o conteúdo (campo Data). */
async function relatorioCsv(acao, parametros) {
  const j = await chamar(`/TnWebDMRelatorio/Executar?_AActionName=${acao}&_ABase64=False&_ATipoRetorno=nrwexCSV`, parametros);
  if (j.ErrosRelatorio && j.ErrosRelatorio.length) throw new Error('o relatório informou erro: ' + JSON.stringify(j.ErrosRelatorio).slice(0, 200));
  return j.Data || '';
}

module.exports = { chamar, testarNweb, consultar, relatorioCsv, BASE };
