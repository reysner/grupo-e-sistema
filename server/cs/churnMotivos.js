'use strict';
/**
 * Churn por motivo e Fechamento do mês (painel /cs).
 *
 * O motivo do churn usa a lista que já existe no sistema (tabela motivos_churn, a mesma de "Gestão de Clientes > Motivo do Churn"),
 * gerenciável pelo administrador. O motivo de cada saída fica em clientes.motivo_churn; quando ele está vazio vale, se for um motivo da
 * lista, o motivo_saida que a Gestão de Clientes já gravou.
 *
 *   GET /api/cs/painel/churn-motivos/motivos               -> motivos ativos
 *   PUT /api/cs/painel/churn-motivos/definir {cliente_id, motivo|null}   (administrador ou usuário)
 *   GET /api/cs/painel/churn-motivos/fechamento?mes=AAAA-MM -> KPIs do mês, comparação com o mês anterior, motivos e leitura
 */
const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../auth');
const churn = require('./churnSaidas');

const PAPEIS = ['administrador', 'usuario'];
const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Motivo do churn de uma saída: o definido no painel; senão o da Gestão de Clientes, se for um motivo da lista. */
function motivoEfetivo(s, nomesAtivos) {
  if (s && s.motivo_churn) return s.motivo_churn;
  const lista = new Map((nomesAtivos || []).map((n) => [norm(n), n]));
  return (s && s.motivo_saida && lista.get(norm(s.motivo_saida))) || null;
}

function ultimoDia(mes) {
  const [y, m] = mes.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}
function mesAnterior(mes) {
  const [y, m] = mes.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return d.toISOString().slice(0, 7);
}
const rotuloMes = (mes) => MESES[parseInt(mes.slice(5, 7), 10) - 1] + '/' + mes.slice(0, 4);

/**
 * Fechamento de um mês. clientes: o mesmo array de churn.calcularChurn (com motivo_churn); hoje: AAAA-MM-DD.
 * Só as saídas que CONTAM no churn (transferidas que estavam na base do início do mês) entram nos motivos e no resumo.
 */
function montarFechamento(clientes, mes, hoje, padroes, nomesMotivos) {
  const ini = mes + '-01';
  const fimMes = ultimoDia(mes);
  const parcial = fimMes > hoje;
  const fim = parcial ? hoje : fimMes;
  const mesAnt = mesAnterior(mes);
  const p = churn.calcularChurn(clientes, ini, fim, padroes);
  const pAnt = churn.calcularChurn(clientes, mesAnt + '-01', ultimoDia(mesAnt), padroes);
  const contadas = p.saidas.filter((s) => s.tipo === 'transferida' && s.na_base).map((s) => ({ ...s, motivo: motivoEfetivo(s, nomesMotivos) }));
  const menos90 = contadas.filter((s) => s.data_entrada && s.data_saida && churn.somarDias(s.data_entrada, 90) >= s.data_saida).length;
  const por = new Map();
  contadas.forEach((s) => { if (s.motivo) por.set(s.motivo, (por.get(s.motivo) || 0) + 1); });
  const motivos = Array.from(por.entries()).map(([nome, qtd]) => ({ nome, qtd, pct: contadas.length ? +(100 * qtd / contadas.length).toFixed(1) : 0 })).sort((a, b) => b.qtd - a.qtd || a.nome.localeCompare(b.nome));
  const semMotivo = contadas.filter((s) => !s.motivo).length;
  const taxa = p.taxa, taxaAnt = pAnt.taxa;
  const deltaPp = taxa != null && taxaAnt != null ? +(taxa - taxaAnt).toFixed(1) : null;
  const leitura = [];
  if (p.base) {
    leitura.push(`${String(taxa).replace('.', ',')}% da base saiu em ${rotuloMes(mes)} (${contadas.length} de ${p.base})` +
      (taxaAnt != null ? (taxa > taxaAnt ? `, acima dos ${String(taxaAnt).replace('.', ',')}% do mês anterior` : taxa < taxaAnt ? `, abaixo dos ${String(taxaAnt).replace('.', ',')}% do mês anterior` : ', igual ao mês anterior') : '') +
      `. Retenção do mês: ${String(+(100 - taxa).toFixed(1)).replace('.', ',')}%.`);
  }
  if (contadas.length) leitura.push(`${menos90} de ${contadas.length} desligado(s) ficaram menos de 90 dias de casa.`);
  if (motivos.length) leitura.push(`Principal motivo: ${motivos[0].nome} (${motivos[0].qtd} de ${contadas.length}).`);
  if (semMotivo) leitura.push(`${semMotivo} saída(s) ainda sem motivo classificado: classifique para o mês fechar completo.`);
  if (p.fora_do_churn.a_confirmar) leitura.push(`${p.fora_do_churn.a_confirmar} saída(s) a confirmar ficam fora do cálculo até a confirmação.`);
  if (parcial) leitura.push(`Mês em andamento: dados até ${hoje.split('-').reverse().join('/')}.`);
  return {
    mes, rotulo: rotuloMes(mes), parcial, ini, fim, base: p.base, saidas: contadas.length, taxa, retencao: taxa == null ? null : +(100 - taxa).toFixed(1),
    taxa_anterior: taxaAnt, delta_pp: deltaPp, base_anterior: pAnt.base, saidas_anterior: pAnt.saidas_contadas,
    menos_de_90_dias: menos90, menos_de_90_pct: contadas.length ? +(100 * menos90 / contadas.length).toFixed(1) : null,
    fora_do_churn: p.fora_do_churn, classificadas: contadas.length - semMotivo, sem_motivo: semMotivo, motivos, leitura,
    lista: contadas.map((s) => ({ id: s.id, nome: s.nome, cnpj: s.cnpj, data_entrada: s.data_entrada, data_saida: s.data_saida, motivo: s.motivo })),
  };
}

