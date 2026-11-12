// Inline suggestions: ghost text in the SQL editor, accepted with Tab.
//
// This module decides what goes to the model and what is kept of its answer.
// The statement around the cursor is split there into a prefix and a suffix,
// and the schema goes along as SQL comments: every column of the tables the
// statement reads, only the names of the others, capped so a request stays a
// few hundred tokens. What comes back is cleaned before it is shown: code
// fences go, so does text that repeats what is already on either side of the
// cursor, and it stops where the statement does.
//
// The editor side (the widget, Tab and Esc, when to ask) is
// components/SqlEditor/ghostText.ts. This file is free of CodeMirror and
// browser imports so the self-test can run it.

import type { ChatMessage } from './promptBuilder';
import type { SqlDialect } from './schemaTypes';
import { findTable, tablesIn, type CatalogColumn, type CatalogTable, type ColumnCatalog } from './sqlComplete';
import { tokenize } from './sqlTokenizer';
import { completionName } from './types';

/** Characters of the statement kept before the cursor; older text is dropped from the start. */
const PREFIX_CHARS = 1200;
/** Characters of the statement kept after the cursor. */
const SUFFIX_CHARS = 400;
/** Tables listed with their columns, and room for those columns. */
const MAX_TABLES_WITH_COLUMNS = 6;
const MAX_COLUMNS = 40;
const COLUMNS_CHARS = 900;
/** Room for the names of every other table. */
const NAMES_CHARS = 600;
/** A long script is read around the cursor only; no statement is that long. */
const WINDOW_BEFORE = 20_000;
const WINDOW_AFTER = 5_000;

/** Short answers: the rest of a clause, not an essay. */
export const INLINE_MAX_TOKENS = 64;
/** A statement ends at a `;` or a blank line, and so does a suggestion. */
export const INLINE_STOP = [';', '\n\n'];
/**
 * Room for a model that reasons before it answers (gpt-oss, the o-series,
 * Gemini 2.5, Claude 5). Reasoning counts against the reply's token limit, so
 * at INLINE_MAX_TOKENS such a model runs out before it writes anything. A
 * ceiling, not a target: the answer is still cut where the statement ends.
 */
export const INLINE_REASONING_TOKENS = 2048;

const isWordChar = (ch: string | undefined): boolean => ch !== undefined && /[A-Za-z0-9_$]/.test(ch);

// --- the statement at the cursor ---------------------------------------------------

/** The statement around the cursor, split there. */
export interface InlineContext {
    /** Offset of the statement's first character in the document. */
    from: number;
    /** Offset of the cursor. */
    pos: number;
    /** The statement from its start to the cursor. */
    prefix: string;
    /** The statement from the cursor to its end, its `;` included. */
    suffix: string;
}

interface Boundary {
    from: number;
    to: number;
    semicolon: boolean;
}

/**
 * Record the blank lines in a stretch of whitespace and comments between two
 * tokens. The cursor splits a run of whitespace, since what is typed there
 * becomes a token. Returns whether the cursor is inside a comment.
 */
function scanGap(text: string, from: number, to: number, cursor: number, out: Boundary[]): boolean {
    let inComment = false;
    let runStart = -1;
    let newlines = 0;
    const flush = (end: number) => {
        if (runStart >= 0 && newlines >= 2) out.push({ from: runStart, to: end, semicolon: false });
        runStart = -1;
        newlines = 0;
    };
    let i = from;
    while (i < to) {
        if (i === cursor) flush(i);
        const ch = text[i];
        if (ch === '-' && text[i + 1] === '-') {
            flush(i);
            let stop = text.indexOf('\n', i);
            if (stop === -1 || stop > to) stop = to;
            if (cursor > i && cursor <= stop) inComment = true;
            i = stop;
            continue;
        }
        if (ch === '/' && text[i + 1] === '*') {
            flush(i);
            const close = text.indexOf('*/', i + 2);
            const stop = close === -1 ? to : Math.min(to, close + 2);
            if (cursor > i && (cursor < stop || (close === -1 && cursor === stop))) inComment = true;
            i = stop;
            continue;
        }
        if (/\s/.test(ch)) {
            if (runStart < 0) runStart = i;
            if (ch === '\n') newlines++;
        } else {
            flush(i);
        }
        i++;
    }
    flush(to);
    return inComment;
}

