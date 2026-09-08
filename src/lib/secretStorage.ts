import { invoke } from '@tauri-apps/api/core';
import type { AIProvider } from './aiService';

const SERVICE = 'LiteDB';

const PROVIDERS: AIProvider[] = ['github', 'azure', 'openai', 'ollama'];

function accountForProvider(provider: AIProvider): string {
  return `ai-api-key-${provider}`;
}

export async function storeApiKey(provider: AIProvider, apiKey: string): Promise<void> {
  await invoke('store_secret', {
    service: SERVICE,
    account: accountForProvider(provider),
    secret: apiKey,
  });
}

export async function getApiKey(provider: AIProvider): Promise<string | null> {
  return invoke<string | null>('get_secret', {
    service: SERVICE,
    account: accountForProvider(provider),
  });
}

export async function deleteApiKey(provider: AIProvider): Promise<void> {
  await invoke('delete_secret', {
    service: SERVICE,
    account: accountForProvider(provider),
  });
}

export async function loadAllApiKeys(): Promise<Record<AIProvider, string>> {
  const keys = {} as Record<AIProvider, string>;
  await Promise.all(
    PROVIDERS.map(async (provider) => {
      keys[provider] = (await getApiKey(provider)) ?? '';
    }),
  );
  return keys;
}

export async function storeAllApiKeys(apiKeys: Record<AIProvider, string>): Promise<void> {
  await Promise.all(
    PROVIDERS.map(async (provider) => {
      const apiKey = apiKeys[provider];
      if (apiKey) {
        await storeApiKey(provider, apiKey);
      } else {
        await deleteApiKey(provider);
      }
    }),
  );
}
