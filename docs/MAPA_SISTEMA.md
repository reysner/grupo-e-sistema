# Mapa do sistema Grupo-E (engenharia reversa)

Especificação para reconstruir ou portar o sistema sem abrir o código. Escopo: sistema inteiro. Idioma: pt-BR. Níveis de certeza: [CONFIRMADO], [INFERIDO], [DÚVIDA].

## Índice

| Parte | Arquivo | Status |
| --- | --- | --- |
| Fase 1 — Inventário (pilha, pastas, módulos, tabelas, rotas, telas, integrações, jobs, achados) | [mapa/00-inventario.md](mapa/00-inventario.md) | **Pronta, aguardando sua aprovação** |
| Lista completa das 358 rotas HTTP | [mapa/00b-rotas.md](mapa/00b-rotas.md) | Gerada do código |
| Lista das 72 tabelas criadas pelo código | [mapa/00c-tabelas.md](mapa/00c-tabelas.md) | Gerada do código |
| **Fase 2 — módulo /cs (Sucesso do Cliente), por assunto** | | **Em andamento (começou pelo /cs, como combinado)** |
| /cs — acesso, login e papéis | [mapa/cs/00-base-acesso.md](mapa/cs/00-base-acesso.md) | Pronto |
| /cs — ingestão do Zappy, vínculos, SLA | [mapa/cs/01-ingestao-vinculos-sla.md](mapa/cs/01-ingestao-vinculos-sla.md) | Pronto |
| /cs — pontuação por ticket e abandono | [mapa/cs/02-pontuacao-abandono.md](mapa/cs/02-pontuacao-abandono.md) | Pronto |
| /cs — Qualidade (ocorrências, vínculos, anexos, alertas) | [mapa/cs/03-qualidade-ocorrencias.md](mapa/cs/03-qualidade-ocorrencias.md) | Pronto |
| /cs — Risco de perda (4 termômetros) | [mapa/cs/04-risco-de-perda.md](mapa/cs/04-risco-de-perda.md) | Pronto |
| /cs — Churn por saídas, motivos e Categorias | [mapa/cs/05-churn-categorias.md](mapa/cs/05-churn-categorias.md) | Pronto |
| /cs — Painel, ficha do cliente e módulo Atendimento | [mapa/cs/06-painel-ficha-atendimento.md](mapa/cs/06-painel-ficha-atendimento.md) | Pronto |
| /cs — Questor, Omie, Análise Anual, Honorário sugerido | [mapa/cs/07-questor-omie-analise-anual.md](mapa/cs/07-questor-omie-analise-anual.md) | Pronto |
| /cs — Sinais de e-mail, Logs, Backup, Limpeza | [mapa/cs/08-email-sinais-auditoria-manutencao.md](mapa/cs/08-email-sinais-auditoria-manutencao.md) | Pronto |
| /cs — Rotas do radar de SLA e Análise Inteligente | [mapa/cs/09-rotas-radar-sla-analise-inteligente.md](mapa/cs/09-rotas-radar-sla-analise-inteligente.md) | Pronto |
| /cs — telas e UX (`cs-painel.js`) | [mapa/cs/10-telas-cs.md](mapa/cs/10-telas-cs.md) | Pronto, com lacuna declarada: portais Gestor/Analista/Sucesso, Minha área, Acessos e formulários de Qualidade ainda sem o texto de cada botão |
| Gamificação (nota mensal, ranking, consolidado, revisões, férias, relatório) | [mapa/gamificacao.md](mapa/gamificacao.md) | Pronto |
| /legalizacao (alvarás, certificados, procurações, rotinas, pedidos) | [mapa/legalizacao.md](mapa/legalizacao.md) | Pronto |
| /financeiro (inadimplência, suspensos, cobranças, rotina do Omie) | [mapa/financeiro.md](mapa/financeiro.md) | Pronto |
| Núcleo (servidor, login, perfis, usuários, avisos, backups, rotinas automáticas) | [mapa/nucleo.md](mapa/nucleo.md) | Pronto |
| SPA `/` (atendimento, gestão, insatisfações, pesquisas, carteira, CAC, tickets, administração) | [mapa/spa-principal.md](mapa/spa-principal.md) | Pronto (telas descritas por campos e regras, sem cada rótulo) |
| 1. Visão geral | `mapa/01-visao-geral.md` | Fase 2 — não iniciada |
| 2. Arquitetura | `mapa/02-arquitetura.md` | Fase 2 — não iniciada |
| 3. Mapa de módulos e submódulos | `mapa/03-modulos.md` | Fase 2 — não iniciada |
| 4. Modelo de dados | `mapa/04-dados.md` | Fase 2 — não iniciada |
| 5. Regras de negócio | `mapa/05-regras.md` | Fase 2 — não iniciada |
| 6. Máquinas de estado e fluxos | `mapa/06-estados-fluxos.md` | Fase 2 — não iniciada |
| 7. KPIs, métricas e relatórios | `mapa/07-kpis.md` | Fase 2 — não iniciada |
| 8. Telas e UX | `mapa/08-telas.md` | Fase 2 — não iniciada |
| 9. API e funções de backend | `mapa/09-api.md` | Fase 2 — não iniciada |
| 10. Permissões e segurança | `mapa/10-permissoes.md` | Fase 2 — não iniciada |
| 11. Integrações externas | `mapa/11-integracoes.md` | Fase 2 — não iniciada |
| 12. Automações e processos em background | `mapa/12-automacoes.md` | Fase 2 — não iniciada |
| 13. Logs, auditoria e histórico | `mapa/13-logs.md` | Fase 2 — não iniciada |
| 14. Portabilidade | `mapa/14-portabilidade.md` | Fase 2 — depende do sistema de destino |
| 15. Pendências e inconsistências | `mapa/15-pendencias.md` | Fase 2 — começa com os achados da Fase 1 |
| 16. Checklist de cobertura | `mapa/16-cobertura.md` | Fase 2 — por último |
