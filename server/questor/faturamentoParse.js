'use strict';
/** Lê o CSV do relatório "Demonstrativo Mensal de Faturamento - Texto" (nFisRRFaturamento) e devolve uma entrada por empresa/página. Função pura. */
const num = (s) => Number(String(s).replace(/\./g, '').replace(',', '.'));
const dig = (s) => String(s || '').replace(/\D/g, '');

function parseFaturamento(csv) {
  const linhas = String(csv || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const empresas = []; let atual = null;
  for (const l of linhas) {
    const cab = /^"(\d+)\s+(.+?)";"\d{2}\/\d{2}\/\d{4}/.exec(l);
    if (cab) { atual = { codigo: cab[1], nome: cab[2], cnpj: null, periodo: null, meses: [], total: null }; empresas.push(atual); continue; }
    if (!atual) continue;
    const doc = /^"(?:CNPJ|CPF|CNO|CAEPF)[^:"]*: ([^"]+)";"Período: ([^"]+)"/.exec(l); if (doc) { atual.cnpj = dig(doc[1]); atual.periodo = doc[2]; continue; }
    const mes = /^"([A-ZÇÃÉÊ]+)";(\d{4});(-?[\d.,]+)$/.exec(l); if (mes) { atual.meses.push({ mes: mes[1], ano: +mes[2], valor: num(mes[3]) }); continue; }
    const tot = /^"TOTAL";;(-?[\d.,]+)$/.exec(l); if (tot) atual.total = num(tot[1]);
  }
  return empresas;
}

/** Confere se a entrada está completa (CNPJ, 12 meses e total que bate com a soma dos meses). */
function entradaValida(e, mesesEsperados = 12) {
  if (!e.cnpj || e.total == null || e.meses.length !== mesesEsperados) return false;
  const soma = e.meses.reduce((s, m) => s + m.valor, 0);
  return Math.abs(soma - e.total) < 0.05;
}
/**
 * Avisos do Questor por empresa/filial: "Empresa: 0010 NOME-MATRIZ - Existem Naturezas com movimentação: 6103002, mas sem a configuração de Faturamento…".
 * Devolve Map "empresa|filial" -> [códigos das naturezas]. Nessas empresas o faturamento pode estar SUBCONTADO.
 */
function avisosPorEstab(avisos) {
  const mapa = new Map();
  for (const a of avisos || []) {
    const m = /Empresa:\s*0*(\d+)\s.*-\s*(?:Matriz|Filial\s*(\d+))\s*-\s*Existem Naturezas com movimenta[çc][ãa]o:\s*([\d,\s]+?),?\s*mas sem a configura[çc][ãa]o de Faturamento/i.exec(String(a));
    if (!m) continue;
    const chave = `${m[1]}|${m[2] || '1'}`;
    const codigos = m[3].split(',').map((x) => x.trim()).filter(Boolean);
    mapa.set(chave, [...new Set([...(mapa.get(chave) || []), ...codigos])]);
  }
  return mapa;
}
module.exports = { parseFaturamento, entradaValida, avisosPorEstab, dig };
