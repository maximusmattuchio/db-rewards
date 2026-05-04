/**
 * Syncs backers from a Kickstarter / ShipStation export into data/codes.csv.
 *
 * Behavior:
 *   - For each backer in the source (matching the amount range), upsert into
 *     codes.csv. Email is the join key.
 *   - If a backer already has a code, that code is preserved. Their name is
 *     updated from the source on every run (so edits in Numbers / the source
 *     spreadsheet propagate down).
 *   - If a row in codes.csv has an email that's no longer present in the
 *     source, its backer_name is blanked out so the label generator skips it.
 *     The code itself stays — never reassigned.
 *   - New backers that don't yet have a code get assigned the next unused
 *     4-digit code (or one is generated on demand).
 *   - Backer names are passed through a naive title-case so capitalization is
 *     consistent. Manual edits in codes.csv will be re-overwritten on the
 *     next sync — make permanent name edits in the source spreadsheet.
 *
 * Usage:
 *   node scripts/match-backers.js [--source path] [--min 25] [--max 55]
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
  const raw = fs.readFileSync(p, 'utf8').replace(/^﻿/, '');
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

// Capitalize first letter of each word, lowercase the rest. Imperfect for
// "McDonald" / "DeLeire" / "O'Brien" — fix those by hand in the source spreadsheet.
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
  throw new Error('Exhausted 4-digit code space');
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
    email: (r.email || '').toLowerCase(),
  }));

  const usedCodes = new Set(codeRows.map((r) => r.code).filter(Boolean));
  const codeByEmail = new Map();
  for (const r of codeRows) {
    if (r.email) codeByEmail.set(r.email, r);
  }

  // ── Load source export ───────────────────────────────────────────────
  const src = readCsv(args.source);
  const lc = (s) => s.toLowerCase();
  const findCol = (names) => src.header.find((h) => names.includes(lc(h)));
  const colTotal = findCol(['order total', 'amount paid', 'pledge amount']) || 'Order Total';
  const colName = findCol(['buyer full name', 'recipient full name', 'name']) || 'Buyer Full Name';
  const colEmail = findCol(['buyer email', 'email']) || 'Buyer Email';

  // ── Filter by amount range and dedupe by email ───────────────────────
  const sourceByEmail = new Map();
  const sourceWithoutEmail = []; // edge case
  let outOfRange = 0;
  for (const row of src.rows) {
    const amt = parseAmount(row[colTotal]);
    if (!Number.isFinite(amt)) continue;
    if (amt < args.min || amt > args.max) { outOfRange++; continue; }

    const name = titleCase((row[colName] || '').trim());
    const email = (row[colEmail] || '').trim().toLowerCase();
    if (!name) continue;

    if (email) {
      sourceByEmail.set(email, { name, email, amount: amt });
    } else {
      sourceWithoutEmail.push({ name, email: '', amount: amt });
    }
  }

  // ── Sync: update existing rows; blank out removed; add new ───────────
  let updated = 0;
  let unchanged = 0;
  let blanked = 0;
  let added = 0;

  // Existing rows: update from source or blank out
  for (const row of codeRows) {
    if (!row.email) continue; // leave manual rows alone
    const fromSrc = sourceByEmail.get(row.email);
    if (fromSrc) {
      if (row.backer_name !== fromSrc.name) {
        row.backer_name = fromSrc.name;
        updated++;
      } else {
        unchanged++;
      }
      sourceByEmail.delete(row.email); // mark consumed
    } else {
      // Backer in codes.csv but no longer in source — blank name to skip
      if (row.backer_name) {
        row.backer_name = '';
        blanked++;
      }
    }
  }

  // New backers from source: assign code (reuse blank rows first)
  const blankRows = codeRows.filter((r) => !r.backer_name && !r.email);
  let blankIdx = 0;

  for (const backer of sourceByEmail.values()) {
    let row = blankRows[blankIdx++];
    if (!row) {
      const newCode = generateCode(usedCodes);
      row = { code: newCode, backer_name: '', loom_video_url: '', email: '' };
      codeRows.push(row);
    }
    row.backer_name = backer.name;
    row.email = backer.email;
    added++;
  }

  // Edge case: backers without email — append with a generated code
  for (const backer of sourceWithoutEmail) {
    const newCode = generateCode(usedCodes);
    codeRows.push({
      code: newCode,
      backer_name: backer.name,
      loom_video_url: '',
      email: '',
    });
    added++;
  }

  // ── Write back ───────────────────────────────────────────────────────
  const headerOut = ['code', 'backer_name', 'loom_video_url', 'email'];
  const lines = [headerOut.join(',')];
  for (const r of codeRows) {
    lines.push(headerOut.map((h) => csvCell(r[h])).join(','));
  }
  fs.writeFileSync(CODES_PATH, lines.join('\n') + '\n');

  // ── Report ───────────────────────────────────────────────────────────
  console.log(`✓ Source:    ${args.source}`);
  console.log(`✓ Filter:    $${args.min}–$${args.max} inclusive  (${outOfRange} rows skipped)`);
  console.log(`✓ Updated:   ${updated} (name changed in source)`);
  console.log(`✓ Unchanged: ${unchanged}`);
  console.log(`✓ Blanked:   ${blanked} (backer removed from source)`);
  console.log(`✓ Added:     ${added} (new backer)`);
  console.log(`✓ Total rows: ${codeRows.length}  (${codeRows.filter((r) => r.backer_name).length} with name, ${codeRows.filter((r) => !r.backer_name).length} blank)`);
  console.log(`\nNext: review data/codes.csv, then \`npm run generate-labels\`.`);
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
