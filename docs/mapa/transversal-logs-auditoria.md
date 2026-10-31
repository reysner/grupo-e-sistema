# Logs, auditoria e histórico — visão consolidada

O sistema não tem uma trilha de auditoria única. Há **um log central** (`log_atividades`) alimentado de dois jeitos, mais históricos próprios de alguns módulos e campos de autoria espalhados. Estado do código em 31/10/2026.

## 1. O log central: `log_atividades`

`id UUID`, `user_id`, `user_name`, `acao`, `modulo`, `descricao`, `ip`, `created_at` (índice por data decrescente). A mesma tabela serve a duas telas:

| Quem grava | Como | Módulos que aparecem |
| --- | --- | --- |
| `registrarLog(userId, userName, acao, modulo, descricao, req)` em `server/routes/data.js` | chamada **à mão** dentro de cada rota que o autor lembrou de registrar | carteira, legalização e outros do SPA; ações `criar`, `editar`, `excluir`, `importar`, `sync` |
| Filtro automático de `server/cs/auditoria.js` | para toda chamada `POST/PUT/PATCH/DELETE` bem-sucedida nas rotas de **Qualidade, Acessos e Analistas** | `cs-qualidade`, `cs-acessos`, `cs-analistas`, `cs-admin` |

Consulta: SPA `GET /api/data/log-atividades` (administrador, 200 por padrão) e /cs `GET /api/cs/painel/admin/logs` (administrador; filtros módulo, usuário, ação, texto e período; 300 por padrão, máximo 1000). Detalhes em [cs/08](cs/08-email-sinais-auditoria-manutencao.md) parte B e [nucleo](nucleo.md) seção 9.

### Lacunas do log (todas [CONFIRMADO])

1. **Nem tudo é registrado.** O registro do SPA depende de cada rota chamar `registrarLog`: por exemplo, `PATCH /clientes/:id/encerrar` e `DELETE /clientes/:id` (que apaga honorários e eventos em cascata) **não registram**.
2. **Ações do /cs fora de Qualidade/Acessos/Analistas não entram no filtro automático**: confirmar um vínculo de telefone como cliente (muda a pontuação da Gamificação), alterar Categorias, Risco ou limites não deixam rastro.
3. **Gamificação**: notas lançadas guardam só `lancado_por` na linha; revisões guardam `revisado_por/em`; fechar/reabrir mês guarda `fechado_por`. Não há histórico de valores anteriores.
4. **Pode ser apagado sem confirmação**: `DELETE /api/data/log-atividades` apaga tudo (administrador). A limpeza da Qualidade apaga todos os logs `cs-%`, mas registra a própria limpeza depois.
5. **Sem retenção definida**: a tabela cresce sem limite.
6. **IP:** o servidor usa `trust proxy = 1`, então `req.ip` é o IP do visitante visto pelo Render; se faltar, grava o cabeçalho `x-forwarded-for` ou "—".

## 2. Históricos próprios por módulo

| Módulo | Onde | O que guarda |
| --- | --- | --- |
| Qualidade | `cs_qualidade_historico` | cada passo da ocorrência (abrir, tratar, validar, devolver, cancelar) |
| Qualidade | `cs_limpezas` | cópia completa antes de cada limpeza |
| Carteira | `honorarios`, `eventos_clientes` | histórico de honorários e eventos de entrada/saída/reajuste |
| Risco | `cs_painel_config` (chaves `risco_foto_AAAA-MM-DD`, 120 dias, e `risco_foto_ultima`) | evolução dos termômetros |
| Financeiro | `financeiro_historico` | retrato semanal dos números |
| Legalização | retrato semanal, `legalizacao_notif_visto`, solicitações de inativação e desativação | quem pediu, quem decidiu, quando |
| Cargas de máquina (Omie, Questor, e-mail) | **nada**: cada carga substitui a anterior | o backup do banco é a única rede |
| Gamificação | revisões (`gam_*_revisoes`), férias, meses fechados | autor e data de cada decisão |

## 3. Backups (a "auditoria de última instância")

| Tipo | O que cobre | O que **não** cobre |
| --- | --- | --- |
| Manual `GET /api/data/backup` (administrador) | 31 conjuntos do SPA, Gamificação, Qualidade, `cs_acessos` | `users`, `refresh_tokens`, `cs_config`, `cs_painel_config` (inclui chaves do push), Legalização, Financeiro, Omie, Questor, e-mail |
| Automático diário (`backups_automaticos`, 30 mais recentes) | o mesmo conteúdo | o mesmo; e fica **no mesmo banco** que protege |
| Backup da Qualidade (`/admin/backup`) | tabelas de Qualidade, anexos só com metadados | tudo o mais |

Para recuperação de verdade é preciso `pg_dump` ou o backup do provedor ([guia de migração](../MIGRACAO_DE_MAQUINA.md)).

## 4. Recomendações registradas (não implementadas)

1. Registrar no log: encerrar/excluir cliente, confirmar vínculo de telefone, mudanças de Categorias/Risco, abrir/fechar mês da Gamificação.
2. Exigir confirmação (frase) em `DELETE /log-atividades` e `DELETE /api/data/clear`.
3. Definir retenção do log (por exemplo, 24 meses) e exportar periodicamente.
4. Incluir `users` e as tabelas de Legalização/Financeiro no backup automático, ou documentar o `pg_dump` agendado no provedor.
