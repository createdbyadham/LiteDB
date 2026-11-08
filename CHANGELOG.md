# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Inline suggestions** in the SQL editor, off by default (Settings → AI). After a pause in typing, the model's suggestion shows as grey text after the cursor: `Tab` accepts it, `Esc` dismisses it, and typing its next characters keeps the rest. Ollama is asked fill-in-the-middle, which FIM-trained models such as qwen2.5-coder complete best; other providers, and models that refuse it, are asked through chat. Suggestions can have a smaller model of their own. Each pause sends the statement you are writing, your table names and the columns of the tables it reads to the provider. They never appear while the column popup is open or on a connection tagged production, and accepting one marks the tab as written by AI, so its writes still ask first in Unrestricted and the audit log names the model.

### Security

- The TLS stack behind AI provider requests and update checks is patched: rustls 0.23.46, rustls-webpki 0.103.16 and aws-lc-sys 0.47. `tar`, which unpacks macOS updates, is 0.4.46.
- Tauri is 2.12. Since 2.11.1, a remote page whose address starts with one of the app's scheme names is no longer mistaken for the app on Windows, so it cannot call the app's commands. The updater plugin is 2.14.1, which unpacks Windows updates with `zip` 9.

## [2.5.0] - 2026-11-08

### Added

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
- Agents see every PostgreSQL schema (litedb-mcp 0.1.6); a table outside the search path is named `schema.table`. The handoff the MCP server follows carries the SSL mode, CA certificate and production tag, and a connection behind SSH goes through the app's tunnel while it is open.

### Removed

- sql.js and what it needed: Save, the guarded write and its lock, and reloading the whole file when another program changed it. SQLite's own locking now handles a second writer, waiting up to five seconds for it.
- The limit of three saved PostgreSQL connections.
- Leftovers from the Lovable / GPT Engineer template: the GPT Engineer script, the `rsms.me` stylesheet and the social-image tags in `index.html`, a second toaster (Sonner) that nothing used, unused shadcn components and hooks, `@tailwindcss/typography`, and template Tailwind settings.

### Security

- The webview CSP no longer allows `cdn.gpteng.co` or `rsms.me`, and `connect-src` is no longer `*`. Model downloads go to Hugging Face. The ONNX runtime is served with the app.

### Fixed

- Release assets are published on `v<version>`, the tag the README and changelog link to.
- macOS installers are Developer ID signed and notarized. Windows installers are Authenticode-signed, so the download is not an unsigned file Gatekeeper or SmartScreen rejects.

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

- **"Use SSL" is now "Require SSL", and the app obeys it.** Ticked requires an encrypted connection; unticked connects without encryption — the same as the MCP server. Previously the app ignored the box and tried TLS anyway, so a saved connection to a host that insists on TLS (Neon, RDS, most managed Postgres) worked unticked and will now fail until you tick it. The error says so.
- SQLite files are saved through a guarded write: LiteDB will not save over a database another program has open or has changed since you loaded it, and shows the state in the status bar instead of in a toast that disappears.

### Fixed

- A WAL-mode SQLite file could lose the app's edit, or be corrupted, when the MCP server had written to it earlier in the session.
- The table view reloads when an agent writes, without closing an open row edit or losing your scroll position.
- Settings logs: distinguish empty log files from read/clipboard failures with specific error details, and fall back to the browser clipboard API if the native clipboard plugin fails.

## [2.1.0] - 2025-09-08

### Added

- **PostgreSQL support** — connect, browse, and edit PostgreSQL databases alongside SQLite via the Connection Manager
- **Vector search & semantic search** — pgvector-powered similarity search with local embedding models (`all-MiniLM-L6-v2`, `bge-base-en-v1.5`, `bge-large-en-v1.5`) via Transformers.js; search by row ID or natural language text with cosine, L2, and inner product distance metrics
- **AI text-to-SQL agent** — context-aware RAG pipeline that introspects schema and injects it into LLM prompts; supports Ollama (local/privacy-first), OpenAI, GitHub, and Azure providers with driver-specific SQL validation
- **Schema visualization** — interactive ERD with drag-and-drop tables, auto-layout, foreign key relationship lines, and PNG/SVG export
- **Autosave & export** — automatic change persistence and query result export to CSV, Excel, and JSON
- **Batch operations & SQL scripting** — execute multiple statements with transaction support; save and reuse SQL scripts
- **Dual database switcher** — toggle between SQLite and PostgreSQL connections in the UI

### Changed

- Download badge and release links updated to v2.1.0

[2.5.0]: https://github.com/createdbyadham/LiteDB/releases/tag/v2.5.0
[2.4.0]: https://github.com/createdbyadham/LiteDB/releases/tag/v2.4.0
[2.3.0]: https://github.com/createdbyadham/LiteDB/releases/tag/app-v2.3.0
[2.2.2]: https://github.com/createdbyadham/LiteDB/releases/tag/app-v2.2.2
[2.2.1]: https://github.com/createdbyadham/LiteDB/releases/tag/app-v2.2.1
[2.2.0]: https://github.com/createdbyadham/LiteDB/releases/tag/app-v2.2.0
[2.1.0]: https://github.com/createdbyadham/LiteDB/releases/tag/app-v2.1.0
