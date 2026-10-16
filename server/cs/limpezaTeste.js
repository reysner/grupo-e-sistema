'use strict';
/**
 * Limpeza ÚNICA do registro de teste feito pela Josiane em 15/10/2026 (Erro / Fiscal, "Cliente entra em contato informando divergência...",
 * empresa ESCRITORIAL CONTADORES E ASSOCIADOS), a pedido do Reysner: apaga o registro, o histórico dele e os avisos do sino.
 * O critério é bem estreito (empresa, quem lançou, tipo, dia e começo do texto) para nunca tocar em registro de verdade.
 */
const CHAVE = 'limpeza_teste_josiane_2026_10_16';

function aplicar(pool) {
  return (async () => {
    await pool.query(`CREATE TABLE IF NOT EXISTS cs_painel_config (
      chave TEXT PRIMARY KEY, valor JSONB NOT NULL, atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(), atualizado_por TEXT)`);
    const marca = await pool.query('SELECT 1 FROM cs_painel_config WHERE chave = $1', [CHAVE]);
    if (marca.rows.length) return;
    const del = await pool.query(
      `DELETE FROM cs_qualidade_registros
        WHERE cliente_nome ILIKE 'ESCRITORIAL CONTADORES E ASSOCIADOS%' AND criado_por ILIKE 'Josiane%' AND tipo = 'Erro'
          AND detalhe LIKE 'Cliente entra em contato informando diverg%' AND (criado_em AT TIME ZONE 'America/Sao_Paulo')::date = DATE '2026-10-15'
        RETURNING id`);
    let avisos = 0;
    try {
      const n = await pool.query(
        `DELETE FROM notificacoes WHERE tipo IN ('qualidade_lancada', 'qualidade_finalizada') AND mensagem ILIKE '%ESCRITORIAL CONTADORES E ASSOCIADOS%' AND created_at >= TIMESTAMPTZ '2026-10-15 00:00:00-03'`);
      avisos = n.rowCount;
    } catch (e) { /* tabela de avisos ainda não existe: nada a limpar */ }
    await pool.query(`INSERT INTO cs_painel_config (chave, valor, atualizado_por) VALUES ($1, $2::jsonb, 'limpeza de teste') ON CONFLICT (chave) DO NOTHING`,
      [CHAVE, JSON.stringify({ registros: del.rowCount, avisos })]);
    console.log('[qualidade] limpeza do teste da Josiane: ' + del.rowCount + ' registro(s) e ' + avisos + ' aviso(s) apagados.');
  })().catch((e) => console.error('[qualidade] limpeza do teste falhou:', e.message));
}

module.exports = { aplicar, CHAVE };
