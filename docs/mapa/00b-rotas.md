# Rotas HTTP (inventário gerado do código)

Gerado por varredura de `router|app.(get|post|put|patch|delete)(…)` em `server/**` (sem os arquivos de teste). Total: **358 rotas**.

Legenda de autenticação: **pública/token** = a rota está antes do `router.use(requireAuth)` do arquivo (aberta ou protegida por token de sincronização no cabeçalho `X-Sync-Token`); **login** = depois dessa barreira ou com `requireAuth` na própria linha; **admin** = `requireAdmin` na própria linha ou no arquivo. [INFERIDO] por posição no arquivo — a Fase 2 confirma rota a rota.

## `server/cs/acessos.js` (2 rotas)

Montagem: `router` → `/api/cs/painel/acessos`

Barreira de sessão (`router.use(requireAuth)`): linha 168.

| Método | Caminho completo | Linha | Acesso |
| --- | --- | --- | --- |
| GET | `/api/cs/painel/acessos` | 173 | login |
| PUT | `/api/cs/painel/acessos/:userId` | 196 | login |

## `server/cs/anualQuestor.js` (3 rotas)

Montagem: `router` → `/api/cs/questor/anual` e `/api/cs/painel/anual`

| Método | Caminho completo | Linha | Acesso |
| --- | --- | --- | --- |
| POST | `/api/cs/questor/anual · /api/cs/painel/anual` | 106 | ver arquivo |
| GET | `/api/cs/questor/anual · /api/cs/painel/anual` | 135 | login |
| PUT | `/api/cs/questor/anual · /api/cs/painel/anual` | 165 | login |

## `server/cs/auditoria.js` (5 rotas)

Montagem: `router` → `/api/cs/painel/admin`

Barreira de sessão (`router.use(requireAuth)`): linha 273.

| Método | Caminho completo | Linha | Acesso |
| --- | --- | --- | --- |
| GET | `/api/cs/painel/admin/logs` | 278 | login |
| GET | `/api/cs/painel/admin/limpar-teste/previa` | 290 | login |
| POST | `/api/cs/painel/admin/limpar-teste` | 294 | login |
| GET | `/api/cs/painel/admin/backup/info` | 305 | login |
| GET | `/api/cs/painel/admin/backup` | 319 | login |

## `server/cs/categorias.js` (4 rotas)

Montagem: `router` → `/api/cs/categorias`

| Método | Caminho completo | Linha | Acesso |
| --- | --- | --- | --- |
| GET | `/api/cs/categorias` | 260 | login |
| GET | `/api/cs/categorias/config` | 269 | admin |
| PUT | `/api/cs/categorias/config` | 301 | admin |
| POST | `/api/cs/categorias/sincronizar-tags` | 337 | admin |

## `server/cs/churnMotivos.js` (3 rotas)

Montagem: `router` → `/api/cs/painel/churn-motivos`

Barreira de sessão (`router.use(requireAuth)`): linha 86.

| Método | Caminho completo | Linha | Acesso |
| --- | --- | --- | --- |
| GET | `/api/cs/painel/churn-motivos/motivos` | 94 | login |
| PUT | `/api/cs/painel/churn-motivos/definir` | 108 | login |
| GET | `/api/cs/painel/churn-motivos/fechamento` | 145 | login |

## `server/cs/churnSaidas.js` (6 rotas)

Montagem: `router` → `/api/cs/churn`

| Método | Caminho completo | Linha | Acesso |
| --- | --- | --- | --- |
| GET | `/api/cs/churn` | 364 | login |
| PUT | `/api/cs/churn/config` | 383 | admin |
| PUT | `/api/cs/churn/saidas/:id/classificacao` | 402 | admin |
| POST | `/api/cs/churn/classificar-saidas` | 420 | admin |
| POST | `/api/cs/churn/sincronizar-motivos` | 428 | admin |
| GET | `/api/cs/churn/diagnostico` | 438 | admin |

## `server/cs/emailSinais.js` (3 rotas)

Montagem: `router` → `/api/cs/email-sinais` e `/api/cs/painel/email-sinais`

| Método | Caminho completo | Linha | Acesso |
| --- | --- | --- | --- |
| POST | `/api/cs/email-sinais · /api/cs/painel/email-sinais` | 127 | ver arquivo |
| POST | `/api/cs/email-sinais/atendimento · /api/cs/painel/email-sinais/atendimento` | 169 | ver arquivo |
| GET | `/api/cs/email-sinais · /api/cs/painel/email-sinais` | 202 | login |

