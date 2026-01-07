import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { load as loadHtml } from 'cheerio';

const DEFAULTS = {
  inFile: null,
  outFile: null,
  delayMs: 1200,
  concurrency: 1,
  retries: 3,
  year: undefined
};

function parseArgs(argv) {
  const opts = { ...DEFAULTS };
  const positionals = argv.filter((arg) => !arg.startsWith('--'));
  if (positionals.length >= 1) opts.inFile = positionals[0];
  if (positionals.length >= 2) opts.outFile = positionals[1];
  if (positionals.length >= 3) {
    const parsed = Number(positionals[2]);
    opts.year = Number.isFinite(parsed) ? Math.floor(parsed) : undefined;
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (value === undefined) continue;
    i += 1;
    if (key === 'delayMs') {
      const parsed = Number(value);
      opts.delayMs = Number.isFinite(parsed) ? Math.max(0, parsed) : DEFAULTS.delayMs;
    }
    if (key === 'concurrency') {
      const parsed = Number(value);
      opts.concurrency = Number.isFinite(parsed) ? Math.max(1, Math.floor(parsed)) : DEFAULTS.concurrency;
    }
  }
  return opts;
}

async function fetchWithRetry(url, { retries, backoffMs }) {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'pdga-scraper/1.0 (+https://github.com/)',
          Accept: 'text/html,application/xhtml+xml'
        }
      });
      if (!res.ok) {
        const retriable = res.status >= 500 || res.status === 429;
        if (retriable && attempt < retries) {
          await delay(backoffMs * 2 ** attempt);
          continue;
        }
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      return res.text();
    } catch (err) {
      if (attempt >= retries) throw err;
      await delay(backoffMs * 2 ** attempt);
    }
  }
  throw new Error('Unexpected fetch retry loop exit');
}

function findSeasonHeading($, year) {
  const yearText = String(year).toLowerCase();
  return $('h1,h2,h3,h4')
    .toArray()
    .find((el) => {
      const text = $(el).text().trim().toLowerCase();
      return text.includes('season totals') && text.includes(yearText);
    });
}

function collectSeasonTables($, heading) {
  if (!heading) return [];
  const tables = [];
  let currentLabel = '';
  const siblings = $(heading).nextAll();
  for (const el of siblings) {
    const tag = el.tagName ? el.tagName.toLowerCase() : '';
    if (['h1', 'h2', 'h3', 'h4'].includes(tag)) {
      const text = $(el).text().trim().toLowerCase();
      if (!text.includes('season totals') && tables.length > 0 && ['h1', 'h2'].includes(tag)) {
        break;
      }
      currentLabel = text;
      continue;
    }
    if (tag === 'table') {
      const headers = $(el)
        .find('th')
        .map((_, th) => $(th).text().trim().toLowerCase())
        .get();
      if (headers.some((h) => h.includes('points'))) {
        tables.push({ table: $(el), label: currentLabel });
      }
    }
  }
  return tables;
}

function extractTotalsRow($, table, matchText) {
  const headers = table
    .find('th')
    .map((_, th) => $(th).text().trim().toLowerCase())
    .get();
  const idx = {
    points: headers.findIndex((h) => h.startsWith('points')),
    prize: headers.findIndex((h) => h.startsWith('prize'))
  };

  let row = null;
  table.find('tr').each((_, tr) => {
    const text = $(tr).text().trim().toLowerCase();
    if (text.includes(matchText)) row = tr;
  });
  if (!row) return { points: null, prize: null, found: false };

  const cells = $(row).find('td,th');
  const getCell = (index) => {
    if (index < 0 || index >= cells.length) return null;
    return $(cells[index]).text();
  };

  const points = parseNumber(getCell(idx.points));
  const prize = parseNumber(getCell(idx.prize));
  return { points, prize, found: true };
}

