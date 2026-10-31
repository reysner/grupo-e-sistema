# Fase 1 — Inventário do sistema Grupo-E

Gerado em 30/10/2026 a partir do código do repositório (`grupo-e-sistema-main`) e da leitura das quatro entradas web: `/`, `/cs`, `/legalizacao` e `/financeiro`. Escopo: **o sistema inteiro**. Sistema de destino: **não informado** (o roteiro trazia o campo em branco); será pedido antes da seção 14 da Fase 2.

Níveis de certeza usados: **[CONFIRMADO]** explícito no código · **[INFERIDO]** deduzido do contexto · **[DÚVIDA]** ambíguo ou contraditório.

Arquivos desta fase: este inventário, `00b-rotas.md` (as 358 rotas HTTP) e `00c-tabelas.md` (as 72 tabelas criadas pelo código).

**Como a navegação foi feita.** O navegador do app estava sem login (a sessão cai com frequência) e senhas não são digitadas por agentes. Por isso a estrutura de cada página foi lida do HTML e do JavaScript servidos (menus, seções, perfis) e não dos dados exibidos. Os dados e os comportamentos por perfil vêm do código. Não foi possível ver as telas **como gestor** e **como analista** com dados reais; o que cada perfil enxerga foi extraído das regras em `server/cs/acessos.js` e `public/js/cs-painel.js` ([CONFIRMADO] pela leitura, não pela tela).

---

## 1. Pilha tecnológica

| Camada | O que é | Origem |
| --- | --- | --- |
| Linguagem / runtime | JavaScript (CommonJS), Node.js (`engines >= 18`; README diz 22; `render.yaml` só `env: node`) | `package.json` [CONFIRMADO] |
| Servidor HTTP | Express `^4.18.3` | `package.json` |
| Banco de dados | **PostgreSQL** via `pg ^8.22` (`DATABASE_URL`) | `server/db.js` [CONFIRMADO] |
| Autenticação | `jsonwebtoken ^9` (acesso 2 h, refresh rotativo), `bcryptjs ^2.4` (12 rounds), `cookie-parser` | `server/auth.js` |
| Segurança HTTP | CORS restrito por `ALLOWED_ORIGINS`, `express-rate-limit` (300 req/min por IP), cabeçalhos manuais (`nosniff`, `X-Frame-Options: SAMEORIGIN`) | `server/index.js` |
| Compressão | `compression` | `server/index.js` |
| E-mail | `nodemailer ^8` com Gmail (`GMAIL_USER`, `GMAIL_APP_PASS`) | `server/mailer.js` |
| Notificações push | `web-push ^3.6`, chaves VAPID geradas e guardadas no banco | `server/push.js` |
| PDF | `pdf-parse ^1.1` (leitura de alvarás em PDF) | `server/legalizacao/lerAlvarasPasta.js` |
| Front-end | **HTML/CSS/JS puros, sem build** (módulos grandes: `app.js` 11.031 linhas, `cs-painel.js` 4.304, `legalizacao.js` 890, `financeiro.js` 827) | `public/` |
| PWA | `public/sw.js` (service worker de push) | `public/sw.js` |
| Hospedagem | Render (web service, plano free, `healthCheckPath: /health`, keep-alive a cada 14 min) | `render.yaml`, `server/index.js` |
| Rotinas locais | PowerShell + Agendador de Tarefas do Windows, scripts Node e **userscripts do Tampermonkey** | `server/*/agendar*.ps1`, `public/tools/*.user.js` |
| Testes | Scripts Node com `assert` (`testes_*.js`), sem framework; executados à mão | `server/**/testes_*.js` |

**Não existe:** pasta de migrations, `.env.example` (o README manda copiar um), Dockerfile, CI, linter, TypeScript, front-end componentizado. [CONFIRMADO] por listagem.

