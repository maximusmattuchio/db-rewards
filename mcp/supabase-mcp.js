#!/usr/bin/env node

/**
 * Supabase MCP Server — Dirty Bastard Laundry Co.
 *
 * Exposes the rewards database via PostgREST as MCP tools so Claude can
 * query and manage customer rewards, event logs, email queues, and webhooks.
 *
 * Tools:
 *   get_customer             — Full reward record for one customer
 *   search_customers         — Find customers by email
 *   get_leaderboard          — Top customers by cycle count
 *   get_pending_fulfillments — All unfulfilled rewards
 *   get_event_log            — Audit trail for a customer
 *   get_email_queue_status   — Email queue health summary
 *   get_dead_webhooks        — Webhooks that exhausted retries
 *   get_stats                — Aggregated system-wide statistics
 *   mark_reward_fulfilled    — Mark a reward as fulfilled via stored proc
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL) {
  process.stderr.write('[supabase-mcp] FATAL: SUPABASE_URL environment variable not set\n');
  process.exit(1);
}
if (!SUPABASE_SERVICE_KEY) {
  process.stderr.write('[supabase-mcp] FATAL: SUPABASE_SERVICE_KEY environment variable not set\n');
  process.exit(1);
}

// ─── POSTGREST API CLIENT ─────────────────────────────────────────────────────

/**
 * Make a request to the Supabase PostgREST API.
 *
 * @param {string} method    - HTTP method
 * @param {string} path      - Path relative to /rest/v1 (e.g. '/customer_rewards')
 * @param {object} [params]  - URL query params object
 * @param {object} [body]    - Request body (for POST/PATCH/PUT)
 * @param {object} [extra]   - Extra headers to merge in
 * @returns {Promise<{ data: any, headers: Headers, status: number }>}
 */
async function postgrest(method, path, params = {}, body = null, extra = {}) {
  const url = new URL(`${SUPABASE_URL}/rest/v1${path}`);

  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') {
      url.searchParams.set(k, String(v));
    }
  });

  const headers = {
    'apikey': SUPABASE_SERVICE_KEY,
    'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    ...extra,
  };

  const options = { method, headers };
  if (body !== null) options.body = JSON.stringify(body);

  const res = await fetch(url.toString(), options);
  const text = await res.text();

  if (!res.ok) {
    let detail = text;
    try {
      const parsed = JSON.parse(text);
      detail = parsed.message || parsed.hint || JSON.stringify(parsed, null, 2);
    } catch {}
    const err = new Error(`PostgREST ${res.status} — ${method} ${path}\n${detail}`);
    err.status = res.status;
    throw err;
  }

  const data = text ? JSON.parse(text) : null;
  return { data, headers: res.headers, status: res.status };
}

/**
 * Parse total record count from the Content-Range header.
 * PostgREST returns e.g. "0-49/312" — we extract the total after the slash.
 */
function parseCount(headers) {
  const cr = headers.get('content-range');
  if (!cr) return null;
  const parts = cr.split('/');
  if (parts.length < 2) return null;
  const total = parseInt(parts[1], 10);
  return isNaN(total) ? null : total;
}

// ─── TOOL DEFINITIONS ─────────────────────────────────────────────────────────

