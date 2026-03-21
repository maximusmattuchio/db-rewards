const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: 'maximusmattuchio@gmail.com',
    pass: process.env.GMAIL_PASS,
  },
});

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

  await transporter.sendMail({
    from: '"Dirty Bastard" <maximusmattuchio@gmail.com>',
    to: email,
    bcc: 'maximusmattuchio@gmail.com', // you get a copy of every reward triggered
    subject,
    html,
  });
}

module.exports = { sendRewardEmail };
