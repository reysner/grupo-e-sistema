'use strict';

/**
 * Estima, pelo CNAE do cartão CNPJ, se a atividade está SUJEITA a licenciamento da Vigilância Sanitária
 * (alvará sanitário). É uma ESTIMATIVA por grupo de atividades (alimentos, saúde, beleza/estética,
 * hospedagem, farmácia/cosméticos, veterinária, dedetização…), pensada pra apontar "quem provavelmente
 * precisa" e conferir. Quem manda é a Vigilância de cada município: atividades de baixo risco podem ser
 * DISPENSADAS (declaração de dispensa) e alguns CNAEs fora desta lista podem exigir. Ajuste a lista abaixo
 * à vontade — cada regra é um prefixo do CNAE de 7 dígitos.
 */

const REGRAS = [
  { p: '10', r: 'Fabricação de alimentos' },
  { p: '11', r: 'Fabricação de bebidas' },
  { p: '2063', r: 'Fabricação de cosméticos, perfumaria e higiene' },
  { p: '21', r: 'Fabricação de produtos farmacêuticos' },
  { p: '3250', r: 'Instrumentos e materiais médicos/odontológicos' },
  { p: '463', r: 'Atacado de alimentos e bebidas' },
  { p: '4644', r: 'Atacado de medicamentos' },
  { p: '4645', r: 'Atacado de material médico/odontológico' },
  { p: '4646', r: 'Atacado de cosméticos e perfumaria' },
  { p: '4711', r: 'Supermercados e hipermercados' },
  { p: '4712', r: 'Minimercados, mercearias e armazéns' },
  { p: '472', r: 'Varejo de alimentos e bebidas' },
  { p: '4771', r: 'Farmácias e drogarias' },
  { p: '4772', r: 'Cosméticos, perfumaria e higiene' },
  { p: '4773', r: 'Produtos médicos e ortopédicos' },
  { p: '4774', r: 'Óticas' },
  { p: '5510', r: 'Hotéis' },
  { p: '5590', r: 'Outros tipos de alojamento' },
  { p: '5611', r: 'Restaurantes, lanchonetes e bares' },
  { p: '5612', r: 'Serviços ambulantes de alimentação' },
  { p: '5620', r: 'Fornecimento de alimentos preparados / buffet' },
  { p: '7500', r: 'Atividades veterinárias' },
  { p: '81290', r: 'Dedetização e controle de pragas' },
  { p: '86', r: 'Atenção à saúde humana' },
  { p: '87', r: 'Assistência social com alojamento (cuidados)' },
  { p: '9601', r: 'Lavanderias e tinturarias' },
  { p: '9602', r: 'Cabeleireiros, manicure e estética' },
  { p: '9609206', r: 'Tatuagem e piercing' },
];

const fmt = (c) => String(c).replace(/^(\d{4})(\d)(\d{2})$/, '$1-$2/$3');

/** @param {{codigo: string, descricao: string, principal: boolean}[]} cnaes */
function avaliarExigenciaSanitaria(cnaes) {
  const achados = [];
  for (const c of cnaes || []) {
    const cod = String(c.codigo || '').replace(/\D/g, '').padStart(7, '0');
    const regra = REGRAS.find((x) => cod.startsWith(x.p));
    if (regra) achados.push({ codigo: fmt(cod), descricao: c.descricao, principal: !!c.principal, grupo: regra.r });
  }
  const principal = achados.find((a) => a.principal);
  return { exige: achados.length > 0, principal: !!principal, achados };
}

/** Texto curto pra observação do alvará sanitário "sem data". */
function textoExigencia(av) {
  const a = av.achados.find((x) => x.principal) || av.achados[0];
  const desc = (a.descricao || a.grupo).slice(0, 60);
  return av.principal
    ? `Exige alvará sanitário (CNAE principal ${a.codigo} — ${desc}) — não localizado.`
    : `Pode exigir alvará sanitário (CNAE secundário ${a.codigo} — ${desc}) — não localizado.`;
}

const PADRAO_OBS_AUTOMATICA = /^(Exige|Pode exigir) alvará sanitário/;

module.exports = { avaliarExigenciaSanitaria, textoExigencia, PADRAO_OBS_AUTOMATICA };