## `server/cs/honorarioSugerido.js` (2 rotas)

Montagem: `router` → `/api/cs/painel/honorario-sugerido`

Barreira de sessão (`router.use(requireAuth)`): linha 53.

| Método | Caminho completo | Linha | Acesso |
| --- | --- | --- | --- |
| GET | `/api/cs/painel/honorario-sugerido` | 55 | login |
| PUT | `/api/cs/painel/honorario-sugerido` | 68 | login |

## `server/cs/omieHonorarios.js` (1 rotas)

Montagem: `router` → `/api/cs/omie/honorarios`

| Método | Caminho completo | Linha | Acesso |
| --- | --- | --- | --- |
| POST | `/api/cs/omie/honorarios` | 75 | ver arquivo |

## `server/cs/painel.js` (6 rotas)

Montagem: `router` → `/api/cs/painel`

Barreira de sessão (`router.use(requireAuth)`): linha 178.

| Método | Caminho completo | Linha | Acesso |
| --- | --- | --- | --- |
| GET | `/api/cs/painel/dados` | 180 | login |
| GET | `/api/cs/painel/churn` | 199 | login |
| GET | `/api/cs/painel/atendimentos` | 245 | login |
| GET | `/api/cs/painel/atendimento/:id` | 268 | login |
| GET | `/api/cs/painel/cliente/:id` | 293 | login |
| GET | `/api/cs/painel/cliente/:id/acessorias` | 341 | login |

## `server/cs/qualidade.js` (53 rotas)

Montagem: `router` → `/api/cs/painel/qualidade`; `routerAnalista` → `(desligado em 17/10/2026)`

Barreira de sessão (`router.use(requireAuth)`): linha 655.

| Método | Caminho completo | Linha | Acesso |
| --- | --- | --- | --- |
| GET | `/api/cs/painel/qualidade/opcoes` | 684 | login |
| GET | `/api/cs/painel/qualidade/tipos` | 691 | login |
| POST | `/api/cs/painel/qualidade/tipos` | 699 | login |
| PATCH | `/api/cs/painel/qualidade/tipos/:id` | 713 | login |
| DELETE | `/api/cs/painel/qualidade/tipos/:id` | 739 | login |
| PUT | `/api/cs/painel/qualidade/analistas/:id/departamentos` | 752 | login |
| GET | `/api/cs/painel/qualidade/analistas` | 763 | login |
| GET | `/api/cs/painel/qualidade/cliente/:clienteId` | 772 | login |
| POST | `/api/cs/painel/qualidade` | 780 | login |
| GET | `/api/cs/painel/qualidade/resumo` | 812 | login |
| GET | `/api/cs/painel/qualidade/analista/:id` | 833 | login |
| GET | `/api/cs/painel/qualidade/gestores` | 891 | login |
| POST | `/api/cs/painel/qualidade/vinculos/automatico` | 909 | login |
| POST | `/api/cs/painel/qualidade/gestores` | 925 | login |
| DELETE | `/api/cs/painel/qualidade/gestores/:id` | 940 | login |
| GET | `/api/cs/painel/qualidade/pendencias` | 955 | login |
| GET | `/api/cs/painel/qualidade/versao` | 974 | login |
| GET | `/api/cs/painel/qualidade/avisos` | 984 | login |
| GET | `/api/cs/painel/qualidade/eu` | 1104 | login |
| GET | `/api/cs/painel/qualidade/ocorrencias/minhas` | 1118 | login |
| GET | `/api/cs/painel/qualidade/gestor/ocorrencias` | 1127 | login |
| PUT | `/api/cs/painel/qualidade/gestor/ocorrencias/:id/tratativa` | 1140 | login |
| POST | `/api/cs/painel/qualidade/gestor/ocorrencias/:id/filha` | 1179 | login |
| POST | `/api/cs/painel/qualidade/gestor/ocorrencias/:id/abrir` | 1244 | login |
| GET | `/api/cs/painel/qualidade/analista/ocorrencias` | 1271 | login |
| POST | `/api/cs/painel/qualidade/analista/ocorrencias/:id/nota` | 1320 | login |
| POST | `/api/cs/painel/qualidade/analista/ocorrencias/:id/encerrar` | 1338 | login |
| POST | `/api/cs/painel/qualidade/gestor/ocorrencias/:id/validar` | 1367 | login |
| POST | `/api/cs/painel/qualidade/gestor/ocorrencias/:id/devolver` | 1407 | login |
| POST | `/api/cs/painel/qualidade/gestor/ocorrencias/:id/mensagem` | 1436 | login |
| POST | `/api/cs/painel/qualidade/gestor/ocorrencias/:id/resposta-final` | 1454 | login |
| POST | `/api/cs/painel/qualidade/gestor/ocorrencias/:id/cancelar` | 1519 | login |
| POST | `/api/cs/painel/qualidade/gestor/ocorrencias/:id/excluir` | 1545 | login |
| POST | `/api/cs/painel/qualidade/gestor/ocorrencias/:id/reabrir` | 1567 | login |
| GET | `/api/cs/painel/qualidade/sucesso/ocorrencias` | 1611 | login |
| POST | `/api/cs/painel/qualidade/sucesso/ocorrencias/:id/responder` | 1622 | login |
| POST | `/api/cs/painel/qualidade/sucesso/ocorrencias/:id/apontar` | 1639 | login |
| POST | `/api/cs/painel/qualidade/sucesso/ocorrencias/:id/encerrar` | 1665 | login |
| GET | `/api/cs/painel/qualidade/tempos` | 1691 | login |
| GET | `/api/cs/painel/qualidade/empresas` | 1713 | login |
| POST | `/api/cs/painel/qualidade/ocorrencias` | 1736 | login |
| POST | `/api/cs/painel/qualidade/ocorrencias/:id/anexo` | 1771 | login |
| POST | `/api/cs/painel/qualidade/ocorrencias/:id/evento/:eventoId/anexo` | 1799 | login |
| GET | `/api/cs/painel/qualidade/anexo/:anexoId` | 1836 | login |
| GET | `/api/cs/painel/qualidade/ocorrencias` | 1851 | login |
| PATCH | `/api/cs/painel/qualidade/:id` | 1859 | login |
| DELETE | `/api/cs/painel/qualidade/:id` | 1891 | login |
| PUT | `/api/cs/painel/qualidade/vinculo/:analistaId` | 1901 | login |
| GET | `(desligado em 17/10/2026) /painel` | 2063 | login |
| GET | `/api/cs/painel/qualidade/analista/meu-painel` | 2064 | login |
| GET | `(desligado em 17/10/2026) /minhas` | 2066 | login |
| PATCH | `(desligado em 17/10/2026) /:id/tratar` | 2100 | login |
| POST | `(desligado em 17/10/2026) /:id/nota` | 2128 | login |