**Inconsistências já visíveis na pilha** (detalhe na Fase 2, seção 15):
- O README descreve **SQLite nativo do Node 22** e token de acesso de **15 min**; o código usa **PostgreSQL** e token de **2 h**. O README está desatualizado. [CONFIRMADO]
- `render.yaml` e `certiseguroSync.js` usam o host `grupo-e-sistema.onrender.com`; o sistema em uso responde em `grupo-e-sistema-uc2w.onrender.com`. [DÚVIDA] qual é o valor real de `APP_URL` em produção.
- `server/cs/schema_cs.sql` diz "Rodar no Supabase → SQL Editor", mas nada no código usa o SDK do Supabase; o banco é acessado só por `pg`. [INFERIDO] histórico de migração.

---

## 2. Árvore de pastas comentada

```text
grupo-e-sistema-main/
├── package.json, render.yaml          dependências e deploy no Render
├── README.md                          desatualizado (fala de SQLite)
├── docs/mapa/                         esta documentação
├── public/                            front-end estático servido pelo Express
│   ├── index.html + js/app.js         SPA do painel principal (/) — 18 páginas internas
│   ├── cs-painel.html + js/cs-painel.js + css/cs-painel.css   Painel do Sucesso do Cliente (/cs)
│   ├── legalizacao-publica.html + js/legalizacao.js           Legalização (/legalizacao)
│   ├── financeiro.html + js/financeiro.js                     Financeiro (/financeiro)
│   ├── pesquisa.html                  pesquisa de satisfação pública (/pesquisa)
│   ├── gamificacao*.html              ranking, regras e admin antigo da Gamificação
│   ├── cs-como-funciona.html, cs-regras-sla.html, legalizacao-regras.html   guias públicos
│   ├── contabil.html                  portal do contábil (login próprio)
│   ├── minha-nota.html, qualidade.html, legalizacao-antiga.html            telas antigas/redirecionadas
│   ├── reset-password.html            redefinição de senha
│   ├── sw.js                          service worker (push)
│   ├── tools/*.user.js                userscripts Tampermonkey (procurações, REDESIM, Protocolo Online)
│   └── css/, img/, modelos/           estilos, imagens (prêmios), planilha-modelo de importação
└── server/
    ├── index.js                       montagem do Express, jobs agendados, páginas
    ├── db.js, auth.js, reset.js, mailer.js, push.js
    ├── acessoriasClient.js            cliente da API do Acessórias
    ├── routes/                        data.js (6.728 linhas, 172 rotas: clientes, Gamificação, Legalização, tickets, backup…), auth, users, analistas, grupos-empresas, unidades, motivos-churn, gamificacao (não montado)
    ├── cs/                            Sucesso do Cliente: ingestão Zappy, SLA, pontuação, abandono, risco, churn, categorias, qualidade (ocorrências), acessos, auditoria, e-mail, Questor, Omie
    ├── financeiro/                    inadimplência, suspensos, cobranças
    ├── legalizacao/                   alvarás, certificados, procurações, portais de prefeituras, OCR, CertiSeguro
    ├── emailSinais/                   leitura de metadados de e-mail (job local)
    ├── questor/                       extração de faturamento/funcionários (job local, VPN)
    ├── omie/                          scripts de console para exportar honorários/contratos
    ├── arquivoMorto/                  rotina local que arquiva pastas de empresas inativadas
    └── backups/                       cópia manual de dados da Gamificação (JSON)
```

---

## 3. Módulos e submódulos

### 3.1 Núcleo (transversal)
Autenticação e sessão, usuários e perfis, redefinição de senha por e-mail, acessos por módulo (`/cs`), notificações push, notificações no "sino", Log de atividades, backup automático, importação de planilhas.

### 3.2 Painel principal — `/` (SPA, `public/index.html`) — 18 páginas
Menu lido do HTML. **Todos os perfis logados:** Dashboard, Atendimento, Gestão de Clientes, Insatisfação, Clientes Sensíveis, Pesquisas, Recuperação, Link da Pesquisa, Meu Perfil, Administração (a página existe no HTML sem a marca `admin-only`; o menu e as rotas restringem — [DÚVIDA] a conferir na Fase 2). **Só administrador (`admin-only`):** Carteira, CAC / Investimentos, Legalização, Financeiro, Gamificação, Tickets, Sucesso do Cliente, Análise Inteligente, Log de Atividades.

### 3.3 Sucesso do Cliente — `/cs` (`public/cs-painel.html`) — 19 seções
Menu e agrupamento lidos do HTML:

