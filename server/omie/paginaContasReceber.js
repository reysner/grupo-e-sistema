/**
 * Scripts que rodam DENTRO da aba do ERP do Omie (app.omie.com.br) — só LEITURA da grade "Finanças → Contas a Receber".
 * Usados pela rotina diária (ver server/omie/LEIA-ME.md). O login é do Reysner; nunca digitar senha.
 * Cada bloco (entre /* e *\/) é um script separado, colado no javascript_tool (limite de ~45 s por chamada → o de coleta roda em
 * segundo plano e é consultado depois). Testado no Chrome (extensão) e no navegador integrado do Claude (21/09/2026).
 *
 * ATENÇÃO — aba em segundo plano: o Chrome pausa timers de aba oculta (document.visibilityState === 'hidden'). No Chrome, enquanto o
 * script 1 roda, mantenha a aba visível ou dê um computer.screenshot pequeno a cada ~10 s pra "acordar" a aba.
 *
 * ── PASSO A (UI, antes do script 1): Finanças → Contas a Receber → "Exibir todas". (Não precisa limpar filtro: o script cuida.)
 *    No Chrome (extensão), o menu abre por clique despachado por JS no <li> "Exibir todas" do bloco "Contas a Receber"
 *    (o que tem "Registrar recebimentos" no mesmo bloco).
 */

// ═══════════ SCRIPT 1 — COLETA OTIMIZADA (~10 min na Escritorial, 16 mil títulos; lê só o que interessa) ═══════════
// Fases: (1) atrasados [filtro Situação "Atras"], (2) parciais ["Parc"], (3) a vencer / vence hoje ["venc"], (4) vencimento recente:
// limpa o filtro, ordena por Vencimento decrescente e lê páginas até passar de 7 meses atrás (cutoff).
// Consultar: ({ fase: window.__om2.fase, pagina: window.__om2.pagina, n: window.__om2.rows.length, contagem: window.__om2.contagem, done: window.__om2.done, err: window.__om2.err })
/*
const $ = window.jQuery; const g = $('#' + $('[id$="g_container"]').toArray()[0].id.replace('_container', '')); const ds = () => g.data('igGrid').dataSource;
const ev = (el) => { const r = el.getBoundingClientRect(); const o = { bubbles: true, cancelable: true, view: window, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, button: 0 }; ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(t => el.dispatchEvent(t.startsWith('pointer') ? new PointerEvent(t, o) : new MouseEvent(t, o))); };
const clicar = (sel) => { const el = $(sel)[0]; if (!el) return false; ev(el); return true; };
const iso = (d) => (d && d.getFullYear) ? d.toISOString().slice(0, 10) : (typeof d === 'string' ? d : null);
const espera = (ms) => new Promise(r => setTimeout(r, ms));
const primeiro = () => (ds().data()[0] || {}).REC_NO;
const hojeD = new Date(); const cutoff = new Date(hojeD.getFullYear(), hojeD.getMonth() - 6, 1).toISOString().slice(0, 10);
window.__om2 = { rows: [], ids: new Set(), fase: 'inicio', pagina: 0, done: false, err: null, cutoff, contagem: {} };
const guardar = (fase) => { for (const r of ds().data() || []) { if (window.__om2.ids.has(r.REC_NO)) continue; window.__om2.ids.add(r.REC_NO); window.__om2.contagem[fase] = (window.__om2.contagem[fase] || 0) + 1; window.__om2.rows.push({ n: r.NOME_CLI, z: r.RAZAO_CLI, c: r.CGC_CLI, s: String(r.SITUACAO || '').replace(/^\[[^\]]*\]/, ''), k: r.DESCR_PAG, v: r.VALOR_DOC, p: r.VL_PAGO, a: r.VL_PAGAR, dv: iso(r.DATA_VENC), dp: iso(r.DATA_PAGA), id: r.REC_NO }); } };
const setFiltro = async (txt) => { const inp = $('#' + g.attr('id') + '_container input.ui-iggrid-filtereditor').toArray()[0]; const antes = ds().totalRecordsCount(); inp.focus(); inp.value = txt; ['input', 'keyup'].forEach(t => inp.dispatchEvent(new Event(t, { bubbles: true }))); ['keydown', 'keypress', 'keyup'].forEach(t => inp.dispatchEvent(new KeyboardEvent(t, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }))); for (let i = 0; i < 30; i++) { await espera(500); if (ds().totalRecordsCount() !== antes) break; } await espera(2500); };
const ordenarVencDesc = async () => { const th = $('#' + g.attr('id') + '_headers th').toArray().find(t => /^Vencimento$/.test(t.innerText.replace(/[«\s]+$/, '').trim())); for (let i = 0; i < 3; i++) { clicar('.ui-iggrid-firstpage'); await espera(3500); const d = ds().data(); if (d.length > 1 && iso(d[0].DATA_VENC) >= iso(d[d.length - 1].DATA_VENC) && iso(d[0].DATA_VENC) >= '2026-01-01') return true; ev(th.querySelector('a') || th); await espera(8000); } return false; };
const percorrer = async (fase, parar) => { clicar('.ui-iggrid-firstpage'); await espera(4000); const total = ds().totalRecordsCount(); const paginas = Math.ceil(total / 50); window.__om2.fase = fase; for (let p = 1; p <= paginas; p++) { guardar(fase); window.__om2.pagina = p; const d = ds().data(); if (parar && d.length && parar(d[d.length - 1])) break; if (p === paginas) break; const antes = primeiro(); clicar('.ui-iggrid-nextpage'); let t = 0; while (t < 60) { await espera(400); if (primeiro() !== antes) break; t++; } await espera(250); } };
(async () => { try {
  for (const [fase, txt] of [['atrasados', 'Atras'], ['parciais', 'Parc'], ['avencer', 'venc']]) { await setFiltro(txt); await percorrer(fase, null); }
  await setFiltro(''); window.__om2.ordenou = await ordenarVencDesc();
  await percorrer('recentes', (u) => (iso(u.DATA_VENC) || '9') < cutoff);
  window.__om2.done = true;
} catch (e) { window.__om2.err = String(e); } })();
'iniciado cutoff=' + cutoff
*/
// Ao terminar (done=true): ordenou deve ser true; contagem.recentes > 0. A Soluções Escritorial (3,4 mil títulos) também roda assim.