function soEquipe(req, res, next) {
  if (!PAPEIS.includes(req.user && req.user.role) && !(req.user && req.user.acessoCs)) return res.status(403).json({ error: 'Acesso restrito à equipe do Sucesso do Cliente.' });
  next();
}

const router = express.Router();
router.use(requireAuth, soEquipe);

async function motivosAtivos() {
  // a lista é a da Gestão de Clientes; se ainda não foi criada (primeira vez), o router dela semeia na primeira leitura
  try { await require('../routes/motivos-churn').garantirTabela(); return (await pool.query('SELECT id, nome FROM motivos_churn WHERE ativo = TRUE ORDER BY nome')).rows; }
  catch (e) { return []; }
}

router.get('/motivos', async (req, res) => {
  try { res.json({ motivos: await motivosAtivos() }); }
  catch (e) { console.error('[churn-motivos] GET /motivos falhou:', e); res.status(500).json({ error: 'Erro ao ler os motivos.' }); }
});

/** Valida o texto de um motivo novo, digitado quando se escolhe "Outro". */
function validarNovoMotivo(txt) {
  const nome = String(txt == null ? '' : txt).replace(/\s+/g, ' ').trim();
  if (nome.length < 3) return { ok: false, erro: 'Escreva qual é o motivo do churn (mínimo de 3 letras).' };
  if (nome.length > 120) return { ok: false, erro: 'O motivo passa de 120 caracteres.' };
  if (norm(nome) === 'outro') return { ok: false, erro: 'Escreva qual é o motivo em vez de "Outro".' };
  return { ok: true, nome };
}

router.put('/definir', async (req, res) => {
  if (!PAPEIS.includes(req.user.role)) return res.status(403).json({ error: 'Só administrador ou usuário classifica o motivo do churn.' });
  const b = req.body || {};
  const id = String(b.cliente_id || '').trim();
  if (!id) return res.status(400).json({ error: 'Informe o cliente.' });
  try {
    await churn.garantirColuna();
    let motivo = null, novo = false;
    if (b.novo_motivo !== null && b.novo_motivo !== undefined && String(b.novo_motivo).trim() !== '') {
      // "Outro": o motivo digitado entra na lista existente (a mesma da Gestão de Clientes) e já fica salvo nesta saída.
      const v = validarNovoMotivo(b.novo_motivo);
      if (!v.ok) return res.status(400).json({ error: v.erro });
      const existe = await pool.query(`SELECT 1 FROM clientes WHERE id::text = $1 AND status = 'encerrado'`, [id]);
      if (!existe.rows.length) return res.status(404).json({ error: 'Cliente encerrado não encontrado.' });
      const todos = (await pool.query('SELECT id, nome, ativo FROM motivos_churn')).rows;
      const ja = todos.find((m) => norm(m.nome) === norm(v.nome));
      if (ja) {
        if (!ja.ativo) await pool.query('UPDATE motivos_churn SET ativo = TRUE WHERE id = $1', [ja.id]);
        motivo = ja.nome;
      } else {
        const ins = await pool.query('INSERT INTO motivos_churn (nome) VALUES ($1) ON CONFLICT (nome) DO UPDATE SET ativo = TRUE RETURNING nome', [v.nome]);
        motivo = ins.rows[0].nome; novo = true;
      }
    } else if (b.motivo !== null && b.motivo !== undefined && String(b.motivo).trim() !== '') {
      const lista = await motivosAtivos();
      const achado = lista.find((m) => norm(m.nome) === norm(b.motivo));
      if (!achado) return res.status(400).json({ error: 'Motivo fora da lista. Inclua-o em Gerenciar motivos.' });
      motivo = achado.nome;
    }
    const up = await pool.query(
      `UPDATE clientes SET motivo_churn = $1, motivo_churn_por = $2, motivo_churn_em = NOW() WHERE id::text = $3 AND status = 'encerrado' RETURNING id`,
      [motivo, req.user.name || null, id]);
    if (!up.rows.length) return res.status(404).json({ error: 'Cliente encerrado não encontrado.' });
    res.json({ ok: true, motivo, novo });
  } catch (e) { console.error('[churn-motivos] PUT /definir falhou:', e); res.status(500).json({ error: 'Erro ao salvar o motivo.' }); }
});

router.get('/fechamento', async (req, res) => {
  const hoje = churn.hojeBrasilia();
  const mes = /^\d{4}-\d{2}$/.test(req.query.mes || '') ? req.query.mes : hoje.slice(0, 7);
  if (mes > hoje.slice(0, 7)) return res.status(400).json({ error: 'Esse mês ainda não começou.' });
  try {
    const [clientes, padroes, motivos] = await Promise.all([churn.carregarClientes(), churn.lerPadroes(), motivosAtivos()]);
    const f = montarFechamento(clientes, mes, hoje, padroes, motivos.map((m) => m.nome));
    // meses do ano corrente para as abas
    const ano = hoje.slice(0, 4);
    const abas = []; for (let m = 1; m <= parseInt(hoje.slice(5, 7), 10); m++) abas.push(ano + '-' + String(m).padStart(2, '0'));
    res.json({ ...f, abas, motivos_lista: motivos });
  } catch (e) { console.error('[churn-motivos] GET /fechamento falhou:', e); res.status(500).json({ error: 'Erro ao montar o fechamento do mês.' }); }
});

module.exports = { router, validarNovoMotivo, montarFechamento, motivoEfetivo, ultimoDia, mesAnterior };