| Grupo | Seção (`data-sec`) | Módulo (código em Acessos) |
| --- | --- | --- |
| Topo | Visão Geral (`visao`) | `visao` |
|  | Análise Inteligente (`analise`) | `inteligente` |
|  | Análise Anual (`anual`) | `anual` |
|  | Atendimento (`atendimento`) | `atendimento` |
|  | Portal do Analista (`analista`) | `analista` |
|  | Qualidade (`consideracoes`) | `qualidade` |
|  | Prioridades (`minhasprior`) | `minhas_prioridades` |
|  | Portal do Gestor (`gestor`) | `gestor` |
|  | Portal do Sucesso do Cliente (`sucesso`) | `sucesso` |
| Minha área | Minha nota (`minhanota`) | `minha_nota` |
|  | Meus atendimentos (`meusatend`) | `meus_atendimentos` |
|  | Meus e-mails (`meusemails`) | `meus_emails` |
|  | Evolução semanal (`minhaevolucao`) | `minha_evolucao` |
|  | Gamificação (`gamificacao`) | `gamificacao` |
| Indicadores | Gestão da Permanência (`risco`) | `permanencia` |
|  | Churn (`churn`) | `churn` |
|  | Categorias (`categorias`) | `categorias` |
| Administração | Acessos (`acessos`) | `acessos` (só administrador) |
| Conferência | Qualidade dos Dados (`qualidade`) | `qualidade_dados` |

**Quem vê o quê no `/cs`** ([CONFIRMADO] `server/cs/acessos.js → modulosPadrao`, `public/js/cs-painel.js → perfilDe`):
- **Administrador:** todos os módulos mais Acessos. O menu pode ser personalizado, mas "Acessos" ele sempre tem.
- **Equipe do painel** (`role = usuario` ou `acesso_cs`): os 8 módulos de indicadores + Qualidade + Gamificação + Portal do Sucesso do Cliente.
- **Gestor** (`acesso_gestor` ou registrado em `cs_qualidade_gestores`): Qualidade + Gamificação + Portal do Gestor.
- **Analista** (`acesso_qualidade` ou login ligado a um analista): Qualidade + Gamificação + Portal do Analista + a Minha área (nota, atendimentos, e-mails, evolução, prioridades).
- Quem tem lista de módulos gravada em `cs_acessos` vê **exatamente** a lista; as rotas recusam (403) o que não está nela.

Submódulos do motor do `/cs`: ingestão de tickets do Zappy, motor de SLA, pontuação por ticket (Gamificação), abandono de atendimento, vínculos de contatos, sinais de e-mail, risco de perda (termômetros Financeiro, Atendimento e Operacional), churn (saídas e motivos), categorias (Diamante/Ouro/Prata/Bronze), Análise Anual (Questor), honorário sugerido (Omie), alertas de prazo, auditoria.

### 3.4 Qualidade (ocorrências) — dentro do `/cs`
Registro de ocorrências, tratativa pelo gestor do departamento, vínculos (inclusive entre departamentos), notas e observações com anexos, validação, devolutiva ao cliente e encerramento pelo Gestor final. Arquivo principal: `server/cs/qualidade.js` (2.157 linhas, 53 rotas).

### 3.5 Gamificação (Liga do Atendimento)
Notas mensais por colaborador, revisões (nota baixa, velocidade, aceite, finalizar, abandono), Consolidado Geral da temporada, férias, mês fechado, relatório e apresentação da temporada, ranking público e regras públicas. Código em `server/routes/data.js` (+ `server/cs/pontuacao.js`, `abandono.js`) e `public/js/app.js`.

### 3.6 Legalização — `/legalizacao` (`legalizacao-publica.html`) — 10 seções
Visão Geral, Prioridades, Alvarás de funcionamento, Alvarás sanitários, Certificados digitais, Procurações, Todos os clientes (Carteira), Solicitações, Evolução semanal, Qualidade dos dados. Acesso por login próprio (`acesso_legalizacao`) ou administrador.

