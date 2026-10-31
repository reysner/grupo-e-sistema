# Como atualizar a documentação do sistema

A documentação é um retrato do código no dia em que foi escrita. Ela **não se atualiza sozinha**: quando o sistema muda, alguém precisa reler o que mudou. O cabeçalho de `docs/MAPA_SISTEMA_COMPLETO.md` informa o commit do código usado ("Gerado em … com o código no commit `xxxxxxx`"). Esse commit é o ponto de partida de toda atualização.

## O que vale guardar

| Para quê | O que guardar |
| --- | --- |
| Entender ou reconstruir o sistema | `docs/MAPA_SISTEMA_COMPLETO.md` (um arquivo só) |
| Trocar de máquina ou servidor | `docs/MIGRACAO_DE_MAQUINA.md` **e** o que o guia lista fora do código: o banco (`pg_dump`), os valores das variáveis de ambiente e as tarefas agendadas. **Só o `.md` não basta** para subir o sistema |
| Ter tudo versionado | a pasta `docs/` e o `README.md` no GitHub (já estão lá) |

## Passo a passo para atualizar (daqui a 1 ou 2 meses)

1. **Ver o que mudou no código desde a última documentação.** Abra o cabeçalho do `MAPA_SISTEMA_COMPLETO.md` e anote o commit. Na pasta do projeto:
   ```bash
   git log <commit>..HEAD --oneline          # lista das mudanças
   git diff <commit>..HEAD --stat            # arquivos mais alterados
   ```
2. **Pedir a atualização ao Claude**, com este pedido (troque o commit):
   > Atualize a documentação em `docs/mapa/` e regere `docs/MAPA_SISTEMA_COMPLETO.md`. A documentação atual foi escrita no commit `<commit>`. Leia `git log <commit>..HEAD` e `git diff <commit>..HEAD`, atualize só os arquivos dos módulos que mudaram (rotas novas, regras, tabelas, telas, rotinas), marque o que mudou e termine rodando `node docs/gerar-documento-unico.js`.
   Se quiser incluir uma área ainda não escrita (a SPA `/`, o núcleo ou as seções transversais), diga qual no mesmo pedido.
3. **Conferir** o arquivo gerado: o cabeçalho deve mostrar o commit novo e a data de hoje; as rotas e tabelas novas devem aparecer nos anexos.
4. **Commitar** `docs/` e `README.md` e enviar para o GitHub.

## Se for refazer sozinho, sem o Claude

- Cada módulo tem um arquivo em `docs/mapa/` (`cs/`, `gamificacao.md`, `legalizacao.md`, `financeiro.md`). Edite o que mudou à mão, mantendo as marcas **[CONFIRMADO]**, **[INFERIDO]** e **[DÚVIDA]**.
- Para refazer as listas de rotas e tabelas (`00b-rotas.md`, `00c-tabelas.md`) é preciso reler o código; elas foram geradas por scripts auxiliares que não estão no repositório. Peça ao Claude para regerá-las.
- Depois rode, na raiz do projeto:
  ```bash
  node docs/gerar-documento-unico.js
  ```
  O script junta tudo em `docs/MAPA_SISTEMA_COMPLETO.md`, troca os links entre arquivos por "(parte N)", grava o commit atual no cabeçalho e **se recusa a gerar** se achar algo parecido com senha, token ou chave.
- Para incluir um arquivo novo no documento único, acrescente uma linha na lista `partes` no começo do script (e atualize os textos `PRONTAS` e `PENDENTES`).

## O que mais envelhece rápido

Valores que mudam sem alterar muito código: horários das tarefas agendadas, endereço de produção, quem tem acesso a cada página, listas de motivos e de analistas (ficam no banco) e os parâmetros de regra (janelas de dias, pesos, cortes). Quando a regra de negócio mudar, ajuste o arquivo do módulo na mesma semana; é bem mais barato do que reconstruir depois.

## Não esqueça

- Nunca escreva valores de senha, token ou chave nestes arquivos: só os nomes das variáveis.
- O guia de migração tem itens marcados **[CONFERIR]** (onde o banco está hospedado, horários reais das tarefas do Windows). Preencha-os na primeira oportunidade.
