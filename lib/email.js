/**
 * Klaviyo Event Tracking
 * Primary: Klaviyo Events API — fires events that trigger flows in Klaviyo
 * Fallback: Gmail SMTP — for dev or if Klaviyo not configured
 *
 * Events sent to Klaviyo:
 *   - "Reward Milestone Reached" — triggers reward email flow
 *   - "Subscription Cycle Counted" — triggers nurture/progress flows
 */

const KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY;
const KLAVIYO_API_URL = 'https://a.klaviyo.com/api/events/';
const KLAVIYO_REVISION = '2023-12-15';

const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_PASS = process.env.GMAIL_PASS;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || GMAIL_USER;
const FROM_EMAIL = process.env.FROM_EMAIL || `"Dirty Bastard" <${GMAIL_USER}>`;

// ─── KLAVIYO EVENT TRACKING ───────────────────────────────────────────────────

async function trackKlaviyoEvent(email, shopifyCustomerId, eventName, properties) {
  if (!KLAVIYO_API_KEY) throw new Error('KLAVIYO_API_KEY not configured');

  const payload = {
    data: {
      type: 'event',
      attributes: {
        profile: {
          data: {
            type: 'profile',
            attributes: {
              email,
              external_id: shopifyCustomerId,
            },
          },
        },
        metric: {
          data: {
            type: 'metric',
            attributes: { name: eventName },
          },
        },
        properties,
      },
    },
  };

  const res = await fetch(KLAVIYO_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
      'Content-Type': 'application/json',
      'revision': KLAVIYO_REVISION,
    },
    body: JSON.stringify(payload),
  });

  // Klaviyo returns 202 Accepted on success
  if (!res.ok && res.status !== 202) {
    const text = await res.text().catch(() => '');
    throw new Error(`Klaviyo API error ${res.status}: ${text}`);
  }

  return { provider: 'klaviyo', event: eventName };
}

// ─── GMAIL FALLBACK ───────────────────────────────────────────────────────────

const nodemailer = require('nodemailer');
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

function buildFallbackEmailHtml(milestone, cycleCount) {
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
          We'll reach out separately to coordinate getting your reward to you. No action needed on your end.
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

async function sendViaGmail(email, milestone, cycleCount) {
  const subject = `🏆 You've earned a reward — ${milestone.name}`;
  const html = buildFallbackEmailHtml(milestone, cycleCount);
  await getGmailTransporter().sendMail({
    from: FROM_EMAIL,
    to: email,
    bcc: ADMIN_EMAIL,
    subject,
    html,
  });
  return { provider: 'gmail' };
}

// ─── PUBLIC API ───────────────────────────────────────────────────────────────

// Fire "Reward Milestone Reached" event — triggers reward email flow in Klaviyo
async function sendRewardEmail(email, milestone, cycleCount, shopifyCustomerId) {
  const MAX_RETRIES = 3;
  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (KLAVIYO_API_KEY) {
        const result = await trackKlaviyoEvent(email, shopifyCustomerId, 'Reward Milestone Reached', {
          milestone_id: milestone.id,
          milestone_name: milestone.name,
          milestone_description: milestone.description,
          milestone_emoji: milestone.emoji,
          milestone_cycles: milestone.cycles,
          cycle_count: cycleCount,
          rewards_page_url: 'https://getdirtybastard.com/pages/rewards',
        });
        console.log(`[email] Klaviyo event fired: Reward Milestone Reached for ${email} (attempt ${attempt})`);
        return result;
      }

      // Fallback to Gmail if Klaviyo not configured
      const result = await sendViaGmail(email, milestone, cycleCount);
      console.log(`[email] Sent via Gmail fallback to ${email} (attempt ${attempt})`);
      return result;

    } catch (err) {
      lastError = err;
      console.error(`[email] Attempt ${attempt}/${MAX_RETRIES} failed for ${email}:`, err.message);
      if (attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
      }
    }
  }

  throw new Error(`Email/event delivery failed after ${MAX_RETRIES} attempts: ${lastError?.message}`);
}

// Fire "Subscription Cycle Counted" event — triggers nurture/progress flows
async function trackCycleEvent(email, shopifyCustomerId, cycleCount, cyclesToNext, nextMilestoneName) {
  if (!KLAVIYO_API_KEY) return; // No-op if Klaviyo not configured

  try {
    await trackKlaviyoEvent(email, shopifyCustomerId, 'Subscription Cycle Counted', {
      cycle_count: cycleCount,
      cycles_to_next_reward: cyclesToNext,
      next_milestone_name: nextMilestoneName || null,
      rewards_page_url: 'https://getdirtybastard.com/pages/rewards',
    });
    console.log(`[email] Klaviyo event fired: Subscription Cycle Counted for ${email} (cycle ${cycleCount})`);
  } catch (err) {
    // Non-critical — don't throw, just log
    console.error(`[email] Failed to track cycle event for ${email}:`, err.message);
  }
}

module.exports = { sendRewardEmail, trackCycleEvent };
