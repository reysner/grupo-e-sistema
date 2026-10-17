'use strict';
/**
 * Lista canônica de analistas — CRUD simples, SEM login/senha.
 * Usada hoje pelo dropdown "Analista Procurado" do Atendimento (antes era
 * texto livre e gerava duplicidade tipo "Reysner" x "Resyner"). Pode
 * alimentar outros módulos no futuro (ex.: comparar com os nomes que vêm
 * do Zappy no módulo Sucesso do Cliente).
 *
 * Montar em server/index.js, junto dos outros routers:
 *   app.use('/api/analistas', require('./routes/analistas'));
 *
 * Endpoints:
 *   GET    /api/analistas?ativo=true   -> lista (todos, ou só ativos com ?ativo=true)
 *   POST   /api/analistas              -> cria { nome }  (reativa se já existir com esse nome)
 *   PATCH  /api/analistas/:id          -> ativa/desativa e/ou renomeia { ativo?: true|false, nome?: string }
 *   DELETE /api/analistas/:id          -> apaga de vez (uso raro — prefira desativar)
 */
const express = require('express');
const router = express.Router();
const { pool } = require('../db');
router.use(require('../cs/auditoria').middleware());   // anota nos Logs de atividades quem incluiu, renomeou, desativou ou excluiu analista

let requireAuth, requireAdmin;
try {
  ({ requireAuth, requireAdmin } = require('../auth'));
} catch (e) {
  console.warn('[analistas] server/auth.js não encontrado — rotas SEM autenticação.');
  requireAuth = (req, res, next) => next();
  requireAdmin = (req, res, next) => next();
}

router.get('/', requireAuth, async (req, res) => {
  try {
    await require('../cs/analistasNomes').aplicar(pool);   // ajuste único dos nomes completos (planilha de 15/10/2026); depois disso não faz nada
    const somenteAtivos = req.query.ativo === 'true';
    const { rows } = await pool.query(
      somenteAtivos
        ? `SELECT id, nome, ativo FROM analistas WHERE ativo = TRUE ORDER BY nome`
        : `SELECT id, nome, ativo FROM analistas ORDER BY nome`
    );
    res.json({ analistas: rows });
  } catch (e) {
    console.error('[analistas] GET / falhou:', e);
    res.status(500).json({ error: e.message });
  }
});

router.post('/', requireAuth, requireAdmin, async (req, res) => {
  const nome = (req.body.nome || '').trim();
  if (!nome) return res.status(400).json({ error: 'Nome é obrigatório.' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO analistas (nome) VALUES ($1)
       ON CONFLICT (nome) DO UPDATE SET ativo = TRUE
       RETURNING id, nome, ativo`,
      [nome]
    );
    res.json({ analista: rows[0] });
  } catch (e) {
    console.error('[analistas] POST / falhou:', e);
    res.status(500).json({ error: e.message });
  }
});

/** PATCH /:id  { ativo?, nome? }  -> ativa/desativa e/ou renomeia (o novo nome aparece em todos os módulos que leem a lista, como o Qualidade). */
router.patch('/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const sets = []; const vals = [];
    if (b.ativo !== undefined) { vals.push(!!b.ativo); sets.push('ativo = $' + vals.length); }
    if (b.nome !== undefined) {
      const nome = String(b.nome || '').split(/\s+/).join(' ').trim();   // espaços repetidos viram um só (antes a barra invertida se perdeu e o "s" sumia do nome)
      if (!nome) return res.status(400).json({ error: 'O nome não pode ficar vazio.' });
      if (nome.length > 80) return res.status(400).json({ error: 'Nome longo demais (até 80 caracteres).' });
      vals.push(nome); sets.push('nome = $' + vals.length);
    }
    if (!sets.length) return res.status(400).json({ error: 'Informe nome e/ou ativo.' });
    vals.push(req.params.id);
    const { rows } = await pool.query(`UPDATE analistas SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING id, nome, ativo`, vals);
    if (!rows.length) return res.status(404).json({ error: 'Analista não encontrado.' });
    res.json({ analista: rows[0] });
  } catch (e) {
    if (e && e.code === '23505') return res.status(409).json({ error: 'Já existe um analista com esse nome.' });
    console.error('[analistas] PATCH /:id falhou:', e);
    res.status(500).json({ error: e.message });
  }
});

router.delete('/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    // Analista com registros de Qualidade não some: o histórico ficaria sem nome. Nesse caso, desative em vez de excluir.
    try {
      const q = await pool.query(`SELECT COUNT(*)::int AS n FROM cs_qualidade_registros WHERE analista_id = $1`, [String(req.params.id)]);
      if (q.rows[0].n > 0) return res.status(409).json({ error: `Esse analista tem ${q.rows[0].n} registro(s) de Qualidade. Desative-o em vez de excluir, para não perder o histórico.` });
    } catch (e) { /* a tabela de Qualidade ainda não existe: nada a proteger */ }
    await pool.query(`DELETE FROM analistas WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('[analistas] DELETE /:id falhou:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
