'use strict';
/**
 * Limpezas ÚNICAS de registros de teste de Qualidade, a pedido do Reysner. Cada uma apaga o registro (o histórico dele sai junto, por cascata)
 * e os avisos do sino que ele gerou. O critério é bem estreito (empresa, quem lançou, tipo, dia e texto) para nunca tocar em registro de verdade,
 * e cada limpeza roda uma vez só (marcada em cs_painel_config).
 */
const LIMPEZAS = [
  {
    // 15/10/2026: Erro / Fiscal da Josiane, empresa ESCRITORIAL CONTADORES E ASSOCIADOS
    chave: 'limpeza_teste_josiane_2026_10_16',
    empresa: 'ESCRITORIAL CONTADORES E ASSOCIADOS', tipo: 'Erro', dia: '2026-10-15',
    textoSql: "detalhe LIKE 'Cliente entra em contato informando diverg%'",
  },
  {
    // 16/10/2026: Reclamação / Comercial da Josiane, texto "Teste", empresa ALMEIDA RODRIGUES PARTICIPACOES SOCIETARIAS (tratada e encerrada no teste do portal)
    chave: 'limpeza_teste_almeida_2026_10_17',
    empresa: 'ALMEIDA RODRIGUES PARTICIPACOES SOCIETARIAS', tipo: 'Reclamação', dia: '2026-10-16',
    textoSql: "btrim(detalhe) = 'Teste'",
  },
];
const CHAVE = LIMPEZAS[0].chave;

async function aplicarUma(pool, l) {
  const marca = await pool.query('SELECT 1 FROM cs_painel_config WHERE chave = $1', [l.chave]);
  if (marca.rows.length) return;
  const del = await pool.query(
    `DELETE FROM cs_qualidade_registros
      WHERE cliente_nome ILIKE $1 AND criado_por ILIKE 'Josiane%' AND tipo = $2 AND ${l.textoSql}
        AND (criado_em AT TIME ZONE 'America/Sao_Paulo')::date = $3::date
      RETURNING id`, [l.empresa + '%', l.tipo, l.dia]);
  let avisos = 0;
  try {
    const n = await pool.query(
      `DELETE FROM notificacoes WHERE tipo IN ('qualidade_lancada', 'qualidade_finalizada') AND mensagem ILIKE $1 AND created_at >= ($2::date)::timestamp AT TIME ZONE 'America/Sao_Paulo'`,
      ['%' + l.empresa + '%', l.dia]);
    avisos = n.rowCount;
  } catch (e) { /* tabela de avisos ainda não existe: nada a limpar */ }
  await pool.query(`INSERT INTO cs_painel_config (chave, valor, atualizado_por) VALUES ($1, $2::jsonb, 'limpeza de teste') ON CONFLICT (chave) DO NOTHING`,
    [l.chave, JSON.stringify({ registros: del.rowCount, avisos })]);
  console.log('[qualidade] limpeza ' + l.chave + ': ' + del.rowCount + ' registro(s) e ' + avisos + ' aviso(s) apagados.');
}

function aplicar(pool) {
  return (async () => {
    await pool.query(`CREATE TABLE IF NOT EXISTS cs_painel_config (
      chave TEXT PRIMARY KEY, valor JSONB NOT NULL, atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(), atualizado_por TEXT)`);
    for (const l of LIMPEZAS) await aplicarUma(pool, l).catch((e) => console.error('[qualidade] limpeza do teste falhou (' + l.chave + '):', e.message));
  })().catch((e) => console.error('[qualidade] limpeza do teste falhou:', e.message));
}

module.exports = { aplicar, CHAVE, LIMPEZAS };
