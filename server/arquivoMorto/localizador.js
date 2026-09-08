'use strict';
/**
 * Localiza a PASTA de uma empresa dentro de uma pasta-origem.
 *
 * Toda origem tem, no 1º nível, uma pasta por empresa com nome = razão social.
 * Compara pelo nome normalizado (ver nomes.js). Resultado:
 *   { status: 'encontrada',   caminho }        -> exatamente 1 match
 *   { status: 'nao_encontrada' }                -> 0 matches (não é erro — a
 *                                                  empresa só não tem nada ali)
 *   { status: 'ambigua', candidatos: [...] }    -> 2+ matches -> não copia,
 *                                                  sinaliza no relatório
 */

const path = require('path');
const { normalizar } = require('./nomes');
const { listarSubpastas } = require('./copiador');

/** cache por pasta-origem: { nomeNormalizado -> [nomesReais...] } */
const _cache = new Map();

async function indiceDaOrigem(dirOrigem) {
  if (_cache.has(dirOrigem)) return _cache.get(dirOrigem);
  const idx = new Map();
  for (const nomeReal of await listarSubpastas(dirOrigem)) {
    const chave = normalizar(nomeReal);
    if (!idx.has(chave)) idx.set(chave, []);
    idx.get(chave).push(nomeReal);
  }
  _cache.set(dirOrigem, idx);
  return idx;
}

/** Limpa o cache (usar entre execuções longas / testes). */
function limparCache() { _cache.clear(); }

async function localizar(dirOrigem, nomeEmpresaNormalizado) {
  const idx = await indiceDaOrigem(dirOrigem);
  const achados = idx.get(nomeEmpresaNormalizado) || [];
  if (achados.length === 0) return { status: 'nao_encontrada' };
  if (achados.length > 1) {
    return { status: 'ambigua', candidatos: achados.map(n => path.win32.join(dirOrigem, n)) };
  }
  return { status: 'encontrada', caminho: path.win32.join(dirOrigem, achados[0]) };
}

/**
 * Procura em VÁRIAS pastas-origem (ex.: as 6 pastas de "2024"). Junta todos os
 * caminhos "encontrada". Ambiguidade em qualquer uma entra em `ambiguas`.
 *
 * @returns {{caminhos:string[], ambiguas:string[][]}}
 */
async function localizarEmVarias(dirsOrigem, nomeEmpresaNormalizado) {
  const caminhos = [];
  const ambiguas = [];
  for (const dir of dirsOrigem) {
    const r = await localizar(dir, nomeEmpresaNormalizado);
    if (r.status === 'encontrada') caminhos.push(r.caminho);
    else if (r.status === 'ambigua') ambiguas.push(r.candidatos);
  }
  return { caminhos, ambiguas };
}

module.exports = { localizar, localizarEmVarias, limparCache };
