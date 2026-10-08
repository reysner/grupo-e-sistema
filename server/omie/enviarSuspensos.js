'use strict';

/**
 * Envia ao Grupo-E a lista de contratos "Suspenso" do Omie (selo ⏸ Suspenso do Risco, painel /cs e Carteira).
 * Entrada: um arquivo por empresa do Omie, gerado pelo SCRIPT 4 de paginaContratos.js (formato compacto):
 *   linha 1:  #total=<quantos contratos a grade tem no total, SEM filtro>
 *   demais:   CNPJ|contrato|nome         (só os contratos com situação Suspenso)
 * O envio SUBSTITUI a lista inteira (quem saiu da lista deixa de ser "Suspenso"), então só envia se AS DUAS empresas foram lidas
 * com sucesso; se uma falhar, nada é enviado e a lista da semana anterior continua valendo.
 * Uso: node server/omie/enviarSuspensos.js --escritorial=server/omie/tmp/escritorial-suspensos.txt --solucoes=server/omie/tmp/solucoes-suspensos.txt [--simular]
 * Segredos: server/legalizacao/.env (APP_URL e o token de sincronização) — nunca imprimir.
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'legalizacao', '.env') });

const arg = (n) => { const a = process.argv.find((x) => x.startsWith('--' + n + '=')); return a ? a.slice(n.length + 3) : null; };
// Leitura incompleta tem menos contratos que isso: Escritorial ≈ 498, Soluções ≈ 237 em 08/10/2026 (mínimos bem abaixo, só para barrar leitura quebrada).
const MINIMO = { escritorial: 250, solucoes: 120 };
const APP_URL = (process.env.APP_URL || '').replace(/\/$/, '');
const TOKEN = process.env.LEGALIZACAO_SYNC_TOKEN || process.env.CERTISEGURO_SYNC_TOKEN;

function ler(empresa, arquivo) {
  if (!arquivo || !fs.existsSync(arquivo)) throw new Error(`${empresa}: arquivo da leitura não encontrado.`);
  const linhas = fs.readFileSync(arquivo, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const m = /^#total=(\d+)$/.exec(linhas[0] || '');
  if (!m) throw new Error(`${empresa}: faltou a linha "#total=N" no início do arquivo.`);
  const total = +m[1];
  if (total < MINIMO[empresa]) throw new Error(`${empresa}: a grade tinha só ${total} contratos (esperado mais de ${MINIMO[empresa]}) — leitura suspeita, nada enviado.`);
  const contratos = linhas.slice(1).map((l) => { const [cnpj, contrato, ...n] = l.split('|'); return { cnpj, contrato, nome: n.join('|') }; });
  if (contratos.some((c) => !/^[\d./-]{11,18}$/.test(c.cnpj || '') || !c.contrato)) throw new Error(`${empresa}: linha fora do formato CNPJ|contrato|nome.`);
  return { total, contratos };
}

(async () => {
  const esc = ler('escritorial', arg('escritorial')); const sol = ler('solucoes', arg('solucoes'));
  const contratos = [...esc.contratos, ...sol.contratos];
  console.log(`Escritorial: ${esc.total} contratos, ${esc.contratos.length} suspensos | Soluções: ${sol.total} contratos, ${sol.contratos.length} suspensos | total ${contratos.length}.`);
  if (process.argv.includes('--simular')) { console.log('(simulação — nada enviado)'); return; }
  const r = await fetch(APP_URL + '/api/cs/risco/suspensos-omie', { method: 'POST', headers: { 'X-Sync-Token': TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify({ contratos }), signal: AbortSignal.timeout(60000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${r.status} ${j.error || ''}`);
  console.log('Enviado:', JSON.stringify(j));
})().catch((e) => { console.error('Falhou:', e.message); process.exit(1); });