## `server/cs/questorDados.js` (1 rotas)

Montagem: `router` → `/api/cs/questor`

| Método | Caminho completo | Linha | Acesso |
| --- | --- | --- | --- |
| POST | `/api/cs/questor` | 84 | ver arquivo |

## `server/cs/risco.js` (6 rotas)

Montagem: `router` → `/api/cs/risco`

| Método | Caminho completo | Linha | Acesso |
| --- | --- | --- | --- |
| POST | `/api/cs/risco/suspensos-omie` | 315 | ver arquivo |
| POST | `/api/cs/risco/foto` | 322 | admin |
| GET | `/api/cs/risco` | 327 | login |
| GET | `/api/cs/risco/config` | 332 | admin |
| PUT | `/api/cs/risco/config` | 340 | admin |
| POST | `/api/cs/risco/sincronizar-entregas` | 355 | admin |

## `server/cs/routes.js` (27 rotas)

Montagem: `router` → `/api/cs`

| Método | Caminho completo | Linha | Acesso |
| --- | --- | --- | --- |
| GET | `/api/cs/agora` | 60 | login |
| GET | `/api/cs/historico` | 90 | login |
| GET | `/api/cs/filtros` | 162 | login |
| POST | `/api/cs/backfill` | 187 | admin |
| POST | `/api/cs/reingerir` | 217 | admin |
| GET | `/api/cs/reingerir/status` | 265 | admin |
| POST | `/api/cs/atualizar-notas` | 279 | admin |
| POST | `/api/cs/recalcular-sla` | 310 | admin |
| GET | `/api/cs/recalcular-sla/status` | 349 | admin |
| GET | `/api/cs/dashboard` | 386 | login |
| GET | `/api/cs/dashboard/etapas` | 493 | login |
| GET | `/api/cs/dashboard/motivos` | 640 | login |
| POST | `/api/cs/ingerir` | 712 | admin |
| GET | `/api/cs/diagnostico` | 731 | admin |
| GET | `/api/cs/churn` | 761 | admin |
| POST | `/api/cs/churn/:ticketId/tratar` | 849 | admin |
| GET | `/api/cs/insatisfacao-conversas` | 886 | admin |
| POST | `/api/cs/insatisfacao-conversas/:mensagemId/tratar` | 957 | admin |
| GET | `/api/cs/motivos` | 1001 | admin |
| GET | `/api/cs/afastamento` | 1125 | admin |
| POST | `/api/cs/afastamento/:clienteId/tratar` | 1191 | admin |
| GET | `/api/cs/tratados` | 1227 | admin |
| GET | `/api/cs/vinculos/buscar` | 1310 | admin |
| GET | `/api/cs/vinculos/pendentes` | 1327 | login |
| POST | `/api/cs/vinculos/recalcular` | 1346 | admin |
| POST | `/api/cs/vinculos/:id/confirmar` | 1358 | login |
| GET | `/api/cs/vinculos/analise-pendentes` | 1381 | admin |

