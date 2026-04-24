#!/usr/bin/env node

/**
 * GitHub MCP Server — Dirty Bastard Laundry Co.
 *
 * Exposes GitHub REST API operations as MCP tools so Claude can inspect
 * repositories, commits, workflow runs, issues, and file contents directly
 * in-chat.
 *
 * Tools:
 *   Repos     — list_repos, get_repo
 *   Commits   — list_commits
 *   Actions   — list_workflow_runs, get_workflow_run
 *   Issues    — list_issues, create_issue
 *   Files     — get_file_content
 *
 * Known repos: db-monitor, shopify_theme
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const BASE_URL = 'https://api.github.com';
const DEFAULT_OWNER = 'maximusmattuchio';

if (!GITHUB_TOKEN) {
  process.stderr.write('[github-mcp] FATAL: GITHUB_TOKEN environment variable not set\n');
  process.exit(1);
}

// ─── GITHUB API CLIENT ────────────────────────────────────────────────────────

async function github(method, path, body = null, params = {}) {
  const url = new URL(`${BASE_URL}${path}`);

  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') {
      url.searchParams.set(k, String(v));
    }
  });

  const options = {
    method,
    headers: {
      'Authorization': `Bearer ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'dirty-bastard-mcp/1.0',
    },
  };

  if (body) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  const res = await fetch(url.toString(), options);
  const text = await res.text();

  if (!res.ok) {
    let detail = text;
    try {
      const parsed = JSON.parse(text);
      detail = parsed.message || JSON.stringify(parsed, null, 2);
    } catch {}
    throw new Error(`GitHub ${res.status} — ${method} ${path}\n${detail}`);
  }

  return text ? JSON.parse(text) : null;
}

// ─── TOOL DEFINITIONS ─────────────────────────────────────────────────────────

const TOOLS = [

  // ── REPOS ─────────────────────────────────────────────────────────────────

  {
    name: 'list_repos',
    description: `List repositories for a GitHub user or org. Defaults to ${DEFAULT_OWNER}. Known repos include db-monitor and shopify_theme. Returns name, description, URL, default branch, visibility, last push time, open issue count, and language.`,
    inputSchema: {
      type: 'object',
      properties: {
        owner: {
          type: 'string',
          description: `GitHub username or org name (default: ${DEFAULT_OWNER})`,
        },
        type: {
          type: 'string',
          enum: ['all', 'owner', 'public'],
          description: 'Filter repos by type (default: owner)',
        },
        sort: {
          type: 'string',
          enum: ['updated', 'created', 'pushed'],
          description: 'Sort field (default: pushed)',
        },
        per_page: {
          type: 'number',
          description: 'Results per page (default: 30)',
        },
      },
    },
  },

  {
    name: 'get_repo',
    description: `Get full details for a single repository, including topics, license, and star count. Owner defaults to ${DEFAULT_OWNER}. Known repos: db-monitor, shopify_theme.`,
    inputSchema: {
      type: 'object',
      properties: {
        owner: {
          type: 'string',
          description: `Repository owner (default: ${DEFAULT_OWNER})`,
        },
        repo: {
          type: 'string',
          description: 'Repository name (e.g. db-monitor, shopify_theme)',
        },
      },
      required: ['repo'],
    },
  },

  // ── COMMITS ───────────────────────────────────────────────────────────────

  {
    name: 'list_commits',
    description: `List recent commits for a repository. Owner defaults to ${DEFAULT_OWNER}. Known repos: db-monitor, shopify_theme. Returns abbreviated SHA, first line of commit message, author name, and date.`,
    inputSchema: {
      type: 'object',
      properties: {
        owner: {
          type: 'string',
          description: `Repository owner (default: ${DEFAULT_OWNER})`,
        },
        repo: {
          type: 'string',
          description: 'Repository name (e.g. db-monitor, shopify_theme)',
        },
        branch: {
          type: 'string',
          description: 'Branch name to list commits from (default: repo default branch)',
        },
        per_page: {
          type: 'number',
          description: 'Number of commits to return (default: 20)',
        },
        since: {
          type: 'string',
          description: 'Only return commits after this ISO 8601 date (e.g. 2024-01-01T00:00:00Z)',
        },
      },
      required: ['repo'],
    },
  },

  // ── ACTIONS ───────────────────────────────────────────────────────────────

  {
    name: 'list_workflow_runs',
    description: `List recent GitHub Actions workflow runs for a repository. Owner defaults to ${DEFAULT_OWNER}. Known repos: db-monitor, shopify_theme. Returns run ID, workflow name, status, conclusion, trigger event, creation time, URL, and head commit message.`,
    inputSchema: {
      type: 'object',
      properties: {
        owner: {
          type: 'string',
          description: `Repository owner (default: ${DEFAULT_OWNER})`,
        },
        repo: {
          type: 'string',
          description: 'Repository name (e.g. db-monitor, shopify_theme)',
        },
        status: {
          type: 'string',
          enum: ['completed', 'success', 'failure', 'in_progress'],
          description: 'Filter by run status',
        },
        per_page: {
          type: 'number',
          description: 'Number of runs to return (default: 20)',
        },
      },
      required: ['repo'],
    },
  },

  {
    name: 'get_workflow_run',
    description: `Get full details for a single GitHub Actions workflow run by run ID, including a jobs_url for drilling down into individual job logs.`,
    inputSchema: {
      type: 'object',
      properties: {
        owner: {
          type: 'string',
          description: `Repository owner (default: ${DEFAULT_OWNER})`,
        },
        repo: {
          type: 'string',
          description: 'Repository name',
        },
        run_id: {
          type: 'number',
          description: 'Workflow run ID (from list_workflow_runs)',
        },
      },
      required: ['repo', 'run_id'],
    },
  },

  // ── ISSUES ────────────────────────────────────────────────────────────────

  {
    name: 'list_issues',
    description: `List issues for a repository. Owner defaults to ${DEFAULT_OWNER}. Known repos: db-monitor, shopify_theme. Returns issue number, title, state, labels, creation date, URL, and author login.`,
    inputSchema: {
      type: 'object',
      properties: {
        owner: {
          type: 'string',
          description: `Repository owner (default: ${DEFAULT_OWNER})`,
        },
        repo: {
          type: 'string',
          description: 'Repository name (e.g. db-monitor, shopify_theme)',
        },
        state: {
          type: 'string',
          enum: ['open', 'closed', 'all'],
          description: 'Filter by issue state (default: open)',
        },
        labels: {
          type: 'string',
          description: 'Comma-separated list of label names to filter by (e.g. "bug,enhancement")',
        },
        per_page: {
          type: 'number',
          description: 'Number of issues to return (default: 20)',
        },
      },
      required: ['repo'],
    },
  },

  {
    name: 'create_issue',
    description: `Create a new issue in a repository. Owner defaults to ${DEFAULT_OWNER}. Returns the new issue number and URL.`,
    inputSchema: {
      type: 'object',
      properties: {
        owner: {
          type: 'string',
          description: `Repository owner (default: ${DEFAULT_OWNER})`,
        },
        repo: {
          type: 'string',
          description: 'Repository name (e.g. db-monitor, shopify_theme)',
        },
        title: {
          type: 'string',
          description: 'Issue title',
        },
        body: {
          type: 'string',
          description: 'Issue body / description (markdown supported)',
        },
        labels: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of label names to apply to the issue',
        },
      },
      required: ['repo', 'title'],
    },
  },

  // ── FILES ─────────────────────────────────────────────────────────────────

  {
    name: 'get_file_content',
    description: `Get the decoded text content of a file from a GitHub repository. Owner defaults to ${DEFAULT_OWNER}. Known repos: db-monitor, shopify_theme. Content is truncated to 10,000 characters if the file is larger. Returns path, content, size, SHA, and URL.`,
    inputSchema: {
      type: 'object',
      properties: {
        owner: {
          type: 'string',
          description: `Repository owner (default: ${DEFAULT_OWNER})`,
        },
        repo: {
          type: 'string',
          description: 'Repository name (e.g. db-monitor, shopify_theme)',
        },
        path: {
          type: 'string',
          description: 'File path within the repository (e.g. src/index.js, package.json)',
        },
        ref: {
          type: 'string',
          description: 'Branch name, tag, or commit SHA to read from (default: repo default branch)',
        },
      },
      required: ['repo', 'path'],
    },
  },
];

// ─── TOOL HANDLERS ────────────────────────────────────────────────────────────

async function handleTool(name, args) {
  switch (name) {

    // ── list_repos ─────────────────────────────────────────────────────────
    case 'list_repos': {
      const owner = args.owner || DEFAULT_OWNER;
      const params = {
        type: args.type || 'owner',
        sort: args.sort || 'pushed',
        per_page: args.per_page || 30,
      };
      // Try user endpoint first; fall back to org endpoint on 404
      let data;
      try {
        data = await github('GET', `/users/${owner}/repos`, null, params);
      } catch (err) {
        if (err.message.includes('404')) {
          data = await github('GET', `/orgs/${owner}/repos`, null, params);
        } else {
          throw err;
        }
      }
      return {
        owner,
        count: data.length,
        repos: data.map(r => ({
          name: r.name,
          description: r.description,
          html_url: r.html_url,
          default_branch: r.default_branch,
          visibility: r.visibility,
          pushed_at: r.pushed_at,
          open_issues_count: r.open_issues_count,
          language: r.language,
        })),
      };
    }

    // ── get_repo ───────────────────────────────────────────────────────────
    case 'get_repo': {
      const owner = args.owner || DEFAULT_OWNER;
      const data = await github('GET', `/repos/${owner}/${args.repo}`);
      return {
        name: data.name,
        full_name: data.full_name,
        description: data.description,
        html_url: data.html_url,
        default_branch: data.default_branch,
        visibility: data.visibility,
        language: data.language,
        topics: data.topics || [],
        license: data.license?.name || null,
        stargazers_count: data.stargazers_count,
        forks_count: data.forks_count,
        open_issues_count: data.open_issues_count,
        pushed_at: data.pushed_at,
        created_at: data.created_at,
        updated_at: data.updated_at,
        clone_url: data.clone_url,
        size_kb: data.size,
      };
    }

    // ── list_commits ───────────────────────────────────────────────────────
    case 'list_commits': {
      const owner = args.owner || DEFAULT_OWNER;
      const params = {
        per_page: args.per_page || 20,
      };
      if (args.branch) params.sha = args.branch;
      if (args.since) params.since = args.since;

      const data = await github('GET', `/repos/${owner}/${args.repo}/commits`, null, params);
      return {
        repo: `${owner}/${args.repo}`,
        branch: args.branch || '(default)',
        count: data.length,
        commits: data.map(c => ({
          sha: c.sha.slice(0, 7),
          message: c.commit.message.split('\n')[0],
          author: c.commit.author.name,
          date: c.commit.author.date,
        })),
      };
    }

    // ── list_workflow_runs ─────────────────────────────────────────────────
    case 'list_workflow_runs': {
      const owner = args.owner || DEFAULT_OWNER;
      const params = {
        per_page: args.per_page || 20,
      };
      if (args.status) params.status = args.status;

      const data = await github('GET', `/repos/${owner}/${args.repo}/actions/runs`, null, params);
      return {
        repo: `${owner}/${args.repo}`,
        total_count: data.total_count,
        count: data.workflow_runs.length,
        runs: data.workflow_runs.map(r => ({
          id: r.id,
          name: r.name,
          status: r.status,
          conclusion: r.conclusion,
          event: r.event,
          created_at: r.created_at,
          html_url: r.html_url,
          head_commit_message: r.head_commit?.message?.split('\n')[0] || null,
        })),
      };
    }

    // ── get_workflow_run ───────────────────────────────────────────────────
    case 'get_workflow_run': {
      const owner = args.owner || DEFAULT_OWNER;
      const data = await github('GET', `/repos/${owner}/${args.repo}/actions/runs/${args.run_id}`);
      return {
        id: data.id,
        name: data.name,
        workflow_id: data.workflow_id,
        run_number: data.run_number,
        status: data.status,
        conclusion: data.conclusion,
        event: data.event,
        display_title: data.display_title,
        head_branch: data.head_branch,
        head_sha: data.head_sha?.slice(0, 7),
        head_commit_message: data.head_commit?.message?.split('\n')[0] || null,
        head_commit_author: data.head_commit?.author?.name || null,
        created_at: data.created_at,
        updated_at: data.updated_at,
        run_started_at: data.run_started_at,
        html_url: data.html_url,
        jobs_url: data.jobs_url,
        logs_url: data.logs_url,
        run_attempt: data.run_attempt,
        actor: data.actor?.login || null,
        triggering_actor: data.triggering_actor?.login || null,
      };
    }

    // ── list_issues ────────────────────────────────────────────────────────
    case 'list_issues': {
      const owner = args.owner || DEFAULT_OWNER;
      const params = {
        state: args.state || 'open',
        per_page: args.per_page || 20,
      };
      if (args.labels) params.labels = args.labels;

      const data = await github('GET', `/repos/${owner}/${args.repo}/issues`, null, params);
      // GitHub issues endpoint also returns pull requests — filter them out
      const issues = data.filter(i => !i.pull_request);
      return {
        repo: `${owner}/${args.repo}`,
        state: params.state,
        count: issues.length,
        issues: issues.map(i => ({
          number: i.number,
          title: i.title,
          state: i.state,
          labels: i.labels.map(l => l.name),
          created_at: i.created_at,
          html_url: i.html_url,
          user: i.user?.login || null,
        })),
      };
    }

    // ── create_issue ───────────────────────────────────────────────────────
    case 'create_issue': {
      const owner = args.owner || DEFAULT_OWNER;
      const body = { title: args.title };
      if (args.body) body.body = args.body;
      if (args.labels && args.labels.length > 0) body.labels = args.labels;

      const data = await github('POST', `/repos/${owner}/${args.repo}/issues`, body);
      return {
        success: true,
        number: data.number,
        html_url: data.html_url,
        title: data.title,
        state: data.state,
        created_at: data.created_at,
      };
    }

    // ── get_file_content ───────────────────────────────────────────────────
    case 'get_file_content': {
      const owner = args.owner || DEFAULT_OWNER;
      const params = {};
      if (args.ref) params.ref = args.ref;

      const data = await github('GET', `/repos/${owner}/${args.repo}/contents/${args.path}`, null, params);

      if (data.type !== 'file') {
        throw new Error(`Path "${args.path}" is a ${data.type}, not a file. Use a direct file path.`);
      }

      const raw = Buffer.from(data.content, 'base64').toString('utf8');
      const TRUNCATE_LIMIT = 10000;
      const truncated = raw.length > TRUNCATE_LIMIT;
      const content = truncated ? raw.slice(0, TRUNCATE_LIMIT) : raw;

      return {
        path: data.path,
        content,
        truncated,
        note: truncated ? `Content truncated to ${TRUNCATE_LIMIT} characters (full file is ${data.size} bytes)` : undefined,
        encoding: data.encoding,
        size: data.size,
        sha: data.sha,
        html_url: data.html_url,
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ─── MCP SERVER SETUP ─────────────────────────────────────────────────────────

const server = new Server(
  { name: 'github-mcp', version: '1.0.0' },
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
    process.stderr.write(`[github-mcp] Error in tool "${name}": ${err.message}\n`);
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: err.message }, null, 2) }],
      isError: true,
    };
  }
});

// ─── START ────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write('[github-mcp] Ready\n');
