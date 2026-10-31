# Permissões e segurança — visão consolidada

Reúne em um só lugar o que está espalhado pelos arquivos de cada módulo. Cada afirmação foi tirada deles (que leram o código); onde um módulo tem a regra completa, há o link. Estado do código em 31/10/2026, **incluindo as correções feitas nesse dia que ainda aguardam deploy** (marcadas).

## 1. Os quatro perfis (`users.role`) e as marcas

| `role` | Quem é | O que alcança no servidor |
| --- | --- | --- |
| `administrador` | liderança | tudo. É o único que passa em `requireAdmin` |
| `usuario` | equipe interna | SPA `/` sem as telas de administração; /cs e /financeiro **sem valores em R$**; qualquer rota protegida só por `requireAuth` (ver seção 4) |
| `contabil` | Portal Contábil | só rotas de tickets, `/auth`, `/perfil` e as liberadas por marca |
| `colaborador` | "Analista" na tela | só `/gam/minha-*`, `/gam/meus-*`, `/auth`, `/perfil` e as liberadas por marca |

Marcas independentes do perfil (colunas de `users`, definidas por um administrador): `acesso_minha_nota`, `acesso_legalizacao`, `acesso_cs`, `acesso_financeiro`, `acesso_financeiro_sv`, `acesso_qualidade`. A marca `acesso_gestor` **não é coluna**: é calculada no login (está em `cs_qualidade_gestores` ou tem módulos de portais em `cs_acessos`). Regra completa em [cs/00-base-acesso.md](cs/00-base-acesso.md) e [nucleo.md](nucleo.md).

## 2. Matriz: o que cada perfil faz em cada área

Legenda: **A** = só se for administrador · **L** = leitura · **E** = leitura e escrita (nos limites da própria rota) · **—** = 403 · **marca** = depende da marca citada.

| Área | administrador | usuario | contabil | colaborador |
| --- | --- | --- | --- | --- |
| SPA: atendimentos, gestão, insatisfações, pesquisas, sensíveis | E | E | — | — |
| SPA: Carteira e CAC (leituras) | E | **— (desde 31/10/2026, após deploy; antes: L)** | — | — |
| SPA: Carteira, criar cliente (`POST /clientes`) | E | E (de propósito: formulário de Gestão) | — | — |
| SPA: Tickets internos | E | E (com checagem de menção) | E (rotas `/tickets`) | — |
| SPA: Administração (usuários, backup, log, importações) | A | — | — | — |
| /cs (painel, ficha, churn, risco) | E, com valores | L/E **sem R$** | marca `acesso_cs` | marca `acesso_cs` |
| /cs Qualidade | E | por rota | marca `acesso_qualidade`/`acesso_gestor`/`acesso_minha_nota` | idem |
| Gamificação: ranking público | sem login | sem login | sem login | sem login |
| Gamificação: administrar | A | — | — | — |
| Gamificação: Minha Nota | E | marca | marca `acesso_minha_nota` | **sim** (resolve a pessoa pelo login) |
| /legalizacao: ver | E | pela API sim; pela tela não | marca `acesso_legalizacao` (L) | marca `acesso_legalizacao` (L) |
| /legalizacao: pedir inativação, "Não vai renovar", informar protocolo, município, IM | E | E | marca (**protocolo e "Não vai renovar" liberados em 31/10/2026**) | marca (idem) |
| /legalizacao: editar alvará/certificado, aprovar/rejeitar pedidos | A (aprovar/rejeitar/certificado) | editar alvará pela API | — | — |
| /financeiro | E, com valores | L **sem R$** | marca `acesso_financeiro`, `acesso_cs` ou `acesso_financeiro_sv` | idem |
| Cargas de máquina (Omie, Questor, e-mail, CertiSeguro, Legalização) | `X-Sync-Token` | `X-Sync-Token` | `X-Sync-Token` | `X-Sync-Token` |

## 3. As camadas, de fora para dentro

