/**
 * Exports ~/Downloads/codes.numbers → data/codes.csv via AppleScript.
 *
 * codes.numbers is the source of truth — the user edits names, Loom URLs,
 * etc. there. This script bridges it into the CSV the seed and label scripts
 * read.
 *
 * Usage: node scripts/sync-codes.js [--source path]
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DEFAULT_SRC = path.join(os.homedir(), 'Downloads', 'codes.numbers');
const DEST = path.join(ROOT, 'data', 'codes.csv');

function parseArgs(argv) {
  const args = { source: DEFAULT_SRC };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--source' && argv[i + 1]) args.source = argv[++i];
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);

  if (!fs.existsSync(args.source)) {
    console.error(`Not found: ${args.source}`);
    console.error('Make sure codes.numbers is at ~/Downloads/codes.numbers, or pass --source.');
    process.exit(1);
  }

  const script = `
    tell application "Numbers"
      activate
      set inputPath to POSIX file ${JSON.stringify(args.source)}
      set outputPath to POSIX file ${JSON.stringify(DEST)}
      open inputPath
      delay 1
      set theDoc to front document
      export theDoc to outputPath as CSV
      close theDoc saving no
    end tell
  `;

  execFileSync('osascript', ['-e', script], { stdio: 'inherit' });

  // Sanity check: header should contain code, backer_name, loom_video_url
  const head = fs.readFileSync(DEST, 'utf8').split(/\r?\n/)[0] || '';
  const required = ['code', 'backer_name', 'loom_video_url'];
  const missing = required.filter((c) => !head.includes(c));
  if (missing.length) {
    console.error(`Export succeeded, but the resulting CSV is missing columns: ${missing.join(', ')}`);
    console.error(`Header was: ${head}`);
    process.exit(1);
  }

  // Numbers strips leading zeros from numeric-looking cells (so "0182" becomes
  // "182"). Pad codes back to 4 digits before the file is consumed downstream.
  const raw = fs.readFileSync(DEST, 'utf8');
  const lines = raw.split(/\r?\n/);
  const headerCells = lines[0].split(',');
  const codeIdx = headerCells.findIndex((c) => c.trim() === 'code');
  let padded = 0;
  if (codeIdx >= 0) {
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i]) continue;
      const cells = lines[i].split(',');
      const before = cells[codeIdx] || '';
      if (/^\d{1,3}$/.test(before)) {
        cells[codeIdx] = before.padStart(4, '0');
        lines[i] = cells.join(',');
        padded++;
      }
    }
    if (padded > 0) fs.writeFileSync(DEST, lines.join('\n'));
  }

  const dataLines = lines.filter(Boolean);
  console.log(`✓ Exported ${args.source}`);
  console.log(`            → ${DEST}`);
  console.log(`✓ ${dataLines.length - 1} rows`);
  if (padded > 0) console.log(`✓ Re-padded ${padded} code(s) that lost leading zeros in Numbers`);
  console.log(`\nNext: \`npm run generate-labels\` to rebuild the PDF, or \`npm run seed\` to push to Supabase.`);
}

main();
