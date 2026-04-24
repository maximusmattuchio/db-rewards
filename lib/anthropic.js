/**
 * Anthropic Client — shared module
 *
 * Provides:
 *   buildScoringPrompt(signals)  — assemble the Claude prompt from raw customer signals
 *   scoreCustomer(signals)       — call Claude Haiku, validate, return structured output
 */

const Anthropic = require('@anthropic-ai/sdk');

const MODEL = 'claude-haiku-4-5-20251001';

let _client = null;
function getClient() {
  if (!_client) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error('ANTHROPIC_API_KEY is not configured');
    _client = new Anthropic({ apiKey: key });
  }
  return _client;
}

/**
 * Build the scoring prompt from raw customer signals.
 *
 * @param {Object} signals
 * @param {string}  signals.shopify_customer_id
 * @param {number}  signals.cycle_count
 * @param {number}  signals.subscription_age_days
 * @param {string}  signals.subscription_status       — 'active' | 'paused' | 'cancelled' | unknown
 * @param {number}  signals.recent_failed_charges     — last 90 days
 * @param {number}  signals.recent_skipped_charges    — last 90 days
 * @param {number}  signals.total_spend               — lifetime USD
 * @param {string}  signals.last_charge_status        — 'success' | 'failure' | 'skipped' | null
 * @param {number}  signals.days_since_last_charge    — null if never charged
 * @param {number}  signals.cycles_to_next_reward
 * @returns {string}
 */
function buildScoringPrompt(signals) {
  const {
    shopify_customer_id,
    cycle_count = 0,
    subscription_age_days = 0,
    subscription_status = 'unknown',
    recent_failed_charges = 0,
    recent_skipped_charges = 0,
    total_spend = 0,
    last_charge_status = null,
    days_since_last_charge = null,
    cycles_to_next_reward = 0,
  } = signals;

  return `You are a churn prediction model for a subscription laundry detergent brand called Dirty Bastard Laundry Co.

Analyze the following customer signals and output a JSON object (no markdown, no explanation — raw JSON only).

CUSTOMER SIGNALS:
- Customer ID: ${shopify_customer_id}
- Subscription status: ${subscription_status}
- Active subscription cycles completed: ${cycle_count}
- Subscription age: ${subscription_age_days} days
- Recent failed charges (last 90 days): ${recent_failed_charges}
- Recent skipped charges (last 90 days): ${recent_skipped_charges}
- Lifetime spend: $${Number(total_spend).toFixed(2)}
- Last charge status: ${last_charge_status || 'unknown'}
- Days since last charge: ${days_since_last_charge != null ? days_since_last_charge : 'unknown'}
- Cycles until next reward: ${cycles_to_next_reward}

OUTPUT FORMAT (strict JSON, all fields required):
{
  "churn_risk_score": <float 0.000–1.000, where 1.000 = certain churn>,
  "churn_risk_label": <"low" | "medium" | "high" | "critical">,
  "churn_risk_factors": [<up to 3 short plain-English strings explaining why>],
  "recommended_action": <"none" | "winback_email" | "pause_offer" | "loyalty_reminder" | "urgent_save">,
  "recommended_action_reason": <one sentence>,
  "predicted_ltv_6mo": <float, predicted USD spend in next 6 months>
}

Rules:
- churn_risk_label: low < 0.30, medium 0.30–0.59, high 0.60–0.79, critical >= 0.80
- If subscription_status is "cancelled", churn_risk_score must be 1.000, label must be "critical"
- If subscription_status is "paused" with no recent failures, label should be at least "medium"
- Reward proximity (cycles_to_next_reward <= 2) is a strong retention signal — reduce risk score accordingly
- Payment failures are the strongest churn indicator
- Output ONLY the JSON object. No markdown fences, no commentary.`;
}

/**
 * Score a single customer using Claude Haiku.
 * Returns the parsed scoring object on success, throws on failure.
 *
 * @param {Object} signals  — same shape as buildScoringPrompt
 * @returns {Promise<Object>}
 */
async function scoreCustomer(signals) {
  const prompt = buildScoringPrompt(signals);

  const message = await getClient().messages.create({
    model: MODEL,
    max_tokens: 512,
    temperature: 0,
    messages: [{ role: 'user', content: prompt }],
  });

  let raw = (message.content[0]?.text || '').trim();

  // Strip markdown code fences if present (```json ... ``` or ``` ... ```)
  raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Claude returned non-JSON: ${raw.slice(0, 200)}`);
  }

  // Validate required fields
  const required = [
    'churn_risk_score', 'churn_risk_label', 'churn_risk_factors',
    'recommended_action', 'recommended_action_reason', 'predicted_ltv_6mo',
  ];
  for (const field of required) {
    if (parsed[field] == null) throw new Error(`Missing field in Claude response: ${field}`);
  }

  // Clamp score to valid range
  parsed.churn_risk_score = Math.min(1, Math.max(0, Number(parsed.churn_risk_score)));
  parsed.predicted_ltv_6mo = Math.max(0, Number(parsed.predicted_ltv_6mo));

  // Ensure factors is an array of strings
  if (!Array.isArray(parsed.churn_risk_factors)) {
    parsed.churn_risk_factors = [String(parsed.churn_risk_factors)];
  }

  return parsed;
}

module.exports = { buildScoringPrompt, scoreCustomer, MODEL };
