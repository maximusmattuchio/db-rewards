/**
 * Email Delivery
 * Primary: Resend API (scales to millions, $0.001/email, reliable)
 * Fallback: Gmail SMTP (for dev or if Resend not configured)
 *
 * At 100K subscribers, Gmail SMTP will hit rate limits during milestone
 * spikes. Resend is required for production at scale.
 */

const nodemailer = require('nodemailer');

const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_PASS = process.env.GMAIL_PASS;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || GMAIL_USER;
const FROM_EMAIL = process.env.FROM_EMAIL || `"Dirty Bastard" <${GMAIL_USER}>`;
const FROM_DOMAIN_EMAIL = process.env.FROM_DOMAIN_EMAIL || FROM_EMAIL;

// Build the reward email HTML — same template for all providers
function buildEmailHtml(milestone, cycleCount) {
  return `
    <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto; background: #F5EFE6; border-radius: 12px; overflow: hidden;">
      <div style="background: #0D3B23; padding: 32px 40px; text-align: center;">
        <div style="font-size: 13px; font-weight: 700; letter-spacing: 4px; text-transform: uppercase; color: #C4733A; margin-bottom: 8px;">The Bastard Club</div>
        <div style="font-size: 28px; font-weight: 700; color: #F5EFE6; font-family: Georgia, serif;">You Earned a Reward</div>
      </div>
      <div style="padding: 36px 40px;">
        <div style="text-align: center; margin-bottom: 28px;">
          <div style="font-size: 56px; margin-bottom: 12px;">${milestone.emoji}</div>
          <div style="font-size: 22px; font-weight: 700; color: #0D3B23; text-transform: uppercase; letter-spacing: 1px;">${milestone.name}</div>
          <div style="font-size: 15px; color: #666; margin-top: 8px;">${milestone.description}</div>
        </div>
        <div style="background: white; border-radius: 10px; padding: 20px 24px; margin-bottom: 24px; border-left: 4px solid #C4733A;">
          <div style="font-size: 13px; color: #888; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 4px;">Milestone Reached</div>
          <div style="font-size: 18px; font-weight: 700; color: #0D3B23;">${cycleCount} Subscription Cycles ✓</div>
        </div>
        <p style="font-size: 15px; color: #444; line-height: 1.7;">
          You've hit the <strong>${cycleCount}-cycle milestone</strong> as a Dirty Bastard subscriber.
          We'll reach out separately to coordinate getting your reward to you.
          No action needed on your end.
        </p>
        <p style="font-size: 15px; color: #444; line-height: 1.7;">
          Questions? Reply to this email or reach us at
          <a href="mailto:hello@getdirtybastard.com" style="color: #C4733A;">hello@getdirtybastard.com</a>
        </p>
        <div style="text-align: center; margin-top: 32px;">
          <a href="https://getdirtybastard.com/pages/rewards"
             style="background: #0D3B23; color: #F5EFE6; padding: 14px 32px; border-radius: 6px; text-decoration: none; font-size: 14px; font-weight: 700; letter-spacing: 1px; text-transform: uppercase;">
            View Your Rewards →
          </a>
        </div>
      </div>
      <div style="background: #0D3B23; padding: 20px 40px; text-align: center;">
        <div style="font-size: 12px; color: rgba(245,239,230,0.5);">
          Dirty Bastard Laundry Co. · <a href="https://getdirtybastard.com" style="color: #C4733A; text-decoration: none;">getdirtybastard.com</a>
        </div>
      </div>
    </div>
  `;
}

// ─── RESEND (PRIMARY — use this in production) ───────────────────────────────
async function sendViaResend(to, subject, html) {
  const { Resend } = require('resend');
  const resend = new Resend(RESEND_API_KEY);

  const { data, error } = await resend.emails.send({
    from: FROM_DOMAIN_EMAIL,
    to,
    bcc: ADMIN_EMAIL,
    subject,
    html,
  });

  if (error) throw new Error(`Resend error: ${error.message}`);
  return data;
}

// ─── GMAIL (FALLBACK — limited to ~500/day, dev only at scale) ───────────────
let _gmailTransporter = null;
function getGmailTransporter() {
  if (!GMAIL_USER || !GMAIL_PASS) throw new Error('Gmail credentials not configured');
  if (!_gmailTransporter) {
    _gmailTransporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: GMAIL_USER, pass: GMAIL_PASS },
      pool: true,
      maxConnections: 5,
      rateDelta: 1000,
      rateLimit: 10,
    });
  }
  return _gmailTransporter;
}

async function sendViaGmail(to, subject, html) {
  await getGmailTransporter().sendMail({
    from: FROM_EMAIL,
    to,
    bcc: ADMIN_EMAIL,
    subject,
    html,
  });
}

// ─── UNIFIED SEND — tries Resend first, falls back to Gmail ─────────────────
async function sendEmail(to, subject, html) {
  // Try Resend first if configured
  if (RESEND_API_KEY) {
    try {
      await sendViaResend(to, subject, html);
      return { provider: 'resend' };
    } catch (err) {
      console.error('[email] Resend failed, falling back to Gmail:', err.message);
      // Fall through to Gmail
    }
  }

  // Fall back to Gmail
  if (GMAIL_USER && GMAIL_PASS) {
    await sendViaGmail(to, subject, html);
    return { provider: 'gmail' };
  }

  throw new Error('No email provider configured — set RESEND_API_KEY or GMAIL_USER+GMAIL_PASS');
}

// ─── PUBLIC API ──────────────────────────────────────────────────────────────

// Send a reward notification email with retry logic
async function sendRewardEmail(email, milestone, cycleCount) {
  const subject = `🏆 You've earned a reward — ${milestone.name}`;
  const html = buildEmailHtml(milestone, cycleCount);

  const MAX_RETRIES = 3;
  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await sendEmail(email, subject, html);
      console.log(`[email] Sent via ${result.provider} to ${email} (attempt ${attempt})`);
      return;
    } catch (err) {
      lastError = err;
      console.error(`[email] Attempt ${attempt}/${MAX_RETRIES} failed for ${email}:`, err.message);
      if (attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
      }
    }
  }

  throw new Error(`Email delivery failed after ${MAX_RETRIES} attempts: ${lastError?.message}`);
}

module.exports = { sendRewardEmail, sendEmail, buildEmailHtml };
