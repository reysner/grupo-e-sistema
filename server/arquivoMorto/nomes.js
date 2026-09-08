'use strict';
/**
 * Normalização de nome de empresa e faixa de letra inicial.
 *
 * O nome vem da API do Acessórias já como Razão Social com "&" trocado por " E "
 * (derivarApelido em ../acessoriasClient.js). As pastas no disco podem ter
 * variações — acento, "&" literal, "ç"/"õ"/"ã", espaço duplo. Decisão do Reysner:
 * se a única diferença for isso, é a MESMA empresa.
 *
 * `normalizar` deixa os dois lados comparáveis: MAIÚSCULAS, sem acento,
 * "&" -> " E ", espaços colapsados. Nada de heurística de similaridade —
 * depois disso é igualdade exata (ou não é a empresa).
 */

/** "M&F Participações Ltda" / "M E F PARTICIPACOES LTDA" -> "M E F PARTICIPACOES LTDA" */
function normalizar(nome) {
  return String(nome || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // remove diacríticos (já separados da letra pelo NFD)
    .replace(/&/g, ' E ')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Faixa de letra do destino Drive (5 pastas). Regra do Reysner:
 * nome começando com 0-9 (ou qualquer coisa que não seja A-Z) vai pra "A a D".
 */
function faixaDeLetra(nomeJaNormalizado) {
  const c = String(nomeJaNormalizado || '').charAt(0);
  if (c >= 'A' && c <= 'D') return 'A a D';
  if (c >= 'E' && c <= 'L') return 'E a L';
  if (c >= 'M' && c <= 'R') return 'M a R';
  if (c >= 'S' && c <= 'T') return 'S a T';
  if (c >= 'U' && c <= 'Z') return 'U a Z';
  return 'A a D'; // 0-9, símbolos, vazio
}

module.exports = { normalizar, faixaDeLetra };
