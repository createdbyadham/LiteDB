import OpenAI from "openai";
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { loadAllApiKeys, adoptLegacyApiKeys, markLegacyApiKeysMigrated } from './secretStorage';
import {
  buildExplainErrorMessages,
  buildExplainQueryMessages,
  buildFixQueryMessages,
  buildRepairMessages,
  buildTextToSqlMessages,
  stripSqlFences,
  type ChatMessage,
} from './promptBuilder';
import { attachSampleValues, type QueryRunner } from './schemaSamples';
import type { DatabaseSchema } from './schemaTypes';
import { FEW_SHOT, REPLY_TOKENS, knownContextWindow, withoutSampleValues } from './contextBudget';
import { INLINE_MAX_TOKENS, INLINE_STOP, cleanSuggestion, fimPrompt, inlineChatMessages, type InlinePrompt } from './inlineSuggest';

export type { ColumnSchema, DatabaseSchema, SqlDialect, TableSchema } from './schemaTypes';

export const AI_PROVIDERS = ['openai', 'anthropic', 'gemini', 'openai-compatible', 'ollama'] as const;

/**
 * Hosted providers with a fixed address. Anthropic and Google both serve the
 * OpenAI chat API, so they share the client below and only need their key.
 */
const HOSTED_ENDPOINTS: Partial<Record<AIProvider, string>> = {
  anthropic: 'https://api.anthropic.com/v1/',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai/',
};

/** Providers whose address the user types: everything not hosted. */
export function needsEndpoint(provider: AIProvider): boolean {
  return provider === 'openai-compatible' || provider === 'ollama';
}
export type AIProvider = (typeof AI_PROVIDERS)[number];

export type AIProviderConfig = {
  apiKey: string;
  endpoint?: string;
  modelName?: string;
  /**
   * The model for inline suggestions, when it should not be the one above:
   * a small fill-in-the-middle model (qwen2.5-coder:1.5b) answers in a
   * fraction of the time a chat model takes. Empty means the same model.
   */
  inlineModelName?: string;
};

export type AISettings = {
  activeProvider: AIProvider;
  configs: Record<AIProvider, AIProviderConfig>;
  /**
   * Whether to include a few distinct values of low-cardinality text columns
   * in the schema sent to the model. Materially improves accuracy on
   * enumerated columns ('DE' vs 'Germany'), at the cost of putting real cell
   * values in the prompt, so it is a visible choice, not a silent default.
   */
  includeSampleValues: boolean;
  /**
   * Ghost-text suggestions in the SQL editor. Off by default: every pause in
   * typing sends the statement and table names to the provider, which is
   * for the user to choose, not to discover.
   */
  inlineSuggestions: boolean;
};

export const defaultSettings: AISettings = {
  activeProvider: 'ollama',
  configs: {
    openai: {
      apiKey: '',
      modelName: 'gpt-4o-mini',
      inlineModelName: ''
    },
    anthropic: {
      apiKey: '',
      modelName: 'claude-sonnet-5-5',
      inlineModelName: 'claude-haiku-5-5'
    },
    gemini: {
      apiKey: '',
      modelName: 'gemini-2.5-flash',
      inlineModelName: ''
    },
    'openai-compatible': {
      apiKey: '',
      endpoint: '',
      modelName: '',
      inlineModelName: ''
    },
    ollama: {
      apiKey: 'ollama',
      endpoint: 'http://localhost:11434/v1',
      modelName: 'llama3',
      inlineModelName: ''
    }
  },
  includeSampleValues: true,
  inlineSuggestions: false
};

type StoredProviderConfig = {
  endpoint?: string;
  modelName?: string;
  inlineModelName?: string;
};

type StoredAISettings = {
  activeProvider: AIProvider;
  configs: Record<AIProvider, StoredProviderConfig>;
  includeSampleValues?: boolean;
  inlineSuggestions?: boolean;
};

