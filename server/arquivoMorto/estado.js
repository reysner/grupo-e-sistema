'use strict';
/**
 * Estado local do job — um JSON simples em server/arquivoMorto/estado/.
 *
 * A estação que roda o job pode não ter rota até o Postgres do sistema (que
 * fica no Render), então o controle de "já arquivei essa empresa" vive aqui,
 * do lado do job. Chave = acessorias_id (estável; ver empresaParaCliente em
 * ../acessoriasClient.js).
 *
 * status por empresa:
 *   'ok'      -> arquivada nos 2 destinos sem erro; execuções seguintes pulam
 *   'parcial' -> encontrada em alguma origem mas com erro/ambiguidade -> tenta de novo
 *   'nao_localizada' -> não achada em NENHUMA origem -> tenta de novo (pode aparecer depois)
 */

const fs = require('fs');
const path = require('path');

const ARQ = 'processadas.json';

function _caminho(estadoDir) { return path.join(estadoDir, ARQ); }

function carregar(estadoDir) {
  try {
    const txt = fs.readFileSync(_caminho(estadoDir), 'utf8');
    const obj = JSON.parse(txt);
    return obj && typeof obj === 'object' ? obj : {};
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw new Error(`Estado corrompido em ${_caminho(estadoDir)}: ${e.message}`);
  }
}

function salvar(estadoDir, dados) {
  fs.mkdirSync(estadoDir, { recursive: true });
  const tmp = _caminho(estadoDir) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(dados, null, 2), 'utf8');
  fs.renameSync(tmp, _caminho(estadoDir)); // troca atômica
}

/** Deve processar esta empresa nesta execução? (pula só quem já está 'ok') */
function jaConcluida(dados, acessoriasId) {
  return !!dados[acessoriasId] && dados[acessoriasId].status === 'ok';
}

function registrar(dados, acessoriasId, info) {
  const agora = new Date().toISOString();
  const anterior = dados[acessoriasId] || {};
  dados[acessoriasId] = {
    ...anterior,
    ...info,
    primeiraExecucao: anterior.primeiraExecucao || agora,
    ultimaExecucao: agora,
  };
  return dados[acessoriasId];
}

module.exports = { carregar, salvar, jaConcluida, registrar };
