#!/usr/bin/env node

/**
 * Klaviyo MCP Server — Dirty Bastard Laundry Co.
 *
 * Exposes Klaviyo REST API operations as MCP tools so Claude can manage
 * templates, flows, analytics, profiles, and events directly in-chat.
 *
 * Tools:
 *   Templates  — list, get, create, update
 *   Flows      — list, get, get_actions, update_status
 *   Analytics  — list_metrics, get_metric_aggregates
 *   Profiles   — get_profile, get_profile_events
 *   Events     — track_event, get_events
 *   Campaigns  — list_campaigns
 *   Account    — get_account_info
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

// Accept either spelling: production env was created with the typo KLAYVIO_API_KEY.
const API_KEY = process.env.KLAVIYO_API_KEY || process.env.KLAYVIO_API_KEY;
const BASE_URL = 'https://a.klaviyo.com/api';
const REVISION = '2023-12-15';

if (!API_KEY) {
  process.stderr.write('[klaviyo-mcp] FATAL: neither KLAVIYO_API_KEY nor KLAYVIO_API_KEY is set\n');
  process.exit(1);
}

// ─── KLAVIYO API CLIENT ───────────────────────────────────────────────────────

async function klaviyo(method, path, body = null, params = {}) {
  const url = new URL(`${BASE_URL}${path}`);

  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') {
      url.searchParams.set(k, String(v));
    }
  });

  const options = {
    method,
    headers: {
      'Authorization': `Klaviyo-API-Key ${API_KEY}`,
      'revision': REVISION,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
  };

  if (body) options.body = JSON.stringify(body);

  const res = await fetch(url.toString(), options);
  const text = await res.text();

  if (!res.ok) {
    let detail = text;
    try {
      const parsed = JSON.parse(text);
      detail = JSON.stringify(parsed.errors || parsed, null, 2);
    } catch {}
    throw new Error(`Klaviyo ${res.status} — ${method} ${path}\n${detail}`);
  }

  return text ? JSON.parse(text) : null;
}

// Paginate through all pages of a list endpoint automatically
async function klaviyoAll(path, params = {}) {
  const results = [];
  let nextUrl = null;
  const url = new URL(`${BASE_URL}${path}`);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  });

  let currentUrl = url.toString();

  while (currentUrl) {
    const res = await fetch(currentUrl, {
      headers: {
        'Authorization': `Klaviyo-API-Key ${API_KEY}`,
        'revision': REVISION,
        'Accept': 'application/json',
      },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Klaviyo ${res.status} — GET ${path}: ${text}`);
    const data = JSON.parse(text);
    results.push(...(data.data || []));
    currentUrl = data.links?.next || null;
  }

  return results;
}

// ─── TOOL DEFINITIONS ─────────────────────────────────────────────────────────

const TOOLS = [

  // ── TEMPLATES ────────────────────────────────────────────────────────────────

  {
    name: 'list_templates',
    description: 'List all email templates in Klaviyo. Returns ID, name, editor type, and last updated date. Sorted newest first.',
    inputSchema: {
      type: 'object',
      properties: {
        page_size: {
          type: 'number',
          description: 'Results per page (max 100, default 50)',
        },
      },
    },
  },

  {
    name: 'get_template',
    description: 'Get a specific email template by ID, including its complete HTML content and metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        template_id: {
          type: 'string',
          description: 'Klaviyo template ID (e.g. TLVZg6)',
        },
      },
      required: ['template_id'],
    },
  },

  {
    name: 'update_template',
    description: 'Update an email template\'s name and/or HTML content. Provide at least one of name or html.',
    inputSchema: {
      type: 'object',
      properties: {
        template_id: {
          type: 'string',
          description: 'Template ID to update',
        },
        name: {
          type: 'string',
          description: 'New display name for the template',
        },
        html: {
          type: 'string',
          description: 'New HTML content for the template',
        },
      },
      required: ['template_id'],
    },
  },

  {
    name: 'create_template',
    description: 'Create a new HTML email template in Klaviyo.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Template display name',
        },
        html: {
          type: 'string',
          description: 'Full HTML content of the template',
        },
      },
      required: ['name', 'html'],
    },
  },

  // ── FLOWS ─────────────────────────────────────────────────────────────────

  {
    name: 'list_flows',
    description: 'List all flows with status, trigger type, tags, and timestamps. Optionally filter by status.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['draft', 'live', 'manual'],
          description: 'Filter flows by status',
        },
      },
    },
  },

  {
    name: 'get_flow',
    description: 'Get detailed information about a specific flow by ID.',
    inputSchema: {
      type: 'object',
      properties: {
        flow_id: {
          type: 'string',
          description: 'Flow ID',
        },
      },
      required: ['flow_id'],
    },
  },

  {
    name: 'get_flow_actions',
    description: 'Get all actions (emails, time delays, conditional splits) within a flow, including email settings and send options.',
    inputSchema: {
      type: 'object',
      properties: {
        flow_id: {
          type: 'string',
          description: 'Flow ID',
        },
      },
      required: ['flow_id'],
    },
  },

  {
    name: 'update_flow_status',
    description: 'Change a flow\'s status. Use "live" to activate, "manual" to pause, "draft" to deactivate.',
    inputSchema: {
      type: 'object',
      properties: {
        flow_id: {
          type: 'string',
          description: 'Flow ID to update',
        },
        status: {
          type: 'string',
          enum: ['draft', 'live', 'manual'],
          description: '"live" = active, "manual" = paused, "draft" = inactive',
        },
      },
      required: ['flow_id', 'status'],
    },
  },

  // ── ANALYTICS ─────────────────────────────────────────────────────────────

  {
    name: 'list_metrics',
    description: 'List all metrics/events tracked in Klaviyo — including custom events like "Reward Milestone Reached" and "Subscription Cycle Counted", plus standard Klaviyo events like "Opened Email" and "Clicked Email".',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },

  {
    name: 'get_metric_aggregates',
    description: 'Get time-series aggregate statistics for a metric — count, unique profiles, or sum of value. Use metric IDs from list_metrics. Great for checking open rates, click rates, and event volumes over time.',
    inputSchema: {
      type: 'object',
      properties: {
        metric_id: {
          type: 'string',
          description: 'Metric ID (from list_metrics)',
        },
        measurements: {
          type: 'array',
          items: { type: 'string', enum: ['count', 'unique', 'sum_value'] },
          description: 'Measurements to compute. Default: ["count", "unique"]',
        },
        interval: {
          type: 'string',
          enum: ['day', 'week', 'month'],
          description: 'Time grouping interval. Default: day',
        },
        start_date: {
          type: 'string',
          description: 'Start date in YYYY-MM-DD format. Default: 30 days ago',
        },
        end_date: {
          type: 'string',
          description: 'End date in YYYY-MM-DD format. Default: today',
        },
      },
      required: ['metric_id'],
    },
  },

  // ── PROFILES ──────────────────────────────────────────────────────────────

  {
    name: 'get_profile',
    description: 'Look up a subscriber profile by email address. Returns name, subscription status, suppression status, and all custom properties.',
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address to look up',
        },
      },
      required: ['email'],
    },
  },

  {
    name: 'get_profile_events',
    description: 'Get the event history for a profile — useful for debugging whether flows triggered correctly, verifying events were received, and auditing email delivery.',
    inputSchema: {
      type: 'object',
      properties: {
        profile_id: {
          type: 'string',
          description: 'Klaviyo profile ID (from get_profile)',
        },
        page_size: {
          type: 'number',
          description: 'Number of events to return (max 200, default 25)',
        },
      },
      required: ['profile_id'],
    },
  },

  // ── EVENTS ────────────────────────────────────────────────────────────────

  {
    name: 'track_event',
    description: 'Fire a Klaviyo event for a profile. Use this to test flows without waiting for real subscriber activity — e.g. fire "Reward Milestone Reached" with test data to verify the flow email sends correctly.',
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the profile to fire the event for',
        },
        event_name: {
          type: 'string',
          description: 'Event name (e.g. "Reward Milestone Reached", "Subscription Cycle Counted")',
        },
        properties: {
          type: 'object',
          description: 'Key-value event properties matching your template variables',
        },
        value: {
          type: 'number',
          description: 'Optional monetary value to associate with this event (for revenue tracking)',
        },
      },
      required: ['email', 'event_name'],
    },
  },

  {
    name: 'get_events',
    description: 'Get recent events across all profiles. Optionally filter by metric ID. Returns event properties and the profile email for each event.',
    inputSchema: {
      type: 'object',
      properties: {
        metric_id: {
          type: 'string',
          description: 'Filter by metric ID (from list_metrics)',
        },
        page_size: {
          type: 'number',
          description: 'Number of events to return (max 200, default 25)',
        },
      },
    },
  },

  // ── CAMPAIGNS ─────────────────────────────────────────────────────────────

  {
    name: 'list_campaigns',
    description: 'List all email campaigns with their status, scheduled send time, and names.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          description: 'Filter by status: draft, scheduled, sent, cancelled',
        },
      },
    },
  },

  // ── ACCOUNT ───────────────────────────────────────────────────────────────

  {
    name: 'get_account_info',
    description: 'Get Klaviyo account information including organization name, timezone, currency, and public API key.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

// ─── TOOL HANDLERS ────────────────────────────────────────────────────────────

async function handleTool(name, args) {
  switch (name) {

    // ── list_templates ─────────────────────────────────────────────────────
    case 'list_templates': {
      const pageSize = Math.min(args.page_size || 50, 100);
      const data = await klaviyo('GET', '/templates/', null, {
        'page[size]': pageSize,
        'sort': '-updated',
      });
      return {
        count: data.data.length,
        templates: data.data.map(t => ({
          id: t.id,
          name: t.attributes.name,
          editor_type: t.attributes.editor_type,
          created: t.attributes.created,
          updated: t.attributes.updated,
        })),
      };
    }

    // ── get_template ───────────────────────────────────────────────────────
    case 'get_template': {
      const data = await klaviyo('GET', `/templates/${args.template_id}/`);
      return {
        id: data.data.id,
        name: data.data.attributes.name,
        editor_type: data.data.attributes.editor_type,
        html: data.data.attributes.html,
        created: data.data.attributes.created,
        updated: data.data.attributes.updated,
      };
    }

    // ── update_template ────────────────────────────────────────────────────
    case 'update_template': {
      if (!args.name && !args.html) {
        throw new Error('Provide at least one of: name, html');
      }
      const attributes = {};
      if (args.name) attributes.name = args.name;
      if (args.html) attributes.html = args.html;

      const data = await klaviyo('PATCH', `/templates/${args.template_id}/`, {
        data: {
          type: 'template',
          id: args.template_id,
          attributes,
        },
      });
      return {
        success: true,
        id: data.data.id,
        name: data.data.attributes.name,
        updated: data.data.attributes.updated,
      };
    }

    // ── create_template ────────────────────────────────────────────────────
    case 'create_template': {
      const data = await klaviyo('POST', '/templates/', {
        data: {
          type: 'template',
          attributes: {
            name: args.name,
            html: args.html,
            editor_type: 'CODE',
          },
        },
      });
      return {
        success: true,
        id: data.data.id,
        name: data.data.attributes.name,
        created: data.data.attributes.created,
      };
    }

    // ── list_flows ─────────────────────────────────────────────────────────
    case 'list_flows': {
      const params = { 'sort': '-updated', 'page[size]': 50 };
      if (args.status) {
        params['filter'] = `equals(status,"${args.status}")`;
      }
      const data = await klaviyo('GET', '/flows/', null, params);
      return {
        count: data.data.length,
        flows: data.data.map(f => ({
          id: f.id,
          name: f.attributes.name,
          status: f.attributes.status,
          trigger_type: f.attributes.trigger_type,
          archived: f.attributes.archived,
          tags: f.attributes.tags || [],
          created: f.attributes.created,
          updated: f.attributes.updated,
        })),
      };
    }

    // ── get_flow ───────────────────────────────────────────────────────────
    case 'get_flow': {
      const data = await klaviyo('GET', `/flows/${args.flow_id}/`);
      return {
        id: data.data.id,
        name: data.data.attributes.name,
        status: data.data.attributes.status,
        trigger_type: data.data.attributes.trigger_type,
        archived: data.data.attributes.archived,
        tags: data.data.attributes.tags || [],
        created: data.data.attributes.created,
        updated: data.data.attributes.updated,
      };
    }

    // ── get_flow_actions ───────────────────────────────────────────────────
    case 'get_flow_actions': {
      const data = await klaviyo('GET', `/flows/${args.flow_id}/flow-actions/`);
      return {
        flow_id: args.flow_id,
        count: data.data.length,
        actions: data.data.map(a => ({
          id: a.id,
          action_type: a.attributes.action_type,
          status: a.attributes.status,
          tracking_options: a.attributes.tracking_options,
          send_options: a.attributes.send_options,
          smart_sending_options: a.attributes.smart_sending_options,
          created: a.attributes.created,
          updated: a.attributes.updated,
        })),
      };
    }

    // ── update_flow_status ─────────────────────────────────────────────────
    case 'update_flow_status': {
      const data = await klaviyo('PATCH', `/flows/${args.flow_id}/`, {
        data: {
          type: 'flow',
          id: args.flow_id,
          attributes: { status: args.status },
        },
      });
      return {
        success: true,
        flow_id: data.data.id,
        name: data.data.attributes.name,
        status: data.data.attributes.status,
      };
    }

    // ── list_metrics ───────────────────────────────────────────────────────
    case 'list_metrics': {
      const data = await klaviyo('GET', '/metrics/', null, { 'page[size]': 200 });
      return {
        count: data.data.length,
        metrics: data.data.map(m => ({
          id: m.id,
          name: m.attributes.name,
          integration: m.attributes.integration?.name || 'Custom',
          created: m.attributes.created,
        })),
      };
    }

    // ── get_metric_aggregates ──────────────────────────────────────────────
    case 'get_metric_aggregates': {
      const now = new Date();
      const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);
      const startDate = args.start_date || thirtyDaysAgo.toISOString().split('T')[0];
      const endDate = args.end_date || now.toISOString().split('T')[0];
      const measurements = args.measurements || ['count', 'unique'];
      const interval = args.interval || 'day';

      const data = await klaviyo('POST', '/metric-aggregates/', {
        data: {
          type: 'metric-aggregate',
          attributes: {
            metric_id: args.metric_id,
            measurements,
            interval,
            filter: `greater-or-equal(datetime,${startDate}T00:00:00),less-than(datetime,${endDate}T23:59:59)`,
            timezone: 'America/New_York',
          },
        },
      });

      const attrs = data.data.attributes;
      return {
        metric_id: args.metric_id,
        interval,
        start_date: startDate,
        end_date: endDate,
        dates: attrs.dates,
        data: attrs.data,
      };
    }

    // ── get_profile ────────────────────────────────────────────────────────
    case 'get_profile': {
      const data = await klaviyo('GET', '/profiles/', null, {
        'filter': `equals(email,"${args.email}")`,
        'page[size]': 1,
        'additional-fields[profile]': 'subscriptions',
      });

      if (!data.data || data.data.length === 0) {
        return { found: false, email: args.email };
      }

      const p = data.data[0];
      return {
        found: true,
        id: p.id,
        email: p.attributes.email,
        first_name: p.attributes.first_name,
        last_name: p.attributes.last_name,
        phone_number: p.attributes.phone_number,
        location: p.attributes.location,
        subscriptions: p.attributes.subscriptions,
        properties: p.attributes.properties,
        created: p.attributes.created,
        updated: p.attributes.updated,
      };
    }

    // ── get_profile_events ─────────────────────────────────────────────────
    case 'get_profile_events': {
      const pageSize = Math.min(args.page_size || 25, 200);
      const data = await klaviyo('GET', '/events/', null, {
        'filter': `equals(relationships.profile.data.id,"${args.profile_id}")`,
        'sort': '-datetime',
        'page[size]': pageSize,
        'include': 'metric',
      });

      // Build metric name lookup from included resources
      const metricMap = {};
      if (data.included) {
        data.included.forEach(inc => {
          if (inc.type === 'metric') metricMap[inc.id] = inc.attributes.name;
        });
      }

      return {
        profile_id: args.profile_id,
        count: data.data.length,
        events: data.data.map(e => ({
          id: e.id,
          datetime: e.attributes.datetime,
          metric_name: metricMap[e.relationships?.metric?.data?.id] || e.relationships?.metric?.data?.id,
          properties: e.attributes.event_properties,
        })),
      };
    }

    // ── track_event ────────────────────────────────────────────────────────
    case 'track_event': {
      const payload = {
        data: {
          type: 'event',
          attributes: {
            profile: {
              data: {
                type: 'profile',
                attributes: { email: args.email },
              },
            },
            metric: {
              data: {
                type: 'metric',
                attributes: { name: args.event_name },
              },
            },
            properties: args.properties || {},
          },
        },
      };
      if (args.value !== undefined) {
        payload.data.attributes.value = args.value;
      }

      await klaviyo('POST', '/events/', payload);
      return {
        success: true,
        email: args.email,
        event: args.event_name,
        properties: args.properties || {},
      };
    }

    // ── get_events ─────────────────────────────────────────────────────────
    case 'get_events': {
      const pageSize = Math.min(args.page_size || 25, 200);
      const params = {
        'sort': '-datetime',
        'page[size]': pageSize,
        'include': 'metric,profile',
      };
      if (args.metric_id) {
        params['filter'] = `equals(relationships.metric.data.id,"${args.metric_id}")`;
      }

      const data = await klaviyo('GET', '/events/', null, params);

      const metricMap = {};
      const profileMap = {};
      if (data.included) {
        data.included.forEach(inc => {
          if (inc.type === 'metric') metricMap[inc.id] = inc.attributes.name;
          if (inc.type === 'profile') profileMap[inc.id] = inc.attributes.email;
        });
      }

      return {
        count: data.data.length,
        events: data.data.map(e => ({
          id: e.id,
          datetime: e.attributes.datetime,
          metric: metricMap[e.relationships?.metric?.data?.id] || e.relationships?.metric?.data?.id,
          profile_email: profileMap[e.relationships?.profile?.data?.id] || e.relationships?.profile?.data?.id,
          properties: e.attributes.event_properties,
        })),
      };
    }

    // ── list_campaigns ─────────────────────────────────────────────────────
    case 'list_campaigns': {
      const params = {
        'filter': 'equals(messages.channel,"email")',
        'sort': '-updated_at',
        'page[size]': 50,
      };
      const data = await klaviyo('GET', '/campaigns/', null, params);
      return {
        count: data.data.length,
        campaigns: data.data.map(c => ({
          id: c.id,
          name: c.attributes.name,
          status: c.attributes.status,
          send_time: c.attributes.send_time,
          created: c.attributes.created_at,
          updated: c.attributes.updated_at,
        })),
      };
    }

    // ── get_account_info ───────────────────────────────────────────────────
    case 'get_account_info': {
      const data = await klaviyo('GET', '/accounts/');
      const a = data.data[0];
      return {
        id: a.id,
        name: a.attributes.contact_information?.organization_name,
        email: a.attributes.contact_information?.email,
        timezone: a.attributes.timezone,
        currency: a.attributes.preferred_currency,
        industry: a.attributes.industry,
        public_api_key: a.attributes.public_api_key,
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ─── MCP SERVER SETUP ─────────────────────────────────────────────────────────

const server = new Server(
  { name: 'klaviyo-mcp', version: '1.0.0' },
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
    process.stderr.write(`[klaviyo-mcp] Error in tool "${name}": ${err.message}\n`);
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: err.message }, null, 2) }],
      isError: true,
    };
  }
});

// ─── START ────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write('[klaviyo-mcp] Ready\n');
