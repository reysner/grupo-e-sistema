'use strict';
/**
 * Faturamento por ANO a partir do relatório "Demonstrativo Mensal do Faturamento" (nFisRRFaturamento) com período longo.
 * Funções PURAS (testadas em testes_anual.js). Entrada: o que parseFaturamento() devolve (uma entrada por página do relatório).
 *
 * Um relatório de vários anos vem em várias "páginas" (uma por bloco de meses); só a última traz o TOTAL, que vale para o período todo.
 * A leitura só é aceita se a soma dos meses bater com esse TOTAL.
 */
const MES = { JANEIRO: 1, FEVEREIRO: 2, 'MARÇO': 3, MARCO: 3, ABRIL: 4, MAIO: 5, JUNHO: 6, JULHO: 7, AGOSTO: 8, SETEMBRO: 9, OUTUBRO: 10, NOVEMBRO: 11, DEZEMBRO: 12 };
const r2 = (n) => Math.round(n * 100) / 100;

/**
 * @param paginas  saída de parseFaturamento(csv)
 * @param doc      CNPJ/CPF/CNO/CAEPF só com dígitos
 * @returns { ok, motivo?, anos: { 'AAAA': { faturamento, meses, meses_com_valor } }, total, meses }
 */
function agregarPorAno(paginas, doc) {
  const minhas = (paginas || []).filter((p) => p && p.cnpj === doc);
  if (!minhas.length) return { ok: false, motivo: 'documento não aparece no relatório', anos: {} };
  const vistos = new Map();                        // 'AAAA-MM' -> valor
  for (const p of minhas) {
    for (const m of p.meses || []) {
      const mes = MES[String(m.mes || '').toUpperCase()];
      if (!mes) return { ok: false, motivo: 'mês desconhecido: ' + m.mes, anos: {} };
      const chave = `${m.ano}-${String(mes).padStart(2, '0')}`;
      if (vistos.has(chave) && Math.abs(vistos.get(chave) - m.valor) > 0.005) return { ok: false, motivo: 'mês repetido com valores diferentes: ' + chave, anos: {} };
      vistos.set(chave, m.valor);
    }
  }
  if (!vistos.size) return { ok: false, motivo: 'relatório sem meses', anos: {} };
  const totais = minhas.map((p) => p.total).filter((t) => t != null);
  const total = totais.length ? totais[totais.length - 1] : null;
  const soma = [...vistos.values()].reduce((s, v) => s + v, 0);
  if (total == null) return { ok: false, motivo: 'relatório sem TOTAL (página final ausente)', anos: {} };
  if (Math.abs(soma - total) > 0.5) return { ok: false, motivo: `soma dos meses (${r2(soma)}) não bate com o TOTAL (${r2(total)})`, anos: {} };
  const anos = {};
  for (const [chave, v] of vistos) {
    const a = chave.slice(0, 4);
    const x = (anos[a] = anos[a] || { faturamento: 0, meses: 0, meses_com_valor: 0 });
    x.faturamento += v; x.meses++; if (v !== 0) x.meses_com_valor++;
  }
  Object.keys(anos).forEach((a) => { anos[a].faturamento = r2(anos[a].faturamento); });
  return { ok: true, anos, total: r2(total), meses: vistos.size };
}

/** Competência 'MM/AAAA' do início (janeiro do ano) e quantidade de meses esperada até o fim 'AAAA-MM'. */
function mesesEsperados(anoInicial, fim /* 'AAAA-MM' */) {
  const [a, m] = fim.split('-').map(Number);
  return (a - anoInicial) * 12 + m;
}

/**
 * Relatório "Relação de Empregados Ativos" (nfpaRRFuncAtivo, agrupado por Empresa e Competência): uma linha por empresa e por mês com o total de
 * empregados ativos. Devolve { codigoEmpresa: { 'AAAA-MM': total } }. Só meses com folha processada aparecem.
 */
function parseAtivos(csv) {
  const out = {}; let emp = null;
  for (const bruto of String(csv || '').split(/\r?\n/)) {
    const l = bruto.trim();
    const e = /^(\d+);"/.exec(l);
    if (e) { emp = e[1]; out[emp] = out[emp] || {}; continue; }
    const m = /^(\d{2})\/(\d{4});"\s*(\d+)\s*"/.exec(l);
    if (m && emp) out[emp][`${m[2]}-${m[1]}`] = parseInt(m[3], 10);
  }
  return out;
}

/**
 * Relatórios "Relação Optantes do SIMPLES Nacional / Lucro Presumido / Lucro Real" com Data Base: uma linha "Empresa: ..., CNPJ: ..." seguida da
 * linha da opção ("Sim";data;...). Devolve o Set de documentos (só dígitos) que são optantes na data base.
 */
function parseOptantes(csv) {
  const out = new Set(); let doc = null;
  for (const bruto of String(csv || '').split(/\r?\n/)) {
    const l = bruto.trim();
    const e = /^"Empresa:\s*\d+\s+.*?(?:CNPJ|CPF|CNO|CAEPF)[^:"]*:\s*([\d./-]+)"/.exec(l);
    if (e) { doc = e[1].replace(/\D/g, ''); continue; }
    if (doc && /^"Sim";/.test(l)) out.add(doc);
  }
  return out;
}

/** Funcionários do ano a partir dos totais mensais: o do último mês com folha no ano (dezembro, nos anos fechados) e a média dos meses com folha. */
function funcionariosDoAno(meses, ano) {
  const chaves = Object.keys(meses || {}).filter((k) => k.startsWith(ano + '-')).sort();
  if (!chaves.length) return { funcionarios: null, funcionarios_media: null, meses_com_folha: 0 };
  const valores = chaves.map((k) => meses[k]);
  const media = valores.reduce((s, v) => s + v, 0) / valores.length;
  return { funcionarios: valores[valores.length - 1], funcionarios_media: Math.round(media * 10) / 10, meses_com_folha: chaves.length };
}

/** Regime do ano pelo conjunto de optantes na data base. As relações de Lucro Presumido e Lucro Real são pouco preenchidas, por isso "Fora do Simples" é o rótulo geral. */
function rotuloRegime(doc, { simples, presumido, real }) {
  if (simples && simples.has(doc)) return 'Simples Nacional';
  if (real && real.has(doc)) return 'Lucro Real';
  if (presumido && presumido.has(doc)) return 'Lucro Presumido';
  return 'Fora do Simples';
}

module.exports = { agregarPorAno, mesesEsperados, parseAtivos, parseOptantes, funcionariosDoAno, rotuloRegime };
