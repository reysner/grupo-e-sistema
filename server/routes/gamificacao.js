// =========================================================
// MÓDULO GAMIFICAÇÃO GRUPO-E
// routes/gamificacao.js
//
// AJUSTE OS IMPORTS ABAIXO para apontar pro seu client do
// Supabase e pro seu middleware de autenticação já existentes
// no projeto Grupo-E.
// =========================================================

const express = require('express');
const router = express.Router();

// --- AJUSTE: caminho do seu client Supabase já configurado ---
const supabase = require('../config/supabaseClient');

// --- AJUSTE: caminho do seu middleware de autenticação já existente ---
const { requireAuth } = require('../middlewares/auth');

// ---------------------------------------------------------
// ROTAS PÚBLICAS (sem login) — usadas pela página de visualização
// ---------------------------------------------------------

// GET /api/gamificacao/ranking?mes=6&ano=2026
// Ranking do mês + pódio + média geral do mês
router.get('/ranking', async (req, res) => {
  try {
    const mes = parseInt(req.query.mes) || (new Date().getMonth() + 1);
    const ano = parseInt(req.query.ano) || new Date().getFullYear();

    const { data, error } = await supabase
      .from('gamificacao_notas')
      .select('nota, colaborador:gamificacao_colaboradores(id, nome)')
      .eq('mes', mes)
      .eq('ano', ano)
      .order('nota', { ascending: false });

    if (error) throw error;

    const ranking = data
      .filter(r => r.colaborador) // ignora órfãos
      .map((r, idx) => ({
        posicao: idx + 1,
        nome: r.colaborador.nome,
        nota: Number(r.nota)
      }));

    const mediaGeral = ranking.length
      ? (ranking.reduce((s, r) => s + r.nota, 0) / ranking.length)
      : 0;

    const { data: premiosMensal } = await supabase
      .from('gamificacao_premios')
      .select('id, posicao, descricao')
      .eq('tipo', 'mensal')
      .order('posicao');

    res.json({
      mes,
      ano,
      mediaGeral: Number(mediaGeral.toFixed(2)),
      ranking,
      premiosMensal
    });
  } catch (err) {
    console.error('Erro ao buscar ranking:', err);
    res.status(500).json({ error: 'Erro ao buscar ranking.' });
  }
});

// GET /api/gamificacao/consolidado-anual?ano=2026
// Média de todas as notas lançadas no ano, por colaborador
router.get('/consolidado-anual', async (req, res) => {
  try {
    const ano = parseInt(req.query.ano) || new Date().getFullYear();

    const { data, error } = await supabase
      .from('gamificacao_notas')
      .select('nota, colaborador:gamificacao_colaboradores(id, nome)')
      .eq('ano', ano);

    if (error) throw error;

    const agrupado = {};
    data.forEach(r => {
      if (!r.colaborador) return;
      const id = r.colaborador.id;
      if (!agrupado[id]) {
        agrupado[id] = { nome: r.colaborador.nome, soma: 0, qtd: 0 };
      }
      agrupado[id].soma += Number(r.nota);
      agrupado[id].qtd += 1;
    });

    const consolidado = Object.values(agrupado)
      .map(c => ({ nome: c.nome, media: Number((c.soma / c.qtd).toFixed(2)), mesesLancados: c.qtd }))
      .sort((a, b) => b.media - a.media)
      .map((c, idx) => ({ posicao: idx + 1, ...c }));

    const { data: premiosAnual } = await supabase
      .from('gamificacao_premios')
      .select('id, posicao, descricao')
      .eq('tipo', 'anual')
      .order('posicao');

    res.json({ ano, consolidado, premiosAnual });
  } catch (err) {
    console.error('Erro ao buscar consolidado anual:', err);
    res.status(500).json({ error: 'Erro ao buscar consolidado anual.' });
  }
});

// ---------------------------------------------------------
// ROTAS ADMIN (exigem login — usa o middleware já existente)
// ---------------------------------------------------------

// GET /api/gamificacao/admin/colaboradores
router.get('/admin/colaboradores', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('gamificacao_colaboradores')
    .select('*')
    .order('nome');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/gamificacao/admin/colaboradores  { nome }
router.post('/admin/colaboradores', requireAuth, async (req, res) => {
  const { nome } = req.body;
  if (!nome || !nome.trim()) return res.status(400).json({ error: 'Nome é obrigatório.' });

  const { data, error } = await supabase
    .from('gamificacao_colaboradores')
    .insert({ nome: nome.trim() })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// PUT /api/gamificacao/admin/colaboradores/:id  { ativo }
router.put('/admin/colaboradores/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { ativo, nome } = req.body;

  const updates = {};
  if (typeof ativo === 'boolean') updates.ativo = ativo;
  if (nome && nome.trim()) updates.nome = nome.trim();

  const { data, error } = await supabase
    .from('gamificacao_colaboradores')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/gamificacao/admin/notas
// body: { colaborador_id, mes, ano, nota }
// Faz upsert: se já existe nota daquele colaborador/mes/ano, atualiza.
router.post('/admin/notas', requireAuth, async (req, res) => {
  try {
    const { colaborador_id, mes, ano, nota } = req.body;

    if (!colaborador_id || !mes || !ano || nota === undefined) {
      return res.status(400).json({ error: 'Campos obrigatórios: colaborador_id, mes, ano, nota.' });
    }
    if (nota < 0 || nota > 5) {
      return res.status(400).json({ error: 'Nota deve estar entre 0 e 5.' });
    }

    const lancado_por = req.user?.nome || req.user?.email || null;

    const { data, error } = await supabase
      .from('gamificacao_notas')
      .upsert(
        { colaborador_id, mes, ano, nota, lancado_por },
        { onConflict: 'colaborador_id,mes,ano' }
      )
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (err) {
    console.error('Erro ao lançar nota:', err);
    res.status(500).json({ error: 'Erro ao lançar nota.' });
  }
});

// GET /api/gamificacao/admin/notas?mes=6&ano=2026
// Lista as notas já lançadas no período (pra preencher o formulário admin)
router.get('/admin/notas', requireAuth, async (req, res) => {
  const mes = parseInt(req.query.mes) || (new Date().getMonth() + 1);
  const ano = parseInt(req.query.ano) || new Date().getFullYear();

  const { data, error } = await supabase
    .from('gamificacao_notas')
    .select('id, nota, colaborador_id')
    .eq('mes', mes)
    .eq('ano', ano);

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// PUT /api/gamificacao/admin/premios/:id  { descricao }
router.put('/admin/premios/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { descricao } = req.body;
  if (!descricao || !descricao.trim()) return res.status(400).json({ error: 'Descrição é obrigatória.' });

  const { data, error } = await supabase
    .from('gamificacao_premios')
    .update({ descricao: descricao.trim() })
    .eq('id', id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

module.exports = router;

// =========================================================
// Como registrar no seu app.js / server.js principal:
//
//   const gamificacaoRoutes = require('./routes/gamificacao');
//   app.use('/api/gamificacao', gamificacaoRoutes);
//
// E para servir as páginas HTML (ajuste conforme seu padrão
// de rotas de view do Grupo-E):
//
//   app.get('/gamificacao', (req, res) =>
//     res.sendFile(path.join(__dirname, 'public/gamificacao.html')));
//
//   app.get('/gamificacao/admin', requireAuth, (req, res) =>
//     res.sendFile(path.join(__dirname, 'public/gamificacao-admin.html')));
// =========================================================
