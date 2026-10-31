# Núcleo — servidor, login, perfis, usuários, avisos, backups e rotinas automáticas

Cobre `server/index.js` (435 linhas), `server/db.js`, `server/auth.js`, `server/routes/auth.js`, `server/routes/users.js`, `server/reset.js`, `server/mailer.js`, `server/push.js` + `public/sw.js`, as listas canônicas (`routes/analistas.js`, `grupos-empresas.js`, `unidades.js`, `motivos-churn.js`), o log de atividades, as notificações do sino e os backups do SPA (em `server/routes/data.js`). A SPA `/` (telas) está em [spa-principal.md](spa-principal.md) (parte seguinte).

Níveis de certeza: [CONFIRMADO] (lido no código) · [INFERIDO] · [DÚVIDA].

## 1. Visão

Um único processo Node/Express serve (a) as páginas estáticas de `public/`, (b) a API `/api/*` e (c) as rotinas agendadas, todas dentro do mesmo processo com `setInterval`. O banco é PostgreSQL (`pg`, `DATABASE_URL`; SSL ligado quando `NODE_ENV=production`). Não há fila de tarefas nem processo separado de rotinas: **se o processo reinicia, os temporizadores recomeçam do zero**, e como o Render gratuito adormece e acorda, "diário" significa "a cada 24 h contadas do último boot" nas rotinas sem horário fixo.

## 2. Montagem do servidor (`index.js`)

- **Cabeçalhos:** `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN` (o ranking da Gamificação é embutido no /cs), `X-XSS-Protection`. **Sem Helmet** e sem política de conteúdo (CSP). [CONFIRMADO]
- **CORS:** só as origens de `ALLOWED_ORIGINS` (padrão `http://localhost:3000`); requisição sem `Origin` passa.
- **Corpo:** JSON de até 100 KB, exceto `/api/cs/questor/anual` (5 MB), `/api/cs/omie/honorarios` (3 MB) e `/api/cs/email-sinais` (4 MB). `compression` (gzip), `cookie-parser` (os cookies não são usados para a sessão), `trust proxy = 1`.
- **Limite global:** 300 requisições por minuto por IP; **login/cadastro:** 20 por 15 minutos por IP.
- **Keep-alive:** com `APP_URL` definido, o servidor chama o próprio `/health` a cada 14 minutos (evita adormecer no plano gratuito).
- **Ordem das rotas** (importa: as primeiras vencem): `/api/public`, `/api/auth` (recuperação de senha e depois login), `/api/data`, `/api/users`, `/api/cs/categorias`, o filtro de módulos `/api/cs/painel`, os sub-roteadores de `/api/cs/painel/*`, `/api/push`, `/api/cs/churn`, `/api/cs/risco`, as cargas (`/api/cs/questor…`, `/api/cs/omie…`), `/api/financeiro`, `/api/cs/email-sinais`, `/api/cs/painel` (painel), `/api/cs`, `/api/analistas`, `/api/grupos-empresas`, `/api/unidades`, `/api/motivos-churn`. O roteador `routes/gamificacao.js` é importado e **nunca montado** (código morto).
- **Páginas servidas:** `/pesquisa`, `/gamificacao` (redireciona ao /cs), `/gamificacao/ranking`, `/gamificacao/regras`, `/contabil`, `/minha-nota` e `/qualidade` (redirecionam ao /cs), `/legalizacao`, `/legalizacao-antiga`, `/legalizacao/regras`, `/cs`, `/cs/como-funciona`, `/cs/sla`, `/financeiro` (e `/financiero` → 301). Arquivos de `/js` e `/css` com MIME fixo; `express.static(public, maxAge 0, sem etag)`; **qualquer outro caminho devolve `index.html`** (a SPA).
- **Erro:** handler final devolve `500 { error: 'Erro interno do servidor.' }`.

