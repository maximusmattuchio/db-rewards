#!/usr/bin/env node

/**
 * Shopify Admin API MCP Server — Dirty Bastard Laundry Co.
 *
 * Exposes Shopify Admin REST API operations as MCP tools so Claude can
 * manage orders, customers, products, and draft orders directly in-chat.
 *
 * Tools:
 *   Shop       — get_shop
 *   Orders     — list_orders, get_order
 *   Customers  — list_customers, search_customers, get_customer, update_customer_tags
 *   Products   — list_products, get_product
 *   Drafts     — list_draft_orders
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const SHOPIFY_ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;

if (!SHOPIFY_STORE) {
  process.stderr.write('[shopify-mcp] FATAL: SHOPIFY_STORE environment variable not set\n');
  process.exit(1);
}

if (!SHOPIFY_ADMIN_TOKEN) {
  process.stderr.write('[shopify-mcp] FATAL: SHOPIFY_ADMIN_TOKEN environment variable not set\n');
  process.exit(1);
}

const BASE_URL = `https://${SHOPIFY_STORE}/admin/api/2024-01`;

// ─── SHOPIFY API CLIENT ───────────────────────────────────────────────────────

/**
 * Make an authenticated request to the Shopify Admin REST API.
 * Builds query params from an object, filtering out null/undefined values.
 */
async function shopify(method, path, body = null, params = {}) {
  const url = new URL(`${BASE_URL}${path}`);

  // Append query params, skipping null/undefined
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') {
      url.searchParams.set(k, String(v));
    }
  });

  const options = {
    method,
    headers: {
      'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN,
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
    throw new Error(`Shopify ${res.status} — ${method} ${path}\n${detail}`);
  }

  return text ? JSON.parse(text) : null;
}

// ─── TOOL DEFINITIONS ─────────────────────────────────────────────────────────

const TOOLS = [

  // ── SHOP ──────────────────────────────────────────────────────────────────

  {
    name: 'get_shop',
    description: 'Get store information including name, email, currency, timezone, plan, and domain.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },

  // ── ORDERS ────────────────────────────────────────────────────────────────

  {
    name: 'list_orders',
    description: 'List orders from the store. Filter by status, email, or creation date. Returns order ID, number, email, financial status, fulfillment status, total price, and line item count.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          description: 'Order status filter. Default: "any". Options: open, closed, cancelled, any',
        },
        limit: {
          type: 'number',
          description: 'Number of orders to return (max 250, default 50)',
        },
        email: {
          type: 'string',
          description: 'Filter orders by customer email address',
        },
        created_at_min: {
          type: 'string',
          description: 'Return orders created after this ISO 8601 date (e.g. 2024-01-01T00:00:00Z)',
        },
      },
    },
  },

  {
    name: 'get_order',
    description: 'Get a full order by ID, including line items, shipping address, financial status, and fulfillment status.',
    inputSchema: {
      type: 'object',
      properties: {
        order_id: {
          type: 'string',
          description: 'Shopify order ID (numeric)',
        },
      },
      required: ['order_id'],
    },
  },

  // ── CUSTOMERS ─────────────────────────────────────────────────────────────

  {
    name: 'list_customers',
    description: 'List customers from the store. Returns id, email, name, orders_count, total_spent, tags, and created_at.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Number of customers to return (max 250, default 50)',
        },
        created_at_min: {
          type: 'string',
          description: 'Return customers created after this ISO 8601 date (e.g. 2024-01-01T00:00:00Z)',
        },
      },
    },
  },

  {
    name: 'search_customers',
    description: 'Search customers by query string. Supports field-specific queries like "email:test@example.com" or "first_name:John". Returns matching customers with summary fields.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query (e.g. "email:test@example.com", "John Smith", "tag:vip")',
        },
        limit: {
          type: 'number',
          description: 'Number of results to return (max 250, default 10)',
        },
      },
      required: ['query'],
    },
  },

  {
    name: 'get_customer',
    description: 'Get a full customer record by ID, including addresses, tags, orders_count, and total_spent.',
    inputSchema: {
      type: 'object',
      properties: {
        customer_id: {
          type: 'string',
          description: 'Shopify customer ID (numeric)',
        },
      },
      required: ['customer_id'],
    },
  },

  {
    name: 'update_customer_tags',
    description: 'Update tags on a customer. Use mode "replace" to set tags exactly, or "append" to add new tags to existing ones without removing any.',
    inputSchema: {
      type: 'object',
      properties: {
        customer_id: {
          type: 'string',
          description: 'Shopify customer ID (numeric)',
        },
        tags: {
          type: 'string',
          description: 'Comma-separated tag string (e.g. "vip, reward-tier-2, subscriber")',
        },
        mode: {
          type: 'string',
          enum: ['replace', 'append'],
          description: '"replace" sets tags to exactly this value; "append" merges with existing tags. Default: "replace"',
        },
      },
      required: ['customer_id', 'tags'],
    },
  },

  // ── PRODUCTS ──────────────────────────────────────────────────────────────

  {
    name: 'list_products',
    description: 'List products from the store. Returns id, title, handle, status, and a summary of variants with price, SKU, and inventory.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Number of products to return (max 250, default 50)',
        },
        status: {
          type: 'string',
          enum: ['active', 'draft', 'archived'],
          description: 'Filter by product status. Default: "active"',
        },
      },
    },
  },

  {
    name: 'get_product',
    description: 'Get a full product by ID, including all variants with prices, SKUs, and inventory quantities.',
    inputSchema: {
      type: 'object',
      properties: {
        product_id: {
          type: 'string',
          description: 'Shopify product ID (numeric)',
        },
      },
      required: ['product_id'],
    },
  },

  // ── DRAFT ORDERS ──────────────────────────────────────────────────────────

  {
    name: 'list_draft_orders',
    description: 'List draft orders (pending manual orders). Used for reward fulfillments that are manually processed. Returns id, name, email, status, total price, and line item count.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          description: 'Filter by status: open, invoice_sent, completed. Omit for all.',
        },
        limit: {
          type: 'number',
          description: 'Number of draft orders to return (max 250, default 50)',
        },
      },
    },
  },
];