const TOOLS = [

  // ── CUSTOMER ──────────────────────────────────────────────────────────────

  {
    name: 'get_customer',
    description: 'Get the full reward record for a single customer by their Shopify customer ID. Returns cycle count, rewards earned/fulfilled, email, and timestamps.',
    inputSchema: {
      type: 'object',
      properties: {
        shopify_customer_id: {
          type: 'string',
          description: 'Shopify customer ID (numeric string)',
        },
      },
      required: ['shopify_customer_id'],
    },
  },

  {
    name: 'search_customers',
    description: 'Search for customers by email address (case-insensitive, partial match). Returns matching reward records.',
    inputSchema: {
      type: 'object',
      properties: {
        email_query: {
          type: 'string',
          description: 'Email search term (partial match supported)',
        },
        limit: {
          type: 'number',
          description: 'Max results to return (default 20)',
        },
      },
      required: ['email_query'],
    },
  },

  // ── LEADERBOARD ───────────────────────────────────────────────────────────

  {
    name: 'get_leaderboard',
    description: 'Get top customers ranked by cycle count from the rewards_overview view. Includes tier status and cycles to next reward. Optionally filter by tier status.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Number of customers to return (default 50)',
        },
        status: {
          type: 'string',
          enum: ['Active', 'Tier 1', 'Tier 2', 'Legend'],
          description: 'Filter by tier status',
        },
      },
    },
  },

  // ── FULFILLMENTS ──────────────────────────────────────────────────────────

  {
    name: 'get_pending_fulfillments',
    description: 'Get all rewards that have been earned but not yet fulfilled, from the pending_fulfillments view.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Max results to return (default 100)',
        },
      },
    },
  },

  // ── EVENT LOG ─────────────────────────────────────────────────────────────

  {
    name: 'get_event_log',
    description: 'Get the reward event audit trail for a specific customer, ordered newest first. Optionally filter by event type.',
    inputSchema: {
      type: 'object',
      properties: {
        shopify_customer_id: {
          type: 'string',
          description: 'Shopify customer ID',
        },
        limit: {
          type: 'number',
          description: 'Number of events to return (default 25)',
        },
        event_type: {
          type: 'string',
          description: 'Filter by event type (e.g. "milestone_reached", "cycle_counted")',
        },
      },
      required: ['shopify_customer_id'],
    },
  },

  // ── EMAIL QUEUE ───────────────────────────────────────────────────────────

  {
    name: 'get_email_queue_status',
    description: 'Get a health summary of the queued_emails table: counts per status (pending, sent, failed, dead), plus the most recent failures.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },

  // ── WEBHOOKS ──────────────────────────────────────────────────────────────

  {
    name: 'get_dead_webhooks',
    description: 'Get webhooks in the dead-letter queue that have exhausted all retry attempts. Useful for investigating failed charge events.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Max results to return (default 50)',
        },
      },
    },
  },

  // ── STATS ─────────────────────────────────────────────────────────────────

  {
    name: 'get_stats',
    description: 'Get aggregated system-wide statistics: total customers, average cycle count, tier distribution, emails sent, and total milestones reached. All queries run in parallel.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },

  // ── MARK FULFILLED ────────────────────────────────────────────────────────

  {
    name: 'mark_reward_fulfilled',
    description: 'Mark a specific reward as fulfilled for a customer by calling the mark_reward_fulfilled stored procedure.',
    inputSchema: {
      type: 'object',
      properties: {
        customer_id: {
          type: 'string',
          description: 'Shopify customer ID',
        },
        reward_id: {
          type: 'string',
          description: 'Reward ID to mark as fulfilled',
        },
      },
      required: ['customer_id', 'reward_id'],
    },
  },

];

// ─── TOOL HANDLERS ────────────────────────────────────────────────────────────

