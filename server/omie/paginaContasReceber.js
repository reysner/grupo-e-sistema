/**
 * Scripts que rodam DENTRO da aba do ERP do Omie (app.omie.com.br), no navegador integrado do Claude — só LEITURA da grade
 * "Finanças → Contas a Receber". Usados pela rotina diária das 11:00 (ver server/omie/LEIA-ME.md). O login é feito pelo Reysner;
 * nunca digitar senha. Cada bloco abaixo é um script separado, colado no javascript_tool (limite de ~45 s por chamada → o de
 * coleta roda em segundo plano e é consultado depois).
 *
 * ── PASSO A (UI, antes do script 1): abrir Finanças → Contas a Receber → "Exibir todas" e clicar em "limpar os filtros e
 *    exibir todos os registros", pra a grade mostrar TODOS os títulos (o total aparece em "1 - 50 de N registros").
 */

// ═══════════════ SCRIPT 1 — COLETA (dispara em segundo plano; consultar window.__om2 até done=true; ~4 s por página de 50) ═══════════════
/*
const $ = window.jQuery; const g = $('#' + $('[id$="g_container"]').toArray()[0].id.replace('_container', ''));
const ds = () => g.data('igGrid').dataSource;
const clicar = (sel) => { const el = $(sel)[0]; if (!el) return false; const r = el.getBoundingClientRect(); const o = { bubbles: true, cancelable: true, view: window, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, button: 0 }; ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(t => el.dispatchEvent(t.startsWith('pointer') ? new PointerEvent(t, o) : new MouseEvent(t, o))); return true; };
const iso = (d) => (d && d.getFullYear) ? d.toISOString().slice(0, 10) : (typeof d === 'string' ? d : null);
const primeiro = () => (ds().data()[0] || {}).REC_NO;
window.__om2 = { rows: [], pagina: 0, done: false, err: null };
(async () => { try {
  clicar('.ui-iggrid-firstpage'); await new Promise(r => setTimeout(r, 4000));
  const total = ds().totalRecordsCount(); const paginas = Math.ceil(total / 50); window.__om2.total = total;
  for (let p = 1; p <= paginas; p++) {
    for (const r of ds().data() || []) window.__om2.rows.push({ n: r.NOME_CLI, z: r.RAZAO_CLI, c: r.CGC_CLI, s: String(r.SITUACAO || '').replace(/^\[[^\]]*\]/, ''), k: r.DESCR_PAG, v: r.VALOR_DOC, p: r.VL_PAGO, a: r.VL_PAGAR, dv: iso(r.DATA_VENC), dp: iso(r.DATA_PAGA), id: r.REC_NO });
    window.__om2.pagina = p; if (p === paginas) break;
    const antes = primeiro(); clicar('.ui-iggrid-nextpage'); let t = 0;
    while (t < 40) { await new Promise(r => setTimeout(r, 500)); if (primeiro() !== antes) break; t++; }
    await new Promise(r => setTimeout(r, 250));
  }
  window.__om2.done = true;
} catch (e) { window.__om2.err = String(e); } })();
'iniciado'
*/
// Conferir: ({ pagina: window.__om2.pagina, n: window.__om2.rows.length, total: window.__om2.total, done: window.__om2.done, err: window.__om2.err })
// Ao terminar, n deve ser IGUAL ao total e todos os REC_NO únicos (new Set(rows.map(r => r.id)).size === n).
// OBS: element.click() puro NÃO pagina a grade — só os eventos de mouse/pointer despachados acima.

// ═══════════════ SCRIPT 2 — RESUMO (rápido): devolve as duas listas prontas pro importarOmie.js ═══════════════
/*
const R = window.__om2.rows.filter(r => r.s !== 'Cancelado');
const frac = (k) => { if (!/HONOR[ÁA]RIOS CONT[ÁA]BEIS/i.test(k || '')) return 0; const m = /HONOR[ÁA]RIOS CONT[ÁA]BEIS\s*\(([\d.,]+)%\)/i.exec(k); return m ? parseFloat(m[1].replace(/\./g, '').replace(',', '.')) / 100 : 1; };
const hojeD = new Date(); const ym = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
const somaMes = (n) => { const d = new Date(hojeD.getFullYear(), hojeD.getMonth() + n, 1); return ym(d); };
const HOJE = hojeD.toISOString().slice(0, 10); const JANELA = somaMes(-6); const ATIVO_DESDE = somaMes(-2);
const r2 = (x) => Math.round(x * 100) / 100;
const C = {}, A = {};
for (const r of R) {
  const f = frac(r.k); if (!f || !r.c || !r.dv) continue;
  const doc = r.c.replace(/\D/g, ''); const nome = r.z || r.n; const mes = r.dv.slice(0, 7);
  const c = C[doc] = C[doc] || { nome, meses: {}, primeiro: mes }; c.meses[mes] = (c.meses[mes] || 0) + (+r.v || 0) * f; if (mes < c.primeiro) c.primeiro = mes;
  const aberto = /^Atrasado|Parcialmente|^A vencer|^Vence/.test(r.s) ? (+r.a || 0) * f : 0;
  if (aberto > 0.005) { const a = A[doc] = A[doc] || { nome, n: 0, ab: 0, at: 0, nat: 0, velho: '' }; a.n++; a.ab += aberto; if (r.dv < HOJE) { a.at += aberto; a.nat++; if (!a.velho || r.dv < a.velho) a.velho = r.dv; } }
}
// honorário ATUAL = valor em vigor: no período recente, o último valor que se repete por ≥2 meses seguidos (mês isolado a mais = serviço extra, ignorado)
const escolher = (c) => { const ms = Object.keys(c.meses).sort(); let usar = ms.filter(m => m >= JANELA); if (!usar.length) usar = ms.slice(-1);
  const vals = usar.map(m => r2(c.meses[m])); const runs = []; vals.forEach((v, i) => { const u = runs[runs.length - 1]; if (u && u.v === v) u.n++; else runs.push({ v, n: 1, ini: usar[i] }); });
  let e = null; for (let i = runs.length - 1; i >= 0; i--) if (runs[i].n >= 2) { e = runs[i]; break; } return e || runs[runs.length - 1]; };
const ult = (c) => Object.keys(c.meses).sort().pop();
const hon = Object.entries(C).filter(([, c]) => ult(c) >= ATIVO_DESDE).map(([d, c]) => { const e = escolher(c); return [d, e.v.toFixed(2), e.ini, c.primeiro, c.nome].join('|'); });
const abertos = Object.entries(A).map(([d, a]) => [d, a.nome, a.n, r2(a.ab), r2(a.at), a.nat, a.velho].join('|'));
window.__saida = { hon, abertos };
({ titulos: R.length, clientesAtivos: hon.length, clientesComAberto: abertos.length, JANELA, ATIVO_DESDE })
*/
// Depois: window.__saida.hon.join('\n')  → arquivo hon.txt   |   window.__saida.abertos.join('\n') → arquivo aberto.txt (em partes se passar de ~10 mil caracteres).
