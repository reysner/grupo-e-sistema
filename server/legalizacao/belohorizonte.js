'use strict';

/**
 * Consulta de alvará de LOCALIZAÇÃO E FUNCIONAMENTO (ALF) da Prefeitura de BELO HORIZONTE-MG.
 * Descoberto em 20/09/2026 — "Acesso público" do Sistema de Atividades Econômicas (alf.pbh.gov.br), SEM login e SEM captcha.
 * A tela chama uma API JSON pública:
 *   GET https://alf.pbh.gov.br/siatu-urbano-consulta-previa/api/v2/alfs?...&codigoNacional=<CNPJ 14 dígitos>&faseStr=2
 *   → { total, registros: [{ numero, dataValidade, dataConcessao, situacao: { nomeSituacao: 'Ativo' }, fase: { nomeFase: 'Alvará' } }] }
 * O WAF (GoCache) bloqueia clientes "sem cara de navegador" (curl puro), então a chamada leva User-Agent/Referer de navegador.
 * Roda só na estação local (como Uberlândia/Uberaba). O SANITÁRIO de BH tem outra consulta (aas.pbh.gov.br/consulta, SISVISA),
 * integrado abaixo (consultarSanitarioBH). ATENÇÃO: o layout do resultado POSITIVO do SISVISA ainda não foi visto (nenhum cliente nosso em BH tinha
 * alvará sanitário em 20/09/2026); o leitor é genérico e o texto bruto de todo positivo vai pra bh-sanitario-bruto.log pra conferir e ajustar.
 *
 * Devolve o mesmo formato de ciclo7Uberlandia.js (funcionamento/sanitario/vencimentoEncontrado/erros).
 */

const URL_API = 'https://alf.pbh.gov.br/siatu-urbano-consulta-previa/api/v2/alfs';
const CABECALHOS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'pt-BR,pt;q=0.9',
  Referer: 'https://alf.pbh.gov.br/publico/home/alfs/pesquisa',
};

const fs = require('fs');
const path = require('path');
const URL_AAS = 'https://aas.pbh.gov.br/consulta';

/** SISVISA (alvará sanitário de BH): formulário Laravel com _token; CNPJ/CPF sem máscara; sem captcha. */
async function consultarSanitarioBH(digitos) {
  const r0 = await fetch(URL_AAS, { headers: { 'User-Agent': CABECALHOS['User-Agent'], 'Accept-Language': 'pt-BR' }, signal: AbortSignal.timeout(30000) });
  const html0 = await r0.text();
  const tok = /name="_token"\s+value="([^"]+)"/.exec(html0);
  if (!r0.ok || !tok) throw new Error('SISVISA-BH indisponível ou bloqueado (' + r0.status + ').');
  const cookie = r0.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const corpo = new URLSearchParams({ _token: tok[1], cnpjCpf: digitos, Tip_Logr: '', Nom_Logr: '', Num_Imov_Logr: '', Num_CEP: '', consultar: 'Consultar' });
  const r = await fetch(URL_AAS, {
    method: 'POST', body: corpo, signal: AbortSignal.timeout(30000),
    headers: { 'User-Agent': CABECALHOS['User-Agent'], 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie, Referer: URL_AAS, Origin: 'https://aas.pbh.gov.br' },
  });
  const html = await r.text();
  if (!r.ok) throw new Error('SISVISA-BH respondeu ' + r.status + '.');
  if (/n[ãa]o encontrado/i.test(html)) return { encontrado: false };
  // tudo que vem depois do título do formulário, sem tags: é onde o resultado aparece
  const texto = html.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>|<select[\s\S]*?<\/select>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
  const m = /(?:validade|vencimento|v[áa]lido\s+at[ée])[^0-9]{0,40}(\d{2})\/(\d{2})\/(\d{4})/i.exec(texto);
  try { fs.appendFileSync(path.join(__dirname, 'bh-sanitario-bruto.log'), `[${new Date().toISOString()}] ${digitos}: ${texto.slice(0, 1500)}\n`); } catch (e) { /* log é só conferência */ }
  return { encontrado: true, vencimento: m ? `${m[3]}-${m[2]}-${m[1]}` : null, texto: texto.slice(0, 300) };
}

