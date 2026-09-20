'use strict';

/**
 * Consulta de alvará de LOCALIZAÇÃO E FUNCIONAMENTO (ALF) da Prefeitura de BELO HORIZONTE-MG.
 * Descoberto em 20/09/2026 — "Acesso público" do Sistema de Atividades Econômicas (alf.pbh.gov.br), SEM login e SEM captcha.
 * A tela chama uma API JSON pública:
 *   GET https://alf.pbh.gov.br/siatu-urbano-consulta-previa/api/v2/alfs?...&codigoNacional=<CNPJ 14 dígitos>&faseStr=2
 *   → { total, registros: [{ numero, dataValidade, dataConcessao, situacao: { nomeSituacao: 'Ativo' }, fase: { nomeFase: 'Alvará' } }] }
 * O WAF (GoCache) bloqueia clientes "sem cara de navegador" (curl puro), então a chamada leva User-Agent/Referer de navegador.
 * Roda só na estação local (como Uberlândia/Uberaba). O SANITÁRIO de BH tem outra consulta (aas.pbh.gov.br/consulta, SISVISA),
 * ainda não integrada — aqui o sanitário fica "não encontrado".
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

async function consultarAlvaraBeloHorizonte(cnpj) {
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
