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

  const lines = fs.readFileSync(DEST, 'utf8').split(/\r?\n/).filter(Boolean);
  console.log(`✓ Exported ${args.source}`);
  console.log(`            → ${DEST}`);
  console.log(`✓ ${lines.length - 1} rows`);
  console.log(`\nNext: \`npm run generate-labels\` to rebuild the PDF, or \`npm run seed\` to push to Supabase.`);
}

main();