## `server/financeiro/rotas.js` (4 rotas)

Montagem: `router` → `/api/financeiro`

| Método | Caminho completo | Linha | Acesso |
| --- | --- | --- | --- |
| GET | `/api/financeiro/dados` | 299 | login |
| GET | `/api/financeiro/historico` | 312 | login |
| GET | `/api/financeiro/ficha/:doc` | 331 | login |
| POST | `/api/financeiro/titulos` | 354 | ver arquivo |

## `server/index.js` (19 rotas)

Montagem: `app` → `/`

| Método | Caminho completo | Linha | Acesso |
| --- | --- | --- | --- |
| GET | `/health` | 93 | ver arquivo |
| GET | `/pesquisa` | 96 | ver arquivo |
| GET | `/gamificacao` | 102 | ver arquivo |
| GET | `/gamificacao/ranking` | 103 | ver arquivo |
| GET | `/gamificacao/regras` | 109 | ver arquivo |
| GET | `/contabil` | 114 | ver arquivo |
| GET | `/minha-nota` | 120 | ver arquivo |
| GET | `/qualidade` | 124 | ver arquivo |
| GET | `/legalizacao` | 130 | ver arquivo |
| GET | `/legalizacao-antiga` | 135 | ver arquivo |
| GET | `/legalizacao/regras` | 140 | ver arquivo |
| GET | `/cs/como-funciona` | 145 | ver arquivo |
| GET | `/cs/sla` | 150 | ver arquivo |
| GET | `/cs` | 155 | ver arquivo |
| GET | `/financeiro` | 160 | ver arquivo |
| GET | `/financiero` | 163 | ver arquivo |
| GET | `/js/:file` | 166 | ver arquivo |
| GET | `/css/:file` | 170 | ver arquivo |
| GET | `*` | 177 | ver arquivo |

## `server/push.js` (3 rotas)

Montagem: `router` → `/api/push`

Barreira de sessão (`router.use(requireAuth)`): linha 116.

| Método | Caminho completo | Linha | Acesso |
| --- | --- | --- | --- |
| GET | `/api/push/chave` | 117 | login |
| POST | `/api/push/assinar` | 121 | login |
| POST | `/api/push/cancelar` | 128 | login |

## `server/reset.js` (3 rotas)

Montagem: `router` → `/api/auth`

| Método | Caminho completo | Linha | Acesso |
| --- | --- | --- | --- |
| POST | `/api/auth/forgot-password` | 23 | ver arquivo |
| GET | `/api/auth/reset-valido` | 66 | ver arquivo |
| POST | `/api/auth/reset-password` | 80 | ver arquivo |

## `server/routes/analistas.js` (4 rotas)

Montagem: `router` → `/api/analistas`

| Método | Caminho completo | Linha | Acesso |
| --- | --- | --- | --- |
| GET | `/api/analistas` | 32 | login |
| POST | `/api/analistas` | 48 | admin |
| PATCH | `/api/analistas/:id` | 66 | admin |
| DELETE | `/api/analistas/:id` | 89 | admin |

## `server/routes/auth.js` (5 rotas)

Montagem: `router` → `/api/auth`

