# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[2.1.0]: https://github.com/createdbyadham/LiteDB/releases/tag/v2.1.0