### 2.1 Subida
1. `initDB()` cria **só** as tabelas-base (`users`, `refresh_tokens`, `atendimentos`, `gestao_clientes`, `insatisfacoes`, `clientes_sensiveis`, `pesquisas`, `recuperacoes`), troca a restrição de papéis e acrescenta as colunas de acesso em `users`. **`clientes`, `honorarios`, `eventos_clientes`, `investimentos` e `notificacoes` não são criadas aqui** (as duas últimas, parcialmente, em `data.js`); `clientes`, `honorarios`, `eventos_clientes`, `analistas` e `investimentos` só existem no banco atual.
2. **Administrador inicial:** se não existe usuário com `ADMIN_EMAIL` (padrão `admin@grupoe.com.br`), cria com `ADMIN_PASS` (bcrypt 12). **Sem `ADMIN_PASS` não cria nada e avisa no log.** Não há senha padrão.
3. Agenda as rotinas da seção 6 e abre a porta (`PORT`, padrão 3000). Falha de conexão com o banco encerra o processo.

## 3. Login e sessão

| Item | Regra |
| --- | --- |
| Credencial | e-mail (sem diferenciar maiúsculas) + senha; só usuários com `active = 1`; senha com bcrypt de 12 rounds; mínimo de 6 caracteres |
| Token de acesso | JWT HS256, **2 horas**, emissor `grupo-e`, assinado por `JWT_SECRET`; carrega `sub`, `name`, `role` e as marcas `acesso_minha_nota`, `acesso_legalizacao`, `acesso_cs`, `acesso_financeiro`, `acesso_financeiro_sv`, `acesso_qualidade`, `acesso_gestor` |
| Refresh | UUID guardado em `refresh_tokens` (30 dias), **rotativo e de uso único**: `POST /auth/refresh` apaga o antigo e emite outro; se o usuário foi desativado, 401 |
| Onde fica no navegador | `localStorage`: `ge_token`, `ge_refresh`, `ge_user` (SPA `/`) ou `cs_token`, `cs_refresh`, `cs_user` (/cs, /legalizacao, /financeiro) |
| Sem `JWT_SECRET`/`JWT_REFRESH_SECRET` | gera valores aleatórios a cada boot (todos são deslogados a cada reinício) e avisa no log |
| Troca de perfil ou de marcas | revoga todos os refresh do usuário (força novo login com as permissões novas) |
| `acesso_gestor` | **calculado no login/refresh**: é gestor em `cs_qualidade_gestores` **ou** tem módulos de portais em `cs_acessos`; `acesso_cs` também soma os módulos de indicadores de `cs_acessos` (arquivo 00 do /cs) |

`GET /api/auth/me` devolve `{ id, name, email, role }` **do banco** (não do token). `POST /api/auth/logout` revoga o refresh informado e responde `ok` mesmo com erro.

### 3.1 O filtro de acesso (`requireAuth`, `server/auth.js:77–141`)
Valida o JWT e preenche `req.user`. Depois aplica, **por prefixo de rota**, a restrição dos dois perfis limitados:
- `contabil` só alcança rotas que contêm `/tickets`, `/auth` ou `/perfil` (**busca por trecho do caminho**), mais as exceções liberadas pelas marcas (Minha Nota, Legalização somente leitura, `/api/cs/painel…`, `/api/financeiro…`, Qualidade, push).
- `colaborador` só alcança `/gam/minha-*`, `/gam/meus-*`, `/auth`, `/perfil` e as mesmas exceções.
- `administrador` e `usuario` não passam por essa restrição: **o que vale para eles é cada rota** (`requireAdmin` ou nada).

`requireAdmin` exige `role = 'administrador'`. Não há perfil intermediário "gestor" na API: o conceito vive nas marcas `acesso_*` e nas tabelas de acesso do /cs.

## 4. Perfis e marcas

| `role` | Para quem | Entra |
| --- | --- | --- |
| `administrador` | liderança | tudo |
| `usuario` | equipe interna | SPA `/` (sem as telas de administração) e, por regra de cada rota, /cs e /financeiro **sem valores em R$** |
| `contabil` | Portal Contábil | só `/contabil` (tickets) mais as marcas que tiver |
| `colaborador` | "Acessos marcados" / Analista | só o que as marcas liberam |