### 3.7 Financeiro — `/financeiro` (`financeiro.html`) — 8 seções
Visão Geral, Oportunidades, Inadimplentes, Suspensos, Carteira, Evolução, Cobranças, Qualidade dos dados. Valores em R$ só para administrador e `acesso_financeiro`; `acesso_cs` e `acesso_financeiro_sv` veem sem valores.

### 3.8 Páginas públicas e antigas
`/pesquisa` (pesquisa de satisfação, sem login), `/gamificacao/ranking`, `/gamificacao/regras`, `/cs/como-funciona`, `/cs/sla`, `/legalizacao/regras` (guias sem login), `/contabil` (login próprio), `/legalizacao-antiga`, `reset-password.html`. **Redirecionamentos:** `/gamificacao` → `/cs?aba=gamificacao`, `/minha-nota` → `/cs?aba=minhanota`, `/qualidade` → `/cs?aba=analista`, `/financiero` → `/financeiro` (301).

### 3.9 Rotinas locais (fora do Render)
Leitura de e-mail (`server/emailSinais`), Questor mensal e anual (`server/questor`), exportação do Omie (`server/omie`, scripts rodados no navegador), Arquivo Morto (`server/arquivoMorto`), leitura de alvarás em pastas de rede, consulta de prefeituras, sincronizações de procurações, REDESIM e Protocolo Online (userscripts). Todas falam com o sistema por rotas protegidas por **token de sincronização** (`LEGALIZACAO_SYNC_TOKEN` / `CERTISEGURO_SYNC_TOKEN`).

---

## 4. Tabelas / entidades

**72 tabelas criadas pelo código** (lista, local de criação e colunas acrescentadas em `00c-tabelas.md`), por grupo:

| Grupo | Qtde | Exemplos |
| --- | --- | --- |
| Autenticação, usuários, acessos, push, logs, backup | 9 | `users`, `refresh_tokens`, `reset_tokens`, `cs_acessos`, `push_assinaturas`, `log_atividades`, `backups_automaticos` |
| Painel principal (`/`) | 12 | `atendimentos`, `gestao_clientes`, `insatisfacoes`, `clientes_sensiveis`, `pesquisas`, `recuperacoes`, `tickets`, `grupos_empresas`, `unidades`, `motivos_churn` |
| Sucesso do Cliente (`/cs`) | 22 | `cs_qualidade_*` (7), `cs_email_*` (4), `cs_*_tratamentos` (3), `cs_painel_config`, `acessorias_tags`, `cliente_tags`, `cliente_entregas_resumo`, `omie_*` (2), `questor_*` (2) |
| Gamificação | 12 | `gam_colaboradores`, `gam_notas`, `gam_config`, `gam_tickets_pontos`, `gam_ferias`, `gam_nota_final_override`, `gam_qualificacao_mapa`, `gam_*_revisoes` (3), `gam_meses_fechados`, `gam_abandono_incidentes` |
| Financeiro | 6 | `financeiro_titulos`, `financeiro_clientes`, `financeiro_aberto`, `financeiro_pontualidade`, `financeiro_historico`, `financeiro_importacoes` |
| Legalização | 10 | `legalizacao_alvaras`, `_certificados`, `_procuracoes`, `_protocolos`, `_rotinas`, `_solicitacoes_*`… |
| Notificações (sino) | 1 | `notificacoes` (criada por `server/cs/qualidade.js`) |

**Tabelas fora do padrão "criar se não existir" no código** (o esquema delas não está versionado de forma completa):
- **7 tabelas em `server/cs/schema_cs.sql`**, rodado à mão: `cs_vinculos`, `cs_tickets`, `cs_mensagens`, `cs_calendario`, `cs_analises`, `cs_scores`, `cs_config`. O código acrescenta colunas a `cs_tickets` por `ALTER` (analista, revisão de nota, abandono). [CONFIRMADO]
- **4 tabelas usadas sem nenhum `CREATE` no repositório:** `clientes` (a carteira, central para quase tudo; recebe 23 colunas por `ALTER`), `analistas`, `eventos_clientes`, `investimentos`. [CONFIRMADO] busca em todo o repositório. [DÚVIDA] onde e como foram criadas; sem o esquema delas não dá para recriar o sistema só pelo código.
- **Tabelas de código morto:** `server/routes/gamificacao.js` consulta `gamificacao_colaboradores`, `gamificacao_notas` e `gamificacao_premios`, que não existem em lugar nenhum, e o arquivo **não é montado** em `index.js` (é importado e nunca usado). [CONFIRMADO]

