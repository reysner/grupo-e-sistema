'use strict';
/**
 * Ajuste ÚNICO da lista de analistas, a partir da planilha enviada pelo Reysner em 15/10/2026 ("Nome atual -> Nome completo"):
 *   - renomeia cada analista para o nome completo;
 *   - inclui quem está na planilha e ainda não estava na lista (Annaisa);
 *   - tira da lista quem saiu da empresa (Daniel): exclui, ou desativa se já tiver registro de Qualidade.
 * Roda uma vez (marca em cs_painel_config) e nunca mais: edições manuais feitas depois, em "Gerenciar analistas", não são desfeitas.
 */
const CHAVE = 'analistas_nomes_planilha_2026_10_15';

const RENOMEAR = [
  ['Bruno Xavier', 'Bruno Cesar Xavier'], ['Bruno Cortez', 'Bruno Henrique Cortez'],
  ['Denisa- Diretora Dpto Pessoal', 'Denisa Maria Ribeiro Souza Xavier'], ['Douglas', 'Douglas da Silva Nascimento'],
  ['Dila', 'Edilamar Aparecida Oliveira'], ['Eduardo - Diretor Contábil e Fiscal', 'Eduardo de Queiroz Cançado Junior'],
  ['Elma', 'Elma Aparecida Oliveira'], ['Eva', 'Eva Monique Ferreira Silva'], ['Guilherme', 'Guilherme de Barros Amaro'],
  ['Ivone', 'Ivone Cardoso Rodrigues'], ['Joao Victor', 'Joao Victor Moraes de Almeida Vasconcelos'],
  ['Josiane - Diretora Geral', 'Josiane Alves de Oliveira Cezario'], ['Kelen', 'Kelen Garcia da Silva'], ['Ketlen', 'Ketlen Rafaela'],
  ['Larissa', 'Larissa Trazzi'], ['Leila', 'Leila Palmieri'], ['Luciana', 'Luciana Teixeira Mendonca'], ['Maira Soares', 'Maira Soares'],
  ['Maria Eduarda', 'Maria Eduarda Silva Souza'], ['Max', 'Max Suel Goncalves'], ['Nathania', 'Nathania Andrade Conceição'],
  ['Polyanna', 'Polyanna Queiroz de Almeida'], ['Reysner', 'Reysner Samuel de Oliveira'],
  ['Rodrigo', 'Rodrigo Christian Moura Wanderley Guimaraes'], ['Sueimy', 'Sueimy Catherine Cardoso'],
  ['Tayone', 'Tayone Stay Ferreira da Silva'], ['Thais', 'Thais Ortelan Garcia'],
];
const INCLUIR = ['Annaisa Alves de Oliveira'];
const SAIRAM = ['Daniel'];

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Plano puro: dado o que existe na lista, devolve o que fazer. */
function planejar(lista) {
  const acoes = { renomear: [], incluir: [], sairam: [] };
  const ocupados = new Set(lista.map((a) => norm(a.nome)));
  RENOMEAR.forEach(([atual, completo]) => {
    const a = lista.find((x) => norm(x.nome) === norm(atual));
    if (!a || a.nome === completo) return;
    if (ocupados.has(norm(completo)) && norm(completo) !== norm(a.nome)) return;   // já existe outro com esse nome: não duplica
    ocupados.delete(norm(a.nome)); ocupados.add(norm(completo));
    acoes.renomear.push({ id: a.id, de: a.nome, para: completo });
  });
  INCLUIR.forEach((nome) => { if (!ocupados.has(norm(nome))) { acoes.incluir.push(nome); ocupados.add(norm(nome)); } });
  SAIRAM.forEach((nome) => { const a = lista.find((x) => norm(x.nome) === norm(nome)); if (a) acoes.sairam.push({ id: a.id, nome: a.nome }); });
  return acoes;
}

let _feito = null;
/** Aplica uma vez. Seguro para chamar várias vezes (memoiza e confere a marca no banco). */
function aplicar(pool) {
  if (!_feito) {
    _feito = (async () => {
      await pool.query(`CREATE TABLE IF NOT EXISTS cs_painel_config (
        chave TEXT PRIMARY KEY, valor JSONB NOT NULL, atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(), atualizado_por TEXT)`);
      const marca = await pool.query('SELECT 1 FROM cs_painel_config WHERE chave = $1', [CHAVE]);
      if (marca.rows.length) return;
      const lista = (await pool.query('SELECT id, nome, ativo FROM analistas')).rows;
      if (!lista.length) return;                                    // lista ainda vazia: tenta de novo na próxima
      const p = planejar(lista);
      for (const r of p.renomear) await pool.query('UPDATE analistas SET nome = $1 WHERE id = $2', [r.para, r.id]);
      for (const nome of p.incluir) await pool.query('INSERT INTO analistas (nome) VALUES ($1) ON CONFLICT (nome) DO NOTHING', [nome]);
      for (const s of p.sairam) {
        let usos = 0;
        try { usos = (await pool.query('SELECT COUNT(*)::int AS n FROM cs_qualidade_registros WHERE analista_id = $1', [String(s.id)])).rows[0].n; } catch (e) { usos = 0; }
        if (usos > 0) await pool.query('UPDATE analistas SET ativo = FALSE WHERE id = $1', [s.id]);
        else await pool.query('DELETE FROM analistas WHERE id = $1', [s.id]);
      }
      await pool.query(`INSERT INTO cs_painel_config (chave, valor, atualizado_por) VALUES ($1, $2::jsonb, 'planilha 15/10/2026') ON CONFLICT (chave) DO NOTHING`,
        [CHAVE, JSON.stringify({ renomeados: p.renomear.length, incluidos: p.incluir, sairam: p.sairam.map((s) => s.nome) })]);
      console.log(`[analistas] nomes completos aplicados: ${p.renomear.length} renomeado(s), ${p.incluir.length} incluído(s), ${p.sairam.length} retirado(s).`);
    })().catch((e) => { _feito = null; console.error('[analistas] ajuste dos nomes falhou:', e.message); });
  }
  return _feito;
}

module.exports = { aplicar, planejar, norm, RENOMEAR, INCLUIR, SAIRAM, CHAVE };
