# LiteDB

A modern, fast, and user-friendly database viewer/editor built with React and Tauri (Rust). Now supporting both SQLite and PostgreSQL with seamless database management and advanced vector search capabilities.

<div align="center">

[![Download](https://img.shields.io/badge/Download-App-blue?style=for-the-badge&logo=w)](https://github.com/createdbyadham/LiteDB/releases/tag/v2.1.0)
[![Watch Demo](https://img.shields.io/badge/Watch-Demo-red?style=for-the-badge&logo=y)](https://www.linkedin.com/feed/update/urn:li:activity:7377312579544563712/?updateEntityUrn=urn%3Ali%3Afs_feedUpdate%3A%28V2%2Curn%3Ali%3Aactivity%3A7377312579544563712%29)

</div>

![LiteDB](./docs/assets/Litedb.png)

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

- **Schema Visualization**: Visualize your database structure, relationships, and foreign keys in an interactive diagram.
  - **Auto-Layout**: Automatically arranges tables to minimize crossing lines.
  - **Export**: Save your schema diagram as **PNG or SVG** for documentation.
- **Edit Support**: View and edit database records directly
- **Advanced Search**: Filter and search through your data
- **Real-time Updates**: Changes reflect immediately
- **Data Sorting**: Sort any column with a click
- **Responsive Design**: Works great on any screen size
- **Batch Operations**: Execute multiple SQL statements with transaction support
- **SQL Script Management**: Save and reuse your SQL scripts
- **Dual Database Support**: Works with SQLite and PostgreSQL
- **AI Agent (Text-to-SQL)**: Turn natural language into SQL queries.
  - **Privacy-First AI**: 100% Local Text-to-SQL support with Ollama.
  - Supports OpenAI, GitHub, and Azure providers.
  - Schema is injected into the LLM upon initialization and refresh.
- **Write Safety**: Generated SQL is classified before it runs.
  - Read-only / guarded / unrestricted / YOLO modes, remembered per connection.
  - Unqualified `DELETE`/`UPDATE`, `DROP` and `TRUNCATE` intercepted.
  - Approval shows the **exact affected-row count**, not just a warning.
  - Generated SQL is **compiled before you see it**, so the model fixes its own
    unknown columns and syntax errors — writes included.
  - Append-only audit log of every statement that ran, and who authorised it.
- **Autosave & Export**: Automatically save changes and export query results to **CSV, Excel, or JSON**.
- **Vector Search & Semantic Search**: Perform semantic similarity searches on your data using pgvector and local embedding models.

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

Unlike standard API wrappers, LiteDB implements a **Context-Aware RAG Pipeline** to ensure high-accuracy SQL generation:

1.  **Schema Extraction**: On connection, the app actively introspects the database to extract table definitions, foreign keys, and data types.
2.  **Dynamic Context Injection**: This metadata is formatted and injected into the LLM's system prompt (System Message), giving the model "awareness" of the specific database structure.
3.  **Driver-Specific Validation**: The system prompts are tailored to the active driver (e.g., enforcing PostgreSQL specific syntax vs. SQLite), reducing syntax errors in generated queries.

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
and any of the four supported providers. Failures are typed — a query that
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
tightens the gate. Clearing the editor resets it.

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

The same write-safety layer, exposed over the Model Context Protocol, so Claude
Desktop or Claude Code can drive a local database through the guardrails instead
of around them. That is the reason to point an agent at
[`litedb-mcp`](mcp/README.md) rather than at a raw Postgres MCP server.

```json
{
  "mcpServers": {
    "litedb": {
      "command": "npx",
      "args": ["-y", "litedb-mcp"],
      "env": { "LITEDB_SQLITE_PATH": "/absolute/path/to/your.db" }
    }
  }
}
```

Seven tools — `list_tables`, `describe_table`, `query`, `execute_approved`,
`list_vector_columns`, `semantic_search`, `audit_log` — plus a `litedb://schema`
resource.

**A write never runs on the first call.** `query` classifies the statement,
measures its impact, and returns a preview and a single-use token; executing it
is a second, separately named tool call, which is the one your MCP client stops
and asks you about — with `2 rows of 4 in orders` already on screen. Because
provenance over MCP is a model by definition, the AI floor applies at every
setting, so even `unrestricted` previews. There is no configuration that runs a
generated write unattended, and `yolo` is refused at startup: it is a mode that
only makes sense with a banner in a status bar and someone watching it.

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

- Node.js (v16 or higher)
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

Connecting to Databases:
1. SQLite: Click "Upload Database" or drag & drop your SQLite file
2. PostgreSQL: Open the Connection Manager, enter your credentials, and connect
3. Switch Databases: Use the database switcher to toggle between SQLite & PostgreSQL
4. Browse tables using the table selector
5. Use the search bar to filter data
6. Double-click any row to edit
7. Check multiple rows at once then click "Delete" to remove them
8. Click "Save Changes" to persist modifications

PostgreSQL-Specific Features:
- Run SQL queries with real-time feedback
- View table structures directly in the UI
- Batch execute multiple statements in transaction mode
- Securely connect using SSL

### Batch Operations & SQL Scripting

The batch operations feature allows you to execute multiple SQL statements at once, which is perfect for complex database operations.

#### Using Batch Operations

1. After loading a database, click on the "Batch Operations" tab
2. Enter your SQL statements in the editor, separating them with semicolons (`;`)
3. Use the "Use Transaction" toggle to enable/disable transaction mode:
   - When enabled (default): All statements succeed or none do (atomic operations)
   - When disabled: Each statement is executed independently
4. Click "Execute Script" to run your SQL commands
   - Reads run immediately. Anything that changes the database opens an
     approval dialog first, showing how many rows each statement will affect —
     see [Write safety](#write-safety). Switch the connection to
     **Unrestricted** in the status bar to skip the prompt for statements you
     typed yourself.
5. View the results including execution time, affected tables, and any errors
6. The **Audit** tab records every statement that ran, and who authorised it

#### Saving and Reusing Scripts

1. Write your SQL script in the editor
2. Enter a name for your script in the input field
3. Click "Save Script" to store it for future use
4. Access your saved scripts by clicking on the "Saved Scripts" tab
5. Use the "Load" button to load a script back into the editor
6. Delete unwanted scripts with the delete button

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
  ├── hooks/         # Custom React hooks
  ├── lib/           # Utilities and services
  ├── styles/        # Global styles
  └── types/         # TypeScript type definitions
```

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
  └── queryGate.ts       # per-connection policy, the audit write path
```

### Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
