import { useSyncExternalStore } from 'react';
import { aiService } from '@/lib/aiService';

function subscribe(onChange: () => void): () => void {
  window.addEventListener('aiSettingsChanged', onChange);
  return () => window.removeEventListener('aiSettingsChanged', onChange);
}

/** Whether inline suggestions are switched on in Settings, kept current as settings are saved. */
export function useInlineSuggestionsSetting(): boolean {
  return useSyncExternalStore(subscribe, () => aiService.inlineSuggestionsEnabled());
}