---

## 5. Rotas de API e endpoints

**358 rotas** declaradas (lista completa com caminho final, linha e tipo de acesso em `00b-rotas.md`):

| Arquivo | Rotas | Prefixo |
| --- | --- | --- |
| `server/routes/data.js` | 172 | `/api/data` e `/api/public` |
| `server/cs/qualidade.js` | 53 | `/api/cs/painel/qualidade` |
| `server/cs/routes.js` | 27 | `/api/cs` |
| `server/index.js` | 19 | páginas, `/health` e redirecionamentos |
| `server/routes/gamificacao.js` | 8 | **não montado** |
| `server/cs/churnSaidas.js`, `painel.js`, `risco.js` | 6 cada | `/api/cs/churn`, `/api/cs/painel`, `/api/cs/risco` |
| `server/routes/users.js` | 6 | `/api/users` |
| `server/cs/auditoria.js`, `server/routes/auth.js` | 5 cada | `/api/cs/painel/admin`, `/api/auth` |
| `server/cs/categorias.js`, `server/financeiro/rotas.js` | 4 cada | `/api/cs/categorias`, `/api/financeiro` |
| `server/routes/analistas.js`, `grupos-empresas.js`, `motivos-churn.js`, `unidades.js` | 4 cada | listas de apoio |
| `server/cs/anualQuestor.js`, `churnMotivos.js`, `emailSinais.js`, `push.js`, `reset.js` | 3 cada | vários |
| `server/cs/acessos.js`, `honorarioSugerido.js` | 2 cada | |
| `server/cs/omieHonorarios.js`, `questorDados.js` | 1 cada | |

Três famílias de acesso: **pública** (`/api/public`, sem login), **token de sincronização** (`X-Sync-Token`, usada pelas rotinas locais) e **login** (JWT em cabeçalho `Authorization`), com `requireAdmin` em parte delas. O `/api/cs/painel` passa antes por um filtro de módulos (`acessos.restringir`).

---

## 6. Telas e páginas (as quatro entradas pedidas + as demais)

| Entrada | Arquivo | Telas internas | Quem acessa |
| --- | --- | --- | --- |
| `/` | `index.html` | 18 páginas (seção 3.2) | login; metade só administrador |
| `/cs` | `cs-painel.html` | 19 seções (seção 3.3) | por módulo (Acessos); Gestores e Analistas veem subconjuntos |
| `/legalizacao` | `legalizacao-publica.html` | 10 seções (3.6) | `acesso_legalizacao` ou administrador |
| `/financeiro` | `financeiro.html` | 8 seções (3.7) | administrador, `acesso_financeiro`, `acesso_financeiro_sv`, `acesso_cs` |
| `/pesquisa` | `pesquisa.html` | formulário de satisfação | público |
| `/gamificacao/ranking`, `/gamificacao/regras` | `gamificacao.html`, `gamificacao-regras.html` | ranking e regras | público (o ranking também embutido no `/cs`) |
| `/cs/como-funciona`, `/cs/sla`, `/legalizacao/regras` | guias | documentação do analista, SLA e Legalização | público |
| `/contabil` | `contabil.html` | portal do contábil | login próprio (`role = contabil`) |
| `/legalizacao-antiga` | `legalizacao-antiga.html` | tela antiga em tabela única | [DÚVIDA] ainda em uso? |
| (arquivadas) | `minha-nota.html`, `qualidade.html`, `gamificacao-admin.html` | substituídas pelo `/cs` | redirecionadas ou sem rota |

---

## 7. Integrações externas

