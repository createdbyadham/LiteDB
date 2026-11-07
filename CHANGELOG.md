# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[2.4.0]: https://github.com/createdbyadham/LiteDB/releases/tag/v2.4.0
[2.3.0]: https://github.com/createdbyadham/LiteDB/releases/tag/v2.3.0
[2.2.2]: https://github.com/createdbyadham/LiteDB/releases/tag/v2.2.2
[2.2.1]: https://github.com/createdbyadham/LiteDB/releases/tag/v2.2.1
[2.2.0]: https://github.com/createdbyadham/LiteDB/releases/tag/v2.2.0
[2.1.0]: https://github.com/createdbyadham/LiteDB/releases/tag/v2.1.0
