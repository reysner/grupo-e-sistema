'use strict';
/**
 * Extração MENSAL do Questor (via nWeb) para o painel /cs: faturamento dos últimos 12 meses lançados (módulo Fiscal) e funcionários ativos
 * (Folha), por CNPJ dos clientes ATIVOS do Grupo-E. Roda NUM COMPUTADOR COM A VPN conectada (a Render não alcança o Questor) e envia só
 * totais ao sistema (POST /api/cs/questor, token de sincronização). Nunca lê nem grava nome/CPF/PIS de funcionário.
 *
 * Quando: no dia 25 ou no 1º dia útil depois (o faturamento só fica lançado logo após o dia 20). Antes disto deve rodar o processo
 * "Gerar Totais por Natureza" (grava no Questor; autorização permanente do Reysner, 09/10/2026) — ver gerarTotais.js.
 *
 * Uso: node server/questor/extrair.js [--simular] [--hoje=AAAA-MM-DD] [--arquivo=saida.json]
 *   --simular  : faz tudo, mas NÃO envia ao sistema (imprime o resumo e, com --arquivo, grava os itens).
 * Segredos: server/legalizacao/.env (APP_URL, token de sincronização, DATABASE_URL) — nunca imprimir.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'legalizacao', '.env') });
const fs = require('fs');
const { Pool } = require('pg');
const nweb = require('./nwebClient');
const { periodoDeExtracao, hojeBrasilia } = require('./periodo');
const { parseFaturamento, entradaValida, avisosPorEstab, dig } = require('./faturamentoParse');

const arg = (n) => { const a = process.argv.find((x) => x.startsWith('--' + n + '=')); return a ? a.slice(n.length + 3) : null; };
const simular = process.argv.includes('--simular');

async function main() {
  const versao = await nweb.testarNweb();
  const hoje = arg('hoje') ? (([a, m, d]) => ({ ano: a, mes: m, dia: d }))(arg('hoje').split('-').map(Number)) : hojeBrasilia();
  const p = periodoDeExtracao(hoje);
  console.log(`nWeb ok (Questor ${versao}) | período: ${p.competIni} a ${p.competFim}`);

  // clientes ativos do Dashboard (só CNPJ)
  const pool = new Pool({ connectionString: (process.env.DATABASE_URL || '').trim(), ssl: { rejectUnauthorized: false }, max: 1 });
  const ativos = [...new Set((await pool.query(`SELECT regexp_replace(cnpj, '\\D', '', 'g') AS d FROM clientes WHERE status = 'ativo'`)).rows.map((r) => r.d).filter((d) => [11, 12, 14].includes(d.length)))];
  await pool.end();

  // CNPJ -> empresa/filial do Questor
  const est = await nweb.consultar('TnGemDCEstabInscrFederal');
  const ie = { emp: est.colunas.indexOf('CODIGOEMPRESA'), est: est.colunas.indexOf('CODIGOESTAB'), doc: est.colunas.indexOf('INSCRFEDERAL') };
  if (Object.values(ie).some((i) => i < 0)) throw new Error('colunas inesperadas em TnGemDCEstabInscrFederal');
  const noQuestor = new Map(); est.linhas.forEach((l) => noQuestor.set(dig(l[ie.doc]), { emp: String(l[ie.emp]), est: String(l[ie.est]) }));
  const presentes = ativos.filter((d) => noQuestor.has(d));
  console.log(`clientes ativos (CNPJ, CPF, CNO e CAEPF): ${ativos.length} | existem no Questor: ${presentes.length}`);

  // funcionários ativos por estabelecimento (consulta já traz só ativos; conferimos DEMITIDO)
  const fn = await nweb.consultar('TnFpaDCFuncContrato');
  const jf = { emp: fn.colunas.indexOf('CODIGOEMPRESA'), est: fn.colunas.indexOf('CODIGOESTAB'), dem: fn.colunas.indexOf('DEMITIDO') };
  if (Object.values(jf).some((i) => i < 0)) throw new Error('colunas inesperadas em TnFpaDCFuncContrato');
  const porEstab = new Map();
  for (const l of fn.linhas) { if (/^s/i.test(String(l[jf.dem]))) continue; const k = `${l[jf.emp]}|${l[jf.est]}`; porEstab.set(k, (porEstab.get(k) || 0) + 1); }
  console.log(`contratos de empregados ativos: ${[...porEstab.values()].reduce((a, b) => a + b, 0)} em ${porEstab.size} estabelecimentos`);

  // Faturamento: UM relatório por estabelecimento dos clientes ativos. O relatório de TODAS as empresas de uma vez esgota a memória do nWeb
  // ("Insufficient memory for this operation", 09/10/2026), e por estabelecimento também resolve matriz, filial, CPF e CNO do mesmo jeito.
  const base = { PMODELO: '1', PTIPOFATURAMENTO: '501', PCOMPETINICIAL: p.competIni, PCOMPETFINAL: p.competFim, PASSINCONT: '0', PGERARASSINATURACONTADOR: '1', PASSINSOCIO: '3', PGERARASSINATURASOCIO: '1' };
  const fatPorCnpj = new Map(), avisos = new Map(); let semLeitura = 0; const inicio = Date.now();
  for (let i = 0; i < presentes.length; i++) {
    const d = presentes[i], m = noQuestor.get(d); let lido = false;
    for (let tentativa = 1; tentativa <= 2 && !lido; tentativa++) {
      try {
        const r1 = await nweb.relatorioCsv('nFisRRFaturamento', { ...base, PCODIGOEMPRESA: m.emp, PCODIGOESTAB: m.est });
        if (/Insufficient memory/i.test(r1.mensagem || '')) throw new Error('SEM_MEMORIA');
        avisosPorEstab(r1.avisos).forEach((v, k) => avisos.set(k, v));
        const e = parseFaturamento(r1.csv).find((x) => x.cnpj === d && entradaValida(x));
        if (e) { fatPorCnpj.set(d, e.total); lido = true; }
      } catch (err) {
        if (err.message === 'SEM_MEMORIA') throw new Error('o nWeb ficou sem memória para gerar o relatório. Feche e abra o nWeb de novo no servidor da Voecloud (e logue) e rode outra vez. Nada foi enviado.');
        if (tentativa === 2) console.warn(`  ${d}: relatório falhou (${err.message})`);
      }
    }
    if (!lido) semLeitura++;
    if (semLeitura > Math.max(10, 0.1 * presentes.length)) throw new Error(`muitos estabelecimentos sem leitura (${semLeitura}) — nada será enviado`);
    if ((i + 1) % 100 === 0) console.log(`  faturamento: ${i + 1}/${presentes.length} | ${Math.round((Date.now() - inicio) / 60000)} min`);
  }
  console.log(`relatórios por estabelecimento: ${presentes.length} | lidos: ${fatPorCnpj.size} | sem leitura: ${semLeitura} | avisos de configuração: ${avisos.size} estabelecimentos`);

  const itens = presentes.map((d) => { const m = noQuestor.get(d); const av = avisos.get(`${m.emp}|${m.est}`); return { cnpj: d, faturamento: fatPorCnpj.has(d) ? fatPorCnpj.get(d) : null, funcionarios: porEstab.get(`${m.emp}|${m.est}`) || 0, aviso: av ? `Natureza(s) com movimentação sem configuração de faturamento no Questor (${av.join(', ')}): o faturamento pode estar incompleto.` : null }; });
  const comFat = itens.filter((i) => i.faturamento != null).length, zeros = itens.filter((i) => i.faturamento === 0).length;
  console.log(`itens com aviso de configuração: ${itens.filter((i) => i.aviso).length}`);
  console.log(`itens: ${itens.length} | com faturamento lido: ${comFat} (zero: ${zeros}) | sem faturamento: ${itens.length - comFat} | com funcionários > 0: ${itens.filter((i) => i.funcionarios > 0).length}`);
  const corpo = { periodo: { ini: p.ini, fim: p.fim }, itens };
  if (arg('arquivo')) fs.writeFileSync(arg('arquivo'), JSON.stringify(corpo));
  if (simular) { console.log('(simulação — nada enviado)'); return; }

  const r = await fetch((process.env.APP_URL || '').replace(/\/$/, '') + '/api/cs/questor', { method: 'POST', headers: { 'X-Sync-Token': process.env.LEGALIZACAO_SYNC_TOKEN || process.env.CERTISEGURO_SYNC_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(corpo), signal: AbortSignal.timeout(420000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`envio recusado (${r.status}) ${j.error || ''}`);
  console.log('Enviado ao Dashboard:', JSON.stringify(j));
}
main().catch((e) => { console.error('FALHOU:', e.message); process.exit(1); });
