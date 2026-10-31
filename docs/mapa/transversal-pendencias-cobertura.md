# Pendências, inconsistências e checklist de cobertura

Consolida os "pontos de atenção" de todos os módulos e fecha com o que este mapa cobre e o que não cobre. Estado em 31/10/2026. Legenda: **Feito** = corrigido no código (as marcadas "após deploy" ainda precisam subir); **Aberto** = decisão ou trabalho pendente; **Conferir** = depende de olhar o banco ou a produção.

## 1. Corrigido em 31/10/2026

| # | Problema | Onde | Situação |
| --- | --- | --- | --- |
| 1 | Qualquer pessoa criava conta `usuario` pela tela de login | `server/routes/auth.js`, `public/index.html` | Feito e no ar (cadastro desligado; reabrir só com `CADASTRO_PUBLICO=1`) |
| 2 | Renomear motivo de churn apagava as letras "s" (regex `/s+/`) | `server/routes/motivos-churn.js` | Feito e no ar |
| 3 | Rota de churn por conversas escondida atrás de outra no mesmo prefixo | `server/cs/routes.js`, `public/js/app.js` | Feito e no ar (`/api/cs/churn-conversas`) |
| 4 | Analista (`colaborador`) recebia 403 em "Não vai renovar" e "Informar protocolo" | `server/auth.js` | Feito, **após deploy** |
| 5 | "Reabrir" meses 05–07/2026 e desligar a regra de aceite da Elma eram desfeitos a cada chamada | `server/routes/data.js` (`ensureGamTables`) | Feito, **após deploy** (semente única em `gam_config`) |
| 6 | `usuario` lia Carteira, honorários, MRR e CAC | `server/routes/data.js` | Feito, **após deploy** (cinco leituras só para administrador; o CAC de quem não é administrador é calculado no servidor) |
| 7 | Apagar `admin@grupoe.com.br` fazia o servidor recriá-lo a cada reinício | `server/index.js` | Feito, **após deploy** (só cria se não houver nenhum administrador) |
| 8 | Clientes Sensíveis eram lidos e registrados por qualquer usuário logado | `server/routes/data.js`, `public/index.html` | Feito, **após deploy** (só administrador; menu oculto; busca global sem esse módulo) |

## 2. Abertos, por prioridade

**Segurança**

1. ~~Varrer as 148 rotas "login"~~ — **feito em 31/10/2026** (leitura das regras internas de cada arquivo): as rotas de `/cs` marcadas "login" já checam o perfil por dentro (administrador, `usuario` ou `acesso_cs`; Acessos, Logs, Backup e limites só administrador), `users.js` inteiro é só administrador, e a busca global devolve só nome, CNPJ e módulo (sem honorário). Sobram como abertas ao `usuario`, **por desenho**, as rotas operacionais do SPA (atendimentos, gestão, insatisfações, pesquisas, recuperações, tickets, Dashboard) e as da Legalização. Decisão de negócio, não falha: se alguma deve ser só da liderança, precisa ser dita (Clientes Sensíveis já foi restrito em 31/10/2026).
2. Um só segredo (`LEGALIZACAO_SYNC_TOKEN`) para quase todas as cargas de máquina; separar por origem.
3. Tokens em `localStorage`; sem CSP e sem HSTS.
4. Exigir confirmação em `DELETE /api/data/clear`, `DELETE /api/data/log-atividades` e na limpeza da Qualidade (hoje basta a frase `LIMPAR` nesta última).
5. Falha aberta se `require('../auth')` não carregar (listas canônicas, radar de SLA).
6. Pesquisa pública sem proteção própria contra abuso.
7. Histórico do Git (repositório público) ainda contém a senha padrão antiga do administrador; conferir se alguma conta antiga a usou.

**Dados e consistência**

8. Cinco tabelas centrais sem `CREATE` no repositório (`clientes`, `honorarios`, `eventos_clientes`, `analistas`, `investimentos`): obter `pg_dump --schema-only`. **Conferir.**
9. Avisos de ticket gravam colunas (`user_id`, `referencia_id`) que a definição de `notificacoes` do código não tem; erro silenciado. **Conferir** no banco real.
10. Duas definições de LTV (48 meses fixos × retenção média) e dois modelos de churn (formulário de Gestão × Risco do /cs).
11. Saída registrada pelo formulário de Gestão ou aprovada na Legalização pode não contar como churn (texto do motivo não casa com "Transferida por…"). **Conferir** com um caso real.
12. Fuso: mês do ticket em UTC; algumas rotas do /cs usam o relógio UTC e as demais `America/Sao_Paulo`.
13. Backup automático dentro do mesmo banco e sem `users`, Legalização, Financeiro e configurações.
14. Cobrador fixo no código ("Bruno Xavier") no Financeiro; cliente "Elma" fixo na semente da Gamificação; feriados só de 2026.

