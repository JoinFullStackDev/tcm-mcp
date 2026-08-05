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
- **Git read access** to `JoinFullStackDev/tcm-mcp` — the package is distributed by **git URL, not published to npm**. On headless hosts (OpenClaw/Torque) a git token must be present in the environment.
- That's it for the TCM URL: it **defaults to production** (`https://tcm-ochre.vercel.app`), so there's nothing to look up or set. You just need to authenticate ([Quickstart](#quickstart-2-steps)).

Because it's distributed by git URL, `npx` clones the repo and **builds from source on first run** (via the package's `prepare` → `tsc` step), so the first launch is slower. Subsequent runs are cached.

## Quickstart (2 steps)

The production TCM instance (`https://tcm-ochre.vercel.app`) is **baked in as the default**, so you do **not** need to set `TCM_BASE_URL` — a fresh install just works. Point at a different instance only if you self-host (see [Environment variables](#environment-variables)).

### 1. Log in (one-time)

```bash
npx --yes github:JoinFullStackDev/tcm-mcp#v1.1.0 login
```

This opens a browser once, you sign in with Google, and it writes a session file the server uses to keep itself authenticated indefinitely. **Playwright is installed automatically** if it's missing (a one-time ~100 MB browser download into `~/.tcm-mcp`) — nothing to set up first. Re-runs refresh silently with no browser window. Details: [Auto-refreshing login](#auto-refreshing-login-recommended).

### 2. Register the server

**Claude Code** — one command, no files to create by hand:

```bash
claude mcp add tcm --scope user -- npx --yes github:JoinFullStackDev/tcm-mcp#v1.1.0 --stdio
```

`--scope user` makes it available in every project. That's it — restart Claude Code and the `tcm` tools are live. (To scope it to one project instead, drop `--scope user`; Claude Code writes a `.mcp.json` in the current directory for you.)

**Claude Desktop** — it has no CLI, so add the server to its config file:

1. Open **Claude Desktop → Settings → Developer → Edit Config**. This creates and opens `claude_desktop_config.json` for you (no need to make the folder yourself):
   - macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
   - Windows: `%APPDATA%\Claude\claude_desktop_config.json`
2. Add the `tcm` entry (merge into `mcpServers` if the file already has one):

```json
{
  "mcpServers": {
    "tcm": {
      "command": "npx",
      "args": ["--yes", "github:JoinFullStackDev/tcm-mcp#v1.1.0", "--stdio"]
    }
  }
}
```

3. Save and fully **quit + reopen** Claude Desktop.

> **Pin to a tag** (`#v1.1.0`), **not a branch** — a branch ref re-resolves on every launch and can trip the 30 s MCP startup timeout. No `env` block is required; add one only to override `TCM_BASE_URL` or to use a different [auth mode](#auth-modes).

<details>
<summary>Manual <code>.mcp.json</code> / legacy static-token setup</summary>

If you'd rather edit `.mcp.json` directly (Claude Code project or `~/.claude/.mcp.json`), the minimal entry is just `command` + `args` as shown above. To use the **legacy static-token** mode instead of a login session (e.g. CI that already has a JWT), add an env block — note it **expires ~1h** and refreshing it needs a full client restart:

```jsonc
{
  "mcpServers": {
    "tcm": {
      "command": "npx",
      "args": ["--yes", "github:JoinFullStackDev/tcm-mcp#v1.1.0", "--stdio"],
      "env": { "TCM_USER_TOKEN": "${TCM_USER_TOKEN}" },
    },
  },
}
```

</details>

## Auth modes

The server resolves its mode at startup. **Precedence: `CLUTCH_API_KEY` → login session file → `TCM_USER_TOKEN`.**

| Mode                               | Selected by                      | Sends                         | Use for                        | Attribution                                   |
| ---------------------------------- | -------------------------------- | ----------------------------- | ------------------------------ | --------------------------------------------- |
| **Refreshing token** (interactive) | a session file (`npm run login`) | `Authorization: Bearer <jwt>` | Claude Code, human in the loop | The real user (their Supabase session)        |
| **Static token** (legacy)          | `TCM_USER_TOKEN`                 | `Authorization: Bearer <jwt>` | CI / scripts injecting a JWT   | The real user (their Supabase JWT)            |
| **Clutch key** (headless)          | `CLUTCH_API_KEY`                 | `X-Clutch-Key`                | Torque via Clutch/OpenClaw     | The service profile — see `MCP_AGENT_USER_ID` |

In **refreshing** mode the server auto-renews the access token before expiry and again on any `401` (retrying the request once), and persists the rotated refresh token back to the session file. In **static** and **clutch** modes a `401` is terminal (nothing to refresh).

In **headless** mode you **must** also set `MCP_AGENT_USER_ID`, or `create`/`update` will fail on the `created_by`/`updated_by` NOT NULL constraint. The server prints a startup warning if it's missing.

## Auto-refreshing login (recommended)

The login helper signs you into TCM in a browser once and writes a **session file** the server then uses to keep itself authenticated indefinitely — no `~1h` token churn, no client restarts.

```bash
# no clone needed — runs straight from the git URL:
npx --yes github:JoinFullStackDev/tcm-mcp#v1.1.0 login

# ...or, from a local clone of this repo:
npm run login
```

- Opens a browser **only** if there's no valid saved session; later runs refresh silently (headless, no window).
- **Playwright is installed for you on first login.** It is deliberately _not_ a server dependency (keeps `npx <server>` installs lean ~50 MB), so the login helper installs `playwright` + Chromium once into `~/.tcm-mcp` (a ~100 MB one-time download) if they aren't already present. You do **not** need a separate "Playwright MCP" — the login is fully self-contained.

It writes `~/.tcm-mcp/session.json` (mode `0600`) containing the Supabase project URL, anon key (public), and the access + **refresh** tokens. From then on the MCP server (mode “refreshing token”) mints fresh access tokens on demand.

- **Session file location:** `~/.tcm-mcp/session.json`, override with `TCM_SESSION_FILE`.
- **Browser profile:** `~/.tcm-mcp/browser`, override with `TCM_BROWSER_PROFILE`.
- **Security:** the refresh token is a long-lived credential — the file is `0600` and must never be committed or shared. Supabase rotates the refresh token on every refresh; the server persists the new one atomically.
- **When it expires:** if the refresh token is ever revoked/expired, tool calls fail with a clear “run `npm run login`” message. Re-run the helper.
- **Anon key capture:** the helper sniffs the public `apikey` header from Supabase network traffic. If capture ever fails, set `SUPABASE_ANON_KEY` (safe to expose) and re-run.

## Environment variables

| Variable              | Required                         | Mode       | Purpose                                                                                                                          |
| --------------------- | -------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `TCM_BASE_URL`        | no (defaults to production)      | all        | Base URL of the TCM instance. Defaults to `https://tcm-ochre.vercel.app`; set only to point at a preview / self-hosted instance. |
| `TCM_SESSION_FILE`    | no                               | refreshing | Override the session-file path (default `~/.tcm-mcp/session.json`).                                                              |
| `TCM_BROWSER_PROFILE` | no                               | refreshing | Override the login browser-profile dir (default `~/.tcm-mcp/browser`).                                                           |
| `TCM_USER_TOKEN`      | one credential                   | static     | User's Supabase JWT (legacy; expires ~1h, no refresh).                                                                           |
| `CLUTCH_API_KEY`      | one credential                   | headless   | Server-to-server key; must match TCM's `CLUTCH_API_KEY`.                                                                         |
| `MCP_AGENT_USER_ID`   | yes, in headless mode for writes | headless   | `profiles.id` UUID of the Clutch Agent service profile, for write attribution.                                                   |

The recommended credential is the **login session file** (`npm run login`), not `TCM_USER_TOKEN` — see [Auto-refreshing login](#auto-refreshing-login-recommended). `TCM_USER_TOKEN` remains for CI / scripts that already have a JWT.

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
