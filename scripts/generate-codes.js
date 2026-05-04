/**
 * Generates 70 unique 4-digit numeric backer codes
 * and writes them to data/codes.csv with empty name/url columns for manual fill.
 *
 * Re-runnable: if data/codes.csv exists, asks before overwriting.
 *
 * Usage:  node scripts/generate-codes.js [--count 70] [--force]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ALPHABET = '0123456789';
const DEFAULT_COUNT = 70;
const CODE_LENGTH = 4;

function parseArgs(argv) {
  const args = { count: DEFAULT_COUNT, force: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force' || a === '-f') args.force = true;
    else if ((a === '--count' || a === '-c') && argv[i + 1]) {
      args.count = parseInt(argv[++i], 10);
    }
  }
  return args;
}

function makeCode() {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return out;
}

function generateUnique(count) {
  const set = new Set();
  while (set.size < count) set.add(makeCode());
  return [...set];
}

function main() {
  const { count, force } = parseArgs(process.argv);
  if (!Number.isInteger(count) || count <= 0) {
    console.error('Invalid --count');
    process.exit(1);
  }

  const dataDir = path.join(__dirname, '..', 'data');
  const csvPath = path.join(dataDir, 'codes.csv');

  if (fs.existsSync(csvPath) && !force) {
    console.error(`Refusing to overwrite ${csvPath}. Re-run with --force if you really mean it.`);
    process.exit(1);
  }

  fs.mkdirSync(dataDir, { recursive: true });

  const codes = generateUnique(count);
  const lines = ['code,backer_name,loom_video_url'];
  for (const c of codes) lines.push(`${c},,`);
  fs.writeFileSync(csvPath, lines.join('\n') + '\n');

  console.log(`✓ Wrote ${codes.length} codes to ${csvPath}`);
  console.log('Next: open the CSV, fill in backer_name + loom_video_url for each row, then run `pnpm seed`.');
}

main();