/**
 * The statement the cursor is in, split at the cursor, or null where nothing
 * should be suggested: an empty statement, the middle of a word, a comment.
 * A statement ends at a top-level `;` or a blank line; a `;` in a string or a
 * comment does not count.
 */
export function inlineContext(doc: string, pos: number): InlineContext | null {
    if (pos < 0 || pos > doc.length) return null;
    // Mid-word: the rest of the word would be split by whatever goes in.
    if (isWordChar(doc[pos])) return null;
    const base = Math.max(0, pos - WINDOW_BEFORE);
    const text = doc.slice(base, Math.min(doc.length, pos + WINDOW_AFTER));
    const cursor = pos - base;

    const boundaries: Boundary[] = [];
    let previous = 0;
    for (const token of tokenize(text)) {
        if (scanGap(text, previous, token.start, cursor, boundaries)) return null;
        if (token.kind === 'punct' && token.value === ';' && token.depth === 0) {
            boundaries.push({ from: token.start, to: token.end, semicolon: true });
        }
        previous = token.end;
    }
    if (scanGap(text, previous, text.length, cursor, boundaries)) return null;

    let start = 0;
    let end = text.length;
    let semicolon = false;
    for (const b of boundaries) {
        if (b.to <= cursor) {
            start = b.to;
        } else if (b.from >= cursor) {
            end = b.from;
            semicolon = b.semicolon;
            break;
        }
    }
    while (start < cursor && /\s/.test(text[start])) start++;
    const prefix = text.slice(start, cursor);
    if (!prefix.trim()) return null;
    const suffix = text.slice(cursor, semicolon ? end + 1 : end).replace(/\s+$/, '');
    return { from: base + start, pos, prefix, suffix };
}

// --- the prompt ------------------------------------------------------------------------

export interface InlinePrompt {
    /** SQL comments: the dialect, then the tables the statement can use. Ends in a newline. */
    context: string;
    /** The statement up to the cursor, its start dropped if it is long. */
    prefix: string;
    /** The statement after the cursor, its end dropped if it is long. */
    suffix: string;
    /** Same key, same request: what answers are cached by. */
    key: string;
}

const DIALECT_NAME: Record<SqlDialect, string> = { sqlite: 'SQLite', postgres: 'PostgreSQL' };

function tableText(table: CatalogTable, catalog: ColumnCatalog): string {
    const name = completionName(table.table, catalog.dialect);
    if (catalog.dialect === 'postgres' && table.schema && table.schema !== catalog.defaultSchema) {
        return `${completionName(table.schema, 'postgres')}.${name}`;
    }
    return name;
}

function columnText(column: CatalogColumn, dialect: SqlDialect): string {
    const type = column.type.trim().slice(0, 24);
    return type ? `${completionName(column.name, dialect)} ${type}` : completionName(column.name, dialect);
}

/**
 * The schema as SQL comments: a dialect line, the columns of the tables the
 * statement reads, then only the names of the other tables. Both lists are
 * capped, so a large database does not turn every pause into a long prompt.
 */
