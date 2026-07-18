'use strict';
/**
 * Módulo Sucesso do Cliente — Gestão de Vínculos (cs_vinculos)
 * ------------------------------------------------------------------
 * Camada entre o de-para puro (depara.js, sem I/O) e o banco. Usa o
 * schema real da Carteira confirmado em CONTEXTO_PROJETO_GRUPO_E.md:
 *   clientes(id, user_id, cnpj, nome_empresa, regime_tributario,
 *            data_entrada, honorario_inicial, origem, cac, obs, codigo,
 *            status, data_saida, motivo_saida)
 * (o que já é exatamente o formato { id, nome_empresa, cnpj } que
 * depara.js espera — nenhum ajuste de nomes de coluna foi necessário).
 */
const { sugerirVinculo, normalizarTelefone } = require('./depara');

/** Carrega a Carteira inteira (id, nome_empresa, cnpj) para casar por similaridade. */
async function carregarClientes(pool) {
  const { rows } = await pool.query('SELECT id, nome_empresa, cnpj FROM clientes');
  return rows;
}

/**
 * Garante que existe uma linha em cs_vinculos para o telefone do contato.
 * Se já existir (confirmado ou pendente), retorna como está — nunca
 * sobrescreve um vínculo já confirmado por humano.
 * Se não existir, cria como 'pendente' com a melhor sugestão pré-preenchida
 * (empresa_nome/cliente_id/confianca), aguardando confirmação humana.
 *
 * @param {import('pg').Pool} pool
 * @param {{nome: string, telefone: string, tags?: string|string[]}} contato
 * @returns {object|null} linha de cs_vinculos
 */
async function garantirVinculo(pool, contato) {
  const telefone = normalizarTelefone(contato.telefone);
  if (!telefone) return null;

  const existente = await pool.query('SELECT * FROM cs_vinculos WHERE telefone = $1', [telefone]);
  if (existente.rows.length) return existente.rows[0];

  const clientes = await carregarClientes(pool);
  const sugestao = sugerirVinculo(contato, clientes);
  const melhor = sugestao.sugestoes[0] || null;

  const inserido = await pool.query(
    `INSERT INTO cs_vinculos (telefone, cliente_id, empresa_nome, cnpj, tipo, confianca)
     VALUES ($1, $2, $3, $4, 'pendente', $5)
     ON CONFLICT (telefone) DO UPDATE SET updated_at = NOW()
     RETURNING *`,
    [
      telefone,
      melhor ? String(melhor.cliente_id) : null,
      melhor ? melhor.nome_empresa : sugestao.nome_contato,
      melhor ? melhor.cnpj : null,
      melhor ? melhor.confianca : null,
    ]
  );
  return inserido.rows[0];
}

/**
 * Confirma um vínculo pendente (ação humana, vinda da aba "Vínculos").
 * @param {import('pg').Pool} pool
 * @param {string} vinculoId
 * @param {{clienteId: string|null, empresaNome: string, cnpj: string|null, tipo: string, confirmadoPor: string}} dados
 */
async function confirmarVinculo(pool, vinculoId, dados) {
  const { clienteId, empresaNome, cnpj, tipo, confirmadoPor } = dados;
  if (!['cliente', 'fornecedor', 'interno', 'software'].includes(tipo)) {
    throw new Error(`tipo de vínculo inválido: ${tipo}`);
  }
  const { rows } = await pool.query(
    `UPDATE cs_vinculos
        SET cliente_id = $1, empresa_nome = $2, cnpj = $3, tipo = $4,
            confirmado_por = $5, confirmado_em = NOW(), updated_at = NOW()
      WHERE id = $6
      RETURNING *`,
    [clienteId, empresaNome, cnpj, tipo, confirmadoPor, vinculoId]
  );
  return rows[0] || null;
}

/** Lista vínculos aguardando confirmação humana (fila da aba "Vínculos"). */
async function listarPendentes(pool) {
  const { rows } = await pool.query(
    `SELECT * FROM cs_vinculos WHERE tipo = 'pendente' ORDER BY created_at DESC`
  );
  return rows;
}

module.exports = { carregarClientes, garantirVinculo, confirmarVinculo, listarPendentes };
