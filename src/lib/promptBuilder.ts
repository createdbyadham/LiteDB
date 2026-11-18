// Text-to-SQL prompt construction, kept free of browser, Tauri and network
// dependencies so the eval harness in `evals/` can exercise the exact prompt
// the app ships. If this file gains an import from `@tauri-apps/*`, `openai`
// or the DOM, the eval harness stops measuring the shipped behaviour.

import { selectExemplars } from './fewShot';
import type { DatabaseSchema, SqlDialect } from './schemaTypes';

export interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

/**
 * Anti-substitution guidance.
 *
 * Measured failure mode on small local models: asked for a per-row value
 * computed across a group, they reach for GROUP BY or a self-join, which
 * collapses or duplicates rows and answers a different question. The SQL is
 * valid, so nothing downstream can detect it, only the prompt can.
 *
 * Deliberately scoped to the substitution itself. Rules about which columns to
 * project would fix some of the same cases for a different reason, and
 * bundling them would make the measurement meaningless.
 */
const ANTI_SUBSTITUTION_RULES = `  <guidance>
    <rule>If a value is computed across a group but must appear on every row, use a window function with OVER (PARTITION BY ...). GROUP BY is wrong here because it collapses the rows.</rule>
    <rule>For a ranking within a group, the top N rows per group, a running total, or a value taken from a neighbouring row, use a window function (ROW_NUMBER, RANK, DENSE_RANK, NTILE, LAG, LEAD, FIRST_VALUE, or an aggregate with OVER). Do not emulate these with a self-join or a correlated subquery.</rule>
  </guidance>
`;

/** Identifier quote character for a dialect. */
export function quoteCharFor(dialect: SqlDialect): string {
    return dialect === 'postgres' ? '"' : '`';
}

/**
 * Flatten a schema into the compact line-per-table form injected into the
 * system prompt. Deliberately terse: schema tokens dominate prompt cost and
 * every column is repeated on every request.
 */
export interface PromptOptions {
    /**
     * Frozen clock for the prompt's <current_date>. Injected rather than read
     * from the system clock so eval runs stay reproducible: a relative-date
     * question must resolve against a fixed date or the golden SQL drifts out
     * from under the case.
     */
    now?: Date;
    /**
     * Render columns as `table.column` instead of bare `column`.
     *
     * Hypothesis under test: bare names under a table header bind weakly, and
     * a model asked for "the order id" writes `orders.order_id`, borrowing
     * `order_id` from `order_items`, where it really exists. Qualifying every
     * name may remove that ambiguity, at the cost of roughly one extra token
     * per column on every request.
     */
    qualifyColumns?: boolean;
    /**
     * Include anti-substitution guidance steering the model toward window
     * functions where it would otherwise reach for GROUP BY or a self-join.
     */
    antiSubstitution?: boolean;
    /**
     * Number of retrieved few-shot exemplars to include. 0 disables them.
     * Exemplars use an unrelated schema on purpose, see fewShot.ts.
     */
    fewShot?: number;
}

export function serializeSchema(schema: DatabaseSchema, qualifyColumns = false): string {
    const quote = quoteCharFor(schema.dialect);
    const lines: string[] = [];
    for (const table of schema.tables) {
        const cols = table.columns
            .map((c) => {
                const name = qualifyColumns ? `${table.name}.${c.name}` : c.name;
                const pk = c.isPrimaryKey ? ' PK' : '';
                const nn = c.isNotNull ? ' NOT NULL' : '';
                // Enumerated columns are unguessable from name and type alone;
                // listing their values is what lets "in Germany" reach 'DE'.
                const samples = c.sampleValues?.length
                    ? ` [values: ${c.sampleValues.join(', ')}]`
                    : '';
                return `${name} ${c.type}${pk}${nn}${samples}`.trim();
            })
            .join(', ');
        lines.push(`table ${quote}${table.name}${quote}: ${cols}`);
    }
    return lines.join('\n');
}

/**
 * Build the message list sent to the model.
 *
 * `now` is injected rather than read from the clock so eval runs are
 * reproducible: a relative-date question ("orders this year") must resolve
 * against a fixed date or the golden SQL drifts out from under the case.
 */
