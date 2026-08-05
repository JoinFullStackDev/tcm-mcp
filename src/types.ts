/**
 * Shared input/output types for the TCM MCP server.
 * All shapes match PRD §8 exactly.
 * Internal UUIDs are never exposed for test cases (only suite_id is returned).
 */

// ─── Enums ────────────────────────────────────────────────────────────────────

export type Priority = 'low' | 'medium' | 'high';
export type AutomationStatus = 'not_automated' | 'scripted' | 'in_cicd' | 'out_of_sync';
export type PlatformTag = 'desktop' | 'tablet' | 'mobile';

// ─── Suite ────────────────────────────────────────────────────────────────────

export interface SuiteRef {
  suite_id: string;
  name: string;
  prefix: string;
  project_id: string;
}

// ─── Steps ────────────────────────────────────────────────────────────────────

export interface StepInput {
  description: string;
  test_data?: string | null;
  expected_result?: string | null;
  is_automation_only?: boolean;
}

export interface Step extends StepInput {
  step_number: number;
  is_automation_only: boolean;
}

// ─── Tool Inputs ──────────────────────────────────────────────────────────────

export interface SearchSuiteInput {
  project_id: string;
  name_or_prefix: string;
}

export interface ListTestCasesInput {
  project_id?: string;
  suite_id?: string;
  search?: string;
  /** Default 50, max 200. Values >200 are clamped to 200. */
  limit?: number;
}

export interface GetTestCaseInput {
  display_id: string;
}

export interface CreateTestCaseInput {
  suite_id: string;
  title: string;
  precondition?: string | null;
  description?: string | null;
  priority?: Priority | null;
  automation_status?: AutomationStatus;
  platform_tags?: PlatformTag[];
  tags?: string[];
  steps: StepInput[];
  dry_run?: boolean;
}

export interface UpdateTestCaseInput {
  display_id: string;
  title?: string;
  precondition?: string | null;
  description?: string | null;
  priority?: Priority | null;
  automation_status?: AutomationStatus;
  platform_tags?: PlatformTag[];
  tags?: string[];
  /** If provided, wipes and replaces ALL existing steps (full-replace). */
  steps?: StepInput[];
  dry_run?: boolean;
}

// ─── Tool Outputs ─────────────────────────────────────────────────────────────

/** Lightweight list item — no steps, no UUIDs. */
export interface TestCaseListItem {
  display_id: string;
  title: string;
  automation_status: AutomationStatus;
  priority: Priority | null;
}

/** Full case detail with steps. */
export interface TestCaseDetail {
  display_id: string;
  suite: SuiteRef;
  title: string;
  precondition: string | null;
  description: string | null;
  priority: Priority | null;
  automation_status: AutomationStatus;
  type: string;
  platform_tags: PlatformTag[];
  tags: string[];
  steps: Step[];
  created_at: string;
  updated_at: string;
}

export interface ListTestCasesResult {
  items: TestCaseListItem[];
  total: number;
  has_more: boolean;
}

/** Dry-run result for create. */
export interface CreateDryRunResult {
  dry_run: true;
  would_create: Omit<CreateTestCaseInput, 'dry_run'> & { steps: Array<StepInput & { step_number: number }> };
  summary_markdown: string;
}

/** Field diff entry for update dry-run. */
export type FieldDiff = Record<string, { before: unknown; after: unknown }>;

/** Dry-run result for update. */
export interface UpdateDryRunResult {
  dry_run: true;
  display_id: string;
  diff: FieldDiff;
  steps_before: Step[];
  steps_after: Array<StepInput & { step_number: number }> | null;
  summary_markdown: string;
}

// ─── Error ────────────────────────────────────────────────────────────────────

export type ErrorCode = 'NOT_FOUND' | 'AMBIGUOUS' | 'VALIDATION' | 'IN_CICD_LOCKED' | 'AUTH_ERROR' | 'SERVER_ERROR';

export interface McpError {
  error: {
    code: ErrorCode;
    message: string;
  };
}
