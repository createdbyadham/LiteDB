import { invoke } from '@tauri-apps/api/core';
import type { AIProvider } from './aiService';

const SERVICE = 'LiteDB';
const LEGACY_KEY_MIGRATION = 'litedb.migrated-legacy-ai-keys';

const PROVIDERS: AIProvider[] = ['openai', 'openai-compatible', 'ollama'];

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

async function legacySecret(account: string): Promise<string> {
  return (
    (await invoke<string | null>('get_secret', {
      service: SERVICE,
      account,
    })) ?? ''
  );
}

/**
 * Copy GitHub/Azure keyring entries into the compatible slot exactly once.
 *
 * `preferAzure` follows whichever of those two was active before the
 * collapse, so we do not pair an Azure endpoint with a GitHub token.
 */
export function markLegacyApiKeysMigrated(): void {
  localStorage.setItem(LEGACY_KEY_MIGRATION, '1');
}

export async function adoptLegacyApiKeys(preferAzure: boolean): Promise<string> {
  if (localStorage.getItem(LEGACY_KEY_MIGRATION) === '1') return '';
  markLegacyApiKeysMigrated();

  const github = await legacySecret('ai-api-key-github');
  const azure = await legacySecret('ai-api-key-azure');
  const chosen = preferAzure ? azure || github : github || azure;
  if (chosen) await storeApiKey('openai-compatible', chosen);
  return chosen;
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
