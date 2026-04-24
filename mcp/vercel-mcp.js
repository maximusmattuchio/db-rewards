#!/usr/bin/env node

/**
 * Vercel MCP Server — Dirty Bastard Laundry Co.
 *
 * Exposes Vercel REST API operations as MCP tools so Claude can manage
 * projects, deployments, environment variables, and domains directly in-chat.
 *
 * Tools:
 *   Projects     — list_projects, get_project
 *   Deployments  — list_deployments, get_deployment
 *   Env Vars     — list_env_vars, set_env_var
 *   Domains      — get_domain
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const VERCEL_TOKEN = process.env.VERCEL_TOKEN;
const VERCEL_TEAM_ID = process.env.VERCEL_TEAM_ID || null;
const BASE_URL = 'https://api.vercel.com';

if (!VERCEL_TOKEN) {
  process.stderr.write('[vercel-mcp] FATAL: VERCEL_TOKEN environment variable not set\n');
  process.exit(1);
}

// ─── VERCEL API CLIENT ────────────────────────────────────────────────────────

/**
 * Returns "&teamId=xxx" to append to query strings, or "" if no team is set.
 * Priority: explicit arg > VERCEL_TEAM_ID env var > none.
 */
function getTeamParam(args) {
  const teamId = (args && args.teamId) ? args.teamId : VERCEL_TEAM_ID;
  return teamId ? `&teamId=${encodeURIComponent(teamId)}` : '';
}

async function vercel(method, path, body = null, queryString = '') {
  const url = `${BASE_URL}${path}${queryString}`;

  const options = {
    method,
    headers: {
      'Authorization': `Bearer ${VERCEL_TOKEN}`,
      'Content-Type': 'application/json',
    },
  };

  if (body) options.body = JSON.stringify(body);

  const res = await fetch(url, options);
  const text = await res.text();

  if (!res.ok) {
    let detail = text;
    try {
      const parsed = JSON.parse(text);
      detail = JSON.stringify(parsed.error || parsed, null, 2);
    } catch {}
    throw new Error(`Vercel ${res.status} — ${method} ${path}\n${detail}`);
  }

  return text ? JSON.parse(text) : null;
}

// ─── TOOL DEFINITIONS ─────────────────────────────────────────────────────────

const TOOLS = [

  // ── PROJECTS ──────────────────────────────────────────────────────────────

  {
    name: 'list_projects',
    description: 'List all Vercel projects. Returns name, ID, framework, last updated time, latest deployment URL/state/createdAt, and linked git repository info.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Number of projects to return (default 20)',
        },
        teamId: {
          type: 'string',
          description: 'Vercel team ID or slug. Overrides VERCEL_TEAM_ID env var if provided.',
        },
      },
    },
  },

  {
    name: 'get_project',
    description: 'Get full details for a single Vercel project by name or ID. Returns framework, rootDirectory, buildCommand, outputDirectory, env var count, and git link info.',
    inputSchema: {
      type: 'object',
      properties: {
        project: {
          type: 'string',
          description: 'Project name or project ID',
        },
        teamId: {
          type: 'string',
          description: 'Vercel team ID or slug. Overrides VERCEL_TEAM_ID env var if provided.',
        },
      },
      required: ['project'],
    },
  },

  // ── DEPLOYMENTS ───────────────────────────────────────────────────────────

  {
    name: 'list_deployments',
    description: 'List recent Vercel deployments. Optionally filter by project, target (production/preview), and limit. Returns id, name, url, state (READY|ERROR|BUILDING|QUEUED|CANCELED), target, timestamps, and git commit info.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: {
          type: 'string',
          description: 'Filter by project ID or name',
        },
        limit: {
          type: 'number',
          description: 'Number of deployments to return (default 20)',
        },
        target: {
          type: 'string',
          enum: ['production', 'preview'],
          description: 'Filter by deployment target',
        },
        teamId: {
          type: 'string',
          description: 'Vercel team ID or slug. Overrides VERCEL_TEAM_ID env var if provided.',
        },
      },
    },
  },

  {
    name: 'get_deployment',
    description: 'Get full details for a single deployment by ID. Includes errorMessage if it failed, buildId, creator, and all meta fields including git commit info.',
    inputSchema: {
      type: 'object',
      properties: {
        deployment_id: {
          type: 'string',
          description: 'Vercel deployment ID (e.g. dpl_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx)',
        },
        teamId: {
          type: 'string',
          description: 'Vercel team ID or slug. Overrides VERCEL_TEAM_ID env var if provided.',
        },
      },
      required: ['deployment_id'],
    },
  },

  // ── ENV VARS ──────────────────────────────────────────────────────────────

  {
    name: 'list_env_vars',
    description: 'List environment variables for a Vercel project. Returns key names, type, and deployment targets — NEVER the actual values. Safe to use in any context.',
    inputSchema: {
      type: 'object',
      properties: {
        project: {
          type: 'string',
          description: 'Project name or project ID',
        },
        teamId: {
          type: 'string',
          description: 'Vercel team ID or slug. Overrides VERCEL_TEAM_ID env var if provided.',
        },
      },
      required: ['project'],
    },
  },

  {
    name: 'set_env_var',
    description: 'Create or update an environment variable on a Vercel project. Specify the key, value, type (plain or encrypted), and which targets (production, preview, development) it applies to.',
    inputSchema: {
      type: 'object',
      properties: {
        project: {
          type: 'string',
          description: 'Project name or project ID',
        },
        key: {
          type: 'string',
          description: 'Environment variable name (e.g. MY_API_KEY)',
        },
        value: {
          type: 'string',
          description: 'Environment variable value',
        },
        type: {
          type: 'string',
          enum: ['plain', 'encrypted'],
          description: 'Storage type: "plain" (readable) or "encrypted" (write-only after creation). Default: plain',
        },
        target: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['production', 'preview', 'development'],
          },
          description: 'Deployment targets this env var applies to. Default: ["production"]',
        },
        teamId: {
          type: 'string',
          description: 'Vercel team ID or slug. Overrides VERCEL_TEAM_ID env var if provided.',
        },
      },
      required: ['project', 'key', 'value'],
    },
  },

  // ── DOMAINS ───────────────────────────────────────────────────────────────

  {
    name: 'get_domain',
    description: 'Get details for a domain registered in Vercel. Returns name, service type, nameservers, verification status, expiry date, and SSL certificate status.',
    inputSchema: {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          description: 'Domain name (e.g. "getdirtybastard.com")',
        },
        teamId: {
          type: 'string',
          description: 'Vercel team ID or slug. Overrides VERCEL_TEAM_ID env var if provided.',
        },
      },
      required: ['domain'],
    },
  },
];

