#!/usr/bin/env node
// Gera os dados do sorteio mensal de NPS: TODO o pool de projetos elegíveis para
// "NPS Aleatório" (cruzando Contratos + Usuários + Histórico de aplicação), mais
// os projetos "NPS Término" (Data Término Real no mês anterior ao mês-alvo).
//
// Não reduz para uma quantidade fixa — devolve o pool inteiro. Cada projeto do
// pool é classificado por "tem Senior" (Gerente de Projeto OU Scrum Master do
// PRÓPRIO projeto é Senior) ou não (normalmente Gerente Sócio + Scrum Pleno, ou
// Gerente e Scrum ambos Sócio) — a aba "Sorteio NPS" do index.html mostra isso
// como duas tabelas separadas. A escolha final de quem entra é manual
// (checkboxes), não é sorteada aqui.
//
// Uso:
//   node scripts/build-sorteio.mjs <contratos.xlsx> <usuarios.xlsx> <nps-campanha.xlsx> <AAAA-MM> [index.html]
//
// <AAAA-MM> é o mês-alvo da campanha (ex: 2026-09 para a campanha de setembro).

import fs from 'node:fs';
import path from 'node:path';
import XLSX from 'xlsx';

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
      // excelSerialToDate ancora em meia-noite UTC — usar getUTC*() aqui, senão em
      // fusos negativos (Brasil, UTC-3) a data "cai" pro dia/mês anterior (ex: um
      // Período "01/03" vira fevereiro), furando o cooldown de 6 meses por 1 mês.
      let ano, mes;
      if (typeof periodo === 'number') {
        const data = excelSerialToDate(periodo);
        ano = data.getUTCFullYear();
        mes = data.getUTCMonth();
      } else {
        const data = parseDataBR(periodo);
        if (!data) return null;
        ano = data.getFullYear();
        mes = data.getMonth();
      }
      return {
        empresa,
        tipo,
        ano,
        mes, // mes: 0-11
        gerente: (r['Gerente do Projeto'] || '').toString().trim(),
        scrumMaster: (r['Scrum Master'] || '').toString().trim(),
        status: (r['Status'] || '').toString().trim(),
        nota: r['Nota'] === '' ? null : r['Nota'],
        classificacao: (r['Classificação'] || '').toString().trim(),
        projeto: (r['Projeto'] || '').toString().trim(),
      };
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