// ═══════════ SCRIPT 2 — RESUMO (rápido) → listas COMPACTAS pro importarOmie.js ═══════════
/*
const R = window.__om2.rows.filter(r => r.s !== 'Cancelado');
const frac = (k) => { if (!/HONOR[ÁA]RIOS CONT[ÁA]BEIS/i.test(k || '')) return 0; const m = /HONOR[ÁA]RIOS CONT[ÁA]BEIS\s*\(([\d.,]+)%\)/i.exec(k); return m ? parseFloat(m[1].replace(/\./g, '').replace(',', '.')) / 100 : 1; };
const hojeD = new Date(); const ym = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
const somaMes = (n) => ym(new Date(hojeD.getFullYear(), hojeD.getMonth() + n, 1));
const HOJE = hojeD.toISOString().slice(0, 10); const JANELA = somaMes(-6); const ATIVO_DESDE = somaMes(-2);
const r2 = (x) => Math.round(x * 100) / 100; const num = (x) => r2(x).toFixed(2).replace(/\.?0+$/, '');
const yymm = (m) => m ? m.slice(2, 4) + m.slice(5, 7) : ''; const yymmdd = (d) => d ? d.slice(2, 4) + d.slice(5, 7) + d.slice(8, 10) : '';
const C = {}, A = {};
for (const r of R) {
  const f = frac(r.k); if (!f || !r.c || !r.dv) continue;
  const doc = r.c.replace(/\D/g, ''); const nome = r.z || r.n; const mes = r.dv.slice(0, 7);
  const c = C[doc] = C[doc] || { nome, meses: {}, primeiro: mes }; c.meses[mes] = (c.meses[mes] || 0) + (+r.v || 0) * f; if (mes < c.primeiro) c.primeiro = mes;
  const aberto = /^Atrasado|Parcialmente|^A vencer|^Vence/.test(r.s) ? (+r.a || 0) * f : 0;
  if (aberto > 0.005) { const a = A[doc] = A[doc] || { nome, n: 0, ab: 0, at: 0, nat: 0, velho: '' }; a.n++; a.ab += aberto; if (r.dv < HOJE) { a.at += aberto; a.nat++; if (!a.velho || r.dv < a.velho) a.velho = r.dv; } }
}
// honorário ATUAL = valor em vigor: no período recente (7 meses), o último valor que se repete por ≥2 meses seguidos
// (um mês isolado a mais = serviço extra, ignorado); cliente ativo = tem honorário nos últimos 3 meses.
const escolher = (c) => { const ms = Object.keys(c.meses).sort(); let usar = ms.filter(m => m >= JANELA); if (!usar.length) usar = ms.slice(-1);
  const vals = usar.map(m => r2(c.meses[m])); const runs = []; vals.forEach((v, i) => { const u = runs[runs.length - 1]; if (u && u.v === v) u.n++; else runs.push({ v, n: 1, ini: usar[i] }); });
  let e = null; for (let i = runs.length - 1; i >= 0; i--) if (runs[i].n >= 2) { e = runs[i]; break; } return e || runs[runs.length - 1]; };
const ult = (c) => Object.keys(c.meses).sort().pop();
const hon = Object.entries(C).filter(([, c]) => ult(c) >= ATIVO_DESDE).map(([d, c]) => { const e = escolher(c); return [d, num(e.v), yymm(e.ini)].join('|'); });
const abertos = Object.entries(A).map(([d, a]) => [d, a.n, num(a.ab), num(a.at), a.nat, yymmdd(a.velho)].join('|'));
window.__C = C; window.__A = A;
window.__nomes = (docs) => docs.map(d => { const c = C[d] || {}; const a = A[d] || {}; return [d, (c.nome || a.nome || '').replace(/\|/g, ' '), yymm(c.primeiro)].join('|'); }).join('\n');
window.__saida = { hon, abertos };
({ titulos: R.length, clientesAtivos: hon.length, clientesComAberto: abertos.length, JANELA, ATIVO_DESDE })
*/

// ═══════════ SCRIPT 3 — SAÍDA (o javascript_tool do Chrome corta a resposta em ~1000 caracteres) ═══════════
// Troca o corpo da página por um <pre> com as listas e lê com get_page_text (aceita até dezenas de milhares de caracteres):
/*
document.body.innerHTML = '<pre id="__saida_txt" style="white-space:pre-wrap">HON\n' + window.__saida.hon.join('\n') + '\nABERTO\n' + window.__saida.abertos.join('\n') + '\nFIM</pre>'; document.getElementById('__saida_txt').textContent.length
*/
// Depois: get_page_text → gravar as linhas entre HON e ABERTO em <slug>-hon.txt e entre ABERTO e FIM em <slug>-aberto.txt
// (server/omie/tmp/). ATENÇÃO: isso destrói a página; o window.__nomes(...) continua disponível (variáveis vivem) — no fim recarregue o ERP.
// Rodar: node server/omie/importarOmie.js --unidade="..." --hon=... --aberto=... — se responder NOMES_NECESSARIOS: a,b,c → no mesmo tab:
//   window.__nomes(['a','b','c'])  → gravar em <slug>-nomes.txt e rodar de novo com --nomes=.
