'use strict';
/**
 * Junta os arquivos de docs/mapa/ em um único arquivo: docs/MAPA_SISTEMA_COMPLETO.md.
 * Uso (na raiz do projeto):  node docs/gerar-documento-unico.js
 *
 * Para incluir um arquivo novo, acrescente uma linha em `partes` (a ordem aqui é a ordem no documento).
 * Os links entre arquivos .md viram "(parte N)" e os títulos de cada arquivo descem um nível.
 * O cabeçalho registra o commit do código em que o documento foi gerado: na próxima atualização,
 * `git log <commit>..HEAD --oneline` mostra tudo o que mudou desde então.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const RAIZ = path.join(__dirname, '..');
const DOCS = __dirname;

// [arquivo dentro de docs/, título da parte]
const partes = [
  ['mapa/00-inventario.md', 'Fase 1 — Inventário'],
  ['mapa/00b-rotas.md', 'Anexo A — As rotas HTTP'],
  ['mapa/00c-tabelas.md', 'Anexo B — As tabelas criadas pelo código'],
  ['mapa/cs/00-base-acesso.md', '/cs — Acesso, login e papéis'],
  ['mapa/cs/01-ingestao-vinculos-sla.md', '/cs — Ingestão do Zappy, vínculos e SLA'],
  ['mapa/cs/02-pontuacao-abandono.md', '/cs — Pontuação por ticket e abandono'],
  ['mapa/cs/03-qualidade-ocorrencias.md', '/cs — Qualidade (ocorrências, vínculos, anexos, alertas)'],
  ['mapa/cs/04-risco-de-perda.md', '/cs — Risco de perda'],
  ['mapa/cs/05-churn-categorias.md', '/cs — Churn, motivos e Categorias'],
  ['mapa/cs/06-painel-ficha-atendimento.md', '/cs — Painel, ficha do cliente e Atendimento'],
  ['mapa/cs/07-questor-omie-analise-anual.md', '/cs — Questor, Omie, Análise Anual e Honorário sugerido'],
  ['mapa/cs/08-email-sinais-auditoria-manutencao.md', '/cs — Sinais de e-mail, Logs, Backup e Limpeza'],
  ['mapa/cs/09-rotas-radar-sla-analise-inteligente.md', '/cs — Rotas do radar de SLA e Análise Inteligente'],
  ['mapa/cs/10-telas-cs.md', '/cs — Telas e experiência de uso'],
  ['mapa/gamificacao.md', 'Gamificação'],
  ['mapa/legalizacao.md', '/legalizacao'],
  ['mapa/financeiro.md', '/financeiro'],
];

// Seção "Situação deste documento": edite aqui quando um assunto novo ficar pronto.
const PRONTAS = 'inventário da Fase 1 e anexos de rotas e tabelas; módulo /cs completo (11 partes); Gamificação; /legalizacao; /financeiro.';
const PENDENTES = 'a SPA `/` (clientes, atendimentos, gestão de clientes, tickets, usuários e demais telas), o núcleo (login, usuários, backup, push), e as seções transversais (visão geral de arquitetura, matriz de permissões, integrações externas, automações e jobs, logs e auditoria, portabilidade e checklist de cobertura). Para essas áreas, valem o inventário (parte 1) e os anexos de rotas e tabelas (partes 2 e 3), que já listam tudo, sem o detalhe de regras.';

const numero = new Map(partes.map(([f], i) => [path.basename(f), i + 1]));
const ancora = (t) => t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function ajustar(txt) {
  return txt.replace(/\[([^\]]+)\]\(([^)#]*?\.md)(#[^)]*)?\)/g, (m, rot, alvo) => {
    const n = numero.get(path.basename(alvo));
    return n ? `${rot} (parte ${n})` : rot;
  });
}
function rebaixar(txt) {
  let dentroCodigo = false;
  return txt.split('\n').map((l) => {
    if (/^```/.test(l)) dentroCodigo = !dentroCodigo;
    if (!dentroCodigo && /^#{1,5} /.test(l)) return '#' + l;
    return l;
  }).join('\n');
}
function commitAtual() {
  try { return execSync('git rev-parse --short HEAD', { cwd: RAIZ, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch (e) { return null; }
}

const hoje = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
const commit = commitAtual();
let saida = '';
saida += `# Mapa do sistema Grupo-E — documento único\n\n`;
saida += `Gerado em ${hoje}${commit ? ` com o código no commit \`${commit}\`` : ''}, a partir dos arquivos de \`docs/mapa/\`. Engenharia reversa do código (servidor Node/Express + PostgreSQL, front-end em HTML/JS puro, hospedado no Render), escrita para reconstruir ou portar o sistema sem abrir o código. Idioma: pt-BR. Níveis de certeza usados em todo o texto: **[CONFIRMADO]** (lido no código), **[INFERIDO]** (deduzido), **[DÚVIDA]** (precisa de confirmação).\n\n`;
saida += `## Situação deste documento\n\n`;
saida += `**Prontas:** ${PRONTAS}\n\n`;
saida += `**Ainda não escritas:** ${PENDENTES}\n\n`;
saida += `**Limites conhecidos:** (1) \`clientes\`, \`honorarios\`, \`eventos_clientes\`, \`analistas\` e \`investimentos\` não têm \`CREATE TABLE\` no repositório; as colunas delas aqui são inferidas pelo uso, e um \`pg_dump --schema-only\` fecharia a lacuna; (2) a seção de portabilidade depende do sistema de destino, que não foi informado; (3) algumas telas do /cs (portais Gestor, Analista e Sucesso do Cliente, Minha área, Acessos) estão descritas pelo que fazem, sem o texto de cada botão; (4) nada foi testado em produção, tudo vem da leitura do código.\n\n`;
saida += `**Cuidado ao compartilhar:** o texto cita nomes de pessoas, caminhos de rede e nomes de variáveis de ambiente. Nenhum valor de segredo, senha ou token deve entrar aqui.\n\n`;
saida += `**Para atualizar:** veja \`docs/COMO_ATUALIZAR_A_DOCUMENTACAO.md\`.\n\n`;
saida += `## Sumário\n\n`;
partes.forEach(([f, t], i) => { saida += `${i + 1}. [${t}](#parte-${i + 1}-${ancora(t)})\n`; });
saida += `\n---\n\n`;

partes.forEach(([f, t], i) => {
  const corpo = fs.readFileSync(path.join(DOCS, f), 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');
  saida += `# Parte ${i + 1} — ${t}\n\n`;
  saida += `*Origem: \`docs/${f}\`*\n\n`;
  saida += ajustar(rebaixar(corpo)).trim() + '\n\n---\n\n';
});

// trava de segurança: nunca grava um documento com cara de segredo
const suspeito = saida.match(/eyJ[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{12,}|postgres(?:ql)?:\/\/[^\s:]+:[^\s@]+@|BEGIN (?:RSA )?PRIVATE KEY/);
if (suspeito) { console.error('PARADO: o texto parece conter um segredo (' + suspeito[0].slice(0, 12) + '…). Remova antes de gerar.'); process.exit(1); }

const destino = path.join(DOCS, 'MAPA_SISTEMA_COMPLETO.md');
fs.writeFileSync(destino, saida);
console.log('gravado:', destino, '|', saida.length, 'caracteres |', saida.split('\n').length, 'linhas |', commit ? 'commit ' + commit : 'sem git');