/** GitHub Models / Azure used to be first-class; they are just OpenAI-compatible endpoints now. */
function coerceProvider(value: unknown): AIProvider {
  if (typeof value === 'string' && (AI_PROVIDERS as readonly string[]).includes(value)) return value as AIProvider;
  if (value === 'github' || value === 'azure') return 'openai-compatible';
  return defaultSettings.activeProvider;
}

function storedConfig(
  configs: Record<string, StoredProviderConfig> | undefined,
  key: string,
): StoredProviderConfig | undefined {
  return configs?.[key];
}

function mergeWithDefaults(stored: Partial<StoredAISettings>): AISettings {
  const settings: AISettings = {
    activeProvider: stored.activeProvider ?? defaultSettings.activeProvider,
    configs: { ...defaultSettings.configs },
    includeSampleValues:
      stored.includeSampleValues ?? defaultSettings.includeSampleValues,
    inlineSuggestions: stored.inlineSuggestions ?? defaultSettings.inlineSuggestions,
  };

  for (const provider of AI_PROVIDERS) {
    const storedConfig = stored.configs?.[provider];
    if (!storedConfig) continue;

    settings.configs[provider] = {
      ...settings.configs[provider],
      apiKey: '',
      endpoint: storedConfig.endpoint ?? settings.configs[provider].endpoint,
      modelName: storedConfig.modelName ?? settings.configs[provider].modelName,
      inlineModelName: storedConfig.inlineModelName ?? settings.configs[provider].inlineModelName,
    };
  }

  return settings;
}

function readStoredSettings(): StoredAISettings | null {
  const savedSettings = localStorage.getItem('aiSettings');
  if (!savedSettings) return null;

  const parsed = JSON.parse(savedSettings);
  if (!parsed.configs) return null;

  const raw = parsed.configs as Record<string, StoredProviderConfig>;
  const compatible =
    storedConfig(raw, 'openai-compatible') ??
    (parsed.activeProvider === 'azure' ? storedConfig(raw, 'azure') : undefined) ??
    (parsed.activeProvider === 'github' ? storedConfig(raw, 'github') : undefined) ??
    storedConfig(raw, 'github') ??
    storedConfig(raw, 'azure');

  const configs = {
    openai: {
      endpoint: raw.openai?.endpoint,
      modelName: raw.openai?.modelName,
      inlineModelName: raw.openai?.inlineModelName,
    },
    anthropic: {
      modelName: raw.anthropic?.modelName,
      inlineModelName: raw.anthropic?.inlineModelName,
    },
    gemini: {
      modelName: raw.gemini?.modelName,
      inlineModelName: raw.gemini?.inlineModelName,
    },
    'openai-compatible': {
      endpoint: compatible?.endpoint,
      modelName: compatible?.modelName,
      inlineModelName: compatible?.inlineModelName,
    },
    ollama: {
      endpoint: raw.ollama?.endpoint,
      modelName: raw.ollama?.modelName,
      inlineModelName: raw.ollama?.inlineModelName,
    },
  } as Record<AIProvider, StoredProviderConfig>;

  return {
    activeProvider: coerceProvider(parsed.activeProvider),
    configs,
    includeSampleValues: parsed.includeSampleValues,
    inlineSuggestions: parsed.inlineSuggestions === true,
  };
}

export function saveNonSecretSettings(settings: AISettings): void {
  const toStore: StoredAISettings = {
    activeProvider: settings.activeProvider,
    configs: Object.fromEntries(
      AI_PROVIDERS.map((provider) => [
        provider,
        {
          endpoint: settings.configs[provider].endpoint,
          modelName: settings.configs[provider].modelName,
          inlineModelName: settings.configs[provider].inlineModelName,
        },
      ]),
    ) as Record<AIProvider, StoredProviderConfig>,
    includeSampleValues: settings.includeSampleValues,
    inlineSuggestions: settings.inlineSuggestions,
  };

  localStorage.setItem('aiSettings', JSON.stringify(toStore));
}

let cachedSettings: AISettings | null = null;