export function buildTextToSqlMessages(
    prompt: string,
    schema: DatabaseSchema | null,
    options: PromptOptions = {},
): ChatMessage[] {
    const now = options.now ?? new Date();
    const messages: ChatMessage[] = [
        {
            role: 'system',
            content: `<system_instructions>
  <role>SQL Expert Assistant</role>
  <task>Convert natural language to SQL queries.</task>
  <constraints>
    <constraint>Only respond with the SQL query.</constraint>
    <constraint>No explanations.</constraint>
    <constraint>No other text or comments.</constraint>
    <constraint>Do not add markdown code blocks.</constraint>
    <constraint>Do not wrap the output in \`\`\`sql or \`\`\`.</constraint>
    <constraint>Return raw SQL text only.</constraint>
  </constraints>
  <current_date>${now.toISOString().split('T')[0]}</current_date>
${options.antiSubstitution ? ANTI_SUBSTITUTION_RULES : ''}</system_instructions>`,
        },
    ];

    if (schema) {
        messages.push({
            role: 'system',
            content: `<database_context>
  <dialect>${schema.dialect}</dialect>
  <quote_char>${quoteCharFor(schema.dialect)}</quote_char>
  <schema>
${serializeSchema(schema, options.qualifyColumns)}
  </schema>
  <instruction>Use only the provided schema. If the user asks for non-existing tables/columns, choose the closest match or state inability.</instruction>
</database_context>`,
        });
    }

    // Exemplars go after the schema and before the question, as real
    // conversational turns rather than a blob of text, instruction-tuned
    // models follow demonstrated turn structure more reliably than a list.
    // The preamble is load-bearing: without it the model has just been shown
    // tables that do not exist in its actual database.
    const exemplars = selectExemplars(prompt, options.fewShot ?? 0);
    if (exemplars.length > 0) {
        messages.push({
            role: 'system',
            content:
                '<examples_note>The next exchanges are worked examples of SQL style, ' +
                'written against an unrelated employees/departments schema. Follow their ' +
                'shape, never their tables or columns. Answer the final question using ' +
                'only the schema above.</examples_note>',
        });
        for (const exemplar of exemplars) {
            messages.push({ role: 'user', content: exemplar.question });
            messages.push({ role: 'assistant', content: exemplar.sql });
        }
    }

    messages.push({ role: 'user', content: prompt });
    return messages;
}

/**
 * The messages as a provider will accept them: every system message joined
 * into one, at the start, with the other turns in their order.
 *
 * The builders keep instructions, schema and the examples note as separate
 * system messages because the context meter measures them apart. Many chat
 * templates refuse that: Qwen, Mistral and Gemma served through llama.cpp,
 * LM Studio or vLLM answer 400 "System message must be at the beginning"
 * to any system message after the first. Every request goes through this.
 */
export function forProvider(messages: ChatMessage[]): ChatMessage[] {
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content);
    const rest = messages.filter((m) => m.role !== 'system');
    return system.length === 0 ? rest : [{ role: 'system', content: system.join('\n\n') }, ...rest];
}

/**
 * The answer without reasoning written into it: `<think>` blocks as some
 * servers return them (Qwen3, DeepSeek R1 and others through llama.cpp, LM
 * Studio or vLLM), one cut off by the token limit, and the end of one whose
 * start was in the prompt template.
 */
export function withoutThinking(text: string): string {
    let rest = text.replace(/<think>[\s\S]*?(?:<\/think>|$)/g, '');
    const close = rest.indexOf('</think>');
    if (close !== -1) rest = rest.slice(close + '</think>'.length);
    // The break after the reasoning is not part of the answer.
    return rest === text ? text : rest.replace(/^\s*\n/, '');
}

/**
 * The SQL in a model's reply. Models ignore the "no code fences" constraint
 * often enough that stripping is mandatory, not defensive, and small ones
 * wrap the query in a sentence ("Here is the query: ```sql ... ```"), so a
 * fenced block anywhere in the reply is taken as the answer.
 */
export function stripSqlFences(content: string): string {
    const text = withoutThinking(content).trim();
    const fenced = /```[a-z]*[ \t]*\r?\n?([\s\S]*?)```/i.exec(text);
    if (fenced && fenced[1].trim()) return fenced[1].trim();
    return text
        .replace(/^```[a-z]*\s*/i, '')
        .replace(/\s*```$/, '')
        .trim();
}

const SQL_START = new Set([
    'select', 'with', 'insert', 'update', 'delete', 'replace', 'merge', 'upsert', 'values', 'table',
    'create', 'alter', 'drop', 'truncate', 'rename', 'comment', 'grant', 'revoke',
    'explain', 'analyze', 'analyse', 'pragma', 'vacuum', 'reindex', 'attach', 'detach',
    'begin', 'start', 'commit', 'end', 'rollback', 'savepoint', 'release',
    'show', 'describe', 'set', 'reset', 'call', 'do', 'copy', 'refresh', 'cluster', 'listen', 'notify', 'lock',
]);

/**
 * Whether a reply reads as SQL rather than prose. Only the first word is
 * judged: a model that cannot answer says so in a sentence ("I cannot answer
 * that, there is no orders table"), and that sentence must not land in the
 * editor as if it were a query.
 */