1. **Token** — `requireAuth` valida o JWT (2 h) e monta `req.user`.
2. **Perfis restritos** — dentro de `requireAuth`, por **trecho do caminho** (`includes`/regex), `contabil` e `colaborador` só passam nas rotas liberadas.
3. **Administrador** — `requireAdmin` por rota. `GET`/`POST`/`PATCH`/`DELETE` de `/api/users` inteiro usam `router.use(requireAuth, requireAdmin)`.
4. **Módulos do /cs** — `acessos.restringir`: quem tem lista gravada em Acessos só passa nos módulos dela.
5. **Cada rota** — escopo por departamento, por analista, por valores em R$ (`veValores`).
6. **Front-end** — só **esconde** menus. [CONFIRMADO] nada é decidido ali, com uma exceção conhecida: o botão "Ocultar valores" do administrador é visual.

## 4. Quantas rotas em cada nível

A varredura do anexo A (358 rotas) classifica por rota: **155 com `requireAdmin` na própria linha**, **148 "login"** (atrás de `requireAuth`), **34 "ver arquivo"** (regra própria no arquivo), **19 públicas/token** e **2 públicas** (sem nenhuma proteção: pesquisa e ranking). A classificação é grosseira: "login" inclui rotas que a própria função restringe (por exemplo as 53 de Qualidade, que têm lista branca interna) e `users.js` aparece como "login" mas **todas** as suas 6 rotas são só de administrador.

## 5. Segurança de transporte e sessão

| Item | Situação |
| --- | --- |
| Senha | bcrypt 12 rounds; mínimo de 6 caracteres; sem senha padrão no código [CONFIRMADO] |
| Login | limite de 20 tentativas por 15 minutos por IP (`loginLimiter`) [CONFIRMADO] |
| Sessão | JWT de acesso 2 h + refresh de 30 dias, rotativo e de uso único; trocar perfil/marcas revoga os refresh [CONFIRMADO] |
| Onde ficam os tokens | `localStorage` (não `httpOnly`): qualquer script injetado os lê [CONFIRMADO] |
| Cadastro público | **desligado em 31/10/2026** (`POST /api/auth/register` → 403; reabrir só com `CADASTRO_PUBLICO=1`) |
| Cabeçalhos | sem CSP e sem HSTS; CORS aceita requisições sem `Origin` [CONFIRMADO] |
| Limite global | 300 requisições por minuto por IP (vale também para a pesquisa pública) [CONFIRMADO] |
| Máquina → servidor | cabeçalho `X-Sync-Token`; **o mesmo segredo** serve a Legalização, Questor, Omie, e-mail e suspensos (`CERTISEGURO_SYNC_TOKEN` é separado só para a CertiSeguro) |
| Administrador inicial | criado só se o banco **não tem nenhum administrador** e `ADMIN_PASS` existe (regra de 31/10/2026, após deploy) |

## 6. Pontos fracos conhecidos (todos com a fonte no módulo)

1. `usuario` alcança as rotas operacionais do SPA e da Legalização por desenho. Em 31/10/2026 foram fechadas as leituras de Carteira/CAC e conferidas as demais rotas "login": as de `/cs` checam o perfil por dentro e a busca global não expõe honorários. Ver [transversal-pendencias-cobertura](transversal-pendencias-cobertura.md), item 1.
2. Falha aberta: se `require('../auth')` falhar, as listas canônicas e o radar de SLA trocam as proteções por funções que deixam passar ([nucleo.md](nucleo.md) seção 8).
3. `isLegalizacaoRoute` libera `GET` em **qualquer** caminho que contenha `/legalizacao`; rota nova com esse trecho nasce liberada para analista.
4. Um segredo só para todas as cargas de máquina.
5. Sino de notificações global e criação de aviso livre por qualquer usuário logado (`POST /notificacoes`).
6. `DELETE /api/data/clear` (administrador) apaga seis tabelas sem confirmação quando `period` não vem; `DELETE /log-atividades` apaga todo o log sem confirmação.
7. A pesquisa pública aceita respostas de qualquer pessoa (só o limite global por IP).
8. `acesso_gestor` fica no token por até 2 h depois de a pessoa sair de `cs_qualidade_gestores`.
9. Conta de administrador com e-mail pessoal ou legado deve ser conferida periodicamente. Em 31/10/2026: `admin@grupoe.com.br` foi **desativada** (a exclusão falhou por vínculos no banco) e a conta de e-mail pessoal foi confirmada pelo dono como sendo da Larissa.
10. O repositório no GitHub é **público**: nenhum segredo pode entrar nele, e a senha padrão antiga continua no histórico do Git (já não funciona no código atual, mas serve contra qualquer conta criada com ela).
