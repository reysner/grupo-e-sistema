'use strict';
// Rodar: node server/financeiro/testes_exportacao.js
// Roda o JavaScript das páginas /financeiro e /cs e do exportador (CSV/PDF) num DOM de mentira, com dados de exemplo, e confere:
// colunas x linhas, nenhum "undefined"/NaN, valores em R$ ocultos e o formato do CSV (Excel pt-BR).
process.env.LEGALIZACAO_SYNC_TOKEN = 'x';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const fin = require('./rotas');

let ok = 0;
const teste = async (nome, fn) => { await fn(); ok++; console.log('  ok -', nome); };
const PUB = path.join(__dirname, '..', '..', 'public', 'js');

function elemento() {
  const e = new Proxy(function () {}, {
    get: (t, k) => { if (k === 'style' || k === 'classList' || k === 'dataset') return k === 'classList' ? { add() {}, remove() {}, toggle() {} } : {}; if (k === Symbol.toPrimitive) return () => ''; if (k === 'then') return undefined; if (k === 'value' || k === 'textContent' || k === 'innerHTML' || k === 'innerText') return ''; if (k === 'checked') return false; return typeof t[k] === 'function' || t[k] === undefined ? () => e : t[k]; },
    set: () => true, apply: () => e,
  });
  return e;
}
function carregar(arquivo, ganchos) {
  const fonte = fs.readFileSync(path.join(PUB, arquivo), 'utf8');
  const i = fonte.lastIndexOf('})(');
  assert.ok(i > 0, 'fim do IIFE não encontrado em ' + arquivo);
  const codigo = fonte.slice(0, i) + ';globalThis.__t = ' + ganchos + ';\n' + fonte.slice(i);
  const win = {};
  const documento = { getElementById: () => elemento(), querySelectorAll: () => [], querySelector: () => elemento(), addEventListener() {}, createElement: () => elemento(), body: elemento(), head: elemento() };
  const ctx = { window: win, document: documento, localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, alert: (m) => { throw new Error('alert: ' + m); }, console, setTimeout, Promise, Date, Math, JSON, Array, Object, String, Number, Intl, RegExp, parseInt, parseFloat, isFinite, fetch: () => Promise.reject(new Error('sem rede')), URL, Blob };
  ctx.globalThis = ctx; win.document = documento;
  vm.createContext(ctx);
  vm.runInContext(codigo, ctx, { filename: arquivo });
  return { t: ctx.__t, win, ctx };
}
const semLixo = (e, nome) => {
  assert.ok(e.linhas.every((l) => l.length === e.colunas.length), nome + ': linha com número de colunas diferente do cabeçalho');
  assert.ok(e.alinhar.length === e.colunas.length, nome + ': alinhar diferente de colunas');
  const txt = JSON.stringify(e.linhas);
  assert.ok(!/undefined|NaN|\[object/.test(txt), nome + ': valor inválido na exportação: ' + (txt.match(/.{0,30}(undefined|NaN|\[object).{0,30}/) || [''])[0]);
};

(async () => {
  // ── /financeiro ──
  const B = (t) => '*Bruno Xavier:* ' + t;
  const dados = fin.compor({
    hoje: '2026-10-13',
    clientes: [
      { id: 'a', nome: 'ALFA LTDA', cnpj: '11.222.333/0001-81', grupo: 'Grupo A', cronico: false },
      { id: 'b', nome: 'BETA; "ASPAS" LTDA', cnpj: '44.555.666/0001-22', grupo: null, cronico: true },
      { id: 'c', nome: 'GAMA LTDA', cnpj: '77.888.999/0001-33', grupo: null, cronico: false },
    ],
    categorias: { a: { categoria: 'Ouro' } },
    honorarios: new Map([['11222333000181', 800], ['44555666000122', 350]]),
    abertoAgg: new Map([['11222333000181', { qtd: 3, aberto: 2400, atrasado: 1600, qtd_atrasados: 2, mais_antigo: '2026-07-10' }], ['77888999000133', { qtd: 1, aberto: 123, atrasado: 123, qtd_atrasados: 1, mais_antigo: '2026-06-10' }]]),
    titulos: [
      { doc: '11222333000181', rec: '1', venc: '2026-07-10', aberto: 800, doc_valor: 800, sit: 'A' },
      { doc: '11222333000181', rec: '2', venc: '2026-08-10', aberto: 800, doc_valor: 800, sit: 'A' },
      { doc: '11222333000181', rec: '3', venc: '2026-10-20', aberto: 800, doc_valor: 800, sit: 'V' },
    ],
    pontual: new Map([['44555666000122', { pagos: 6, media_dias: 2.8, max_dias: 9 }]]),
    suspensos: new Map([['77888999000133', { contrato: '1' }]]),
    mensagens: [{ doc: '11222333000181', dia: '2026-09-15', texto: B('Identificamos honorários em aberto da empresa.'), ticket: '900' }],
  });
  const F = carregar('financeiro.js', '{ estado: estado, dadosExport: dadosExport, linhasPorTitulo: linhasPorTitulo, COLUNAS_TITULO: COLUNAS_TITULO, abrirCompetencia: abrirCompetencia, desenharEvolucao: desenharEvolucao, desenharOportunidades: desenharOportunidades, irParaOportunidade: irParaOportunidade, listaOportunidades: listaOportunidades }');
  F.t.estado.dados = { kpis: dados.kpis, clientes: dados.clientes, valores_ocultos: false, usuario: { ve_valores: true } };
  const r1 = fin.retratoDeKpis(dados.kpis);
  F.t.estado.historico = [Object.assign({}, r1, { semana: '2026-10-05', atualizado_em: '2026-10-05 09:10', valor_atrasado: 1900, inadimplentes: 3, nunca_cobrados: 2 }), Object.assign({}, r1, { atualizado_em: '2026-10-13 17:23' })];

  await teste('financeiro: todas as seções geram colunas e linhas coerentes', () => {
    for (const sec of ['visao', 'oportunidades', 'evolucao', 'inadimplentes', 'suspensos', 'carteira', 'cobrancas', 'qualidade']) {
      const e = F.t.dadosExport(sec);
      assert.ok(e && e.colunas.length && e.linhas.length, sec + ' vazio');
      semLixo(e, 'financeiro/' + sec);
    }
  });
  await teste('financeiro: inadimplentes traz meses, valor e cobranças; CSV por título tem uma linha por honorário em aberto', () => {
    const e = F.t.dadosExport('inadimplentes');
    const alfa = e.linhas.find((l) => l[0] === 'ALFA LTDA');
    assert.deepStrictEqual([alfa[5], alfa[6], alfa[7], alfa[8], alfa[9], alfa[11]], [2, 'jun/26', 'jul/26', 2, 1600, 1]);
    const t = F.t.linhasPorTitulo(e.porTitulo);
    assert.strictEqual(t.filter((l) => l[0] === 'ALFA LTDA').length, 3);
    assert.ok(t.every((l) => l.length === F.t.COLUNAS_TITULO.length));
    assert.deepStrictEqual([...t.find((l) => l[5] === 'set/26').slice(8, 11)], ['a vencer', 0, '']);
  });
  await teste('financeiro: oportunidades (cartões, atalho para a lista filtrada) e detalhe da competência rodam sem erro', () => {
    const ops = F.t.listaOportunidades();
    assert.ok(ops.length > 0 && ops.every((o) => o.titulo && o.acao && o.qtd > 0), 'sem oportunidades');
    F.t.desenharOportunidades();
    const h0 = F.t.estado.historico;
    F.t.desenharEvolucao();                            // duas semanas: cartões com variação, gráficos e tabela
    F.t.estado.historico = [h0[1]];                    // uma semana só: sem variação, sem erro
    F.t.desenharEvolucao();
    F.t.estado.historico = [];
    F.t.desenharEvolucao();
    F.t.estado.historico = h0;
    for (const o of ops.filter((x) => x.ir)) F.t.irParaOportunidade(o.chave);
    assert.strictEqual(F.t.estado.f.inad.pag, 1);
    F.t.abrirCompetencia('2026-07');
  });
  await teste('financeiro: com "Ocultar valores" nenhum valor em R$ vai para a exportação', () => {
    F.t.estado.ocultar = true;
    for (const sec of ['visao', 'oportunidades', 'evolucao', 'inadimplentes', 'suspensos', 'carteira', 'cobrancas']) {
      const e = F.t.dadosExport(sec);
      const txt = JSON.stringify(e.linhas);
      assert.ok(!/\b(800|1600|1723|2400|350|123)\b/.test(txt), sec + ' vazou valor: ' + txt.slice(0, 200));
    }
    assert.ok(F.t.linhasPorTitulo(F.t.dadosExport('inadimplentes').porTitulo).every((l) => l[7] === 'oculto'));
    F.t.estado.ocultar = false;
  });

  // ── /cs ──
  const risco = (nivel, pontos, term, extra) => Object.assign({ nivel, pontos, alerta: false, suspenso: false, termometros: term, motivos: [] }, extra || {});
  const C = carregar('cs-painel.js', '{ estado: estado, dadosExport: dadosExport, honSugerido: honSugerido, honAnalise: honAnalise, celSugerido: celSugerido, celAnalise: celAnalise, linhasAnual: linhasAnual, filtroAnual: filtroAnual, destaqueAnual: destaqueAnual, varPct: varPct, anosAnual: anosAnual, desenharAnual: desenharAnual, destaqueLinha: destaqueLinha, reajusteLinha: reajusteLinha, desenharAtendimento: desenharAtendimento, motivoDaSaida: motivoDaSaida, selectMotivoChurn: selectMotivoChurn, cartaoMotivosChurn: cartaoMotivosChurn, dicaEmails: dicaEmails, linhasAtend: linhasAtend, abrirFichaAnual: abrirFichaAnual, abrirFichaGrupo: abrirFichaGrupo, motivosRever: motivosRever, mapaHonAnual: mapaHonAnual, regimeMudou: regimeMudou, semDadoFat: semDadoFat, resumoQ: resumoQ, chipOcorrenciaQ: chipOcorrenciaQ, listaRegistrosQ: listaRegistrosQ, formularioQ: formularioQ, formularioQAntigo: formularioQAntigo, listaRegistrosQAntigo: listaRegistrosQAntigo, celTerm: celTerm, comoPesaTratativa: comoPesaTratativa }');
  C.t.estado.dados = {
    clientes: [
      { id: '1', nome: 'ALFA LTDA', cnpj: '11.222.333/0001-81', grupo: 'Grupo A', tipo_doc: 'CNPJ', categoria: 'Ouro', categoria_motivo: 'honorário R$ 800,00 (faixa R$ 500 a 999)', honorario: 800, regime: 'Lucro Presumido', questor: { faturamento: 120000.5, funcionarios: 3, aviso: null }, risco: risco('Alto', 70, { financeiro: 90, atendimento: 10, operacional: null, tratativas: 75 }, { motivos: ['Inadimplente: 3 títulos', 'Nota baixa'] }) },
      { id: '2', nome: 'ALFA FILIAL LTDA', cnpj: '11.222.333/0002-62', grupo: 'Grupo A', tipo_doc: 'CNPJ', categoria: 'Ouro', categoria_motivo: 'soma do grupo "Grupo A", 2 empresas: R$ 1.300,00 (faixa R$ 1.000 a 1.999)', honorario: 500, regime: null, questor: { faturamento: 0, funcionarios: 0, aviso: 'Natureza sem configuração' }, risco: risco('Baixo', 5, { financeiro: 0, atendimento: 0, operacional: null, tratativas: null }) },
      { id: '3', nome: 'GAMA LTDA', cnpj: '77.888.999/0001-33', grupo: null, tipo_doc: 'CNPJ', categoria: null, categoria_motivo: null, honorario: null, regime: 'Simples Nacional', questor: null, risco: risco('Suspenso', null, { financeiro: null, atendimento: null, operacional: null }, { suspenso: true }) },
    ],
    clientes_outros: [{ id: '9', nome: 'JOAO DA SILVA', cnpj: '123.456.789-09', tipo_doc: 'CPF', grupo: null, categoria: null, honorario: 100, regime: null, questor: null }],
    totais: { clientes: 3, risco: { Alto: 1, 'Médio': 0, Baixo: 1, Suspenso: 1, Incompleto: 0 }, suspensos: 1, sem_reclamacao_30d: 3, categorias: { Diamante: 0, Ouro: 2, Prata: 0, Bronze: 0, sem_categoria: 1 },
      termometros: { financeiro: { com_dado: 2, em_alerta: 1, medio_ou_mais: 1 }, atendimento: { com_dado: 2, em_alerta: 0, medio_ou_mais: 0 }, operacional: { com_dado: 0, em_alerta: 0, medio_ou_mais: 0 }, tratativas: { com_dado: 1, sem_dado: 1, em_alerta: 1, medio_ou_mais: 1 } } },
    churn: { periodos: { ultimos_12_meses: { ini: '2025-10-01', fim: '2026-10-13', base: 10, saidas_contadas: 1, taxa: 10, taxa_teto: 12, menos_de_90_dias: 0, fora_do_churn: { a_confirmar: 0, baixas: 0, outras_saidas: 0 },
      saidas: [{ nome: 'SAIU LTDA', cnpj: '10.000.000/0001-00', data_entrada: '2024-01-01', data_saida: '2026-05-01', tipo: 'transferida', origem: 'acessorias', na_base: true }, { nome: 'NOVA LTDA', cnpj: '20.000.000/0001-00', data_entrada: '2026-02-01', data_saida: '2026-04-01', tipo: 'baixa', origem: 'receita', na_base: false }] } }, padroes: [], evolucao: [] },
    config: { cortes: { medio: 30, alto: 60 }, pesos: { financeiro: 1, atendimento: 1, operacional: 1, tratativas: 1 } }, usuario: { papel: 'administrador' },
  };
  await teste('cs: todas as seções geram colunas e linhas coerentes', () => {
    C.t.estado.filtroRisco.nivel = 'todos';
    for (const sec of ['visao', 'analise', 'risco', 'churn', 'categorias']) {
      const e = C.t.dadosExport(sec);
      assert.ok(e && e.colunas.length && e.linhas.length, sec + ' vazio');
      semLixo(e, 'cs/' + sec);
    }
    assert.strictEqual(C.t.dadosExport('qualidade'), null);
  });
  await teste('cs: risco e visão geral exportam o 4º critério (Tratativas); sem pendência fica em branco', () => {
    C.t.estado.filtroRisco.nivel = 'todos';
    const r = C.t.dadosExport('risco');
    assert.ok(r.colunas.includes('Tratativas'));
    const i = r.colunas.indexOf('Tratativas');
    assert.strictEqual(r.linhas.find((l) => l[0] === 'ALFA LTDA')[i], 75);
    assert.strictEqual(r.linhas.find((l) => l[0] === 'ALFA FILIAL LTDA')[i], '');
    assert.ok(C.t.dadosExport('visao').linhas.some((l) => String(l[0]).includes('Termômetro Tratativas')));
    assert.ok(C.t.celTerm(C.t.estado.dados.clientes[1], 'tratativas').includes('—'), 'sem pendência não vira "sem dado"');
  });
  await teste('cs: ficha — plano de ação mostra só o mais recente (anteriores recolhidos), com "Responsável", e ignora o que veio do módulo', () => {
    const reg = (id, em, origem, detalhe) => ({ id, origem, tipo: 'Erro', departamentos: ['Fiscal'], detalhe, analista_nome: 'Josiane', criado_em: em, criado_por: 'Larissa', prazo: '2026-10-20', situacao: 'aberto', status: 'aberto', notas: [] });
    const h = C.t.listaRegistrosQ([reg('a', '2026-10-10T12:00:00Z', 'ficha', 'plano antigo'), reg('b', '2026-10-16T12:00:00Z', 'ficha', 'plano novo'), reg('c', '2026-10-17T12:00:00Z', 'modulo', 'ocorrência do módulo')]);
    assert.ok(h.includes('plano novo') && h.includes('<details class="qa-mais">') && h.includes('1 registro anterior') && h.includes('plano antigo'));
    assert.ok(h.indexOf('plano novo') < h.indexOf('<details'), 'o mais recente fica fora da seta');
    assert.ok(h.indexOf('plano antigo') > h.indexOf('<details'), 'o anterior fica dentro da seta');
    assert.ok(!h.includes('ocorrência do módulo'), 'o que veio do módulo Qualidade não é plano de ação');
    assert.ok(h.includes('Responsável:') && !h.includes('Analista:'));
    assert.ok(!C.t.listaRegistrosQ([reg('d', '2026-10-17T12:00:00Z', 'ficha', 'só um')]).includes('<details'), 'com um só registro não há seta');
    assert.ok(C.t.listaRegistrosQ([]).includes('Nenhum plano de ação'));
    assert.ok(C.t.listaRegistrosQAntigo([reg('a', '2026-10-10T12:00:00Z', 'ficha', 'x')]).includes('Analista:'), 'o layout antigo continua guardado');
  });
  await teste('cs: ficha — formulário novo (Descreva a tratativa + Responsável + Prazo) e Sinais de atenção com resumo da ocorrência', () => {
    const o = { tipos: ['Erro', 'Multa'], departamentos: ['Fiscal', 'Contábil'], max_detalhe: 600 };
    const f = C.t.formularioQ(o);
    assert.ok(f.includes('Descreva a tratativa:') && f.includes('Responsável') && !f.includes('Descreva a ocorrência') && !f.includes('>Analista'));
    assert.ok(f.includes('class="qa-grade"') && f.indexOf('id="qa-detalhe"') < f.indexOf('id="qa-analista"') && f.indexOf('id="qa-analista"') < f.indexOf('id="qa-prazo"'));
    assert.ok(f.indexOf('Departamentos envolvidos') < f.indexOf('Descreva a tratativa:'));
    assert.ok(f.includes('não entra no card Tratativa nem no risco'));
    assert.ok(!f.includes('Tipo de registro') && !f.includes('id="qa-tipo"') && !f.includes('qa-editar-tipos'), 'a ficha não pede mais o tipo de registro');
    assert.ok(f.includes('Departamentos envolvidos'));
    assert.ok(C.t.formularioQAntigo(o).includes('Descreva a ocorrência'), 'o layout antigo continua guardado');
    assert.strictEqual(C.t.resumoQ('apuração   do imposto com valor divergente'), 'apuração do imposto com valor divergente');
    const longo = 'Erro na apuração do imposto da competência de setembro: valor do ISS calculado sobre a base errada e guia enviada ao cliente sem conferência.';
    const r = C.t.resumoQ(longo);
    assert.ok(r.length <= 91 && r.endsWith('…') && !r.includes('  '), r);
    const chip = C.t.chipOcorrenciaQ({ tipo: 'Erro', departamentos: ['Fiscal'], detalhe: longo, criado_em: '2026-10-16T12:00:00Z', prazo: '2026-10-20', situacao: 'vencido', analista_nome: 'Josiane' });
    assert.ok(chip.includes('<strong>Erro</strong>') && chip.includes('Fiscal') && chip.includes('apuração do imposto') && chip.includes('Vencido') && chip.includes('title='));
  });
  await teste('cs: quadro "Como a Tratativa pesa" mostra o peso de cada tipo (dobro) e o que não conta', () => {
    const h = C.t.comoPesaTratativa([{ nome: 'Multa', peso: 25 }, { nome: 'Erro', peso: 15 }]);
    assert.ok(h.includes('só administradores') && h.includes('Como a Tratativa pesa'));
    assert.ok(h.includes('<td>Multa</td><td class="c">25</td><td class="c"><strong>50</strong></td>') && h.includes('<td>Erro</td><td class="c">15</td><td class="c"><strong>30</strong></td>'));
    assert.ok(h.includes('1,5') && h.includes('0,25') && h.includes('não conta') && h.includes('mais de 45 dias'));
    assert.ok(C.t.comoPesaTratativa([]).includes('Nenhum tipo ativo'));
  });
  await teste('cs: análise traz o grupo consolidado e cada empresa; zero vira "sem faturamento"; CPF aparece', () => {
    const e = C.t.dadosExport('analise');
    const nomes = e.linhas.map((l) => l[1].trim());
    assert.ok(nomes.includes('GRUPO GRUPO A') && nomes.includes('ALFA LTDA') && nomes.includes('ALFA FILIAL LTDA') && nomes.includes('JOAO DA SILVA'));
    const grupo = e.linhas.find((l) => l[0] === 'Grupo');
    assert.deepStrictEqual([grupo[6], grupo[7], grupo[8]], [3, 1300, 120000.5]);
    assert.strictEqual(grupo[4], 'Ouro');                                                  // a linha do grupo traz a categoria das empresas
    assert.strictEqual(e.linhas.find((l) => l[1].trim() === 'ALFA FILIAL LTDA')[8], 'sem faturamento');
    assert.strictEqual(e.linhas.find((l) => l[1].trim() === 'ALFA FILIAL LTDA')[11], 'Natureza sem configuração de faturamento no Questor');
    assert.strictEqual(e.linhas.find((l) => l[1] === 'JOAO DA SILVA')[3], 'CPF');
  });
  await teste('cs: honorário sugerido = percentual × faturamento médio mensal; análise verde, amarela e vermelha', () => {
    C.t.estado.honorario = { percentual: 0.5, limite_amarelo: 80, pode_editar: true };
    assert.strictEqual(C.t.honSugerido(120000), 50);            // 120.000 ÷ 12 = 10.000 × 0,5% = 50
    assert.strictEqual(C.t.honSugerido(null), null);
    assert.strictEqual(C.t.honSugerido(0), null);
    assert.strictEqual(C.t.honAnalise(50, 50), 'ok');
    assert.strictEqual(C.t.honAnalise(80, 50), 'ok');
    assert.strictEqual(C.t.honAnalise(45, 50), 'medio');         // 90% do sugerido
    assert.strictEqual(C.t.honAnalise(40, 50), 'medio');         // exatamente 80%
    assert.strictEqual(C.t.honAnalise(39, 50), 'baixo');
    assert.strictEqual(C.t.honAnalise(0, 50), 'baixo');
    assert.strictEqual(C.t.honAnalise(null, 50), null);
    C.t.estado.honorario = { percentual: null, limite_amarelo: 80 };
    assert.strictEqual(C.t.honSugerido(120000), null);          // sem percentual definido
    C.t.estado.honorario = { percentual: 0.5, limite_amarelo: 80, pode_editar: true };
    const cel = C.t.celSugerido(12000000, 800);                  // 1.000.000 × 0,5% = 5.000
    const celTxt = cel.split(String.fromCharCode(160)).join(' ');
    assert.ok(celTxt.includes('R$ 5.000,00') && celTxt.includes('diferença −R$ 4.200,00'), 'tooltip com a diferença: ' + cel);
    assert.ok(C.t.celAnalise(12000000, 800).includes('an-baixo'));
    assert.ok(C.t.celAnalise(12000000, 5000).includes('an-ok'));
    C.t.estado.ocultar = true;
    assert.ok(!/5[.]000|4[.]200/.test(C.t.celSugerido(12000000, 800)), 'valores ocultos vazaram na coluna nova');
    assert.ok(!C.t.celAnalise(12000000, 800).includes('an-'), 'o símbolo revelaria a relação com os valores ocultos');
    C.t.estado.ocultar = false;
    C.t.estado.honorario = null;
  });
  await teste('cs: análise anual — faturamento e funcionários, regra "ambos", regime por ano, só ativos e exportação', () => {
    const E = C.t.estado;
    const a = (ano, fat, fun, regime) => ({ ano, faturamento: fat, meses: 12, funcionarios: fun, regime });
    E.anual = {
      valores_ocultos: false, ate: '2026-08', ano_inicial: 2023, config: { percentual: 30, pode_editar: true },
      itens: [
        { cnpj: '11222333000181', anos: [a(2023, 1000, 10, 'Simples Nacional'), a(2024, 1000, 10, 'Simples Nacional'), a(2025, 1400, 14, 'Lucro Presumido'), { ano: 2026, faturamento: 900, meses: 8, funcionarios: 15 }] },   // +40% fat, +40% func, mudou de regime
        { cnpj: '11222333000262', anos: [a(2024, 1000, 10, 'Simples Nacional'), a(2025, 1250, 13, 'Simples Nacional')] },                                                                                              // +25% (abaixo do limite)
        { cnpj: '77888999000133', anos: [a(2024, 1000, null, null), a(2025, 1500, null, null)] },                                                                                                                   // +50% fat, sem folha
        { cnpj: '99999999000199', anos: [a(2024, 100, 1, null), a(2025, 900, 9, null)] },                                                                                                                           // não está na lista de ativos
      ],
    };
    E.filtroAnual = { busca: '', ano: null, soDestaque: false, regra: 'ambos', ordem: 'alta', pag: 1 };
    // fontes diferentes não geram mudança falsa: 'Lucro (Presumido/Real)' (sem detalhe) contra um regime específico não conta
    assert.strictEqual(C.t.regimeMudou('Lucro Presumido', 'Lucro (Presumido/Real)'), false);
    assert.strictEqual(C.t.regimeMudou('Lucro (Presumido/Real)', 'Lucro Presumido'), false);
    assert.strictEqual(C.t.regimeMudou('Simples Nacional', 'Lucro (Presumido/Real)'), true);
    assert.strictEqual(C.t.regimeMudou('Simples Nacional', 'Lucro Presumido'), true);
    assert.strictEqual(C.t.regimeMudou('Lucro Presumido', 'Lucro Real'), true);
    assert.strictEqual(C.t.regimeMudou('Lucro Real', 'Lucro Real'), false);
    assert.strictEqual(C.t.regimeMudou(null, 'Lucro Real'), false);
    assert.deepStrictEqual([...C.t.anosAnual().completos], [2024, 2025]);                  // 2026 é parcial (8 meses) e fica de fora
    // cliente sem faturamento usado: "sem dado" com o aviso ao passar o mouse (total do relatório não fecha com a soma dos meses)
    const semAviso = C.t.semDadoFat({ 2025: { faturamento: null } }, 2025);
    const comAviso = C.t.semDadoFat({ 2025: { faturamento: null, aviso: 'Faturamento não usado: o total do relatório do Questor (R$ 1,00) não fecha com a soma dos meses (R$ 2,00)' } }, 2025);
    assert.ok(!/title=/.test(semAviso) && /sem dado/.test(semAviso));
    assert.ok(/title="[^"]*não fecha com a soma dos meses/.test(comAviso));
    assert.strictEqual(C.t.varPct(1000, 1400), 40);
    assert.strictEqual(C.t.varPct(0, 500), null);
    const r = C.t.linhasAnual();
    assert.strictEqual(r.ano, 2025);
    assert.strictEqual(r.linhas.length, 4);                                                // 3 CNPJ + 1 CPF da lista; o 99999999000199 não aparece
    assert.strictEqual(r.linhas[0].c.nome, 'GAMA LTDA');                                   // maior alta de faturamento primeiro (+50%)
    assert.strictEqual(r.subiram, 2);                                                      // "ambos": ALFA (fat +40% e func +40%) e GAMA (+50%, sem folha: decide o faturamento)
    assert.strictEqual(r.mudaram, 1);
    const alfa = r.linhas.find((l) => l.c.nome === 'ALFA LTDA');
    assert.deepStrictEqual([alfa.fp, alfa.fc, alfa.vf, alfa.rp, alfa.rc, alfa.mudouRegime], [10, 14, 40, 'Simples Nacional', 'Lucro Presumido', true]);
    // honorário por ano vindo do Omie fica à parte do faturamento
    E.anual.itens[0].honorarios = [{ ano: 2024, total: 4000, meses: 12, mensal: 330 }, { ano: 2025, total: 5000, meses: 12, mensal: 420 }];
    assert.strictEqual(C.t.mapaHonAnual()['11222333000181'][2025].mensal, 420);
    assert.deepStrictEqual({ ...C.t.mapaHonAnual()['11222333000262'] }, {});
    // cruzamento com o honorário do Omie: ALFA (+40% fat, +40% func) cobrava 330 em 2024 e 420 em 2025 (+27%): reajustado
    const alfaH = C.t.linhasAnual().linhas.find((l) => l.c.nome === 'ALFA LTDA');
    assert.deepStrictEqual([alfaH.hp, alfaH.hc, alfaH.hcAno, Math.round(alfaH.vh)], [330, 420, 2025, 27]);
    assert.strictEqual(C.t.reajusteLinha(alfaH), 'sim');
    assert.strictEqual(C.t.reajusteLinha({ ...alfaH, hc: 335, vh: 1.5 }), 'nao');                  // destaque, mas o honorário quase não mexeu
    assert.strictEqual(C.t.reajusteLinha({ ...alfaH, hp: null, vh: null }), 'sem-dado');            // sem os dois valores no Omie
    assert.strictEqual(C.t.reajusteLinha({ v: 5, vf: 0, mudouRegime: false, vh: 1 }), null);        // não é destaque: sem situação
    assert.doesNotThrow(() => C.t.abrirFichaAnual('11222333000181'));                              // ficha com o bloco do honorário do Omie
    assert.doesNotThrow(() => C.t.abrirFichaAnual('77888999000133'));                              // sem honorário no Omie
    // corte do "sem reajuste" editável: com 30%, +27% passa a contar como sem reajuste; sem valor salvo vale o padrão de 5%
    E.anual.config.reajuste_min = 30;
    assert.strictEqual(C.t.reajusteLinha(C.t.linhasAnual().linhas.find((l) => l.c.nome === 'ALFA LTDA')), 'nao');
    delete E.anual.config.reajuste_min;
    assert.strictEqual(C.t.reajusteLinha(C.t.linhasAnual().linhas.find((l) => l.c.nome === 'ALFA LTDA')), 'sim');
    // mudança de regime dispara 'Rever honorário' mesmo sem alta de faturamento/funcionários, em qualquer regra
    const semAlta = { v: 5, vf: 0, rp: 'Simples Nacional', rc: 'Lucro Presumido', mudouRegime: true };
    ['ambos', 'fat', 'func', 'ou'].forEach((rg) => assert.strictEqual(C.t.destaqueLinha(semAlta, rg), true, rg));
    assert.strictEqual(C.t.destaqueLinha({ v: 5, vf: 0, mudouRegime: false }, 'ou'), false);
    assert.deepStrictEqual([...C.t.motivosRever(semAlta)], ['mudou de regime (Simples Nacional → Lucro Presumido)']);
    assert.deepStrictEqual([...C.t.motivosRever(alfa)], ['faturamento +40%', 'funcionários +40%', 'mudou de regime (Simples Nacional → Lucro Presumido)']);
    E.filtroAnual.regra = 'fat';
    assert.strictEqual(C.t.linhasAnual().subiram, 2);                                      // ALFA e GAMA
    E.filtroAnual.tipo = 'CPF';
    assert.deepStrictEqual(C.t.linhasAnual().linhas.map((l) => l.c.nome), ['JOAO DA SILVA']);   // filtro Documento
    assert.deepStrictEqual({ ...C.t.linhasAnual().contTipo }, { CNPJ: 3, CPF: 1, CAEPF: 0, CNO: 0 });
    E.filtroAnual.tipo = '';
    E.filtroAnual.regra = 'ou';
    assert.strictEqual(C.t.linhasAnual().subiram, 3);                                      // ALFA, ALFA FILIAL (func +30%) e GAMA (fat +50%)
    E.filtroAnual.regra = 'func';
    assert.strictEqual(C.t.linhasAnual().subiram, 2);                                      // ALFA (+40%) e ALFA FILIAL (+30%, exatamente no limite)
    E.filtroAnual.regra = 'ambos';
    E.filtroAnual.soDestaque = true;
    assert.deepStrictEqual(C.t.linhasAnual().linhas.map((l) => l.c.nome), ['GAMA LTDA', 'ALFA LTDA']);
    E.filtroAnual.soDestaque = false;
    E.filtroAnual.ordem = 'alfa';                                                          // ordem alfabética (padrão da tela)
    assert.deepStrictEqual(C.t.linhasAnual().linhas.map((l) => l.c.nome), ['ALFA FILIAL LTDA', 'ALFA LTDA', 'GAMA LTDA', 'JOAO DA SILVA']);
    E.filtroAnual.ordem = 'alta';
    const x = C.t.dadosExport('anual');
    semLixo(x, 'cs/anual');
    const lin = x.linhas.find((l) => l[0] === 'ALFA LTDA');
    assert.deepStrictEqual([lin[3], lin[4], lin[5], lin[6], lin[7], lin[8], lin[9], lin[10], lin[11]], ['Simples Nacional', 'Lucro Presumido', 1000, 1400, 40, 10, 14, 40, 'Sim']);
    assert.strictEqual(x.linhas.find((l) => l[0] === 'GAMA LTDA')[11], 'Sim');             // sem folha: decide o faturamento (+50%)
    assert.strictEqual(x.linhas.find((l) => l[0] === 'ALFA FILIAL LTDA')[11], '');         // fat +25%: abaixo do limite
    E.ocultar = true;
    assert.ok(C.t.dadosExport('anual').linhas.every((l) => l[5] === 'oculto' || l[5] === 'sem dado'), 'valores ocultos vazaram na análise anual');
    E.ocultar = false;
    E.anual = null;
  });
  await teste('cs: módulo Atendimento — lista, dica de e-mails por destinatário, filtro e exportação', () => {
    const E = C.t.estado;
    E.atend = { janela_dias: 180, email_lido_em: '2026-10-12T11:00:00Z', email_janela_dias: 180, clientes: [
      { id: '2', nome: 'BETA LTDA', cnpj: '22.333.444/0001-55', categoria: 'Prata', atendimentos: 4, sla_vermelho: 1, notas_baixas: 0, ultimo: '2026-10-10',
        email: { recebidos: 9, sem_resposta: 2, destinatarios: [{ nome: 'dptofiscal@escritorial.com.br', grupo: true, recebidos: 5, sem: 2 }, { nome: 'Guilherme', grupo: false, recebidos: 4, sem: 0 }] } },
      { id: '1', nome: 'ALFA LTDA', cnpj: '11.222.333/0001-81', categoria: 'Ouro', atendimentos: 12, sla_vermelho: 0, notas_baixas: 1, ultimo: '2026-10-14', email: null },
    ] };
    E.filtroAtend = { busca: '', soSem: false, pag: 1 };
    assert.deepStrictEqual(C.t.linhasAtend().map((l) => l.nome), ['ALFA LTDA', 'BETA LTDA']);               // ordem alfabética
    E.filtroAtend.soSem = true;
    assert.deepStrictEqual(C.t.linhasAtend().map((l) => l.nome), ['BETA LTDA']);                              // só com e-mail sem resposta
    E.filtroAtend.soSem = false;
    const dica = C.t.dicaEmails(E.atend.clientes[0].email);
    assert.ok(dica.includes('• dptofiscal@escritorial.com.br (grupo): 5') && dica.includes('• Guilherme: 4'), dica);
    assert.ok(dica.includes('Sem resposta:\n• dptofiscal@escritorial.com.br: 2 (grupo do escritório: pode ter sido respondido por outro e-mail)'), dica);
    assert.ok(!/Guilherme: 0/.test(dica));
    assert.ok(/sem resposta/i.test(C.t.dicaEmails(null)) || /Sem e-mails/.test(C.t.dicaEmails(null)));
    assert.doesNotThrow(() => C.t.desenharAtendimento());
    const x = C.t.dadosExport('atendimento');
    semLixo(x, 'cs/atendimento');
    assert.deepStrictEqual(x.linhas.map((l) => [l[0], l[3], l[7], l[8]]), [['ALFA LTDA', 12, '', ''], ['BETA LTDA', 4, 9, 2]]);
    assert.strictEqual(x.linhas[1][9], 'dptofiscal@escritorial.com.br: 2');
  });
  await teste('cs: churn por motivo — motivo efetivo, seleção e cartão com sem motivo', () => {
    const E = C.t.estado;
    E.motivosChurn = [{ id: '1', nome: 'Churn por experiência técnica' }, { id: '2', nome: 'Churn motivado por decisão pessoal' }];
    E.dados.usuario = { nome: 'Teste', papel: 'administrador' };
    assert.strictEqual(C.t.motivoDaSaida({ motivo_churn: 'Churn por experiência técnica' }), 'Churn por experiência técnica');
    assert.strictEqual(C.t.motivoDaSaida({ motivo_saida: 'churn motivado por decisao pessoal' }), 'Churn motivado por decisão pessoal');
    assert.strictEqual(C.t.motivoDaSaida({ motivo_saida: 'Baixa de empresa' }), null);
    assert.ok(/<select class="gp-select q-motivo" data-id="x1"/.test(C.t.selectMotivoChurn({ id: 'x1', motivo_churn: null })));
    const html = C.t.cartaoMotivosChurn([
      { id: 'a', tipo: 'transferida', na_base: true, motivo_churn: 'Churn por experiência técnica' },
      { id: 'b', tipo: 'transferida', na_base: true, motivo_churn: null },
      { id: 'c', tipo: 'baixa', na_base: true, motivo_churn: 'Churn por experiência técnica' },     // baixa não conta
    ]);
    assert.ok(html.includes('2 saída(s) que contam') && html.includes('1 sem motivo classificado'), html.slice(0, 400));
    E.dados.usuario = { nome: 'Teste', papel: 'colaborador' };
    assert.ok(!/<select/.test(C.t.selectMotivoChurn({ id: 'x1', motivo_churn: 'Churn por experiência técnica' })));   // sem permissão: só texto
  });
  await teste('cs: risco e churn trazem os campos certos', () => {
    const r = C.t.dadosExport('risco');
    const alfa = r.linhas.find((l) => l[0] === 'ALFA LTDA');
    assert.deepStrictEqual([alfa[3], alfa[4], alfa[5], alfa[7], alfa[8], alfa[11]], ['Alto', 70, 90, 'sem dado', 75, 'Inadimplente: 3 títulos | Nota baixa']);
    assert.strictEqual(r.linhas.find((l) => l[0] === 'GAMA LTDA')[9], 'Sim');
    const c = C.t.dadosExport('churn');
    assert.strictEqual(c.linhas.length, 2);
    assert.deepStrictEqual([...c.linhas[0].slice(2, 6)], ['01/01/2024', '01/05/2026', 'Transferida', 'Sim']);
  });
  await teste('cs: valores ocultos (perfil Usuário ou botão) não vazam honorário, faturamento nem motivo da categoria', () => {
    C.t.estado.ocultar = true;
    for (const sec of ['analise', 'risco', 'categorias']) {
      const txt = JSON.stringify(C.t.dadosExport(sec).linhas);
      assert.ok(!/\b(800|1300|1\.300|120000)/.test(txt), sec + ' vazou: ' + txt.slice(0, 200));   // 500 e 999 são limites de faixa, não valores do cliente
    }
    C.t.estado.ocultar = false;
    C.t.estado.dados.valores_ocultos = true;                       // perfil Usuário: o servidor já mascarou
    assert.ok(C.t.dadosExport('analise').linhas.every((l) => l[7] === 'oculto' || l[7] === ''));
    assert.ok(C.t.dadosExport('analise').linhas.every((l) => l[9] === 'oculto' || l[9] === ''), 'honorário sugerido vazou');
    C.t.estado.dados.valores_ocultos = false;
  });

  // ── exportador (CSV) ──
  let ultimo = null;
  const E = carregar('exportar.js', '{ Exportar: window.Exportar }');
  E.ctx.document.createElement = () => ({ click() { ultimo.clicou = true; }, set href(v) {}, set download(v) { ultimo.nome = v; }, style: {} });
  E.ctx.document.body = { appendChild() {}, removeChild() {} };
  E.ctx.URL = { createObjectURL: (b) => { ultimo = { blob: b }; return 'blob:x'; }, revokeObjectURL() {} };
  await teste('csv: BOM, separador ";", vírgula decimal, aspas e proteção contra fórmula', async () => {
    E.win.Exportar.csv('teste', ['Nome', 'Valor', 'Obs'], [['BETA; "ASPAS" LTDA', 1234.5, '=SOMA(A1)'], ['Linha\ncom quebra', null, 'ok']]);
    assert.ok(/^teste-\d{4}-\d{2}-\d{2}\.csv$/.test(ultimo.nome), ultimo.nome);
    const txt = Buffer.from(await ultimo.blob.arrayBuffer()).toString('utf8');
    assert.strictEqual(txt.charCodeAt(0), 0xfeff);
    const linhas = txt.slice(1).split('\r\n');
    assert.strictEqual(linhas[0], 'Nome;Valor;Obs');
    assert.strictEqual(linhas[1], '"BETA; ""ASPAS"" LTDA";1234,5;\'=SOMA(A1)');
    assert.strictEqual(linhas[2], 'Linha com quebra;;ok');
  });

  console.log(`\n${ok} testes passaram.`);
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e); process.exit(1); });
