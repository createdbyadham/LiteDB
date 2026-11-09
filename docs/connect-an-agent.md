# Connect an agent

LiteDB is the MCP server. Your agent's app — Claude Desktop, Claude Code,
Cursor, VS Code — starts `LiteDB --mcp`, which connects to the LiteDB window
you have open. There is nothing else to install: no Node, no npm package.

The agent follows the connection on screen — no path, no URL, no restart when
you switch databases. The status-bar policy is the agent's policy (YOLO maps
down to guarded), and a connection tagged production starts read-only for the
agent as well. Its queries run on the app's own connection, so a Postgres
password stays in the app, and a database behind SSH is reached through the
app's tunnel while LiteDB has it open.

While LiteDB is closed, the agent still sees its tools, and every call says to
open LiteDB. Once the window is up, the next call goes through.

## In the app

Settings → **Agents**, or the **MCP** chip in the status bar.

- Green “Agents can see this connection” means a database is open for agents.
- **Add to Claude Desktop** merges `mcpServers.litedb` into
  `claude_desktop_config.json` — always the documented file, plus the Windows
  Store copy when the Store version is installed. Fully quit Claude — tray too —
  then a new chat.
- Everyone else: copy the snippet for Claude Code, Cursor, OpenCode, or VS Code.
  The snippets carry this install's path.

`mcpServers` is a **top-level** key, sibling of `preferences`. Nesting it inside
`preferences` is invalid JSON and Claude will ignore it.

## The 15-second config

Windows (the default install path; Settings → Agents copies yours):

```json
{
  "mcpServers": {
    "litedb": {
      "command": "C:\\Users\\you\\AppData\\Local\\LiteDB\\LiteDB.exe",
      "args": ["--mcp"]
    }
  }
}
```

macOS: `"command": "/Applications/LiteDB.app/Contents/MacOS/LiteDB"`.
Linux: the AppImage's path, or `litedb` from the AUR package. Flatpak:
`"command": "flatpak", "args": ["run", "--command=litedb", "com.adhamehab.litedb", "--mcp"]`.

Claude Code:

```bash
claude mcp add litedb --scope user -- /Applications/LiteDB.app/Contents/MacOS/LiteDB --mcp
```

MCP servers load at host startup. Add the entry, then start a **new** session.

## Without the app

On a machine without LiteDB — CI, a server — the same tools ship as the npm
package `litedb-mcp` (Node 22.5+ with `npx` on the host's PATH): set
`LITEDB_SQLITE_PATH` or `LITEDB_DATABASE_URL`. Run alongside the app, it
follows the window through a handoff file instead. Details:
[`mcp/README.md`](../mcp/README.md).

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

## Letting an agent work on its own

For an agent that edits a database with nobody watching, turn on Settings →
Agents → **Let agents make small changes without asking** for that connection,
and set how many rows one call may change. The status bar says so for as long
as it is on, and it is not available on a connection tagged production.

With it on, the agent's `write` tool runs a change in one call when it is an
INSERT of listed rows, or an UPDATE or DELETE with a WHERE clause, and changes
no more rows than the limit. The rows are counted before it runs, and the write
is rolled back if it changes more while it runs. It is still in the audit log,
marked as run without approval, and Undo still works for a single statement.

Everything else still waits for approval: schema and permission changes, an
UPDATE or DELETE with no WHERE clause, DROP, TRUNCATE, an upsert, an INSERT fed
by a SELECT, and anything over the limit. `write` returns those as a preview
with a token and the reason, and `query` never writes at all. To run those
unattended too, turn *Ask in LiteDB* off and let the host run
`execute_approved` without asking.
