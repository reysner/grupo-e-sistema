'use strict';
const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireAdmin } = require('../auth');

const router = express.Router();

// ---------------------------------------------------------
// PÚBLICAS — sem login (ranking e consolidado anual)
// IMPORTANTE: ao contrário de data.js, este router NÃO aplica
// router.use(requireAuth) globalmente, porque /ranking e
// /consolidado-anual precisam ficar abertos (link público).
// ---------------------------------------------------------

// GET /api/data/gamificacao/ranking?mes=6&ano=2026
router.get('/ranking', async (req, res) => {
  try {
    const mes = parseInt(req.query.mes) || (new Date().getMonth() + 1);
    const ano = parseInt(req.query.ano) || new Date().getFullYear();

    const { rows } = await pool.query(
      `SELECT n.nota, c.id AS colaborador_id, c.nome
       FROM gamificacao_notas n
       JOIN gamificacao_colaboradores c ON c.id = n.colaborador_id
       WHERE n.mes = $1 AND n.ano = $2
       ORDER BY n.nota DESC`,
      [mes, ano]
    );

    const ranking = rows.map((r, i) => ({
      posicao: i + 1,
      nome: r.nome,
      nota: Number(r.nota),
    }));
    const mediaGeral = ranking.length
      ? ranking.reduce((s, r) => s + r.nota, 0) / ranking.length
      : 0;

    const { rows: premiosMensal } = await pool.query(
      `SELECT id, posicao, descricao FROM gamificacao_premios WHERE tipo = 'mensal' ORDER BY posicao`
    );

    res.json({ mes, ano, mediaGeral: Number(mediaGeral.toFixed(2)), ranking, premiosMensal });
  } catch (err) {
    console.error('Erro ranking gamificação:', err);
    res.status(500).json({ error: 'Erro ao buscar ranking.' });
  }
});

// GET /api/data/gamificacao/consolidado-anual?ano=2026
router.get('/consolidado-anual', async (req, res) => {
  try {
    const ano = parseInt(req.query.ano) || new Date().getFullYear();

    const { rows } = await pool.query(
      `SELECT n.nota, c.id AS colaborador_id, c.nome
       FROM gamificacao_notas n
       JOIN gamificacao_colaboradores c ON c.id = n.colaborador_id
       WHERE n.ano = $1`,
      [ano]
    );

    const agrupado = {};
    rows.forEach(r => {
      const id = r.colaborador_id;
      if (!agrupado[id]) agrupado[id] = { nome: r.nome, soma: 0, qtd: 0 };
      agrupado[id].soma += Number(r.nota);
      agrupado[id].qtd += 1;
    });
    const consolidado = Object.values(agrupado)
      .map(c => ({ nome: c.nome, media: Number((c.soma / c.qtd).toFixed(2)), mesesLancados: c.qtd }))
      .sort((a, b) => b.media - a.media)
      .map((c, i) => ({ posicao: i + 1, ...c }));

    const { rows: premiosAnual } = await pool.query(
      `SELECT id, posicao, descricao FROM gamificacao_premios WHERE tipo = 'anual' ORDER BY posicao`
    );

    res.json({ ano, consolidado, premiosAnual });
  } catch (err) {
    console.error('Erro consolidado gamificação:', err);
    res.status(500).json({ error: 'Erro ao buscar consolidado anual.' });
  }
});

// ---------------------------------------------------------
// ADMIN — exige login (consulta liberada a qualquer logado;
// criação/edição exige requireAdmin)
// ---------------------------------------------------------

router.get('/admin/colaboradores', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM gamificacao_colaboradores ORDER BY nome`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/admin/colaboradores', requireAuth, requireAdmin, async (req, res) => {
  const nome = (req.body.nome || '').trim();
  if (!nome) return res.status(400).json({ error: 'Nome é obrigatório.' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO gamificacao_colaboradores (nome) VALUES ($1) RETURNING *`,
      [nome]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/admin/colaboradores/:id', requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { ativo, nome } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE gamificacao_colaboradores
       SET ativo = COALESCE($2, ativo), nome = COALESCE($3, nome)
       WHERE id = $1 RETURNING *`,
      [id, typeof ativo === 'boolean' ? ativo : null, nome?.trim() || null]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/admin/notas', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { colaborador_id, mes, ano, nota } = req.body;
    if (!colaborador_id || !mes || !ano || nota === undefined) {
      return res.status(400).json({ error: 'Campos obrigatórios: colaborador_id, mes, ano, nota.' });
    }
    if (nota < 0 || nota > 5) {
      return res.status(400).json({ error: 'Nota deve estar entre 0 e 5.' });
    }
    const lancado_por = req.user?.name || req.user?.email || null;

    const { rows } = await pool.query(
      `INSERT INTO gamificacao_notas (colaborador_id, mes, ano, nota, lancado_por)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (colaborador_id, mes, ano)
       DO UPDATE SET nota = EXCLUDED.nota, lancado_por = EXCLUDED.lancado_por
       RETURNING *`,
      [colaborador_id, mes, ano, nota, lancado_por]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('Erro ao lançar nota:', err);
    res.status(500).json({ error: 'Erro ao lançar nota.' });
  }
});

router.get('/admin/notas', requireAuth, async (req, res) => {
  const mes = parseInt(req.query.mes) || (new Date().getMonth() + 1);
  const ano = parseInt(req.query.ano) || new Date().getFullYear();
  try {
    const { rows } = await pool.query(
      `SELECT id, nota, colaborador_id FROM gamificacao_notas WHERE mes = $1 AND ano = $2`,
      [mes, ano]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/admin/premios/:id', requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const descricao = (req.body.descricao || '').trim();
  if (!descricao) return res.status(400).json({ error: 'Descrição é obrigatória.' });
  try {
    const { rows } = await pool.query(
      `UPDATE gamificacao_premios SET descricao = $2 WHERE id = $1 RETURNING *`,
      [id, descricao]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
