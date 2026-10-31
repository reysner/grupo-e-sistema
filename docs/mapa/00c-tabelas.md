# Tabelas (inventário gerado do código)

Gerado por varredura de `CREATE TABLE IF NOT EXISTS` e `ALTER TABLE … ADD COLUMN IF NOT EXISTS` em `server/**`. Total: **72 tabelas**. Todas são criadas por código na subida do servidor (não há pasta de migrations; [CONFIRMADO] — o esquema é "criar se não existir" dentro de funções `ensure*Schema` e de `server/db.js`). A Fase 2 detalha colunas, tipos, índices e restrições de cada uma.

## Autenticação, usuários e acessos (9)

| Tabela | Criada em | Colunas acrescentadas depois (ALTER) |
| --- | --- | --- |
| `backups_automaticos` | `server/routes/data.js` | — |
| `cs_acessos` | `server/cs/acessos.js` | — |
| `cs_acessos_migracoes` | `server/cs/acessos.js` | — |
| `cs_limpezas` | `server/cs/auditoria.js` | — |
| `log_atividades` | `server/cs/auditoria.js`, `server/routes/data.js` | — |
| `push_assinaturas` | `server/push.js` | — |
| `refresh_tokens` | `server/db.js` | — |
| `reset_tokens` | `server/reset.js` | — |
| `users` | `server/db.js` | 8 (acesso_minha_nota, acesso_legalizacao, acesso_cs, acesso_financeiro, acesso_financeiro_sv, acesso_qualidade, active, regimes_atendidos) |

## Módulos do painel principal (/) (12)

| Tabela | Criada em | Colunas acrescentadas depois (ALTER) |
| --- | --- | --- |
| `atendimentos` | `server/db.js` | — |
| `clientes_sensiveis` | `server/db.js` | 1 (detalhe) |
| `gestao_clientes` | `server/db.js` | 2 (codigo, regime_tributario) |
| `grupos_empresas` | `server/routes/grupos-empresas.js` | — |
| `insatisfacoes` | `server/db.js` | 3 (status, area, tipo) |
| `motivos_churn` | `server/routes/motivos-churn.js` | — |
| `pesquisas` | `server/db.js` | 1 (tratado) |
| `recuperacoes` | `server/db.js` | 1 (insatisfacao_id) |
| `ticket_interacoes` | `server/routes/data.js` | — |
| `ticket_mencoes` | `server/routes/data.js` | — |
| `tickets` | `server/routes/data.js` | 1 (dados_gestao) |
| `unidades` | `server/routes/unidades.js` | — |

## Sucesso do Cliente (/cs): SLA, tratativas, risco, churn, categorias, e-mail (22)

| Tabela | Criada em | Colunas acrescentadas depois (ALTER) |
| --- | --- | --- |
| `acessorias_tags` | `server/cs/categorias.js` | — |
| `cliente_entregas_resumo` | `server/cs/risco.js` | 1 (versao) |
| `cliente_tags` | `server/cs/categorias.js` | — |
| `cs_afastamento_tratamentos` | `server/cs/routes.js` | — |
| `cs_churn_tratamentos` | `server/cs/routes.js` | — |
| `cs_email_atendimento` | `server/cs/emailSinais.js` | 3 (comp_recebidos, comp_sem, comp_destinatarios) |
| `cs_email_atendimento_leitura` | `server/cs/emailSinais.js` | — |
| `cs_email_sinais` | `server/cs/emailSinais.js` | — |
| `cs_email_sinais_leitura` | `server/cs/emailSinais.js` | — |
| `cs_insatisfacao_tratamentos` | `server/cs/routes.js` | — |
| `cs_painel_config` | `server/cs/analistasNomes.js`, `server/cs/anualQuestor.js`, `server/cs/honorarioSugerido.js`, `server/cs/limpezaTeste.js`, `server/cs/omieHonorarios.js`, `server/push.js`, `server/routes/motivos-churn.js` | — |
| `cs_qualidade_alertas` | `server/cs/alertasPrazo.js` | — |
| `cs_qualidade_anexos` | `server/cs/qualidade.js` | 1 (historico_id) |
| `cs_qualidade_gestores` | `server/cs/qualidade.js` | — |
| `cs_qualidade_historico` | `server/cs/qualidade.js` | — |
| `cs_qualidade_registros` | `server/cs/qualidade.js` | 25 (validado_em, validado_por, origem, plano_cs, assunto, prioridade, encaminhada, etapa, …) |
| `cs_qualidade_resp` | `server/cs/qualidade.js` | — |
| `cs_qualidade_tipos` | `server/cs/qualidade.js` | — |
| `omie_contratos_suspensos` | `server/cs/risco.js` | — |
| `omie_honorario_anual` | `server/cs/omieHonorarios.js` | — |
| `questor_cliente_anual` | `server/cs/anualQuestor.js` | 5 (funcionarios, funcionarios_media, regime, regime_fonte, aviso) |
| `questor_cliente_dados` | `server/cs/questorDados.js` | 1 (aviso) |

