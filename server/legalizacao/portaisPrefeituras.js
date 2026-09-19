'use strict';

/**
 * Onde localizar o alvará de funcionamento/sanitário das cidades que NÃO são Uberlândia (a única com
 * consulta automática — ver ciclo7Uberlandia.js). Levantamento de 19/09/2026: nenhuma dessas cidades
 * tem consulta pública por CNPJ sem login/captcha que devolva o vencimento (Rio e SIVISA-SP exigem
 * captcha; Campinas exige gov.br; Contagem só mostra andamento de processo; BH, Uberaba e SP não
 * têm busca pública achada). Por isso aqui é só um atalho pro portal — a consulta é manual.
 *
 * Chave: "MUNICIPIO/UF" em maiúsculas e sem acento, como a Receita devolve (ver municipioCnpj.js).
 * Só entra URL que foi aberta/confirmada; cidade fora da lista cai numa busca no Google.
 */

const PORTAIS = {
  'UBERABA/MG': 'https://www.uberaba.mg.gov.br/portal/conteudo,44738',
  'SAO PAULO/SP': 'https://prefeitura.sp.gov.br/w/servico/alvaras-certidoes-e-licencas',
  'BELO HORIZONTE/MG': 'https://prefeitura.pbh.gov.br/empreendedor/abrir-minha-empresa/alvara-localizacao-funcionamento',
  'CONTAGEM/MG': 'https://alvaras.contagem.mg.gov.br/consulta',
  'CAMPINAS/SP': 'https://appo.campinas.sp.gov.br/',
  'RIO DE JANEIRO/RJ': 'https://carioca.rio/servicos/pesquisa-de-existencia-de-alvara-para-um-local/',
  'RIBEIRAO PRETO/SP': 'https://www.ribeiraopreto.sp.gov.br/portal/fazenda/alvara-de-funcionamento',
  'GUARUJA/SP': 'https://www.guaruja.sp.gov.br/servicos-online',
  'PARACATU/MG': 'https://www.paracatu.mg.gov.br/portal/servicos_online',
  'ARAGUARI/MG': 'https://araguari.mg.gov.br/',
  'PATOS DE MINAS/MG': 'https://www.patosdeminas.mg.gov.br/',
  'APARECIDA DE GOIANIA/GO': 'https://aparecida.go.gov.br/',
  'CATALAO/GO': 'https://www.catalao.go.gov.br/',
  'GOUVELANDIA/GO': 'https://gouvelandia.go.gov.br/',
  'ARCOS/MG': 'https://www.arcos.mg.gov.br/',
  'CENTRALINA/MG': 'https://centralina.mg.gov.br/',
  'IRAI DE MINAS/MG': 'https://iraideminas.mg.gov.br/',
  'PRATA/MG': 'https://prata.mg.gov.br/',
  'SANTA FE DE MINAS/MG': 'https://santafedeminas.mg.gov.br/',
  'SAO GOTARDO/MG': 'https://saogotardo.mg.gov.br/',
  'TIROS/MG': 'https://tiros.mg.gov.br/',
};

// Licença sanitária das cidades paulistas: consulta estadual (SIVISA) por CNPJ — exige captcha de imagem.
const SIVISA_SP = 'https://sivisa.saude.sp.gov.br/sivisa/cidadao/cidadaoLicenca.consulta.logic';

function semAcento(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim(); }

/** @returns {{url: string, oficial: boolean, url_sanitario: string|null}} */
function portalDaPrefeitura(municipio, uf) {
  const chave = `${semAcento(municipio)}/${semAcento(uf)}`;
  const oficial = Object.prototype.hasOwnProperty.call(PORTAIS, chave);
  const url = oficial
    ? PORTAIS[chave]
    : 'https://www.google.com/search?q=' + encodeURIComponent(`alvará de funcionamento consulta prefeitura ${municipio} ${uf || ''}`.trim());
  return { url, oficial, url_sanitario: semAcento(uf) === 'SP' ? SIVISA_SP : null };
}

module.exports = { portalDaPrefeitura };
