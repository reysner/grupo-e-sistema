'use strict';

/**
 * Importa pro Grupo-E o que foi lido da grade do Omie (ver paginaContasReceber.js). Formato COMPACTO (uma linha por cliente):
 *   hon.txt    → CNPJ|valor|AAMM     (honorário atual e o mês em que passou a valer, ex.: 45297664000100|3524.4|2603)
 *   aberto.txt → CNPJ|qtd|aberto|atrasado|qtdAtrasados|AAMMDD  (só honorário em aberto; AAMMDD = vencimento mais antigo em atraso)
 *   nomes.txt  → CNPJ|nome|AAMM      (opcional; nome e 1º mês SÓ dos clientes que não existem na Carteira)
 *   titulos.txt → rec|CNPJ|AAMMDD|aberto|valorDoc|A/P/V  (opcional; cada honorário em aberto — alimenta a página /financeiro)
 *   pontual.txt → CNPJ|pagos|mediaDias|maxDias           (opcional; atraso médio de quem pagou nos últimos 7 meses)
 * O que faz:
 *   1) Gestão de Clientes (POST /gestao/honorarios-omie): preenche honorário que falta; cria cliente "Não há cadastro no Acessórias";
 *      honorário DIFERENTE do cadastrado só é trocado com --diferentes (por padrão só relata).
 *   2) módulo Financeiro (POST /financeiro/importar): snapshot da unidade (honorário atual + em aberto/atrasado).
 * Se houver cliente sem cadastro e sem nome no nomes.txt, NÃO grava nada e imprime "NOMES_NECESSARIOS: cnpj1,cnpj2,..." (saída 3):
 * pegue os nomes na página (window.__nomes([...])), grave em nomes.txt e rode de novo.
 * Uso: node server/omie/importarOmie.js --unidade="Soluções Escritorial" --hon=hon.txt --aberto=aberto.txt [--nomes=nomes.txt] [--titulos=titulos.txt --pontual=pontual.txt] [--diferentes] [--simular]
 * Segredos: server/legalizacao/.env (APP_URL e o token de sincronização) — nunca imprimir.
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'legalizacao', '.env') });

const arg = (n) => { const a = process.argv.find((x) => x.startsWith('--' + n + '=')); return a ? a.slice(n.length + 3) : null; };
const flag = (n) => process.argv.includes('--' + n);
const unidade = arg('unidade'); const fHon = arg('hon'); const fAberto = arg('aberto'); const fNomes = arg('nomes'); const fTitulos = arg('titulos'); const fPontual = arg('pontual');
if (!unidade || !fHon || !fAberto) { console.error('Uso: --unidade="..." --hon=arquivo --aberto=arquivo [--nomes=arquivo] [--diferentes] [--simular]'); process.exit(1); }
const APP_URL = (process.env.APP_URL || '').replace(/\/$/, '');
const TOKEN = process.env.LEGALIZACAO_SYNC_TOKEN || process.env.CERTISEGURO_SYNC_TOKEN;
const ler = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : []);
const mes = (a) => (/^\d{4}$/.test(a || '') ? `20${a.slice(0, 2)}-${a.slice(2)}` : null);
const dia = (a) => (/^\d{6}$/.test(a || '') ? `20${a.slice(0, 2)}-${a.slice(2, 4)}-${a.slice(4)}` : null);

async function post(rota, corpo) {
  const r = await fetch(APP_URL + (rota.startsWith('/') ? rota : '/api/data/' + rota), { method: 'POST', headers: { 'X-Sync-Token': TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(corpo), signal: AbortSignal.timeout(600000) }); // 10 min: a Escritorial já passou de 180 s (13/10/2026: 187 s)
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${rota}: ${r.status} ${j.error || ''}`);
  return j;
}

(async () => {
  const nomes = new Map(ler(fNomes || '').map((l) => { const [c, n, m] = l.split('|'); return [c, { nome: n, desde: mes(m) }]; }));
  const clientes = ler(fHon).map((l) => { const [cnpj, valor, m] = l.split('|'); const n = nomes.get(cnpj); return { cnpj, valor: parseFloat(valor), vigencia: mes(m), mes: mes(m), desde: n && n.desde ? n.desde : mes(m), nome: n ? n.nome : '' }; });
  const abertos = ler(fAberto).map((l) => { const [cnpj, qtd, aberto, atrasado, nat, velho] = l.split('|'); const n = nomes.get(cnpj); return { cnpj, nome: n ? n.nome : '', qtd: +qtd, aberto: +aberto, atrasado: +atrasado, qtdAtrasados: +nat, maisAntigo: dia(velho) }; });
  if (clientes.length < 5) throw new Error('Poucos clientes na lista (' + clientes.length + ') — leitura suspeita, nada foi importado.');
  console.log(`${unidade}: ${clientes.length} cliente(s) com honorário, ${abertos.length} com valor em aberto.`);
  if (flag('simular')) { console.log('(simulação — nada enviado)'); return; }

  // 1) quem não existe na Carteira precisa de nome (pra criar o cadastro "Não há cadastro no Acessórias")
  const simulacao = await post('gestao/honorarios-omie', { itens: clientes, aplicar: false });
  const semNome = simulacao.semCadastro.filter((x) => !nomes.get(x.doc)).map((x) => x.doc);
  if (semNome.length) { console.log('NOMES_NECESSARIOS: ' + semNome.join(',')); process.exit(3); }

  const g = await post('gestao/honorarios-omie', { itens: clientes, aplicar: true, aplicarDiferentes: flag('diferentes') });
  console.log('Gestão de Clientes:', JSON.stringify(g.contagem));
  console.log('Financeiro:', JSON.stringify(await post('financeiro/importar', { unidade, fonte: 'Omie (Contas a Receber) — rotina diária', clientes, abertos })));
  // /financeiro: títulos em aberto e pontualidade (só se os arquivos vieram). Não derruba a rotina se falhar: o resto já foi gravado.
  if (fTitulos) {
    const diaV = (a) => (/^\d{6}$/.test(a || '') ? `20${a.slice(0, 2)}-${a.slice(2, 4)}-${a.slice(4)}` : null);
    const titulos = ler(fTitulos).map((l) => { const [rec, cnpj, venc, aberto, doc, sit] = l.split('|'); return { rec, cnpj, venc: diaV(venc), aberto: +aberto, doc: +doc, sit }; }).filter((t) => t.rec && t.venc);
    const pontualidade = ler(fPontual || '').map((l) => { const [cnpj, pagos, media, max] = l.split('|'); return { cnpj, pagos: +pagos, media: +media, max: +max }; });
    if (!titulos.length && abertos.length) console.log('Títulos: arquivo vazio apesar de haver clientes em aberto — NÃO enviado ao /financeiro (leitura suspeita).');
    else { try { console.log('Financeiro (títulos):', JSON.stringify(await post('/api/financeiro/titulos', { unidade, titulos, pontualidade }))); } catch (e) { console.log('Títulos NÃO enviados ao /financeiro:', e.message); } }
  }
  if (g.diferente.length) console.log('Honorário DIFERENTE do cadastrado' + (flag('diferentes') ? ' (atualizado)' : ' (NÃO alterado)') + ':\n  ' + g.diferente.map((x) => `${x.nome}: cadastrado ${x.atual} → Omie ${x.valor}`).join('\n  '));
  if (g.semCadastro.length) console.log('Criados sem cadastro no Acessórias:', g.semCadastro.map((x) => x.nome).join('; '));
  if (g.inativoNaCarteira.length) console.log('Faturando no Omie mas encerrados na Carteira:', g.inativoNaCarteira.map((x) => x.carteira).join('; '));
})().catch((e) => { console.error('Falhou:', e.message); process.exit(1); });