| Serviço | Para quê | Onde no código |
| --- | --- | --- |
| **Zappy** (`api-escritorial.zapcontabil.chat`) | tickets, mensagens, avaliações do cliente, usuários | `server/cs/zappyClient.js`, `ingestao.js` (`ZAPPY_BASE_URL`, `ZAPPY_TOKEN`) |
| **Acessórias** (`api.acessorias.com`) | carteira de clientes, TAGs, motivos de cancelamento, entregas, solicitações | `server/acessoriasClient.js` (`ACESSORIAS_API_TOKEN`) |
| **Omie** | contratos, contas a receber, honorários (exportação em scripts de console; carga por token) | `server/omie/*`, `server/cs/omieHonorarios.js`, `risco.js` |
| **Questor** (nWeb/VPN) | faturamento anual, 12 meses e funcionários | `server/questor/*`, `server/cs/anualQuestor.js`, `questorDados.js` (`QUESTOR_NWEB`, `QUESTOR_TOKEN_API`) |
| **CertiSeguro** (`app.certiseguro.com.br`) | lista de certificados digitais (IP liberado) | `server/legalizacao/certiseguroSync.js` (`CERTISEGURO_URL/TOKEN/CNPJ`) |
| **Protocolo Online / Ciclo7 Uberlândia** | situação de alvarás e protocolos | `public/tools/sincronizar-protocolo-online.user.js`, `ciclo7Uberlandia.js` |
| **Prefeituras e órgãos** (BH, Uberaba, Contagem, Campinas, SP, Rio, Ribeirão Preto, cidades de MG/GO, SIVISA) | consulta de alvará | `server/legalizacao/portaisPrefeituras.js`, `belohorizonte.js`, `uberaba.js` |
| **REDESIM**, **e-CAC** (procurações) | sincronização por userscript | `public/tools/*.user.js` |
| **Receita via BrasilAPI e minhareceita.org** | situação e município do CNPJ | `server/cs/churnSaidas.js`, `legalizacao/municipioCnpj.js`, `questor/extrairAnual.js` |
| **IBGE** (`servicodados.ibge.gov.br`) | código do município | `server/routes/data.js` |
| **Google (Gmail API e Admin SDK)** | leitura de metadados de e-mail por conta de serviço (delegação de domínio) | `server/emailSinais/coletar.js` (`GMAIL_CHAVE_JSON`, `GMAIL_ADMIN`) |
| **Gmail SMTP** | e-mail de recuperação de senha e relatórios | `server/mailer.js` (`GMAIL_USER`, `GMAIL_APP_PASS`) |
| **Web Push** | avisos no navegador | `server/push.js` (VAPID no banco) |
| **Render / GitHub** | hospedagem e deploy por `git push` | `render.yaml` |

**Variáveis de ambiente** encontradas (nomes apenas; 32 pelo acesso direto, mais as acessadas por nome dinâmico): `DATABASE_URL`, `JWT_SECRET`, `JWT_REFRESH_SECRET`, `NODE_ENV`, `PORT`, `APP_URL`, `ALLOWED_ORIGINS`, `ADMIN_EMAIL`, `ADMIN_PASS`, `ADMIN_NAME`, `ZAPPY_BASE_URL`, `ZAPPY_TOKEN`, `ACESSORIAS_API_TOKEN`, `GMAIL_USER`, `GMAIL_APP_PASS`, `GMAIL_CHAVE_JSON`, `GMAIL_ADMIN`, `LEGALIZACAO_SYNC_TOKEN`, `CERTISEGURO_SYNC_TOKEN`, `CERTISEGURO_URL`, `CERTISEGURO_TOKEN`, `CERTISEGURO_CNPJ`, `LEGALIZACAO_CONSULTA_NO_SERVIDOR`, `LEGALIZACAO_PASTA`, `QUESTOR_NWEB`, `QUESTOR_TOKEN_API`, `PDFTOPPM_PATH`, `ARQUIVO_MORTO_*` (6), `EMAIL_MAPA_CACHE`, `EMAIL_APRENDIDOS`, `EMAIL_CACHE_DIR`, `DEBUG_CICLO7`, `DBG`. Obrigatórias, valores e uso por ambiente ficam para a Fase 2, seção 2.

---

## 8. Jobs agendados e processos em background

**No servidor (Render), em `server/index.js` e `server/routes/data.js`** [CONFIRMADO]:

