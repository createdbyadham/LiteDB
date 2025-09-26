import OpenAI from "openai";

type AIProvider = 'github' | 'azure' | 'openai';
type AISettings = {
  provider: AIProvider;
  apiKey: string;
  endpoint?: string;
};

// Database schema context for better SQL generation
export type DatabaseDialect = 'sqlite' | 'postgres';
export type ColumnSchema = {
  name: string;
  type: string;
  isPrimaryKey?: boolean;
  isNotNull?: boolean;
};
export type TableSchema = {
  name: string;
  columns: ColumnSchema[];
};
export type DatabaseSchema = {
  dialect: DatabaseDialect;
  tables: TableSchema[];
};

const defaultSettings: AISettings = {
  provider: 'github',
  apiKey: import.meta.env.VITE_GITHUB_TOKEN || '',
  endpoint: 'https://models.github.ai/inference'
};

function getSettings(): AISettings {
  const savedSettings = localStorage.getItem('aiSettings');
  return savedSettings ? JSON.parse(savedSettings) : defaultSettings;
}

function createClient() {
  const settings = getSettings();
  return new OpenAI({ 
    baseURL: settings.endpoint,
    apiKey: settings.apiKey,
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
      const modelName = settings.provider === 'github' ? 'openai/gpt-4o-mini' : 'gpt-4';

      const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
        {
          role: 'system',
          content: `You are an SQL expert assistant. Convert natural language to SQL queries. Only respond with the SQL query, no explanations. Do not include any other text or comments. Do not add \`\`\`sql\`\`\`.
Current date: ${new Date().toISOString().split('T')[0]}`
        }
      ];

      if (currentSchema) {
        const dialect = currentSchema.dialect;
        const quote = dialect === 'postgres' ? '"' : '`';
        messages.push({
          role: 'system',
          content: `Database dialect: ${dialect}. Quote identifiers with ${quote}. Use only the following schema. If the user asks for non-existing tables/columns, choose the closest match or state inability.
Schema:\n${serializeSchema(currentSchema)}`
        });
      }

      messages.push({ role: 'user', content: prompt });

      const response = await client.chat.completions.create({
        messages,
        temperature: 0.7,
        top_p: 1.0,
        max_tokens: 1000,
        model: modelName
      });

      return response.choices[0].message.content || '';
    } catch (error) {
      console.error('Error generating SQL query:', error);
      throw error;
    }
  }
}; 