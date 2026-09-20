'use strict';

/**
 * Lê CLIs (Certificado de Licenciamento Integrado, JUCESP/Facilita SP) baixados à mão do site — a Consulta Pública
 * (jucesp.sp.gov.br/IntegradorPaulista/ConsultaPublica) tem reCAPTCHA e o botão "Emitir CLI" só abre com clique humano —
 * e grava o vencimento (DATA DE VALIDADE do documento) como alvará de FUNCIONAMENTO.
 * Vale só pra cidade de São Paulo (exceção "até segunda ordem" do Reysner, 20/09/2026 — mesma de lerAlvarasPasta.js).
 * Só LÊ os PDFs (nunca apaga nem move). O CNPJ do documento tem que ser de uma empresa ativa do Grupo-E.
 *
 * Uso: node server/legalizacao/importarCliBaixado.js [pasta] [--simular] [--horas=24]
 *   pasta padrão: C:\Users\Grupo e\Downloads (só PDFs alterados nas últimas 24 h; --horas=N muda)
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const pdfParse = require('pdf-parse');

const args = process.argv.slice(2);
const PASTA = args.find((a) => !a.startsWith('--')) || 'C:\\Users\\Grupo e\\Downloads';
const SIMULAR = args.includes('--simular');
const HORAS = parseInt((args.find((a) => a.startsWith('--horas=')) || '').slice(8), 10) || 24;
const APP_URL = (process.env.APP_URL || '').replace(/\/$/, '');
const TOKEN = process.env.LEGALIZACAO_SYNC_TOKEN || process.env.CERTISEGURO_SYNC_TOKEN;
const IBGES_SP = new Set(['3550308']);
const soDigitos = (s) => String(s || '').replace(/\D/g, '');

async function api(metodo, rota, corpo) {
  const res = await fetch(APP_URL + '/api/data/legalizacao/' + rota, {
    method: metodo, headers: { 'X-Sync-Token': TOKEN, 'Content-Type': 'application/json' },
    body: corpo ? JSON.stringify(corpo) : undefined, signal: AbortSignal.timeout(120000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${json.error || ''}`.trim());
  return json;
}

async function main() {
  if (!APP_URL || !TOKEN) { console.error('Faltam APP_URL e/ou CERTISEGURO_SYNC_TOKEN em server/legalizacao/.env'); process.exit(1); }
  const limite = Date.now() - HORAS * 3600 * 1000;
  const pdfs = fs.readdirSync(PASTA, { withFileTypes: true })
    .filter((d) => d.isFile() && /\.pdf$/i.test(d.name))
    .map((d) => ({ nome: d.name, caminho: path.join(PASTA, d.name), mtime: fs.statSync(path.join(PASTA, d.name)).mtimeMs }))
    .filter((p) => SIMULAR ? true : p.mtime >= limite);
  const { data: empresas } = await api('GET', 'clientes-ativos');
  const porCnpj = new Map(empresas.map((e) => [soDigitos(e.cnpj), e]));
  console.log(`${pdfs.length} PDF(s) em ${PASTA}${SIMULAR ? '' : ' (últimas ' + HORAS + ' h)'}.`);

  let gravados = 0;
  for (const p of pdfs) {
    let texto = '';
    try { texto = ((await pdfParse(fs.readFileSync(p.caminho))).text || '').replace(/\s+/g, ' '); } catch (e) { continue; }
    if (!/CERTIFICADO\s+DE\s+LICENCIAMENTO\s+INTEGRADO/i.test(texto.slice(0, 900))) continue;
    const cnpjs = [...texto.matchAll(/\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/g)].map((m) => soDigitos(m[0]));
    const cnpj = cnpjs.find((c) => porCnpj.has(c));
    const val = /DATA\s+DE\s+VALIDADE\s*(\d{2})\/(\d{2})\/(\d{4})/i.exec(texto);
    const prot = /(SPP\d{10,})/.exec(texto);
    if (!cnpj) { console.log(`- ${p.nome}: CLI, mas o CNPJ não é de empresa ativa do Grupo-E — ignorado.`); continue; }
    const emp = porCnpj.get(cnpj);
    if (!IBGES_SP.has(String(emp.municipio_ibge))) { console.log(`- ${p.nome}: ${emp.nome_empresa} não é de São Paulo (exceção só vale pra SP) — ignorado.`); continue; }
    if (!val) { console.log(`- ${p.nome}: ${emp.nome_empresa} — sem "DATA DE VALIDADE" legível.`); continue; }
    const iso = `${val[3]}-${val[2]}-${val[1]}`;
    let res = '(simulação)';
    if (!SIMULAR) { try { const r = await api('POST', 'alvaras-arquivo', { cliente_id: emp.cliente_id, tipo: 'funcionamento', vencimento: iso, numero: prot ? prot[1] : null, arquivo: 'CLI baixado do JUCESP — ' + p.nome }); res = r.gravou ? 'gravado' : 'já tinha data igual/mais nova'; } catch (e) { res = 'FALHOU ' + e.message; } }
    if (/gravado|simula/.test(res)) gravados++;
    console.log(`- ${emp.nome_empresa}: CLI ${prot ? prot[1] : ''} validade ${val[1]}/${val[2]}/${val[3]} → ${res}`);
  }
  console.log(`\nConcluído: ${gravados} CLI(s) gravado(s).`);
}

main().catch((e) => { console.error('Falhou:', e.message); process.exit(1); });
