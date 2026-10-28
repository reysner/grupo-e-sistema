'use strict';
/**
 * Lista canônica de Motivos de Churn — mesmo padrão de
 * server/routes/unidades.js e server/routes/grupos-empresas.js. Usada no
 * campo "Motivo do Churn" da Gestão de Clientes, que só aparece quando a
 * Solicitação é "Saída de empresa" (não "Baixa de empresa" — baixa é o
 * empresário encerrando o CNPJ por motivos diversos, nem sempre ligado à
 * contabilidade; pedido do Reysner: "churn é pra buscar entender os
 * maiores índices de saída [do escritório]"). Dropdown em vez de texto
 * livre — pedido do Reysner: "posso criar vários que é pelo mesmo motivo
 * e não ter uma ideia exata dos principais motivos".
 *
 * Vem com uma lista inicial de motivos comuns em escritório de
 * contabilidade (seed on first create) — o Reysner pode editar/adicionar
 * pela tela "Gerenciar Motivos de Churn", igual já faz com Unidade/Grupo.
 *
 * Montar em server/index.js, junto dos outros routers:
 *   app.use('/api/motivos-churn', require('./routes/motivos-churn'));
 *
 * Endpoints:
 *   GET    /api/motivos-churn?ativo=true   -> lista (todos, ou só ativos com ?ativo=true)
 *   POST   /api/motivos-churn              -> cria { nome }  (reativa se já existir com esse nome)
 *   PATCH  /api/motivos-churn/:id          -> ativa/desativa { ativo: true|false } ou renomeia { nome } (propaga às saídas já classificadas)
 *   DELETE /api/motivos-churn/:id          -> apaga de vez (uso raro — prefira desativar)
 */
const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { requireAuth, requireAdmin } = require('../auth');

// Lista definida pelo Reysner em 28/10/2026 (substitui a anterior, de 17 motivos). Dali em diante é ele quem mantém, pelo "Gerenciar lista" da tela de Churn.
const MOTIVOS_INICIAIS = [
  'Falha técnica',
  'Falha Atendimento',
  'Falha Comercial',
  'Preço',
  'Conveniência',
];
const CHAVE_LISTA = 'motivos_churn_lista_2026_10_28';

async function garantirTabela() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS motivos_churn (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      nome TEXT UNIQUE NOT NULL,
      ativo BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`).catch(() => {});
  // Troca única (28/10/2026): a lista antiga sai e entram as 5 novas. Marca em cs_painel_config para não refazer depois que o Reysner mexer na lista.
  await pool.query(`CREATE TABLE IF NOT EXISTS cs_painel_config (chave TEXT PRIMARY KEY, valor JSONB, atualizado_em TIMESTAMPTZ DEFAULT NOW(), atualizado_por TEXT)`).catch(() => {});
  const feito = await pool.query(`SELECT 1 FROM cs_painel_config WHERE chave = $1`, [CHAVE_LISTA]).catch(() => ({ rows: [{}] }));
  if (!feito.rows.length) {
    await pool.query(`DELETE FROM motivos_churn`);
    for (const nome of MOTIVOS_INICIAIS) await pool.query(`INSERT INTO motivos_churn (nome) VALUES ($1) ON CONFLICT (nome) DO NOTHING`, [nome]);
    await pool.query(`INSERT INTO cs_painel_config (chave, valor, atualizado_por) VALUES ($1, 'true'::jsonb, 'sistema') ON CONFLICT (chave) DO NOTHING`, [CHAVE_LISTA]).catch(() => {});
  }
  // Seed só na primeira vez — se a tabela já tem alguma linha, não mexe
  // (não força a lista inicial de volta se o Reysner já editou/apagou algo).
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM motivos_churn`);
  if (rows[0].n === 0) {
    for (const nome of MOTIVOS_INICIAIS) {
      await pool.query(`INSERT INTO motivos_churn (nome) VALUES ($1) ON CONFLICT (nome) DO NOTHING`, [nome]);
    }
  }
}

router.get('/', requireAuth, async (req, res) => {
  try {
    await garantirTabela();
    const somenteAtivos = req.query.ativo === 'true';
    const { rows } = await pool.query(
      somenteAtivos
        ? `SELECT id, nome, ativo FROM motivos_churn WHERE ativo = TRUE ORDER BY nome`
        : `SELECT id, nome, ativo FROM motivos_churn ORDER BY nome`
    );
    res.json({ motivos: rows });
  } catch (e) {
    console.error('[motivos-churn] GET / falhou:', e);
    res.status(500).json({ error: e.message });
  }
});

router.post('/', requireAuth, requireAdmin, async (req, res) => {
  const nome = (req.body.nome || '').trim();
  if (!nome) return res.status(400).json({ error: 'Nome é obrigatório.' });
  try {
    await garantirTabela();
    const { rows } = await pool.query(
      `INSERT INTO motivos_churn (nome) VALUES ($1)
       ON CONFLICT (nome) DO UPDATE SET ativo = TRUE
       RETURNING id, nome, ativo`,
      [nome]
    );
    res.json({ motivo: rows[0] });
  } catch (e) {
    console.error('[motivos-churn] POST / falhou:', e);
    res.status(500).json({ error: e.message });
  }
});

router.patch('/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    await garantirTabela();
    // { nome } renomeia (e leva o novo nome para as saídas já classificadas); { ativo } liga/desliga. Pode vir um ou outro.
    if (req.body.nome !== undefined) {
      const nome = String(req.body.nome || '').replace(/s+/g, ' ').trim();
      if (nome.length < 3 || nome.length > 120) return res.status(400).json({ error: 'O nome do motivo precisa ter de 3 a 120 caracteres.' });
      const atual = await pool.query(`SELECT nome FROM motivos_churn WHERE id = $1`, [req.params.id]);
      if (!atual.rows.length) return res.status(404).json({ error: 'Motivo não encontrado.' });
      const igual = await pool.query(`SELECT 1 FROM motivos_churn WHERE lower(nome) = lower($1) AND id <> $2`, [nome, req.params.id]);
      if (igual.rows.length) return res.status(409).json({ error: 'Já existe um motivo com esse nome.' });
      const { rows } = await pool.query(`UPDATE motivos_churn SET nome = $1 WHERE id = $2 RETURNING id, nome, ativo`, [nome, req.params.id]);
      await pool.query(`UPDATE clientes SET motivo_churn = $1 WHERE motivo_churn = $2`, [nome, atual.rows[0].nome]).catch(() => {});   // coluna criada pelo painel de churn
      return res.json({ motivo: rows[0] });
    }
    const { rows } = await pool.query(
      `UPDATE motivos_churn SET ativo = $1 WHERE id = $2 RETURNING id, nome, ativo`,
      [!!req.body.ativo, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Motivo não encontrado.' });
    res.json({ motivo: rows[0] });
  } catch (e) {
    console.error('[motivos-churn] PATCH /:id falhou:', e);
    res.status(500).json({ error: e.message });
  }
});

router.delete('/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    await pool.query(`DELETE FROM motivos_churn WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('[motivos-churn] DELETE /:id falhou:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
module.exports.garantirTabela = garantirTabela;   // chamado ao subir o servidor e antes de ler a lista no painel de churn (a troca única da lista acontece aqui)
