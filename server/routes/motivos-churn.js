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
 *   PATCH  /api/motivos-churn/:id          -> ativa/desativa { ativo: true|false }
 *   DELETE /api/motivos-churn/:id          -> apaga de vez (uso raro — prefira desativar)
 */
const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { requireAuth, requireAdmin } = require('../auth');

// Lista definida pelo Reysner (taxonomia própria de churn) — substitui a
// sugestão inicial genérica.
const MOTIVOS_INICIAIS = [
  'Churn financeiro / redução de custos',
  'Churn financeiro por inadimplência',
  'Churn involuntário por encerramento de atividade',
  'Churn Técnico / Reestruturação Societária',
  'Churn por experiência técnica / relacionamento pessoal',
  'Churn por concentração de carteira',
  'Churn por experiência técnica / redução de custos',
  'Churn por experiência técnica',
  'Churn por experiência técnica / Processos',
  'Churn por experiência técnica / por preço (price-driven churn)',
  'Churn por reorganização familiar na gestão da empresa',
  'Churn por preço (price-driven churn) / Baixa percepção de valor',
  'Churn por experiência técnica / concentração de carteira',
  'Churn por preço (price-driven churn) / redução de custos',
  'Churn estratégico / consultivo - Benefício fiscal percebido',
  'Churn motivado por decisão pessoal',
  'Outro',
];

async function garantirTabela() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS motivos_churn (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      nome TEXT UNIQUE NOT NULL,
      ativo BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`).catch(() => {});
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
