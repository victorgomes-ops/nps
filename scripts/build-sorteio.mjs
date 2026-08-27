#!/usr/bin/env node
// Gera os dados do sorteio mensal de NPS: TODO o pool de projetos elegíveis para
// "NPS Aleatório" (cruzando Contratos + Usuários + Histórico de aplicação), mais
// os projetos "NPS Término" (Data Término Real no mês anterior ao mês-alvo).
//
// Não reduz para uma quantidade fixa — devolve o pool inteiro, com uma sugestão
// (campo `sugerido`) calculada garantindo cobertura de Senior e Sócio primeiro.
// A escolha final de quem entra é feita na aba "Sorteio NPS" do index.html
// (checkboxes), não aqui.
//
// Uso:
//   node scripts/build-sorteio.mjs <contratos.xlsx> <usuarios.xlsx> <nps-campanha.xlsx> <AAAA-MM> [out.json]
//
// <AAAA-MM> é o mês-alvo da campanha (ex: 2026-09 para a campanha de setembro).

import fs from 'node:fs';
import path from 'node:path';
import XLSX from 'xlsx';

const QTD_SUGERIDA_ALEATORIO = 20;
const DIAS_MIN_SEM_TERMINO = 30; // criterio 2
const DIAS_MIN_DESDE_INICIO = 90; // criterio 3
const MESES_COOLDOWN = 6; // criterio 4

function normalizaNome(s) {
  return (s || '').toString().normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
}

function achaAba(wb, alvo) {
  const alvoNorm = normalizaNome(alvo);
  return wb.SheetNames.find((n) => normalizaNome(n) === alvoNorm) || null;
}

function acheLinhaCabecalho(ws, colunasExigidas, maxRange) {
  for (let r = 0; r <= maxRange; r++) {
    const tentativa = XLSX.utils.sheet_to_json(ws, { defval: '', range: r });
    if (tentativa.length && colunasExigidas.every((c) => c in tentativa[0])) return tentativa;
  }
  return null;
}

function parseDataBR(s) {
  if (!s) return null;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s.toString().trim());
  if (!m) return null;
  const [, d, mo, y] = m;
  const dt = new Date(Number(y), Number(mo) - 1, Number(d));
  return isNaN(dt.getTime()) ? null : dt;
}

function diffDias(a, b) {
  return Math.round((a.getTime() - b.getTime()) / 86400000);
}

function parseMoeda(s) {
  if (s === undefined || s === null || s === '') return 0;
  // formato de origem é "$4,000.00" (vírgula = milhar, ponto = decimal)
  const n = Number(s.toString().replace(/[^0-9.-]/g, ''));
  return isNaN(n) ? 0 : n;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function parseContratos(filePath) {
  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { defval: '' });
}

function parseUsuariosPorCargo(filePath, regexCargo) {
  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
  return rows
    .filter((r) => (r['Ativo'] || '').toString().trim().toLowerCase() === 'sim')
    .filter((r) => regexCargo.test((r['Cargo'] || '').toString().trim()))
    .map((r) => (r['Nome'] || '').toString().trim())
    .filter(Boolean);
}

// Excel guarda datas como serial numérico (dias desde 1899-12-30).
function excelSerialToDate(serial) {
  const utcDays = Math.floor(serial - 25569);
  return new Date(utcDays * 86400 * 1000);
}

function parseHistoricoAplicacao(filePath) {
  const wb = XLSX.readFile(filePath);
  const nomeAba = achaAba(wb, 'Histórico de aplicação');
  if (!nomeAba) throw new Error('aba "Histórico de aplicação" não encontrada em ' + filePath);
  const ws = wb.Sheets[nomeAba];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
  return rows
    .map((r) => {
      const tipo = (r['Tipo'] || '').toString().trim();
      const empresa = (r['Empresa'] || '').toString().trim();
      const periodo = r['Período'];
      if (!empresa || !tipo) return null;
      const data = typeof periodo === 'number' ? excelSerialToDate(periodo) : parseDataBR(periodo);
      if (!data) return null;
      return { empresa, tipo, ano: data.getFullYear(), mes: data.getMonth() }; // mes: 0-11
    })
    .filter(Boolean);
}

// Reaproveita a mesma lógica de scripts/build-data.mjs para ler a campanha do mês corrente.
function parseCampanhaAtual(filePath) {
  const wb = XLSX.readFile(filePath);
  const nomeAba = achaAba(wb, 'RESUMO MÊS (2)');
  if (!nomeAba) return [];
  const ws = wb.Sheets[nomeAba];
  const rows = acheLinhaCabecalho(ws, ['Nome Contrato'], 10);
  if (!rows) return [];
  return rows.map((r) => (r['Cliente'] || '').toString().trim()).filter(Boolean);
}

