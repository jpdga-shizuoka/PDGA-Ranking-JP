import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

function parseArgs(argv) {
  const positionals = argv.filter((arg) => !arg.startsWith('--'));
  if (positionals.length < 1) {
    console.error('Usage: node ranking.js <input.json>');
    process.exitCode = 1;
    return null;
  }
  return { inFile: positionals[0] };
}

function extractYearFromFilename(filename) {
  const match = filename.match(/(\d{4})/);
  return match ? match[1] : 'unknown';
}

async function readPlayers(filePath) {
  const data = await fs.readFile(filePath, 'utf8');
  const json = JSON.parse(data);
  if (!Array.isArray(json.players)) {
    throw new Error('Invalid input: missing players array');
  }
  return json.players;
}

function normalizeClass(value) {
  return (value || '').trim().toLowerCase().startsWith('pro') ? 'pro' : 'am';
}

function sortByNumberDesc(key) {
  return (a, b) => {
    const av = a[key];
    const bv = b[key];
    if (av === bv) return a.pdgaNumber - b.pdgaNumber;
    return bv - av;
  };
}

function formatLine(rank, player, key) {
  return `${rank} ${player.name} ${player[key]}`;
}

async function writeRanking(filePath, lines) {
  await fs.writeFile(filePath, lines.join('\n'), 'utf8');
  console.error(`Wrote ${lines.length} lines to ${filePath}`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts) return;

  const inputPath = path.resolve(process.cwd(), opts.inFile);
  const players = await readPlayers(inputPath);
  const year = extractYearFromFilename(path.basename(opts.inFile));

  const pro = players.filter((p) => normalizeClass(p.class) === 'pro');
  const am = players.filter((p) => normalizeClass(p.class) === 'am');
  const all = players.slice();

  const proPoints = pro
    .filter((p) => p.points !== null && p.points !== undefined && p.points !== 0)
    .sort(sortByNumberDesc('points'));
  const proPrize = pro
    .filter((p) => p.prize !== null && p.prize !== undefined && p.prize !== 0)
    .sort(sortByNumberDesc('prize'));
  const amPoints = am
    .filter((p) => p.points !== null && p.points !== undefined && p.points !== 0)
    .sort(sortByNumberDesc('points'));
  const allPoints = all
    .filter((p) => p.points !== null && p.points !== undefined && p.points !== 0)
    .sort(sortByNumberDesc('points'));

  const outputs = [
    { key: 'points', list: proPoints, file: `ranking_${year}_pro_points.txt` },
    { key: 'prize', list: proPrize, file: `ranking_${year}_pro_prize.txt` },
    { key: 'points', list: amPoints, file: `ranking_${year}_am_points.txt` },
    { key: 'points', list: allPoints, file: `ranking_${year}_all_points.txt` }
  ];

  for (const { key, list, file } of outputs) {
    const lines = list.map((p, idx) => formatLine(idx + 1, p, key));
    await writeRanking(path.resolve(process.cwd(), file), lines);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exitCode = 1;
});
