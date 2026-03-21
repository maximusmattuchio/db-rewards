/**
 * Queue Operations
 * Manages the email queue and webhook dead-letter queue (DLQ).
 * All heavy processing uses these queues so webhooks return fast
 * and retries happen automatically via cron jobs.
 */

const { supabase } = require('./supabase');

// ─── EMAIL QUEUE ─────────────────────────────────────────────────────────────

// Add a milestone email to the send queue
async function queueEmail(shopifyCustomerId, email, milestone, cycleCount) {
  const { error } = await supabase.from('queued_emails').insert({
    shopify_customer_id: String(shopifyCustomerId),
    email: email.toLowerCase().trim(),
    reward_id: milestone.id,
    milestone_id: milestone.id,
    cycle_count: cycleCount,
    status: 'pending',
    attempt_count: 0,
    next_retry_at: new Date().toISOString(),
  });
  if (error) throw new Error(`Failed to queue email: ${error.message}`);
}

// Get batch of pending emails ready to send
async function getPendingEmails(limit = 50) {
  const { data, error } = await supabase
    .from('queued_emails')
    .select('*')
    .in('status', ['pending', 'failed'])
    .lte('next_retry_at', new Date().toISOString())
    .order('created_at', { ascending: true })
    .limit(limit);

  if (error) throw new Error(`Failed to get pending emails: ${error.message}`);
  return data || [];
}

// Mark email as successfully sent
async function markEmailSent(id) {
  const { error } = await supabase
    .from('queued_emails')
    .update({ status: 'sent', sent_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw new Error(`Failed to mark email sent: ${error.message}`);
}

// Mark email as failed — schedule retry with exponential backoff
// After max_attempts, mark as dead
async function markEmailFailed(id, errorMessage, currentAttempt, maxAttempts = 5) {
  const nextAttempt = currentAttempt + 1;
  const isDead = nextAttempt >= maxAttempts;

  // Exponential backoff: 5m, 15m, 45m, 2h, dead
  const backoffMinutes = Math.min(5 * Math.pow(3, currentAttempt), 120);
  const nextRetry = new Date(Date.now() + backoffMinutes * 60 * 1000).toISOString();

  const { error } = await supabase
    .from('queued_emails')
    .update({
      status: isDead ? 'dead' : 'failed',
      attempt_count: nextAttempt,
      last_error: String(errorMessage).slice(0, 500),
      next_retry_at: isDead ? null : nextRetry,
    })
    .eq('id', id);

  if (error) throw new Error(`Failed to mark email failed: ${error.message}`);
  return isDead;
}

// ─── WEBHOOK DEAD LETTER QUEUE ───────────────────────────────────────────────

// Store a failed webhook for retry
async function queueFailedWebhook(chargeId, rawBody, topic, errorMessage) {
  const { error } = await supabase.from('webhook_dlq').insert({
    recharge_charge_id: chargeId ? String(chargeId).slice(0, 100) : null,
    raw_body: rawBody.slice(0, 50000), // cap at 50KB
    topic: topic ? String(topic).slice(0, 100) : null,
    error_message: String(errorMessage).slice(0, 500),
    attempt_count: 1,
    status: 'pending',
    next_retry_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(), // retry in 1 hour
  });
  if (error) console.error('[queue] Failed to write to DLQ:', error.message);
  // Never throw — DLQ write failure must not crash the webhook handler
}

// Get pending DLQ items ready for retry
async function getPendingWebhooks(limit = 20) {
  const { data, error } = await supabase
    .from('webhook_dlq')
    .select('*')
    .eq('status', 'pending')
    .lte('next_retry_at', new Date().toISOString())
    .order('created_at', { ascending: true })
    .limit(limit);

  if (error) throw new Error(`Failed to get pending webhooks: ${error.message}`);
  return data || [];
}

// Mark DLQ webhook as resolved
async function markWebhookResolved(id) {
  const { error } = await supabase
    .from('webhook_dlq')
    .update({ status: 'resolved', resolved_at: new Date().toISOString() })
    .eq('id', id);
  if (error) console.error('[queue] Failed to mark webhook resolved:', error.message);
}

// Mark DLQ webhook as permanently failed
async function markWebhookDead(id, errorMessage, currentAttempt, maxAttempts = 3) {
  const nextAttempt = currentAttempt + 1;
  const isDead = nextAttempt >= maxAttempts;
  const nextRetry = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(); // 4 hours

  const { error } = await supabase
    .from('webhook_dlq')
    .update({
      status: isDead ? 'dead' : 'pending',
      attempt_count: nextAttempt,
      error_message: String(errorMessage).slice(0, 500),
      next_retry_at: isDead ? null : nextRetry,
    })
    .eq('id', id);

  if (error) console.error('[queue] Failed to update DLQ status:', error.message);
  return isDead;
}

// ─── HEALTH METRICS ──────────────────────────────────────────────────────────

// Get current queue depths for health monitoring
async function getQueueDepths() {
  const [emailPending, emailDead, dlqPending, dlqDead] = await Promise.all([
    supabase.from('queued_emails').select('id', { count: 'exact', head: true }).in('status', ['pending', 'failed']),
    supabase.from('queued_emails').select('id', { count: 'exact', head: true }).eq('status', 'dead'),
    supabase.from('webhook_dlq').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
    supabase.from('webhook_dlq').select('id', { count: 'exact', head: true }).eq('status', 'dead'),
  ]);

  return {
    emails_pending: emailPending.count || 0,
    emails_dead: emailDead.count || 0,
    webhooks_pending: dlqPending.count || 0,
    webhooks_dead: dlqDead.count || 0,
  };
}

module.exports = {
  queueEmail,
  getPendingEmails,
  markEmailSent,
  markEmailFailed,
  queueFailedWebhook,
  getPendingWebhooks,
  markWebhookResolved,
  markWebhookDead,
  getQueueDepths,
};
