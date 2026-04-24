/**
 * UI Preview — simulates the multi-subscription card layout
 * GET /api/preview
 */
module.exports = function handler(req, res) {
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Subscriptions Preview — Dirty Bastard</title>
<link href="https://fonts.googleapis.com/css2?family=Oswald:wght@400;500;600;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
  :root { --cream: #F5EFE6; --brown: #0D3B23; --amber: #C4733A; --off-white: #F0EBE0; }
  body { background: var(--off-white); font-family: 'Inter', sans-serif; color: var(--brown); padding: 40px 20px; }
  h2 { font-family: 'Oswald', sans-serif; font-size: 22px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 20px; }
  .note { font-size: 12px; color: #aaa; margin-bottom: 28px; }

  .rw-sub-section { background: white; border-radius: 12px; border: 1.5px solid #ede5d8; padding: 28px; max-width: 700px; margin: 0 auto 40px; box-shadow: 0 2px 12px rgba(13,59,35,0.05); }
  .rw-sub-header { margin-bottom: 20px; }
  .rw-sub-title { font-family: 'Oswald', sans-serif; font-size: 18px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; color: var(--brown); }

  .rw-sub-card { border: 1.5px solid #ede5d8; border-radius: 10px; padding: 20px; margin-bottom: 16px; }
  .rw-sub-card:last-child { margin-bottom: 0; }
  .rw-sub-card-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
  .rw-sub-card-name { font-family: 'Oswald', sans-serif; font-size: 15px; font-weight: 600; color: var(--brown); text-transform: uppercase; letter-spacing: 0.5px; }
  .rw-sub-badge { font-size: 11px; font-weight: 700; padding: 3px 10px; border-radius: 99px; background: #e8f5ee; color: #0D3B23; letter-spacing: 0.5px; text-transform: uppercase; }
  .rw-sub-badge--paused { background: #fef3e5; color: #b05a00; }

  .rw-sub-details { margin-bottom: 16px; }
  .rw-sub-detail-row { display: flex; justify-content: space-between; align-items: center; padding: 6px 0; border-bottom: 1px solid #f5efe6; font-size: 13px; }
  .rw-sub-detail-row:last-child { border-bottom: none; }
  .rw-sub-detail-label { color: #999; font-weight: 500; }
  .rw-sub-detail-val { font-weight: 600; color: var(--brown); }

  .rw-sub-actions { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
  .rw-sub-action { background: var(--off-white); border: 1.5px solid #ede5d8; border-radius: 8px; padding: 12px 8px; cursor: pointer; text-align: center; transition: all 0.15s; }
  .rw-sub-action:hover { border-color: var(--amber); }
  .rw-sub-action--full { grid-column: 1 / -1; display: flex; align-items: center; justify-content: center; gap: 8px; }
  .rw-sub-action-icon { font-size: 18px; margin-bottom: 4px; }
  .rw-sub-action-label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.8px; color: var(--brown); }
  .rw-sub-action--full .rw-sub-action-icon { margin-bottom: 0; }

  .scenario-label { font-family: 'Oswald', sans-serif; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; color: var(--amber); text-align: center; margin-bottom: 8px; }
  .divider { border: none; border-top: 2px dashed #ede5d8; margin: 40px auto; max-width: 700px; }
</style>
</head>
<body>

<div style="text-align:center; max-width:700px; margin:0 auto 32px;">
  <div style="font-family:'Oswald',sans-serif; font-size:28px; font-weight:700; text-transform:uppercase; letter-spacing:2px;">Subscription UI Preview</div>
  <div class="note">Mock data only — showing how the subscription cards look with 1, 2, and 3 subscriptions</div>
</div>

<!-- SCENARIO 1: Single subscription -->
<div class="scenario-label">Scenario 1 — Single Subscription</div>
<div class="rw-sub-section">
  <div class="rw-sub-header"><span class="rw-sub-title">Your Subscriptions</span></div>
  <div class="rw-sub-card">
    <div class="rw-sub-card-header">
      <span class="rw-sub-card-name">Alaskan Alpine</span>
      <span class="rw-sub-badge">Active</span>
    </div>
    <div class="rw-sub-details">
      <div class="rw-sub-detail-row"><span class="rw-sub-detail-label">Frequency</span><span class="rw-sub-detail-val">Every 6 week</span></div>
      <div class="rw-sub-detail-row"><span class="rw-sub-detail-label">Next Charge</span><span class="rw-sub-detail-val">Apr 15, 2026</span></div>
      <div class="rw-sub-detail-row"><span class="rw-sub-detail-label">Ships To</span><span class="rw-sub-detail-val">Jake Smith — Austin, TX</span></div>
    </div>
    <div class="rw-sub-actions">
      <button class="rw-sub-action"><div class="rw-sub-action-icon">⏭</div><div class="rw-sub-action-label">Skip Next</div></button>
      <button class="rw-sub-action"><div class="rw-sub-action-icon">🌲</div><div class="rw-sub-action-label">Swap Scent</div></button>
      <button class="rw-sub-action"><div class="rw-sub-action-icon">📅</div><div class="rw-sub-action-label">Frequency</div></button>
      <button class="rw-sub-action"><div class="rw-sub-action-icon">⏸</div><div class="rw-sub-action-label">Pause</div></button>
      <button class="rw-sub-action rw-sub-action--full"><div class="rw-sub-action-icon">📦</div><div class="rw-sub-action-label">Change Address</div></button>
    </div>
  </div>
</div>

<hr class="divider">

<!-- SCENARIO 2: Two subscriptions (mom + 2 sons) -->
<div class="scenario-label">Scenario 2 — Two Subscriptions (e.g. mom managing 2 sons)</div>
<div class="rw-sub-section">
  <div class="rw-sub-header"><span class="rw-sub-title">Your Subscriptions</span></div>

  <div class="rw-sub-card">
    <div class="rw-sub-card-header">
      <span class="rw-sub-card-name">Alaskan Alpine</span>
      <span class="rw-sub-badge">Active</span>
    </div>
    <div class="rw-sub-details">
      <div class="rw-sub-detail-row"><span class="rw-sub-detail-label">Frequency</span><span class="rw-sub-detail-val">Every 6 week</span></div>
      <div class="rw-sub-detail-row"><span class="rw-sub-detail-label">Next Charge</span><span class="rw-sub-detail-val">Apr 15, 2026</span></div>
      <div class="rw-sub-detail-row"><span class="rw-sub-detail-label">Ships To</span><span class="rw-sub-detail-val">Jake Smith — Austin, TX</span></div>
    </div>
    <div class="rw-sub-actions">
      <button class="rw-sub-action"><div class="rw-sub-action-icon">⏭</div><div class="rw-sub-action-label">Skip Next</div></button>
      <button class="rw-sub-action"><div class="rw-sub-action-icon">🌲</div><div class="rw-sub-action-label">Swap Scent</div></button>
      <button class="rw-sub-action"><div class="rw-sub-action-icon">📅</div><div class="rw-sub-action-label">Frequency</div></button>
      <button class="rw-sub-action"><div class="rw-sub-action-icon">⏸</div><div class="rw-sub-action-label">Pause</div></button>
      <button class="rw-sub-action rw-sub-action--full"><div class="rw-sub-action-icon">📦</div><div class="rw-sub-action-label">Change Address</div></button>
    </div>
  </div>

  <div class="rw-sub-card">
    <div class="rw-sub-card-header">
      <span class="rw-sub-card-name">Coastal Drift</span>
      <span class="rw-sub-badge rw-sub-badge--paused">Paused</span>
    </div>
    <div class="rw-sub-details">
      <div class="rw-sub-detail-row"><span class="rw-sub-detail-label">Frequency</span><span class="rw-sub-detail-val">Every 8 week</span></div>
      <div class="rw-sub-detail-row"><span class="rw-sub-detail-label">Next Charge</span><span class="rw-sub-detail-val">—</span></div>
      <div class="rw-sub-detail-row"><span class="rw-sub-detail-label">Ships To</span><span class="rw-sub-detail-val">Tyler Smith — Dallas, TX</span></div>
    </div>
    <div class="rw-sub-actions">
      <button class="rw-sub-action"><div class="rw-sub-action-icon">⏭</div><div class="rw-sub-action-label">Skip Next</div></button>
      <button class="rw-sub-action"><div class="rw-sub-action-icon">🌲</div><div class="rw-sub-action-label">Swap Scent</div></button>
      <button class="rw-sub-action"><div class="rw-sub-action-icon">📅</div><div class="rw-sub-action-label">Frequency</div></button>
      <button class="rw-sub-action"><div class="rw-sub-action-icon">▶</div><div class="rw-sub-action-label">Resume</div></button>
      <button class="rw-sub-action rw-sub-action--full"><div class="rw-sub-action-icon">📦</div><div class="rw-sub-action-label">Change Address</div></button>
    </div>
  </div>
</div>

<hr class="divider">

<!-- SCENARIO 3: Three subscriptions -->
<div class="scenario-label">Scenario 3 — Three Subscriptions</div>
<div class="rw-sub-section">
  <div class="rw-sub-header"><span class="rw-sub-title">Your Subscriptions</span></div>

  <div class="rw-sub-card">
    <div class="rw-sub-card-header">
      <span class="rw-sub-card-name">Alaskan Alpine</span>
      <span class="rw-sub-badge">Active</span>
    </div>
    <div class="rw-sub-details">
      <div class="rw-sub-detail-row"><span class="rw-sub-detail-label">Frequency</span><span class="rw-sub-detail-val">Every 4 week</span></div>
      <div class="rw-sub-detail-row"><span class="rw-sub-detail-label">Next Charge</span><span class="rw-sub-detail-val">Apr 3, 2026</span></div>
      <div class="rw-sub-detail-row"><span class="rw-sub-detail-label">Ships To</span><span class="rw-sub-detail-val">Jake Smith — Austin, TX</span></div>
    </div>
    <div class="rw-sub-actions">
      <button class="rw-sub-action"><div class="rw-sub-action-icon">⏭</div><div class="rw-sub-action-label">Skip Next</div></button>
      <button class="rw-sub-action"><div class="rw-sub-action-icon">🌲</div><div class="rw-sub-action-label">Swap Scent</div></button>
      <button class="rw-sub-action"><div class="rw-sub-action-icon">📅</div><div class="rw-sub-action-label">Frequency</div></button>
      <button class="rw-sub-action"><div class="rw-sub-action-icon">⏸</div><div class="rw-sub-action-label">Pause</div></button>
      <button class="rw-sub-action rw-sub-action--full"><div class="rw-sub-action-icon">📦</div><div class="rw-sub-action-label">Change Address</div></button>
    </div>
  </div>

  <div class="rw-sub-card">
    <div class="rw-sub-card-header">
      <span class="rw-sub-card-name">Coastal Drift</span>
      <span class="rw-sub-badge">Active</span>
    </div>
    <div class="rw-sub-details">
      <div class="rw-sub-detail-row"><span class="rw-sub-detail-label">Frequency</span><span class="rw-sub-detail-val">Every 6 week</span></div>
      <div class="rw-sub-detail-row"><span class="rw-sub-detail-label">Next Charge</span><span class="rw-sub-detail-val">Apr 20, 2026</span></div>
      <div class="rw-sub-detail-row"><span class="rw-sub-detail-label">Ships To</span><span class="rw-sub-detail-val">Tyler Smith — Dallas, TX</span></div>
    </div>
    <div class="rw-sub-actions">
      <button class="rw-sub-action"><div class="rw-sub-action-icon">⏭</div><div class="rw-sub-action-label">Skip Next</div></button>
      <button class="rw-sub-action"><div class="rw-sub-action-icon">🌲</div><div class="rw-sub-action-label">Swap Scent</div></button>
      <button class="rw-sub-action"><div class="rw-sub-action-icon">📅</div><div class="rw-sub-action-label">Frequency</div></button>
      <button class="rw-sub-action"><div class="rw-sub-action-icon">⏸</div><div class="rw-sub-action-label">Pause</div></button>
      <button class="rw-sub-action rw-sub-action--full"><div class="rw-sub-action-icon">📦</div><div class="rw-sub-action-label">Change Address</div></button>
    </div>
  </div>

  <div class="rw-sub-card">
    <div class="rw-sub-card-header">
      <span class="rw-sub-card-name">Amber Canyon</span>
      <span class="rw-sub-badge">Active</span>
    </div>
    <div class="rw-sub-details">
      <div class="rw-sub-detail-row"><span class="rw-sub-detail-label">Frequency</span><span class="rw-sub-detail-val">Every 8 week</span></div>
      <div class="rw-sub-detail-row"><span class="rw-sub-detail-label">Next Charge</span><span class="rw-sub-detail-val">May 1, 2026</span></div>
      <div class="rw-sub-detail-row"><span class="rw-sub-detail-label">Ships To</span><span class="rw-sub-detail-val">Connor Smith — Tampa, FL</span></div>
    </div>
    <div class="rw-sub-actions">
      <button class="rw-sub-action"><div class="rw-sub-action-icon">⏭</div><div class="rw-sub-action-label">Skip Next</div></button>
      <button class="rw-sub-action"><div class="rw-sub-action-icon">🌲</div><div class="rw-sub-action-label">Swap Scent</div></button>
      <button class="rw-sub-action"><div class="rw-sub-action-icon">📅</div><div class="rw-sub-action-label">Frequency</div></button>
      <button class="rw-sub-action"><div class="rw-sub-action-icon">⏸</div><div class="rw-sub-action-label">Pause</div></button>
      <button class="rw-sub-action rw-sub-action--full"><div class="rw-sub-action-icon">📦</div><div class="rw-sub-action-label">Change Address</div></button>
    </div>
  </div>
</div>

</body>
</html>`);
};
