# Roadmap

What is being built, roughly in order. Issues and discussions are where the
order changes: if something here matters to you, say so there.

## Now

- **Approve agent writes in LiteDB.** An agent's write waits in the LiteDB
  window with its row count and the rows it changes, and runs only when you
  click Approve, even when the agent's app runs tools without asking.
- **Undo for agent writes**, from the audit log.
- **Inline suggestions** in the SQL editor, from a local or hosted model.
- **MCP without Node.** The app is the server: agents start `LiteDB --mcp`,
  so *Add to Claude Desktop* points at a file that is guaranteed to exist, and
  approval is a call inside the app instead of a file handshake.

## Next

- **List the server** in the MCP Registry, Glama, Smithery and
  awesome-mcp-servers, and ship a Claude Desktop extension (`.mcpb`).
- **A public leaderboard: the best local model for Text-to-SQL.** The
  benchmark in [`evals/`](./evals) is rerunnable and has a held-out split.
  Publish rankings by GPU memory ("best for 8 GB"), rerun them when a big open
  model ships, and let Settings → AI recommend a model from them.

## Later

- sqlite-vec, so vector search works on SQLite (today it needs pgvector).
- DuckDB: drop in a CSV or Parquet file and ask questions in plain English.
- MySQL.

## Good first issues

Small, well-contained, and a tour of one part of the codebase each.
[`docs/architecture.md`](docs/architecture.md) says where things live.

| Idea | Where to start |
| --- | --- |
| A keyboard shortcut sheet (press `?`) listing every shortcut | `src/lib/commands.ts`, `src/components/CommandPalette.tsx` |
| Filter the Audit panel by agent, decision or table | `src/components/SqlEditor/AuditLogView.tsx` |
| Export the audit log as CSV | `src/components/SqlEditor/AuditLogView.tsx`, `src/lib/db/sqlLiteral.ts` (`formatRows`) |
| Step through several waiting agent requests instead of oldest-first only | `src/components/AgentApprovalDialog.tsx` |
| Choose the default row limit for new editor tabs in Settings | `src/components/SqlEditor/index.tsx`, `src/components/ui/settings-dialog.tsx` |
| Export as JSON Lines (`.jsonl`) | `src/components/ExportDialog.tsx`, `src/lib/db/client.ts` |
| CSV import: choose the text encoding (UTF-16, Latin-1) | `src/components/ImportDialog.tsx`, `src/lib/db/csv.ts` |
| "Duplicate" for a saved connection | `src/components/Connections/ConnectionsView.tsx` |
| Copy a column's name from the grid header's menu | `src/components/DataGrid/index.tsx` |
| Export the schema diagram as Mermaid ER text | `src/components/SchemaVisualizer/` |
| Show relative times in History ("5 minutes ago") | `src/components/SqlEditor/SidePanel.tsx` |
| Remember the editor/results split position | `src/components/SqlEditor/index.tsx` |