async function consultarAlvaraBeloHorizonte(cnpj) {
  const res = await consultarFuncionamentoBH(cnpj);
  const digitos = res.cnpj;
  try {
    const san = await consultarSanitarioBH(digitos);
    if (san.encontrado) {
      res.sanitario = { encontrado: true, servico: 'Alvará Sanitário (SISVISA-BH) — conferir', solicitacao: null, numeroPlanilha: null, statusGeral: san.vencimento ? 'Com validade' : 'Encontrado, validade não lida', pareceres: san.vencimento ? [] : [{ secretaria: 'SISVISA', parecer: san.texto }] };
      if (san.vencimento) res.vencimentos = { ...(res.vencimentos || {}), sanitario: san.vencimento };
    }
  } catch (e) { res.erros = [...(res.erros || []), 'Sanitário BH: ' + e.message]; }
  if (res.funcionamento && res.funcionamento.encontrado && res.vencimentoEncontrado) res.vencimentos = { ...(res.vencimentos || {}), funcionamento: res.vencimentoEncontrado };
  return res;
}

async function consultarFuncionamentoBH(cnpj) {
  const digitos = String(cnpj || '').replace(/\D/g, '');
  if (digitos.length !== 14) throw new Error('CNPJ inválido — preciso dos 14 dígitos.');
  const qs = new URLSearchParams({
    pagina: '1', tamPagina: '20', total: '1', paginaAtual: '1', count: 'S', recuperaEndereco: 'S', codigoNacional: digitos, faseStr: '2',
  });
  const res = await fetch(`${URL_API}?${qs}`, { headers: CABECALHOS, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`Belo Horizonte: o portal respondeu ${res.status}.`);
  const j = await res.json().catch(() => { throw new Error('Belo Horizonte: resposta inesperada do portal (bloqueio do WAF?).'); });
  const regs = Array.isArray(j.registros) ? j.registros : [];

  const base = { ano: new Date().getFullYear(), cnpj: digitos, anosVarridos: 1 };
  if (!regs.length) {
    return { ...base, funcionamento: { encontrado: false }, sanitario: { encontrado: false }, nadaEncontrado: true,
      erros: ['Nenhum alvará de localização e funcionamento (ALF) deste CNPJ em Belo Horizonte.'] };
  }

  // Vale o ALF ativo de validade mais longa (um CNPJ pode ter histórico de alvarás antigos).
  const nomeSit = (r) => String((r.situacao && r.situacao.nomeSituacao) || '').toLowerCase();
  const ativos = regs.filter((r) => nomeSit(r) === 'ativo' && r.dataValidade);
  const escolhidos = ativos.length ? ativos : regs.filter((r) => r.dataValidade);
  escolhidos.sort((a, b) => String(b.dataValidade).localeCompare(String(a.dataValidade)));
  const melhor = escolhidos[0];
  if (!melhor) {
    return { ...base, funcionamento: { encontrado: false }, sanitario: { encontrado: false }, nadaEncontrado: true,
      erros: ['Belo Horizonte: ALF encontrado, mas sem data de validade.'] };
  }
  const vencimento = String(melhor.dataValidade).slice(0, 10);
  // Só grava vencimento de alvará ATIVO; inativo/cancelado vira aviso (evita alarme falso no sino).
  if (nomeSit(melhor) !== 'ativo') {
    return { ...base, funcionamento: { encontrado: false }, sanitario: { encontrado: false }, nadaEncontrado: true,
      erros: [`Belo Horizonte: ALF ${melhor.numero} consta como "${(melhor.situacao && melhor.situacao.nomeSituacao) || 'sem situação'}" (validade ${vencimento.split('-').reverse().join('/')}).`] };
  }
  return {
    ...base,
    funcionamento: {
      encontrado: true,
      servico: 'Alvará de Localização e Funcionamento (ALF)',
      solicitacao: null,
      numeroPlanilha: String(melhor.numero),
      statusGeral: 'Ativo',
      pareceres: [],
    },
    sanitario: { encontrado: false },
    erros: [],
    vencimentoEncontrado: vencimento,
  };
}

module.exports = { consultarAlvaraBeloHorizonte };
