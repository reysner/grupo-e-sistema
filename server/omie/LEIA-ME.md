# Rotina diária do Omie (11:00) — honorário, ticket médio e inadimplência

Duas empresas no Omie: **Soluções Escritorial** e **Escritorial** (cada uma vira uma "unidade" no módulo Financeiro).

## Como funciona
1. O Reysner (presente às 11:00) faz o login no Omie e clica em **Acessar** em cada empresa, deixando as duas abas do ERP abertas no
   navegador integrado do Claude. **Ninguém digita senha por ele** — e o Claude nunca deve digitar/pedir senha.
2. A rotina agendada (tarefa "omie-financeiro-11h") lê, só em leitura, **Finanças → Contas a Receber** de cada aba, com os scripts de
   `paginaContasReceber.js` (coleta paginada + resumo).
3. Grava dois arquivos de texto por unidade (pasta `server/omie/tmp/`, ignorada pelo Git) e roda `importarOmie.js`, que atualiza:
   - o módulo **Financeiro** (snapshot da unidade: honorário atual, ticket médio, faixas, inadimplência);
   - **Gestão de Clientes**: preenche honorário que falta e cria cliente "Não há cadastro no Acessórias". Honorário diferente do cadastrado
     só é relatado (troca só com `--diferentes`, decisão do Reysner).

## Regras do honorário (definidas com o Reysner em 21/09/2026)
- Só a categoria **SERVIÇOS HONORÁRIOS CONTÁBEIS**; título misto conta só a fração dessa categoria (ex.: "… (58,44%)").
- Honorário atual = último valor que se repete em ≥2 meses seguidos nos últimos 7 meses (reajuste costuma ser em fevereiro); um mês com
  valor a mais é serviço extra e é ignorado.
- Cliente ativo no Omie = tem honorário nos últimos 3 meses. Inadimplente = tem valor de honorário em aberto com vencimento já passado.
- Ticket médio = média dos honorários atuais da unidade; "na média" = média ± R$ 50 (mesma banda de Gestão de Clientes).

## Se a aba do ERP não estiver aberta/logada
Não tentar logar. Avisar o Reysner (o ERP só abre em aba nova por clique dele em "Acessar" no Portal Omie) e parar; os dados do dia anterior
continuam no Financeiro.

## Alternativa sem login (futuro)
API do Omie com App Key/App Secret de cada empresa (variáveis `OMIE_SOLUCOES_APP_KEY/SECRET`, `OMIE_ESCRITORIAL_APP_KEY/SECRET` no servidor).
