# /cs — Base: autenticação, perfis e acesso por módulo

Escopo: como uma pessoa chega ao `/cs`, o que cada perfil vê e onde cada permissão é verificada. Vale também para as outras páginas (`/financeiro`, `/legalizacao`), que reutilizam o mesmo JWT.

Níveis de certeza: [CONFIRMADO] · [INFERIDO] · [DÚVIDA].

## 1. Usuários e perfis

Tabela `users` (`server/db.js`):

| Coluna | Tipo | Nulo | Default | Significado |
| --- | --- | --- | --- | --- |
| `id` | TEXT PK | não | UUID gerado no código | identificador |
| `name` | TEXT | não | — | nome completo (também usado para casar com analistas por nome) |
| `email` | TEXT UNIQUE | não | — | login (comparado em minúsculas) |
| `password` | TEXT | não | — | hash bcrypt (12 rounds) |
| `role` | TEXT | não | `'usuario'` | `administrador`, `usuario`, `contabil`, `colaborador` (CHECK recriado a cada subida) |
| `active` | INTEGER | não | 1 | 1 ativo, 0 inativo (login recusa inativo) |
| `created_at`, `updated_at` | TIMESTAMPTZ | não | `NOW()` | auditoria |
| `acesso_minha_nota` | BOOLEAN | não | false | libera as rotas `/gam/minha-*` e `/gam/meus-*` (nota própria) |
| `acesso_legalizacao` | BOOLEAN | não | false | libera leitura e solicitação de inativação na Legalização |
| `acesso_cs` | BOOLEAN | não | false | entra no `/cs` e no `/financeiro` **sem valores em R$** (equipe do painel) |
| `acesso_financeiro` | BOOLEAN | não | false | `/financeiro` com valores em R$ |
| `acesso_financeiro_sv` | BOOLEAN | não | false | só o `/financeiro`, sem valores e sem o `/cs` |
| `acesso_qualidade` | BOOLEAN | não | false | é analista: Portal do Analista e Minha área |

`acesso_gestor` **não é coluna**: é calculado no login (seção 3). [CONFIRMADO] `server/routes/auth.js`.

Perfis efetivos no `/cs` (função `perfilDe`, `public/js/cs-painel.js`, e `modulosPadrao`, `server/cs/acessos.js`):

| Perfil | Como a pessoa cai nele | Padrão de módulos (sem configuração em Acessos) |
| --- | --- | --- |
| Administrador | `role = administrador` | todos + Acessos |
| Equipe do painel | `role = usuario` ou `acesso_cs` | 8 indicadores + Qualidade + Gamificação + Portal do Sucesso do Cliente |
| Sucesso do Cliente | registrado em `cs_qualidade_gestores` com departamento `Sucesso` ou papel `final` | Qualidade + Gamificação + Portal do Sucesso do Cliente |
| Gestor | registrado em `cs_qualidade_gestores` (papel gestor, diretor ou final) | Qualidade + Gamificação + Portal do Gestor |
| Analista | `acesso_qualidade` | Qualidade + Gamificação + Portal do Analista + Minha área (nota, atendimentos, e-mails, evolução, prioridades) |

Os perfis se somam: a mesma pessoa pode ser analista e gestora.

## 2. Sessão

