'use strict';

/**
 * Preenche a inscrição municipal (C.M.C.) das empresas de Uberlândia que ainda não têm, reaproveitando a consulta do
 * Ciclo7 (o PDF da certidão traz "C.M.C.:601.290-00"). Também atualiza a data de vencimento, como a consulta normal.
 * Uso: node server/legalizacao/preencherInscricoes.js [--limite=N] [--contar]
 * Ritmo: 20 s entre empresas (mesmo da consulta noturna, pra não repetir o bloqueio do portal).
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { consultarAlvaraUberlandia } = require('./ciclo7Uberlandia');

const APP_URL = (process.env.APP_URL || '').replace(/\/$/, '');
const TOKEN = process.env.LEGALIZACAO_SYNC_TOKEN || process.env.CERTISEGURO_SYNC_TOKEN;
const args = process.argv.slice(2);
const LIMITE = parseInt((args.find((a) => a.startsWith('--limite=')) || '').slice(9), 10) || Infinity;
const hora = () => new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' });
const dorme = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(metodo, rota, corpo) {
  const res = await fetch(APP_URL + '/api/data/legalizacao/' + rota, {
    method: metodo, headers: { 'X-Sync-Token': TOKEN, 'Content-Type': 'application/json' },
    body: corpo ? JSON.stringify(corpo) : undefined, signal: AbortSignal.timeout(120000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${json.error || ''}`.trim());
  return json;
}

(async () => {
  const { data } = await api('GET', 'clientes-ativos');
  const alvos = data.filter((e) => e.municipio_ibge === '3170206' && !e.inscricao_municipal).slice(0, LIMITE);
  console.log(`[${hora()}] ${alvos.length} empresa(s) de Uberlândia sem inscrição municipal.`);
  if (args.includes('--contar')) return;
  let achou = 0, semDado = 0, falhas = 0;
  for (let i = 0; i < alvos.length; i++) {
    const e = alvos[i];
    try {
      const r = await consultarAlvaraUberlandia(e.cnpj);
      await api('POST', 'alvaras-consulta-local', { cliente_id: e.cliente_id, resultado: r });
      if (r.inscricaoMunicipal) { achou++; console.log(`[${hora()}] ${i + 1}/${alvos.length} ${e.nome_empresa}: inscrição ${r.inscricaoMunicipal}`); }
      else semDado++;
    } catch (err) { falhas++; console.log(`[${hora()}] ${i + 1}/${alvos.length} ${e.nome_empresa}: falhou — ${err.message}`); }
    await dorme(20000);
  }
  console.log(`[${hora()}] Fim: ${achou} inscrição(ões) preenchida(s), ${semDado} sem inscrição no certificado, ${falhas} falha(s).`);
})().catch((e) => { console.error('Falhou:', e.message); process.exit(1); });
