#!/usr/bin/env node
// Publica index.html como uma nova Production Deployment no projeto Vercel do
// relatorio de NPS, usando a API REST da Vercel (v13/deployments).
//
// NUNCA aponte este script para outro projectId - o projeto "alocacao-pwr" (outro
// dashboard interno) nao deve ser tocado por esta automacao.
//
// Variaveis de ambiente:
//   VERCEL_TOKEN       (obrigatoria) token de deploy da Vercel
//   VERCEL_PROJECT_ID  (opcional) sobrescreve o projectId padrao abaixo
//   VERCEL_TEAM_ID     (opcional) necessario se o projeto pertence a um team

import fs from 'node:fs';
import path from 'node:path';
import driveConfig from '../drive-config.json' with { type: 'json' };

const DEFAULT_PROJECT_ID = driveConfig.vercel.projectId; // prj_XElRMaYdx1R5HUkJgto5gqCsjvzS
const PROIBIDO_PROJECT_ID_HINT = 'alocacao-pwr';

async function vercelFetch(urlPath, token, options = {}) {
  const res = await fetch(`https://api.vercel.com${urlPath}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Vercel API ${urlPath} -> HTTP ${res.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

async function main() {
  const token = process.env.VERCEL_TOKEN;
  if (!token) {
    console.error('Faltando VERCEL_TOKEN no ambiente. Configure antes de rodar o deploy.');
    process.exit(1);
  }

  const projectId = process.env.VERCEL_PROJECT_ID || DEFAULT_PROJECT_ID;
  if (projectId.toLowerCase().includes(PROIBIDO_PROJECT_ID_HINT)) {
    console.error(`Recusando deploy: projectId "${projectId}" parece ser o projeto protegido "${PROIBIDO_PROJECT_ID_HINT}".`);
    process.exit(1);
  }

  const indexPath = path.resolve(process.argv[2] || 'index.html');
  const html = fs.readFileSync(indexPath, 'utf8');
  console.log(`Publicando ${indexPath} (${(html.length / 1024).toFixed(0)} KB) no projeto ${projectId}...`);

  const teamQuery = process.env.VERCEL_TEAM_ID ? `?teamId=${encodeURIComponent(process.env.VERCEL_TEAM_ID)}` : '';

  const deployment = await vercelFetch(`/v13/deployments${teamQuery}`, token, {
    method: 'POST',
    body: JSON.stringify({
      name: 'relatorio-gerencial-nps',
      project: projectId,
      target: 'production',
      files: [{ file: 'index.html', data: html }],
      projectSettings: { framework: null },
    }),
  });

  console.log(`Deployment criado: ${deployment.id} (estado inicial: ${deployment.readyState})`);

  const deploymentId = deployment.id;
  let estado = deployment.readyState;
  const inicio = Date.now();
  while (estado !== 'READY' && estado !== 'ERROR' && estado !== 'CANCELED' && Date.now() - inicio < 120000) {
    await new Promise((r) => setTimeout(r, 3000));
    const status = await vercelFetch(`/v13/deployments/${deploymentId}${teamQuery}`, token);
    estado = status.readyState;
    console.log(`  ... estado: ${estado}`);
  }

  if (estado !== 'READY') {
    throw new Error(`Deployment terminou em estado "${estado}" (não READY). Verifique no painel da Vercel.`);
  }

  console.log('\nDeploy concluído com sucesso.');
  console.log(`URL do deployment: https://${deployment.url}`);
  console.log(`URL de produção:   https://${driveConfig.vercel.productionUrl}`);
}

main().catch((err) => {
  console.error('Falha no deploy:', err.message);
  process.exit(1);
});
