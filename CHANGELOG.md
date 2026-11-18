# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.7.0] - 2026-11-17

### Added

- **Open CSV, Excel and JSON files.** *Open file*, the command palette or a drop on the home screen now takes `.csv`, `.tsv`, `.xlsx`, `.xlsm`, `.xlsb`, `.xls`, `.ods`, `.json`, `.jsonl` and `.ndjson` as well as SQLite databases. The file is read into a copy in memory and opens like any SQLite database: browse and filter it in the grid, query it in the SQL editor, ask Text to SQL about it, draw its schema and export it. A CSV becomes one table named after the file; each worksheet becomes a table named after its sheet; a JSON array of objects becomes a table with a column per key, and an object holding such arrays becomes a table per array.
  - Columns are typed from the data: INTEGER, REAL, BOOLEAN for a file's own true and false values, TEXT otherwise. Zip codes and other numbers with a leading zero stay text, Excel dates become ISO 8601 text, formulas give their last calculated value, and nested JSON is kept as JSON text. Empty cells are NULL.
  - The delimiter is guessed (comma, semicolon, tab or pipe). In a semicolon-separated file, as Excel writes where the comma is the decimal separator, `2,50` is the number 2.5. Text that is not UTF-8 is read as UTF-16 when it has a byte-order mark, otherwise as Windows-1252, and LiteDB says so.
  - A file opens on its first table, in the file's own order: the first sheet of a workbook, the first array of a JSON file.
  - It is a read-only copy, and the file on disk is never written: the safety mode stays read-only and SQLite itself refuses writes. Open the file again to pick up changes made to it since. To edit the data, import the CSV into a SQLite database as before.
  - Agents connected over MCP can read it too, through the app's connection. Their writes are refused.
  - Files are saved to the connection list like SQLite files, with their own icon. Text files up to 1 GB and workbooks up to 256 MB open; larger ones are refused with a reason rather than running the app out of memory.

### Fixed

- **Text to SQL with Qwen and other local models.** Requests from Text to SQL, *Explain* and *Fix* sent the instructions and the schema as separate system messages, which Qwen, Mistral and Gemma chat templates refuse with `400 System message must be at the beginning`. Every request now goes out with one system message, first.
- **AI settings from a failed Text to SQL.** The toast's *AI settings* button opened Settings underneath the Text to SQL dialog. The dialog now closes first, and keeps the question for when it reopens.
- **Reasoning models in Text to SQL, Fix and Explain.** A `<think>` block in the reply went into the editor with the SQL, or into the explanation. It is now left out, and a reply that ran out of tokens while reasoning says so instead of placing an empty statement.
- **Replies that are not SQL.** When the model answered in a sentence ("I cannot answer that, there is no orders table") or sent back nothing, the sentence or a lone `;` went into the editor. Text to SQL and Fix now show the model's words in the error instead. SQL wrapped in a sentence with a code block is taken from the block.
- **Closing Text to SQL while it works** abandons the request. Before, its SQL still landed in the editor seconds later, and in YOLO mode ran.
- **Readable AI errors.** A failed request said `401 Invalid API key provided.`, or showed a gateway's whole HTML error page. It now says what happened in a sentence (the key was refused, the model was not found, the provider is limiting requests or had a problem), with the server's own message when it has one. The connection test in Settings uses the same wording.
- **Fix with AI** no longer leaves a double `;` after the corrected statement.
- **Ctrl+K** opens Text to SQL from anywhere on the SQL editor page, not only from inside the editor, and after Text to SQL places a query the editor has focus again, so Ctrl+Enter runs it.

## [2.6.2] - 2026-11-12

### Changed

- The macOS app is signed with a Developer ID and notarized by Apple, so it opens without the "app is damaged" warning or the `xattr` workaround.

## [2.6.1] - 2026-11-12

### Fixed

