const nodemailer = require('nodemailer');

const GMAIL_USER = process.env.GMAIL_USER || process.env.GMAIL_PASS && 'maximusmattuchio@gmail.com';
const GMAIL_PASS = process.env.GMAIL_PASS;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || GMAIL_USER;

function createTransporter() {
  if (!GMAIL_USER || !GMAIL_PASS) {
    throw new Error('GMAIL_USER and GMAIL_PASS environment variables must be set');
  }
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user: GMAIL_USER, pass: GMAIL_PASS },
    pool: true,         // Connection pooling for high throughput
    maxConnections: 5,  // Max 5 simultaneous SMTP connections
    rateDelta: 1000,    // Rate limit: 1 second between sends
    rateLimit: 10,      // Max 10 emails per rateDelta window
  });
}

// Lazy-initialize transporter so missing env vars fail at send time, not startup
let _transporter = null;
function getTransporter() {
  if (!_transporter) _transporter = createTransporter();
  return _transporter;
}

async function sendRewardEmail(email, milestone, cycleCount) {
  const subject = `🏆 You've earned a reward — ${milestone.name}`;

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto; background: #F5EFE6; border-radius: 12px; overflow: hidden;">

      <!-- Header -->
      <div style="background: #0D3B23; padding: 32px 40px; text-align: center;">
        <div style="font-size: 13px; font-weight: 700; letter-spacing: 4px; text-transform: uppercase; color: #C4733A; margin-bottom: 8px;">The Bastard Club</div>
        <div style="font-size: 28px; font-weight: 700; color: #F5EFE6; font-family: Georgia, serif;">You Earned a Reward</div>
      </div>

      <!-- Body -->
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

      <!-- Footer -->
      <div style="background: #0D3B23; padding: 20px 40px; text-align: center;">
        <div style="font-size: 12px; color: rgba(245,239,230,0.5);">
          Dirty Bastard Laundry Co. · <a href="https://getdirtybastard.com" style="color: #C4733A; text-decoration: none;">getdirtybastard.com</a>
        </div>
      </div>

    </div>
  `;

  const MAX_RETRIES = 3;
  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await getTransporter().sendMail({
        from: `"Dirty Bastard" <${GMAIL_USER}>`,
        to: email,
        bcc: ADMIN_EMAIL,
        subject,
        html,
      });
      return; // success
    } catch (err) {
      lastError = err;
      console.error(`[email] Attempt ${attempt}/${MAX_RETRIES} failed for ${email}:`, err.message);
      if (attempt < MAX_RETRIES) {
        // Exponential backoff: 1s, 2s, 4s
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
      }
    }
  }

  throw new Error(`Email delivery failed after ${MAX_RETRIES} attempts: ${lastError?.message}`);
}

module.exports = { sendRewardEmail };
