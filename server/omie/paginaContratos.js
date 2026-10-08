/**
 * Script que roda DENTRO da aba do ERP do Omie (app.omie.com.br) — só LEITURA da grade "Serviços e NFS-e → Contratos de Serviço".
 * Lê os contratos com Situação "Suspenso" (selo ⏸ Suspenso do Risco) de UMA empresa do Omie por vez. Testado em 08/10/2026
 * no navegador integrado do Claude, nas duas empresas (ESCRITORIAL: 498 contratos / 15 suspensos; SOLUÇÕES: 237 / 8).
 * O login é do Reysner; nunca digitar senha. Nunca clicar em nada que inclua, edite ou exclua contrato.
 *
 * ── PASSO A (abrir a grade): no javascript_tool rode
 *      document.querySelector('[data-slug="listar-todas-contratos-servico"]').click()
 *    (é o item "Exibir todos" do bloco "Contratos de Serviço"; o menu fica oculto, por isso o clique por JS). Espere ~15 s
 *    (a grade abre vazia e carrega depois) e confirme com um screenshot pequeno que a janela "Contrato de Serviço" tem linhas.
 *
 * ── PASSO B: rode o SCRIPT 4 abaixo (assíncrono; ~20 s). Consulte depois:
 *      ({ done: window.__ctr.done, err: window.__ctr.err, total: window.__ctr.antes, suspensos: window.__ctr.total })
 *    total (= contratos da grade SEM filtro) deve ser parecido com o de semana passada (ESCRITORIAL ≈ 498, SOLUÇÕES ≈ 237).
 *    Depois leia window.__ctr.saida (texto compacto) e grave EXATAMENTE como veio em
 *      server/omie/tmp/escritorial-suspensos.txt   ou   server/omie/tmp/solucoes-suspensos.txt
 *
 * ── PASSO C: com as DUAS empresas lidas, rode  node server/omie/enviarSuspensos.js --escritorial=... --solucoes=...
 *
 * Observação: a janela de contratos pode já abrir com um filtro de outra consulta (ex.: um nome); o script limpa todos os filtros
 * antes de filtrar a Situação. Se houver outra grade aberta por baixo (ex.: Contas a Receber), o script usa só a que tem o campo CONTRATO.
 */

// ═══════════ SCRIPT 4 — CONTRATOS SUSPENSOS (uma empresa) ═══════════
/*
window.__ctr = { done: false, err: null, rows: [], total: null, antes: null, saida: null };
(async () => { try {
  const $ = window.jQuery; const espera = (ms) => new Promise(r => setTimeout(r, ms));
  const pick = $('[id$="g_container"]').toArray().find(e => { const gd = $('#' + e.id.replace('_container', '')).data('igGrid'); const d = gd && gd.dataSource.data(); return gd && e.offsetParent !== null && d[0] && 'CONTRATO' in d[0]; });
  if (!pick) throw new Error('grade de contratos não encontrada (abra "Exibir todos" dos Contratos de Serviço e espere carregar)');
  const g = $('#' + pick.id.replace('_container', '')); const ds = () => g.data('igGrid').dataSource;
  const aplicar = async (inp, txt) => { const antes = ds().totalRecordsCount(); inp.focus(); inp.value = txt; ['input', 'keyup'].forEach(t => inp.dispatchEvent(new Event(t, { bubbles: true }))); ['keydown', 'keypress', 'keyup'].forEach(t => inp.dispatchEvent(new KeyboardEvent(t, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }))); for (let i = 0; i < 30; i++) { await espera(500); if (ds().totalRecordsCount() !== antes) break; } await espera(2500); };
  const inps = $('#' + g.attr('id') + '_container input.ui-iggrid-filtereditor').toArray();
  for (const i of inps) if (i.value) await aplicar(i, '');          // limpa filtros que já estivessem na janela
  window.__ctr.antes = ds().totalRecordsCount();                     // contratos da grade, sem filtro
  await aplicar(inps[0], 'Susp');                                    // 1º filtro = coluna Situação
  window.__ctr.total = ds().totalRecordsCount();
  const guardar = () => { for (const r of ds().data() || []) window.__ctr.rows.push({ s: String(r.SITUACAO || '').replace(/^\[[^\]]*\]/, '').trim(), c: r.CGC_CLI, n: r.NOME_CLI, k: r.CONTRATO }); };
  guardar();                                                         // ≤ 50 suspensos cabem numa página; se passar, é preciso paginar
  if (window.__ctr.total > 50) throw new Error('mais de 50 contratos suspensos: falta paginar neste script');
  if (window.__ctr.rows.length !== window.__ctr.total || window.__ctr.rows.some(r => !/^Suspenso$/i.test(r.s))) throw new Error('leitura inconsistente (linhas diferentes do total ou situação diferente de Suspenso)');
  window.__ctr.saida = '#total=' + window.__ctr.antes + '\n' + window.__ctr.rows.map(r => [r.c, r.k, String(r.n || '').replace(/\|/g, ' ')].join('|')).join('\n');
  window.__ctr.done = true;
} catch (e) { window.__ctr.err = String(e); window.__ctr.done = true; } })();
'iniciado'
*/
