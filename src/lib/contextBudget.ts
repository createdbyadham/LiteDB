// How much of a model's context window a Text-to-SQL request uses, split by
// what fills it. Pure, like promptBuilder.ts: it measures the exact messages
// buildTextToSqlMessages produces, so the meter cannot drift from what is sent.

import { buildTextToSqlMessages, type ChatMessage } from './promptBuilder';
import type { DatabaseSchema } from './schemaTypes';

/** Tokens requested for the reply (max_tokens). Shared with aiService. */
export const REPLY_TOKENS = 1000;

/** Worked examples sent when the request is not compacted. */
export const FEW_SHOT = 3;

export type BudgetKind = 'instructions' | 'schema' | 'samples' | 'examples' | 'question' | 'reply';

export interface BudgetSegment {
    kind: BudgetKind;
    label: string;
    tokens: number;
}

export interface ContextBudget {
    segments: BudgetSegment[];
    /** Everything sent plus the reply reserve. */
    total: number;
}

/**
 * Rough BPE token count without shipping a tokenizer.
 *
 * Words cost about one token per 4–5 letters, digits about one per 3, and
 * most punctuation a token each. Schema text is mostly short identifiers and
 * punctuation, where the usual "characters / 4" undercounts badly.
 */
export function estimateTokens(text: string): number {
    let tokens = 0;
    for (const piece of text.match(/[A-Za-z]+|\d+|[^\sA-Za-z\d]/g) ?? []) {
        if (/^[A-Za-z]/.test(piece)) tokens += Math.ceil(piece.length / 4.5);
        else if (/^\d/.test(piece)) tokens += Math.ceil(piece.length / 3);
        else tokens += 1;
    }
    return tokens;
}

/** Per-message framing the chat format adds around each message. */
const MESSAGE_OVERHEAD = 4;

function messageTokens(messages: ChatMessage[]): number {
    return messages.reduce((sum, m) => sum + estimateTokens(m.content) + MESSAGE_OVERHEAD, 0);
}

export function withoutSampleValues(schema: DatabaseSchema): DatabaseSchema {
    return {
        ...schema,
        tables: schema.tables.map(table => ({
            ...table,
            columns: table.columns.map(({ sampleValues: _drop, ...column }) => column),
        })),
    };
}

/**
 * Split a request into what the meter shows.
 *
 * Compact drops the sample values and the worked examples: the two parts that
 * help accuracy but are optional, so the prompt fits a small local window.
 */
export function measureContext(
    prompt: string,
    schema: DatabaseSchema | null,
    options: { compact?: boolean; now?: Date } = {},
): ContextBudget {
    const compact = options.compact ?? false;
    const now = options.now ?? new Date();
    const sent = compact && schema ? withoutSampleValues(schema) : schema;
    const messages = buildTextToSqlMessages(prompt, sent, { fewShot: compact ? 0 : FEW_SHOT, now });

    // Messages come out in a fixed order: instructions, then the schema if
    // any, then exemplars (a note and question/answer pairs), then the question.
    const instructions = messageTokens(messages.slice(0, 1));
    const hasSchema = !!sent;
    const schemaMessage = hasSchema ? messages.slice(1, 2) : [];
    const examples = messages.slice(1 + schemaMessage.length, -1);
    const question = messageTokens(messages.slice(-1));

    let schemaTokens = messageTokens(schemaMessage);
    let sampleTokens = 0;
    if (sent && !compact && sent.tables.some(t => t.columns.some(c => c.sampleValues?.length))) {
        const bare = buildTextToSqlMessages(prompt, withoutSampleValues(sent), { fewShot: 0, now });
        const bareSchema = messageTokens(bare.slice(1, 2));
        sampleTokens = Math.max(0, schemaTokens - bareSchema);
        schemaTokens = bareSchema;
    }

    const segments: BudgetSegment[] = [
        { kind: 'instructions', label: 'Instructions', tokens: instructions },
        { kind: 'schema', label: 'Schema', tokens: schemaTokens },
        { kind: 'samples', label: 'Sample values', tokens: sampleTokens },
        { kind: 'examples', label: 'Examples', tokens: messageTokens(examples) },
        { kind: 'question', label: 'Question', tokens: question },
        { kind: 'reply', label: 'Reply', tokens: REPLY_TOKENS },
    ];
    return { segments, total: segments.reduce((sum, s) => sum + s.tokens, 0) };
}

/** 950 → "950", 3240 → "3.2K", 128000 → "128K". */
export function formatTokens(n: number): string {
    if (n < 1000) return String(Math.round(n));
    // Windows are often powers of two: 4096 is "4K", not "4.1K".
    if (n % 1024 === 0) return `${n / 1024}K`;
    const k = n / 1000;
    return `${k >= 100 ? Math.round(k) : Math.round(k * 10) / 10}K`;
}

/**
 * Known context windows by model name, for providers that cannot tell us.
 * Longest prefix wins. Unknown models return null and the meter says so
 * rather than guessing a limit it would then warn about.
 */
const KNOWN_WINDOWS: [RegExp, number][] = [
    [/^gpt-5/i, 400_000],
    [/^gpt-4\.1/i, 1_047_576],
    [/^gpt-4o/i, 128_000],
    [/^gpt-4-turbo/i, 128_000],
    [/^gpt-4(?!o|\.)/i, 8_192],
    [/^gpt-3\.5/i, 16_385],
    [/^o[134](-|$)/i, 200_000],
    [/claude/i, 200_000],
    [/gemini/i, 1_000_000],
    [/llama-?3\.[123]|llama3\.[123]/i, 128_000],
    [/llama-?3(?![.\d])/i, 8_192],
    [/qwen/i, 32_768],
    [/mixtral|mistral/i, 32_768],
    [/deepseek/i, 64_000],
    [/gemma-?3/i, 128_000],
    [/gemma/i, 8_192],
    [/phi-?4/i, 16_384],
];

export function knownContextWindow(model: string): number | null {
    for (const [pattern, tokens] of KNOWN_WINDOWS) {
        if (pattern.test(model)) return tokens;
    }
    return null;
}
