/**
 * resolve_project — Shared project_id / project_name resolution (issue #3, Part 2).
 *
 * Lets search_suite and list_test_cases accept a human project_name as an alternative to a
 * UUID, resolving name -> id in the MCP tool (no extra TCM endpoints beyond Part 1) via the
 * same GET /api/projects data that list_projects uses.
 *
 * Matching is case-insensitive EXACT on name; substring is used ONLY to build a helpful
 * candidate list for the AMBIGUOUS / NOT_FOUND message — never to silently pick a hit.
 */

import type { TcmClient } from '../client.js';
import type { McpError } from '../types.js';
import { fetchProjects } from './list_projects.js';

export interface ResolveProjectInput {
  project_id?: string;
  project_name?: string;
}

function candidateList(items: { project_id: string; name: string }[]): string {
  return items.map((p) => `${p.name} (${p.project_id})`).join(', ');
}

/**
 * Resolve to a concrete project_id, or return an McpError the caller can pass straight back.
 *
 * - project_id given -> used as-is (no lookup).
 * - project_name given -> case-insensitive exact match against visible projects:
 *     1 match  -> resolved;
 *     0 matches -> NOT_FOUND (with any substring near-matches as a hint);
 *     >1 match  -> AMBIGUOUS, listing candidate { name, project_id }.
 * - both / neither -> VALIDATION (callers also guard this via zod, but resolve defensively).
 */
export async function resolveProjectId(
  client: TcmClient,
  input: ResolveProjectInput,
): Promise<{ project_id: string } | McpError> {
  const projectId = input.project_id?.trim();
  const projectName = input.project_name?.trim();

  if (projectId && projectName) {
    return {
      error: {
        code: 'VALIDATION',
        message: 'Provide either project_id or project_name, not both.',
      },
    };
  }
  if (projectId) return { project_id: projectId };
  if (!projectName) {
    return {
      error: {
        code: 'VALIDATION',
        message: 'Provide a project_id or a project_name.',
      },
    };
  }

  // Fetch candidates (server-side ilike on name narrows the set; exact match happens here).
  const projects = await fetchProjects(client, { search: projectName, limit: 200 });
  if ('error' in projects) return projects;

  const needle = projectName.toLowerCase();
  const exact = projects.items.filter((p) => (p.name ?? '').toLowerCase() === needle);

  if (exact.length === 1) return { project_id: exact[0].project_id };

  if (exact.length > 1) {
    return {
      error: {
        code: 'AMBIGUOUS',
        message:
          `Multiple projects are named "${projectName}". Pass project_id instead. ` +
          `Candidates: ${candidateList(exact)}.`,
      },
    };
  }

  // No exact match — offer substring near-matches (if any) as a hint.
  const near = projects.items.filter((p) =>
    (p.name ?? '').toLowerCase().includes(needle),
  );
  const hint = near.length > 0 ? ` Did you mean: ${candidateList(near)}?` : '';
  return {
    error: {
      code: 'NOT_FOUND',
      message: `No project named "${projectName}".${hint}`,
    },
  };
}
