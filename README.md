# Dashboard NPS — PWR Gestão

Relatório gerencial da campanha de NPS, publicado como página estática
(`index.html`) na Vercel para a liderança acompanhar a cobrança de respostas por
gerente/scrum master e o painel gerencial por senioridade.

Ver `CLAUDE.md` para o funcionamento completo e `.claude/skills/atualizar-nps/`
para o fluxo de atualização e publicação automática.

## Atualizar e publicar

Dentro de uma sessão do Claude Code neste repositório, basta pedir **"atualizar e
publicar"**. O fluxo baixa as 3 bases do Google Drive (NPS, Alocações, Usuários),
reprocessa os dados e publica a nova versão em produção.

Para rodar manualmente:

```bash
npm install
node scripts/build-data.mjs <nps.xlsx> <aloc.xlsx> <usuarios.xlsx> index.html
VERCEL_TOKEN=xxx node scripts/deploy-vercel.mjs
```
