#!/usr/bin/env node
/**
 * TCM MCP Server — Epic 1: Test Case CRUD
 *
 * Stdio MCP server that gives AI agents (Torque, triage-e2e, Claude agents)
 * a stable tool interface to read and write TCM test cases.
 *
 * Architecture: thin client — all reads/writes proxy TCM REST endpoints.
 * Agents reference cases by display_id; UUIDs are never exposed.
 *
 * Tools:
 *   search_suite     — resolve a suite name/prefix to a suite reference
 *   list_suites      — enumerate every suite in a project (with group + test_case_count)
 *   list_projects    — discover visible projects (id + name)
 *   list_test_cases  — filterable lightweight list
 *   get_test_case    — full detail with steps
 *   create_test_case — dry-run → approval → commit create
 *   update_test_case — dry-run → approval → commit partial update (steps full-replace)
 *
 * Auth (OQ-2):
 *   CLUTCH_API_KEY   → X-Clutch-Key (headless/Torque path)
 *   TCM_USER_TOKEN   → Authorization: Bearer (interactive/Claude Code path)
 *   TCM_BASE_URL     → optional (defaults to the production TCM instance)
 *
 * Distribution: git URL, no npm publish. Pin by tag/commit for reproducibility.
 * See .mcp.json at repo root for Claude Code configuration.
 *
 * PRD: docs/features/mcp-e1-test-case-crud.md
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';

import { resolveAuthConfig } from './auth.js';
import { SessionExpiredError } from './token-provider.js';
import { TcmClient } from './client.js';
import { searchSuite } from './tools/search_suite.js';
import { listSuites } from './tools/list_suites.js';
import { listTestCases } from './tools/list_test_cases.js';
import { getTestCase } from './tools/get_test_case.js';
import { createTestCase } from './tools/create_test_case.js';
import { updateTestCase } from './tools/update_test_case.js';
import { listProjects } from './tools/list_projects.js';

// ─── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS: Tool[] = [
  {
    name: 'search_suite',
    description:
      'Resolve a suite name or prefix to a suite reference. ' +
      'Call this before create_test_case or list_test_cases to get the suite_id. ' +
      'Returns all matches so the caller can disambiguate if >1. ' +
      'To enumerate every suite in a project (no search term), use list_suites instead.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        project_id: {
          type: 'string',
          description: 'Project UUID. Provide this OR project_name (exactly one).',
        },
        project_name: {
          type: 'string',
          description:
            'Project name (case-insensitive exact match) as an alternative to project_id. ' +
            'Resolved to a UUID via list_projects; ambiguous/unknown names return an error.',
        },
        name_or_prefix: {
          type: 'string',
          description: 'Suite name or prefix to search (case-insensitive, substring match).',
        },
      },
      required: ['name_or_prefix'],
    },
  },
  {
    name: 'list_suites',
    description:
      'List every suite in a project (no search term). ' +
      'Each suite includes suite_id, name, prefix, group (role label the TCM sidebar groups on), ' +
      'and test_case_count. Provide project_id OR project_name (exactly one). ' +
      'An empty project returns []. Use search_suite to resolve a single suite by name/prefix.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        project_id: {
          type: 'string',
          description: 'Project UUID. Provide this OR project_name (exactly one).',
        },
        project_name: {
          type: 'string',
          description:
            'Project name (case-insensitive exact match) as an alternative to project_id. ' +
            'Resolved to a UUID via list_projects; ambiguous/unknown names return an error.',
        },
      },
      required: [],
    },
  },
  {
    name: 'list_test_cases',
    description:
      'List test cases with lightweight projection (display_id, title, automation_status, priority). ' +
      'Filterable by project, suite, or search term. Default limit 50, max 200.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        project_id: { type: 'string', description: 'Filter by project UUID (joins through suite).' },
        project_name: { type: 'string', description: 'Filter by project name (case-insensitive exact match) instead of project_id. Provide at most one of project_id / project_name.' },
        suite_id: { type: 'string', description: 'Filter by suite UUID.' },
        search: { type: 'string', description: 'ilike match on display_id or title.' },
        limit: { type: 'number', description: 'Max results (default 50, max 200).' },
      },
      required: [],
    },
  },
  {
    name: 'get_test_case',
    description:
      'Get full detail of a test case by display_id (e.g. "APA-3"), including all steps. ' +
      'Use this before update_test_case to review the current state.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        display_id: {
          type: 'string',
          description: 'Human-readable test case ID, e.g. "APA-3".',
        },
      },
      required: ['display_id'],
    },
  },
  {
    name: 'list_projects',
    description:
      'List the projects you can see (project_id + name). ' +
      'Call this to discover a project_id before search_suite or list_test_cases, ' +
      'or to resolve a project by name. Default limit 50, max 200.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        search: { type: 'string', description: 'Case-insensitive filter on project name.' },
        limit: { type: 'number', description: 'Max results (default 50, max 200).' },
      },
      required: [],
    },
  },
  {
    name: 'create_test_case',
    description:
      'Create a test case with steps. ' +
      'REQUIRED: call with dry_run: true first. Review the summary with a human. ' +
      'Only call with dry_run: false (or omit dry_run) after explicit human approval. ' +
      'Steps are required. display_id is assigned by TCM on commit.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        suite_id: { type: 'string', description: 'Suite UUID (from search_suite).' },
        title: { type: 'string', description: 'Test case title (1–500 chars).' },
        precondition: { type: 'string', description: 'Precondition text (optional).', nullable: true },
        description: { type: 'string', description: 'Description text (optional).', nullable: true },
        priority: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description: 'Priority (v1: low/medium/high only; critical deferred to v2).',
          nullable: true,
        },
        automation_status: {
          type: 'string',
          enum: ['not_automated', 'scripted', 'in_cicd', 'out_of_sync'],
          description: 'Default: not_automated.',
        },
        platform_tags: {
          type: 'array',
          items: { type: 'string', enum: ['desktop', 'tablet', 'mobile'] },
          description: 'Platform tags (constrained enum: desktop/tablet/mobile only).',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Free-form tags (each ≤50 chars).',
        },
        steps: {
          type: 'array',
          description: 'Test steps (required; step_number assigned by order, 1-based).',
          items: {
            type: 'object',
            properties: {
              description: { type: 'string', description: 'Step description (required).' },
              test_data: { type: 'string', description: 'Test data.', nullable: true },
              expected_result: { type: 'string', description: 'Expected result.', nullable: true },
              is_automation_only: { type: 'boolean', description: 'Automation-only step.' },
            },
            required: ['description'],
          },
        },
        dry_run: {
          type: 'boolean',
          description:
            'true → validate + return summary to caller, no write. ' +
            'false/omit → commit (only after human approval of a dry-run).',
        },
      },
      required: ['suite_id', 'title', 'steps'],
    },
  },
  {
    name: 'update_test_case',
    description:
      'Partially update an existing test case by display_id. ' +
      'If steps is provided, ALL existing steps are wiped and replaced (full-replace — not partial). ' +
      'REQUIRED: call with dry_run: true first. The dry-run shows the full before/after diff including steps. ' +
      'Only call with dry_run: false after explicit human approval.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        display_id: { type: 'string', description: 'Target test case display_id, e.g. "APA-3".' },
        title: { type: 'string', description: 'New title (optional).' },
        precondition: { type: 'string', description: 'New precondition (optional).', nullable: true },
        description: { type: 'string', description: 'New description (optional).', nullable: true },
        priority: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description: 'New priority (optional).',
          nullable: true,
        },
        automation_status: {
          type: 'string',
          enum: ['not_automated', 'scripted', 'in_cicd', 'out_of_sync'],
          description: 'New automation status (optional).',
        },
        platform_tags: {
          type: 'array',
          items: { type: 'string', enum: ['desktop', 'tablet', 'mobile'] },
          description: 'New platform tags (optional, replaces all).',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'New tags (optional, replaces all).',
        },
        steps: {
          type: 'array',
          description:
            'If provided: FULL REPLACE of ALL steps. Omit to leave steps unchanged.',
          items: {
            type: 'object',
            properties: {
              description: { type: 'string' },
              test_data: { type: 'string', nullable: true },
              expected_result: { type: 'string', nullable: true },
              is_automation_only: { type: 'boolean' },
            },
            required: ['description'],
          },
        },
        dry_run: {
          type: 'boolean',
          description:
            'true → compute diff + return to caller, no write. ' +
            'false/omit → commit (only after human approval).',
        },
      },
      required: ['display_id'],
    },
  },
];

const LOGIN_TOOL: Tool = {
  name: 'login',
  description:
    'Sign in to TCM. Opens a browser once for Google sign-in and stores a session that ' +
    'the server keeps refreshed. Call this if other tools report that you are not signed in. ' +
    'Takes up to a couple of minutes while you complete the browser login.',
  inputSchema: { type: 'object' as const, properties: {}, required: [] },
};

// ─── Server bootstrap ─────────────────────────────────────────────────────────

async function main() {
  const auth = resolveAuthConfig();
  const tcmClient = new TcmClient(auth);

  // Prime credentials at startup so we can report auth state — but do NOT exit when there
  // is no session yet: boot degraded so the `login` tool stays reachable (Claude Desktop
  // can't run a terminal command). Real tool calls return a clear "not signed in" error.
  let authed = true;
  try {
    await auth.headers();
  } catch (err) {
    if (err instanceof SessionExpiredError) {
      authed = false;
    } else {
      throw err;
    }
  }

  console.error(
    `[tcm-mcp] Starting. Mode: ${auth.mode}. Base URL: ${auth.baseUrl}.` +
      (authed ? '' : ' Not signed in yet — call the `login` tool.'),
  );

  const server = new Server(
    { name: 'tcm-mcp', version: '1.4.0' },
    { capabilities: { tools: {} } },
  );

  // Headless (clutch) callers don't need the interactive login tool; everyone else gets it.
  const toolList = auth.mode === 'clutch-key' ? TOOLS : [...TOOLS, LOGIN_TOOL];

  // List tools
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolList,
  }));

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const input = args as Record<string, unknown>;

    // Extract correlation ID from meta if provided by the calling agent
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const meta = (request.params as any)._meta as Record<string, unknown> | undefined;
    const correlationId = meta?.correlationId as string | undefined;

    let result: unknown;

    try {
      switch (name) {
        case 'search_suite':
          result = await searchSuite(tcmClient, input as Parameters<typeof searchSuite>[1]);
          break;

        case 'list_suites':
          result = await listSuites(tcmClient, input as Parameters<typeof listSuites>[1]);
          break;

        case 'list_test_cases':
          result = await listTestCases(tcmClient, input as Parameters<typeof listTestCases>[1]);
          break;

        case 'list_projects':
          result = await listProjects(tcmClient, input as Parameters<typeof listProjects>[1]);
          break;

        case 'get_test_case':
          result = await getTestCase(tcmClient, input as Parameters<typeof getTestCase>[1]);
          break;

        case 'create_test_case':
          result = await createTestCase(
            tcmClient,
            input as Parameters<typeof createTestCase>[1],
            correlationId,
          );
          break;

        case 'update_test_case':
          result = await updateTestCase(
            tcmClient,
            input as Parameters<typeof updateTestCase>[1],
            correlationId,
          );
          break;

        case 'login':
          result = await handleLoginTool(tcmClient);
          break;

        default:
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ error: { code: 'NOT_FOUND', message: `Unknown tool: ${name}` } }),
              },
            ],
            isError: true,
          };
      }
    } catch (err) {
      if (err instanceof SessionExpiredError) {
        result = { error: { code: 'NOT_AUTHENTICATED', message: (err as Error).message } };
      } else {
        throw err;
      }
    }

    const isError =
      result !== null &&
      typeof result === 'object' &&
      'error' in (result as object) &&
      (result as { error: unknown }).error !== undefined;

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(result, null, 2),
        },
      ],
      isError,
    };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('[tcm-mcp] Ready. Listening on stdio.');
}

/**
 * `login` subcommand: `npx github:JoinFullStackDev/tcm-mcp login` runs the interactive
 * login helper (scripts/login.mjs) without the user cloning the repo. It's a separate
 * process so Playwright (a dev-only, on-demand dependency) never loads in the server.
 */
