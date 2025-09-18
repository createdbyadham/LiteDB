import OpenAI from "openai";

const token = import.meta.env.VITE_GITHUB_TOKEN;
const endpoint = "https://models.github.ai/inference";
const modelName = "openai/gpt-4o-mini";

const client = new OpenAI({ baseURL: endpoint, apiKey: token, dangerouslyAllowBrowser: true });

export const aiService = {
  async generateSqlQuery(prompt: string): Promise<string> {
    try {
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