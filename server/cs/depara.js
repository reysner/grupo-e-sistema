'use strict';
/**
 * Módulo Sucesso do Cliente — De-para (Vínculos)
 * ------------------------------------------------------------------
 * Casa um CONTATO do Zappy (nome livre + telefone + tags) com um CLIENTE
 * da Carteira do Grupo-E, por similaridade de texto. Gera SUGESTÕES com
 * grau de confiança; a confirmação é humana.
 *
 * Baseado na análise de 4.242 contatos reais:
 *  - tag "Escritorial" marca clientes do escritório (~970); "Hands" = outra empresa.
 *  - nome vem como "Pessoa - Empresa", ou só "Empresa", ou só "Pessoa".
 *  - telefone quase sempre "55"+DDD+número (formato bom para âncora).
 *
 * Sem dependências externas.
 */

// ── Normalização de telefone ────────────────────────────────────────────────
/** Reduz o telefone a só dígitos e tenta padronizar para 55+DDD+numero. */
function normalizarTelefone(tel) {
  if (!tel) return null;
  let d = String(tel).replace(/\D/g, '');
  if (!d) return null;
  // remove zeros à esquerda
  d = d.replace(/^0+/, '');
  // adiciona DDI 55 se veio sem (10 ou 11 dígitos = DDD+numero)
  if (d.length === 10 || d.length === 11) d = '55' + d;
  return d;
}

// ── Normalização de texto ───────────────────────────────────────────────────
const STOPWORDS = new Set([
  'ltda','me','epp','eireli','sa','s','a','de','da','do','das','dos','e',
  'the','comercio','comercial','industria','servicos','servico','company',
  'cia','grupo','empresa','microempreendedor','individual','mei',
]);

/** minúsculas, sem acento, sem pontuação */
function base(txt) {
  return (txt || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // tira acento
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** normaliza e remove stopwords/sufixos societários -> tokens significativos */
function tokens(txt) {
  return base(txt).split(' ').filter(t => t && !STOPWORDS.has(t) && t.length > 1);
}

// ── Extração de empresa a partir do nome do contato ─────────────────────────
/**
 * O nome do contato pode ser "Pessoa - Empresa", "Empresa" ou "Pessoa".
 * Retorna candidatos de texto para casar (tenta o pós-hífen e o nome inteiro).
 */
function candidatosEmpresa(nomeContato) {
  const nome = (nomeContato || '').trim();
  const cands = [];
  // pós-hífen (o mais comum para empresa): "Jose - Emporio Siqueira" -> "Emporio Siqueira"
  const m = nome.split(/\s*-\s*/);
  if (m.length > 1) {
    const depois = m.slice(1).join(' - ').trim();
    if (depois) cands.push(depois);
    // e também o antes, caso a empresa esteja antes do hífen
    if (m[0].trim()) cands.push(m[0].trim());
  }
  // nome inteiro (caso seja "8M Administracao de Imoveis")
  cands.push(nome);
  // dedup preservando ordem
  return [...new Set(cands)];
}

// ── Similaridade ────────────────────────────────────────────────────────────
/** Similaridade de Jaccard entre conjuntos de tokens (0..1). */
function jaccard(aTokens, bTokens) {
  const A = new Set(aTokens), B = new Set(bTokens);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

/**
 * Similaridade entre um texto de contato e um nome de cliente da Carteira.
 * Combina Jaccard de tokens com bônus se todos os tokens de um lado estão no outro.
 * @returns número 0..100
 */
function similaridade(textoContato, nomeCliente) {
  const a = tokens(textoContato);
  const b = tokens(nomeCliente);
  if (!a.length || !b.length) return 0;
  let s = jaccard(a, b);
  // bônus de contenção: se todos os tokens do menor estão no maior
  const [menor, maior] = a.length <= b.length ? [a, b] : [b, a];
  const contido = menor.every(t => maior.includes(t));
  if (contido) s = Math.max(s, 0.85);
  return Math.round(s * 100);
}

// ── Matcher principal ───────────────────────────────────────────────────────
/**
 * Dado um contato do Zappy e a lista de clientes da Carteira, retorna as
 * melhores sugestões de vínculo.
 *
 * @param {object} contato  { nome, telefone, tags }  (tags: string ou array)
 * @param {Array}  clientes lista da Carteira: { id, nome_empresa, cnpj }
 * @param {object} opts     { min: confiança mínima (default 40), max: nº de sugestões (default 3) }
 * @returns {object} { telefone, is_escritorial, sugestoes: [{cliente_id, nome_empresa, cnpj, confianca}] }
 */
function sugerirVinculo(contato, clientes, opts = {}) {
  const min = opts.min ?? 40;
  const max = opts.max ?? 3;
  const telefone = normalizarTelefone(contato.telefone);
  const tagsStr = Array.isArray(contato.tags) ? contato.tags.join(',') : (contato.tags || '');
  const isEscritorial = /escritorial/i.test(tagsStr);

  const cands = candidatosEmpresa(contato.nome);
  const scored = [];
  for (const cli of clientes) {
    let melhor = 0;
    for (const c of cands) {
      const s = similaridade(c, cli.nome_empresa);
      if (s > melhor) melhor = s;
    }
    if (melhor >= min) {
      scored.push({
        cliente_id: cli.id,
        nome_empresa: cli.nome_empresa,
        cnpj: cli.cnpj || null,
        confianca: melhor,
      });
    }
  }
  scored.sort((a, b) => b.confianca - a.confianca);
  return {
    telefone,
    nome_contato: (contato.nome || '').trim(),
    is_escritorial: isEscritorial,        // pré-marca candidato a cliente
    sugestoes: scored.slice(0, max),
  };
}

module.exports = {
  normalizarTelefone,
  candidatosEmpresa,
  similaridade,
  sugerirVinculo,
  tokens,
  base,
};