| Método | Caminho completo | Linha | Acesso |
| --- | --- | --- | --- |
| POST | `/api/auth/register` | 17 | ver arquivo |
| POST | `/api/auth/login` | 61 | ver arquivo |
| POST | `/api/auth/refresh` | 88 | ver arquivo |
| POST | `/api/auth/logout` | 117 | login |
| GET | `/api/auth/me` | 128 | login |

## `server/routes/data.js` (172 rotas)

Montagem: `router` → `/api/data`; `publicRouter` → `/api/public`

Barreira de sessão (`router.use(requireAuth)`): linha 809.

| Método | Caminho completo | Linha | Acesso |
| --- | --- | --- | --- |
| GET | `/api/data/legalizacao/alvaras-a-consultar` | 35 | pública/token |
| POST | `/api/data/legalizacao/inscricao-municipal-arquivo` | 75 | pública/token |
| POST | `/api/data/gestao/honorarios-omie` | 92 | pública/token |
| POST | `/api/data/financeiro/importar` | 165 | pública/token |
| POST | `/api/data/legalizacao/saude-rotina` | 231 | pública/token |
| POST | `/api/data/legalizacao/alvaras-dispensa` | 250 | pública/token |
| POST | `/api/data/legalizacao/alvaras-consulta-local` | 281 | pública/token |
| GET | `/api/data/legalizacao/clientes-ativos` | 349 | pública/token |
| POST | `/api/data/legalizacao/alvaras-arquivo` | 360 | pública/token |
| POST | `/api/data/legalizacao/cnaes-completar` | 399 | pública/token |
| POST | `/api/data/legalizacao/sanitario-avaliar` | 405 | pública/token |
| GET | `/api/data/legalizacao/redesim-a-consultar` | 420 | pública/token |
| GET | `/api/data/legalizacao/redesim-resumo` | 441 | pública/token |
| POST | `/api/data/legalizacao/redesim-reprocessar` | 522 | pública/token |
| POST | `/api/data/legalizacao/redesim-resultado` | 540 | pública/token |
| POST | `/api/data/legalizacao/certificados/importar-certiseguro` | 571 | pública/token |
| POST | `/api/data/legalizacao/certificados/sincronizar-certiseguro` | 601 | pública/token |
| POST | `/api/data/legalizacao/certificados/atualizar-agora` | 616 | admin |
| POST | `/api/data/legalizacao/procuracoes/importar` | 711 | pública/token |
| POST | `/api/data/legalizacao/protocolo-online` | 799 | pública/token |
| POST | `/api/data/legalizacao/protocolo-online-manual` | 812 | admin |
| POST | `/api/data/legalizacao/procuracoes/importar-manual` | 827 | admin |
| GET | `/api/data/atendimentos` | 865 | login |
| POST | `/api/data/atendimentos` | 873 | login |
| GET | `/api/data/financeiro` | 900 | admin |
| GET | `/api/data/gestao` | 958 | login |
| POST | `/api/data/gestao` | 1021 | login |
| POST | `/api/data/gestao/importar` | 1073 | admin |
| POST | `/api/data/clientes/importar-acessorias` | 1615 | admin |
| GET | `/api/data/insatisfacoes` | 1648 | login |
| POST | `/api/data/insatisfacoes` | 1662 | login |
| PATCH | `/api/data/insatisfacoes/:id/status` | 1688 | login |
| GET | `/api/data/sensiveis` | 1704 | login |
| POST | `/api/data/sensiveis` | 1712 | login |
| GET | `/api/data/pesquisas` | 1729 | login |
| POST | `/api/data/pesquisas` | 1737 | login |
| GET | `/api/data/recuperacoes` | 1752 | login |
| POST | `/api/data/recuperacoes` | 1761 | login |
| GET | `/api/data/dashboard` | 1782 | login |
| PATCH | `/api/data/pesquisas/:id/tratado` | 1906 | login |
| DELETE | `/api/data/pesquisas/clear` | 1918 | admin |
| DELETE | `/api/data/atendimentos/clear` | 1928 | admin |
| DELETE | `/api/data/gestao/clear` | 1935 | admin |
| DELETE | `/api/data/insatisfacoes/clear` | 1942 | admin |
| DELETE | `/api/data/sensiveis/clear` | 1949 | admin |
| DELETE | `/api/data/pesquisas/:id` | 1956 | admin |
| DELETE | `/api/data/recuperacoes/clear` | 1963 | admin |
| DELETE | `/api/data/atendimentos/:id` | 1970 | admin |
| DELETE | `/api/data/gestao/:id` | 1977 | admin |
| DELETE | `/api/data/recuperacoes/:id` | 1986 | admin |
| GET | `/api/data/clientes` | 1995 | login |
| POST | `/api/data/clientes` | 2032 | login |
| GET | `/api/data/clientes/:id` | 2072 | login |
| PATCH | `/api/data/clientes/:id` | 2091 | admin |
| PATCH | `/api/data/clientes/:id/encerrar` | 2111 | admin |
| PATCH | `/api/data/clientes/:id/completar-entrada` | 2141 | admin |
| POST | `/api/data/clientes/:id/honorario` | 2193 | admin |
| POST | `/api/data/clientes/reajuste-em-massa` | 2231 | admin |
| GET | `/api/data/carteira/dashboard` | 2278 | login |
| DELETE | `/api/data/clientes/clear` | 2330 | admin |
| DELETE | `/api/data/clientes/:id` | 2344 | admin |
| DELETE | `/api/data/insatisfacoes/:id` | 2352 | admin |
| DELETE | `/api/data/sensiveis/:id` | 2360 | admin |
| DELETE | `/api/data/clear` | 2368 | admin |
| PATCH | `/api/data/perfil` | 2379 | login |
| GET | `/api/data/investimentos` | 2434 | login |
| POST | `/api/data/investimentos` | 2450 | admin |
| PATCH | `/api/data/investimentos/:id` | 2469 | admin |
| DELETE | `/api/data/investimentos/clear` | 2486 | admin |
| DELETE | `/api/data/investimentos/:id` | 2493 | admin |
| GET | `/api/data/cac/dashboard` | 2500 | login |
| GET | `/api/data/notificacoes` | 2564 | login |
| PATCH | `/api/data/notificacoes/:id/lida` | 2580 | login |
| PATCH | `/api/data/notificacoes/todas/lidas` | 2587 | login |
| POST | `/api/data/notificacoes` | 2595 | login |
| GET | `/api/data/relatorio-executivo` | 2607 | admin |
| GET | `/api/data/busca-global` | 2718 | login |
| GET | `/api/data/log-atividades` | 2754 | admin |
| DELETE | `/api/data/log-atividades` | 2780 | admin |
| GET | `/api/data/backup` | 2899 | admin |
| GET | `/api/data/backups-automaticos` | 2974 | admin |
| GET | `/api/data/backups-automaticos/:id/download` | 2987 | admin |
| POST | `/api/public/pesquisa` | 3008 | pública |
| GET | `/api/public/gamificacao` | 3132 | pública |
| GET | `/api/data/gam/consolidado` | 3513 | admin |
| POST | `/api/data/gam/ferias` | 3529 | admin |
| DELETE | `/api/data/gam/ferias` | 3543 | admin |
| GET | `/api/data/gam/config` | 3554 | admin |
| PATCH | `/api/data/gam/config` | 3567 | admin |
| GET | `/api/data/gam/meses-fechados` | 3604 | admin |
| POST | `/api/data/gam/mes/:mes/fechar` | 3611 | admin |
| POST | `/api/data/gam/mes/:mes/reabrir` | 3625 | admin |
| GET | `/api/data/gam/colaboradores` | 3635 | admin |
| POST | `/api/data/gam/colaboradores` | 3643 | admin |
| PATCH | `/api/data/gam/colaboradores/:id/toggle` | 3655 | admin |
| DELETE | `/api/data/gam/colaboradores/:id` | 3665 | admin |
| GET | `/api/data/gam/notas` | 3673 | admin |
| POST | `/api/data/gam/notas` | 3686 | admin |
| DELETE | `/api/data/gam/notas/:id` | 3705 | admin |
| POST | `/api/data/gam/nota-final-override` | 3719 | admin |
| GET | `/api/data/gam/nota-final-override` | 3735 | admin |
| DELETE | `/api/data/gam/nota-final-override` | 3752 | admin |
| DELETE | `/api/data/gam/nota-final-override/:id` | 3759 | admin |
| GET | `/api/data/gam/usuarios-zappy` | 3773 | admin |
| PATCH | `/api/data/gam/colaboradores/:id/aceite` | 3788 | admin |
| POST | `/api/data/gam/colaboradores/criar-logins-em-lote` | 3818 | admin |
| PATCH | `/api/data/gam/colaboradores/:id/login` | 3865 | admin |
| PATCH | `/api/data/gam/colaboradores/:id/zappy` | 3878 | admin |
| GET | `/api/data/gam/qualificacao-mapa` | 3895 | admin |
| PATCH | `/api/data/gam/qualificacao-mapa` | 3903 | admin |
| GET | `/api/data/gam/diagnostico-analista` | 4270 | admin |
| GET | `/api/data/gam/diagnostico-vinculos` | 4331 | admin |
| POST | `/api/data/gam/notas/auto-preencher` | 4353 | admin |
| GET | `/api/data/gam/minha-composicao` | 4374 | login |
| GET | `/api/data/gam/meus-tickets` | 4395 | login |
| GET | `/api/data/gam/composicao-nota` | 4431 | admin |
| POST | `/api/data/gam/recalcular-pontos` | 4454 | admin |
| GET | `/api/data/gam/relatorio-descontos` | 4480 | admin |
| GET | `/api/data/gam/tickets-revisao` | 4539 | admin |
| PATCH | `/api/data/gam/tickets-revisao/:id` | 4595 | admin |
| GET | `/api/data/gam/tickets-revisao-velocidade` | 4632 | admin |
| PATCH | `/api/data/gam/tickets-revisao-velocidade/:ticketId/:papel` | 4670 | admin |
| GET | `/api/data/gam/tickets-revisao-aceite` | 4709 | admin |
| PATCH | `/api/data/gam/tickets-revisao-aceite/:ticketId/:papel` | 4747 | admin |
| GET | `/api/data/gam/tickets-revisao-finalizar` | 4786 | admin |
| PATCH | `/api/data/gam/tickets-revisao-finalizar/:ticketId/:papel` | 4822 | admin |
| GET | `/api/data/gam/tickets-revisao-abandono` | 4863 | admin |
| PATCH | `/api/data/gam/tickets-revisao-abandono/:id` | 4895 | admin |
| GET | `/api/data/gam/ticket-busca` | 4929 | admin |
| GET | `/api/data/tickets` | 5030 | login |
| POST | `/api/data/tickets` | 5116 | admin |
| GET | `/api/data/tickets/:id` | 5130 | login |
| POST | `/api/data/tickets/:id/interacoes` | 5152 | login |
| PATCH | `/api/data/tickets/:id/checklist` | 5196 | login |
| PATCH | `/api/data/tickets/:id/finalizar` | 5245 | login |
| PATCH | `/api/data/tickets/:id/status` | 5276 | admin |
| DELETE | `/api/data/tickets/clear` | 5286 | admin |
| DELETE | `/api/data/tickets/:id` | 5294 | admin |
| GET | `/api/data/tickets-usuarios` | 5302 | login |
| GET | `/api/data/sentimento` | 5349 | admin |
| GET | `/api/data/churn` | 5368 | admin |
| GET | `/api/data/legalizacao/painel` | 5813 | login |
| GET | `/api/data/legalizacao/historico` | 5839 | login |
| GET | `/api/data/legalizacao/saude` | 5898 | admin |
| PATCH | `/api/data/legalizacao/clientes/:clienteId/municipio` | 5957 | login |
| GET | `/api/data/legalizacao/conferencia` | 5981 | admin |
| POST | `/api/data/legalizacao/alvaras/:id/conferir` | 5995 | admin |
| PATCH | `/api/data/legalizacao/clientes/:clienteId/inscricao-municipal` | 6020 | login |
| PUT | `/api/data/legalizacao/procuracoes/:clienteId/:tipo` | 6033 | admin |
| PUT | `/api/data/legalizacao/alvaras/:clienteId/:tipo` | 6063 | login |
| POST | `/api/data/legalizacao/alvaras/:clienteId/:tipo/protocolo` | 6091 | login |
| POST | `/api/data/legalizacao/alvaras/:clienteId/:tipo/consultar-prefeitura` | 6208 | login |
| PATCH | `/api/data/legalizacao/alvaras/:id/desativar` | 6282 | admin |
| PATCH | `/api/data/legalizacao/certificados/:id/desativar` | 6291 | admin |
| PATCH | `/api/data/legalizacao/alvaras/:id/reativar` | 6300 | admin |
| PATCH | `/api/data/legalizacao/certificados/:id/reativar` | 6308 | admin |
| DELETE | `/api/data/legalizacao/alvaras/:id` | 6316 | admin |
| PUT | `/api/data/legalizacao/certificados/:clienteId` | 6330 | login |
| PATCH | `/api/data/legalizacao/certificados/:id` | 6351 | admin |
| DELETE | `/api/data/legalizacao/certificados/:id` | 6368 | admin |
| GET | `/api/data/legalizacao/notificacoes` | 6468 | login |
| POST | `/api/data/legalizacao/notificacoes/lidas` | 6484 | login |
| GET | `/api/data/legalizacao/motivos-inativacao` | 6495 | login |
| POST | `/api/data/legalizacao/solicitar-inativacao` | 6509 | login |
| GET | `/api/data/legalizacao/solicitacoes-inativacao` | 6541 | admin |
| PATCH | `/api/data/legalizacao/solicitacoes-inativacao/:id/aprovar` | 6561 | admin |
| PATCH | `/api/data/legalizacao/solicitacoes-inativacao/:id/rejeitar` | 6591 | admin |
| PATCH | `/api/data/legalizacao/certificados-cliente/:clienteId/desativar` | 6633 | admin |
| POST | `/api/data/legalizacao/solicitar-desativacao-certificado` | 6646 | login |
| GET | `/api/data/legalizacao/solicitacoes-desativacao` | 6678 | admin |
| PATCH | `/api/data/legalizacao/solicitacoes-desativacao/:id/aprovar` | 6692 | admin |
| PATCH | `/api/data/legalizacao/solicitacoes-desativacao/:id/rejeitar` | 6706 | admin |