export function schemaComment(dialect: SqlDialect, catalog: ColumnCatalog | null, statement: string): string {
    const lines = [`-- Dialect: ${DIALECT_NAME[dialect]}`];
    if (catalog && catalog.tables.length > 0) {
        const used: CatalogTable[] = [];
        for (const ref of tablesIn(statement)) {
            const table = findTable(catalog, ref);
            if (table && !used.includes(table)) used.push(table);
        }

        const detailed: CatalogTable[] = [];
        let budget = COLUMNS_CHARS;
        for (const table of used) {
            if (detailed.length >= MAX_TABLES_WITH_COLUMNS || budget <= 0) break;
            const parts: string[] = [];
            let length = 0;
            for (const column of table.columns) {
                const part = columnText(column, catalog.dialect);
                if (parts.length >= MAX_COLUMNS || (parts.length > 0 && length + part.length > budget)) break;
                parts.push(part);
                length += part.length + 2;
            }
            const rest = table.columns.length - parts.length;
            if (rest > 0) parts.push(`… ${rest} more`);
            budget -= length;
            detailed.push(table);
            lines.push(table.columns.length > 0 ? `-- Table ${tableText(table, catalog)} (${parts.join(', ')})` : `-- Table ${tableText(table, catalog)}`);
        }

        const others = catalog.tables.filter((t) => !detailed.includes(t)).map((t) => tableText(t, catalog));
        if (others.length > 0) {
            let list = '';
            let listed = 0;
            for (const name of others) {
                const next = list ? `${list}, ${name}` : name;
                if (next.length > NAMES_CHARS) break;
                list = next;
                listed++;
            }
            if (listed < others.length) list += `${list ? ', ' : ''}… ${others.length - listed} more`;
            lines.push(`-- ${detailed.length > 0 ? 'Other tables' : 'Tables'}: ${list}`);
        }
    }
    return `${lines.join('\n')}\n`;
}

/** The last `max` characters, starting at a line where one starts nearby. */
function keepEnd(text: string, max: number): string {
    if (text.length <= max) return text;
    const cut = text.length - max;
    const line = text.indexOf('\n', cut);
    return line !== -1 && line - cut < 200 && line + 1 < text.length ? text.slice(line + 1) : text.slice(cut);
}

/** The first `max` characters, ending at a line break where one is nearby. */
function keepStart(text: string, max: number): string {
    if (text.length <= max) return text;
    const line = text.lastIndexOf('\n', max);
    return line > max - 200 ? text.slice(0, line) : text.slice(0, max);
}

export function buildInlinePrompt(context: InlineContext, dialect: SqlDialect, catalog: ColumnCatalog | null): InlinePrompt {
    const header = schemaComment(dialect, catalog, context.prefix + context.suffix);
    const prefix = keepEnd(context.prefix, PREFIX_CHARS);
    const suffix = keepStart(context.suffix, SUFFIX_CHARS);
    return { context: header, prefix, suffix, key: `${header}\u0000${prefix}\u0000${suffix}` };
}

/** Fill-in-the-middle: the schema comments and the statement so far, then the suffix separately. */
export function fimPrompt(prompt: InlinePrompt): { prompt: string; suffix: string } {
    return { prompt: prompt.context + prompt.prefix, suffix: prompt.suffix };
}

/** For a model without fill-in-the-middle: the statement with a marker at the cursor. */
export function inlineChatMessages(prompt: InlinePrompt): ChatMessage[] {
    return [
        {
            role: 'system',
            content:
                'You are the autocomplete in a SQL editor. The statement being typed follows, with <CURSOR> where the cursor is. ' +
                'Continue the SQL at <CURSOR>: reply with only the text to insert there. No explanation, no code fences, and ' +
                'nothing that is already before or after <CURSOR>. Finish the current clause, or the statement if it is short. ' +
                'Start with a space when one is needed. Use only the tables and columns in the comments.',
        },
        { role: 'user', content: `${prompt.context}${prompt.prefix}<CURSOR>${prompt.suffix}` },
    ];
}

// --- reasoning models -------------------------------------------------------------------

/**
 * The answer without reasoning written into it: `<think>` blocks as some
 * servers return them, one cut off by the token limit, and the end of one
 * whose start was in the prompt template.
 */
function withoutThinking(text: string): string {
    let rest = text.replace(/<think>[\s\S]*?(?:<\/think>|$)/g, '');
    const close = rest.indexOf('</think>');
    if (close !== -1) rest = rest.slice(close + '</think>'.length);
    // The break after the reasoning is not part of the answer.
    return rest === text ? text : rest.replace(/^\s*\n/, '');
}

