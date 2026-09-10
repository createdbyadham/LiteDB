import OpenAI from "openai";
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { loadAllApiKeys } from './secretStorage';
import { buildRepairMessages, buildTextToSqlMessages, stripSqlFences } from './promptBuilder';
import { attachSampleValues, type QueryRunner } from './schemaSamples';
import type { DatabaseSchema } from './schemaTypes';

export type { ColumnSchema, DatabaseSchema, SqlDialect, TableSchema } from './schemaTypes';

export type AIProvider = 'github' | 'azure' | 'openai' | 'ollama';

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
  activeProvider: 'github',
  configs: {
    github: {
      apiKey: '',
      endpoint: 'https://models.github.ai/inference',
      modelName: 'openai/gpt-4o-mini'
    },
    openai: {
      apiKey: '',
      modelName: 'gpt-4'
    },
    azure: {
      apiKey: '',
      endpoint: '',
      modelName: ''
    },
    ollama: {
      apiKey: 'ollama', // Dummy key for local
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

const AI_PROVIDERS: AIProvider[] = ['github', 'azure', 'openai', 'ollama'];

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

  const configs = Object.fromEntries(
    AI_PROVIDERS.map((provider) => [
      provider,
      {
        endpoint: parsed.configs[provider]?.endpoint,
        modelName: parsed.configs[provider]?.modelName,
      },
    ]),
  ) as Record<AIProvider, StoredProviderConfig>;

  return {
    activeProvider: parsed.activeProvider ?? defaultSettings.activeProvider,
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

function createClient() {
  const settings = getSettings();
  const config = settings.configs[settings.activeProvider];
  
  // For Ollama, we need to ensure the apiKey is not empty (even if dummy) for the OpenAI client to work
  const apiKey = settings.activeProvider === 'ollama' && !config.apiKey 
    ? 'ollama' 
    : config.apiKey;

  return new OpenAI({ 
    baseURL: config.endpoint || undefined,
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
      let modelName = config.modelName;

      if (!modelName) {
        switch (settings.activeProvider) {
          case 'github':
            modelName = 'openai/gpt-4o-mini';
            break;
          case 'ollama':
            modelName = 'llama3';
            break;
          default:
            modelName = 'gpt-4';
        }
      }

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