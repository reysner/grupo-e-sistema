'use strict';
/**
 * Faturamento por ANO do Questor (via nWeb) para a "Análise Anual" do painel /cs: um relatório de vários anos por estabelecimento dos
 * clientes ATIVOS, somado por ano civil. Roda NUM COMPUTADOR COM A VPN conectada (a Render não alcança o Questor) e envia só totais por
 * CNPJ e ano (POST /api/cs/questor/anual, token de sincronização). Somente leitura no Questor; nunca lê dados de funcionário.
 *
 * Uso: node server/questor/extrairAnual.js [--ano-inicial=2015] [--limite=N] [--simular] [--arquivo=saida.json] [--retomar=parcial.json]
 *   --simular   faz tudo, mas NÃO envia ao sistema (imprime o resumo; com --arquivo grava o resultado)
 *   --limite=N  só os N primeiros estabelecimentos (teste)
 *   --retomar   continua de um arquivo parcial (gravado a cada 25 estabelecimentos em --arquivo)
 * Período: de janeiro do ano inicial até o último mês fechado (mesma regra do dia 25 da extração mensal).
 * Segredos: server/legalizacao/.env (APP_URL, token de sincronização, DATABASE_URL) — nunca imprimir.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'legalizacao', '.env') });
const fs = require('fs');
const { Pool } = require('pg');
const nweb = require('./nwebClient');
const { periodoDeExtracao, hojeBrasilia } = require('./periodo');
const { parseFaturamento, dig } = require('./faturamentoParse');
const { agregarPorAno, mesesEsperados, parseAtivos, parseOptantes, funcionariosDoAno, rotuloRegime, regimeDaReceita } = require('./anual');

// Regime tributário: dados abertos da Receita Federal via BrasilAPI (CNPJ é dado público); o Questor fica só como reserva (o cadastro de regime lá não é confiável).
const os = require('os');
const CACHE_RECEITA = path.join(os.tmpdir(), 'brasilapi_regime_cache.json');
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
async function lerReceita(docs) {
  let cache = {}; try { cache = JSON.parse(fs.readFileSync(CACHE_RECEITA, 'utf8')); } catch (e) { cache = {}; }
  const validade = 20 * 86400000;
  let buscados = 0, falhas = 0;
  // 4 consultas ao mesmo tempo: CNPJ novo na BrasilAPI leva uns 5 s para ser buscado na origem; em fila, 600 CNPJs levariam quase uma hora
  const fila = docs.filter((d) => d.length === 14 && !(cache[d] && Date.now() - cache[d].t < validade));
  let proximo = 0;
  const trabalhar = async () => {
  while (proximo < fila.length) {
    const d = fila[proximo++];
    let ok = false;
    for (let t = 0; t < 4 && !ok; t++) {
      try {
        const r = await fetch('https://brasilapi.com.br/api/cnpj/v1/' + d, { headers: { 'User-Agent': 'grupo-e-sistema' }, signal: AbortSignal.timeout(30000) });
        if (r.status === 404) { cache[d] = { t: Date.now(), j: null }; ok = true; break; }
        if (r.status === 429 || r.status >= 500) { await esperar(3000 * (t + 1)); continue; }
        if (!r.ok) break;
        const j = await r.json();
        cache[d] = { t: Date.now(), j: { opcao_pelo_simples: j.opcao_pelo_simples, opcao_pelo_mei: j.opcao_pelo_mei, data_opcao_pelo_simples: j.data_opcao_pelo_simples, data_exclusao_do_simples: j.data_exclusao_do_simples, regime_tributario: j.regime_tributario || [] } };
        ok = true;
      } catch (e) { await esperar(2000); }
    }
    if (!ok) falhas++;
    buscados++;
    if (buscados % 50 === 0) { fs.writeFileSync(CACHE_RECEITA, JSON.stringify(cache)); console.log('  Receita: ' + buscados + ' consultados'); }
    await esperar(150);
  }
  };
  await Promise.all([trabalhar(), trabalhar(), trabalhar(), trabalhar()]);
  fs.writeFileSync(CACHE_RECEITA, JSON.stringify(cache));
  console.log('Receita (BrasilAPI): ' + buscados + ' consultados nesta rodada, ' + falhas + ' sem resposta');
  return cache;
}

const arg = (n) => { const a = process.argv.find((x) => x.startsWith('--' + n + '=')); return a ? a.slice(n.length + 3) : null; };
const simular = process.argv.includes('--simular');
const ANO_INICIAL = parseInt(arg('ano-inicial'), 10) || 2015;
const LIMITE = parseInt(arg('limite'), 10) || 0;

async function enviar(corpo) {
  const resp = await fetch((process.env.APP_URL || '').replace(/\/$/, '') + '/api/cs/questor/anual', {
    method: 'POST', headers: { 'X-Sync-Token': process.env.LEGALIZACAO_SYNC_TOKEN || process.env.CERTISEGURO_SYNC_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(corpo), signal: AbortSignal.timeout(180000),
  });
  const j = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`envio recusado (${resp.status}) ${j.error || ''}${j.detalhe ? ' — ' + j.detalhe : ''}`);
  console.log('Enviado ao Dashboard:', JSON.stringify(j));
}

async function main() {
  // --enviar-arquivo=saida.json: manda uma leitura já feita (gravada com --arquivo) sem falar com o Questor
  if (arg('enviar-arquivo')) {
    const doc = JSON.parse(fs.readFileSync(arg('enviar-arquivo'), 'utf8'));
    if (!doc.corpo) throw new Error('o arquivo não tem a leitura completa (corpo); rode a extração até o fim.');
    return enviar(doc.corpo);
  }
  const versao = await nweb.testarNweb();
  const p = periodoDeExtracao(hojeBrasilia());
  const competIni = `01/${ANO_INICIAL}`, competFim = p.competFim, fim = p.fim;   // fim 'AAAA-MM'
  console.log(`nWeb ok (Questor ${versao}) | período: ${competIni} a ${competFim} (${mesesEsperados(ANO_INICIAL, fim)} meses)`);

  const pool = new Pool({ connectionString: (process.env.DATABASE_URL || '').trim(), ssl: { rejectUnauthorized: false }, max: 1 });
  const linhasAtivos = (await pool.query(`SELECT regexp_replace(cnpj, '\\D', '', 'g') AS d, regime_tributario AS regime FROM clientes WHERE status = 'ativo'`)).rows;
  const ativos = [...new Set(linhasAtivos.map((r) => r.d).filter((d) => [11, 12, 14].includes(d.length)))];
  // regime atual do cadastro do Acessórias (só as três opções que importam; reserva para o ano corrente e o anterior)
  const regimeAcessorias = new Map();
  linhasAtivos.forEach((r) => {
    const t = String(r.regime || '').toLowerCase();
    const rot = /presumido/.test(t) ? 'Lucro Presumido' : /lucro real|^real$/.test(t) ? 'Lucro Real' : /simples|mei/.test(t) ? 'Simples Nacional' : null;
    if (rot) regimeAcessorias.set(r.d, rot);
  });
  await pool.end();

  const est = await nweb.consultar('TnGemDCEstabInscrFederal');
  const ie = { emp: est.colunas.indexOf('CODIGOEMPRESA'), est: est.colunas.indexOf('CODIGOESTAB'), doc: est.colunas.indexOf('INSCRFEDERAL') };
  if (Object.values(ie).some((i) => i < 0)) throw new Error('colunas inesperadas em TnGemDCEstabInscrFederal');
  const noQuestor = new Map(); est.linhas.forEach((l) => noQuestor.set(dig(l[ie.doc]), { emp: String(l[ie.emp]), est: String(l[ie.est]) }));
  let presentes = ativos.filter((d) => noQuestor.has(d));
  if (LIMITE) presentes = presentes.slice(0, LIMITE);
  console.log(`clientes ativos: ${ativos.length} | no Questor: ${presentes.length}${LIMITE ? ' (limitado por --limite)' : ''}`);

  const base = { PMODELO: '1', PTIPOFATURAMENTO: '501', PCOMPETINICIAL: competIni, PCOMPETFINAL: competFim, PASSINCONT: '0', PGERARASSINATURACONTADOR: '1', PASSINSOCIO: '3', PGERARASSINATURASOCIO: '1' };
  const resultado = {};      // doc -> { anos, total }
  const falhas = [];         // { doc, motivo }
  const parcial = arg('retomar') && fs.existsSync(arg('retomar')) ? JSON.parse(fs.readFileSync(arg('retomar'), 'utf8')) : null;
  if (parcial) { Object.assign(resultado, parcial.resultado || {}); console.log(`retomando: ${Object.keys(resultado).length} estabelecimentos já lidos`); }
  const inicio = Date.now(); let feitos = 0;
  for (const d of presentes) {
    if (resultado[d]) continue;
    const m = noQuestor.get(d);
    let r = null, motivo = '';
    for (let tentativa = 1; tentativa <= 2 && !(r && r.ok); tentativa++) {
      try {
        const rel = await nweb.relatorioCsv('nFisRRFaturamento', { ...base, PCODIGOEMPRESA: m.emp, PCODIGOESTAB: m.est });
        if (/Insufficient memory/i.test(rel.mensagem || '')) throw new Error('SEM_MEMORIA');
        r = agregarPorAno(parseFaturamento(rel.csv), d);
        if (!r.ok) motivo = r.motivo;
      } catch (err) {
        if (err.message === 'SEM_MEMORIA') throw new Error('o nWeb ficou sem memória para gerar o relatório. Feche e abra o nWeb de novo no servidor da Voecloud (e logue) e rode outra vez com --retomar. Nada foi enviado.');
        motivo = err.message;
      }
    }
    if (r && r.ok) resultado[d] = { anos: r.anos, total: r.total }; else falhas.push({ doc: d, motivo });
    feitos++;
    if (falhas.length > Math.max(10, 0.1 * presentes.length)) throw new Error(`muitas falhas de leitura (${falhas.length}) — nada será enviado`);
    if (feitos % 25 === 0) {
      const dec = (Date.now() - inicio) / 60000;
      console.log(`  ${Object.keys(resultado).length}/${presentes.length} lidos | ${falhas.length} falhas | ${dec.toFixed(1)} min`);
      if (arg('arquivo')) fs.writeFileSync(arg('arquivo'), JSON.stringify({ ate: fim, ano_inicial: ANO_INICIAL, resultado }));
    }
  }
  console.log(`lidos: ${Object.keys(resultado).length} | falhas: ${falhas.length}${falhas.length ? ' (' + falhas.slice(0, 5).map((f) => f.doc + ': ' + f.motivo).join(' | ') + ')' : ''}`);

  // ── Funcionários por mês (relatório "Empregados Ativos", agrupado por Empresa e Competência): um relatório por ano, todas as empresas ──
  const [anoFim, mesFim] = fim.split('-').map(Number);
  const ultimoDia = (a, m) => new Date(Date.UTC(a, m, 0)).getUTCDate();
  const ativosPorEmp = {};
  for (let ano = ANO_INICIAL; ano <= anoFim; ano++) {
    const ate = ano === anoFim ? `${ultimoDia(anoFim, mesFim)}/${String(mesFim).padStart(2, '0')}/${anoFim}` : `31/12/${ano}`;
    const j = await nweb.chamar('/TnWebDMRelatorio/Executar?_AActionName=nfpaRRFuncAtivo&_ABase64=False&_ATipoRetorno=nrwexCSV',
      { PCOMPETINICIAL: `01/01/${ano}`, PCOMPETFIN: ate, PQUEBRA: '2', PORDENAR: '0' }, { timeoutMs: 240000 });
    if (/Insufficient memory/i.test(j.Message || '')) throw new Error('o nWeb ficou sem memória no relatório de funcionários. Feche e abra o nWeb de novo e rode outra vez. Nada foi enviado.');
    const r = parseAtivos(j.Data || '');
    Object.keys(r).forEach((emp) => { ativosPorEmp[emp] = Object.assign(ativosPorEmp[emp] || {}, r[emp]); });
  }
  console.log(`funcionários: ${Object.keys(ativosPorEmp).length} empresas com folha processada`);

  const receita = await lerReceita(presentes);
  // a contagem de funcionários é por EMPRESA do Questor: fica no documento do estabelecimento de menor código (a matriz) entre os clientes lidos
  const donoDaEmpresa = new Map();
  for (const d of presentes) { const m = noQuestor.get(d); const atual = donoDaEmpresa.get(m.emp); if (!atual || Number(m.est) < Number(noQuestor.get(atual).est)) donoDaEmpresa.set(m.emp, d); }
  // regime só da Receita (o cadastro de regime do Questor não é confiável); sem informação da Receita fica em branco
  const regimeDoAno = (cnpj, ano) => {
    const rec = receita[cnpj] && receita[cnpj].j ? regimeDaReceita(receita[cnpj].j, ano) : null;
    if (cnpj.length !== 14) return { regime: null, regime_fonte: null };            // CPF, CNO e CAEPF não têm regime: ficam em branco
    if (rec && rec.regime !== 'Lucro (Presumido/Real)') return { regime: rec.regime, regime_fonte: rec.fonte };
    // a Receita não define Presumido x Real (sem ECF, ou saiu do Simples): vale o regime ATUAL do Acessórias, só para o ano corrente e o anterior
    const ac = regimeAcessorias.get(cnpj);
    if (ac && ano >= anoFim - 1) return { regime: ac, regime_fonte: 'Acessórias (regime atual)' };
    return { regime: null, regime_fonte: null };
  };
  const itens = presentes.map((cnpj) => {
    const m = noQuestor.get(cnpj), fat = resultado[cnpj] ? resultado[cnpj].anos : {};
    const falha = falhas.find((f) => f.doc === cnpj);
    const aviso = !resultado[cnpj] && falha ? 'Faturamento não usado: ' + falha.motivo.replace(/^soma dos meses \(([\d.]+)\) não bate com o TOTAL \(([\d.]+)\)$/, (_, a, b) => 'o total do relatório do Questor (R$ ' + Number(b).toLocaleString('pt-BR', { minimumFractionDigits: 2 }) + ') não fecha com a soma dos meses (R$ ' + Number(a).toLocaleString('pt-BR', { minimumFractionDigits: 2 }) + ')') : null;
    const meses = donoDaEmpresa.get(m.emp) === cnpj ? (ativosPorEmp[m.emp] || {}) : null;
    const anos = [];
    for (let ano = ANO_INICIAL; ano <= anoFim; ano++) {
      const f = fat[ano], fn = meses ? funcionariosDoAno(meses, ano) : { funcionarios: null, funcionarios_media: null };
      anos.push({
        ano, faturamento: f ? f.faturamento : null, meses: f ? f.meses : 0, meses_com_valor: f ? f.meses_com_valor : 0,
        funcionarios: fn.funcionarios, funcionarios_media: fn.funcionarios_media, ...regimeDoAno(cnpj, ano), aviso: f ? null : aviso,
      });
    }
    return { cnpj, anos };
  });
  const corpo = { ate: fim, ano_inicial: ANO_INICIAL, itens };
  if (arg('arquivo')) fs.writeFileSync(arg('arquivo'), JSON.stringify({ ate: fim, ano_inicial: ANO_INICIAL, resultado, corpo }));
  if (simular) { console.log('(simulação — nada enviado)'); return; }
  if (LIMITE) { console.log('NÃO ENVIADO: --limite lê só parte da carteira.'); return; }

  await enviar(corpo);
}
main().catch((e) => { console.error('FALHOU:', e.message); process.exit(1); });