// ─── TOOL HANDLERS ────────────────────────────────────────────────────────────

async function handleTool(name, args) {
  switch (name) {

    // ── list_projects ───────────────────────────────────────────────────────
    case 'list_projects': {
      const limit = args.limit || 20;
      const teamParam = getTeamParam(args);
      const data = await vercel('GET', '/v9/projects', null, `?limit=${limit}${teamParam}`);

      return {
        count: data.projects.length,
        projects: data.projects.map(p => {
          const latest = p.latestDeployments && p.latestDeployments[0];
          return {
            id: p.id,
            name: p.name,
            framework: p.framework || null,
            updatedAt: p.updatedAt,
            latestDeployment: latest ? {
              url: latest.url,
              state: latest.state,
              createdAt: latest.createdAt,
            } : null,
            link: p.link ? {
              type: p.link.type,
              repo: p.link.repo || p.link.projectName || null,
              org: p.link.org || p.link.projectNamespace || null,
              repoId: p.link.repoId || null,
            } : null,
          };
        }),
      };
    }

    // ── get_project ─────────────────────────────────────────────────────────
    case 'get_project': {
      const teamParam = getTeamParam(args);
      const data = await vercel('GET', `/v9/projects/${encodeURIComponent(args.project)}`, null, teamParam ? `?${teamParam.slice(1)}` : '');

      return {
        id: data.id,
        name: data.name,
        framework: data.framework || null,
        rootDirectory: data.rootDirectory || null,
        buildCommand: data.buildCommand || null,
        outputDirectory: data.outputDirectory || null,
        devCommand: data.devCommand || null,
        installCommand: data.installCommand || null,
        nodeVersion: data.nodeVersion || null,
        createdAt: data.createdAt,
        updatedAt: data.updatedAt,
        link: data.link ? {
          type: data.link.type,
          repo: data.link.repo || data.link.projectName || null,
          org: data.link.org || data.link.projectNamespace || null,
          repoId: data.link.repoId || null,
          defaultBranch: data.link.defaultBranch || null,
          productionBranch: data.link.productionBranch || null,
        } : null,
        latestDeployments: data.latestDeployments
          ? data.latestDeployments.slice(0, 3).map(d => ({
              id: d.id,
              url: d.url,
              state: d.state,
              target: d.target,
              createdAt: d.createdAt,
            }))
          : [],
      };
    }

    // ── list_deployments ────────────────────────────────────────────────────
    case 'list_deployments': {
      const limit = args.limit || 20;
      const teamParam = getTeamParam(args);
      let qs = `?limit=${limit}${teamParam}`;
      if (args.projectId) qs += `&projectId=${encodeURIComponent(args.projectId)}`;
      if (args.target) qs += `&target=${encodeURIComponent(args.target)}`;

      const data = await vercel('GET', '/v6/deployments', null, qs);

      return {
        count: data.deployments.length,
        deployments: data.deployments.map(d => {
          // Trim git commit sha to first 7 chars and commit message to first line
          const sha = d.meta?.githubCommitSha || d.meta?.gitlabCommitSha || d.meta?.bitbucketCommitSha || null;
          const msg = d.meta?.githubCommitMessage || d.meta?.gitlabCommitMessage || d.meta?.bitbucketCommitMessage || null;

          return {
            id: d.uid,
            name: d.name,
            url: d.url,
            state: d.state,
            target: d.target || null,
            createdAt: d.createdAt,
            buildingAt: d.buildingAt || null,
            readyAt: d.ready || null,
            meta: {
              gitCommitSha: sha ? sha.slice(0, 7) : null,
              gitCommitMessage: msg ? msg.split('\n')[0] : null,
            },
          };
        }),
      };
    }

    // ── get_deployment ──────────────────────────────────────────────────────
    case 'get_deployment': {
      const teamParam = getTeamParam(args);
      const data = await vercel(
        'GET',
        `/v13/deployments/${encodeURIComponent(args.deployment_id)}`,
        null,
        teamParam ? `?${teamParam.slice(1)}` : ''
      );

      const sha = data.meta?.githubCommitSha || data.meta?.gitlabCommitSha || data.meta?.bitbucketCommitSha || null;
      const msg = data.meta?.githubCommitMessage || data.meta?.gitlabCommitMessage || data.meta?.bitbucketCommitMessage || null;

      return {
        id: data.id || data.uid,
        name: data.name,
        url: data.url,
        state: data.readyState || data.state,
        target: data.target || null,
        errorMessage: data.errorMessage || null,
        buildId: data.build?.id || null,
        createdAt: data.createdAt,
        buildingAt: data.buildingAt || null,
        readyAt: data.ready || null,
        creator: data.creator ? {
          uid: data.creator.uid,
          email: data.creator.email,
          username: data.creator.username,
        } : null,
        meta: {
          gitCommitSha: sha ? sha.slice(0, 7) : null,
          gitCommitMessage: msg ? msg.split('\n')[0] : null,
          ...Object.fromEntries(
            Object.entries(data.meta || {}).filter(([k]) =>
              !['githubCommitSha', 'gitlabCommitSha', 'bitbucketCommitSha',
                'githubCommitMessage', 'gitlabCommitMessage', 'bitbucketCommitMessage'].includes(k)
            )
          ),
        },
      };
    }

    // ── list_env_vars ───────────────────────────────────────────────────────
    case 'list_env_vars': {
      const teamParam = getTeamParam(args);
      const data = await vercel(
        'GET',
        `/v9/projects/${encodeURIComponent(args.project)}/env`,
        null,
        teamParam ? `?${teamParam.slice(1)}` : ''
      );

      // SECURITY: Explicitly strip 'value' and 'decrypted' fields from every env var
      // before returning. The Vercel API may return plaintext values for non-encrypted
      // vars — we never want these surfaced in chat history or logs.
      return {
        project: args.project,
        count: data.envs.length,
        envs: data.envs.map(e => ({
          id: e.id,
          key: e.key,
          type: e.type,
          target: e.target,
          gitBranch: e.gitBranch || null,
          createdAt: e.createdAt,
          updatedAt: e.updatedAt,
          // value and decrypted are intentionally omitted — never expose secrets
        })),
      };
    }

    // ── set_env_var ─────────────────────────────────────────────────────────
    case 'set_env_var': {
      const teamParam = getTeamParam(args);
      const type = args.type || 'plain';
      const target = args.target || ['production'];

      const body = {
        key: args.key,
        value: args.value,
        type,
        target,
      };

      const result = await vercel(
        'POST',
        `/v10/projects/${encodeURIComponent(args.project)}/env`,
        body,
        teamParam ? `?${teamParam.slice(1)}` : ''
      );

      return {
        success: true,
        id: result.id,
        key: result.key,
        type: result.type,
        target: result.target,
        createdAt: result.createdAt,
      };
    }

    // ── get_domain ──────────────────────────────────────────────────────────
    case 'get_domain': {
      const teamParam = getTeamParam(args);
      const data = await vercel(
        'GET',
        `/v5/domains/${encodeURIComponent(args.domain)}`,
        null,
        teamParam ? `?${teamParam.slice(1)}` : ''
      );

      const d = data.domain || data;

      return {
        name: d.name,
        serviceType: d.serviceType || null,
        nameservers: d.nameservers || [],
        intendedNameservers: d.intendedNameservers || [],
        verified: d.verified ?? null,
        expiresAt: d.expiresAt || null,
        createdAt: d.createdAt || null,
        updatedAt: d.updatedAt || null,
        boughtAt: d.boughtAt || null,
        transferredAt: d.transferredAt || null,
        ssl: d.ssl ? {
          id: d.ssl.id,
          autoRenew: d.ssl.autoRenew,
          expiresAt: d.ssl.expiresAt,
          issuedAt: d.ssl.issuedAt,
          pending: d.ssl.pending,
        } : null,
        cns: d.cns || null,
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ─── MCP SERVER SETUP ─────────────────────────────────────────────────────────

const server = new Server(
  { name: 'vercel-mcp', version: '1.0.0' },
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
    process.stderr.write(`[vercel-mcp] Error in tool "${name}": ${err.message}\n`);
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: err.message }, null, 2) }],
      isError: true,
    };
  }
});

// ─── START ────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write('[vercel-mcp] Ready\n');
