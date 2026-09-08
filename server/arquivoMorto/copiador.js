'use strict';
/**
 * Cópia INCREMENTAL e não-destrutiva.
 *
 * Regras (decisão do Reysner):
 *   - só COPIA — nunca move, nunca apaga, nunca toca na origem;
 *   - se o arquivo já existe no destino, NÃO sobrescreve (mesmo com tamanho/
 *     data diferente) — só conta como "já existia";
 *   - cria as pastas do destino conforme precisa.
 *
 * Caminhos longos no Windows: usa o prefixo `\\?\` (mágica do Win32 pra passar
 * de 260 chars). Só serve com caminho absoluto e separador `\`.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

/** Prefixa `\\?\` (ou `\\?\UNC\` pra UNC) pra aguentar caminho > 260 chars. */
function longPath(p) {
  const abs = path.win32.resolve(p);
  if (abs.startsWith('\\\\?\\')) return abs;
  if (abs.startsWith('\\\\')) return '\\\\?\\UNC\\' + abs.slice(2);
  return '\\\\?\\' + abs;
}

async function existe(p) {
  try { await fsp.access(longPath(p)); return true; } catch { return false; }
}

async function listarSubpastas(dir) {
  let ents;
  try { ents = await fsp.readdir(longPath(dir), { withFileTypes: true }); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  return ents.filter(e => e.isDirectory()).map(e => e.name);
}

/**
 * Copia recursivamente o CONTEÚDO de `origem` pra dentro de `destino`.
 * `filtroArquivo(nomeRelativo)` opcional — retorna true pra copiar o arquivo.
 * `dryRun` só conta, não escreve nada.
 *
 * @returns {{copiados:number, jaExistiam:number, bytes:number, erros:Array<{arquivo:string,motivo:string}>}}
 */
async function copiarConteudo(origem, destino, { dryRun = false, filtroArquivo = null } = {}) {
  const res = { copiados: 0, jaExistiam: 0, bytes: 0, erros: [] };

  async function andar(relDir) {
    const dirOrig = relDir ? path.win32.join(origem, relDir) : origem;
    let ents;
    try { ents = await fsp.readdir(longPath(dirOrig), { withFileTypes: true }); }
    catch (e) {
      if (e.code === 'ENOENT') return;
      res.erros.push({ arquivo: relDir || '.', motivo: e.message });
      return;
    }

    for (const ent of ents) {
      const rel = relDir ? path.win32.join(relDir, ent.name) : ent.name;
      if (ent.isDirectory()) {
        await andar(rel);
        continue;
      }
      if (!ent.isFile()) continue; // ignora symlink / device / etc.
      if (filtroArquivo && !filtroArquivo(rel)) continue;

      const alvo = path.win32.join(destino, rel);
      try {
        if (await existe(alvo)) { res.jaExistiam++; continue; }
        const src = path.win32.join(dirOrig, ent.name);
        let tamanho = 0;
        try { tamanho = (await fsp.stat(longPath(src))).size; } catch { /* sem tamanho, segue */ }
        if (!dryRun) {
          await fsp.mkdir(longPath(path.win32.dirname(alvo)), { recursive: true });
          // COPYFILE_EXCL: falha em vez de sobrescrever (trava de segurança
          // além do teste `existe` acima — evita corrida).
          await fsp.copyFile(longPath(src), longPath(alvo), fs.constants.COPYFILE_EXCL);
        }
        res.copiados++;
        res.bytes += tamanho;
      } catch (e) {
        if (e.code === 'EEXIST') { res.jaExistiam++; continue; }
        res.erros.push({ arquivo: rel, motivo: e.message });
      }
    }
  }

  await andar('');
  return res;
}

/** Soma vários resultados de `copiarConteudo` num só. */
function somar(...resultados) {
  return resultados.reduce((acc, r) => ({
    copiados: acc.copiados + r.copiados,
    jaExistiam: acc.jaExistiam + r.jaExistiam,
    bytes: acc.bytes + r.bytes,
    erros: acc.erros.concat(r.erros),
  }), { copiados: 0, jaExistiam: 0, bytes: 0, erros: [] });
}

module.exports = { copiarConteudo, listarSubpastas, existe, somar, longPath };
