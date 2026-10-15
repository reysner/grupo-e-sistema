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
const { agregarPorAno, mesesEsperados } = require('./anual');

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
  const ativos = [...new Set((await pool.query(`SELECT regexp_replace(cnpj, '\\D', '', 'g') AS d FROM clientes WHERE status = 'ativo'`)).rows.map((r) => r.d).filter((d) => [11, 12, 14].includes(d.length)))];
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

  const itens = Object.keys(resultado).map((cnpj) => ({
    cnpj,
    anos: Object.keys(resultado[cnpj].anos).sort().map((a) => ({ ano: Number(a), faturamento: resultado[cnpj].anos[a].faturamento, meses: resultado[cnpj].anos[a].meses, meses_com_valor: resultado[cnpj].anos[a].meses_com_valor })),
  }));
  const corpo = { ate: fim, ano_inicial: ANO_INICIAL, itens };
  if (arg('arquivo')) fs.writeFileSync(arg('arquivo'), JSON.stringify({ ate: fim, ano_inicial: ANO_INICIAL, resultado, corpo }));
  if (simular) { console.log('(simulação — nada enviado)'); return; }
  if (LIMITE) { console.log('NÃO ENVIADO: --limite lê só parte da carteira.'); return; }

  await enviar(corpo);
}
main().catch((e) => { console.error('FALHOU:', e.message); process.exit(1); });
