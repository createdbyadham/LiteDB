import OpenAI from "openai";

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
      apiKey: import.meta.env.VITE_GITHUB_TOKEN || '',
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

function getSettings(): AISettings {
  const savedSettings = localStorage.getItem('aiSettings');
  if (!savedSettings) return defaultSettings;
  
  const parsed = JSON.parse(savedSettings);
  
  // Migration for old settings format
  if (!parsed.configs) {
    const oldSettings = parsed as any;
    const newSettings = { ...defaultSettings };
    
    // Try to preserve the old setting into the correct config slot if possible
    if (oldSettings.provider) {
      newSettings.activeProvider = oldSettings.provider;
      if (newSettings.configs[oldSettings.provider as AIProvider]) {
        newSettings.configs[oldSettings.provider as AIProvider] = {
          apiKey: oldSettings.apiKey || '',
          endpoint: oldSettings.endpoint,
          modelName: oldSettings.modelName
        };
      }
    }
    return newSettings;
  }
  
  return parsed;
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
    dangerouslyAllowBrowser: true 
  });
}

// Re-create client when settings change
window.addEventListener('aiSettingsChanged', () => {
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