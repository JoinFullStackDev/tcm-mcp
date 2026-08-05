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
 *   list_test_cases  — filterable lightweight list
 *   get_test_case    — full detail with steps
 *   create_test_case — dry-run → approval → commit create
 *   update_test_case — dry-run → approval → commit partial update (steps full-replace)
 *
 * Auth (OQ-2):
 *   CLUTCH_API_KEY   → X-Clutch-Key (headless/Torque path)
 *   TCM_USER_TOKEN   → Authorization: Bearer (interactive/Claude Code path)
 *   TCM_BASE_URL     → required
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
import { TcmClient } from './client.js';
import { searchSuite } from './tools/search_suite.js';
import { listTestCases } from './tools/list_test_cases.js';
import { getTestCase } from './tools/get_test_case.js';
import { createTestCase } from './tools/create_test_case.js';
import { updateTestCase } from './tools/update_test_case.js';

// ─── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS: Tool[] = [
  {
    name: 'search_suite',
    description:
      'Resolve a suite name or prefix to a suite reference. ' +
      'Call this before create_test_case or list_test_cases to get the suite_id. ' +
      'Returns all matches so the caller can disambiguate if >1.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        project_id: {
          type: 'string',
          description: 'Project UUID. Scopes the search (prefix is only unique per project).',
        },
        name_or_prefix: {
          type: 'string',
          description: 'Suite name or prefix to search (case-insensitive, substring match).',
        },
      },
      required: ['project_id', 'name_or_prefix'],
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

// ─── Server bootstrap ─────────────────────────────────────────────────────────

async function main() {
  const auth = resolveAuthConfig();
  const tcmClient = new TcmClient(auth);

  console.error(`[tcm-mcp] Starting. Mode: ${auth.mode}. Base URL: ${auth.baseUrl}`);

  const server = new Server(
    { name: 'tcm-mcp', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  // List tools
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
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

    switch (name) {
      case 'search_suite':
        result = await searchSuite(tcmClient, input as Parameters<typeof searchSuite>[1]);
        break;

      case 'list_test_cases':
        result = await listTestCases(tcmClient, input as Parameters<typeof listTestCases>[1]);
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

main().catch((err) => {
  console.error('[tcm-mcp] Fatal error:', err);
  process.exit(1);
});
