import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { load as loadHtml } from 'cheerio';

const DEFAULT_QUERY = {
  Status: 'Current',
  Class: 'P',
  Country: 'JP',
  Country_1: '3',
  Gender: 'All'
};

const DEFAULTS = {
  out: 'players_jp_pro_current.json',
  maxPages: Infinity,
  delayMs: 1000,
  startPage: 0,
  baseUrl: 'https://www.pdga.com/players',
  retries: 3
};

function parseArgs(argv) {
  const opts = { ...DEFAULTS };
  const valueOptions = new Set(['out', 'maxPages', 'delayMs', 'startPage']);

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    if (!valueOptions.has(key)) continue;
    const value = argv[i + 1];
    if (value === undefined) continue;
    i += 1;
    if (key === 'out') opts.out = value;
    if (key === 'maxPages') opts.maxPages = Number(value) || Infinity;
    if (key === 'delayMs') opts.delayMs = Number(value) || DEFAULTS.delayMs;
    if (key === 'startPage') {
      const parsed = Number(value);
      opts.startPage = Number.isFinite(parsed) ? Math.max(0, parsed) : DEFAULTS.startPage;
    }
  }

  return opts;
}

function buildSearchUrl(baseUrl, page, query) {
  const url = new URL(baseUrl);
  Object.entries(query).forEach(([k, v]) => url.searchParams.set(k, v));
  url.searchParams.set('page', String(page));
  return url.toString();
}

async function fetchWithRetry(url, { retries = 3, backoffMs = 1000 } = {}) {
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

function normalizeProfileUrl(href) {
  if (!href) return null;
  const match = String(href).match(/\/player\/(\d+)/);
  if (!match) return null;
  return `https://www.pdga.com/player/${match[1]}`;
}

function detectNextPage($, currentPage) {
  if ($('a[rel~="next"]').length) return true;
  if ($('li.pager__item--next a, li.pager-next a, .pager-next a').length) return true;
  const hasTextNext = $('a')
    .toArray()
    .some((a) => $(a).text().trim().toLowerCase().startsWith('next'));
  if (hasTextNext) return true;

  const hrefHasHigherPage = $('a[href*="page="]')
    .toArray()
    .some((a) => {
      const href = $(a).attr('href');
      if (!href) return false;
      try {
        const url = new URL(href, 'https://www.pdga.com');
        const pageParam = Number(url.searchParams.get('page'));
        return Number.isFinite(pageParam) && pageParam > currentPage;
      } catch {
        return false;
      }
    });
  return hrefHasHigherPage;
}

function extractFromTable($, table) {
  const headers = $(table)
    .find('th')
    .map((_, el) => $(el).text().trim().toLowerCase())
    .get();

  const headerIndex = (name) => headers.findIndex((h) => h.startsWith(name.toLowerCase()));

  const idx = {
    name: headerIndex('name'),
    pdga: headerIndex('pdga #'),
    rating: headerIndex('rating'),
    city: headerIndex('city'),
    stateProv: headerIndex('state/prov'),
    country: headerIndex('country')
  };

  const rows = [];
  $(table)
    .find('tbody tr')
    .each((_, row) => {
      const cells = $(row).find('td');
      if (!cells.length) return;
      const nameCell = idx.name >= 0 ? $(cells[idx.name]) : $(cells[0]);
      const link = nameCell.find('a[href^="/player/"]').first();
      const profileUrl = normalizeProfileUrl(link.attr('href')) || normalizeProfileUrl(nameCell.attr('href'));
      const pdgaText = idx.pdga >= 0 ? $(cells[idx.pdga]).text().trim() : link.text().trim();
      const pdgaNumber = Number(pdgaText.replace(/\D/g, ''));
      if (!pdgaNumber || Number.isNaN(pdgaNumber)) return;

      const player = {
        pdgaNumber,
        name: (nameCell.text() || '').trim(),
        profileUrl: profileUrl || `https://www.pdga.com/player/${pdgaNumber}`,
        rating: idx.rating >= 0 ? parseCellNumber($(cells[idx.rating]).text()) : null,
        city: idx.city >= 0 ? cleanText($(cells[idx.city]).text()) : null,
        stateProv: idx.stateProv >= 0 ? cleanText($(cells[idx.stateProv]).text()) : null,
        country: idx.country >= 0 ? cleanText($(cells[idx.country]).text()) : null
      };

      rows.push(player);
    });

  return rows;
}

function parseCellNumber(text) {
  const num = Number(String(text).trim());
  return Number.isFinite(num) ? num : null;
}

function cleanText(text) {
  const value = (text || '').trim();
  return value.length ? value : null;
}

function extractPlayers(html, page) {
  const $ = loadHtml(html);
  const tables = $('table').toArray();
  let rows = [];
  for (const table of tables) {
    const headers = $(table)
      .find('th')
      .map((_, el) => $(el).text().trim().toLowerCase())
      .get();
    if (headers.includes('name') && headers.some((h) => h.includes('pdga'))) {
      rows = extractFromTable($, table);
      if (rows.length) break;
    }
  }

  if (rows.length === 0) {
    const fallback = new Map();
    $('a[href^="/player/"]').each((_, link) => {
      const href = $(link).attr('href');
      const profileUrl = normalizeProfileUrl(href);
      const match = href.match(/\/player\/(\d+)/);
      if (!match) return;
      const pdgaNumber = Number(match[1]);
      if (fallback.has(pdgaNumber)) return;
      fallback.set(pdgaNumber, {
        pdgaNumber,
        name: cleanText($(link).text()) || `Player ${pdgaNumber}`,
        profileUrl,
        rating: null,
        city: null,
        stateProv: null,
        country: null
      });
    });
    rows = Array.from(fallback.values());
  }

  return { rows, hasNext: detectNextPage($, page) };
}

async function writeOutput(filePath, data) {
  const absolute = path.resolve(process.cwd(), filePath);
  const json = JSON.stringify(data, null, 2);
  await fs.writeFile(absolute, json, 'utf8');
  return absolute;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const query = { ...DEFAULT_QUERY };
  const results = new Map();
  let page = opts.startPage;
  let processedPages = 0;

  while (processedPages < opts.maxPages) {
    const url = buildSearchUrl(opts.baseUrl, page, query);
    console.error(`Fetching page=${page} url=${url}`);
    const html = await fetchWithRetry(url, { retries: DEFAULTS.retries, backoffMs: opts.delayMs });
    const { rows, hasNext } = extractPlayers(html, page);

    let added = 0;
    for (const player of rows) {
      if (!results.has(player.pdgaNumber)) {
        results.set(player.pdgaNumber, player);
        added += 1;
      }
    }

    console.error(`page=${page} rows=${rows.length} added=${added} totalUnique=${results.size} hasNext=${hasNext}`);

    processedPages += 1;
    const shouldStop = rows.length === 0 || added === 0 || !hasNext;
    if (shouldStop) break;

    page += 1;
    if (opts.delayMs > 0) {
      await delay(opts.delayMs);
    }
  }

  const players = Array.from(results.values()).sort((a, b) => a.pdgaNumber - b.pdgaNumber);
  const output = {
    generatedAt: new Date().toISOString(),
    source: {
      baseUrl: opts.baseUrl,
      query
    },
    count: players.length,
    players
  };

  const outputPath = await writeOutput(opts.out, output);
  console.error(`Done. pages=${processedPages} total=${players.length} output=${outputPath}`);
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exitCode = 1;
});
