import OpenAI from "openai";
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { loadAllApiKeys, adoptLegacyApiKeys, markLegacyApiKeysMigrated } from './secretStorage';
import { buildRepairMessages, buildTextToSqlMessages, stripSqlFences } from './promptBuilder';
import { attachSampleValues, type QueryRunner } from './schemaSamples';
import type { DatabaseSchema } from './schemaTypes';

export type { ColumnSchema, DatabaseSchema, SqlDialect, TableSchema } from './schemaTypes';

export const AI_PROVIDERS = ['openai', 'openai-compatible', 'ollama'] as const;
export type AIProvider = (typeof AI_PROVIDERS)[number];

export type AIProviderConfig = {
  apiKey: string;
  endpoint?: string;
  modelName?: string;
};

export type AISettings = {
  activeProvider: AIProvider;
  configs: Record<AIProvider, AIProviderConfig>;
  /**
   * Whether to include a few distinct values of low-cardinality text columns
   * in the schema sent to the model. Materially improves accuracy on
   * enumerated columns ('DE' vs 'Germany'), at the cost of putting real cell
   * values in the prompt — so it is a visible choice, not a silent default.
   */
  includeSampleValues: boolean;
};

export const defaultSettings: AISettings = {
  activeProvider: 'ollama',
  configs: {
    openai: {
      apiKey: '',
      modelName: 'gpt-4o-mini'
    },
    'openai-compatible': {
      apiKey: '',
      endpoint: '',
      modelName: ''
    },
    ollama: {
      apiKey: 'ollama',
      endpoint: 'http://localhost:11434/v1',
      modelName: 'llama3'
    }
  },
  includeSampleValues: true
};

type StoredProviderConfig = {
  endpoint?: string;
  modelName?: string;
};

type StoredAISettings = {
  activeProvider: AIProvider;
  configs: Record<AIProvider, StoredProviderConfig>;
  includeSampleValues?: boolean;
};

/** GitHub Models / Azure used to be first-class; they are just OpenAI-compatible endpoints now. */
function coerceProvider(value: unknown): AIProvider {
  if (value === 'openai' || value === 'ollama' || value === 'openai-compatible') return value;
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
  };

  for (const provider of AI_PROVIDERS) {
    const storedConfig = stored.configs?.[provider];
    if (!storedConfig) continue;

    settings.configs[provider] = {
      ...settings.configs[provider],
      apiKey: '',
      endpoint: storedConfig.endpoint ?? settings.configs[provider].endpoint,
      modelName: storedConfig.modelName ?? settings.configs[provider].modelName,
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
    },
    'openai-compatible': {
      endpoint: compatible?.endpoint,
      modelName: compatible?.modelName,
    },
    ollama: {
      endpoint: raw.ollama?.endpoint,
      modelName: raw.ollama?.modelName,
    },
  } as Record<AIProvider, StoredProviderConfig>;

  return {
    activeProvider: coerceProvider(parsed.activeProvider),
    configs,
    includeSampleValues: parsed.includeSampleValues,
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
        },
      ]),
    ) as Record<AIProvider, StoredProviderConfig>,
    includeSampleValues: settings.includeSampleValues,
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
  const apiKey =
    config.apiKey ||
    (provider === 'openai' ? '' : 'local');

  const baseURL =
    provider === 'openai' ? undefined : config.endpoint?.trim() || undefined;
  if (provider !== 'openai' && !baseURL) {
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
  /** The provider's own message. Shown verbatim — it is usually specific. */
  error?: string;
  /** The model actually tested, after defaulting. */
  model?: string;
}

// Re-create client when settings change
window.addEventListener('aiSettingsChanged', () => {
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

export const aiService = {
  setSchema(schema: DatabaseSchema) {
    currentSchema = schema;
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
   * Listing models is not enough — it proves the key is valid but not that
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
   * failure class no prompt wording fixed — hallucinated column names, which
   * the database reports precisely.
   *
   * `validate` compiles rather than executes (see sqlValidator.ts), which is
   * what lets the loop cover writes. The previous version dry-ran the query
   * and was gated behind the read-only guard, so it could only ever check
   * SELECTs — and a SELECT that fails to run is the case the user was least
   * likely to be hurt by.
   */
  async generateSqlQuery(
    prompt: string,
    validate?: (sql: string) => Promise<string | null>,
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
      let messages = buildTextToSqlMessages(prompt, currentSchema, { fewShot: 3 });

      // One extra round at most: a second failure means the model is not
      // converging, and a third request is latency the user pays for nothing.
      const maxAttempts = validate ? 2 : 1;
      let sql = '';

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const response = await client.chat.completions.create({
          messages: messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
          temperature: 0,
          top_p: 1.0,
          max_tokens: 1000,
          model: modelName
        });

        sql = stripSqlFences(response.choices[0].message.content || '');
        if (!validate || attempt === maxAttempts - 1) return sql;

        // No read-only gate here, deliberately. `validate` compiles the
        // statement instead of running it, so a write is as safe to check as
        // a read — and gating on read-only is precisely what stopped the old
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
  }
}; 