async function handleTool(name, args) {
  switch (name) {

    // ── get_customer ────────────────────────────────────────────────────────
    case 'get_customer': {
      const { data } = await postgrest('GET', '/customer_rewards', {
        'shopify_customer_id': `eq.${args.shopify_customer_id}`,
      });

      if (!data || data.length === 0) {
        return { found: false, shopify_customer_id: args.shopify_customer_id };
      }

      return { found: true, customer: data[0] };
    }

    // ── search_customers ────────────────────────────────────────────────────
    case 'search_customers': {
      const limit = args.limit || 20;
      const { data } = await postgrest('GET', '/customer_rewards', {
        'email': `ilike.*${args.email_query}*`,
        'order': 'cycle_count.desc',
        'limit': limit,
      });

      return {
        count: data ? data.length : 0,
        query: args.email_query,
        customers: data || [],
      };
    }

    // ── get_leaderboard ─────────────────────────────────────────────────────
    case 'get_leaderboard': {
      const limit = args.limit || 50;
      const params = {
        'order': 'cycle_count.desc',
        'limit': limit,
      };
      if (args.status) {
        params['status'] = `eq.${args.status}`;
      }

      const { data } = await postgrest('GET', '/rewards_overview', params);

      return {
        count: data ? data.length : 0,
        status_filter: args.status || null,
        leaderboard: data || [],
      };
    }

    // ── get_pending_fulfillments ─────────────────────────────────────────────
    case 'get_pending_fulfillments': {
      const limit = args.limit || 100;
      const { data } = await postgrest('GET', '/pending_fulfillments', {
        'fulfillment_status': 'eq.pending',
        'order': 'earned_at.asc',
        'limit': limit,
      });

      return {
        count: data ? data.length : 0,
        pending_fulfillments: data || [],
      };
    }

    // ── get_event_log ───────────────────────────────────────────────────────
    case 'get_event_log': {
      const limit = args.limit || 25;
      const params = {
        'shopify_customer_id': `eq.${args.shopify_customer_id}`,
        'order': 'created_at.desc',
        'limit': limit,
      };
      if (args.event_type) {
        params['event_type'] = `eq.${args.event_type}`;
      }

      const { data } = await postgrest('GET', '/reward_events', params);

      return {
        shopify_customer_id: args.shopify_customer_id,
        count: data ? data.length : 0,
        event_type_filter: args.event_type || null,
        events: data || [],
      };
    }

    // ── get_email_queue_status ──────────────────────────────────────────────
    case 'get_email_queue_status': {
      const statuses = ['pending', 'sent', 'failed', 'dead'];

      // Fetch counts for each status in parallel
      const countResults = await Promise.all(
        statuses.map(status =>
          postgrest('GET', '/queued_emails', {
            'status': `eq.${status}`,
            'select': 'id',
            'limit': 1,
          }, null, { 'Prefer': 'count=exact' })
            .then(({ headers }) => ({ status, count: parseCount(headers) ?? 0 }))
            .catch(() => ({ status, count: 0 }))
        )
      );

      // Fetch the most recent failures for context
      const { data: recentFailures } = await postgrest('GET', '/queued_emails', {
        'status': `eq.failed`,
        'order': 'created_at.desc',
        'limit': 5,
        'select': 'id,shopify_customer_id,email,reward_id,last_error,attempt_count,next_retry_at,created_at',
      });

      const counts = countResults.reduce((acc, { status, count }) => {
        acc[status] = count;
        return acc;
      }, {});

      const total = Object.values(counts).reduce((s, n) => s + n, 0);

      return {
        total,
        counts,
        recent_failures: recentFailures || [],
      };
    }

    // ── get_dead_webhooks ───────────────────────────────────────────────────
    case 'get_dead_webhooks': {
      const limit = args.limit || 50;
      const { data } = await postgrest('GET', '/webhook_dlq', {
        'status': 'eq.dead',
        'order': 'created_at.desc',
        'limit': limit,
      });

      return {
        count: data ? data.length : 0,
        dead_webhooks: data || [],
      };
    }

    // ── get_stats ───────────────────────────────────────────────────────────
    case 'get_stats': {
      const [
        customersResult,
        tiersResult,
        sentEmailsResult,
        milestonesResult,
      ] = await Promise.all([
        // 1. Total customers + cycle counts for average
        postgrest('GET', '/customer_rewards', {
          'select': 'cycle_count',
        }, null, { 'Prefer': 'count=exact' }),

        // 2. Tier distribution from rewards_overview
        postgrest('GET', '/rewards_overview', {
          'select': 'status',
        }),

        // 3. Total sent emails
        postgrest('GET', '/queued_emails', {
          'status': 'eq.sent',
          'select': 'id',
          'limit': 1,
        }, null, { 'Prefer': 'count=exact' }),

        // 4. Total milestones reached
        postgrest('GET', '/reward_events', {
          'event_type': 'eq.milestone_reached',
          'select': 'id',
          'limit': 1,
        }, null, { 'Prefer': 'count=exact' }),
      ]);

      // Parse total customer count from Content-Range
      const totalCustomers = parseCount(customersResult.headers) ?? (customersResult.data ? customersResult.data.length : 0);

      // Calculate average cycle count
      const cycleCounts = (customersResult.data || []).map(r => r.cycle_count || 0);
      const avgCycleCount = cycleCounts.length > 0
        ? Math.round((cycleCounts.reduce((s, n) => s + n, 0) / cycleCounts.length) * 100) / 100
        : 0;

      // Build tier distribution
      const tierCounts = { Active: 0, 'Tier 1': 0, 'Tier 2': 0, Legend: 0 };
      (tiersResult.data || []).forEach(row => {
        if (row.status in tierCounts) tierCounts[row.status]++;
      });

      const totalEmailsSent = parseCount(sentEmailsResult.headers) ?? 0;
      const totalMilestones = parseCount(milestonesResult.headers) ?? 0;

      return {
        total_customers: totalCustomers,
        avg_cycle_count: avgCycleCount,
        tier_distribution: tierCounts,
        total_emails_sent: totalEmailsSent,
        total_milestones_reached: totalMilestones,
      };
    }

    // ── mark_reward_fulfilled ───────────────────────────────────────────────
    case 'mark_reward_fulfilled': {
      let result;
      try {
        result = await postgrest('POST', '/rpc/mark_reward_fulfilled', {}, {
          customer_id: args.customer_id,
          reward_id: args.reward_id,
        });
      } catch (err) {
        if (err.status === 404) {
          throw new Error(
            'Stored procedure mark_reward_fulfilled not found. ' +
            'Run the mark_reward_fulfilled stored procedure migration in Supabase first.'
          );
        }
        throw err;
      }

      return {
        success: true,
        customer_id: args.customer_id,
        reward_id: args.reward_id,
        result: result.data,
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ─── MCP SERVER SETUP ─────────────────────────────────────────────────────────

const server = new Server(
  { name: 'supabase-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    const result = await handleTool(name, args || {});
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    process.stderr.write(`[supabase-mcp] Error in tool "${name}": ${err.message}\n`);
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: err.message }, null, 2) }],
      isError: true,
    };
  }
});

// ─── START ────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write('[supabase-mcp] Ready\n');
