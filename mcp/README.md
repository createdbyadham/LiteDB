# litedb-mcp

An MCP server that lets Claude Desktop, Claude Code or any MCP client work
against a local SQLite or PostgreSQL database — through LiteDB's write-safety
layer rather than around it.

The difference from pointing a model at a raw connection string is one
sentence: **a write never runs on the first call.** `query` classifies the SQL,
measures what it would do, and hands back a preview and a single-use token.
Running it is a separate, separately-named tool call. That is the call your MCP
client asks you to approve — attached to a result that already told you
`2 rows of 4 in orders`.

```
> query({ sql: "DELETE FROM orders WHERE status = 'shipped'" })

APPROVAL REQUIRED — nothing has run.

Generated SQL contains a write: removes rows in orders matching the WHERE clause.

  1. DELETE FROM orders WHERE status = 'shipped'
     write · table: orders — removes rows in orders matching the WHERE clause
     affects: 2 rows of 4 in orders
     plan: SEARCH orders USING COVERING INDEX orders_status_idx (status=?)

Policy in force: guarded · assessed as: write

To run exactly the statements above, call execute_approved with:
  token: f34b1f04-1aae-4260-9bc3-bd8612f3e645
```

## Install

If LiteDB is running, the server follows whatever you have open. In the app:
Settings → **Agents**. Step-by-step for each host:
[Connect an agent](../docs/connect-an-agent.md).

```json
{
  "mcpServers": {
    "litedb": {
      "command": "npx",
      "args": ["-y", "litedb-mcp"]
    }
  }
}
```

```bash
claude mcp add litedb --scope user -- npx -y litedb-mcp
```

Switch database in the app, or flip the status-bar policy, and the next tool
call follows. No paths, no restart. YOLO in the app maps down to `guarded`.

That file is `claude_desktop_config.json` for Claude Desktop; for Claude Code
it is `.mcp.json` in the project, or `claude mcp add`. MCP servers load at
startup, so add it, then start a fresh session.

Without the app — a CI box, a machine that has never launched LiteDB — set the
target as environment variables. Env wins when both are present:

```json
{
  "mcpServers": {
    "litedb": {
      "command": "npx",
      "args": ["-y", "litedb-mcp"],
      "env": {
        "LITEDB_SQLITE_PATH": "/absolute/path/to/your.db"
      }
    }
  }
}
```

For PostgreSQL, swap the env block:

```json
"env": {
  "LITEDB_DATABASE_URL": "postgres://user:pass@localhost:5432/mydb",
  "LITEDB_POLICY": "guarded"
}
```

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| *(none)* | the app's open database | Handoff file next to the audit log. |
| `LITEDB_SQLITE_PATH` | — | Path to a SQLite file. Mutually exclusive with the next. Wins over the app. |
| `LITEDB_DATABASE_URL` | — | `postgres://…` connection string. Wins over the app. |
| `LITEDB_POLICY` | app dropdown, or `read-only` for env | `read-only`, `guarded`, or `unrestricted`. |
| `LITEDB_MAX_ROWS` | `200` | Cap on rows returned by one tool call. |
| `LITEDB_AUDIT_PATH` | the desktop app's log | Where statements are recorded. |
| `LITEDB_EMBEDDING_MODEL` | `minilm` | `minilm` (384d), `bge-base` (768d), `bge-large` (1024d). |
| `LITEDB_EMBEDDING_CACHE` | `<app data>/models` | Where the embedding model is downloaded to. |

**Following the app.** Connect in LiteDB and the agent uses that database. The
status-bar dropdown is the policy. SQLite is the file on disk, not the
editor's unsaved buffer — save first if you have been editing. An in-memory
database cannot be shared; save it to a file.

**The env default is `read-only`,** which is the opposite of the desktop app's
`guarded` default and deliberately so. The app's first job is editing tables
and there is a person in front of it; a server started from env alone is a
model and the session may be unattended. Opt into writes explicitly, or use
the app's dropdown.

**`yolo` is not available over MCP.** In the app it is a real mode, behind a
confirmation, with a banner in the status bar and someone at the keyboard.
If the app is in YOLO, the handoff maps that down to `guarded`. Setting
`LITEDB_POLICY=yolo` refuses to start and says why.

**The Postgres password.** Sharing a connection means sharing the credential.
The handoff file stores it in plaintext in your app-data directory — the same
exposure as putting it in `claude_desktop_config.json`, in a less
screenshot-prone place, and out of a file you might sync between machines.
The cleaner version would read it back out of the OS keychain where LiteDB
already put it, but that needs a native module and would cost the package its
"22 MB, no native deps" property.

## Tools