- **Login** `POST /api/auth/login` (limite de 20 tentativas por 15 min por IP, `loginLimiter`): busca `users` por e-mail (case-insensitive) e `active = 1`; confere o hash; devolve **token de acesso JWT** e **refresh token** (UUID gravado em `refresh_tokens`). Mensagem única para e-mail ou senha errados: "E-mail ou senha incorretos." [CONFIRMADO]
- **Token de acesso:** JWT HS256 com `iss = grupo-e`, validade **2 h** (o README diz 15 min: desatualizado). Payload: `sub`, `name`, `role` e as seis marcas `acesso_*`. [CONFIRMADO] `server/auth.js → signAccess`
- **Refresh:** `POST /api/auth/refresh` valida o refresh token (existe, não vencido, usuário ativo), **apaga o usado** (rotação) e emite um novo par. Validade do refresh: 30 dias. `refresh_tokens` apagada a cada 24 h por `pruneExpiredTokens`.
- **Armazenamento no navegador:** o front guarda token, refresh e usuário no `localStorage` (chaves `ge_token`, `ge_refresh`, `ge_user` na SPA principal; `cs_token`, `cs_refresh`, `cs_user` no `/cs` e nas páginas de Legalização). Os tokens **não** vão em cookie. [CONFIRMADO] leitura dos JS e da sessão; o README fala em cookies HttpOnly (desatualizado).
- **Segredos:** `JWT_SECRET` e `JWT_REFRESH_SECRET`; se faltarem, o servidor gera segredo aleatório a cada subida e registra aviso no log (todas as sessões caem a cada reinício). Não há valor padrão fixo.
- **Cadastro público** (desligado em 31/10/2026; só volta com `CADASTRO_PUBLICO=1`) `POST /api/auth/register`: sempre cria `role = usuario`, ignorando `role` do corpo; exige nome, e-mail e senha de pelo menos 6 caracteres; e-mail único (409). [CONFIRMADO] [DÚVIDA] se a rota deveria ficar aberta em produção.
- **Administrador inicial:** criado na subida só se `ADMIN_PASS` existir (`ADMIN_EMAIL`, `ADMIN_NAME` opcionais); sem `ADMIN_PASS` não cria e avisa no log.

## 3. Marcas calculadas no login e no refresh

```text
marcasCs = acessos.marcasDeAcesso(user.id)          // lê cs_acessos
acesso_gestor = (user.id está em cs_qualidade_gestores) OU marcasCs.portais
acesso_cs     = users.acesso_cs OU marcasCs.cs
// marcasCs.cs     = há lista gravada em Acessos E ela contém algum módulo de indicadores
// marcasCs.portais = há lista gravada E ela contém algum módulo de portal (qualidade, gestor, analista, sucesso, gamificação, Minha área)
```

Falha na consulta = sem a marca (nunca derruba o login). [CONFIRMADO] `server/routes/auth.js → marcasDoPainel`, `ehGestorDeQualidade`.

## 4. Onde cada permissão é verificada

| Camada | Verificação | Arquivo |
| --- | --- | --- |
| 1. Token | `requireAuth` valida JWT e monta `req.user` | `server/auth.js` |
| 2. Papéis restritos | `contabil` só chega em rotas de tickets, perfil/auth e nas rotas liberadas por marca (`isMinhaNotaRoute`, `isLegalizacaoRoute`, `isCsPainelRoute`, `isFinanceiroRoute`, `isQualidadeRoute`, `isCsQualidadeRoute`, `isPushRoute`); `colaborador` idem, sem tickets | `server/auth.js` (403 "Acesso restrito…") |
| 3. Administrador | `requireAdmin`: `role = administrador` | `server/auth.js` |
| 4. Módulos do `/cs` | `acessos.restringir`: pessoa **com lista gravada** só passa nas rotas dos módulos que tem; sem lista, segue (a rota confere o resto) | `server/cs/acessos.js`, montado em `/api/cs/painel` |
| 5. Cada rota | regras próprias (escopo por departamento, por analista, por valores em R$) | `server/cs/*.js`, `server/financeiro/*.js` |
| 6. Front-end | só **esconde** menus (`perfilCs`, `secaoLiberada`); nunca decide acesso | `public/js/cs-painel.js` |

Regra de ouro [CONFIRMADO]: o servidor decide; o front-end só reflete (`/api/cs/painel/qualidade/eu` devolve a lista de módulos efetivos da pessoa).

## 5. Acessos por módulo (RN-ACS)

Catálogo de 18 módulos em `CATALOGO` (código → seção do menu): `visao`, `inteligente`→`analise`, `anual`, `atendimento`, `permanencia`→`risco`, `churn`, `categorias`, `qualidade_dados`→`qualidade`, `qualidade`→`consideracoes`, `gestor`, `analista`, `sucesso`, `minha_nota`→`minhanota`, `meus_atendimentos`→`meusatend`, `meus_emails`→`meusemails`, `minha_evolucao`→`minhaevolucao`, `minhas_prioridades`→`minhasprior`, `gamificacao`. `acessos` existe à parte (só administrador, não configurável).