- Claude (Anthropic) requests no longer fail with "401 CORS requests must set 'anthropic-dangerous-direct-browser-access' header". The localhost Origin header meant for Ollama is now sent only to local providers.
- Without Ollama running, AI errors say Ollama could not be reached and point to OpenAI, Claude or Gemini, with a button to AI settings, instead of a bare "Connection error." Settings → AI says the same when Ollama is chosen.
- The log file records each AI request's host, status and the provider's error message, and no longer fills with HTTP and TLS trace output.

## [2.6.0] - 2026-11-10

### Added

- **Claude and Gemini** as providers in Settings → AI: paste an Anthropic or Google AI Studio key and pick a model, no endpoint to type. Keys go to the OS keychain like the others. Defaults: Claude Sonnet 5.5 (Haiku 5.5 for inline suggestions) and Gemini 2.5 Flash.

### Fixed

- Audit panel cards stay inside the panel. A long statement or prompt used to push every card past its right edge; it now wraps.
- The page size picker in the table editor shows its whole label, "100 per page", instead of "100 per...".
- The typed confirmation for a write with nothing limiting it asks for the table name without its quotes. For a statement written with `` `Employees` ``, typing `Employees` never matched, so **Run anyway** stayed disabled. The quoted form is still accepted.

## [2.5.0] - 2026-11-09

### Added

