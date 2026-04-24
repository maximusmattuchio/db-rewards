#!/usr/bin/env node

/**
 * Recharge MCP Server — Dirty Bastard Laundry Co.
 *
 * Exposes Recharge subscription billing API operations as MCP tools so Claude
 * can inspect subscriptions, charges, and customers, and perform safe mutations.
 *
 * Tools:
 *   Stats         — get_subscription_stats
 *   Subscriptions — list_subscriptions, get_subscription, search_customer_subscriptions
 *   Charges       — list_charges, get_charge
 *   Customers     — get_customer
 *   Actions       — skip_next_charge, cancel_subscription
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const API_KEY = process.env.RECHARGE_API_KEY;
const BASE_URL = 'https://api.rechargeapps.com';

if (!API_KEY) {
  process.stderr.write('[recharge-mcp] FATAL: RECHARGE_API_KEY environment variable not set\n');
  process.exit(1);
}

// ─── RECHARGE API CLIENT ──────────────────────────────────────────────────────

async function recharge(method, path, body = null, params = {}) {
  const url = new URL(`${BASE_URL}${path}`);

  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') {
      url.searchParams.set(k, String(v));
    }
  });

  const options = {
    method,
    headers: {
      'X-Recharge-Access-Token': API_KEY,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
  };

  if (body !== null) options.body = JSON.stringify(body);

  const res = await fetch(url.toString(), options);
  const text = await res.text();

  if (!res.ok) {
    let detail = text;
    try {
      const parsed = JSON.parse(text);
      detail = JSON.stringify(parsed.errors || parsed, null, 2);
    } catch {}
    throw new Error(`Recharge ${res.status} — ${method} ${path}\n${detail}`);
  }

  return text ? JSON.parse(text) : null;
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function formatSubscription(s) {
  return {
    id: s.id,
    customer_id: s.customer_id,
    shopify_customer_id: s.shopify_customer_id,
    product_title: s.product_title,
    variant_title: s.variant_title,
    price: s.price,
    status: s.status,
    next_charge_scheduled_at: s.next_charge_scheduled_at,
    frequency: s.charge_interval_frequency
      ? `${s.charge_interval_frequency} ${s.order_interval_unit}`
      : null,
  };
}

function formatCharge(c) {
  return {
    id: c.id,
    customer_id: c.customer_id,
    shopify_customer_id: c.shopify_customer_id,
    type: c.type,
    status: c.status,
    total_price: c.total_price,
    processed_at: c.processed_at,
    scheduled_at: c.scheduled_at,
  };
}

// ─── TOOL DEFINITIONS ─────────────────────────────────────────────────────────

const TOOLS = [

  // ── STATS ─────────────────────────────────────────────────────────────────

  {
    name: 'get_subscription_stats',
    description: 'Get high-level subscription stats: total active subscriptions and total charges processed. Calls /subscriptions/count and /charges/count.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },

  // ── SUBSCRIPTIONS ─────────────────────────────────────────────────────────

  {
    name: 'list_subscriptions',
    description: 'List subscriptions with optional filters. Returns id, customer_id, shopify_customer_id, product_title, variant_title, price, status, next_charge_scheduled_at, and frequency (interval + unit).',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['ACTIVE', 'CANCELLED', 'EXPIRED'],
          description: 'Filter by subscription status. Default: ACTIVE',
        },
        email: {
          type: 'string',
          description: 'Filter by customer email (optional)',
        },
        limit: {
          type: 'number',
          description: 'Number of results to return (max 250, default 50)',
        },
        page: {
          type: 'number',
          description: 'Page number for pagination (default 1)',
        },
      },
    },
  },

  {
    name: 'get_subscription',
    description: 'Get full detail for a single subscription by its Recharge subscription ID.',
    inputSchema: {
      type: 'object',
      properties: {
        subscription_id: {
          type: 'string',
          description: 'Recharge subscription ID',
        },
      },
      required: ['subscription_id'],
    },
  },

  {
    name: 'search_customer_subscriptions',
    description: 'Find all subscriptions for a customer by their email address. Looks up the Recharge customer record first, then returns all their subscriptions.',
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Customer email address to search for',
        },
      },
      required: ['email'],
    },
  },

  // ── CHARGES ───────────────────────────────────────────────────────────────

  {
    name: 'list_charges',
    description: 'List charges with optional filters. Returns id, customer_id, shopify_customer_id, type, status, total_price, processed_at, scheduled_at.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['SUCCESS', 'FAILURE', 'QUEUED', 'SKIPPED', 'REFUNDED'],
          description: 'Filter by charge status (optional)',
        },
        customer_id: {
          type: 'string',
          description: 'Filter by Recharge customer ID (optional)',
        },
        date_min: {
          type: 'string',
          description: 'Minimum scheduled/processed date in ISO format, e.g. 2024-01-01 (optional)',
        },
        date_max: {
          type: 'string',
          description: 'Maximum scheduled/processed date in ISO format, e.g. 2024-12-31 (optional)',
        },
        limit: {
          type: 'number',
          description: 'Number of results to return (default 50)',
        },
      },
    },
  },

  {
    name: 'get_charge',
    description: 'Get full detail for a single charge by its Recharge charge ID, including all line items.',
    inputSchema: {
      type: 'object',
      properties: {
        charge_id: {
          type: 'string',
          description: 'Recharge charge ID',
        },
      },
      required: ['charge_id'],
    },
  },

  // ── CUSTOMERS ─────────────────────────────────────────────────────────────

  {
    name: 'get_customer',
    description: 'Get a Recharge customer record by their Recharge customer ID. Returns id, email, shopify_customer_id, status, subscriptions_active_count, first_charge_processed_at.',
    inputSchema: {
      type: 'object',
      properties: {
        customer_id: {
          type: 'string',
          description: 'Recharge customer ID',
        },
      },
      required: ['customer_id'],
    },
  },

  // ── ACTIONS ───────────────────────────────────────────────────────────────

  {
    name: 'skip_next_charge',
    description: 'Skip a queued charge so the customer skips one billing cycle. The charge must be in QUEUED status. Returns the updated charge record.',
    inputSchema: {
      type: 'object',
      properties: {
        charge_id: {
          type: 'string',
          description: 'Recharge charge ID to skip (must be in QUEUED status)',
        },
      },
      required: ['charge_id'],
    },
  },

  {
    name: 'cancel_subscription',
    description: 'DANGEROUS: Cancel an active subscription permanently. Requires confirm: true as a safety gate. Provide a cancellation_reason string.',
    inputSchema: {
      type: 'object',
      properties: {
        subscription_id: {
          type: 'string',
          description: 'Recharge subscription ID to cancel',
        },
        cancellation_reason: {
          type: 'string',
          description: 'Reason for cancellation (required, stored in Recharge)',
        },
        confirm: {
          type: 'boolean',
          description: 'Must be exactly true to proceed — safety gate to prevent accidental cancellations',
        },
      },
      required: ['subscription_id', 'cancellation_reason', 'confirm'],
    },
  },
];

// ─── TOOL HANDLERS ────────────────────────────────────────────────────────────

async function handleTool(name, args) {
  switch (name) {

    // ── get_subscription_stats ─────────────────────────────────────────────
    case 'get_subscription_stats': {
      const [subCount, chargeCount] = await Promise.all([
        recharge('GET', '/subscriptions/count'),
        recharge('GET', '/charges/count'),
      ]);
      return {
        active_subscriptions: subCount.count,
        total_charges: chargeCount.count,
      };
    }

    // ── list_subscriptions ─────────────────────────────────────────────────
    case 'list_subscriptions': {
      const limit = Math.min(args.limit || 50, 250);
      const params = {
        status: args.status || 'ACTIVE',
        limit,
        page: args.page || 1,
      };
      if (args.email) params.email = args.email;

      const data = await recharge('GET', '/subscriptions', null, params);
      const subs = data.subscriptions || [];
      return {
        count: subs.length,
        page: params.page,
        subscriptions: subs.map(formatSubscription),
      };
    }

    // ── get_subscription ───────────────────────────────────────────────────
    case 'get_subscription': {
      const data = await recharge('GET', `/subscriptions/${args.subscription_id}`);
      return data.subscription;
    }

    // ── search_customer_subscriptions ──────────────────────────────────────
    case 'search_customer_subscriptions': {
      // Step 1: look up Recharge customer by email
      const custData = await recharge('GET', '/customers', null, {
        email: args.email,
        limit: 1,
      });
      const customers = custData.customers || [];

      if (customers.length === 0) {
        return { found: false, email: args.email };
      }

      const customer = customers[0];

      // Step 2: get their subscriptions
      const subData = await recharge('GET', '/subscriptions', null, {
        customer_id: customer.id,
        limit: 250,
      });
      const subs = subData.subscriptions || [];

      return {
        customer: {
          id: customer.id,
          email: customer.email,
          shopify_customer_id: customer.shopify_customer_id,
        },
        subscriptions: subs.map(formatSubscription),
        subscription_count: subs.length,
      };
    }

    // ── list_charges ───────────────────────────────────────────────────────
    case 'list_charges': {
      const params = {
        limit: args.limit || 50,
      };
      if (args.status) params.status = args.status;
      if (args.customer_id) params.customer_id = args.customer_id;
      if (args.date_min) params.date_min = args.date_min;
      if (args.date_max) params.date_max = args.date_max;

      const data = await recharge('GET', '/charges', null, params);
      const charges = data.charges || [];
      return {
        count: charges.length,
        charges: charges.map(formatCharge),
      };
    }

    // ── get_charge ─────────────────────────────────────────────────────────
    case 'get_charge': {
      const data = await recharge('GET', `/charges/${args.charge_id}`);
      return data.charge;
    }

    // ── get_customer ───────────────────────────────────────────────────────
    case 'get_customer': {
      const data = await recharge('GET', `/customers/${args.customer_id}`);
      const c = data.customer;
      return {
        id: c.id,
        email: c.email,
        shopify_customer_id: c.shopify_customer_id,
        status: c.status,
        subscriptions_active_count: c.subscriptions_active_count,
        first_charge_processed_at: c.first_charge_processed_at,
      };
    }

    // ── skip_next_charge ───────────────────────────────────────────────────
    case 'skip_next_charge': {
      const data = await recharge('POST', `/charges/${args.charge_id}/skip`, {});
      return data.charge;
    }

    // ── cancel_subscription ────────────────────────────────────────────────
    case 'cancel_subscription': {
      if (args.confirm !== true) {
        throw new Error('Cancellation requires confirm: true to prevent accidents');
      }
      const data = await recharge('POST', `/subscriptions/${args.subscription_id}/cancel`, {
        cancellation_reason: args.cancellation_reason,
      });
      return data.subscription;
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ─── MCP SERVER SETUP ─────────────────────────────────────────────────────────

const server = new Server(
  { name: 'recharge-mcp', version: '1.0.0' },
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
    process.stderr.write(`[recharge-mcp] Error in tool "${name}": ${err.message}\n`);
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: err.message }, null, 2) }],
      isError: true,
    };
  }
});

// ─── START ────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write('[recharge-mcp] Ready\n');
