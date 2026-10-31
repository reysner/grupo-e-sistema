# Visão geral e arquitetura

Resumo de uma página para quem chega sem conhecer o sistema. Cada item aponta para o arquivo que tem o detalhe e a evidência. Estado do código em 31/10/2026.

## 1. O que é

O **Grupo-E** é o sistema interno do escritório contábil Escritorial para acompanhar clientes e a equipe. Quatro entradas web, todas no mesmo servidor:

| Entrada | Para quê | Quem usa | Detalhe |
| --- | --- | --- | --- |
| `/` (SPA) | atendimentos, gestão de clientes, insatisfações, pesquisas, Carteira, CAC, tickets internos, administração | equipe e liderança | [spa-principal](spa-principal.md) |
| `/cs` | Sucesso do Cliente: radar de SLA, risco de perda, churn, categorias, Qualidade, painéis de Gestor/Analista | liderança, gestores, analistas | arquivos `cs/00` a `cs/10` |
| `/legalizacao` | alvarás, certificados digitais, procurações | liderança e analistas com a marca | [legalizacao](legalizacao.md) |
| `/financeiro` | inadimplência, suspensos, cobranças | liderança e quem tem a marca | [financeiro](financeiro.md) |

Páginas sem login: ranking da **Gamificação** (`/gamificacao/ranking`, [gamificacao](gamificacao.md)) e pesquisa de satisfação pública.

## 2. Como é construído

| Camada | Escolha | Observação |
| --- | --- | --- |
| Servidor | Node.js + Express, um único processo | monta as rotas em `server/index.js` |
| Banco | PostgreSQL (`pg`), sem ORM e sem pasta de migrations | tabelas criadas "na hora" por `CREATE TABLE IF NOT EXISTS` dentro das rotas; 5 tabelas centrais (`clientes`, `honorarios`, `eventos_clientes`, `analistas`, `investimentos`) não têm `CREATE` no repositório |
| Front-end | HTML, CSS e JavaScript puros, sem build | `app.js` ≈ 11 mil linhas; `cs-painel.js` ≈ 4,3 mil |
| Sessão | JWT de 2 h + refresh de 30 dias no `localStorage` | [transversal-permissoes](transversal-permissoes.md) |
| Hospedagem | Render (web service) com deploy a partir do GitHub (`reysner/grupo-e-sistema`, ramo `main`) | repositório **público** |
| Rotinas | `setInterval` dentro do processo web + estação Windows + *userscripts* | [transversal-integracoes-automacoes](transversal-integracoes-automacoes.md) |
| Testes | scripts Node com `assert`, rodados à mão; sem CI | cobertura em [transversal-pendencias-cobertura](transversal-pendencias-cobertura.md) |

## 3. Como as partes conversam

```
Navegador (4 entradas)  ──HTTPS──►  Express (um processo no Render)  ──pg──►  PostgreSQL
                                        ▲        │
 Zappy ◄── busca a cada 5 min ──────────┘        ├── Acessórias (24 h), CertiSeguro (2×/dia), Receita, IBGE
                                                 └── e-mail (SMTP) e avisos push
 Estação Windows / navegador do Reysner ──X-Sync-Token──► Questor, Omie, e-mail, prefeituras, REDESIM, e-CAC, pastas de rede
```

## 4. Princípios que o código segue (e onde foge deles)

1. **O servidor decide o acesso; a tela só esconde.** Vale em quase tudo; exceção conhecida: o botão "Ocultar valores".
2. **Só metadados** nos dados sensíveis de e-mail (nunca o conteúdo).
3. **Cada carga de máquina substitui a anterior**, sem histórico.
4. **Falha silenciosa** é a escolha padrão em consultas opcionais: a tela sobe, mas esquema quebrado não alerta ninguém.
5. **Regras de negócio no código**, não em configuração: nomes fixos (cobrador "Bruno Xavier", colaboradora "Elma"), horários, janelas de dias, pesos e feriados de 2026.

## 5. O que este mapa ainda não cobre

A seção de **portabilidade** depende do sistema de destino, que não foi informado; o que existe é o [guia de migração de máquina](../MIGRACAO_DE_MAQUINA.md) (mudar de computador e de hospedagem mantendo o mesmo sistema).