- **LiteDB is its own MCP server.** Agents start `LiteDB --mcp`, which connects to the running window: no Node, no npm package, nothing else on the agent's PATH. The tools are the same, they run on the connection on screen (so a Postgres password stays in the app and an SSH tunnel is the app's), approvals are the app's own dialog, and every call lands in the same audit log. While LiteDB is closed the agent still sees its tools and each call says to open it; once the window is up, the next call goes through. Settings → Agents and *Add to Claude Desktop* now write this install's path. The npm package `litedb-mcp` stays, for machines without the app.
- **Let agents make small changes without asking**, per connection (Settings → Agents), for an agent that works with nobody watching. Its `write` tool then runs an INSERT of listed rows, or an UPDATE or DELETE with a WHERE clause, in one call when it changes no more rows than the limit you set. The rows are counted before it runs, and the write is rolled back if it changes more while it runs. Each one is in the audit log, marked as run without approval, and Undo still works. Schema changes, writes with no WHERE clause, DROP, TRUNCATE, upserts and anything over the limit still wait for approval, and `query` still never writes. Off by default, never on a connection tagged production, and named in the status bar while it is on.
- **Approve agent writes in LiteDB.** With the app open, an agent's `execute_approved` puts the write in front of you in LiteDB: the statement, the exact row count, and the rows it deletes, changes (old → new) or adds. Nothing runs until you click Approve there, even when the agent's app runs tools without asking. Decline, and the agent is told nothing ran. A write with nothing limiting it asks for the table name typed out, the window flashes for attention, and every answer goes in the audit log. Settings → Agents turns it off. Through the npm package it needs litedb-mcp 0.1.7; older versions leave the asking to the agent's app.
- **Undo for agent writes.** Before an approved UPDATE or DELETE from an agent runs, the rows it touches (up to 5,000, keyed by primary key or SQLite's rowid) are saved next to the audit log, and **Undo** in the Audit panel puts them back; a SQLite INSERT's new rows can be removed the same way. Rows that changed again after the write are left alone, so undo never overwrites newer work, and the undo itself is logged. Not covered: scripts of several statements, upserts, Postgres INSERTs, Postgres tables without a primary key, and rows changed by cascades or triggers.
- The Audit panel names the agent that sent a statement (Claude Code, Cursor) instead of "model".
- **Inline suggestions** in the SQL editor, off by default (Settings → AI). After a pause in typing, the model's suggestion shows as grey text after the cursor: `Tab` accepts it, `Esc` dismisses it, and typing its next characters keeps the rest. Ollama is asked fill-in-the-middle, which FIM-trained models such as qwen2.5-coder complete best; other providers, and models that refuse it, are asked through chat. Suggestions can have a smaller model of their own. Each pause sends the statement you are writing, your table names and the columns of the tables it reads to the provider. They never appear while the column popup is open or on a connection tagged production, and accepting one marks the tab as written by AI, so its writes still ask first in Unrestricted and the audit log names the model.
- **A real SQL editor.** Syntax highlighting, autocomplete for tables and for the columns of the tables in your query, without typing `table.` first (a name two tables share comes in as `o.id`), and errors underlined where the database points. `Ctrl/Cmd+Enter` runs the statement under the cursor or the selection; `Shift+Ctrl/Cmd+Enter` or `F5` runs the whole tab. Tabs keep their text across restarts, every run is kept in History, and **Cancel** stops a query that runs too long. Results stop at a row limit you choose, 1,000 by default.
- **AI in the editor.** **Ask AI** (`Ctrl/Cmd+K`) opens Text to SQL, and the SQL it writes goes in after the statement you are on. **Explain** describes the statement under the cursor and its plan without running it. A failed query offers **Explain** and **Fix with AI**.
- **Transactions in the editor.** With **Transaction** on, a script runs all or nothing. A `BEGIN` you type stays open until you end it; the editor says so and offers Commit and Roll back.
- **Saved connections**, as many as you like, each with a name and a colour. SQLite files you open are remembered too. Passwords and SSH secrets stay in the OS keychain.
- **Production tag.** A connection tagged production opens read-only, for you and for agents, under a red title bar. Leaving read-only asks first.
- **Several connections open at once**, each a tab in the title bar.
- **PostgreSQL:** every schema, with a schema picker in the sidebar; paste a `postgres://` URL to fill in the form; SSL modes Off, Prefer, Require, Verify CA and Verify full, with your own CA certificate; and **SSH tunnels** with a key, a password or your SSH agent, the host key checked against `known_hosts`.
- **Editing in the grid.** Double-click a cell to edit it, set NULL, duplicate a row, or insert one with defaults filled in. Filter by any column, open the row a foreign key points at or the rows that point at this one, read and edit JSON in a viewer, and copy rows as TSV, CSV, JSON, INSERT statements or Markdown. Pages hold 50 to 1,000 rows, and the grid draws only what is on screen.
- **CSV import** into a new table, with column types guessed from the data, or into an existing one.
- **Command palette** (`Ctrl/Cmd+P`) for tables, connections and commands.
- **Light theme**, or follow the system.
- Export as SQL INSERT statements, for one table or all of them.

### Changed

- **SQLite runs natively, on the file itself.** LiteDB used to load a copy into the webview with sql.js and write the whole copy back when you saved. Now each change is written when it happens, there is no Save step, and a large file no longer has to fit in memory. A change another program makes, such as an agent through the MCP server, appears on its own within a couple of seconds.
- PostgreSQL connections are held by the app's Rust side: a small pool for browsing, plus one session for the editor, so `SET`, temporary tables and open transactions carry over from one run to the next.
- The home screen lists your connections instead of asking for a file.
- The SQL editor replaces the Batch Operations tab.
- Grid edits and CSV imports obey the connection's safety mode and are written to the audit log.
- Agents see every PostgreSQL schema (and so does litedb-mcp 0.1.7); a table outside the search path is named `schema.table`. The handoff the MCP server follows carries the SSL mode, CA certificate and production tag, and a connection behind SSH goes through the app's tunnel while it is open.

### Removed

- sql.js and what it needed: Save, the guarded write and its lock, and reloading the whole file when another program changed it. SQLite's own locking now handles a second writer, waiting up to five seconds for it.
- The limit of three saved PostgreSQL connections.
- Leftovers from the Lovable / GPT Engineer template: the GPT Engineer script, the `rsms.me` stylesheet and the social-image tags in `index.html`, a second toaster (Sonner) that nothing used, unused shadcn components and hooks, `@tailwindcss/typography`, and template Tailwind settings.

### Security

- The webview CSP no longer allows `cdn.gpteng.co` or `rsms.me`, and `connect-src` is no longer `*`. Model downloads go to Hugging Face. The ONNX runtime is served with the app.
- The TLS stack behind AI provider requests and update checks is patched: rustls 0.23.46, rustls-webpki 0.103.16 and aws-lc-sys 0.47. `tar`, which unpacks macOS updates, is 0.4.46.
- Tauri is 2.12. Since 2.11.1, a remote page whose address starts with one of the app's scheme names is no longer mistaken for the app on Windows, so it cannot call the app's commands. The updater plugin is 2.14.1, which unpacks Windows updates with `zip` 9.
- PostgreSQL connections, SSL included, run on sqlx 0.8 and rustls 0.23. sqlx 0.7 held them on rustls 0.21, which no longer gets security fixes.

### Fixed

- Release assets are published on `v<version>`, the tag the README and changelog link to.
- After an update installs on macOS or Linux, the app restarts into the new version. The restart used to fail without a word, and the old version kept running until you quit it.
- On PostgreSQL, a query that returns no rows names its columns in one round trip to the server instead of three, which shows on a remote database.
- Saved passwords, SSH secrets and AI provider keys are now kept in the OS keychain: Windows Credential Manager, the macOS Keychain, or on Linux a Secret Service such as GNOME Keyring or KWallet. Since 2.2.0 they had been held in memory only and never read back, so AI keys were gone after a restart and a saved connection asked for its password every time.

## [2.4.0] - 2026-11-07

### Added

- **Star**, the Text to SQL mascot. It peeks over the status bar, opens Text to SQL when clicked, and reacts to a clean run or a failed one. Colour (White, Graphite), eyes (Cutout, Glossy, Lines, None) and mouth are chosen in Settings and kept on this device.
- The Text to SQL dialog shows how full the model window is, split into instructions, schema, sample values, examples, the question and the reply. Ollama's window is read from the server; other models use a known size, or no limit when the size is unknown. Compact drops the samples and examples so a small window still fits the schema.

## [2.3.0] - 2026-11-05

### Added

- **Every row is reachable.** The table grid pages, searches and sorts in SQL instead of over the first 1,000 rows. The header shows the real row count, and search matches `%` and `_` literally.
- **Excel export** writes a real `.xlsx` (one sheet per table, bold frozen header, numbers as numbers), for SQLite and now PostgreSQL. It used to write JSON into a `.xlsx` file.
- Tables without a primary key can be edited and deleted row by row (SQLite `rowid`, PostgreSQL `ctid`).
- SQLite views are listed in the sidebar, read-only. PostgreSQL views are read-only too.

### Changed

- New look: neutral graphite surfaces, an amber key mark for primary and foreign keys, sentence-case labels, and calmer dialogs, toasts, settings and safety-policy menu.
- The edit dialog checks values when you save, so you can type `-3.5` or clear a required field to retype it. BLOB columns are shown as their size and left untouched.

### Fixed

- **Edits and deletes on tables with a composite primary key used only the first key column**, so editing one row of a table keyed by `(EmployeeID, TerritoryID)` rewrote every row with that `EmployeeID`. They now use the whole key.
- Tables and columns whose names contain spaces, dashes or quotes (such as `Order Details`) failed to load. PostgreSQL tables with capital letters failed to load their columns.
- CSV and JSON exports stopped at 1,000 rows per table. CSV escaping is now RFC 4180, and BLOBs export as base64.
- SVG schema export wrote a `data:` URL instead of SVG. PNG export had a white background; it is now transparent at 2x.
- Deleting rows in SQLite broke on key values containing `'`.
- Pressing Delete while typing in the search box or the SQL editor offered to delete the ticked rows.
- An edit to a row someone else had already changed or deleted reported success.
- PostgreSQL two-column foreign keys appeared as four relations, index columns showed as `{a,b}`, and same-named tables in other schemas leaked their indexes.
- PostgreSQL `bigint` values above 2^53 were rounded, so an edit or delete could miss the row.
- User tables named like `sqlite1data` were hidden as if they were system tables.
- The schema sidebar overflowed its right edge and its counts did not line up.

## [2.2.2] - 2026-09-23

### Changed

- Settings → Agents, and the MCP docs, now say the copied config needs Node.js 22.5+ with `npx` on the PATH that Claude, Cursor, or VS Code uses. LiteDB does not install Node.

## [2.2.1] - 2026-09-23

### Fixed

- The window close button did nothing. Closing now has permission to destroy the window after the quit handler runs.

## [2.2.0] - 2026-09-14

### Changed

- **"Use SSL" is now "Require SSL", and the app obeys it.** Ticked requires an encrypted connection; unticked connects without encryption, the same as the MCP server. Previously the app ignored the box and tried TLS anyway, so a saved connection to a host that insists on TLS (Neon, RDS, most managed Postgres) worked unticked and will now fail until you tick it. The error says so.
- SQLite files are saved through a guarded write: LiteDB will not save over a database another program has open or has changed since you loaded it, and shows the state in the status bar instead of in a toast that disappears.

### Fixed

- A WAL-mode SQLite file could lose the app's edit, or be corrupted, when the MCP server had written to it earlier in the session.
- The table view reloads when an agent writes, without closing an open row edit or losing your scroll position.
- Settings logs: distinguish empty log files from read/clipboard failures with specific error details, and fall back to the browser clipboard API if the native clipboard plugin fails.

## [2.1.0] - 2025-09-08

### Added

- **PostgreSQL support**, connect, browse, and edit PostgreSQL databases alongside SQLite via the Connection Manager
- **Vector search & semantic search**, pgvector-powered similarity search with local embedding models (`all-MiniLM-L6-v2`, `bge-base-en-v1.5`, `bge-large-en-v1.5`) via Transformers.js; search by row ID or natural language text with cosine, L2, and inner product distance metrics
- **AI text-to-SQL agent**, context-aware RAG pipeline that introspects schema and injects it into LLM prompts; supports Ollama (local/privacy-first), OpenAI, GitHub, and Azure providers with driver-specific SQL validation
- **Schema visualization**, interactive ERD with drag-and-drop tables, auto-layout, foreign key relationship lines, and PNG/SVG export
- **Autosave & export**, automatic change persistence and query result export to CSV, Excel, and JSON
- **Batch operations & SQL scripting**, execute multiple statements with transaction support; save and reuse SQL scripts
- **Dual database switcher**, toggle between SQLite and PostgreSQL connections in the UI

### Changed

- Download badge and release links updated to v2.1.0

[2.7.0]: https://github.com/createdbyadham/LiteDB/releases/tag/v2.7.0
[2.6.2]: https://github.com/createdbyadham/LiteDB/releases/tag/v2.6.2
[2.6.1]: https://github.com/createdbyadham/LiteDB/releases/tag/v2.6.1
[2.6.0]: https://github.com/createdbyadham/LiteDB/releases/tag/v2.6.0
[2.5.0]: https://github.com/createdbyadham/LiteDB/releases/tag/v2.5.0
[2.4.0]: https://github.com/createdbyadham/LiteDB/releases/tag/v2.4.0
[2.3.0]: https://github.com/createdbyadham/LiteDB/releases/tag/app-v2.3.0
[2.2.2]: https://github.com/createdbyadham/LiteDB/releases/tag/app-v2.2.2
[2.2.1]: https://github.com/createdbyadham/LiteDB/releases/tag/app-v2.2.1
[2.2.0]: https://github.com/createdbyadham/LiteDB/releases/tag/app-v2.2.0
[2.1.0]: https://github.com/createdbyadham/LiteDB/releases/tag/app-v2.1.0