- **RN-ACS-001** Administrador sempre tem acesso aos dados; o **menu** dele pode ser personalizado, mas "Acessos" ele sempre tem.
- **RN-ACS-002** Pessoa **sem configuração** segue `modulosPadrao(perfil)` (tabela da seção 1).
- **RN-ACS-003** Pessoa **com configuração** vê exatamente os módulos marcados; rotas dos outros módulos respondem 403 "Você não tem acesso a este módulo. Peça à administração em Acessos."
- **RN-ACS-004** Os dados da carteira (`/dados`, `/cliente`, `/email-sinais`) são compartilhados: **um** módulo de indicadores basta para chegar neles.
- **RN-ACS-005** Mapa rota → módulo (`modulosDaRota`, caminho depois de `/api/cs/painel`): `/anual` e `/honorario-sugerido` → `anual`, `inteligente`; `/atendimentos`, `/atendimento` → `atendimento`; `/churn-motivos`, `/churn` → `churn`, `visao`; `/categorias` → `categorias`, `permanencia`, `visao`; `/dados`, `/cliente`, `/email-sinais` → qualquer módulo de dados; `/qualidade` e `/acessos` têm controle próprio (retornam `null`).
- **RN-ACS-006** Listas gravadas só aceitam códigos do catálogo, sem repetição, na ordem do catálogo (`limparModulos`). `null` apaga a configuração e volta ao padrão.
- **RN-ACS-007** Migração única `minha_area_analista` (21/10/2026): soma Minha área e Gamificação às listas que já tinham o portal do analista, para quem foi configurado antes desses módulos existirem. Controle em `cs_acessos_migracoes`.
- **RN-ACS-008** Cache em memória de 20 s por usuário (`cache`), limpo ao gravar; falha de banco = sem configuração (cai no padrão).

Tabelas: `cs_acessos (user_id TEXT PK, modulos JSONB NOT NULL, atualizado_por TEXT, atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW())` e `cs_acessos_migracoes (nome TEXT PK, feita_em TIMESTAMPTZ NOT NULL DEFAULT NOW())`.

Endpoints (só administrador, com auditoria): `GET /api/cs/painel/acessos` (catálogo + cada usuário ativo com `modulos`, `padrao`, `definido`, `entra_padrao`, `entra_no_painel`) e `PUT /api/cs/painel/acessos/:userId` com `{ modulos: [..] | null }` (404 se a pessoa não está ativa; 400 se `modulos` não for lista nem `null`).

## 6. Perfis rápidos da tela Acessos (front)

`PERFIS_RAPIDOS` em `public/js/cs-painel.js`: Equipe completa (8 indicadores + qualidade + sucesso), Só indicadores (8), Só Qualidade e portais (`qualidade`, `gestor`, `analista`, `sucesso`), Analista (`qualidade`, `analista` + 5 da Minha área), Sem acesso a nada (lista vazia). São atalhos de preenchimento; o que vale é a lista gravada.

## 7. Auditoria dos acessos

Toda rota de `acessos` passa por `auditoria.middleware()`, que grava ação, módulo e autor em `log_atividades` (detalhado no arquivo de logs do `/cs`).

## 8. Pontos de atenção (para a seção 15)

1. README descreve SQLite, token de 15 min e cookies HttpOnly; o código usa Postgres, 2 h e `localStorage`. [CONFIRMADO]
2. `acesso_gestor` não é coluna mas viaja no token; quem for retirado de `cs_qualidade_gestores` mantém a marca até o token expirar (até 2 h) ou o refresh renovar. [INFERIDO]
3. Dois pontos duplicam a lista de módulos (front: `SEC_MODULO`, `ORDEM_SECOES`; back: `CATALOGO`). O back é a fonte de verdade. [CONFIRMADO]
4. `isLegalizacaoRoute` libera `GET` em qualquer caminho que contenha `/legalizacao`, mesmo que a rota tenha outro propósito (comparação por `includes`). [INFERIDO] risco de liberar mais do que o desejado se surgirem rotas novas com esse trecho no caminho.
