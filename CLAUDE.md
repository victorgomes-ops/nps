# Dashboard NPS — PWR Gestão

Dashboard HTML estático (`index.html`) com o relatório gerencial da campanha de NPS,
hospedado na Vercel para a alta cúpula da empresa acompanhar quem já respondeu e
quem falta cobrar.

## Status atual (22/ago/2026)

Resolvido. A sessão anterior do Claude Code Web tinha construído toda a automação
abaixo, mas não conseguiu dar `git push` (a integração do Claude com o GitHub nesta
conta só tem OAuth de leitura — "Resource not accessible by integration"). O código
foi entregue como zip e commitado/pushado localmente com sucesso nesta sessão: o
problema era mesmo restrito à integração remota, não ao código.

- ✅ **Repositório GitHub:** https://github.com/victorgomes-ops/nps — branch `main`,
  com as credenciais de git já configuradas na máquina (push local funciona normal).
- ✅ **Vercel já está publicado e atualizado** (`relatorio-gerencial-nps.vercel.app`,
  projeto `relatoriogerencialnps`), com dados reais de Agosto/2026 (40 projetos NPS,
  1266 alocações, 106 ativos). O deploy é via API (script), não Git-linkado — dar
  push no GitHub não publica sozinho na Vercel, é preciso rodar
  `scripts/deploy-vercel.mjs` (ver fluxo abaixo).
- **URL de produção:** relatorio-gerencial-nps.vercel.app
- **Vercel Project ID:** ver `drive-config.json` (`vercel.projectId`)
- **NUNCA fazer deploy no projeto:** `alocacao-pwr.vercel.app` (outro dashboard, não relacionado)

### Armadilha conhecida: `npm install` dentro do Google Drive

Este repositório vive em `G:\Meu Drive\...` (pasta sincronizada pelo Google Drive
Desktop). Rodar `npm install` diretamente aqui **corrompe arquivos silenciosamente**
(ex.: `node_modules/xlsx/package.json` vira 0 bytes, erro `ERR_INVALID_PACKAGE_CONFIG`
ao dar `require`) — é um problema conhecido do filesystem virtual do Google Drive
com a extração de tarball do npm, não um bug do projeto.

Workaround (se precisar reinstalar `node_modules`):
```bash
mkdir /c/temp-nps-install && cp package.json /c/temp-nps-install/
cd /c/temp-nps-install && npm install
cp -r node_modules "G:/Meu Drive/Victor Gomes/App_NPS/"
```
Ou seja: instale numa pasta local (fora do Drive) e copie o `node_modules` resultante
por cima — copiar arquivos prontos funciona bem, só a extração ao vivo do npm que
falha nesse filesystem.

## Como funciona

`index.html` é auto-contido: os dados das 3 bases (NPS, Alocações, Usuários) ficam
embutidos como arrays/Set JavaScript literais no próprio arquivo (variáveis
`currentNps`, `currentAloc`, `currentUsers`), então a alta cúpula abre o link e o
relatório já aparece pronto, sem precisar fazer upload de nada.

O próprio HTML também tem um upload manual client-side (abas "Cobrança" → botões de
upload) que usa a mesma lógica de leitura (`parseNpsSheet` etc.) — o script
`scripts/build-data.mjs` replica exatamente essa lógica no servidor, para que o
resultado automático seja idêntico ao que um upload manual pelo navegador geraria.

## Fluxo "atualizar e publicar"

Quando o Victor pedir para **atualizar e publicar** (ou variações: "atualizar nps",
"publicar relatório", "atualizar dashboard"), siga a skill em
`.claude/skills/atualizar-nps/SKILL.md`. Resumo do fluxo:

1. Baixar as 3 bases do Google Drive (IDs em `drive-config.json`) via Google Drive MCP.
2. `node scripts/build-data.mjs <nps.xlsx> <aloc.xlsx> <usuarios.xlsx> index.html`
   — reprocessa e reembute os dados no HTML.
3. Commit + push do `index.html` atualizado.
4. `VERCEL_TOKEN=... node scripts/deploy-vercel.mjs` — publica em produção.

## Bases do Google Drive

Ver `drive-config.json` para IDs, nomes de arquivo, aba e caminho no Drive. Resumo:

| Base | Arquivo | Observação |
|---|---|---|
| NPS | NPS - Campanha.xlsx | Aba **RESUMO MÊS (2)** (busca é tolerante a acento/caixa) |
| Alocações | Alocações - NPS.xlsx | Usar este arquivo, não "Alocações.xlsx" |
| Usuários | Usuarios.xlsx | Coluna "Ativo": Sim = ativo |

## Credenciais

O token da Vercel (`VERCEL_TOKEN`) **nunca deve ser commitado no repositório**.
Configure-o como variável de ambiente no ambiente do Claude Code (persiste entre
sessões) ou exporte manualmente antes de rodar `npm run deploy`. Veja `.env.example`.

## Identidade visual PWR (já aplicada no HTML)

```css
--navy:   #05244F   /* títulos, fundos escuros */
--blue:   #273A76   /* corpo */
--light:  #3C58B4   /* destaques */
--orange: #FF5B00   /* CTAs, ícones */
--white:  #FFFFFF
/* Fonte: Montserrat (Google Fonts) */
/* Proibido: verde, amarelo, roxo, rosa como cor principal */
```
