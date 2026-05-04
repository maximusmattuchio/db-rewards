# db-rewards — context for future sessions

This repo is a single Vercel serverless project that hosts two unrelated things:

1. **Rewards system** — webhook handler + cron jobs for the ReCharge subscription milestone reward program. Original purpose of the repo.
2. **Backer unlock site** — `unlock.getdirtybastard.com` Kickstarter backer thank-you flow. Bolted on May 2026.

Plain Node CommonJS, no framework, no build step. Vercel runs `api/*.js` as serverless functions and serves `public/*` statically.

---

## Backer unlock feature

### What it does
Backer scans a QR code on a paper insert → lands on `unlock.getdirtybastard.com` → enters their 4-digit code → API returns their backer name + a Loom embed URL → the page swaps in place to a "What's up, {first name}." view with the embedded video and a "Leave us a review" CTA. Codes are reusable; backers can rewatch.

### Files
- `public/index.html` — the entire frontend (vanilla HTML/CSS/JS, brand-styled, mobile-first). Two views toggled via `hidden` class. Submits a fetch to `/api/redeem`.
- `api/health.js` — combined function. **GET** = original health check (DB connectivity, queue depths, error rate). **POST** = backer redemption (validates 4-digit code, looks up the row, increments `redeem_count`, returns `{ backer_name, loom_embed_url }`). Two unrelated endpoints share one file because the project is at the Hobby-plan 12-function limit. The frontend posts to `/api/redeem`, which `vercel.json` rewrites to `/api/health`. If this gets messy, split it back out and upgrade Vercel to Pro.
- `lib/loom.js` — converts any Loom share/embed URL to the embed form.
- `lib/rate-limit.js` — in-memory IP rate limiter (5 attempts / minute / IP). Best-effort on serverless — across cold starts it resets. Good enough for MVP. Swap for Vercel KV / Upstash if abuse appears.
- `scripts/generate-codes.js` — generates 70 unique 4-digit codes → `data/codes.csv` (gitignored).
- `scripts/seed.js` — reads `data/codes.csv` and upserts to Supabase. Idempotent. Skips rows missing name/url so you can fill incrementally.

### Database
- Table: `backer_codes` in Supabase project `trpwfihkrkqqkxqrnjep` (the same Rewards project the rest of this app uses).
- Columns: `code` (text PK), `backer_name`, `loom_video_url`, `first_redeemed_at`, `redeem_count`, `created_at`.

### Workflow when you're ready to ship the codes
```
npm run generate-codes      # writes 70 random 4-digit codes to data/codes.csv
# open data/codes.csv, fill in backer_name + loom_video_url for each row
npm run seed                # upserts to Supabase, safe to re-run
```

If you only have some videos recorded, that's fine — `seed` skips rows missing name/url. Re-run as you finish more.

Loom URLs accept either form:
- `https://www.loom.com/share/{id}`
- `https://www.loom.com/embed/{id}`

### Env vars (already in Vercel and `.env.local`)
- `SUPABASE_URL`, `SUPABASE_KEY` — service role key, server-only.

No new env vars needed for unlock — reuses what's already wired up.

### Local testing
```
vercel dev --listen 3939
# open http://localhost:3939, enter a seeded code
```

### Deploy + DNS
1. **Push the branch and merge to main** — Vercel auto-deploys main.
2. **Add the subdomain in Vercel:** Project → Settings → Domains → Add `unlock.getdirtybastard.com`.
3. **Vercel will give you a CNAME target** (something like `cname.vercel-dns.com`).
4. **In GoDaddy:** DNS → add a `CNAME` record:
   - Host: `unlock`
   - Value: (the CNAME target Vercel gave you)
   - TTL: default
5. Wait 5–30 min for DNS to propagate. `unlock.getdirtybastard.com` will serve `public/index.html`.

### Brand styling
Colors and fonts hard-coded in `public/index.html` `<style>`. Match the existing brand:
- `#0D3B23` dark green, `#C4733A` amber, `#F5EFE6` cream, `#F0EBE0` off-white.
- Oswald (headings, ALL CAPS), Barlow (body) — loaded from Google Fonts.

To change the review URL, edit the `<a id="review-cta" href="...">` in `public/index.html`. Currently points at `https://getdirtybastard.com/pages/leave-a-review`.

---

## Rewards system (original purpose of repo)

See `vercel.json` for the function/cron map. Key files:
- `api/webhook.js` — ReCharge charge webhook (HMAC-verified)
- `api/cron/*.js` — scheduled jobs (emails, retries, syncs, AI scoring)
- `api/sync/*.js`, `api/ai/*.js` — long-running syncs and AI scoring
- `lib/supabase.js` — Supabase client + reward-system helpers
- `lib/queue.js`, `lib/email.js`, `lib/anthropic.js` — internal helpers
