// What Star says about an agent's statements. Pure, so it can be tested and
// reasoned about apart from the animation.

import type { AuditEntry } from '@/lib/auditLog';

export interface Narration {
  text: string;
  /** How Star reacts as well as what it says. */
  react?: 'nod' | 'shake' | 'attend' | 'wince';
}

/** What an MCP host calls itself (clientInfo.name) to what a person calls it. */
const HOSTS: [RegExp, string][] = [
  [/claude[-_ ]?code/i, 'Claude Code'],
  [/claude/i, 'Claude'],
  [/cursor/i, 'Cursor'],
  [/windsurf|codeium/i, 'Windsurf'],
  [/zed/i, 'Zed'],
  [/cline/i, 'Cline'],
  [/continue/i, 'Continue'],
  [/goose/i, 'Goose'],
  [/copilot|vscode|visual studio code/i, 'VS Code'],
  [/codex/i, 'Codex'],
  [/gemini/i, 'Gemini CLI'],
];

export function agentName(client: string | null | undefined): string {
  if (!client) return 'An agent';
  for (const [pattern, name] of HOSTS) if (pattern.test(client)) return name;
  return 'An agent';
}

/** The engine's own catalogue tables: reading them is reading the schema. */
const SYSTEM_TABLE = /^(sqlite_|pg_|information_schema)/i;

const isWrite = (e: AuditEntry) => e.kind !== 'read' && e.kind !== 'session';

/** Lists table names the way a sentence would: "orders", "orders and items", "orders and 2 more tables". */
export function tableList(tables: string[]): string {
  if (tables.length === 1) return tables[0];
  if (tables.length === 2) return `${tables[0]} and ${tables[1]}`;
  return `${tables[0]} and ${tables.length - 1} more tables`;
}

// A table name after FROM or JOIN: "quoted", [bracketed], `backticked` or bare (schema.table too).
const SOURCE = /\b(?:from|join)\s+(?:"([^"]+)"|\[([^\]]+)\]|`([^`]+)`|([A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)?))/gi;

/**
 * The tables a read names. The classifier records a target only for writes,
 * so a SELECT arrives with no table; this is enough to say what it reads,
 * not a parser. Subqueries in parentheses are skipped.
 */
export function readTables(sql: string): string[] {
  const found: string[] = [];
  for (const m of sql.matchAll(SOURCE)) {
    const name = (m[1] ?? m[2] ?? m[3] ?? m[4]).split('.').pop()!;
    if (!found.includes(name)) found.push(name);
  }
  return found;
}

/**
 * One line for a batch of an agent's statements, most important first:
 * something refused, something waiting on you, a change, a failure, and only
 * then the reads, which are most of what an agent does.
 *
 * `recentReads` are tables read moments ago, so a run of reads reads as one
 * sentence rather than a ticker.
 */
export function narrate(entries: AuditEntry[], recentReads: string[] = []): Narration | null {
  if (!entries.length) return null;
  const who = agentName(entries.find((e) => e.client)?.client);
  const on = (e: AuditEntry) => (e.table && !SYSTEM_TABLE.test(e.table) ? ` on ${e.table}` : '');

  const blocked = entries.find((e) => e.decision === 'blocked' || e.decision === 'declined');
  if (blocked) return { text: `Stopped ${who}: ${blocked.verb}${on(blocked)} isn't allowed here`, react: 'shake' };

  const pending = entries.find((e) => e.decision === 'pending');
  if (pending) return { text: `${who} wants to run ${pending.verb}${on(pending)}. It's waiting for your approval`, react: 'attend' };

  const failed = entries.find((e) => e.outcome === 'error');
  if (failed) return { text: `${who}'s ${failed.verb}${on(failed)} failed`, react: 'wince' };

  const changed = entries.find((e) => isWrite(e) && e.outcome === 'ok');
  if (changed) {
    const rows = changed.actualRows;
    const where = changed.table ? ` in ${changed.table}` : '';
    return {
      text:
        rows === null || rows === undefined
          ? `${who} ran ${changed.verb}${on(changed)}`
          : `${who} changed ${rows.toLocaleString()} ${rows === 1 ? 'row' : 'rows'}${where}`,
      react: 'nod',
    };
  }

  const tables = [...recentReads];
  for (const e of entries) {
    for (const t of e.table ? [e.table] : readTables(e.sql)) {
      if (!SYSTEM_TABLE.test(t) && !tables.includes(t)) tables.push(t);
    }
  }
  if (!tables.length) return { text: `${who} is looking at the schema` };
  return { text: `${who} is reading ${tableList(tables)}` };
}
