# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[2.2.1]: https://github.com/createdbyadham/LiteDB/releases/tag/v2.2.1
[2.2.0]: https://github.com/createdbyadham/LiteDB/releases/tag/v2.2.0
[2.1.0]: https://github.com/createdbyadham/LiteDB/releases/tag/v2.1.0