/** A chat model's reply, as far as a suggestion is concerned. */
export interface ChatReply {
    text: string;
    /** `length` when the reply hit its token limit. */
    finishReason: string | null;
    /** The provider reported reasoning beside the answer: its text, or a count of its tokens. */
    reasoned: boolean;
}

/**
 * A reply with no answer because the model spent it reasoning. At the short
 * suggestion budget a reasoning model runs out before it writes a word
 * (`length`), and a provider that applies stop sequences to the reasoning
 * ends it at the first `;` it thinks. Either way nothing comes back to show.
 */
export function spentOnThinking(reply: ChatReply): boolean {
    return !withoutThinking(reply.text).trim() && (reply.finishReason === 'length' || reply.reasoned);
}

// --- cleaning the answer -------------------------------------------------------------

/** Where the text before the cursor leaves off: inside a quote or a comment, and how many brackets are open. */
function lexState(sql: string): { depth: number; quote: string | null; comment: 'line' | 'block' | null } {
    let depth = 0;
    let quote: string | null = null;
    let comment: 'line' | 'block' | null = null;
    for (let i = 0; i < sql.length; i++) {
        const ch = sql[i];
        if (comment === 'line') {
            if (ch === '\n') comment = null;
            continue;
        }
        if (comment === 'block') {
            if (ch === '*' && sql[i + 1] === '/') {
                comment = null;
                i++;
            }
            continue;
        }
        if (quote) {
            if (ch === quote) {
                if (sql[i + 1] === quote) i++;
                else quote = null;
            }
            continue;
        }
        if (ch === '-' && sql[i + 1] === '-') {
            comment = 'line';
            i++;
        } else if (ch === '/' && sql[i + 1] === '*') {
            comment = 'block';
            i++;
        } else if (ch === "'" || ch === '"' || ch === '`') {
            quote = ch;
        } else if (ch === '(') {
            depth++;
        } else if (ch === ')') {
            depth = Math.max(0, depth - 1);
        }
    }
    return { depth, quote, comment };
}

/**
 * Where a suggestion stops: at the end of the statement (a `;` or a blank
 * line), or where it closes a bracket or quote that was open at the cursor
 * and that the text after the cursor already closes. That is the model
 * running into the suffix, `*) FROM t` where `)` is already there.
 */
function suggestionEnd(text: string, prefix: string, suffix: string): number {
    const state = lexState(prefix);
    const next = suffix.trimStart()[0];
    let open = state.depth;
    let own = 0;
    let quote = state.quote;
    let quoteFromPrefix = state.quote !== null;
    let comment = state.comment;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (comment === 'line') {
            if (ch !== '\n') continue;
            comment = null;
        } else if (comment === 'block') {
            if (ch === '*' && text[i + 1] === '/') {
                comment = null;
                i++;
            }
            continue;
        }
        if (quote) {
            if (ch === quote) {
                if (text[i + 1] === quote) {
                    i++;
                } else {
                    if (quoteFromPrefix && next === quote) return i;
                    quote = null;
                    quoteFromPrefix = false;
                }
            }
            continue;
        }
        if (ch === ';') return i;
        if (ch === '\n' && /^\n[ \t]*\n/.test(text.slice(i))) return i;
        if (ch === '-' && text[i + 1] === '-') {
            comment = 'line';
            i++;
        } else if (ch === '/' && text[i + 1] === '*') {
            comment = 'block';
            i++;
        } else if (ch === "'" || ch === '"' || ch === '`') {
            quote = ch;
            quoteFromPrefix = false;
        } else if (ch === '(') {
            own++;
        } else if (ch === ')') {
            if (own > 0) {
                own--;
            } else if (open > 0) {
                if (next === ')') return i;
                open--;
            }
        }
    }
    return text.length;
}