Marcas independentes do perfil (colunas de `users`, definidas por um administrador): `acesso_minha_nota`, `acesso_legalizacao`, `acesso_cs`, `acesso_financeiro`, `acesso_financeiro_sv`, `acesso_qualidade`. Na tela de usuários elas aparecem como chips, e **Portal Contábil** é um chip que define o perfil `contabil`. Para `contabil`, o campo `regimes_atendidos` (JSONB com Simples Nacional, Lucro Presumido, Lucro Real) decide quem recebe o ticket de baixa/saída do regime da empresa; vazio = atende qualquer regime (reserva).

## 5. Contas e senhas

| Rota | Acesso | Regra |
| --- | --- | --- |
| `POST /api/auth/register` | público, **desligado desde 31/10/2026** | responde 403 "O cadastro está desativado…" sem tocar o banco, a menos que `CADASTRO_PUBLICO=1` esteja no ambiente (nesse caso cria sempre `role = usuario`, nome + e-mail + senha ≥ 6, e-mail único, entra já logado). A tela de login não mostra mais "Criar conta"; quem precisa de acesso é criado por um administrador |
| `POST /api/auth/login`, `/refresh`, `/logout`, `GET /me` | veja seção 3 | |
| `GET/POST /api/users`, `PATCH /:id/profile`, `/:id/password`, `/:id/toggle`, `DELETE /:id` | **administrador** | criar com perfil e marcas; editar nome, e-mail, perfil, marcas e regimes (revoga tokens); trocar senha de outro (revoga tokens); ativar/desativar (alternância 1/0); excluir (não a si mesmo) |
| `PATCH /api/data/perfil` | logado | altera o **próprio** nome, e-mail e senha; exige a senha atual |
| `POST /api/auth/forgot-password` | público | resposta sempre igual (não revela se o e-mail existe); gera token de 32 bytes com validade de **1 hora** em `reset_tokens` (apaga os anteriores do usuário) e envia o link por Gmail SMTP em segundo plano |
| `GET /api/auth/reset-valido?token=`, `POST /api/auth/reset-password` | público | token válido, não usado e não expirado; nova senha ≥ 6; marca o token como usado e revoga as sessões |

E-mail de recuperação: `mailer.js` (nodemailer, Gmail SMTP porta 587 com STARTTLS, **IPv4 forçado** porque o Render não sai por IPv6), conta `GMAIL_USER` + senha de app `GMAIL_APP_PASS`; o link vai para `{APP_URL}/reset-password.html?token=…`. Uma rota de diagnóstico de e-mail que era pública foi **removida** na auditoria.

## 6. Rotinas automáticas (todas no mesmo processo)

| Rotina | Quando | Condição |
| --- | --- | --- |
| Limpar `refresh_tokens` vencidos | a cada 24 h | sempre |
| Alerta de prazo das ocorrências de Qualidade | confere a cada 10 min; roda às **08h de Brasília**, uma vez por dia (memória) | sempre |
| Ingestão do Zappy (`cs/ingestao`) | **a cada 5 min** e já ao subir | `ZAPPY_BASE_URL` **e** `ZAPPY_TOKEN` |
| Agenda diária (confere a cada 5 min): notas e ranking às **08h, 11h e 15h**; CertiSeguro às **07h e 13h**; notificações de vencimento da Legalização e retrato semanal às **08h** | por horário de Brasília | **dentro do mesmo bloco do Zappy**: sem as duas variáveis do Zappy essas rotinas **também não rodam** |
| Consulta noturna às prefeituras (02h) | desligada por padrão | `LEGALIZACAO_CONSULTA_NO_SERVIDOR=1` (e o bloco do Zappy) |
| Saúde das rotinas da Legalização | a cada hora | bloco do Zappy |
| Sincronização com o Acessórias: clientes, TAGs, motivos de cancelamento, classificação pela Receita, entregas do Risco e foto diária do risco | **ao subir e a cada 24 h** | `ACESSORIAS_API_TOKEN` |
| Completar município/CNAE dos clientes (700 por rodada) | a cada 6 h | `ACESSORIAS_API_TOKEN` |
| **Backup automático** dos dados do SPA | confere a cada 10 min; gera **uma vez por dia entre 03h e 04h de Brasília**; guarda os **30 mais recentes** | sempre (dentro de `data.js`) |
| Keep-alive | a cada 14 min | `APP_URL` |

