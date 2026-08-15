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

/**
 * `Fantasia` às vezes vem mascarado como "********" (mesmo campo aparece
 * mascarado na própria tela do Acessórias — parece ser permissão restrita
 * do token, não um bug daqui). Nesses casos não dá pra usar.
 */
function fantasiaUtilizavel(fantasia) {
  const f = String(fantasia || '').trim();
  if (!f || /^\*+$/.test(f)) return null;
  return f;
}

/**
 * A API não expõe o campo "Apelido e-Contínuo" do Acessórias (confirmado
 * testando com todos os parâmetros da documentação — não vem em nenhuma
 * resposta). Decisão do Reysner: já que não dá pra buscar o Apelido, usar
 * SEMPRE a Razão Social (não o Nome Fantasia) como nome da empresa aqui —
 * troca "&" por " E " em qualquer situação (ex.: "M&F PARTICIPACOES LTDA"
 * vira "M E F PARTICIPACOES LTDA", "PITTELLI & PITTELLI" vira "PITTELLI E
 * PITTELLI").
 *
 * De propósito NÃO corta sufixo tipo "LTDA"/"EIRELI"/"ME": pra empresa com
 * filiais (ex.: "CARDOSO ADEGA LTDA - FILIAL UBERABA") é exatamente esse
 * sufixo que diferencia uma filial da outra — cortar recriaria o problema
 * de nomes duplicados que a Razão Social resolve.
 */
function derivarApelido(razaoSocial) {
  if (!razaoSocial) return null;
  return String(razaoSocial).replace(/&/g, ' E ').replace(/\s+/g, ' ').trim();
}

async function buscarPagina(pagina, token) {
  // `registrationData` é obrigatório aqui — sem ele a API não devolve o
  // campo `Regime` (nem `GrupoDeEmpresas`), e todo regime_tributario sai
  // null (bug real, presente desde a 1ª sincronização — só ficou óbvio
  // quando um sync reportou 622 de 622 empresas "sem regime reconhecido").
  const url = `${BASE_URL}/companies/ListAll?ativa=S&Pagina=${pagina}&registrationData`;
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
 * Busca UMA empresa específica pelo CNPJ/CPF (usado ao resolver uma
 * notificação de churn — pega o `ClienteAte` real, em vez de usar "hoje"
 * como data de saída). CNPJ vai direto na URL, sem encodar a barra — a API
 * retorna 404 se `/` virar `%2F` (confirmado testando).
 *
 * @returns {object|null} { status: 'Ativa'|'Inativa', clienteAte: 'AAAA-MM-DD'|null } ou null se não achar/der erro.
 */
async function buscarEmpresaPorCnpj(cnpj, token) {
  if (!cnpj || !token) return null;
  try {
    const url = `${BASE_URL}/companies/${cnpj}`;
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!resp.ok) return null;
    const empresa = await resp.json();
    if (!empresa || !empresa.Status) return null;
    return { status: empresa.Status, clienteAte: normalizarData(empresa.ClienteAte) };
  } catch (e) {
    return null; // falha na busca não pode travar a resolução do churn — quem chama usa "hoje" como fallback
  }
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
    codigo: empresa.ID != null ? String(empresa.ID) : null, // pedido do Reysner: usar o ID do Acessórias como código
    cnpj: empresa.Identificador || null,
    // Sempre Razão Social (não Fantasia) — decisão do Reysner: além de não
    // dar pra buscar o Apelido e-Contínuo, a Razão Social já desambigua
    // empresas diferentes que por coincidência usam a mesma marca/fantasia
    // (ex.: duas academias "Muscle Training" de donos diferentes).
    // Fantasia só entra como último recurso, se por algum motivo a Razão
    // Social vier vazia (não deveria acontecer, é campo obrigatório lá).
    nome_empresa: derivarApelido(empresa.Razao) || empresa.Razao || fantasiaUtilizavel(empresa.Fantasia) || null,
    regime_tributario: normalizarRegime(empresa.Regime),
    regime_tributario_bruto: empresa.Regime || null, // pra revisão de quem não mapeou
    data_entrada: normalizarData(empresa.ClienteDesde) || normalizarData(empresa.DataDoCadastro),
  };
}

module.exports = { listarEmpresasAtivas, buscarEmpresaPorCnpj, normalizarRegime, normalizarData, fantasiaUtilizavel, derivarApelido, empresaParaCliente };
