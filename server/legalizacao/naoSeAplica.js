'use strict';

/**
 * Cliente cujo documento NÃO é um CNPJ válido (CPF, CNO, CAEPF, produtor rural, doméstica, cadastro interno 9997..9999…) não tem alvará de
 * funcionamento/sanitário nem certificado PJ. Pedido do Reysner (20/10/2026): esses clientes pararam de aparecer como "Sem data".
 * Só some o que está SEM data: se houver data (ex.: procuração com vencimento) ou solicitação em andamento, continua aparecendo.
 * Muda a linha do painel no lugar (func, sanit, ecac, fgts e cert PJ viram null) e devolve a mesma linha.
 */
function limparSemDataSeNaoCnpj(l, naoEhCnpj) {
  if (!l || !naoEhCnpj || l.sem_cadastro_acessorias) return l;   // linhas de certificado "sem cadastro" (CertiSeguro) seguem como estão
  ['func', 'sanit', 'ecac', 'fgts'].forEach((k) => { if (l[k] && l[k].status === 'sem_data') l[k] = null; });
  if (l.cert && l.cert.tipo === 'pj' && l.cert.status === 'sem_data') l.cert = null;
  return l;
}

module.exports = { limparSemDataSeNaoCnpj };