## 7. Notificações

- **Push do navegador** (`push.js` + `public/sw.js`): `GET /api/push/chave` (chave pública), `POST /assinar` e `/cancelar` (qualquer pessoa logada, só mexe nos aparelhos dela). As chaves VAPID são geradas uma vez e ficam em `cs_painel_config` (chave `webpush_vapid`): **perder o banco invalida as inscrições**. Aparelho que responde 404/410 sai do cadastro (`push_assinaturas`). O service worker mostra o aviso, ou, se a página está visível, entrega a mensagem à própria página (balão e som) para não duplicar. Falha de envio nunca derruba a operação principal.
- **Sino do SPA** (`/api/data/notificacoes`): tabela única e **global** (não é por pessoa): 50 mais recentes, "marcar como lida" e "marcar todas como lidas" valem para **todos**. Criação: automática (novo cliente no Acessórias, retorno, vencimentos, falhas de rotina) ou por `POST /notificacoes`, que **qualquer usuário logado** pode chamar com tipo, título e mensagem livres (a tela usa para avisar insatisfação alta).
- **Sino da Legalização:** "lido" por usuário (`legalizacao_notif_visto`), ver [legalizacao.md](legalizacao.md).

## 8. Listas canônicas

`analistas`, `grupos-empresas`, `unidades` e `motivos-churn`: CRUD mínimo para alimentar listas suspensas e evitar duplicidade ("Reysner" × "Resyner"). Todas: `GET` para qualquer logado (`?ativo=true` filtra); `POST` cria ou **reativa** pelo nome, `PATCH` ativa/desativa (`analistas` e `motivos-churn` também renomeiam), `DELETE` apaga de vez; escrita **só administrador**. `analistas` grava no log de atividades do /cs; renomear um motivo de churn leva o novo nome para `clientes.motivo_churn`. Se o `require('../auth')` falhar, estes arquivos trocam as proteções por funções que **deixam passar** (falha aberta).

## 9. Log de atividades e backups do SPA

- **Log** (`log_atividades`): quem, ação (`criar`, `editar`, `excluir`, `importar`, `sync`…), módulo, descrição e IP; gravado por `registrarLog` nas rotas do SPA e da Legalização e pelo filtro automático da Qualidade (arquivo 08 do /cs). `GET /api/data/log-atividades` (administrador; filtros módulo e usuário, 200 por padrão) e `DELETE /log-atividades` (administrador, **apaga tudo sem confirmação**).
- **Backup manual** `GET /api/data/backup` (administrador): JSON com os dados de **31 conjuntos** (atendimentos, gestão, insatisfações, sensíveis, pesquisas, recuperações, clientes, honorários, eventos, investimentos, notificações, últimos 1000 logs; vínculos e tickets do Zappy **sem as mensagens**; Gamificação inteira; analistas; Qualidade (registros, responsáveis, histórico, tipos, gestores) e `cs_acessos`).
- **Backup automático** (`backups_automaticos`: `id`, `gerado_em`, `dados JSONB`, `totais JSONB`): o mesmo conteúdo, uma vez por dia, **no próprio banco** (se o banco se perde, os backups se perdem junto); listagem e download por administrador.
- **Fora de qualquer backup do sistema:** `users`, `refresh_tokens`, `reset_tokens`, `cs_config`, `cs_painel_config` (inclui as chaves do push), `cs_mensagens`, os dados da Legalização (`legalizacao_*`), do Financeiro (`financeiro_*`), `omie_*`, `questor_*`, os resumos de e-mail e `push_assinaturas`. Para recuperação de verdade é preciso `pg_dump` ou o backup do provedor (ver [guia de migração](../MIGRACAO_DE_MAQUINA.md)).

## 10. Dados do núcleo

