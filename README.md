# LiteDB

A modern, fast, and user-friendly database viewer/editor built with React and Tauri (Rust). Now supporting both SQLite and PostgreSQL with seamless database management and advanced vector search capabilities.

<div align="center">

[![Download](https://img.shields.io/badge/Download-App-blue?style=for-the-badge&logo=w)](https://github.com/createdbyadham/LiteDB/releases/tag/v2.5.0)
[![Watch Demo](https://img.shields.io/badge/Watch-Demo-red?style=for-the-badge&logo=y)](https://www.linkedin.com/feed/update/urn:li:activity:7377312579544563712/?updateEntityUrn=urn%3Ali%3Afs_feedUpdate%3A%28V2%2Curn%3Ali%3Aactivity%3A7377312579544563712%29)

</div>

![LiteDB](./docs/assets/Litedb.png)

## Install

```bash
brew install --cask litedb
winget install -e --id AdhamEhab.LiteDB
scoop bucket add extras && scoop install extras/litedb
yay -S litedb-bin
flatpak install flathub com.adhamehab.litedb
```

The badge above is the GitHub release for this version. macOS builds are Developer ID signed and notarized. Windows builds are Authenticode-signed.

## Code signing policy

Free code signing provided by SignPath.io, certificate by SignPath Foundation

## Measured, not asserted

LiteDB's Text-to-SQL agent ships with a public benchmark in [`evals/`](./evals)
— 109 cases scored by **execution accuracy**, with a held-out split that was
written after the prompt work and never tuned against.

`qwen2.5-coder:7b` running locally on a 6 GB laptop GPU, SQLite:

| | Overall | Held-out |
| --- | ---: | ---: |
| Schema context + execution-guided repair | 77.3% | 67.6% |
| \+ retrieved few-shot exemplars | **85.6%** | **76.5%** |

On a **second, unseen schema** — different naming conventions, integer cents,
nullable dates — the same agent scores 91.7%, so the gains are not an artifact
of one database.

```bash
npm run eval:selftest   # verify the harness itself (no API calls)
npm run eval -- --provider ollama
```

Six experiments are documented in [`evals/README.md`](./evals/README.md),
including the two that were **rejected** and the case-design defects a stronger
model exposed. Every number is reproducible with one command.

That score is also the argument for the [write-safety layer](#write-safety):
85.6% is good for a 7B model on read-only queries, and read-only queries are
the easy case. Generated SQL is classified before it runs, and never executes
unattended — even on a connection you have set to unrestricted.

## Features

- **SQLite, opened in place**: files are read and written natively (rusqlite), so a multi-gigabyte database opens as fast as a small one and shares the file with your app or an agent through SQLite's own locking. Writes from another program show up in the grid on their own.
- **PostgreSQL the way it is used**: every schema the role can see (Supabase's `auth` and `storage` included), paste a `postgres://` URL to fill the form, SSL from off to verify-full with your CA, and SSH tunnels through a bastion with a key, a password or your SSH agent.
- **Saved connections**: as many as you like, each with a name and a colour. Passwords and SSH passphrases go to the OS keychain, only if you ask.
- **Production tag**: a connection tagged production opens read-only, for you and for any agent following the app, and turns the title bar red while it is on screen. Leaving read-only asks first.
- **Several databases open at once**, as tabs in the title bar. Switching does not reconnect.
- **SQL editor**: syntax highlighting, autocomplete that offers the columns of the tables in your query (no `table.` needed), `Ctrl/Cmd+Enter` runs the statement under the cursor or the selection, `F5` runs the script, query tabs that survive a restart, history and saved scripts, a row limit, and Cancel for a long query. Errors underline the statement (and, in Postgres, the exact spot).
- **AI in the editor**: **Ask AI** (`Ctrl/Cmd+K`) opens Text to SQL from the editor, **Explain** describes a query with its plan, and a failed query offers **Explain** and **Fix with AI**, shown side by side before anything changes.
- **Inline suggestions** (off by default): the model's continuation as grey text after the cursor, `Tab` to accept, `Esc` to dismiss. Fill-in-the-middle on Ollama, chat elsewhere. Never on a production connection, and accepted text counts as AI-written for the safety gate.
- **Table editor**: double-click a cell to edit it, insert and duplicate rows, filter by any column, follow a foreign key to the row it points at (or see what points here), view and edit JSON, and copy rows as TSV, CSV, JSON, INSERT statements or Markdown. Results scroll smoothly however many rows come back.
- **CSV import**: into a new table with inferred column types, or into an existing one with columns matched by name, in one transaction.
- **Command palette**: `Ctrl/Cmd+P` jumps to any table, connection or action.
- **Light and dark themes**, or follow the OS.
- **Schema Visualization**: Visualize your database structure, relationships, and foreign keys in an interactive diagram.
  - **Auto-Layout**: Automatically arranges tables to minimize crossing lines.
  - **Export**: Save your schema diagram as **PNG or SVG** for documentation.
- **AI Agent (Text-to-SQL)**: Turn natural language into SQL queries.
  - Settings → **AI**: OpenAI, OpenAI-compatible (LM Studio, vLLM, GitHub Models, Azure, …), or Ollama. Default is Ollama.
  - Same prompt the eval harness measures: schema + sample values (toggle), retrieved few-shot (K=3), one compile-repair pass.
- **MCP**: Settings → **Agents**, or the status-bar **MCP** chip. Claude Desktop / Claude Code / Cursor / OpenCode / VS Code follow the open connection — [Connect an agent](docs/connect-an-agent.md).
- **Write Safety**: Generated SQL is classified before it runs.
  - Read-only / guarded / unrestricted / YOLO modes, remembered per connection.
  - Unqualified `DELETE`/`UPDATE`, `DROP` and `TRUNCATE` intercepted.
  - Approval shows the **exact affected-row count**, not just a warning.
  - Generated SQL is **compiled before you see it**, so the model fixes its own
    unknown columns and syntax errors — writes included.
  - Append-only audit log of every statement that ran — including edits, inserts, deletes and imports made in the grid — and who authorised it.
- **Export**: tables or query results to **CSV, Excel, JSON or INSERT statements**.
- **Vector Search & Semantic Search**: Perform semantic similarity searches on your data using pgvector and local embedding models.

## Compared honestly

LiteDB is a SQLite/Postgres desktop client with an agent and a write-safety
layer. It is not a replacement for a general DBA workbench.

| | LiteDB | TablePlus | Beekeeper Studio | DBeaver |
| --- | :---: | :---: | :---: | :---: |
| SQLite + PostgreSQL | ✓ | ✓ | ✓ | ✓ |
| MySQL, SQL Server, and the rest | — | ✓ | ✓ | ✓ |
| SSH tunnel / jump host | ✓ | ✓ | ✓ | ✓ |
| ERD | ✓ | paid | plugins | ✓ |
| Text-to-SQL (local or cloud) | ✓ | — | — | Pro AI |
| Write-safety (classify, row-count approval, audit) | ✓ | — | — | — |
| MCP server through those guardrails | ✓ | — | — | — |
| pgvector semantic search in the app | ✓ | — | — | — |
| JDBC / every obscure driver | — | — | — | ✓ |
| Native polish / years of query UX | — | ✓ | — | — |

The loss that matters in practice: **two dialects**. If you need MySQL or SQL
Server, use those tools. Use this one when a model is allowed near the
database, when production should be hard to change by accident, or when
pgvector is the point.

## Schema Visualization

LiteDB now includes a powerful **Entity Relationship Diagram (ERD)** generator:
1. **Interactive Graph**: Drag and drop tables, zoom in/out, and explore relationships.
2. **Visual Foreign Keys**: Lines connect Foreign Keys (Source) to Primary Keys (Target) automatically.
3. **Key Indicators**: Visual icons for Primary Keys (🔑), Foreign Keys (🔗), and Unique constraints (#).
4. **Export Ready**: One-click export to high-quality images for your technical documentation.

## Vector Search & Semantic Search

LiteDB integrates advanced vector search capabilities powered by **pgvector** and local embedding models:

1.  **Semantic Search**: Find similar rows based on vector embeddings.
    *   **Search by Row ID**: Find rows that are semantically similar to a specific record.
    *   **Search by Text**: Enter natural language queries to find relevant records using local embedding models.
2.  **Local Embedding Models**: Run embedding models locally in your browser/app using Transformers.js.
    *   Supported models: `all-MiniLM-L6-v2`, `bge-base-en-v1.5`, `bge-large-en-v1.5`.
    *   Privacy-first: No data is sent to external APIs for embedding generation.
3.  **Distance Metrics**: Support for multiple distance metrics to suit your data:
    *   **Cosine Distance** (`<=>`): Best for normalized vectors.
    *   **L2 Distance** (`<->`): Euclidean distance.
    *   **Inner Product** (`<#>`): Dot product (negative).
4.  **Visual Feedback**: Color-coded similarity bars to quickly identify the most relevant results.

## AI Architecture (Text-to-SQL)

Unlike standard API wrappers, LiteDB implements a **Context-Aware RAG Pipeline** to ensure high-accuracy SQL generation. Settings → **AI** is the live matrix: **OpenAI**, **OpenAI compatible**, **Ollama (local)**. GitHub Models / Azure used to be separate rows; they are OpenAI-compatible endpoints now.

1.  **Schema Extraction**: On connection, the app introspects tables, foreign keys, and types.
2.  **Dynamic Context Injection**: That metadata goes into the system prompt, dialect-specific (Postgres vs SQLite).
3.  **Sample values** (on by default, toggle in Settings): a few distinct values from short enum-like columns so `"Germany"` can match stored `'DE'`. Emails, keys, and PII-looking columns are skipped.
4.  **Retrieved few-shot (K=3)**: worked examples from an unrelated employees schema. Same default as `npm run eval`.
5.  **Compile-repair**: if generated SQL does not compile, the engine error goes back to the model once. Writes included — it uses `EXPLAIN`, not a dry run.

### Measured accuracy

Accuracy claims about the Text-to-SQL agent are backed by a public, runnable
benchmark in [`evals/`](./evals) rather than asserted. It scores **execution
accuracy** — the generated query and a reference query are both executed
against a seeded fixture database and their result sets compared — so any
correct formulation counts, not just one that matches a string.

```bash
npm run eval:selftest              # verify the harness itself (no API calls)
npm run eval:verify                # verify the golden set (no API calls)
npm run eval -- --provider ollama  # score a local model
```

109 cases across five slices (`single-table`, `joins`, `aggregation`,
`window-functions`, `ambiguous-schema`), over two fixture schemas, runnable against SQLite or PostgreSQL
and OpenAI, any OpenAI-compatible endpoint, or Ollama. Failures are typed — a query that
answers the wrong question is reported separately from one that fails to parse,
and provider outages are excluded from the score entirely.

The harness executes model-generated SQL, so it treats that SQL as hostile:
a static read-only guard, plus an engine that physically cannot write
(read-only SQLite connection; `BEGIN READ ONLY` in Postgres).

See [`evals/README.md`](./evals/README.md) for the methodology, the comparison
rules and their tradeoffs, and how to add cases.

## Write safety

The benchmark above measures how often the model is right. This layer decides
what happens when it isn't.

Every statement — typed or generated — passes through one gate before it
reaches the database, and read-only mode is enforced in the services rather
than in the query box, so it covers the table editor's inline edits too.

### Statements are classified by what they do

Not by their leading keyword:

| Kind | Meaning |
| --- | --- |
| `read` | returns rows, changes nothing |
| `session` | transaction control, `SET`, `PRAGMA` writes |
| `ddl` | creates or alters a schema object without destroying data |
| `write` | changes rows, bounded by a predicate |
| `destructive` | unbounded row change, or removal of an object |
| `unknown` | unrecognised — **gated as destructive** |

Three cases drive most of the implementation, because all three fail *open* —
each makes a dangerous statement look safe:

- **`EXPLAIN ANALYZE DELETE FROM t` deletes.** In Postgres, `ANALYZE` executes
  the statement it claims to be explaining. Treating every `EXPLAIN` as a read
  is a data-loss bug.
- **`WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x` deletes**, while
  leading with a harmless-looking `WITH`.
- **`UPDATE t SET x = (SELECT y FROM z WHERE q)` has no `WHERE` of its own.**
  The only `WHERE` belongs to the subquery, so it rewrites every row. A
  substring search for `where` calls this bounded; it is not.

Each is covered by an assertion in `npm run eval:selftest`, alongside a
tokenizer that knows the difference between a `;` and a `;` inside a string
literal, and between the keyword `DELETE` and a column named `"delete"`.

### Three modes, remembered per connection

| Mode | Reads | Your writes | Generated writes |
| --- | --- | --- | --- |
| **Read-only** | run | refused | refused |
| **Guarded** *(default)* | run | ask first | ask first |
| **Unrestricted** | run | run | **still ask** |
| **YOLO** | run | run | run, unreviewed |

The `unrestricted` row is the interesting one. It is a promise you make about
your own typing, and it does not extend to SQL a model wrote — that is floored
at `guarded` whatever the connection is set to. A `DELETE` you typed and a
`DELETE` a model inferred from a sentence are the same SQL and not the same
event, and the benchmark above is the reason: 85.6% is a good score for a 7B
model on *read-only* queries, which is the easy case.

**YOLO** is the deliberate escape hatch, and the only mode that waives that
floor. In it the model executes its own SQL the moment it writes it — no
editor, no Execute click, no row count, nothing refused. It exists because the
alternative to an escape hatch is people working around the tool, and because
on a scratch database the prompts are pure friction. It is opt-in per
connection behind a one-time confirmation, shown in red for as long as it is
on, and it is the one mode where the audit log stops being a convenience and
becomes the only record that anything happened — which is why, in YOLO, the
log records your reads too.

Provenance is sticky. Editing generated SQL does not make you its author —
someone who tweaks one clause has not read the rest — and `ai` only ever
tightens the gate. Accepting an inline suggestion makes a tab `ai` too.
Clearing the editor resets it.

> **Deviation from the original plan, stated plainly:** this was specified as
> "read-only by default". Read-only by default would make the table editor —
> the app's primary function — appear broken on first launch, and a safety
> default users switch off within a minute protects nobody. `guarded` keeps
> reads instant, makes every mutation an explicit act, and leaves read-only as
> a real mode one click away in the status bar for the case it is meant for:
> pointing the app at production.

### Approval shows impact, not a shrug

"Are you sure?" is a question nobody can answer well. The dialog answers a
better one — how many rows, out of how many:

- **Bounded writes get an exact count.** The predicate that limits the write is
  the same predicate that counts what it will hit, so `DELETE FROM t WHERE p`
  is previewed with `SELECT COUNT(*) FROM t WHERE p`. That is a measurement,
  not an estimate, and the self-test checks it against a real database.
- **The total it is measured against is probed, not counted.** `12 of 200+ rows`
  means the table holds at least 200 — the probe stops there, because a plain
  `COUNT(*)` on a large table is a full scan and the dialog would sit waiting on
  it. A capped total is never promoted to an exact one: an unbounded `DELETE`
  reports "affects every row", not a number the probe never reached.
- **Everything else gets the planner's estimate**, via `EXPLAIN` — never
  `EXPLAIN ANALYZE`, for the reason above.
- **Typed confirmation is rationed** to statements that destroy data with no
  predicate bounding them. Requiring it for every write would train the habit
  of typing the word without reading the sentence above it.

### The model checks its own SQL before you see it

A generated statement is compiled against the live database before it reaches
the editor. If it does not compile, the engine's own error goes back to the
model, which gets one attempt to fix it.

The important word is **compiled**, not executed. `EXPLAIN <statement>` parses
and resolves names without performing the statement, so this checks writes as
well as reads:

| Generated SQL | Caught as |
| --- | --- |
| `UPDATE orders SET nonexistent_col = 1 WHERE id = 1` | `no such column: nonexistent_col` |
| `SELECT nope FROM orders` | `no such column: nope` |
| `SELEC * FROM orders` | `near "SELEC": syntax error` |

An earlier version dry-*ran* the query instead, which meant the read-only guard
had to refuse anything but a `SELECT` — so the failure people actually hit went
uncaught: the model writes an `UPDATE`, it looks plausible in the box, and the
missing column only surfaces after you press Execute.

The rule that keeps this safe is that the checker never emits `EXPLAIN
ANALYZE`, which would execute the statement it claims to be checking. The
self-test asserts it, and demonstrates the property directly: on a physically
read-only connection, `EXPLAIN DROP TABLE orders` compiles cleanly and the
table is still there afterwards.

### Audit log

Every generated statement and every hand-made change is appended to
`<app data>/audit/sql-audit.jsonl`, one JSON object per line, readable in the
editor's **Audit** tab. Entries record the SQL, the natural-language prompt it
came from, the model that wrote it, the policy in force, whether it was
allowed, approved, blocked or declined, and what actually happened.

Two limits, stated because a safety feature that overclaims is worse than none:
append-only is a property of the API, not of the file — the file is yours and
you can edit it; and entries hold SQL verbatim, including literal values, which
is why it never leaves the machine and is never attached to a diagnostics
bundle.

## MCP server

The same write-safety layer, exposed over the Model Context Protocol, so an
agent can drive a local database through the guardrails instead of around them.
That is the reason to point it at [`litedb-mcp`](mcp/README.md) rather than at
a raw Postgres MCP server.

If LiteDB is running, the server follows whatever you have open. No paths in
the config, no restart when you switch database. Quitting the app clears that
handoff — including a stored Postgres password — so an agent cannot keep using
the last connection. Fastest path: Settings →
**Agents**, or the status-bar **MCP** chip. Host-by-host:
[Connect an agent](docs/connect-an-agent.md). Requires **Node.js 22.5+** with
`npx` on the PATH that Claude, Cursor, or VS Code uses (`node:sqlite`). LiteDB
does not install Node.

Windows (what the app copies):

```json
{
  "mcpServers": {
    "litedb": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "litedb-mcp"]
    }
  }
}
```

macOS / Linux: `"command": "npx", "args": ["-y", "litedb-mcp"]`.

```bash
claude mcp add litedb --scope user -- npx -y litedb-mcp
```

The status-bar policy is the agent's policy. Set the connection read-only in
the UI and the next tool call is read-only. YOLO is the one exception: it maps
down to guarded, because YOLO means a human is watching this window, which is
exactly what isn't true over MCP.

Without the app — CI, a box that has never launched LiteDB — set
`LITEDB_SQLITE_PATH` or `LITEDB_DATABASE_URL`. Env wins when both are present.

Seven tools — `list_tables`, `describe_table`, `query`, `execute_approved`,
`list_vector_columns`, `semantic_search`, `audit_log` — plus a `litedb://schema`
resource.

**A write never runs on the first `query`.** That call classifies, measures
impact, and returns a preview plus a single-use token. Running it is a second
tool, `execute_approved`. Provenance over MCP is a model by definition, so even
`unrestricted` previews; `LITEDB_POLICY=yolo` is refused at startup.

**With LiteDB open, you approve the write in LiteDB.** `execute_approved` puts
the statement in front of you in the app, with the exact row count and the rows
it deletes, changes or adds, and waits. Nothing runs until you click Approve
there, even when the agent's host runs tools without asking (Cursor with
auto-run chains both tools without a click). Decline, and the agent is told
nothing ran. Settings → Agents turns this off, leaving the host's own prompt as
the only check. What it does not stop is in
[`mcp/README.md`](mcp/README.md#what-it-does-not-do).

Underneath the classifier, the engine enforces the same boundary independently —
SQLite opened read-only, Postgres reads inside `BEGIN READ ONLY` that is always
rolled back — so a statement that beats the parser still meets
`cannot execute UPDATE in a read-only transaction`.

Semantic search embeds your query text with MiniLM or BGE **in the server
process**, so searching a pgvector column by meaning sends nothing to an
embedding API. And it writes to the same audit log the desktop app reads: run
something over MCP, open LiteDB, and it is there in the Audit tab next to your
own statements.

## Tech Stack

- React
- TypeScript
- Vite
- Tailwind CSS
- Tauri (Rust)
- PostgreSQL
- SQLite

## Getting Started

### Prerequisites

- Node.js **22.5+** (MCP uses `node:sqlite`; evals want **24+**)
- Rust (latest stable)
- PostgreSQL (if using PostgreSQL features)

### Installation

1. Clone the repository:
```bash
git clone https://github.com/createdbyadham/LiteDB
```

2. Install dependencies:
```bash
npm install
```

3. Start the development server:
```bash
npm run tauri dev
```

### Building for Production

```bash
npm run tauri build
```

## Usage

### Connecting

- **SQLite**: *Open SQLite file*, drop a file anywhere on the home screen, or *New SQLite database* for an empty one. Files you open are saved to the list for next time.
- **PostgreSQL**: *Connect to Postgres*, or paste a `postgres://` URL anywhere on the home screen. Give it a name and a colour, tag it production if it is, choose the SSL mode, and turn on *Connect through SSH* for a database behind a bastion. *Test* checks it without saving.
- Saved connections reopen with one click. Several can be open at once; each is a tab in the title bar, and `+` goes back to the list.

### Browsing and editing

- Pick a table in the sidebar. In Postgres, the picker above it chooses the schema.
- Search, sort, and **Filter** by any column. A foreign-key value has an arrow that opens the row it points at; right-click a row for *Referenced by*.
- Double-click a cell to edit it (`Enter` saves, `Esc` cancels), or right-click for the whole row, *Set to NULL*, *Duplicate* and *Delete*. JSON opens in a viewer you can edit.
- **Insert row** fills in defaults and generated keys for you. **Import** loads a CSV.
- Copy cells with `Ctrl/Cmd+C`, or ticked rows as TSV, CSV, JSON, INSERT statements or Markdown.

Edits in the grid follow the connection's safety mode: in read-only they are refused, and every change is written to the audit log.

### The SQL editor

1. Write SQL. Autocomplete offers the columns of the tables your query reads, before you type `table.`; a name two of them share comes qualified, as `o.id`.
2. `Ctrl/Cmd+Enter` runs the statement under the cursor, or the selection. `Shift+Ctrl/Cmd+Enter` or `F5` runs every statement in the tab.
   - Reads run immediately. Anything that changes the database opens an
     approval dialog first, showing how many rows each statement will affect —
     see [Write safety](#write-safety). Switch the connection to
     **Unrestricted** in the status bar to skip the prompt for statements you
     typed yourself.
   - With **Transaction** on, a script runs all or nothing. A `BEGIN` you type yourself stays open until you commit; the editor shows it and offers *Commit* and *Roll back*.
   - Results stop at the row limit in the toolbar (1,000 by default). **Cancel** stops a query that runs too long.
3. **Ask AI** (`Ctrl/Cmd+K`) opens Text to SQL: describe what you want, and the SQL goes in after the statement you are on, selected, ready to run. **Explain** describes the statement under the cursor and its plan (plain `EXPLAIN`, so nothing runs). A failed query offers **Explain** and **Fix with AI**.
4. **Inline suggestions** (Settings → AI, off by default): pause while typing and the model's continuation appears in grey after the cursor. `Tab` accepts it, `Esc` dismisses it, and typing its next characters keeps the rest. They wait while the column popup is open.
   - Each pause sends the statement you are writing, your table names and the columns of the tables it reads to the provider, capped to a few hundred tokens. A connection tagged production never sends anything.
   - On Ollama the request is fill-in-the-middle, with the text after the cursor sent separately. A FIM-trained model such as `qwen2.5-coder:1.5b` completes best and fastest; set it as the model for suggestions to keep a larger model for Text to SQL. Models that refuse fill-in-the-middle, and the other providers, are asked through chat.
   - Accepting a suggestion marks the tab as AI-written, as Text to SQL output is, so its writes ask first even in **Unrestricted**.
5. Tabs keep their text across restarts. The panel on the right has **History**, **Saved** scripts and the **Audit** log.

#### Example Scripts

Here are some example SQL scripts you can try:

**Create new table and insert data:**
```sql
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  age INTEGER
);

INSERT INTO users (id, name, email, age) VALUES (1, 'name-example1', 'name1@example.com', 32);
INSERT INTO users (id, name, email, age) VALUES (2, 'name-example2', 'name2@example.com', 28);
```

**Update and delete records:**
```sql
UPDATE users SET age = 33 WHERE name = 'John Doe';
DELETE FROM users WHERE name = 'Jane Smith';
```

**Schema modifications:**
```sql
ALTER TABLE users ADD COLUMN created_at TEXT;
UPDATE users SET created_at = datetime('now');
CREATE INDEX idx_users_name ON users (name);
```

**Complex operations with transaction:**
```sql
BEGIN TRANSACTION;
CREATE TABLE temp_users AS SELECT * FROM users;
UPDATE users SET age = age + 1;
INSERT INTO users SELECT * FROM temp_users WHERE age > 30;
DROP TABLE temp_users;
COMMIT;
```

## Development

### Project Structure

```
src/
  ├── components/     # React components
  ├── hooks/          # Custom React hooks
  ├── lib/            # Utilities and services
  │   └── db/         # connections, the SQLite and Postgres clients, CSV, URLs
  └── types/          # TypeScript type definitions
src-tauri/src/
  ├── main.rs         # window, AI proxy, keychain
  └── db/             # sqlite.rs (rusqlite), postgres.rs (sqlx), ssh.rs (russh)
```

Every database call goes through one Tauri command, `db_run`, to a connection
held in Rust. SQLite is opened in place with rusqlite; Postgres keeps a small
pool plus a dedicated session for the editor, and an SSH tunnel when the
connection has one. `npm run test:unit` covers the pure helpers (URL parsing,
CSV, SQL literals, the statement under the cursor) and `cargo test` the SQLite
engine.

The Text-to-SQL and write-safety modules are deliberately free of browser,
Tauri and network imports, so the eval harness in [`evals/`](./evals) exercises
the code the app actually ships rather than a copy of it:

```
src/lib/
  ├── promptBuilder.ts   # the prompt, including retrieved few-shot exemplars
  ├── fewShot.ts         # exemplar bank and lexical retrieval
  ├── schemaSamples.ts   # sample values for enumerated columns, with guards
  ├── sqlTokenizer.ts    # strings, comments, identifiers, paren depth
  ├── sqlClassifier.ts   # read / write / destructive / ddl / session / unknown
  ├── sqlPolicy.ts       # policy + provenance -> allow / confirm / block
  ├── sqlGuard.ts        # read-only guard, shared with the harness
  ├── sqlValidator.ts    # compiles generated SQL without running it
  ├── impactPreview.ts   # exact row counts and EXPLAIN
  ├── auditLog.ts        # append-only JSONL
  ├── queryGate.ts       # per-connection policy, the audit write path
  ├── mcpHandoff.ts      # file the MCP server reads when you connect in the app
  ├── mcpAgentConfig.ts  # copy-paste snippets (Claude Code, Cursor, OpenCode, VS Code)
  └── claudeDesktopMcp.ts # Settings → Agents “Add to Claude Desktop”
```

### Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
