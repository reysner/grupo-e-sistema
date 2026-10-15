'use strict';

/**
 * Envia ao Grupo-E o honorário cobrado por cliente e ano, lido do Omie (ficha da Análise Anual, /cs).
 * Entrada: JSON { "<CNPJ só dígitos>": { "<ano>": { total, meses, mediana } } }, gerado da grade "Contas por Cliente ou Fornecedor"
 * (Finanças > Relatórios > Contas a pagar e a receber, consolidada com o outro ambiente, período específico por data de emissão,
 * categoria SERVIÇOS HONORÁRIOS CONTÁBEIS; linhas CNPJ > Ano > Mês), lida com flexmonster.getData() na tela do Omie.
 * O envio SUBSTITUI toda a carga anterior (a leitura sempre cobre todos os anos).
 * Uso: node server/omie/enviarHonorarios.js --arquivo=server/omie/tmp/honorarios-por-ano.json --ate=2026-10 [--simular]
 * Segredos: server/legalizacao/.env (APP_URL e o token de sincronização) — nunca imprimir.
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'legalizacao', '.env') });

const arg = (n) => { const a = process.argv.find((x) => x.startsWith('--' + n + '=')); return a ? a.slice(n.length + 3) : null; };
const APP_URL = (process.env.APP_URL || '').replace(/\/$/, '');
const TOKEN = process.env.LEGALIZACAO_SYNC_TOKEN || process.env.CERTISEGURO_SYNC_TOKEN;

(async () => {
  const arquivo = arg('arquivo'), ate = arg('ate');
  if (!arquivo || !fs.existsSync(arquivo)) throw new Error('Informe --arquivo= com o JSON da leitura.');
  if (!/^\d{4}-\d{2}$/.test(ate || '')) throw new Error('Informe --ate=AAAA-MM (último mês incluído na leitura).');
  const lido = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
  const itens = Object.entries(lido).map(([cnpj, anos]) => ({
    cnpj, anos: Object.entries(anos).map(([ano, v]) => ({ ano: +ano, total: v.total, meses: v.meses, mensal: v.mediana })),
  }));
  const linhas = itens.reduce((s, i) => s + i.anos.length, 0);
  if (itens.length < 300) throw new Error(`Só ${itens.length} documentos na leitura (esperado ~700): leitura suspeita, nada enviado.`);
  console.log(`${itens.length} documentos, ${linhas} linhas (cliente × ano), até ${ate}.`);
  if (process.argv.includes('--simular')) { console.log('(simulação — nada enviado)'); return; }
  const r = await fetch(APP_URL + '/api/cs/omie/honorarios', {
    method: 'POST', headers: { 'X-Sync-Token': TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ate, itens }), signal: AbortSignal.timeout(120000),
  });
  console.log(r.status, (await r.text()).slice(0, 300));
  if (!r.ok) process.exitCode = 1;
})().catch((e) => { console.error('FALHOU:', e.message); process.exit(1); });