| Tool | What it does |
| --- | --- |
| `list_tables` | Tables, column counts, row counts, primary keys. |
| `describe_table` | Columns, types, keys, foreign keys, indexes, and the values a low-cardinality column actually holds. |
| `query` | Runs reads. **Previews** writes and returns a token. Refuses what the policy forbids. |
| `execute_approved` | Runs a previewed statement. Takes only the token. |
| `list_vector_columns` | pgvector columns and their dimensions. |
| `semantic_search` | Nearest-neighbour search, with the query text embedded on your machine. |
| `audit_log` | What has been proposed, approved and run — including from the desktop app. |

Plus a `litedb://schema` resource: the whole schema as one document, for when
you want the picture rather than one table.

### Why `describe_table` returns values, not just names

Because [the eval harness in this repo](../evals) measured what it is worth.
Asked for "customers in Germany" against a column storing `'DE'`, a model with
only column names and types has to guess. Sample values for low-cardinality
columns are several points of execution accuracy on their own. They are drawn
through the same read-only connection every other tool uses, under the same
eligibility rules the desktop app applies.

### Why `semantic_search` is a tool at all

A similarity query needs a query *vector*, and a model writing SQL cannot
produce one. Asking it to would mean shipping your search text to an embedding
API. Here it is embedded by MiniLM or BGE running in this process, so
"find rows about billing errors" never leaves the machine.

Text search needs one extra package, which is **not** installed by default:

```bash
npm install @xenova/transformers
```

It is an optional peer dependency because it pulls in the ONNX runtime and
sharp — around 210 MB, against 22 MB for the server itself. Charging that to
someone who only wants `list_tables` would be the wrong default. Without it,
`semantic_search` still works by `row_id`; text search returns the install
command rather than failing obscurely.

The first text search downloads the model (~23 MB for the default) and takes
about 25 seconds. After that it is cached in `LITEDB_EMBEDDING_CACHE`.

## How the safety layer actually holds

Three independent mechanisms, in the order they engage.

**1. Classification.** Every statement goes through the same tokenizer and
classifier the desktop app uses — string literals, comments, quoted
identifiers, dollar-quoting and paren depth all handled — and comes out as
`read`, `write`, `destructive`, `ddl`, `session` or `unknown`. An `unknown`
statement is gated *as destructive*: the classifier failing to recognise
something is exactly when it is least safe to assume it is harmless.

**2. The policy floor.** Provenance is part of the risk. A `DELETE` you typed
and a `DELETE` a model wrote are the same SQL and not the same event. Over
MCP the caller is a model by construction, so generated SQL is held to the
`guarded` floor no matter how permissively the server was started — which is
why `unrestricted` still previews. There is no configuration that makes a
write run on the first call.

**3. The engine.** Parsing can be beaten. So reads do not rely on it: SQLite
gets a connection opened read-only, and PostgreSQL runs every read inside
`BEGIN READ ONLY` that is always rolled back. A statement that slips past the
classifier meets an engine that refuses it:

```
ERROR:  cannot execute UPDATE in a read-only transaction
```

The impact preview runs there too, and it never uses `EXPLAIN ANALYZE` —
which in PostgreSQL executes the statement it claims to be explaining.

### What it does not do

LiteDB cannot make your MCP client ask you. A client that has allowlisted
`execute_approved` has turned the prompt off, and this server has no way to
know. What it guarantees is narrower and still worth having: the write was
classified, its impact was measured and reported before anything ran, what
runs is byte-for-byte what was previewed, and all of it is in the audit log
either way.

The audit log is append-only as a property of the API, not of the file. It
sits in your own app-data directory and you can edit it. It is a record for
its owner, not tamper-evident storage for a third party. It holds SQL
verbatim, which means literal values — that is the point, and it is why the
file never leaves the machine.

## The audit log is shared with the desktop app

By default this server appends to the same file LiteDB writes:

- Windows — `%LOCALAPPDATA%\com.adhamehab.litedb\audit\sql-audit.jsonl`
- macOS — `~/Library/Application Support/com.adhamehab.litedb/audit/sql-audit.jsonl`
- Linux — `~/.local/share/com.adhamehab.litedb/audit/sql-audit.jsonl`

So a statement an agent ran over MCP shows up in the app's audit view next to
the ones you ran yourself. A proposal is logged when it is made, not only when
it is approved — a write an agent suggested and never came back for still
leaves a trace:

```
2026-09-11T08:27:22.396Z · ai · pending/not-run · ~3 rows predicted
    DROP TABLE customers
2026-09-11T08:27:22.390Z · ai · approved/ok · 2 rows
    DELETE FROM orders WHERE status = 'shipped'
```

Point `LITEDB_AUDIT_PATH` somewhere else if you would rather keep them apart.

## Development

```bash
npm run mcp:selftest   # 73 assertions, no model, no API key, no network
npm run typecheck:mcp
npm run mcp:build      # bundles to mcp/dist/index.js
```

The self-test asserts outcomes rather than calls — after a `query` that
previews a `DELETE`, it reopens the database on its own connection and checks
the rows are still there. Every piece of the guarantee can degrade silently,
leaving a server that still answers questions correctly and guards nothing.

## Licence

MIT, same as LiteDB.