## `server/routes/gamificacao.js` (8 rotas)

Montagem: `router` → `(NÃO MONTADO em index.js)`

| Método | Caminho completo | Linha | Acesso |
| --- | --- | --- | --- |
| GET | `(NÃO MONTADO em index.js) /ranking` | 16 | ver arquivo |
| GET | `(NÃO MONTADO em index.js) /consolidado-anual` | 51 | ver arquivo |
| GET | `(NÃO MONTADO em index.js) /admin/colaboradores` | 91 | login |
| POST | `(NÃO MONTADO em index.js) /admin/colaboradores` | 102 | admin |
| PATCH | `(NÃO MONTADO em index.js) /admin/colaboradores/:id` | 116 | admin |
| POST | `(NÃO MONTADO em index.js) /admin/notas` | 132 | admin |
| GET | `(NÃO MONTADO em index.js) /admin/notas` | 158 | login |
| PATCH | `(NÃO MONTADO em index.js) /admin/premios/:id` | 172 | admin |

## `server/routes/grupos-empresas.js` (4 rotas)

Montagem: `router` → `/api/grupos-empresas`

| Método | Caminho completo | Linha | Acesso |
| --- | --- | --- | --- |
| GET | `/api/grupos-empresas` | 42 | login |
| POST | `/api/grupos-empresas` | 58 | admin |
| PATCH | `/api/grupos-empresas/:id` | 76 | admin |
| DELETE | `/api/grupos-empresas/:id` | 90 | admin |