// ─── TOOL HANDLERS ────────────────────────────────────────────────────────────

async function handleTool(name, args) {
  switch (name) {

    // ── get_shop ───────────────────────────────────────────────────────────
    case 'get_shop': {
      const data = await shopify('GET', '/shop.json');
      const s = data.shop;
      return {
        id: s.id,
        name: s.name,
        email: s.email,
        domain: s.domain,
        myshopify_domain: s.myshopify_domain,
        currency: s.currency,
        money_format: s.money_format,
        timezone: s.timezone,
        iana_timezone: s.iana_timezone,
        plan_name: s.plan_name,
        plan_display_name: s.plan_display_name,
        country_name: s.country_name,
        created_at: s.created_at,
      };
    }

    // ── list_orders ────────────────────────────────────────────────────────
    case 'list_orders': {
      const limit = Math.min(args.limit || 50, 250);
      const data = await shopify('GET', '/orders.json', null, {
        status: args.status || 'any',
        limit,
        email: args.email,
        created_at_min: args.created_at_min,
      });
      return {
        count: data.orders.length,
        orders: data.orders.map(o => ({
          id: o.id,
          order_number: o.order_number,
          name: o.name,
          email: o.email,
          financial_status: o.financial_status,
          fulfillment_status: o.fulfillment_status,
          total_price: o.total_price,
          currency: o.currency,
          line_items_count: o.line_items?.length || 0,
          customer_id: o.customer?.id,
          created_at: o.created_at,
          updated_at: o.updated_at,
        })),
      };
    }

    // ── get_order ──────────────────────────────────────────────────────────
    case 'get_order': {
      const data = await shopify('GET', `/orders/${args.order_id}.json`);
      const o = data.order;
      return {
        id: o.id,
        order_number: o.order_number,
        name: o.name,
        email: o.email,
        phone: o.phone,
        financial_status: o.financial_status,
        fulfillment_status: o.fulfillment_status,
        total_price: o.total_price,
        subtotal_price: o.subtotal_price,
        total_tax: o.total_tax,
        total_discounts: o.total_discounts,
        currency: o.currency,
        customer: o.customer ? {
          id: o.customer.id,
          email: o.customer.email,
          first_name: o.customer.first_name,
          last_name: o.customer.last_name,
          orders_count: o.customer.orders_count,
          total_spent: o.customer.total_spent,
        } : null,
        shipping_address: o.shipping_address,
        billing_address: o.billing_address,
        line_items: o.line_items?.map(li => ({
          id: li.id,
          title: li.title,
          variant_title: li.variant_title,
          sku: li.sku,
          quantity: li.quantity,
          price: li.price,
          product_id: li.product_id,
          variant_id: li.variant_id,
          fulfillment_status: li.fulfillment_status,
        })),
        fulfillments: o.fulfillments?.map(f => ({
          id: f.id,
          status: f.status,
          tracking_number: f.tracking_number,
          tracking_url: f.tracking_url,
          created_at: f.created_at,
        })),
        note: o.note,
        tags: o.tags,
        created_at: o.created_at,
        updated_at: o.updated_at,
        closed_at: o.closed_at,
        cancelled_at: o.cancelled_at,
      };
    }

    // ── list_customers ─────────────────────────────────────────────────────
    case 'list_customers': {
      const limit = Math.min(args.limit || 50, 250);
      const data = await shopify('GET', '/customers.json', null, {
        limit,
        created_at_min: args.created_at_min,
      });
      return {
        count: data.customers.length,
        customers: data.customers.map(c => ({
          id: c.id,
          email: c.email,
          first_name: c.first_name,
          last_name: c.last_name,
          orders_count: c.orders_count,
          total_spent: c.total_spent,
          tags: c.tags,
          verified_email: c.verified_email,
          created_at: c.created_at,
        })),
      };
    }

    // ── search_customers ───────────────────────────────────────────────────
    case 'search_customers': {
      const limit = Math.min(args.limit || 10, 250);
      const data = await shopify('GET', '/customers/search.json', null, {
        query: args.query,
        limit,
      });
      return {
        count: data.customers.length,
        customers: data.customers.map(c => ({
          id: c.id,
          email: c.email,
          first_name: c.first_name,
          last_name: c.last_name,
          orders_count: c.orders_count,
          total_spent: c.total_spent,
          tags: c.tags,
          verified_email: c.verified_email,
          created_at: c.created_at,
        })),
      };
    }

    // ── get_customer ───────────────────────────────────────────────────────
    case 'get_customer': {
      const data = await shopify('GET', `/customers/${args.customer_id}.json`);
      const c = data.customer;
      return {
        id: c.id,
        email: c.email,
        first_name: c.first_name,
        last_name: c.last_name,
        phone: c.phone,
        orders_count: c.orders_count,
        total_spent: c.total_spent,
        tags: c.tags,
        note: c.note,
        verified_email: c.verified_email,
        accepts_marketing: c.accepts_marketing,
        accepts_marketing_updated_at: c.accepts_marketing_updated_at,
        tax_exempt: c.tax_exempt,
        state: c.state,
        currency: c.currency,
        addresses: c.addresses?.map(a => ({
          id: a.id,
          address1: a.address1,
          address2: a.address2,
          city: a.city,
          province: a.province,
          country: a.country,
          zip: a.zip,
          default: a.default,
        })),
        default_address: c.default_address,
        last_order_id: c.last_order_id,
        last_order_name: c.last_order_name,
        created_at: c.created_at,
        updated_at: c.updated_at,
      };
    }

    // ── update_customer_tags ───────────────────────────────────────────────
    case 'update_customer_tags': {
      const mode = args.mode || 'replace';
      let finalTags = args.tags;

      // In append mode, fetch current tags first and merge
      if (mode === 'append') {
        const existing = await shopify('GET', `/customers/${args.customer_id}.json`);
        const currentTags = existing.customer.tags || '';

        // Split both tag strings, trim whitespace, deduplicate, rejoin
        const currentSet = new Set(
          currentTags.split(',').map(t => t.trim()).filter(Boolean)
        );
        const newTags = args.tags.split(',').map(t => t.trim()).filter(Boolean);
        newTags.forEach(t => currentSet.add(t));
        finalTags = Array.from(currentSet).join(', ');
      }

      const data = await shopify('PUT', `/customers/${args.customer_id}.json`, {
        customer: {
          id: Number(args.customer_id),
          tags: finalTags,
        },
      });

      const c = data.customer;
      return {
        success: true,
        customer_id: c.id,
        email: c.email,
        tags: c.tags,
        mode,
      };
    }

    // ── list_products ──────────────────────────────────────────────────────
    case 'list_products': {
      const limit = Math.min(args.limit || 50, 250);
      const data = await shopify('GET', '/products.json', null, {
        limit,
        status: args.status || 'active',
      });
      return {
        count: data.products.length,
        products: data.products.map(p => ({
          id: p.id,
          title: p.title,
          handle: p.handle,
          status: p.status,
          product_type: p.product_type,
          vendor: p.vendor,
          tags: p.tags,
          variants: p.variants?.map(v => ({
            id: v.id,
            title: v.title,
            price: v.price,
            sku: v.sku,
            inventory_quantity: v.inventory_quantity,
            inventory_management: v.inventory_management,
          })),
          created_at: p.created_at,
          updated_at: p.updated_at,
        })),
      };
    }

    // ── get_product ────────────────────────────────────────────────────────
    case 'get_product': {
      const data = await shopify('GET', `/products/${args.product_id}.json`);
      const p = data.product;
      return {
        id: p.id,
        title: p.title,
        handle: p.handle,
        body_html: p.body_html,
        status: p.status,
        product_type: p.product_type,
        vendor: p.vendor,
        tags: p.tags,
        variants: p.variants?.map(v => ({
          id: v.id,
          title: v.title,
          price: v.price,
          compare_at_price: v.compare_at_price,
          sku: v.sku,
          barcode: v.barcode,
          inventory_quantity: v.inventory_quantity,
          inventory_management: v.inventory_management,
          inventory_policy: v.inventory_policy,
          weight: v.weight,
          weight_unit: v.weight_unit,
          requires_shipping: v.requires_shipping,
          taxable: v.taxable,
          option1: v.option1,
          option2: v.option2,
          option3: v.option3,
          created_at: v.created_at,
          updated_at: v.updated_at,
        })),
        options: p.options,
        images: p.images?.map(img => ({
          id: img.id,
          src: img.src,
          alt: img.alt,
          position: img.position,
        })),
        created_at: p.created_at,
        updated_at: p.updated_at,
        published_at: p.published_at,
      };
    }

    // ── list_draft_orders ──────────────────────────────────────────────────
    case 'list_draft_orders': {
      const limit = Math.min(args.limit || 50, 250);
      const data = await shopify('GET', '/draft_orders.json', null, {
        limit,
        status: args.status,
      });
      return {
        count: data.draft_orders.length,
        draft_orders: data.draft_orders.map(d => ({
          id: d.id,
          name: d.name,
          status: d.status,
          email: d.email,
          total_price: d.total_price,
          subtotal_price: d.subtotal_price,
          currency: d.currency,
          customer: d.customer ? {
            id: d.customer.id,
            email: d.customer.email,
            first_name: d.customer.first_name,
            last_name: d.customer.last_name,
          } : null,
          line_items_count: d.line_items?.length || 0,
          line_items: d.line_items?.map(li => ({
            title: li.title,
            variant_title: li.variant_title,
            sku: li.sku,
            quantity: li.quantity,
            price: li.price,
          })),
          note: d.note,
          tags: d.tags,
          invoice_sent_at: d.invoice_sent_at,
          invoice_url: d.invoice_url,
          created_at: d.created_at,
          updated_at: d.updated_at,
          completed_at: d.completed_at,
        })),
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ─── MCP SERVER SETUP ─────────────────────────────────────────────────────────

const server = new Server(
  { name: 'shopify-mcp', version: '1.0.0' },
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
    process.stderr.write(`[shopify-mcp] Error in tool "${name}": ${err.message}\n`);
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: err.message }, null, 2) }],
      isError: true,
    };
  }
});

// ─── START ────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write('[shopify-mcp] Ready\n');
