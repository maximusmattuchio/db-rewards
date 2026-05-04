/**
 * Reads a Kickstarter / ShipStation export, filters backers by order amount,
 * pairs each with a unique 4-digit code, and merges into data/codes.csv.
 *
 * Idempotent by buyer email — running twice won't double-match the same person.
 * Generates additional codes on the fly if there aren't enough unused.
 *
 * Usage:
 *   node scripts/match-backers.js [--source path] [--min 25] [--max 55]
 *
 * Defaults:
 *   --source  data/backers.csv
 *   --min     25
 *   --max     55
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const CODES_PATH = path.join(ROOT, 'data', 'codes.csv');

function parseArgs(argv) {
  const args = {
    source: path.join(ROOT, 'data', 'backers.csv'),
    min: 25,
    max: 55,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--source' && argv[i + 1]) args.source = argv[++i];
    else if (a === '--min' && argv[i + 1]) args.min = Number(argv[++i]);
    else if (a === '--max' && argv[i + 1]) args.max = Number(argv[++i]);
  }
  return args;
}

// Minimal CSV splitter that handles quoted fields with commas.
function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else cur += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { out.push(cur); cur = ''; }
      else cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function csvCell(value) {
  if (value == null) return '';
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function readCsv(p) {
  const raw = fs.readFileSync(p, 'utf8').replace(/^﻿/, ''); // strip BOM
  const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return { header: [], rows: [] };
  const header = splitCsvLine(lines[0]).map((h) => h.trim());
  const rows = lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    const obj = {};
    header.forEach((h, i) => { obj[h] = (cells[i] ?? '').trim(); });
    return obj;
  });
  return { header, rows };
}

function parseAmount(raw) {
  if (!raw) return NaN;
  const cleaned = String(raw).replace(/[$,\s]/g, '');
  const v = Number(cleaned);
  return Number.isFinite(v) ? v : NaN;
}

// Capitalize first letter of each word, lowercase the rest.
// Imperfect for compound names like "McDonald" / "DeLeire" — manually fix
// those in data/codes.csv after running.
function titleCase(s) {
  return String(s).toLowerCase().replace(/\b\p{L}+/gu, (w) => w[0].toUpperCase() + w.slice(1));
}

const ALPHABET = '0123456789';
function makeCode() {
  const bytes = crypto.randomBytes(4);
  let out = '';
  for (let i = 0; i < 4; i++) out += ALPHABET[bytes[i] % 10];
  return out;
}

function generateCode(used) {
  for (let attempt = 0; attempt < 10000; attempt++) {
    const c = makeCode();
    if (!used.has(c)) {
      used.add(c);
      return c;
    }
  }
  throw new Error('Exhausted 4-digit code space (very unlikely)');
}

async function main() {
  const args = parseArgs(process.argv);

  if (!fs.existsSync(args.source)) {
    console.error(`Source file not found: ${args.source}`);
    process.exit(1);
  }
  if (!fs.existsSync(CODES_PATH)) {
    console.error(`codes.csv not found at ${CODES_PATH}. Run \`npm run generate-codes\` first.`);
    process.exit(1);
  }

  // ── Load existing codes.csv ──────────────────────────────────────────
  const codes = readCsv(CODES_PATH);
  const codeRows = codes.rows.map((r) => ({
    code: r.code || '',
    backer_name: r.backer_name || '',
    loom_video_url: r.loom_video_url || '',
    email: r.email || '', // optional column we'll add for idempotency
  }));

  const usedCodes = new Set(codeRows.map((r) => r.code).filter(Boolean));
  const matchedEmails = new Set(
    codeRows.filter((r) => r.email).map((r) => r.email.toLowerCase())
  );

  // ── Load source export ───────────────────────────────────────────────
  const src = readCsv(args.source);

  // Build flexible column lookup so this works with slight header variations.
  const lc = (s) => s.toLowerCase();
  const findCol = (names) => src.header.find((h) => names.includes(lc(h)));
  const colTotal = findCol(['order total', 'amount paid', 'pledge amount']) || 'Order Total';
  const colName = findCol(['buyer full name', 'recipient full name', 'name']) || 'Buyer Full Name';
  const colEmail = findCol(['buyer email', 'email']) || 'Buyer Email';

  // ── Filter by amount range and dedupe by email ───────────────────────
  const filtered = [];
  for (const row of src.rows) {
    const amt = parseAmount(row[colTotal]);
    if (!Number.isFinite(amt)) continue;
    if (amt < args.min || amt > args.max) continue;

    const name = titleCase((row[colName] || '').trim());
    const email = (row[colEmail] || '').trim().toLowerCase();
    if (!name) continue;
    if (email && matchedEmails.has(email)) continue; // already matched
    filtered.push({ name, email, amount: amt });
    if (email) matchedEmails.add(email);
  }

  if (filtered.length === 0) {
    console.log('No new backers to match.');
    return;
  }

  // ── Find unused code rows; generate more if needed ───────────────────
  const unusedRows = codeRows.filter((r) => !r.backer_name);
  const need = filtered.length - unusedRows.length;

  let appended = 0;
  if (need > 0) {
    for (let i = 0; i < need; i++) {
      const c = generateCode(usedCodes);
      const newRow = { code: c, backer_name: '', loom_video_url: '', email: '' };
      codeRows.push(newRow);
      unusedRows.push(newRow);
      appended++;
    }
  }

  // ── Assign each filtered backer to the next unused row ───────────────
  let assigned = 0;
  for (const b of filtered) {
    const row = unusedRows.shift();
    if (!row) break;
    row.backer_name = b.name;
    row.email = b.email;
    assigned++;
  }

  // ── Write updated codes.csv ──────────────────────────────────────────
  const headerOut = ['code', 'backer_name', 'loom_video_url', 'email'];
  const lines = [headerOut.join(',')];
  for (const r of codeRows) {
    lines.push(headerOut.map((h) => csvCell(r[h])).join(','));
  }
  fs.writeFileSync(CODES_PATH, lines.join('\n') + '\n');

  console.log(`✓ Source:           ${args.source}`);
  console.log(`✓ Filter:           $${args.min}–$${args.max} inclusive`);
  console.log(`✓ Matched backers:  ${assigned}`);
  if (appended > 0) console.log(`✓ Generated codes:  ${appended} (existing pool was short)`);
  console.log(`✓ Codes file:       ${CODES_PATH}`);
  console.log(`✓ Total rows:       ${codeRows.length}`);
  console.log(`\nNext: record videos, paste Loom URLs into the CSV, then run \`npm run seed\`.`);
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