## Gamificação (Liga do Atendimento) (12)

| Tabela | Criada em | Colunas acrescentadas depois (ALTER) |
| --- | --- | --- |
| `gam_abandono_incidentes` | `server/cs/abandono.js` | 1 (override_analista_id) |
| `gam_aceite_revisoes` | `server/routes/data.js` | 1 (override_analista_id) |
| `gam_colaboradores` | `server/routes/data.js` | 3 (zappy_user_id, aplica_regra_aceite, user_id) |
| `gam_config` | `server/routes/data.js` | — |
| `gam_ferias` | `server/routes/data.js` | — |
| `gam_finalizar_revisoes` | `server/routes/data.js` | 1 (override_analista_id) |
| `gam_meses_fechados` | `server/routes/data.js` | — |
| `gam_nota_final_override` | `server/routes/data.js` | — |
| `gam_notas` | `server/routes/data.js` | — |
| `gam_qualificacao_mapa` | `server/routes/data.js` | — |
| `gam_tickets_pontos` | `server/cs/pontuacao.js` | 1 (ajuste_aceite) |
| `gam_velocidade_revisoes` | `server/routes/data.js` | 1 (override_analista_id) |

## Financeiro (/financeiro) (6)

| Tabela | Criada em | Colunas acrescentadas depois (ALTER) |
| --- | --- | --- |
| `financeiro_aberto` | `server/routes/data.js` | — |
| `financeiro_clientes` | `server/routes/data.js` | — |
| `financeiro_historico` | `server/financeiro/rotas.js` | — |
| `financeiro_importacoes` | `server/routes/data.js` | — |
| `financeiro_pontualidade` | `server/financeiro/rotas.js` | — |
| `financeiro_titulos` | `server/financeiro/rotas.js` | — |

## Legalização (/legalizacao) (10)

| Tabela | Criada em | Colunas acrescentadas depois (ALTER) |
| --- | --- | --- |
| `legalizacao_alvaras` | `server/routes/data.js` | 19 (ultima_consulta_status, ultima_consulta_resumo, ultima_consulta_data_solicitacao, ultima_consulta_em, dispensado_motivo, dispensado_em, dispensado_fonte, notificado_vencimento_em, …) |
| `legalizacao_certificados` | `server/routes/data.js` | 2 (notificado_vencimento_em, desativado_em) |
| `legalizacao_historico` | `server/routes/data.js` | 2 (dispensado, nao_possui) |
| `legalizacao_notif_visto` | `server/routes/data.js` | — |
| `legalizacao_procuracoes` | `server/routes/data.js` | 1 (notificado_vencimento_em) |
| `legalizacao_protocolos` | `server/routes/data.js` | — |
| `legalizacao_redesim` | `server/routes/data.js` | — |
| `legalizacao_rotinas` | `server/routes/data.js` | — |
| `legalizacao_solicitacoes_desativacao` | `server/routes/data.js` | — |
| `legalizacao_solicitacoes_inativacao` | `server/routes/data.js` | 1 (motivo) |

## Notificações (1)

| Tabela | Criada em | Colunas acrescentadas depois (ALTER) |
| --- | --- | --- |
| `notificacoes` | `server/cs/qualidade.js`, `server/routes/data.js` | 1 (cliente_id) |

## Tabelas que recebem ALTER mas não têm CREATE no código (4)

- `cs_tickets` — colunas: abandono_calculado_em, analista_id, analista_anterior, analista_anterior_id, revisao_nota_status, revisao_nota_por, revisao_nota_em, revisao_nota_override_analista_id
- `clientes` — colunas: motivo_cancelamento_acessorias, situacao_receita, data_situacao_receita, situacao_receita_em, classificacao_manual, classificacao_manual_por, classificacao_manual_em, motivo_churn, motivo_churn_por, motivo_churn_em, inscricao_municipal, grupo_empresas, tipo_entrada, inadimplente_cronico, unidade, codigo, municipio, municipio_ibge, municipio_verificado_em, cnaes, acessorias_id, uf, alerta_baixa_notificado_em
- `analistas` — colunas: user_id, departamentos
- `investimentos` — colunas: recorrente, valor_original
