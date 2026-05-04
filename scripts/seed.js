/**
 * Reads data/codes.csv and upserts to backer_codes in Supabase.
 * Idempotent — safe to re-run after editing the CSV.
 *
 * Skips rows missing backer_name or loom_video_url so you can fill in
 * codes incrementally as you record videos.
 *
 * Usage:  node scripts/seed.js
 */

require('dotenv').config({ path: '.env.local' });
require('dotenv').config(); // fall back to .env

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { toLoomEmbed } = require('../lib/loom');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_KEY. Add them to .env.local.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
});

function parseCsv(text) {
  const rows = [];
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return rows;
  const header = lines[0].split(',').map((h) => h.trim());
  const required = ['code', 'backer_name', 'loom_video_url'];
  for (const r of required) {
    if (!header.includes(r)) {
      throw new Error(`CSV missing required column: ${r}`);
    }
  }
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    rows.push({
      code: (cells[idx.code] || '').trim(),
      backer_name: (cells[idx.backer_name] || '').trim(),
      loom_video_url: (cells[idx.loom_video_url] || '').trim(),
    });
  }
  return rows;
}

// Minimal CSV splitter that handles "quoted, fields"
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

async function main() {
  const csvPath = path.join(__dirname, '..', 'data', 'codes.csv');
  if (!fs.existsSync(csvPath)) {
    console.error(`Not found: ${csvPath}`);
    console.error('Run `pnpm generate-codes` first.');
    process.exit(1);
  }

  const rows = parseCsv(fs.readFileSync(csvPath, 'utf8'));
  if (rows.length === 0) {
    console.error('CSV is empty.');
    process.exit(1);
  }

  const ready = [];
  const skipped = [];

  for (const row of rows) {
    if (!row.code) {
      skipped.push({ row, reason: 'missing code' });
      continue;
    }
    if (!row.backer_name || !row.loom_video_url) {
      skipped.push({ row, reason: 'missing backer_name or loom_video_url' });
      continue;
    }
    if (!toLoomEmbed(row.loom_video_url)) {
      skipped.push({ row, reason: 'unrecognizable Loom URL' });
      continue;
    }
    if (!/^\d{4}$/.test(row.code)) {
      skipped.push({ row, reason: 'code is not a 4-digit number' });
      continue;
    }
    ready.push({
      code: row.code,
      backer_name: row.backer_name,
      loom_video_url: row.loom_video_url,
    });
  }

  console.log(`Parsed ${rows.length} rows: ${ready.length} ready, ${skipped.length} skipped.`);
  if (skipped.length > 0) {
    console.log('\nSkipped rows (fill these in to seed them):');
    for (const s of skipped) console.log(`  ${s.row.code || '(no code)'} — ${s.reason}`);
  }

  if (ready.length === 0) {
    console.log('\nNothing to seed.');
    return;
  }

  // Upsert in chunks (Supabase handles up to ~1000 in one call, but stay tame).
  const CHUNK = 100;
  let total = 0;
  for (let i = 0; i < ready.length; i += CHUNK) {
    const chunk = ready.slice(i, i + CHUNK);
    const { error } = await supabase
      .from('backer_codes')
      .upsert(chunk, { onConflict: 'code', ignoreDuplicates: false });
    if (error) {
      console.error(`\nUpsert failed at chunk ${i}-${i + chunk.length}:`, error.message);
      process.exit(1);
    }
    total += chunk.length;
  }

  console.log(`\n✓ Upserted ${total} backer codes.`);
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
