import OpenAI from "openai";
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { loadAllApiKeys } from './secretStorage';

export type AIProvider = 'github' | 'azure' | 'openai' | 'ollama';

export type AIProviderConfig = {
  apiKey: string;
  endpoint?: string;
  modelName?: string;
};

export type AISettings = {
  activeProvider: AIProvider;
  configs: Record<AIProvider, AIProviderConfig>;
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
  }
};

type StoredProviderConfig = {
  endpoint?: string;
  modelName?: string;
};

type StoredAISettings = {
  activeProvider: AIProvider;
  configs: Record<AIProvider, StoredProviderConfig>;
};

const AI_PROVIDERS: AIProvider[] = ['github', 'azure', 'openai', 'ollama'];

function mergeWithDefaults(stored: Partial<StoredAISettings>): AISettings {
  const settings: AISettings = {
    activeProvider: stored.activeProvider ?? defaultSettings.activeProvider,
    configs: { ...defaultSettings.configs },
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

function serializeSchema(schema: DatabaseSchema): string {
  const quote = schema.dialect === 'postgres' ? '"' : '`';
  const lines: string[] = [];
  for (const table of schema.tables) {
    const cols = table.columns.map(c => {
      const pk = c.isPrimaryKey ? ' PK' : '';
      const nn = c.isNotNull ? ' NOT NULL' : '';
      return `${c.name} ${c.type}${pk}${nn}`.trim();
    }).join(', ');
    lines.push(`table ${quote}${table.name}${quote}: ${cols}`);
  }
  return lines.join('\n');
}

export const aiService = {
  setSchema(schema: DatabaseSchema) {
    currentSchema = schema;
  },
  clearSchema() {
    currentSchema = null;
  },
  async generateSqlQuery(prompt: string): Promise<string> {
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

      const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
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
  <current_date>${new Date().toISOString().split('T')[0]}</current_date>
</system_instructions>`
        }
      ];

      if (currentSchema) {
        const dialect = currentSchema.dialect;
        const quote = dialect === 'postgres' ? '"' : '`';
        messages.push({
          role: 'system',
          content: `<database_context>
  <dialect>${dialect}</dialect>
  <quote_char>${quote}</quote_char>
  <schema>
${serializeSchema(currentSchema)}
  </schema>
  <instruction>Use only the provided schema. If the user asks for non-existing tables/columns, choose the closest match or state inability.</instruction>
</database_context>`
        });
      }

      messages.push({ role: 'user', content: prompt });

      const response = await client.chat.completions.create({
        messages,
        temperature: 0,
        top_p: 1.0,
        max_tokens: 1000,
        model: modelName
      });

      const content = response.choices[0].message.content || '';
      // Remove markdown code blocks if present
      return content.replace(/^```sql\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, '').trim();
    } catch (error) {
      console.error('Error generating SQL query:', error);
      throw error;
    }
  }
}; 