## `server/routes/motivos-churn.js` (4 rotas)

Montagem: `router` → `/api/motivos-churn`

| Método | Caminho completo | Linha | Acesso |
| --- | --- | --- | --- |
| GET | `/api/motivos-churn` | 67 | login |
| POST | `/api/motivos-churn` | 83 | admin |
| PATCH | `/api/motivos-churn/:id` | 101 | admin |
| DELETE | `/api/motivos-churn/:id` | 128 | admin |

## `server/routes/unidades.js` (4 rotas)

Montagem: `router` → `/api/unidades`

| Método | Caminho completo | Linha | Acesso |
| --- | --- | --- | --- |
| GET | `/api/unidades` | 43 | login |
| POST | `/api/unidades` | 59 | admin |
| PATCH | `/api/unidades/:id` | 77 | admin |
| DELETE | `/api/unidades/:id` | 91 | admin |

## `server/routes/users.js` (6 rotas)

Montagem: `router` → `/api/users`

Barreira de sessão (`router.use(requireAuth)`): linha 8.

| Método | Caminho completo | Linha | Acesso |
| --- | --- | --- | --- |
| GET | `/api/users` | 21 | login |
| POST | `/api/users` | 33 | login |
| PATCH | `/api/users/:id/password` | 60 | login |
| DELETE | `/api/users/:id` | 74 | login |
| PATCH | `/api/users/:id/profile` | 87 | login |
| PATCH | `/api/users/:id/toggle` | 134 | login |