/**
 * Text that repeats the end of the prefix. Chat models often restate the
 * statement, or the word being typed (`e` → `email`); that overlap goes, but
 * only from the start of a word, never half of one. A fill-in-the-middle
 * model continues by design, so only an echo of the whole prefix is dropped:
 * after `FROM a`, `ardvarks` is the rest of `aardvarks`, not a repeat.
 */
function dropRepeatedPrefix(text: string, prefix: string, fim: boolean): string {
    if (!prefix) return text;
    if (fim) return text.startsWith(prefix) ? text.slice(prefix.length) : text;
    for (let k = Math.min(prefix.length, text.length); k > 0; k--) {
        const i = prefix.length - k;
        if (i > 0 && isWordChar(prefix[i - 1]) && isWordChar(prefix[i])) continue;
        if (text.startsWith(prefix.slice(i))) return text.slice(k);
    }
    return text;
}

const normalized = (text: string): string => text.replace(/\s+/g, ' ').trim().toLowerCase();

function sharedLength(a: string, b: string): number {
    let n = 0;
    while (n < a.length && n < b.length && a[n] === b[n]) n++;
    return n;
}

/**
 * A tail that repeats the start of the suffix, or runs on into it: the model
 * wrote `id FROM users` where ` FROM users` already follows the cursor.
 * Whitespace and case are ignored; brackets and quotes are suggestionEnd's.
 */
function dropSuffixOverlap(text: string, suffix: string): string {
    const after = normalized(suffix);
    if (!after) return text;
    for (let i = 0; i < text.length; i++) {
        if (i > 0 && isWordChar(text[i - 1]) && isWordChar(text[i])) continue;
        const tail = normalized(text.slice(i));
        // Tails only get shorter: once one has no word in it, none after it does.
        if (!/[A-Za-z0-9_]/.test(tail)) break;
        const shared = sharedLength(tail, after);
        // `id` is not a repeat of `identity`: a tail must end where a word does.
        const wholeWords = !(isWordChar(tail[tail.length - 1]) && isWordChar(after[tail.length]));
        if ((shared === tail.length && wholeWords) || shared === after.length || shared >= 12) return text.slice(0, i);
    }
    return text;
}

/**
 * What to show of a model's answer, or null if nothing is left. Strips
 * reasoning and code fences, drops text that repeats the prefix (see
 * dropRepeatedPrefix; `fim` says which kind of model answered), stops at the
 * end of the statement, and drops a tail that repeats the start of the suffix.
 */
export function cleanSuggestion(raw: string, prefix: string, suffix: string, options: { fim?: boolean } = {}): string | null {
    let text = withoutThinking(raw.replace(/\r\n?/g, '\n'));
    const fence = /^\s*```[\w+-]*[ \t]*\n?/.exec(text);
    if (fence) text = text.slice(fence[0].length);
    const close = text.indexOf('```');
    if (close !== -1) text = text.slice(0, close);
    text = text.replace(/<\/?CURSOR>/g, '');
    text = dropRepeatedPrefix(text, prefix, options.fim === true);
    text = text.slice(0, suggestionEnd(text, prefix, suffix));
    text = dropSuffixOverlap(text, suffix);
    text = text.replace(/\s+$/, '');
    // One space between `WHERE ` and the suggestion, not two.
    if (/[ \t]$/.test(prefix)) text = text.replace(/^[ \t]+/, '');
    return text.trim() ? text : null;
}

// --- the suggestion on screen ------------------------------------------------------

/** A suggestion shown at `pos`. */
export interface Ghost {
    pos: number;
    text: string;
}

/**
 * The suggestion after an edit that replaced `from`..`to` with `inserted`:
 * typing its next characters keeps the rest, anything else clears it.
 */
export function typeThrough(ghost: Ghost, from: number, to: number, inserted: string): Ghost | null {
    if (from !== ghost.pos || to !== ghost.pos || !inserted) return null;
    if (inserted.length >= ghost.text.length || !ghost.text.startsWith(inserted)) return null;
    return { pos: ghost.pos + inserted.length, text: ghost.text.slice(inserted.length) };
}