function runLogin(): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { spawnSync } = require('node:child_process');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const nodePath = require('node:path');
  const script = nodePath.join(__dirname, '..', 'scripts', 'login.mjs');
  const res = spawnSync(process.execPath, [script], { stdio: 'inherit', env: process.env });
  process.exit(res.status ?? 1);
}

/** Run the login helper as a child process and capture its result (for the `login` tool). */
function runLoginProcess(): Promise<{ ok: boolean; message: string }> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { spawn } = require('node:child_process');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const nodePath = require('node:path');
  const script = nodePath.join(__dirname, '..', 'scripts', 'login.mjs');
  // GUI-launched clients (e.g. Claude Desktop on macOS) don't inherit the shell PATH, so
  // prepend node's own bin dir to help npm / npx / git resolve for the login helper.
  const binDir = nodePath.dirname(process.execPath);
  const env = {
    ...process.env,
    PATH: `${binDir}${nodePath.delimiter}${process.env.PATH ?? ''}`,
  };
  return new Promise((resolve) => {
    let stderr = '';
    const child = spawn(process.execPath, [script], { env });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', (e: Error) =>
      resolve({ ok: false, message: `Failed to start login: ${e.message}` }),
    );
    child.on('close', (code: number | null) => {
      const tail = stderr.trim().split('\n').slice(-8).join('\n');
      resolve({ ok: code === 0, message: tail });
    });
  });
}

/** `login` tool handler: run the browser login, then swap in the refreshing provider. */
async function handleLoginTool(client: TcmClient): Promise<unknown> {
  const outcome = await runLoginProcess();
  if (!outcome.ok) {
    return {
      error: {
        code: 'LOGIN_FAILED',
        message: outcome.message || 'Login did not complete.',
      },
    };
  }
  // The session file now exists — re-resolve auth and swap it into the live client.
  client.setAuth(resolveAuthConfig());
  return {
    ok: true,
    message: 'Signed in to TCM. All tools are now available.',
    detail: outcome.message,
  };
}

if (process.argv.slice(2).includes('login')) {
  runLogin();
} else {
  main().catch((err) => {
    console.error('[tcm-mcp] Fatal error:', err);
    process.exit(1);
  });
}
