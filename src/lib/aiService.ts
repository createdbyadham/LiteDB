import OpenAI from "openai";

type AIProvider = 'github' | 'azure' | 'openai';
type AISettings = {
  provider: AIProvider;
  apiKey: string;
  endpoint?: string;
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

export const aiService = {
  async generateSqlQuery(prompt: string): Promise<string> {
    try {
      const settings = getSettings();
      const modelName = settings.provider === 'github' ? 'openai/gpt-4o-mini' : 'gpt-4';

      const response = await client.chat.completions.create({
        messages: [
          { 
            role: "system", 
            content: "You are an SQL expert assistant. Convert natural language to SQL queries. Only respond with the SQL query, no explanations. Do not include any other text or comments. do not add ```sql```" 
          },
          { role: "user", content: prompt }
        ],
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