/**
 * What is left of a suggestion made for `asked` now that the editor is at
 * `now`. An answer arrives after the user has typed on, and is still good if
 * they typed its first characters at the cursor and changed nothing else.
 */
export function reconcile(asked: InlineContext, now: InlineContext, suggestion: string): string | null {
    if (now.suffix !== asked.suffix || !now.prefix.startsWith(asked.prefix)) return null;
    const typed = now.prefix.slice(asked.prefix.length);
    if (typed.length >= suggestion.length || !suggestion.startsWith(typed)) return null;
    return suggestion.slice(typed.length);
}

// --- asking ------------------------------------------------------------------------------

export type SuggestFetch = (prompt: InlinePrompt) => Promise<string | null>;

export type SuggestOutcome =
    | { kind: 'ok'; text: string | null; cached: boolean }
    /** A request is already in flight; the proxy cannot cancel it, so it is not joined by another. */
    | { kind: 'busy' }
    /** The last request failed; waiting before trying again. */
    | { kind: 'cooling' }
    | { kind: 'failed'; error: unknown };

export interface SuggesterOptions {
    cacheSize?: number;
    /** Pause after a failure, so a provider that is down is not asked on every keystroke. */
    backoffMs?: number;
    /** A request still unanswered after this counts as failed and frees the slot. */
    timeoutMs?: number;
    now?: () => number;
}

/**
 * When to ask: one request at a time, answers cached by prompt, and a pause
 * after a failure. Knows nothing about the editor, so the self-test can drive
 * it with a fake model and a fake clock.
 */
export class InlineSuggester {
    private inFlight = false;
    private retryAt = 0;
    private epoch = 0;
    private readonly cache = new Map<string, string | null>();
    private readonly cacheSize: number;
    private readonly backoffMs: number;
    private readonly timeoutMs: number;
    private readonly now: () => number;

    constructor(private readonly fetch: SuggestFetch, options: SuggesterOptions = {}) {
        this.cacheSize = options.cacheSize ?? 50;
        this.backoffMs = options.backoffMs ?? 30_000;
        this.timeoutMs = options.timeoutMs ?? 45_000;
        this.now = options.now ?? Date.now;
    }

    get busy(): boolean {
        return this.inFlight;
    }

    async suggest(prompt: InlinePrompt): Promise<SuggestOutcome> {
        if (this.cache.has(prompt.key)) {
            const text = this.cache.get(prompt.key) ?? null;
            // Most recently used goes last; the oldest is evicted first.
            this.cache.delete(prompt.key);
            this.cache.set(prompt.key, text);
            return { kind: 'ok', text, cached: true };
        }
        if (this.inFlight) return { kind: 'busy' };
        if (this.now() < this.retryAt) return { kind: 'cooling' };
        this.inFlight = true;
        const epoch = this.epoch;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const timeout = new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error('The model did not answer in time.')), this.timeoutMs);
            });
            const text = await Promise.race([this.fetch(prompt), timeout]);
            // Settings changed while it was out: the answer is from the old model.
            if (epoch === this.epoch) this.remember(prompt.key, text);
            return { kind: 'ok', text, cached: false };
        } catch (error) {
            if (epoch === this.epoch) this.retryAt = this.now() + this.backoffMs;
            return { kind: 'failed', error };
        } finally {
            clearTimeout(timer);
            this.inFlight = false;
        }
    }

    /** Forget cached answers and any pause, after the provider or model changes. */
    reset(): void {
        this.epoch++;
        this.cache.clear();
        this.retryAt = 0;
    }

    private remember(key: string, text: string | null): void {
        this.cache.set(key, text);
        while (this.cache.size > this.cacheSize) {
            const oldest = this.cache.keys().next().value;
            if (oldest === undefined) break;
            this.cache.delete(oldest);
        }
    }
}
