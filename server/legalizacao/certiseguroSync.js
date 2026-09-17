'use strict';

/**
 * Sincroniza vencimentos de certificado digital (PJ e PF) a partir da API
 * da CertiSeguro — pedido do Reysner, 17/09/2026.
 *
 * A API da CertiSeguro roda em REDE INTERNA do escritório (confirmado pelo
 * Reysner) — o Render não alcança. Por isso este script é standalone e
 * precisa rodar numa ESTAÇÃO WINDOWS de dentro da rede, do mesmo jeito que
 * server/arquivoMorto/ roda (Agendador de Tarefas). Ele faz 2 chamadas:
 *
 *   1) POST em CERTISEGURO_URL com vID=listcert → traz TODOS os certificados
 *      cadastrados (nome, cnpj/cpf, validade) numa única chamada — dispensa
 *      ficar batendo um a um (limite da API é 15 chamadas/15min).
 *   2) POST em APP_URL/api/data/legalizacao/certificados/importar-certiseguro
 *      (o sistema na nuvem) com a lista, autenticado por token compartilhado
 *      (CERTISEGURO_SYNC_TOKEN) — não é login de usuário, é máquina-a-máquina.
 *
 * O servidor decide, por CNPJ/CPF, se é upsert de um certificado PJ de
 * cliente existente ou de um PF avulso (ver rota em server/routes/data.js).
 *
 * Segredos vêm de server/legalizacao/.env (git-ignored), mesmo padrão do
 * resto do sistema — nunca hardcode vToken/token aqui.
 *
 * Uso: node server/legalizacao/certiseguroSync.js
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

function obrigatorio(nome) {
  const v = process.env[nome];
  if (!v || !String(v).trim()) {
    throw new Error(`Variável de ambiente ${nome} não configurada (server/legalizacao/.env).`);
  }
  return String(v).trim();
}

/** Extrai o texto de uma tag simples (sem atributos) dentro de um trecho de XML. */
function tag(bloco, nomeTag) {
  const m = new RegExp(`<${nomeTag}>([\\s\\S]*?)</${nomeTag}>`, 'i').exec(bloco);
  return m ? m[1].trim() : null;
}

/**
 * A API da CertiSeguro devolve XML simples (sem atributos, sem CDATA) — dá
 * pra ler com regex, do mesmo jeito que já fazemos com o HTML do Ciclo7, sem
 * precisar de uma dependência de parser XML só pra isso.
 */
function parseListcert(xml) {
  const status = tag(xml, 'status');
  if (status !== 'OK') {
    const resposta = tag(xml, 'resposta') || 'Erro desconhecido na API da CertiSeguro.';
    throw new Error(`CertiSeguro respondeu ERROR: ${resposta}`);
  }
  const blocos = xml.match(/<certificado>[\s\S]*?<\/certificado>/gi) || [];
  return blocos.map(b => ({
    nome: tag(b, 'nome'),
    nome_amigavel: tag(b, 'nome_amigavel'),
    cnpj: tag(b, 'cnpj'),
    validade: tag(b, 'validade'),
    dt_cadastro: tag(b, 'dt_cadastro'),
  }));
}

async function buscarCertificadosCertiseguro() {
  const url = obrigatorio('CERTISEGURO_URL');       // ex.: http://192.168.X.X:8090/apicertiseguro
  const token = obrigatorio('CERTISEGURO_TOKEN');   // vToken gerado no painel "Configurar API" da CertiSeguro
  const cnpj = obrigatorio('CERTISEGURO_CNPJ');     // CNPJ do contratante (Grupo-E), não do cliente

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      vToken: token,
      vCNPJ: cnpj,
      vID: 'listcert',
    },
  });
  const texto = await resp.text();
  if (!resp.ok) {
    throw new Error(`CertiSeguro devolveu HTTP ${resp.status}: ${texto.slice(0, 300)}`);
  }
  return parseListcert(texto);
}

async function enviarParaSistema(certificados) {
  const appUrl = (process.env.APP_URL || 'https://grupo-e-sistema.onrender.com').replace(/\/+$/, '');
  const syncToken = obrigatorio('CERTISEGURO_SYNC_TOKEN'); // mesmo valor da variável CERTISEGURO_SYNC_TOKEN no Render

  const resp = await fetch(`${appUrl}/api/data/legalizacao/certificados/importar-certiseguro`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Sync-Token': syncToken },
    body: JSON.stringify({ certificados }),
  });
  const dados = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(`Sistema Grupo-E devolveu HTTP ${resp.status}: ${dados.error || JSON.stringify(dados)}`);
  }
  return dados;
}

async function main() {
  console.log('[certiseguroSync] Buscando lista de certificados na CertiSeguro...');
  const certificados = await buscarCertificadosCertiseguro();
  console.log(`[certiseguroSync] ${certificados.length} certificado(s) recebido(s). Enviando para o sistema...`);
  const resultado = await enviarParaSistema(certificados);
  console.log(`[certiseguroSync] Concluído: ${resultado.atualizados} atualizado(s), ${resultado.criados} criado(s), ${resultado.ignorados} ignorado(s) de ${resultado.total}.`);
}

if (require.main === module) {
  main().catch(err => {
    console.error('[certiseguroSync] Falhou:', err.message || err);
    process.exit(1);
  });
}

module.exports = { buscarCertificadosCertiseguro, enviarParaSistema, parseListcert };