export function looksLikeSql(text: string): boolean {
    const body = text.replace(/^(\s*(--[^\n]*(\n|$)|\/\*[\s\S]*?\*\/))*/, '').trimStart();
    if (body.startsWith('(')) return true;
    const word = /^[a-z_]+/i.exec(body)?.[0].toLowerCase();
    return !!word && SQL_START.has(word);
}

/**
 * Build the follow-up turn for execution-guided repair.
 *
 * Only ever called with a real engine error, a parse failure, an unknown
 * column, a rejected statement. A query that executes but answers the wrong
 * question produces no error, so there is nothing to feed back and no repair
 * is attempted. That asymmetry is the honest limit of this technique: it
 * fixes SQL that does not run, not SQL that runs and is wrong.
 */
export function buildRepairMessages(
    previous: ChatMessage[],
    failedSql: string,
    errorMessage: string,
): ChatMessage[] {
    return [
        ...previous,
        { role: 'assistant', content: failedSql },
        {
            role: 'user',
            content: `<execution_error>
  <message>${errorMessage}</message>
  <instruction>That query failed to run. Re-read the schema above, use only columns that exist on the tables you reference, and return a corrected query. Output raw SQL only.</instruction>
</execution_error>`,
        },
    ];
}

function schemaContext(schema: DatabaseSchema | null): ChatMessage[] {
    if (!schema) return [];
    return [
        {
            role: 'system',
            content: `<database_context>
  <dialect>${schema.dialect}</dialect>
  <schema>
${serializeSchema(schema)}
  </schema>
</database_context>`,
        },
    ];
}

/**
 * Ask for a plain-language explanation of a query the database rejected.
 *
 * Grounded in the real engine error and the real schema, so "no such column"
 * can be answered with the column that does exist rather than a guess.
 */
export function buildExplainErrorMessages(
    sql: string,
    errorMessage: string,
    schema: DatabaseSchema | null,
): ChatMessage[] {
    return [
        {
            role: 'system',
            content: `<system_instructions>
  <role>Database assistant</role>
  <task>Explain why a SQL query failed, for the person who ran it.</task>
  <constraints>
    <constraint>Two or three short sentences of plain prose: what went wrong, then how to fix it.</constraint>
    <constraint>Name the actual table or column involved, using the schema when it helps.</constraint>
    <constraint>No headings, no lists, no code blocks, and do not rewrite the whole query.</constraint>
  </constraints>
</system_instructions>`,
        },
        ...schemaContext(schema),
        {
            role: 'user',
            content: `<failed_query>
${sql}
</failed_query>
<error>${errorMessage}</error>`,
        },
    ];
}

/**
 * Ask for a corrected version of a query the database rejected, keeping what
 * it was trying to do. Raw SQL out, like Text to SQL, so the same fence
 * stripping and validation apply.
 */
export function buildFixQueryMessages(
    sql: string,
    errorMessage: string,
    schema: DatabaseSchema | null,
): ChatMessage[] {
    return [
        {
            role: 'system',
            content: `<system_instructions>
  <role>SQL Expert Assistant</role>
  <task>Correct a SQL query that failed to run.</task>
  <constraints>
    <constraint>Keep the query's intent; change only what the error requires.</constraint>
    <constraint>Use only tables and columns that exist in the schema.</constraint>
    <constraint>Only respond with the corrected SQL. No explanations, no comments, no markdown code blocks.</constraint>
  </constraints>
</system_instructions>`,
        },
        ...schemaContext(schema),
        {
            role: 'user',
            content: `<failed_query>
${sql}
</failed_query>
<error>${errorMessage}</error>`,
        },
    ];
}

/**
 * Ask for a plain-language explanation of a query that has not failed, what
 * it does and what to watch out for, with the planner's output when there is
 * one. The plan comes from plain EXPLAIN, never ANALYZE, so asking for an
 * explanation never runs the statement.
 */
export function buildExplainQueryMessages(sql: string, plan: string | null, schema: DatabaseSchema | null): ChatMessage[] {
    return [
        {
            role: 'system',
            content: `<system_instructions>
  <role>Database engineer explaining SQL to a colleague</role>
  <format>
    Start with one or two sentences on what the query returns or changes.
    Then a short bullet list of what matters: joins and what they match on, filters, grouping, ordering,
    and anything risky or slow, an UPDATE or DELETE without a WHERE, a full table scan in the plan,
    a missing index, a join that can multiply rows, implicit casts.
    Plain language. Markdown: short paragraphs, "- " bullets, \`inline code\`. No headings. Under 200 words.
  </format>
</system_instructions>`,
        },
        ...schemaContext(schema),
        {
            role: 'user',
            content: `<query>
${sql}
</query>${plan ? `\n<plan>\n${plan}\n</plan>` : ''}`,
        },
    ];
}
