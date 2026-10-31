# Grupo-E — Sistema de Gestão de Clientes

Sistema web interno do Grupo-E: gestão de clientes e atendimentos, Sucesso do Cliente (SLA, risco de perda, churn, Qualidade), Gamificação do atendimento, Legalização (alvarás, certificados e procurações) e Financeiro (inadimplência e cobranças).

> **Documentação completa:** [`docs/MAPA_SISTEMA_COMPLETO.md`](docs/MAPA_SISTEMA_COMPLETO.md) (engenharia reversa do sistema, por módulo) e [`docs/MIGRACAO_DE_MAQUINA.md`](docs/MIGRACAO_DE_MAQUINA.md) (como refazer tudo em outra máquina ou servidor).

## Stack

- **Servidor:** Node.js (18 ou superior; recomendado 22) + Express.
- **Banco:** PostgreSQL (`pg`), conexão por `DATABASE_URL`. As tabelas são criadas pelo próprio código na subida (`CREATE TABLE IF NOT EXISTS`), **exceto** `clientes`, `honorarios`, `eventos_clientes`, `analistas` e `investimentos`, que só existem no banco atual: para um ambiente novo, restaure um dump (veja o guia de migração).
- **Front-end:** HTML, CSS e JavaScript puro, sem etapa de build (`public/`).
- **Login:** JWT de acesso (2 horas) + refresh token rotativo (30 dias), guardados no navegador; senhas com bcrypt (12 rounds); limite de tentativas de login (20 a cada 15 minutos por IP) e de requisições (300 por minuto).
- **Hospedagem:** Render (`render.yaml`), com auto-ping a cada 14 minutos para o plano gratuito não adormecer.

## Páginas

| Endereço | Para quê | Quem entra |
| --- | --- | --- |
| `/` | sistema principal: clientes, atendimentos, gestão, tickets, usuários, Gamificação (administração) | administrador e usuário |
| `/cs` | Sucesso do Cliente: visão geral, risco, churn, categorias, Qualidade, portais do Gestor, do Analista e do Sucesso, Minha área | equipe (por módulos liberados em **Acessos**) |
| `/legalizacao` | alvarás, certificados digitais e procurações | administrador e quem tem `acesso_legalizacao` |
| `/financeiro` | inadimplência, suspensos, cobranças e carteira | administrador, usuário e quem tem `acesso_financeiro`, `acesso_cs` ou `acesso_financeiro_sv` |
| `/gamificacao/ranking`, `/gamificacao/regras` | ranking mensal e regras (sem login) | público |
| `/pesquisa` | pesquisa de satisfação (sem login) | público |
| `/cs/sla`, `/cs/como-funciona`, `/legalizacao/regras` | guias de cada módulo (sem login) | público |
| `/contabil` | portal do usuário contábil | login próprio |

Toda checagem de acesso é feita pelo servidor; as telas só escondem o que a pessoa não pode usar.

## Rodando localmente

```bash
git clone https://github.com/reysner/grupo-e-sistema.git
cd grupo-e-sistema
npm install
```

Crie um arquivo `.env` na raiz (ele é lido por `dotenv`) com, no mínimo:

```
DATABASE_URL=postgres://usuario:senha@localhost:5432/grupoe   # um banco PostgreSQL seu, de teste
JWT_SECRET=<valor longo e aleatório>
JWT_REFRESH_SECRET=<outro valor longo e aleatório>
ADMIN_PASS=<senha do administrador inicial>
```

```bash
npm start        # ou: npm run dev (reinicia ao salvar)
# http://localhost:3000
```

- O administrador inicial é criado **somente se `ADMIN_PASS` estiver definida** (e-mail `admin@grupoe.com.br`, ou o de `ADMIN_EMAIL`). **Não existe senha padrão.** Sem `ADMIN_PASS`, o servidor sobe sem criar o administrador e avisa no log.
- Sem `JWT_SECRET`/`JWT_REFRESH_SECRET` o servidor sobe com valores aleatórios (todos são deslogados a cada reinício).
- Sem `ZAPPY_BASE_URL` e `ZAPPY_TOKEN` as rotinas de atendimento não rodam; sem `ACESSORIAS_API_TOKEN` não há sincronização de clientes. As demais variáveis estão no guia de migração.
- **Não aponte o ambiente local para o banco de produção.**

Testes sem banco (exemplos): `node server/testes_gam_ferias.js`, `node server/financeiro/testes_financeiro.js`, `node server/emailSinais/testes_email_sinais.js`, `node server/cs/testes_acessos.js`. Não há `npm test` único.

## Deploy no Render

