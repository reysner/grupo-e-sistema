'use strict';

/**
 * OCR local pra PDFs escaneados (sem camada de texto). Só roda nesta estação do escritório — as dependências
 * (tesseract.js + idioma português) ficam em server/legalizacao/ocr/node_modules e NÃO vão pro Render.
 * Instalar: (cd server/legalizacao/ocr && npm install)
 * O PDF vira imagem com o `pdftoppm` (Poppler); caminho em PDFTOPPM_PATH ou o padrão do MSYS2 abaixo.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const PDFTOPPM = process.env.PDFTOPPM_PATH || (fs.existsSync('C:\\msys64\\ucrt64\\bin\\pdftoppm.exe') ? 'C:\\msys64\\ucrt64\\bin\\pdftoppm.exe' : 'pdftoppm');
const RAIZ_OCR = path.join(__dirname, 'ocr', 'node_modules');
let worker = null;

function disponivel() {
  return fs.existsSync(path.join(RAIZ_OCR, 'tesseract.js')) && fs.existsSync(path.join(RAIZ_OCR, '@tesseract.js-data', 'por'));
}

async function obterWorker() {
  if (worker) return worker;
  const { createWorker } = require(path.join(RAIZ_OCR, 'tesseract.js'));
  worker = await createWorker('por', 1, {
    langPath: path.join(RAIZ_OCR, '@tesseract.js-data', 'por', '4.0.0_best_int'),
    gzip: true,
    cachePath: path.join(os.tmpdir(), 'grupoe-ocr-cache'),
    logger: () => {},
  });
  return worker;
}

/** Texto das primeiras `paginas` páginas do PDF por OCR. */
async function textoPorOcr(pdf, paginas = 2) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'grupoe-ocr-'));
  try {
    // cópia com nome ASCII: o pdftoppm no Windows engasga com acento/UNC nos argumentos
    const copia = path.join(tmp, 'entrada.pdf');
    fs.copyFileSync(pdf, copia);
    execFileSync(PDFTOPPM, ['-r', '200', '-png', '-f', '1', '-l', String(paginas), copia, path.join(tmp, 'p')], { timeout: 120000, stdio: 'ignore' });
    const imagens = fs.readdirSync(tmp).filter((f) => /\.png$/i.test(f)).sort();
    const w = await obterWorker();
    let texto = '';
    for (const img of imagens) { const r = await w.recognize(path.join(tmp, img)); texto += (r.data.text || '') + '\n'; }
    return texto;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* limpeza best-effort */ }
  }
}

async function encerrar() { if (worker) { try { await worker.terminate(); } catch (e) { /* já encerrado */ } worker = null; } }

module.exports = { disponivel, textoPorOcr, encerrar };