**Operação**

15. Agenda da Legalização presa às variáveis do Zappy.
16. Dependência de estação Windows, VPN, IP liberado da CertiSeguro, login do gov.br e do Omie; horários reais não versionados.
17. Rotinas por `setInterval` no processo web (plano gratuito dorme e reinicia).
18. Arquivos gigantes: `server/routes/data.js` (≈ 6,7 mil linhas, 172 rotas) e `public/js/app.js` (≈ 11 mil linhas).
19. Código morto: `server/routes/gamificacao.js` (não montado), `routerAnalista` da Qualidade (desligado), `legalizacao-antiga.html`, `minha-nota.html`, `qualidade.html`, rotas temporárias de diagnóstico.
20. Texto desatualizado: tela de Oportunidades do /financeiro; `VERSAO` fixa em `cs-painel.js`; `render.yaml` com host diferente do em uso.

## 3. Checklist de cobertura deste mapa

| Área | Arquivo | Cobertura | Lacuna declarada |
| --- | --- | --- | --- |
| Inventário, rotas, tabelas | `00-inventario`, `00b-rotas`, `00c-tabelas` | completa para o que o código cria | 5 tabelas só por inferência; números de linha de `data.js` deslocados pelas correções de hoje |
| Núcleo (servidor, login, perfis, avisos, backups) | `nucleo` | completa | — |
| SPA `/` | `spa-principal` | regras e campos de cada tela | texto exato de cada rótulo |
| /cs | `cs/00` a `cs/10` | completa | portais Gestor/Analista/Sucesso, Minha área, Acessos e formulários de Qualidade sem o texto de cada botão |
| Gamificação | `gamificacao` | completa | — |
| /legalizacao | `legalizacao` | completa | horários reais das rotinas locais |
| /financeiro | `financeiro` | completa | conversão dos arquivos do Omie sem teste |
| Permissões | `transversal-permissoes` | consolidada, com a varredura das rotas "login" feita em 31/10/2026 | — |
| Integrações e automações | `transversal-integracoes-automacoes` | consolidada | lista de tarefas do Agendador da estação não conferida |
| Logs e auditoria | `transversal-logs-auditoria` | consolidada | — |
| Arquitetura | `transversal-arquitetura` | visão geral | — |
| Portabilidade | `../MIGRACAO_DE_MAQUINA.md` | só mudança de máquina/hospedagem do mesmo sistema | **depende do sistema de destino (não informado)** |

**Nada foi testado em produção com login de cada perfil**: tudo vem da leitura do código, mais a conferência de 31/10/2026 de que o cadastro público saiu do ar.

## 4. Testes automatizados que existem

Scripts Node com `assert`, rodados à mão (`node <arquivo>`); não há CI.

| Área | Arquivos |
| --- | --- |
| Acesso por perfil e cadastro desligado | `server/testes_acesso_perfis.js` (novo em 31/10/2026) |
| /cs | `server/cs/testes_*.js` (21 arquivos: acessos, alertas, categorias, churn, ingestão, painel, pontuação, qualidade, risco, SLA, tradutor…) |
| Financeiro | `server/financeiro/testes_*.js` (3) |
| Legalização | `server/testes_legalizacao_pagina.js`, `testes_legalizacao_retrato.js`, `testes_saude_rotinas.js` |
| Gamificação | `server/testes_gam_ferias.js` (só o consolidado com férias) |
| Questor / e-mail | `server/questor/testes_*.js`, `server/emailSinais/testes_email_sinais.js` |
| Outros | `server/testes_avisos.js`, `server/testes_push.js`, `server/arquivoMorto/nomes.test.js` |

**Sem teste:** nota mensal, ranking e pódio da Gamificação; revisões; Protocolo Online; regra de status em SQL da Legalização; rotas de entrada do Financeiro; toda a Carteira e o CAC (o teste novo cobre o filtro por perfil, não as consultas).
