'use strict';

/**
 * Importa pro Grupo-E o que foi lido da grade do Omie (ver paginaContasReceber.js):
 *   1) módulo Financeiro (POST /financeiro/importar — snapshot da unidade: honorário atual + em aberto/atrasado);
 *   2) Gestão de Clientes (POST /gestao/honorarios-omie) — preenche honorário que falta e cria cliente "Não há cadastro no Acessórias";
 *      honorário DIFERENTE do cadastrado só é trocado com --diferentes (por padrão só relata).
 * Uso: node server/omie/importarOmie.js --unidade="Soluções Escritorial" --hon=hon.txt --aberto=aberto.txt [--diferentes] [--simular]
 * Segredos: server/legalizacao/.env (APP_URL e o token de sincronização) — nunca imprimir.
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'legalizacao', '.env') });

const arg = (n) => { const a = process.argv.find((x) => x.startsWith('--' + n + '=')); return a ? a.slice(n.length + 3) : null; };
const flag = (n) => process.argv.includes('--' + n);
const unidade = arg('unidade'); const fHon = arg('hon'); const fAberto = arg('aberto');
if (!unidade || !fHon || !fAberto) { console.error('Uso: --unidade="..." --hon=arquivo --aberto=arquivo [--diferentes] [--simular]'); process.exit(1); }
const APP_URL = (process.env.APP_URL || '').replace(/\/$/, '');
const TOKEN = process.env.LEGALIZACAO_SYNC_TOKEN || process.env.CERTISEGURO_SYNC_TOKEN;
const ler = (f) => fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean);

async function post(rota, corpo) {
  const r = await fetch(APP_URL + '/api/data/' + rota, { method: 'POST', headers: { 'X-Sync-Token': TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(corpo), signal: AbortSignal.timeout(180000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${rota}: ${r.status} ${j.error || ''}`);
  return j;
}

(async () => {
  const clientes = ler(fHon).map((l) => { const [cnpj, valor, mes, desde, ...n] = l.split('|'); return { cnpj, valor: parseFloat(valor), vigencia: mes, desde, mes, nome: n.join('|') }; });
  const abertos = ler(fAberto).map((l) => { const [cnpj, nome, qtd, aberto, atrasado, qtdAtrasados, maisAntigo] = l.split('|'); return { cnpj, nome, qtd: +qtd, aberto: +aberto, atrasado: +atrasado, qtdAtrasados: +qtdAtrasados, maisAntigo }; });
  if (clientes.length < 5) throw new Error('Poucos clientes na lista (' + clientes.length + ') — leitura suspeita, nada foi importado.');
  console.log(`${unidade}: ${clientes.length} cliente(s) com honorário, ${abertos.length} com valor em aberto.`);
  if (flag('simular')) { console.log('(simulação — nada enviado)'); return; }
  console.log('Financeiro:', JSON.stringify(await post('financeiro/importar', { unidade, fonte: 'Omie (Contas a Receber) — rotina diária das 11:00', clientes, abertos })));
  const g = await post('gestao/honorarios-omie', { itens: clientes, aplicar: true, aplicarDiferentes: flag('diferentes') });
  console.log('Gestão de Clientes:', JSON.stringify(g.contagem));
  if (g.diferente.length) console.log('Honorário DIFERENTE do cadastrado' + (flag('diferentes') ? ' (atualizado)' : ' (NÃO alterado)') + ':\n  ' + g.diferente.map((x) => `${x.nome}: cadastrado ${x.atual} → Omie ${x.valor}`).join('\n  '));
  if (g.semCadastro.length) console.log('Criados sem cadastro no Acessórias:', g.semCadastro.map((x) => x.nome).join('; '));
  if (g.inativoNaCarteira.length) console.log('Faturando no Omie mas encerrados na Carteira:', g.inativoNaCarteira.map((x) => x.carteira).join('; '));
})().catch((e) => { console.error('Falhou:', e.message); process.exit(1); });