export function loadAISettings(): AISettings {
  const stored = readStoredSettings();
  if (!stored) return defaultSettings;
  return mergeWithDefaults(stored);
}

export async function loadAISettingsAsync(): Promise<AISettings> {
  const settings = loadAISettings();

  const apiKeys = await loadAllApiKeys();
  if (!apiKeys['openai-compatible']) {
    let preferAzure = false;
    try {
      const raw = JSON.parse(localStorage.getItem('aiSettings') || 'null');
      preferAzure = raw?.activeProvider === 'azure';
    } catch {
      preferAzure = false;
    }
    apiKeys['openai-compatible'] = await adoptLegacyApiKeys(preferAzure);
  } else {
    markLegacyApiKeysMigrated();
  }
  for (const provider of AI_PROVIDERS) {
    settings.configs[provider] = {
      ...settings.configs[provider],
      apiKey: apiKeys[provider] || settings.configs[provider].apiKey,
    };
  }

  cachedSettings = settings;
  return settings;
}

function getSettings(): AISettings {
  return cachedSettings ?? loadAISettings();
}

/**
 * Build a client for an explicit provider and config.
 *
 * Taking the config as an argument rather than reading the saved settings is
 * what lets the settings dialog test a key the user has typed but not yet
 * saved. Testing the *previous* credentials and reporting success would be
 * worse than not testing at all.
 */
function clientFor(provider: AIProvider, config: AIProviderConfig) {
  // The OpenAI SDK refuses an empty key even when the server ignores it
  // (Ollama, LM Studio, and some compatible proxies).
  const apiKey = config.apiKey || (needsEndpoint(provider) ? 'local' : '');

  const baseURL = needsEndpoint(provider) ? config.endpoint?.trim() || undefined : HOSTED_ENDPOINTS[provider];
  if (needsEndpoint(provider) && !baseURL) {
    throw new Error('Set an endpoint for this provider.');
  }

  return new OpenAI({
    baseURL,
    apiKey: apiKey,
    dangerouslyAllowBrowser: true,
    fetch: async (url, init) => {
      // Convert headers to Record<string, string>
      const headers: Record<string, string> = {};
      if (init?.headers) {
        new Headers(init.headers).forEach((value, key) => {
          headers[key] = value;
        });
      }
      
      // Force Origin to localhost to bypass Ollama's CORS check
      headers['Origin'] = 'http://localhost';

      try {
        console.log('Invoking proxy_request with url:', url);
        if (typeof tauriInvoke !== 'function') {
          console.error('tauriInvoke is not a function:', tauriInvoke);
          throw new Error('tauriInvoke is not defined');
        }

        const response = await tauriInvoke<{
          status: number;
          statusText: string;
          headers: Record<string, string>;
          body: string;
        }>('proxy_request', {
          url: url.toString(),
          method: init?.method || 'GET',
          headers,
          body: init?.body ? String(init.body) : null,
        });

        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      } catch (e) {
        console.error('Proxy request failed:', e);
        throw e;
      }
    }
  });
}

function createClient() {
  const settings = getSettings();
  return clientFor(settings.activeProvider, settings.configs[settings.activeProvider]);
}

/** Fallback model when none is configured. */
function defaultModelFor(provider: AIProvider): string {
  switch (provider) {
    case 'ollama':
      return 'llama3';
    case 'anthropic':
      return 'claude-sonnet-5-5';
    case 'gemini':
      return 'gemini-2.5-flash';
    default:
      return 'gpt-4o-mini';
  }
}

/**
 * Send the smallest possible completion, retrying with the newer parameter
 * name if the model rejects the older one.
 *
 * Newer models reject `max_tokens` in favour of `max_completion_tokens`. A
 * connection test that failed on that would report a bad key when the key is
 * fine, which is the one thing a test must not do.
 */
async function pingModel(client: OpenAI, model: string): Promise<void> {
  const base = {
    model,
    messages: [{ role: 'user' as const, content: 'ping' }],
  };
  try {
    await client.chat.completions.create({ ...base, max_tokens: 1 });
  } catch (error) {
    if (!/max_tokens|max_completion_tokens/i.test(String(error))) throw error;
    await client.chat.completions.create({ ...base, max_completion_tokens: 1 });
  }
}