1. Crie um **Web Service** a partir deste repositório. O `render.yaml` define: build `npm install`, start `node server/index.js`, health check `/health`, porta 3000.
2. Crie o PostgreSQL e configure `DATABASE_URL` (com `NODE_ENV=production` a conexão usa SSL).
3. Em **Environment**, configure as variáveis (lista completa, com a função de cada uma, em [`docs/MIGRACAO_DE_MAQUINA.md`](docs/MIGRACAO_DE_MAQUINA.md), seção 4): `NODE_ENV`, `DATABASE_URL`, `JWT_SECRET`, `JWT_REFRESH_SECRET`, `ADMIN_PASS`, `APP_URL`, `ALLOWED_ORIGINS`, `ACESSORIAS_API_TOKEN`, `ZAPPY_BASE_URL`, `ZAPPY_TOKEN`, `LEGALIZACAO_SYNC_TOKEN`/`CERTISEGURO_SYNC_TOKEN`, `CERTISEGURO_URL`, `CERTISEGURO_TOKEN`, `CERTISEGURO_CNPJ`, `GMAIL_USER`, `GMAIL_APP_PASS`.
4. Depois do deploy, entre com o administrador e confira as páginas `/cs`, `/legalizacao` e `/financeiro`.

O `render.yaml` só declara parte das variáveis; as demais são configuradas à mão no painel e **não** estão no repositório.

## O que roda fora do servidor

Algumas rotinas dependem de acessos que o Render não tem (VPN do Questor, compartilhamento de arquivos do escritório, login de uma pessoa, IP liberado em terceiros) e rodam numa estação Windows do escritório ou em scripts de navegador:

| Rotina | Pasta |
| --- | --- |
| Consulta às prefeituras, leitura de alvarás em PDF (com OCR), CertiSeguro de reserva | `server/legalizacao/` |
| Sinais de e-mail (só cabeçalhos das caixas) | `server/emailSinais/` |
| Extrações do Questor (faturamento e funcionários) | `server/questor/` |
| Leitura do Omie (honorários, títulos em aberto, contratos suspensos) | `server/omie/` |
| Arquivo Morto de empresas inativadas | `server/arquivoMorto/` |
| Procurações (e-CAC e FGTS), Protocolo Online e Redesim | `public/tools/*.user.js` (Tampermonkey) |

Cada pasta tem seu `LEIA-ME`/`README` com o uso. O agendamento dessas rotinas está no Agendador de Tarefas do Windows da estação (não é versionado); como refazê-lo está em [`docs/MIGRACAO_DE_MAQUINA.md`](docs/MIGRACAO_DE_MAQUINA.md).

## Segurança

| Item | Como é |
| --- | --- |
| Senhas | bcrypt, 12 rounds |
| Sessão | JWT de acesso (2 h) + refresh token rotativo (30 dias, uso único); o logout revoga o refresh |
| Acesso | cada rota confere o perfil e as marcas de acesso no servidor (`requireAuth`, `requireAdmin` e as regras de cada módulo) |
| CORS | lista de origens em `ALLOWED_ORIGINS` |
| Cabeçalhos | `X-Content-Type-Options`, `X-Frame-Options: SAMEORIGIN`, `X-XSS-Protection` |
| Limites | login 20 por 15 min por IP; 300 requisições por minuto |
| SQL | consultas parametrizadas |
| Rotinas de máquina | token de sincronização (`X-Sync-Token`) compartilhado entre o servidor e as rotinas do escritório |
| Segredos | nunca no repositório: variáveis do Render e arquivos `.env` git-ignorados |

Pontos de melhoria já mapeados (mesmo token de sincronização para várias rotinas, falhas abertas em rotas antigas, rota de limpeza de dados de teste ativa) estão descritos em `docs/MAPA_SISTEMA_COMPLETO.md`.

## Estrutura

```
grupo-e-sistema/
├── server/
│   ├── index.js             entrada Express: rotas, jobs e agenda diária
│   ├── db.js, auth.js       banco e login
│   ├── routes/              auth, data (clientes, gamificação, legalização, tickets…), users…
│   ├── cs/                  Sucesso do Cliente: ingestão do Zappy, SLA, risco, churn, Qualidade
│   ├── financeiro/          página /financeiro
│   ├── legalizacao/         rotinas da estação + regras da Legalização
│   ├── emailSinais/ questor/ omie/ arquivoMorto/   rotinas locais
│   └── testes_*.js          testes avulsos
├── public/                  páginas, css, js e tools/ (scripts de navegador)
├── docs/                    documentação (mapa do sistema e guia de migração)
├── render.yaml
└── package.json
```
