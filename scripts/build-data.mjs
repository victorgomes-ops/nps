#!/usr/bin/env node
// Reprocessa as 3 bases (NPS, Alocacoes, Usuarios) e reembute os dados no index.html.
// Replica a MESMA logica de leitura que ja existe embutida no HTML (funcao parseNpsSheet
// e os handlers de upload), para garantir que a versao "automatica" gera exatamente o
// mesmo resultado que o upload manual pelo navegador geraria.
//
// Uso:
//   node scripts/build-data.mjs <nps.xlsx> <aloc.xlsx> <usuarios.xlsx> [index.html]

import fs from 'node:fs';
import path from 'node:path';
import XLSX from 'xlsx';

const ABA_NPS = 'RESUMO MÊS (2)';

function normalizaNome(s) {
  return (s || '')
    .toString()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function achaAba(wb, alvo) {
  const alvoNorm = normalizaNome(alvo);
  return wb.SheetNames.find((n) => normalizaNome(n) === alvoNorm) || null;
}

// Encontra, dentro das primeiras `maxRange` linhas, a linha que funciona como
// cabeçalho real (sheet_to_json com range:r produzindo colunas com os nomes exigidos).
function acheLinhaCabecalho(ws, colunasExigidas, maxRange) {
  for (let r = 0; r <= maxRange; r++) {
    const tentativa = XLSX.utils.sheet_to_json(ws, { defval: '', range: r });
    if (tentativa.length && colunasExigidas.every((c) => c in tentativa[0])) {
      return tentativa;
    }
  }
  return null;
}

// Procura, nas primeiras linhas da aba, uma célula do tipo "Relatório - NPS - Agosto 2026"
// para saber qual é o mês/ano da campanha atual (usado para atualizar os títulos do HTML).
function extraiPeriodo(ws) {
  const linhas = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  for (let i = 0; i < Math.min(10, linhas.length); i++) {
    for (const cel of linhas[i]) {
      const m = /Relat[oó]rio\s*-\s*NPS\s*-\s*([A-Za-zÀ-ú]+)\s+(\d{4})/.exec(String(cel));
      if (m) return { mes: m[1], ano: m[2] };
    }
  }
  return null;
}

function parseNps(filePath) {
  const wb = XLSX.readFile(filePath);
  const nomeAba = achaAba(wb, ABA_NPS);
  if (!nomeAba) {
    throw new Error(`aba "${ABA_NPS}" não encontrada. Abas do arquivo: ${wb.SheetNames.join(', ')}`);
  }
  const ws = wb.Sheets[nomeAba];
  const periodo = extraiPeriodo(ws);
  const rows = acheLinhaCabecalho(ws, ['Nome Contrato'], 10);
  if (!rows) throw new Error(`não encontrei a coluna "Nome Contrato" na aba ${nomeAba}`);

  const filtradas = rows.filter(
    (r) => (r['Nome Contrato'] || '').toString().trim() !== '' && (r['Aplicação'] || '').toString().trim() !== ''
  );
  if (!filtradas.length) throw new Error(`nenhuma linha de projeto válida na aba ${nomeAba}`);

  const rowsSaida = filtradas.map((r) => ({
    Cliente: (r['Cliente'] || '').toString().trim(),
    'Nome Contrato': (r['Nome Contrato'] || '').toString().trim(),
    Unidade: (r['Unidade'] || '').toString().trim(),
    'Gerente de Projeto': (r['Gerente de Projeto'] || '').toString().trim(),
    'Scrum Master': (r['Scrum Master'] || '').toString().trim(),
    Status: (r['Status'] || '').toString().trim(),
  }));

  return { rows: rowsSaida, periodo };
}

function parseAloc(filePath) {
  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = acheLinhaCabecalho(ws, ['Consultor', 'Projeto'], 5);
  if (!rows) throw new Error('não encontrei as colunas Consultor / Projeto na base de Alocações');

  const filtradas = rows.filter((r) => (r['Projeto'] || '').toString().trim() !== '');
  if (!filtradas.length) throw new Error('nenhuma linha de alocação válida');
  return filtradas;
}

function parseUsuarios(filePath) {
  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
  if (!rows.length || !('Nome' in rows[0]) || !('Ativo' in rows[0])) {
    throw new Error('Colunas "Nome" e "Ativo" não encontradas na base de Usuários');
  }
  const ativos = [];
  let desligados = 0;
  for (const r of rows) {
    const nome = (r['Nome'] || '').toString().trim();
    const ativo = (r['Ativo'] || '').toString().trim().toLowerCase();
    if (ativo === 'sim') {
      if (nome) ativos.push(nome);
    } else {
      desligados++;
    }
  }
  return { ativos, desligados };
}

function substituiLinha(html, prefixo, novoConteudo) {
  const linhas = html.split('\n');
  const idx = linhas.findIndex((l) => l.startsWith(prefixo));
  if (idx === -1) throw new Error(`linha com prefixo "${prefixo}" não encontrada no index.html`);
  linhas[idx] = novoConteudo;
  return linhas.join('\n');
}

// Atualiza os textos de "mês/ano da campanha" no HTML (título da página, cabeçalho,
// subtítulo e a frase de resumo), a partir do período lido na planilha. Descobre o
// texto atual em cada lugar (em vez de assumir um mês fixo) para continuar
// funcionando corretamente mês a mês.
function atualizaPeriodo(html, periodo) {
  if (!periodo) return html; // não achou o rótulo na planilha: deixa o HTML como está

  const novoEspaco = `${periodo.mes} ${periodo.ano}`; // "Agosto 2026"
  const novoBarra = `${periodo.mes}/${periodo.ano}`; // "Agosto/2026"
  const novoMinusculo = periodo.mes.toLowerCase(); // "agosto"

  const tituloAtual = /<title>NPS (.+?) \| PWR Gestão<\/title>/.exec(html);
  if (tituloAtual) html = html.replaceAll(tituloAtual[1], novoEspaco);

  const barraAtual = /Campanha NPS — (.+?)<em>/.exec(html);
  if (barraAtual) html = html.replaceAll(barraAtual[1], novoBarra);

  const gsubAtual = /Painel executivo — Campanha de NPS ([^\s<]+)/.exec(html);
  if (gsubAtual) html = html.replaceAll(gsubAtual[1], novoBarra);

  const fraseAtual = /Na campanha de NPS de (\S+?),/.exec(html);
  if (fraseAtual) html = html.replaceAll(fraseAtual[1], novoMinusculo);

  return html;
}

function main() {
  const [npsPath, alocPath, usuariosPath, indexPath = 'index.html'] = process.argv.slice(2);
  if (!npsPath || !alocPath || !usuariosPath) {
    console.error('Uso: node scripts/build-data.mjs <nps.xlsx> <aloc.xlsx> <usuarios.xlsx> [index.html]');
    process.exit(1);
  }

  console.log('Lendo NPS - Campanha...');
  const { rows: nps, periodo } = parseNps(npsPath);
  console.log(`  -> ${nps.length} projetos (aba "${ABA_NPS}")${periodo ? `, período: ${periodo.mes} ${periodo.ano}` : ''}`);

  console.log('Lendo Alocações - NPS...');
  const aloc = parseAloc(alocPath);
  console.log(`  -> ${aloc.length} alocações`);

  console.log('Lendo Usuários...');
  const { ativos, desligados } = parseUsuarios(usuariosPath);
  console.log(`  -> ${ativos.length} ativos, ${desligados} desligado(s) ignorado(s)`);

  const indexAbs = path.resolve(indexPath);
  let html = fs.readFileSync(indexAbs, 'utf8');

  html = substituiLinha(html, 'let currentNps = ', `let currentNps = ${JSON.stringify(nps)};`);
  html = substituiLinha(html, 'let currentAloc = ', `let currentAloc = ${JSON.stringify(aloc)};`);
  html = substituiLinha(
    html,
    'let currentUsers = ',
    `let currentUsers = new Set(${JSON.stringify(ativos)});`
  );
  html = atualizaPeriodo(html, periodo);

  fs.writeFileSync(indexAbs, html, 'utf8');
  console.log(`\nindex.html atualizado (${(fs.statSync(indexAbs).size / 1024).toFixed(0)} KB).`);

  console.log(
    JSON.stringify(
      { projetosNps: nps.length, alocacoes: aloc.length, ativos: ativos.length, desligados, periodo },
      null,
      2
    )
  );
}

main();