export interface ConnectionTestResult {
  ok: boolean;
  /** The provider's own message. Shown verbatim, it is usually specific. */
  error?: string;
  /** The model actually tested, after defaulting. */
  model?: string;
}

// Re-create client when settings change
window.addEventListener('aiSettingsChanged', () => {
  noFillInMiddle.clear();
  void loadAISettingsAsync().then(() => {
    client = createClient();
  });
});

void loadAISettingsAsync().then(() => {
  client = createClient();
});

let client = createClient();

// Hold current schema context in-memory. It's ephemeral and recomputed on connection/load.
let currentSchema: DatabaseSchema | null = null;

/** Size of the active model's context window, and where that number came from. */
export interface ContextWindow {
  tokens: number | null;
  /** Shown under the meter, so an assumed number is never presented as measured. */
  source: string;
  /** For Ollama: the most the model itself supports, when it is more than the window in use. */
  modelMax?: number;
}

const windowCache = new Map<string, ContextWindow>();

/** GET or POST through the Tauri proxy, as the OpenAI client does. Null on any failure. */
async function proxyJson(url: string, method: 'GET' | 'POST', body?: unknown): Promise<Record<string, unknown> | null> {
  try {
    const response = await tauriInvoke<{ status: number; body: string }>('proxy_request', {
      url,
      method,
      headers: { 'Content-Type': 'application/json', Origin: 'http://localhost' },
      body: body === undefined ? null : JSON.stringify(body),
    });
    if (response.status < 200 || response.status >= 300) return null;
    return JSON.parse(response.body) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Ollama's window is a runtime setting (num_ctx), not a property of the
 * model, and a prompt longer than it is cut from the start, which drops the
 * schema first. Ask the server rather than assume: a loaded model reports
 * the window it runs with, and a Modelfile may set num_ctx.
 */
async function ollamaWindow(endpoint: string, model: string): Promise<ContextWindow> {
  const base = endpoint.trim().replace(/\/+$/, '').replace(/\/v1$/, '');
  const wanted = model.includes(':') ? model : `${model}:latest`;

  let modelMax: number | undefined;
  const show = await proxyJson(`${base}/api/show`, 'POST', { model, name: model });
  if (show) {
    const info = (show.model_info ?? {}) as Record<string, unknown>;
    const max = Object.entries(info).find(([key]) => key.endsWith('.context_length'))?.[1];
    if (typeof max === 'number') modelMax = max;
  }

  const ps = await proxyJson(`${base}/api/ps`, 'GET');
  const loaded = Array.isArray(ps?.models)
    ? (ps.models as Record<string, unknown>[]).find(m => m.name === wanted || m.model === wanted)
    : undefined;
  if (typeof loaded?.context_length === 'number') {
    return { tokens: loaded.context_length, source: 'as loaded in Ollama', modelMax };
  }

  const numCtx = /(?:^|\n)\s*num_ctx\s+(\d+)/.exec(String(show?.parameters ?? ''));
  if (numCtx) return { tokens: Number(numCtx[1]), source: 'num_ctx in its Modelfile', modelMax };

  return { tokens: 4096, source: 'assumed Ollama default', modelMax };
}

/** Room for a short explanation of an error: a few sentences, not an essay. */
const EXPLAIN_TOKENS = 220;

/** One completion with the active provider, and its model unless another is given. */
async function complete(
  messages: ChatMessage[],
  maxTokens: number,
  temperature: number,
  options: { model?: string; stop?: string[]; maxRetries?: number } = {},
): Promise<string> {
  const settings = getSettings();
  const model = options.model || settings.configs[settings.activeProvider].modelName || defaultModelFor(settings.activeProvider);
  const response = await client.chat.completions.create(
    {
      messages: messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
      temperature,
      // Claude refuses temperature and top_p together.
      ...(settings.activeProvider === 'anthropic' ? {} : { top_p: 1.0 }),
      max_tokens: maxTokens,
      model,
      ...(options.stop ? { stop: options.stop } : {}),
    },
    options.maxRetries === undefined ? undefined : { maxRetries: options.maxRetries },
  );
  return response.choices[0]?.message.content ?? '';
}

/** The model inline suggestions use: their own if one is set, otherwise the provider's. */
function inlineModelFor(settings: AISettings): string {
  const config = settings.configs[settings.activeProvider];
  return config.inlineModelName?.trim() || config.modelName || defaultModelFor(settings.activeProvider);
}

/**
 * Endpoint and model pairs that refused fill-in-the-middle while chat
 * worked: a model without an insert template ("does not support insert"),
 * or a server without /completions. Asked through chat from then on, so a
 * pause costs one request, not two.
 */
const noFillInMiddle = new Set<string>();

/** A 4xx that means "not like this", unlike 408 and 429, which mean "not now". */
function refusedRequest(error: unknown): boolean {
  return (
    error instanceof OpenAI.APIError &&
    typeof error.status === 'number' &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408 &&
    error.status !== 429
  );
}

/** An inline suggestion through chat, for providers and models without fill-in-the-middle. */
async function chatSuggestion(prompt: InlinePrompt, model: string): Promise<string | null> {
  const messages = inlineChatMessages(prompt);
  let text: string;
  try {
    text = await complete(messages, INLINE_MAX_TOKENS, 0, { model, stop: INLINE_STOP, maxRetries: 0 });
  } catch (error) {
    // Some models refuse `stop`. The answer is cut where the statement ends anyway.
    if (!refusedRequest(error) || !/\bstop\b/i.test(error instanceof Error ? error.message : '')) throw error;
    text = await complete(messages, INLINE_MAX_TOKENS, 0, { model, maxRetries: 0 });
  }
  return cleanSuggestion(text, prompt.prefix, prompt.suffix);
}

export const aiService = {
  setSchema(schema: DatabaseSchema) {
    currentSchema = schema;
  },
  /** The schema the next request will send, for measuring it. */
  getSchema(): DatabaseSchema | null {
    return currentSchema;
  },
  /** The active provider and the model that will actually run. */
  activeModel(): { provider: AIProvider; model: string } {
    const settings = getSettings();
    const config = settings.configs[settings.activeProvider];
    return { provider: settings.activeProvider, model: config.modelName || defaultModelFor(settings.activeProvider) };
  },
  /**
   * The active model's context window. Asked of Ollama, looked up by name
   * otherwise, and null when unknown, the meter then shows usage without
   * inventing a limit to warn about.
   */
  async contextWindow(): Promise<ContextWindow> {
    const settings = getSettings();
    const provider = settings.activeProvider;
    const config = settings.configs[provider];
    const model = config.modelName || defaultModelFor(provider);
    const key = `${provider}|${config.endpoint ?? ''}|${model}`;
    const cached = windowCache.get(key);
    if (cached) return cached;

    let result: ContextWindow;
    if (provider === 'ollama' && config.endpoint) {
      result = await ollamaWindow(config.endpoint, model);
    } else {
      const known = knownContextWindow(model);
      result = known
        ? { tokens: known, source: 'published limit' }
        : { tokens: null, source: 'window unknown for this model' };
    }
    // An assumed Ollama default may change once the model is loaded; ask again next time.
    if (result.source !== 'assumed Ollama default') windowCache.set(key, result);
    return result;
  },
  /**
   * The model currently configured to generate SQL.
   *
   * Recorded in the audit log so an entry says which model wrote the
   * statement. "A model deleted these rows" is a much weaker record than
   * "qwen2.5-coder:7b deleted these rows", especially after switching
   * providers.
   */
  activeModelName(): string | null {
    const settings = getSettings();
    return settings.configs[settings.activeProvider].modelName ?? null;
  },
  /**
   * Whether inline suggestions are on. Read from storage rather than the
   * cached settings, which reload asynchronously, so switching them off
   * applies at the very next pause.
   */
  inlineSuggestionsEnabled(): boolean {
    try {
      return loadAISettings().inlineSuggestions;
    } catch {
      return false;
    }
  },
  /** The model inline suggestions use, for the audit log. */
  inlineModelName(): string {
    return inlineModelFor(getSettings());
  },
  /**
   * Ghost text for the cursor: the text to insert there, cleaned, or null
   * when the model has nothing usable.
   *
   * Ollama is asked fill-in-the-middle, with the text after the cursor sent
   * as `suffix`: FIM-trained models such as qwen2.5-coder complete that far
   * better than they follow a chat prompt. A model or server that refuses it
   * is asked through chat instead, as the other providers are.
   */
  async suggestInline(prompt: InlinePrompt): Promise<string | null> {
    const settings = getSettings();
    const provider = settings.activeProvider;
    const model = inlineModelFor(settings);
    const fimKey = `${settings.configs[provider].endpoint ?? ''}|${model}`;
    if (provider !== 'ollama' || noFillInMiddle.has(fimKey)) return chatSuggestion(prompt, model);
    try {
      const fim = fimPrompt(prompt);
      const response = await client.completions.create(
        { model, prompt: fim.prompt, suffix: fim.suffix, max_tokens: INLINE_MAX_TOKENS, temperature: 0, stop: INLINE_STOP },
        { maxRetries: 0 },
      );
      return cleanSuggestion(response.choices[0]?.text ?? '', prompt.prefix, prompt.suffix, { fim: true });
    } catch (error) {
      if (!refusedRequest(error)) throw error;
      const text = await chatSuggestion(prompt, model);
      noFillInMiddle.add(fimKey);
      return text;
    }
  },
  /**
   * The models a provider says it has, so they can be picked rather than
   * typed from memory.
   *
   * Uses the OpenAI-compatible `/models` endpoint. A host that does not
   * implement it leaves the field typeable; an empty list is a normal
   * outcome, not an error the user has to interpret.
   */
  async listModels(provider: AIProvider, config: AIProviderConfig): Promise<string[]> {
    const client = clientFor(provider, config);
    const response = await client.models.list();
    return response.data
      .map((model) => model.id)
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
  },
  /**
   * Check that the configured provider, key and model actually work, by
   * doing the smallest real thing: a one-token completion.
   *
   * Listing models is not enough, it proves the key is valid but not that
   * the chosen model exists or is accessible to this account, which is the
   * failure people actually hit.
   */
  async testConnection(
    provider: AIProvider,
    config: AIProviderConfig,
  ): Promise<ConnectionTestResult> {
    const model = config.modelName || defaultModelFor(provider);
    try {
      await pingModel(clientFor(provider, config), model);
      return { ok: true, model };
    } catch (error) {
      return {
        ok: false,
        model,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
  /**
   * Set the schema, enriching enumerated columns with sample values when the
   * user has left that enabled. Failure to sample is not failure to connect:
   * the plain schema is still installed.
   */
  async setSchemaWithSamples(schema: DatabaseSchema, runQuery: QueryRunner): Promise<void> {
    if (!getSettings().includeSampleValues) {
      currentSchema = schema;
      return;
    }
    try {
      currentSchema = await attachSampleValues(schema, runQuery);
    } catch {
      currentSchema = schema;
    }
  },
  clearSchema() {
    currentSchema = null;
  },
  /**
   * Generate SQL for a natural-language prompt.
   *
   * When `validate` is supplied, a statement that fails to compile is fed back
   * to the model once with the engine's own error message. This recovers a
   * failure class no prompt wording fixed, hallucinated column names, which
   * the database reports precisely.
   *
   * `validate` compiles rather than executes (see sqlValidator.ts), which is
   * what lets the loop cover writes. The previous version dry-ran the query
   * and was gated behind the read-only guard, so it could only ever check
   * SELECTs, and a SELECT that fails to run is the case the user was least
   * likely to be hurt by.
   */
  async generateSqlQuery(
    prompt: string,
    validate?: (sql: string) => Promise<string | null>,
    options: { compact?: boolean } = {},
  ): Promise<string> {
    try {
      const settings = getSettings();
      const config = settings.configs[settings.activeProvider];
      // Shared with the connection test, so the model the test checks is the
      // model that actually runs.
      const modelName = config.modelName || defaultModelFor(settings.activeProvider);

      // K=3 retrieved exemplars. Measured on the eval harness as the single
      // largest win for a small local model (+8.3pp overall, +8.9pp on
      // held-out cases it was never tuned against) and the plateau: K=4
      // scored identically for more tokens and latency. Costs a strong model
      // ~31% more prompt tokens for no gain, which is a routing decision
      // rather than a reason to withhold it from everyone.
      // Compact (chosen in the dialog's context meter) drops the sample values
      // and the examples so the request fits a small window.
      const schema = options.compact && currentSchema ? withoutSampleValues(currentSchema) : currentSchema;
      let messages = buildTextToSqlMessages(prompt, schema, { fewShot: options.compact ? 0 : FEW_SHOT });

      // One extra round at most: a second failure means the model is not
      // converging, and a third request is latency the user pays for nothing.
      const maxAttempts = validate ? 2 : 1;
      let sql = '';

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const response = await client.chat.completions.create({
          messages: messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
          temperature: 0,
          top_p: 1.0,
          max_tokens: REPLY_TOKENS,
          model: modelName
        });

        sql = stripSqlFences(response.choices[0].message.content || '');
        if (!validate || attempt === maxAttempts - 1) return sql;

        // No read-only gate here, deliberately. `validate` compiles the
        // statement instead of running it, so a write is as safe to check as
        // a read, and gating on read-only is precisely what stopped the old
        // loop from catching the errors that mattered.
        const error = await validate(sql);
        if (!error) return sql;

        messages = buildRepairMessages(messages, sql, error);
      }

      return sql;
    } catch (error) {
      console.error('Error generating SQL query:', error);
      throw error;
    }
  },
  /**
   * Explain, in two or three sentences, why a query failed. Uses the engine's
   * real error and the schema, so it can point at the column that does exist.
   */
  async explainError(sql: string, error: string): Promise<string> {
    const text = await complete(buildExplainErrorMessages(sql, error, currentSchema), EXPLAIN_TOKENS, 0.2);
    if (!text.trim()) throw new Error('The model returned an empty explanation.');
    return text.trim();
  },
  /**
   * A corrected version of a query that failed, keeping its intent. When
   * `validate` is supplied the fix is compiled against the live database and,
   * if it still fails, sent back once with the new error, as Text to SQL does.
   */
  async fixQuery(sql: string, error: string, validate?: (sql: string) => Promise<string | null>): Promise<string> {
    let messages = buildFixQueryMessages(sql, error, currentSchema);
    const attempts = validate ? 2 : 1;
    let fixed = '';
    for (let attempt = 0; attempt < attempts; attempt++) {
      fixed = stripSqlFences(await complete(messages, REPLY_TOKENS, 0));
      if (!fixed) throw new Error('The model returned no SQL.');
      if (!validate || attempt === attempts - 1) break;
      const failure = await validate(fixed);
      if (!failure) break;
      messages = buildRepairMessages(messages, fixed, failure);
    }
    return fixed;
  },
  /**
   * Explain a query that has not failed: what it does and what to watch out
   * for. `plan` is plain EXPLAIN output, which describes the statement
   * without running it. Sample values are left out; the shape is enough.
   */
  async explainQuery(sql: string, plan: string | null): Promise<string> {
    const schema = currentSchema ? withoutSampleValues(currentSchema) : null;
    const text = await complete(buildExplainQueryMessages(sql, plan, schema), 700, 0.2);
    if (!text.trim()) throw new Error('The model returned an empty explanation.');
    return text.trim();
  }
};