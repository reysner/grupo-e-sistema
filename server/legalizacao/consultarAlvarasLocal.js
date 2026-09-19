'use strict';

/**
 * Consulta os alvarás (Funcionamento/Sanitário) na Prefeitura de Uberlândia a partir de uma
 * ESTAÇÃO DO ESCRITÓRIO e grava o resultado no Grupo-E. Existe porque a Prefeitura bloqueia o
 * IP do Render (a sessão do portal nem abre) — mesmo motivo do certiseguroSync.js rodar aqui.
 *
 * Devagar de propósito: 1 empresa a cada 20 segundos (pra não sermos bloqueados de novo) e
 * para sozinho se falhar várias vezes seguidas (sinal de bloqueio). Só consulta quem precisa
 * (sem data de vencimento, vencido, ou não consultado há 7 dias) — a mesma regra da rotina noturna.
 *
 * Segredos: server/legalizacao/.env (APP_URL e CERTISEGURO_SYNC_TOKEN, os mesmos do certiseguroSync).
 * Uso: node server/legalizacao/consultarAlvarasLocal.js [limite]
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { consultarAlvaraUberlandia } = require('./ciclo7Uberlandia');

const INTERVALO_MS = 20 * 1000;
const MAX_FALHAS_SEGUIDAS = 4;
const APP_URL = (process.env.APP_URL || '').replace(/\/$/, '');
const TOKEN = process.env.LEGALIZACAO_SYNC_TOKEN || process.env.CERTISEGURO_SYNC_TOKEN;
const hora = () => new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' });
const dorme = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(metodo, rota, corpo) {
  const res = await fetch(APP_URL + '/api/data/legalizacao/' + rota, {
    method: metodo,
    headers: { 'X-Sync-Token': TOKEN, 'Content-Type': 'application/json' },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${json.error || ''}`.trim());
  return json;
}

async function main() {
  if (!APP_URL || !TOKEN) { console.error('Faltam APP_URL e/ou CERTISEGURO_SYNC_TOKEN em server/legalizacao/.env'); process.exit(1); }
  const limite = parseInt(process.argv[2], 10) || Infinity;
  const { data } = await api('GET', 'alvaras-a-consultar');
  const alvos = data.slice(0, limite);
  console.log(`[${hora()}] ${alvos.length} empresa(s) pra consultar (1 a cada ${INTERVALO_MS / 1000}s).`);

  let comData = 0, comSolicitacao = 0, nada = 0, falhas = 0, seguidas = 0;
  for (let i = 0; i < alvos.length; i++) {
    const a = alvos[i];
    try {
      const resultado = await consultarAlvaraUberlandia(a.cnpj);
      const g = await api('POST', 'alvaras-consulta-local', { cliente_id: a.cliente_id, resultado });
      seguidas = 0;
      const achou = (resultado.funcionamento && resultado.funcionamento.encontrado) || (resultado.sanitario && resultado.sanitario.encontrado);
      if (resultado.vencimentoEncontrado) comData++; else if (achou) comSolicitacao++; else nada++;
      console.log(`[${hora()}] ${i + 1}/${alvos.length} ${a.nome_empresa}: ${resultado.vencimentoEncontrado ? 'vence ' + resultado.vencimentoEncontrado : achou ? 'solicitação em andamento' : 'nada encontrado'}${g && resultado.sanitario && resultado.sanitario.encontrado ? ' (+ sanitário)' : ''}`);
    } catch (e) {
      falhas++; seguidas++;
      console.log(`[${hora()}] ${i + 1}/${alvos.length} ${a.nome_empresa}: FALHOU — ${e.message}`);
      if (seguidas >= MAX_FALHAS_SEGUIDAS) { console.log('Muitas falhas seguidas — parando pra não forçar o portal (pode ser bloqueio). Tente de novo mais tarde.'); break; }
    }
    if (i < alvos.length - 1) await dorme(INTERVALO_MS);
  }
  console.log(`[${hora()}] Fim: ${comData} com data, ${comSolicitacao} em andamento, ${nada} sem alvará, ${falhas} falha(s).`);
}

main().catch((e) => { console.error('Falhou:', e.message); process.exit(1); });
