# Connect an agent

LiteDB already has the database open. The MCP server follows that connection —
no path, no URL, no restart when you switch databases. The status-bar policy is
the agent's policy (YOLO maps down to guarded), and a connection tagged
production starts read-only for the agent as well. Quitting the app removes the
handoff, including any Postgres password, so the agent cannot keep using the
last database.

The handoff carries the connection's SSL mode and CA certificate. A Postgres
connection behind SSH goes through the app's tunnel, so the agent reaches that
database only while LiteDB has it open.

Requires Node.js 22.5+ with `npx` on the PATH that Claude, Cursor, or VS Code uses. LiteDB does not install Node.

## In the app

Settings → **Agents**, or the **MCP** chip in the status bar.

- Green “Agents can see this connection” means the handoff file is on disk.
  It is removed when you disconnect or quit.
- **Add to Claude Desktop** merges `mcpServers.litedb` into
  `claude_desktop_config.json` — always the documented file, plus the Windows
  Store copy when the Store version is installed. Fully quit Claude — tray too —
  then a new chat.
- Everyone else: copy the snippet for Claude Code, Cursor, OpenCode, or VS Code.

`mcpServers` is a **top-level** key, sibling of `preferences`. Nesting it inside
`preferences` is invalid JSON and Claude will ignore it.

## The 15-second config

Windows:

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

Claude Code:

```bash
claude mcp add litedb --scope user -- npx -y litedb-mcp
```

MCP servers load at host startup. Add the entry, then start a **new** session.

Without the app (CI), set `LITEDB_SQLITE_PATH` or `LITEDB_DATABASE_URL`. Env
wins over the handoff. Details: [`mcp/README.md`](../mcp/README.md).

## Tutorial: two prompts

Connect in LiteDB first. Then in the agent:

1. **“What’s in this database?”** — should call `list_tables` / `describe_table`.
2. **“Delete the shipped orders.”** — should `query` a DELETE, return a preview
   and a token, and **not** run it yet.

Watch, in this order:

1. When the agent calls `execute_approved`, LiteDB shows the request: the
   statement, `Affects 2 of 4 rows in orders`, and the two rows it deletes.
   Nothing runs until you click Approve there. Decline, and the agent is told
   nothing ran.
2. Does the model relay the row count, or only say it needs approval?
3. If you take longer than 50 seconds, the agent hears `WAITING FOR APPROVAL IN
   LITEDB` and should call again with the same token.

Hosts that run tools without asking (Cursor's auto-run, or `execute_approved`
allowlisted) still stop at LiteDB's window. With Settings → Agents → *Ask in
LiteDB* off, the host's prompt is the only check, and the preview text is the
record; [`mcp/README.md`](../mcp/README.md#what-it-does-not-do) says what
neither stops. For SQLite, the agent works on the file itself; edits made in
the app are already there.