// Nomes em `pessoas` que não são Gerente de Projeto NEM Scrum Master de nenhum
// projeto do pool — aviso pro usuário (ex: aquele Senior ficou sem nenhum
// projeto elegível pra representá-lo neste mês).
function semNenhumProjetoNoPool(pessoas, pool) {
  return pessoas.filter(
    (pessoa) => !pool.some((c) => c['Gerente de Projeto'] === pessoa || c['Scrum Master'] === pessoa)
  );
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
  const mesAlvoIdx = mesAlvoNum - 1; // 0-11 — só usado como rótulo da campanha no relatório
  const NOMES_MES = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];

  // Tudo se baseia em HOJE (a data real de quando este script roda), igual à função
  // HOJE() do Excel que já era usada manualmente — não no 1º dia do mês-alvo. O
  // mês-alvo (<AAAA-MM>) só nomeia a campanha no relatório.
  // Zera a hora: HOJE() do Excel é só a data, sem hora — se eu deixar a hora exata
  // (ex: 15h), a conta de "dias até o término" fica sensível a que horas do dia eu
  // rodei o script, arredondando pra baixo/cima de forma inconsistente perto da
  // borda dos 30 dias (achado real: Ercole Spada dava 31 dias de manhã e 30 à tarde).
  const agora = new Date();
  const refDate = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate());
  console.log(`Sorteio NPS — campanha de ${NOMES_MES[mesAlvoIdx]}/${anoAlvo} (calculado a partir de hoje, ${refDate.toLocaleDateString('pt-BR')})\n`);

  const contratos = parseContratos(contratosPath);
  console.log(`Contratos.xlsx: ${contratos.length} linhas`);

  const seniores = parseUsuariosPorCargo(usuariosPath, /^senior/i);
  const socios = parseUsuariosPorCargo(usuariosPath, /^s[óo]cio/i);
  console.log(`Usuários ativos — Senior: ${seniores.length} | Sócio: ${socios.length}`);

  const historico = parseHistoricoAplicacao(npsPath);
  console.log(`Histórico de aplicação: ${historico.length} linhas válidas`);

  // Mês corrente = mês de hoje (não mais derivado do mês-alvo). É o mês que ainda
  // não foi transferido pro histórico — tudo que já está na campanha em andamento
  // conta como "aplicado" pro cooldown.
  const mesCorrenteIdx = refDate.getMonth();
  const anoCorrenteDoMes = refDate.getFullYear();

  // Critério 4: cooldown de 6 meses, contando o mês corrente (hoje) pra trás, calendário.
  const cooldownSet = new Set();
  const mesesCooldown = [];
  for (let i = 0; i < MESES_COOLDOWN; i++) {
    const d = new Date(anoCorrenteDoMes, mesCorrenteIdx - i, 1);
    mesesCooldown.push({ ano: d.getFullYear(), mes: d.getMonth() });
  }
  for (const h of historico) {
    if (mesesCooldown.some((m) => m.ano === h.ano && m.mes === h.mes)) cooldownSet.add(normalizaNome(h.empresa));
  }
  const clientesCampanhaAtual = parseCampanhaAtual(npsPath);
  clientesCampanhaAtual.forEach((c) => cooldownSet.add(normalizaNome(c)));
  console.log(`Cooldown (últimos ${MESES_COOLDOWN} meses + campanha em andamento de ${NOMES_MES[mesCorrenteIdx]}/${anoCorrenteDoMes}): ${cooldownSet.size} empresas excluídas`);

  // ── Critérios 1-4: pool elegível para NPS Aleatório (não reduzido) ──
  const pool = contratos.filter((c) => {
    if ((c['Projeto Interno'] || '').toString().trim().toLowerCase() === 'sim') return false;

    const status = (c['Status do Projeto'] || '').toString().trim().toLowerCase();
    if (status !== 'ativo') return false;

    // "Data Término Previsto" fica vazia na quase totalidade dos contratos (98% dos
    // ativos) — quem carrega a data real prevista de encerramento nesses casos é
    // "Data Término Vendido". Aplica pra TODO mundo, inclusive Perpétuo/Renovação
    // Automática — mesmo contrato perpétuo tem um "Término Vendido" real marcando
    // o fim do ciclo atual (ex: DoceVille, Perpétuo, com Vendido em cima da hora).
    const termPrev = parseDataBR(c['Data Término Previsto']) || parseDataBR(c['Data Término Vendido']);
    if (termPrev) {
      const dias = diffDias(termPrev, refDate);
      // <= 30: cobre tanto quem termina nos próximos 30 dias quanto quem já
      // devia ter terminado e ainda não tem Data Término Real preenchida.
      if (dias <= DIAS_MIN_SEM_TERMINO) return false;
    }

    const inicio = parseDataBR(c['Data Inicial']);
    if (!inicio) return false;
    if (diffDias(refDate, inicio) < DIAS_MIN_DESDE_INICIO) return false;

    const empresa = normalizaNome(c['Nome Fantasia']);
    if (cooldownSet.has(empresa)) return false;

    return true;
  });
  console.log(`Pool elegível (critérios 1-4): ${pool.length} projetos`);

  // ── Critério 5: classifica cada projeto por "tem Senior" (Gerente OU Scrum do
  // PRÓPRIO projeto é Senior) — não é mais uma escolha de quantidade, é uma
  // categorização de cada linha do pool em duas tabelas. ──
  const seniorSet = new Set(seniores);
  const temSenior = (c) =>
    seniorSet.has((c['Gerente de Projeto'] || '').toString().trim()) ||
    seniorSet.has((c['Scrum Master'] || '').toString().trim());

  const seniorSemCobertura = semNenhumProjetoNoPool(seniores, pool);
  const socioSemCobertura = semNenhumProjetoNoPool(socios, pool);

  const aleatorios = pool
    .map((c) => ({
      nomeFantasia: c['Nome Fantasia'],
      nomeProjeto: c['Nome Contrato'],
      gerente: c['Gerente de Projeto'],
      scrumMaster: c['Scrum Master'],
      parcela: parseMoeda(c['Parcela Fechada']),
      statusProjeto: c['Status do Projeto'],
      aplicacao: 'NPS Aleatório',
      temSenior: temSenior(c),
    }))
    .sort((a, b) => a.statusProjeto.localeCompare(b.statusProjeto, 'pt-BR') || a.nomeFantasia.localeCompare(b.nomeFantasia, 'pt-BR'));

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
      statusProjeto: c['Status do Projeto'],
      aplicacao: 'NPS Término',
    }))
    .sort((a, b) => a.statusProjeto.localeCompare(b.statusProjeto, 'pt-BR') || a.nomeFantasia.localeCompare(b.nomeFantasia, 'pt-BR'));

  const comSenior = aleatorios.filter((r) => r.temSenior).length;
  const semSenior = aleatorios.length - comSenior;

  const resultado = {
    campanha: `${NOMES_MES[mesAlvoIdx]}/${anoAlvo}`,
    mesTermino: `${NOMES_MES[mesCorrenteIdx]}/${anoCorrenteDoMes}`,
    geradoEm: new Date().toISOString(),
    criterios: {
      poolElegivel: pool.length,
      seniores,
      socios,
      seniorSemCobertura,
      socioSemCobertura,
    },
    aleatorios,
    termino,
  };

  // ── Histórico de aplicação completo, pra aba própria (não depende do mês-alvo) ──
  const historicoDisplay = historico
    .map((h) => ({
      empresa: h.empresa,
      periodo: `${NOMES_MES[h.mes]}/${h.ano}`,
      periodoOrd: h.ano * 12 + h.mes,
      tipo: h.tipo,
      status: h.status,
      gerente: h.gerente,
      scrumMaster: h.scrumMaster,
      nota: h.nota,
      classificacao: h.classificacao,
    }))
    .sort((a, b) => b.periodoOrd - a.periodoOrd || a.empresa.localeCompare(b.empresa, 'pt-BR'));

  const indexAbs = path.resolve(indexPath);
  let html = fs.readFileSync(indexAbs, 'utf8');
  html = substituiLinha(html, 'let currentSorteio = ', `let currentSorteio = ${JSON.stringify(resultado)};`);
  html = substituiLinha(html, 'let currentHistorico = ', `let currentHistorico = ${JSON.stringify(historicoDisplay)};`);
  fs.writeFileSync(indexAbs, html, 'utf8');

  console.log(`\nPool NPS Aleatório: ${pool.length} elegíveis (${comSenior} com Senior, ${semSenior} sem Senior)`);
  if (seniorSemCobertura.length) console.log(`⚠ Seniores SEM nenhum projeto elegível para representá-los: ${seniorSemCobertura.join(', ')}`);
  if (socioSemCobertura.length) console.log(`⚠ Sócios SEM nenhum projeto elegível para representá-los: ${socioSemCobertura.join(', ')}`);
  console.log(`NPS Término (encerrados em ${NOMES_MES[mesCorrenteIdx]}/${anoCorrenteDoMes}): ${termino.length}`);
  console.log(`\n${indexPath} atualizado (${(fs.statSync(indexAbs).size / 1024).toFixed(0)} KB).`);
}

main();
