'use strict';

/**
 * Lê os PDFs de alvará SANITÁRIO que o escritório já guarda no servidor — pasta
 * `...\EMPRESAS\LEGALIZACAO\<razão social>\Alvaras` — extrai o VENCIMENTO do texto do PDF e manda pro Grupo-E.
 * Funciona pra qualquer cidade (não depende de prefeitura) e roda todo dia: alvará novo salvo na pasta entra sozinho.
 * Só o SANITÁRIO (decisão do Reysner, 20/09/2026): o de FUNCIONAMENTO vem direto da prefeitura/Redesim, nunca desta pasta.
 *
 * SÓ LÊ: nunca cria, move, renomeia nem apaga arquivo do servidor.
 * Segurança da leitura: só aceita o documento se o CNPJ da empresa aparece no texto do PDF.
 * PDF escaneado (sem texto) não dá pra ler sem OCR: entra no relatório final, pra decidir depois.
 *
 * Segredos: server/legalizacao/.env (APP_URL e CERTISEGURO_SYNC_TOKEN — os mesmos do certiseguroSync).
 * Uso: node server/legalizacao/lerAlvarasPasta.js [--simular] [--limite=N] [--empresa=TRECHO_DO_NOME]
 *   --simular  lê e mostra o que acharia, sem gravar nada no Grupo-E.
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const pdfParse = require('pdf-parse');

const PASTA = process.env.LEGALIZACAO_PASTA || '\\\\192.168.251.13\\escritorial$\\UNIDADE ORGANIZACIONAL\\EMPRESAS\\LEGALIZACAO';
const APP_URL = (process.env.APP_URL || '').replace(/\/$/, '');
const TOKEN = process.env.LEGALIZACAO_SYNC_TOKEN || process.env.CERTISEGURO_SYNC_TOKEN;
const MAX_PDF_BYTES = 25 * 1024 * 1024;
const args = process.argv.slice(2);
const SIMULAR = args.includes('--simular');
const LIMITE = parseInt((args.find((a) => a.startsWith('--limite=')) || '').slice(9), 10) || Infinity;
const FILTRO = ((args.find((a) => a.startsWith('--empresa=')) || '').slice(10) || '').toUpperCase();
const hora = () => new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' });
const dorme = (ms) => new Promise((r) => setTimeout(r, ms));
process.on('unhandledRejection', () => { /* PDF corrompido (ex.: "bad XRef entry"): já tratado como ilegível no lerPdf */ });

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
const soDigitos = (s) => String(s || '').replace(/\D/g, '');

