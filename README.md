# tcm-mcp — TCM MCP Server (Epic 1: Test Case CRUD)

A stdio [MCP](https://modelcontextprotocol.io) server that gives AI agents (Torque, triage-e2e, Claude agents) a stable tool interface to read and write **TCM** test cases — without touching the database schema directly.

It is a **thin client**: every tool call proxies a TCM REST endpoint. ID resolution, validation, `display_id` generation, the `in_cicd` lock, and soft-delete scoping all happen inside TCM. Agents reference cases by **`display_id`** (e.g. `APA-3`); internal UUIDs are never exposed.

Full design: [`docs/features/mcp-e1-test-case-crud.md`](https://github.com/JoinFullStackDev/TCM/blob/main/docs/features/mcp-e1-test-case-crud.md) (in the main TCM repo).

## Tools

| Tool               | Purpose                                                                                                    |
| ------------------ | ---------------------------------------------------------------------------------------------------------- |
| `search_suite`     | Resolve a suite name/prefix → `suite_id`. Call before the case tools.                                      |
| `list_test_cases`  | Lightweight filterable list (`display_id`, `title`, `automation_status`, `priority`). Default 50, max 200. |
| `get_test_case`    | Full detail + steps, by `display_id`.                                                                      |
| `create_test_case` | Create a case with steps — **dry-run → approval → commit** (see below).                                    |
| `update_test_case` | Partial update; steps are **full-replace** when provided — same dry-run flow.                              |

Reads exclude trashed (soft-deleted) cases. Writes require the dry-run flow.

## Requirements

- **Node.js ≥ 18** (for `npx` and the global `fetch`).
- **Git read access** to `JoinFullStackDev/TCM` — the package is distributed by **git URL, not published to npm**. On headless hosts (OpenClaw/Torque) a git token must be present in the environment.
- A reachable **TCM instance URL** and an **auth credential** (below).

Because it's distributed by git URL, `npx` clones the repo and **builds from source on first run** (via the package's `prepare` → `tsc` step), so the first launch is slower. Subsequent runs are cached.

## Install (Claude Code)

Add an entry to your `.mcp.json` (project-level, or `~/.claude/.mcp.json`). Interactive / user-token setup:

```jsonc
{
  "mcpServers": {
    "tcm": {
      "command": "npx",
      "args": ["--yes", "github:JoinFullStackDev/tcm-mcp#v1.0.0", "--stdio"],
      "env": {
        "TCM_BASE_URL": "https://your-tcm-instance.example.com",
        "TCM_USER_TOKEN": "${TCM_USER_TOKEN}",
      },
    },
  },
}
```

> **Pin to a tag or commit** (`#v1.0.0`), **not a branch** — a branch ref re-resolves on every launch and can trip Claude Code's 30s MCP startup timeout. Set `TCM_BASE_URL` to your real TCM instance, not a preview alias. `TCM_USER_TOKEN` must be present in the environment that launches your MCP client (it's passed to the server as `${TCM_USER_TOKEN}`); a Supabase JWT expires ~1h — see below.

## Auth modes

The server picks its mode from environment variables. **If both are set, `CLUTCH_API_KEY` wins** (it is checked first).

| Mode                         | Set              | Sends                         | Use for                        | Attribution                                   |
| ---------------------------- | ---------------- | ----------------------------- | ------------------------------ | --------------------------------------------- |
| **User token** (interactive) | `TCM_USER_TOKEN` | `Authorization: Bearer <jwt>` | Claude Code, human in the loop | The real user (their Supabase JWT)            |
| **Clutch key** (headless)    | `CLUTCH_API_KEY` | `X-Clutch-Key`                | Torque via Clutch/OpenClaw     | The service profile — see `MCP_AGENT_USER_ID` |

In **headless** mode you **must** also set `MCP_AGENT_USER_ID`, or `create`/`update` will fail on the `created_by`/`updated_by` NOT NULL constraint. The server prints a startup warning if it's missing.

## Environment variables

| Variable            | Required                         | Mode     | Purpose                                                                        |
| ------------------- | -------------------------------- | -------- | ------------------------------------------------------------------------------ |
| `TCM_BASE_URL`      | **yes**                          | both     | Base URL of the TCM instance (trailing slash optional).                        |
| `TCM_USER_TOKEN`    | one of these two                 | user     | User's Supabase JWT.                                                           |
| `CLUTCH_API_KEY`    | one of these two                 | headless | Server-to-server key; must match TCM's `CLUTCH_API_KEY`.                       |
| `MCP_AGENT_USER_ID` | yes, in headless mode for writes | headless | `profiles.id` UUID of the Clutch Agent service profile, for write attribution. |

Getting a **`TCM_USER_TOKEN`**: it's your TCM Supabase session JWT — obtained by signing into TCM in a browser (or via the Playwright login flow) and reading the Supabase access token.

## The write safety flow (dry-run → approval → commit)

`create_test_case` and `update_test_case` are two-pass:

1. Call with **`dry_run: true`** first. The tool validates, resolves IDs, and **returns a summary** (create: the proposed case; update: a field-level diff + before/after steps). **No write happens.**
2. A human reviews and approves — Torque relays the summary to Slack via Clutch; Claude Code shows it inline in the chat.
3. Call again with **`dry_run: false`** (or omit `dry_run`) to commit.

The server does **not** technically enforce that a dry-run/approval happened before a commit (decided: PRD OQ-4 Option A) — it's a process convention. Don't call with `dry_run: false` without human approval.

## Local development

```bash
git clone https://github.com/JoinFullStackDev/tcm-mcp && cd tcm-mcp
npm install                 # runs prepare → tsc → dist/
npm run build               # rebuild after changes

# run the stdio server directly (Ctrl-D / EOF to exit)
TCM_BASE_URL=https://your-tcm-instance.example.com \
TCM_USER_TOKEN=your-jwt \
node dist/index.js

npm run dev                 # same, via ts-node (no build step)
```

Startup logs (mode, base URL, "Ready") are written to **stderr**, so they don't interfere with the stdio MCP protocol on stdout.

## Notes & caveats

- **Audit logging** (`mcp_tool_calls`, PRD Appendix C) requires migration `00042` applied to the TCM database. The log inserts are **fire-and-forget and non-blocking** — if the table is missing, tools still work; only the audit trail is skipped.
- **Distribution** is git-URL only (no npm publish). Pin a tag; ensure hosts have git access.
- The `--stdio` arg in the config is cosmetic — stdio is the only transport.