// Garante que cada nome em `pessoas` tenha ao menos 1 escolhido no conjunto `escolhidosKeys`
// (mutado in-place), sorteando entre seus candidatos elegíveis quando ainda não tem nenhum.
// Retorna a lista de nomes sem NENHUM candidato elegível no pool (aviso pro usuário).
function garanteCobertura(pessoas, pool, escolhidosKeys) {
  const semCobertura = [];
  for (const pessoa of pessoas) {
    const candidatos = pool.filter((c) => c['Gerente de Projeto'] === pessoa || c['Scrum Master'] === pessoa);
    if (!candidatos.length) {
      semCobertura.push(pessoa);
      continue;
    }
    if (candidatos.some((c) => escolhidosKeys.has(c['Nome Contrato']))) continue; // já coberto por outra pessoa
    escolhidosKeys.add(shuffle(candidatos)[0]['Nome Contrato']);
  }
  return semCobertura;
}

function substituiLinha(html, prefixo, novoConteudo) {
  const linhas = html.split('\n');
  const idx = linhas.findIndex((l) => l.startsWith(prefixo));
  if (idx === -1) throw new Error(`linha com prefixo "${prefixo}" não encontrada no index.html`);
  linhas[idx] = novoConteudo;
  return linhas.join('\n');
}

