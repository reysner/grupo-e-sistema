'use strict';
/**
 * Integração com a API do Sistema Acessórias — busca a lista de empresas
 * ATIVAS de lá pra popular/atualizar a Carteira (tabela `clientes`) daqui.
 * Pedido do Reysner: trazer os clientes ativos, MAS SEM o honorário (isso
 * fica pendente de preenchimento manual/depois — de propósito, não é bug).
 *
 * Documentação: https://api.acessorias.com/documentation
 *   GET https://api.acessorias.com/companies/ListAll?ativa=S&Pagina=N
 *   Header: Authorization: Bearer <token>
 *   20 registros por página, sem total informado — pagina até vir vazio.
 *   Rate limit: 100 req/min (sliding window) — por segurança, espaçamos
 *   as páginas em ~700ms (~85 req/min no pior caso).
 *
 * Token nunca fica no código nem no git — vem de process.env.ACESSORIAS_API_TOKEN
 * (mesmo padrão do ZAPPY_TOKEN já usado no módulo de Sucesso do Cliente).
 */

const BASE_URL = 'https://api.acessorias.com';
const ESPACAMENTO_MS = 700;

/**
 * A API usa uma variedade maior de regimes do que as 5 opções que o
 * formulário do Grupo-E aceita (Simples Nacional, Lucro Presumido, Lucro
 * Real, MEI, Sem fins lucrativos). Mapeia os valores reais vistos na API
 * (ex.: "Simples Nacional - Isenta") pro valor equivalente daqui. Valor não
 * reconhecido vira `null` — melhor deixar em branco pra alguém revisar do
 * que adivinhar errado.
 */
function normalizarRegime(regimeAcessorias) {
  const r = String(regimeAcessorias || '').toLowerCase();
  if (!r) return null;
  if (r.includes('mei') || r.includes('microempreendedor')) return 'MEI';
  if (r.includes('simples nacional')) return 'Simples Nacional';
  if (r.includes('lucro presumido')) return 'Lucro Presumido';
  if (r.includes('lucro real')) return 'Lucro Real';
  if (r.includes('sem fins lucrativos') || r.includes('sem fim lucrativo')) return 'Sem fins lucrativos';
  return null;
}

/** "0000-00-00" (data "vazia" da API) ou string inválida vira null; senão devolve como veio (AAAA-MM-DD). */
function normalizarData(data) {
  if (!data || data === '0000-00-00') return null;
  return data;
}

async function buscarPagina(pagina, token) {
  const url = `${BASE_URL}/companies/ListAll?ativa=S&Pagina=${pagina}`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (resp.status === 429) {
    // Estourou o rate limit mesmo com o espaçamento — espera um pouco mais e tenta 1x.
    await new Promise(r => setTimeout(r, 5000));
    return buscarPagina(pagina, token);
  }
  if (!resp.ok) {
    throw new Error(`Acessórias respondeu ${resp.status} na página ${pagina}`);
  }
  const dados = await resp.json();
  return Array.isArray(dados) ? dados : [];
}

/**
 * Busca TODAS as empresas ativas, paginando até vir página vazia (ou menor
 * que 20, sinal de última página). `limitePaginas` é uma trava de segurança
 * (não documentada pela API) pra nunca entrar num loop infinito por engano.
 */
async function listarEmpresasAtivas({ token, limitePaginas = 500 } = {}) {
  if (!token) throw new Error('ACESSORIAS_API_TOKEN não configurado.');
  const todas = [];
  for (let pagina = 1; pagina <= limitePaginas; pagina++) {
    const lote = await buscarPagina(pagina, token);
    if (!lote.length) break;
    todas.push(...lote);
    if (lote.length < 20) break; // última página
    if (pagina < limitePaginas) await new Promise(r => setTimeout(r, ESPACAMENTO_MS));
  }
  return todas.map(empresaParaCliente);
}

/**
 * Traduz uma empresa da API pro formato de `clientes` daqui — SEM honorário
 * de propósito (ver comentário no topo do arquivo). `acessorias_id` é
 * guardado pra re-sincronizar sem depender só do CNPJ (evita duplicar se o
 * CNPJ vier formatado diferente numa importação manual futura).
 */
function empresaParaCliente(empresa) {
  return {
    acessorias_id: String(empresa.ID || ''),
    cnpj: empresa.Identificador || null,
    nome_empresa: empresa.Fantasia || empresa.Razao || null,
    regime_tributario: normalizarRegime(empresa.Regime),
    regime_tributario_bruto: empresa.Regime || null, // pra revisão de quem não mapeou
    data_entrada: normalizarData(empresa.ClienteDesde) || normalizarData(empresa.DataDoCadastro),
  };
}

module.exports = { listarEmpresasAtivas, normalizarRegime, normalizarData, empresaParaCliente };
