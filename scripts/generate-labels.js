/**
 * Generates a multi-page PDF of 4×6 thank-you labels for the Nelko thermal printer.
 *
 * For each row in data/codes.csv with a backer_name, produces one page containing:
 *   - DB logo
 *   - Personalized message addressed to the first name
 *   - QR code that encodes https://unlock.getdirtybastard.com?code=XXXX
 *   - "Your 4 digit pin is: XXXX" line
 *   - URL footer
 *
 * Optimized for monochrome thermal print: white background, black-on-white QR,
 * dark text. Layout fits within a single 4×6 page (no overflow to a second page).
 *
 * Output:    data/labels.pdf
 *
 * Usage:     node scripts/generate-labels.js
 *            node scripts/generate-labels.js --start 0 --end 30
 */

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');

const ROOT = path.join(__dirname, '..');
const CODES_PATH = path.join(ROOT, 'data', 'codes.csv');
const LOGO_PATH = path.join(ROOT, 'data', 'assets', 'db-logo.png');
const OUT_PATH = path.join(ROOT, 'data', 'labels.pdf');

const SITE = 'unlock.getdirtybastard.com';
const URL_BASE = `https://${SITE}`;

// 4×6 inch label at 72 PDF points per inch = 288 × 432 points portrait
const PAGE_W = 4 * 72;
const PAGE_H = 6 * 72;

// Thermal-friendly: high-contrast dark green prints as solid black on thermal.
const INK = '#0D3B23';

function parseArgs(argv) {
  const args = { start: 0, end: Infinity };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--start' && argv[i + 1]) args.start = parseInt(argv[++i], 10);
    else if (argv[i] === '--end' && argv[i + 1]) args.end = parseInt(argv[++i], 10);
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

function readCodes() {
  const raw = fs.readFileSync(CODES_PATH, 'utf8').replace(/^﻿/, '');
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const header = splitCsvLine(lines[0]).map((h) => h.trim());
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  return lines.slice(1).map((line) => {
    const c = splitCsvLine(line);
    return {
      code: (c[idx.code] || '').trim(),
      backer_name: (c[idx.backer_name] || '').trim(),
      loom_video_url: (c[idx.loom_video_url] || '').trim(),
      email: (c[idx.email] || '').trim(),
    };
  });
}

// Default: first name only.
// Use the full name if it contains one of these tokens (couple/family/title cases):
//   "Aunty", "Uncle", "Family", "&", "Ms."
const KEEP_FULL_TOKENS = ['aunty', 'uncle', 'family', '&', 'ms.'];

function displayName(full) {
  if (!full) return 'friend';
  const trimmed = full.trim();
  const lower = trimmed.toLowerCase();
  if (KEEP_FULL_TOKENS.some((t) => lower.includes(t))) return trimmed;
  return trimmed.split(/\s+/)[0];
}

async function makeQrPng(code) {
  return QRCode.toBuffer(`${URL_BASE}?code=${code}`, {
    errorCorrectionLevel: 'H',
    type: 'png',
    margin: 1,
    width: 600,
    color: { dark: '#000000', light: '#FFFFFF' },
  });
}

async function main() {
  if (!fs.existsSync(CODES_PATH)) {
    console.error(`Missing ${CODES_PATH}. Run \`npm run match-backers\` first.`);
    process.exit(1);
  }
  const hasLogo = fs.existsSync(LOGO_PATH);
  if (!hasLogo) console.warn(`(no logo at ${LOGO_PATH} — skipping)`);

  const args = parseArgs(process.argv);
  const all = readCodes().filter((r) => r.backer_name);
  const slice = all.slice(args.start, args.end);

  if (slice.length === 0) {
    console.error('No rows with a backer_name to render.');
    process.exit(1);
  }

  const doc = new PDFDocument({
    size: [PAGE_W, PAGE_H],
    margin: 0,
    autoFirstPage: false,
  });
  doc.pipe(fs.createWriteStream(OUT_PATH));

  // Layout constants — sum must fit within PAGE_H (432pt) with bottom padding
  const padX = 22;
  const TOP = 18;
  const LOGO_BOX_W = 200;
  const LOGO_BOX_H = 56;
  const QR_SIZE = 156;

  for (let i = 0; i < slice.length; i++) {
    const row = slice[i];
    doc.addPage({ size: [PAGE_W, PAGE_H], margin: 0 });

    let y = TOP;

    // ── Logo (constrained inside a fit box so height never overflows) ──
    if (hasLogo) {
      doc.image(LOGO_PATH, (PAGE_W - LOGO_BOX_W) / 2, y, {
        fit: [LOGO_BOX_W, LOGO_BOX_H],
        align: 'center',
        valign: 'top',
      });
      y += LOGO_BOX_H;
    } else {
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(22)
        .text('DIRTY BASTARD', 0, y, { width: PAGE_W, align: 'center', characterSpacing: 2 });
      y += 36;
    }
    y += 14;

    // ── Personalized greeting ────────────────────────────────────────
    const name = displayName(row.backer_name);
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(16)
      .text(`${name},`, padX, y, { width: PAGE_W - padX * 2 });
    y = doc.y + 4;

    // ── Message ──────────────────────────────────────────────────────
    doc.fillColor(INK).font('Helvetica').fontSize(11)
      .text(
        `I was gonna write you a handwritten note. Felt too old school.\n\n` +
        `So I recorded you a video instead. Scan the code & enter your 4 digit pin to view your personalized video.`,
        padX, y,
        { width: PAGE_W - padX * 2, lineGap: 1.5 }
      );
    y = doc.y + 12;

    // ── QR centered ───────────────────────────────────────────────────
    const qrBuf = await makeQrPng(row.code);
    const qrX = (PAGE_W - QR_SIZE) / 2;
    doc.image(qrBuf, qrX, y, { width: QR_SIZE, height: QR_SIZE });
    y += QR_SIZE + 14;

    // ── Pin line: "Your 4 digit pin is: 2878" ────────────────────────
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(15)
      .text(`Your 4 digit pin is: ${row.code}`, 0, y, {
        width: PAGE_W, align: 'center',
      });

    // ── Footer URL anchored at bottom ────────────────────────────────
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(9)
      .text(SITE, 0, PAGE_H - 22, {
        width: PAGE_W, align: 'center', characterSpacing: 1,
      });

    if ((i + 1) % 25 === 0) console.log(`  rendered ${i + 1}/${slice.length}…`);
  }

  doc.end();
  await new Promise((resolve) => doc.on('end', resolve));

  console.log(`✓ Wrote ${slice.length} labels → ${OUT_PATH}`);
  console.log(`  Open with Preview, audit a few, then drop into Nelko app to print.`);
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