function findTotals($, tables, matchText, preferredLabel = '') {
  for (const entry of tables) {
    const label = (entry.label || '').toLowerCase();
    if (preferredLabel && !label.includes(preferredLabel) && matchText === 'pro totals') {
      continue;
    }
    const res = extractTotalsRow($, entry.table, matchText);
    if (res.found) return res;
  }
  for (const entry of tables) {
    const res = extractTotalsRow($, entry.table, matchText);
    if (res.found) return res;
  }
  return { points: null, prize: null, found: false };
}

function extractSeasonTotals($, year, playerClass) {
  const heading = findSeasonHeading($, year);
  if (!heading) return { points: null, prize: null };
  const tables = collectSeasonTables($, heading);
  const proTotals = findTotals($, tables, 'pro totals', 'professional');
  const amTotals = findTotals($, tables, 'am totals', 'amateur');

  const isPro = (playerClass || '').toLowerCase().startsWith('pro');
  if (isPro) {
    return { points: proTotals.points, prize: proTotals.prize };
  }

  const proPoints = proTotals.points;
  const amPoints = amTotals.points;
  const hasPoints = proPoints !== null || amPoints !== null;
  const summed = hasPoints ? (proPoints || 0) + (amPoints || 0) : null;
  return { points: summed, prize: null };
}

function parseNumber(text) {
  if (text === null || text === undefined) return null;
  const cleaned = String(text).replace(/[\$,]/g, '').trim();
  if (!cleaned) return null;
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}

async function readPlayers(filePath) {
  const data = await fs.readFile(filePath, 'utf8');
  const json = JSON.parse(data);
  if (!Array.isArray(json.players)) {
    throw new Error('Invalid input: missing players array');
  }
  return json;
}

async function writePlayers(filePath, data) {
  const absolute = path.resolve(process.cwd(), filePath);
  const payload = { ...data, count: data.players.length };
  const json = JSON.stringify(payload, null, 2);
  await fs.writeFile(absolute, json, 'utf8');
  return absolute;
}

function buildStatsUrl(pdgaNumber, year) {
  return `https://www.pdga.com/player/${pdgaNumber}/stats/${year}`;
}

async function processPlayer(player, opts) {
  if (!player.pdgaNumber) throw new Error('Missing pdgaNumber');
  const statsUrl = buildStatsUrl(player.pdgaNumber, opts.year);
  const html = await fetchWithRetry(statsUrl, { retries: opts.retries, backoffMs: opts.delayMs });
  const $ = loadHtml(html);
  const { points, prize } = extractSeasonTotals($, opts.year, player.class);
  return { ...player, points, prize };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.inFile || !opts.outFile || !Number.isFinite(opts.year)) {
    console.error('Usage: node add_totals.js <input.json> <output.json> <year> [--delayMs N] [--concurrency N]');
    process.exitCode = 1;
    return;
  }

  const inputPath = path.resolve(process.cwd(), opts.inFile);
  const outputPath = path.resolve(process.cwd(), opts.outFile);

  const data = await readPlayers(inputPath);
  const players = data.players;
  const updated = new Array(players.length);

  let index = 0;
  const worker = async () => {
    while (true) {
      const current = index;
      index += 1;
      if (current >= players.length) break;
      const player = players[current];
      try {
        const enriched = await processPlayer(player, opts);
        updated[current] = enriched;
        console.error(
          `player=${player.pdgaNumber} year=${opts.year} fetch=ok points=${enriched.points ?? 'null'} prize=${enriched.prize ?? 'null'}`
        );
      } catch (err) {
        updated[current] = { ...player, points: null, prize: null };
        console.error(`player=${player.pdgaNumber} year=${opts.year} error=${err.message}`);
      }
      if (opts.delayMs > 0) await delay(opts.delayMs);
    }
  };

  const workers = Array.from({ length: opts.concurrency }, () => worker());
  await Promise.all(workers);

  const filtered = updated.filter((p) => !(p.points === null && p.prize === null));
  if (filtered.length !== updated.length) {
    console.error(`Filtered out ${updated.length - filtered.length} players with null points and prize`);
  }

  const output = { ...data, players: filtered };
  const written = await writePlayers(outputPath, output);
  console.error(`Done. players=${filtered.length} year=${opts.year} output=${written}`);
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exitCode = 1;
});
