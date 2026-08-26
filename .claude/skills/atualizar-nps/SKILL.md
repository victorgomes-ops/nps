---
name: atualizar-nps
description: Atualiza e publica o dashboard de NPS da PWR Gestão — baixa as 3 bases do Google Drive (NPS, Alocações, Usuários), reprocessa os dados e faz deploy do index.html na Vercel. Use quando o usuário disser "atualizar e publicar", "atualizar nps", "publicar relatório de nps", "atualizar dashboard nps" ou pedir para subir uma nova versão do relatório gerencial de NPS.
---

# Atualizar e publicar o dashboard de NPS

Este projeto é um dashboard HTML estático (`index.html`) com dados embutidos como
arrays JS literais (`currentNps`, `currentAloc`, `currentUsers`). Este skill
reprocessa as 3 bases de origem no Google Drive e publica a nova versão na Vercel.

Leia `CLAUDE.md` e `drive-config.json` neste repositório antes de começar, se ainda
não tiver o contexto na conversa.

## Passo a passo

0. **Garantir que o `index.html` local está igual ao último commit** antes de
   tocar em qualquer coisa: rode `git status --short index.html` (ou
   `git diff --quiet index.html`). Se aparecer QUALQUER diferença sem
   explicação, restaure com `git checkout -- index.html` antes de seguir para
   o passo 1 — boa prática geral, mesmo que a causa que motivou este passo
   (ver `CLAUDE.md`) já tenha sido corrigida na raiz.

1. **Baixar as 3 bases do Google Drive** usando a ferramenta MCP
   `mcp__Google_Drive__download_file_content`, com os IDs de `drive-config.json`
   (`arquivos.npsCampanha.id`, `arquivos.alocacoesNps.id`, `arquivos.usuarios.id`).
   O resultado vem em JSON com um campo `content` em base64 — se a ferramenta salvar
   em um arquivo de tool-result por ser grande, use `jq -r '.content' <arquivo> | base64 -d > data/<nome>.xlsx`.
   Salve os 3 arquivos em `data/` na raiz do repo (pasta já está no `.gitignore`,
   então nunca vai para o git).

2. **Reprocessar e reembutir os dados**:
   ```
   npm install   # só na primeira vez / se node_modules não existir
   node scripts/build-data.mjs data/nps.xlsx data/aloc.xlsx data/usuarios.xlsx index.html
   ```
   O script imprime quantos projetos de NPS, alocações e usuários ativos foram
   carregados. Confira se os números fazem sentido (ex: não deveria zerar).

3. **Revisar e commitar**: rode `git diff --stat index.html` para confirmar que só
   umas poucas linhas de dados mudaram. Se aparecer QUALQUER linha fora das 3
   (`currentNps`, `currentAloc`, `currentUsers`) — nem que seja só 1 linha extra —
   **pare e olhe o `git diff` completo antes de commitar**: isso é sinal de que o
   arquivo local já estava desatualizado/revertido antes de rodar o
   `build-data.mjs` (ver passo 0). Só depois de confirmar que o diff é só dados,
   `git add index.html` e commit com uma mensagem como
   `Atualiza dados NPS (Drive) - <data>`. Faça push para a branch atual.

4. **Publicar na Vercel**:
   ```
   node scripts/deploy-vercel.mjs
   ```
   Requer a variável de ambiente `VERCEL_TOKEN` (token de deploy da Vercel, sem
   expiração, do projeto do relatório de NPS). **Nunca** commite esse token no
   repositório.
   - Se `VERCEL_TOKEN` não estiver definido no ambiente, peça ao usuário o valor
     (ou avise que ele deveria configurá-lo como variável de ambiente persistente
     deste Environment do Claude Code, para não precisar informar de novo a cada
     sessão) — nunca escreva o token em um arquivo versionado.
   - O script já se recusa a rodar se o `projectId` apontar para algo parecido com
     "alocacao-pwr" (outro projeto, que nunca deve ser tocado por esta automação).

5. **Confirmar e reportar**: ao final, informe a URL de produção
   (`relatorio-gerencial-nps.vercel.app`) e um resumo dos números (projetos NPS,
   alocações, ativos) para o usuário.

## Coisas a nunca fazer

- Nunca commitar o `VERCEL_TOKEN` ou qualquer segredo no git.
- Nunca fazer deploy no projeto `alocacao-pwr.vercel.app`.
- Nunca usar o arquivo "Alocações.xlsx" (sem "- NPS") — é uma base diferente.