function main() {
  const [contratosPath, usuariosPath, npsPath, mesAlvoStr, indexPath = 'index.html'] = process.argv.slice(2);
  if (!contratosPath || !usuariosPath || !npsPath || !mesAlvoStr) {
    console.error('Uso: node scripts/build-sorteio.mjs <contratos.xlsx> <usuarios.xlsx> <nps-campanha.xlsx> <AAAA-MM> [index.html]');
    process.exit(1);
  }
  const [anoAlvo, mesAlvoNum] = mesAlvoStr.split('-').map(Number);
  const mesAlvoIdx = mesAlvoNum - 1; // 0-11
  const refDate = new Date(anoAlvo, mesAlvoIdx, 1);
  const NOMES_MES = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];

  console.log(`Sorteio NPS — campanha de ${NOMES_MES[mesAlvoIdx]}/${anoAlvo}\n`);

  const contratos = parseContratos(contratosPath);
  console.log(`Contratos.xlsx: ${contratos.length} linhas`);

  const seniores = parseUsuariosPorCargo(usuariosPath, /^senior/i);
  const socios = parseUsuariosPorCargo(usuariosPath, /^s[óo]cio/i);
  console.log(`Usuários ativos — Senior: ${seniores.length} | Sócio: ${socios.length}`);

  const historico = parseHistoricoAplicacao(npsPath);
  console.log(`Histórico de aplicação: ${historico.length} linhas válidas`);

  // Critério 4: cooldown de 6 meses (mês-alvo - 6 até mês-alvo - 1), calendário.
  const cooldownSet = new Set();
  const mesesCooldown = [];
  for (let i = 1; i <= MESES_COOLDOWN; i++) {
    const d = new Date(anoAlvo, mesAlvoIdx - i, 1);
    mesesCooldown.push({ ano: d.getFullYear(), mes: d.getMonth() });
  }
  for (const h of historico) {
    if (mesesCooldown.some((m) => m.ano === h.ano && m.mes === h.mes)) cooldownSet.add(normalizaNome(h.empresa));
  }
  // Mês corrente (ainda não transferido pro histórico): tudo que já está na campanha em andamento conta como "aplicado".
  const mesCorrenteIdx = mesAlvoIdx - 1 >= 0 ? mesAlvoIdx - 1 : 11;
  const anoCorrenteDoMes = mesAlvoIdx - 1 >= 0 ? anoAlvo : anoAlvo - 1;
  const clientesCampanhaAtual = parseCampanhaAtual(npsPath);
  clientesCampanhaAtual.forEach((c) => cooldownSet.add(normalizaNome(c)));
  console.log(`Cooldown (últimos ${MESES_COOLDOWN} meses + campanha em andamento de ${NOMES_MES[mesCorrenteIdx]}/${anoCorrenteDoMes}): ${cooldownSet.size} empresas excluídas`);

  // ── Critérios 1-4: pool elegível para NPS Aleatório (não reduzido) ──
  const pool = contratos.filter((c) => {
    if ((c['Projeto Interno'] || '').toString().trim().toLowerCase() === 'sim') return false;

    const status = (c['Status do Projeto'] || '').toString().trim().toLowerCase();
    if (status !== 'ativo') return false;

    const termPrev = parseDataBR(c['Data Término Previsto']);
    if (termPrev) {
      const dias = diffDias(termPrev, refDate);
      if (dias >= 0 && dias <= DIAS_MIN_SEM_TERMINO) return false;
    }

    const inicio = parseDataBR(c['Data Inicial']);
    if (!inicio) return false;
    if (diffDias(refDate, inicio) < DIAS_MIN_DESDE_INICIO) return false;

    const empresa = normalizaNome(c['Nome Fantasia']);
    if (cooldownSet.has(empresa)) return false;

    return true;
  });
  console.log(`Pool elegível (critérios 1-4): ${pool.length} projetos`);

  // ── Critério 5: sugestão com cobertura de Senior + Sócio, completando até a meta ──
  const escolhidosKeys = new Set();
  const seniorSemCobertura = garanteCobertura(seniores, pool, escolhidosKeys);
  const socioSemCobertura = garanteCobertura(socios, pool, escolhidosKeys);

  const restante = shuffle(pool.filter((c) => !escolhidosKeys.has(c['Nome Contrato'])));
  for (const c of restante) {
    if (escolhidosKeys.size >= QTD_SUGERIDA_ALEATORIO) break;
    escolhidosKeys.add(c['Nome Contrato']);
  }

  const aleatorios = pool.map((c) => ({
    nomeFantasia: c['Nome Fantasia'],
    nomeProjeto: c['Nome Contrato'],
    gerente: c['Gerente de Projeto'],
    scrumMaster: c['Scrum Master'],
    parcela: parseMoeda(c['Parcela Fechada']),
    aplicacao: 'NPS Aleatório',
    sugerido: escolhidosKeys.has(c['Nome Contrato']),
  }));

  // ── NPS Término: Data Término Real no mês anterior ao mês-alvo (sempre sugerido) ──
  const termino = contratos
    .filter((c) => {
      if ((c['Projeto Interno'] || '').toString().trim().toLowerCase() === 'sim') return false;
      const dt = parseDataBR(c['Data Término Real']);
      return dt && dt.getFullYear() === anoCorrenteDoMes && dt.getMonth() === mesCorrenteIdx;
    })
    .map((c) => ({
      nomeFantasia: c['Nome Fantasia'],
      nomeProjeto: c['Nome Contrato'],
      gerente: c['Gerente de Projeto'],
      scrumMaster: c['Scrum Master'],
      parcela: parseMoeda(c['Parcela Fechada']),
      aplicacao: 'NPS Término',
      sugerido: true,
    }));

  const totalSugeridoAleatorio = aleatorios.filter((r) => r.sugerido).length;

  const resultado = {
    campanha: `${NOMES_MES[mesAlvoIdx]}/${anoAlvo}`,
    mesTermino: `${NOMES_MES[mesCorrenteIdx]}/${anoCorrenteDoMes}`,
    geradoEm: new Date().toISOString(),
    criterios: {
      qtdSugeridaAleatorio: QTD_SUGERIDA_ALEATORIO,
      poolElegivel: pool.length,
      seniores,
      socios,
      seniorSemCobertura,
      socioSemCobertura,
    },
    aleatorios,
    termino,
  };

  const indexAbs = path.resolve(indexPath);
  let html = fs.readFileSync(indexAbs, 'utf8');
  html = substituiLinha(html, 'let currentSorteio = ', `let currentSorteio = ${JSON.stringify(resultado)};`);
  fs.writeFileSync(indexAbs, html, 'utf8');

  console.log(`\nPool NPS Aleatório: ${pool.length} elegíveis, ${totalSugeridoAleatorio} sugeridos por padrão`);
  if (seniorSemCobertura.length) console.log(`⚠ Seniores SEM nenhum projeto elegível para representá-los: ${seniorSemCobertura.join(', ')}`);
  if (socioSemCobertura.length) console.log(`⚠ Sócios SEM nenhum projeto elegível para representá-los: ${socioSemCobertura.join(', ')}`);
  console.log(`NPS Término (encerrados em ${NOMES_MES[mesCorrenteIdx]}/${anoCorrenteDoMes}): ${termino.length}`);
  console.log(`\n${indexPath} atualizado (${(fs.statSync(indexAbs).size / 1024).toFixed(0)} KB).`);
}

main();