| Tabela | Colunas e regras |
| --- | --- |
| `users` | `id TEXT PK`, `name`, `email UNIQUE`, `password` (hash bcrypt; o código também tolera `password_hash`), `role` CHECK (`administrador, usuario, contabil, colaborador`), `active INTEGER` (1/0), `created_at`, `updated_at`; marcas booleanas `acesso_minha_nota, acesso_legalizacao, acesso_cs, acesso_financeiro, acesso_financeiro_sv, acesso_qualidade`; `regimes_atendidos JSONB` |
| `refresh_tokens` | `token PK`, `user_id → users ON DELETE CASCADE`, `expires_at`, `created_at` |
| `reset_tokens` | `token PK`, `user_id`, `expires_at`, `used`, `created_at` |
| `log_atividades` | ver seção 9 |
| `notificacoes` | criada à parte: `id UUID`, `tipo`, `titulo`, `mensagem`, `lida`, `link_modulo`, `created_at`, `cliente_id UUID` |
| `backups_automaticos` | seção 9 |
| `push_assinaturas`, `cs_painel_config` | push e configurações chave/valor JSON do painel |

As tabelas de negócio do SPA (`atendimentos`, `gestao_clientes`, `insatisfacoes`, `clientes_sensiveis`, `pesquisas`, `recuperacoes`, `clientes`, `honorarios`, `eventos_clientes`, `investimentos`, `tickets*`) estão em [spa-principal.md](spa-principal.md).

## 11. Pontos de atenção

1. ~~Qualquer pessoa na internet podia criar uma conta de `usuario` e entrar~~ — **corrigido em 31/10/2026**: o cadastro público foi desligado (rota recusa com 403 e a tela não oferece mais "Criar conta"; reabrir só com `CADASTRO_PUBLICO=1`). Contas criadas **antes** da correção continuam existindo: vale conferir a lista em Administração → Usuários e desativar as que não são de pessoas conhecidas. Lição: o perfil `usuario` ainda passa em toda rota protegida apenas por `requireAuth` (Carteira com honorários, /cs e /financeiro sem R$). [CONFIRMADO]
2. **Rotinas ligadas a variáveis erradas:** a agenda da Legalização (CertiSeguro 2×/dia, vencimentos, retrato semanal, saúde das rotinas) só existe se `ZAPPY_BASE_URL` e `ZAPPY_TOKEN` estiverem definidos. [CONFIRMADO]
3. **Backups no mesmo lugar do dado:** o backup automático fica no banco e deixa de fora usuários, Legalização, Financeiro e configurações. [CONFIRMADO]
4. **Sino global:** ler ou limpar o sino de um limpa para todos; e qualquer usuário cria avisos livres. [CONFIRMADO]
5. **Gestão de notificações de ticket:** as inserções de aviso do ticket (`criarTicketInterno`, marcar checklist, finalizar) gravam as colunas `user_id` e `referencia_id`, que **não existem** na definição de `notificacoes` do código (que exige `titulo`), e o erro é silenciado (`.catch(()=>{})`). Se o banco de produção tem outra versão da tabela, funciona; se não, os avisos de ticket nunca são gravados. Conferir com o `pg_dump --schema-only`. [DÚVIDA]
6. **Cabeçalhos de segurança parciais** (sem CSP, sem HSTS), **CORS** libera requisições sem `Origin`, e os tokens ficam em `localStorage` (qualquer script injetado na página os lê). [CONFIRMADO]
7. **Falha aberta nas listas** (seção 8) e nas rotas do radar de SLA (arquivo 09 do /cs) se `auth.js` não carregar. [CONFIRMADO]
8. **Rotinas por `setInterval` no processo web:** com o plano gratuito, reinícios e dormência atrasam ou repetem rotinas; só as que têm horário fixo guardam em memória "já rodei hoje" (reiniciar na mesma hora pode repeti-las). [INFERIDO]
9. **README e documentação antigos** falavam em SQLite e senha padrão; o código usa PostgreSQL e não tem senha padrão. [CONFIRMADO]