async function api(metodo, rota, corpo) {
  let ultimo;
  for (let i = 0; i < 5; i++) {
    try {
      const res = await fetch(APP_URL + '/api/data/legalizacao/' + rota, {
        method: metodo,
        headers: { 'X-Sync-Token': TOKEN, 'Content-Type': 'application/json' },
        body: corpo ? JSON.stringify(corpo) : undefined,
        signal: AbortSignal.timeout(120000),
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok) return json;
      ultimo = Object.assign(new Error(`${res.status} ${json.error || ''}`.trim()), { temporario: res.status >= 500 });
      if (!ultimo.temporario) throw ultimo;
    } catch (e) { ultimo = e; if (e.temporario === false) throw e; }
    await dorme(15000);
  }
  throw ultimo;
}

// ── achar a pasta da empresa e listar os PDFs de alvará ─────────────────
function listarPdfs(dir, prof) {
  let saida = [];
  let itens = [];
  try { itens = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return saida; }
  for (const it of itens) {
    const p = path.join(dir, it.name);
    if (it.isFile() && /\.pdf$/i.test(it.name)) saida.push(p);
    else if (it.isDirectory() && prof > 0) saida = saida.concat(listarPdfs(p, prof - 1));
  }
  return saida;
}

function acharPastaAlvaras(pastaEmpresa) {
  try {
    const d = fs.readdirSync(pastaEmpresa, { withFileTypes: true }).find((x) => x.isDirectory() && /^alvar/i.test(x.name));
    return d ? path.join(pastaEmpresa, d.name) : null;
  } catch (e) { return null; }
}

// ── leitura do texto do PDF ─────────────────────────────────────────────
const DATA_RE = '(\\d{2})[\\/.-](\\d{2})[\\/.-](\\d{4})';
const PADROES_VENC = [
  new RegExp('Data\\s+de\\s+Vencimento:?\\s*' + DATA_RE, 'i'),
  new RegExp('Vencimento:?\\s*' + DATA_RE, 'i'),
  new RegExp('V[áa]lid[oa]\\s+at[ée]:?\\s*' + DATA_RE, 'i'),
  new RegExp('Validade:?\\s*' + DATA_RE, 'i'),
  new RegExp('Vig[êe]ncia[^0-9]{0,40}' + DATA_RE, 'i'),
  // Alvará de funcionamento de Uberlândia: "Emissão:22/12/2023 07/11/2026" — a 2ª data (logo após a emissão) é o vencimento.
  new RegExp('Emiss[ãa]o:?\\s*\\d{2}[\\/.-]\\d{2}[\\/.-]\\d{4}\\s+' + DATA_RE, 'i'),
  new RegExp('venc\\.?\\s*' + DATA_RE, 'i'),
];
function acharVencimento(texto, nomeArquivo) {
  for (const fonte of [texto.replace(/\s+/g, ' '), nomeArquivo]) {
    for (const re of PADROES_VENC) {
      const m = re.exec(fonte);
      if (m) {
        const ano = +m[3];
        if (ano >= 2000 && ano <= 2100 && +m[2] >= 1 && +m[2] <= 12) return `${m[3]}-${m[2]}-${m[1]}`;
      }
    }
  }
  return null;
}

function acharTipo(texto, nomeArquivo) {
  if (/sanit|visa|vigil/i.test(nomeArquivo)) return 'sanitario';
  if (/funcion|localiz/i.test(nomeArquivo)) return 'funcionamento';
  const inicio = texto.slice(0, 700);
  if (/ALVAR[ÁA]\s+SANIT[ÁA]RIO|AUTORIZA[ÇC][ÃA]O\s+SANIT[ÁA]RIA|LICEN[ÇC]A\s+SANIT[ÁA]RIA|LICENCIAMENTO\s+VIGIL/i.test(inicio)) return 'sanitario';
  if (/ALVAR[ÁA]\s+DE\s+(LICEN[ÇC]A|FUNCIONAMENTO|LOCALIZA)|LICEN[ÇC]A\s+DE\s+FUNCIONAMENTO/i.test(inicio)) return 'funcionamento';
  return null;
}

function acharNumero(texto) {
  const m = /N[ÚU]MERO:?\s*([0-9][0-9\/.\-]{3,})/i.exec(texto) || /Alvar[áa]\s+n[ºo°.]{0,2}\s*([0-9][0-9\/.\-]{2,})/i.exec(texto);
  return m ? m[1] : null;
}

async function lerPdf(arquivo, cnpj) {
  const st = fs.statSync(arquivo);
  if (st.size > MAX_PDF_BYTES) return { ignorado: 'grande demais' };
  const nome = path.basename(arquivo);
  if (/funcion|localiz/i.test(nome) && !/sanit|visa|vigil/i.test(nome)) return { ignorado: 'funcionamento' };
  let texto = '';
  try { texto = (await pdfParse(fs.readFileSync(arquivo))).text || ''; } catch (e) { return { erro: 'PDF ilegível' }; }
  if (texto.replace(/\s+/g, '').length < 80) return { semTexto: true };
  const digitos = soDigitos(texto);
  if (!digitos.includes(cnpj)) return { cnpjDiferente: true };
  const tipo = acharTipo(texto, nome);
  if (tipo !== 'sanitario') return { ignorado: 'não é sanitário' };
  return { tipo, vencimento: acharVencimento(texto, nome), numero: acharNumero(texto), arquivo: nome };
}

async function main() {
  if (!APP_URL || !TOKEN) { console.error('Faltam APP_URL e/ou CERTISEGURO_SYNC_TOKEN em server/legalizacao/.env'); process.exit(1); }
  console.log(`[${hora()}] ${SIMULAR ? 'SIMULAÇÃO (não grava) — ' : ''}pasta: ${PASTA}`);
  const dirs = fs.readdirSync(PASTA, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  const porNorm = new Map(dirs.map((d) => [norm(d), d]));
  const { data } = await api('GET', 'clientes-ativos');
  let empresas = data.filter((e) => !FILTRO || norm(e.nome_empresa).includes(norm(FILTRO)));
  empresas = empresas.slice(0, LIMITE);
  console.log(`[${hora()}] ${empresas.length} empresa(s) ativa(s) pra conferir.`);

  const rel = { semPasta: [], semAlvaras: [], semTexto: [], cnpjDiferente: [], semVencimento: [], gravados: { sanitario: 0, funcionamento: 0 }, empresasComSanitario: 0 };
  for (let i = 0; i < empresas.length; i++) {
    const e = empresas[i];
    const cnpj = soDigitos(e.cnpj);
    const n = norm(e.nome_empresa);
    let pasta = porNorm.get(n);
    if (!pasta) { const c = [...porNorm.keys()].find((k) => k.length >= 12 && n.length >= 12 && (k.startsWith(n) || n.startsWith(k))); if (c) pasta = porNorm.get(c); }
    if (!pasta) { rel.semPasta.push(e.nome_empresa); continue; }
    const alv = acharPastaAlvaras(path.join(PASTA, pasta));
    if (!alv) { rel.semAlvaras.push(e.nome_empresa); continue; }

    const melhor = {}; // tipo -> {vencimento, numero, arquivo}
    for (const pdf of listarPdfs(alv, 2)) {
      let r;
      try { r = await lerPdf(pdf, cnpj); } catch (err) { r = { erro: err.message }; }
      if (r.semTexto) rel.semTexto.push(`${e.nome_empresa} — ${path.basename(pdf)}`);
      else if (r.cnpjDiferente) rel.cnpjDiferente.push(`${e.nome_empresa} — ${path.basename(pdf)}`);
      else if (r.tipo) {
        if (!r.vencimento) rel.semVencimento.push(`${e.nome_empresa} — ${r.arquivo}`);
        else if (!melhor[r.tipo] || r.vencimento > melhor[r.tipo].vencimento) melhor[r.tipo] = r;
      }
    }
    for (const tipo of Object.keys(melhor)) {
      const m = melhor[tipo];
      let gravou = '(simulação)';
      if (!SIMULAR) {
        try { const r = await api('POST', 'alvaras-arquivo', { cliente_id: e.cliente_id, tipo, vencimento: m.vencimento, numero: m.numero, arquivo: m.arquivo }); gravou = r.gravou ? 'gravado' : 'já tinha data igual/mais nova'; }
        catch (err) { gravou = 'FALHOU ' + err.message; }
      }
      if (/gravado|simula/.test(gravou)) rel.gravados[tipo]++;
      if (tipo === 'sanitario') rel.empresasComSanitario++;
      console.log(`[${hora()}] ${i + 1}/${empresas.length} ${e.nome_empresa}: ${tipo} vence ${m.vencimento.split('-').reverse().join('/')} — ${m.arquivo} → ${gravou}`);
    }
    if ((i + 1) % 100 === 0) console.log(`[${hora()}] … ${i + 1}/${empresas.length} conferidas`);
  }

  if (!SIMULAR) {
    try { const a = await api('POST', 'sanitario-avaliar'); console.log(`[${hora()}] Avaliação por CNAE: ${JSON.stringify(a)}`); } catch (err) { console.log('Avaliação por CNAE falhou:', err.message); }
  }
  const mostra = (t, l) => console.log(`\n${t}: ${l.length}${l.length ? '\n  ' + l.slice(0, 25).join('\n  ') + (l.length > 25 ? `\n  … (+${l.length - 25})` : '') : ''}`);
  console.log(`\n=== RESUMO ===\nalvarás sanitários gravados: ${rel.gravados.sanitario}`);
  mostra('Empresas sem pasta no servidor', rel.semPasta);
  mostra('Empresas sem subpasta Alvaras', rel.semAlvaras);
  mostra('PDFs ESCANEADOS (sem texto — precisariam de OCR)', rel.semTexto);
  mostra('PDFs com CNPJ diferente do cadastro (ignorados)', rel.cnpjDiferente);
  mostra('Alvarás sanitários sem data legível', rel.semVencimento);
  try { fs.writeFileSync(path.join(__dirname, 'relatorio-alvaras-pasta.json'), JSON.stringify(rel, null, 1)); } catch (e) { /* relatório é só conveniência */ }
}

main().catch((e) => { console.error('Falhou:', e.message); process.exit(1); });
