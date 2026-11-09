# Architecture

LiteDB is a Tauri v2 app: a React + TypeScript front end in a webview, and a
Rust back end that owns every database connection. A separate Node process,
`litedb-mcp`, lets AI agents use the same database through the same safety
rules. This page is the map; the files it names explain themselves in their
header comments.

## The safety pipeline

The part most worth understanding. Every statement — typed in the editor,
written by Text to SQL, made by a grid edit, or sent by an agent — goes through
the same stages:

```
SQL ─▶ tokenize ─▶ classify ─▶ policy ─▶ impact preview ─▶ approval ─▶ run ─▶ audit ─▶ (undo)
```

| Stage | Where | What it decides |
| --- | --- | --- |
| Tokenize | `src/lib/sqlTokenizer.ts` | Where strings, comments, identifiers and parentheses begin and end, so a `;` in a string or a column named `delete` cannot fool anything after it. Splits scripts into statements. |
| Classify | `src/lib/sqlClassifier.ts` | Each statement's kind (`read`, `write`, `destructive`, `ddl`, `session`, `unknown`), verb, target table and top-level `WHERE` predicate; flags an `UPDATE`/`DELETE` with no predicate as unbounded. |
| Policy | `src/lib/sqlPolicy.ts` | Allow, confirm or block, from the connection's mode (read-only, guarded, unrestricted, YOLO) and the statement's provenance. AI-written SQL is floored to guarded, so it is never run unattended. |
| Impact preview | `src/lib/impactPreview.ts` | Turns `DELETE FROM t WHERE p` into `SELECT COUNT(*) FROM t WHERE p` for an exact row count, probes the table size for "12 of 4,210", and gets the plan with plain `EXPLAIN` (never `EXPLAIN ANALYZE`, which runs the statement). |
| Approval | `src/components/SqlEditor/ApprovalDialog.tsx`; for agents `src/components/AgentApprovalDialog.tsx` | The person decides with the count in front of them. Unbounded destructive statements need the table name typed out. |
| Run | `src-tauri/src/db/` | Rust runs it: rusqlite for SQLite, sqlx for Postgres. Scripts can run in one transaction. |
| Audit | `src/lib/auditLog.ts` | One JSON line per statement in `<app data>/audit/sql-audit.jsonl`: provenance, policy, decision, predicted and actual rows, and the agent or model behind it. |
| Undo | `src/lib/undoWrite.ts` | For agent writes, the rows saved before the write and the plan that puts back only what is still as the write left it. |

Two layers do not depend on the classifier being right:

- `assertWritable` in `src/lib/queryGate.ts` refuses writes on a read-only
  connection again at the client, whatever path they took.
- The MCP server reads through connections the engine will not let write
  (SQLite opened read-only, Postgres inside `BEGIN READ ONLY` that is always
  rolled back). A statement that beats the parser still meets
  `cannot execute UPDATE in a read-only transaction`.

## Agents: litedb-mcp

`mcp/` is an MCP server that agents (Claude, Cursor, VS Code) launch over
stdio. It does not open a database of its own choosing: it follows the one open
in LiteDB, through the handoff file the app writes (`src/lib/mcpHandoff.ts`,
read by `mcp/src/config.ts`). Quitting the app removes the handoff.

- `mcp/src/tools/query.ts`: `query` runs reads and turns writes into a preview
  with a single-use token (`mcp/src/approvals.ts`); `execute_approved` runs
  exactly the previewed SQL, byte for byte.
- `mcp/src/appApproval.ts` + `src/lib/agentApproval.ts`: while the app is
  open, `execute_approved` writes the request to `<app data>/approvals/` and
  waits for the window's answer (`src/lib/agentApprovals.ts` polls, the card
  decides). Older apps leave out `approveInApp` in the handoff, and the asking
  stays with the MCP host.
- `mcp/src/undo.ts`: saves the rows an approved write touches, for Undo.
- `mcp/src/audit.ts`: writes to the same audit log, with the host's name.

The app and the server share code: everything in `src/lib/` that the server
imports is kept free of browser and Tauri imports, and the self-tests run it in
Node.

## The desktop app

- **Rust** (`src-tauri/src/`): `main.rs` (window, the HTTP proxy AI providers
  go through, keychain access), and `db/`: `mod.rs` (the `db_*` commands and
  the SQLite file allowlist), `sqlite.rs`, `postgres.rs` (a small pool plus one
  session for the editor, so `SET` and transactions carry over), `ssh.rs`
  (tunnels, host keys checked against `known_hosts`), `value.rs` (how cells
  cross into JSON).
- **Connections** (`src/lib/db/`): `native.ts` wraps the commands;
  `client.ts`, `sqliteClient.ts` and `pgClient.ts` build the SQL for the grid,
  imports and exports; `connections.ts` is the store of open connections;
  `savedConnections.ts` keeps profiles in localStorage and secrets in the OS
  keychain.
- **Editor** (`src/components/SqlEditor/`): CodeMirror 6 in
  `SqlCodeEditor.tsx`; column completion in `src/lib/sqlComplete.ts`; inline
  suggestions in `ghostText.ts` and `src/lib/inlineSuggest.ts`.
- **Text to SQL** (`src/lib/aiService.ts`, `src/lib/promptBuilder.ts`):
  schema context, few-shot examples, and a repair loop that compiles the SQL
  against the live database before you see it. Measured by `evals/`.

## Tests

| Command | Covers |
| --- | --- |
| `npm run test:unit` | Pure helpers: URLs, CSV, literals, completion, approvals, undo plans. |
| `npm run mcp:selftest` | The MCP server end to end against a real SQLite file: policies, previews, tokens, in-window approval, undo. |
| `npm run eval:selftest` | The Text-to-SQL eval harness itself, without calling a model. |
| `cd src-tauri && cargo test` | The Rust SQLite engine. |

CI runs all of them, plus `cargo fmt --check`, `cargo clippy -D warnings`,
`npm run lint` and `npm run typecheck`.
