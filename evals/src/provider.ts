// Model access for the harness.
//
// Mirrors the provider matrix the app ships (OpenAI, GitHub Models, Azure
// OpenAI, Ollama) but talks to them directly rather than through the Tauri
// proxy, which does not exist outside the desktop shell.

import OpenAI from 'openai';
import type { ChatMessage } from '../../src/lib/promptBuilder';

export interface ProviderConfig {
    provider: string;
    model: string;
    baseURL?: string;
    apiKey: string;
}

export interface GenerationResult {
    content: string;
    latencyMs: number;
    promptTokens: number | null;
    completionTokens: number | null;
}

const DEFAULT_MODELS: Record<string, string> = {
    openai: 'gpt-4o-mini',
    github: 'openai/gpt-4o-mini',
    azure: 'gpt-4o-mini',
    ollama: 'qwen2.5-coder:7b',
};

function requireEnv(name: string, provider: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Provider "${provider}" needs ${name} to be set.`);
    }
    return value;
}

export function resolveProvider(provider: string, modelOverride?: string): ProviderConfig {
    const model = modelOverride || DEFAULT_MODELS[provider];
    if (!model) throw new Error(`Unknown provider "${provider}".`);

    switch (provider) {
        case 'openai':
            return { provider, model, apiKey: requireEnv('OPENAI_API_KEY', provider) };

        case 'github':
            return {
                provider,
                model,
                baseURL: 'https://models.github.ai/inference',
                apiKey:
                    process.env.GITHUB_MODELS_TOKEN ||
                    requireEnv('GITHUB_TOKEN', provider),
            };

        case 'azure':
            return {
                provider,
                model,
                baseURL: requireEnv('AZURE_OPENAI_ENDPOINT', provider),
                apiKey: requireEnv('AZURE_OPENAI_API_KEY', provider),
            };

        case 'ollama':
            return {
                provider,
                model,
                baseURL: process.env.OLLAMA_HOST || 'http://localhost:11434/v1',
                // Ollama ignores the key but the OpenAI client requires one.
                apiKey: 'ollama',
            };

        default:
            throw new Error(`Unknown provider "${provider}".`);
    }
}

export function createClient(config: ProviderConfig): OpenAI {
    return new OpenAI({
        apiKey: config.apiKey,
        baseURL: config.baseURL,
        maxRetries: 2,
    });
}

/**
 * Which request parameters a given model actually accepts.
 *
 * The chat-completions surface is not uniform. Newer OpenAI models reject
 * `max_tokens` and require `max_completion_tokens`; Ollama's compatibility
 * layer knows only the older name; reasoning models reject `temperature` and
 * `top_p` outright. Hardcoding either shape breaks half the provider matrix,
 * so the shape is negotiated once per model and remembered.
 */
interface RequestShape {
    tokenParam: 'max_tokens' | 'max_completion_tokens';
    sampling: boolean;
}

const shapeCache = new Map<string, RequestShape>();

function defaultShape(config: ProviderConfig): RequestShape {
    // Ollama's OpenAI-compatible endpoint only implements max_tokens.
    const legacy = config.provider === 'ollama';
    return { tokenParam: legacy ? 'max_tokens' : 'max_completion_tokens', sampling: true };
}

/** Adjust the shape in response to a 400, or return null if unrecognised. */
function adaptShape(shape: RequestShape, message: string): RequestShape | null {
    if (/max_completion_tokens/i.test(message) && shape.tokenParam === 'max_tokens') {
        return { ...shape, tokenParam: 'max_completion_tokens' };
    }
    if (/max_tokens/i.test(message) && shape.tokenParam === 'max_completion_tokens') {
        return { ...shape, tokenParam: 'max_tokens' };
    }
    if (/temperature|top_p/i.test(message) && shape.sampling) {
        return { ...shape, sampling: false };
    }
    return null;
}

export async function generate(
    client: OpenAI,
    config: ProviderConfig,
    messages: ChatMessage[],
): Promise<GenerationResult> {
    const started = Date.now();
    let shape = shapeCache.get(config.model) ?? defaultShape(config);

    // At most two adaptations: one for the token parameter, one for sampling.
    for (let attempt = 0; ; attempt++) {
        // temperature 0 / top_p 1 matches the app and keeps runs comparable.
        // Models that reject them run at their own defaults, which the console
        // notes, because it makes that run less reproducible.
        const params: Record<string, unknown> = {
            model: config.model,
            messages,
            [shape.tokenParam]: 1000,
        };
        if (shape.sampling) {
            params.temperature = 0;
            params.top_p = 1.0;
        }

        try {
            const response = await client.chat.completions.create(
                params as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
            );
            shapeCache.set(config.model, shape);
            return {
                content: response.choices[0]?.message?.content ?? '',
                latencyMs: Date.now() - started,
                promptTokens: response.usage?.prompt_tokens ?? null,
                completionTokens: response.usage?.completion_tokens ?? null,
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const next = attempt < 2 ? adaptShape(shape, message) : null;
            if (!next) throw error;

            if (!next.sampling && shape.sampling) {
                process.stderr.write(
                    `note: ${config.model} rejects temperature/top_p; ` +
                    `running at model defaults, so this run is less reproducible\n`,
                );
            }
            shape = next;
        }
    }
}
