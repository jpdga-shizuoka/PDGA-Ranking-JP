import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { load as loadHtml } from 'cheerio';

const DEFAULTS = {
  inFile: 'players_jp_pro_current.json',
  outFile: 'players_jp_pro_current_with_totals.json',
  delayMs: 1200,
  concurrency: 1,
  retries: 3,
  year: undefined
};

function parseArgs(argv) {
  const opts = { ...DEFAULTS };
  const withValue = new Set(['in', 'out', 'delayMs', 'concurrency', 'year']);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    if (!withValue.has(key)) continue;
    const value = argv[i + 1];
    if (value === undefined) continue;
    i += 1;
    if (key === 'in') opts.inFile = value;
    if (key === 'out') opts.outFile = value;
    if (key === 'delayMs') {
      const parsed = Number(value);
      opts.delayMs = Number.isFinite(parsed) ? Math.max(0, parsed) : DEFAULTS.delayMs;
    }
    if (key === 'concurrency') {
      const parsed = Number(value);
      opts.concurrency = Number.isFinite(parsed) ? Math.max(1, Math.floor(parsed)) : DEFAULTS.concurrency;
    }
    if (key === 'year') {
      const parsed = Number(value);
      opts.year = Number.isFinite(parsed) ? Math.floor(parsed) : undefined;
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

function findSeasonTable($, year) {
  const yearText = String(year);
  const heading = $('h1,h2,h3,h4')
    .toArray()
    .find((el) => {
      const text = $(el).text().trim().toLowerCase();
      return text.includes('season totals') && text.includes(yearText.toLowerCase());
    });
  if (heading) {
    const table = $(heading).nextAll('table').first();
    if (table && table.length) return table;
  }
  return null;
}

function extractProTotals($, table) {
  if (!table || !table.length) return { points: null, prize: null };
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
    if (text.includes('pro totals')) row = tr;
  });
  if (!row) return { points: null, prize: null };

  const cells = $(row).find('td,th');
  const getCell = (index) => {
    if (index < 0 || index >= cells.length) return null;
    return $(cells[index]).text();
  };

  const points = parseNumber(getCell(idx.points));
  const prize = parseNumber(getCell(idx.prize));
  return { points, prize };
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

function buildStatsUrl(profileUrl, pdgaNumber) {
  const base = String(profileUrl || '').replace(/\/+$/, '');
  return `${base}/stats/${pdgaNumber}`;
}

async function processPlayer(player, opts) {
  if (!player.profileUrl) throw new Error('Missing profileUrl');
  const statsUrl = buildStatsUrl(player.profileUrl, player.pdgaNumber);
  const html = await fetchWithRetry(statsUrl, { retries: opts.retries, backoffMs: opts.delayMs });
  const $ = loadHtml(html);
  const table = findSeasonTable($, opts.year);
  const { points, prize } = extractProTotals($, table);
  return { ...player, points, prize, seasonYear: opts.year };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!Number.isFinite(opts.year)) {
    console.error('Error: --year <YYYY> is required');
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
        updated[current] = { ...player, points: null, prize: null, seasonYear: opts.year };
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

  const output = { ...data, seasonYear: opts.year, players: filtered };
  const written = await writePlayers(outputPath, output);
  console.error(`Done. players=${filtered.length} year=${opts.year} output=${written}`);
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exitCode = 1;
});