| Gatilho | O que faz | Condição |
| --- | --- | --- |
| a cada 14 min | auto-ping em `APP_URL/health` (evita o plano free dormir) | `APP_URL` definida |
| a cada 24 h | apaga tokens de sessão vencidos | sempre |
| a cada 10 min, só às 8h (Brasília) | alerta de prazo das ocorrências da Qualidade | sempre |
| a cada 5 min | ingestão de tickets do Zappy | `ZAPPY_BASE_URL` e `ZAPPY_TOKEN` |
| 08h, 11h, 15h | atualiza notas pendentes e aplica o auto-preencher da Gamificação do mês corrente | idem |
| 07h e 13h | lê a lista de certificados da CertiSeguro | idem |
| 08h | verifica vencimentos da Legalização (alvará 60 dias, certificado 10 dias) | idem |
| 02h | consulta noturna de alvarás nas prefeituras | **desligada** salvo `LEGALIZACAO_CONSULTA_NO_SERVIDOR=1` |
| a cada 1 h | saúde das rotinas locais da Legalização (avisa no sino) | idem |
| a cada 10 min | confere se é hora do backup automático e, se for, grava em `backups_automaticos` (`rodarBackupAutomaticoSeNecessario`) | sempre |
| a cada 24 h | sincroniza a carteira com o Acessórias e, em seguida: TAGs, motivos de cancelamento, classificação de saídas pela Receita, entregas (200 empresas por rodada), foto diária do risco | `ACESSORIAS_API_TOKEN` |
| a cada 6 h | completa o município dos clientes (700 por vez) | idem |

**Fora do servidor (estação Windows / navegador)**: leitura de e-mail (diária, `emailSinais/agendar.ps1`), Questor mensal e anual (`questor/agendar*.ps1`), Arquivo Morto (20h), leitura de alvarás em pastas (05h), consulta às prefeituras (semanal, segunda 08h30), userscripts semanais (procurações, REDESIM, Protocolo Online). [INFERIDO] horários a partir dos comentários do código; a Fase 2 confirma cada um.

---

## 9. Achados da Fase 1 que afetam a reconstrução

1. **Esquema incompleto no repositório:** `clientes`, `analistas`, `eventos_clientes` e `investimentos` não têm `CREATE`; `schema_cs.sql` é manual. Sem o esquema real do banco de produção, a seção 4 da Fase 2 ficará parcial para essas tabelas. **Pedido:** um `pg_dump --schema-only` do banco (sem dados).
2. **Código morto:** `routes/gamificacao.js` (8 rotas) e três tabelas `gamificacao_*` inexistentes; `routerAnalista` da Qualidade desligado desde 17/10/2026; `legalizacao-antiga`, `minha-nota.html`, `qualidade.html`.
3. **Concentração de lógica:** `server/routes/data.js` tem 6.728 linhas e mistura clientes, Gamificação, Legalização, tickets, backup e importações. É o maior risco de portabilidade.
4. **Regras duplicadas entre front e back:** perfis e módulos são decididos em `cs-painel.js` (`perfilDe`, `SEC_MODULO`) **e** em `acessos.js`; o servidor é a fonte de verdade, mas há duas cópias da lista de módulos.
5. **Segredos e acessos:** o README ainda lista um usuário e senha padrão; o código atual recusa criar o administrador sem `ADMIN_PASS`. Sem `JWT_SECRET`, o servidor gera um segredo aleatório a cada boot (sessões caem a cada reinício). [CONFIRMADO]
6. **Dependência de máquinas locais:** vários fluxos só funcionam com uma estação do escritório ligada (VPN do Questor, IP liberado da CertiSeguro, pastas de rede de alvarás).

## 10. O que a Fase 2 vai precisar de você

- O **sistema de destino** (pilha) e se será multiempresa; o roteiro trazia o campo em branco.
- O esquema real do banco (`pg_dump --schema-only`) ou acesso de leitura para eu extraí-lo.
- Confirmação do escopo: **o sistema inteiro** ou um módulo (por exemplo só o `/cs`), já que o documento completo é muito grande (estimativa: 16 seções, dezenas de milhares de linhas).
- Acesso de **gestor e analista de teste** para ver as telas deles com dados (senão a seção 8 sai só do código).
