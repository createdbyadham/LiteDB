# Connect an agent

LiteDB already has the database open. The MCP server follows that connection —
no path, no URL, no restart when you switch databases. The status-bar policy is
the agent's policy (YOLO maps down to guarded).

You need Node 22.5+ on the PATH the host uses.

## In the app

Settings → **Agents**, or the **MCP** chip in the status bar.

- Green “Agents can see this connection” means the handoff file is on disk.
- **Add to Claude Desktop** merges `mcpServers.litedb` into
  `claude_desktop_config.json` (both the documented file and the Windows Store
  copy, if it exists). Fully quit Claude — tray too — then a new chat.
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

1. Does `execute_approved` prompt separately from `query`? That is the HITL claim.
2. Does the model relay the row count (`2 rows of 4 in orders`), or only say it
   needs approval?
3. Does it pause, or chain preview → execute on its own?

If (1) does not prompt, the host auto-ran the tool (Cursor auto-accept, or
`execute_approved` allowlisted). LiteDB cannot force that click. The preview
text is still the record; [`mcp/README.md`](../mcp/README.md#what-it-does-not-do)
is doing real work. SQLite is the file on disk, not unsaved editor state —
save first.
