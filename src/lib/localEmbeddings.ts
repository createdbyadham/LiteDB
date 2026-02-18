import { pipeline, env } from '@xenova/transformers';

// Configure transformers.js to use local cache
env.allowLocalModels = false;
env.useBrowserCache = true;

// Model info
const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
const DIMENSIONS = 384;

// Singleton pipeline instance
let embedder: any = null;
let isLoading = false;
let loadError: string | null = null;

export interface LocalEmbeddingService {
  isReady: boolean;
  isLoading: boolean;
  error: string | null;
  modelName: string;
  dimensions: number;
  initialize: () => Promise<boolean>;
  embed: (text: string) => Promise<number[]>;
  embedBatch: (texts: string[]) => Promise<number[][]>;
}

// Progress callback type
type ProgressCallback = (progress: { status: string; progress?: number; file?: string }) => void;

let progressCallback: ProgressCallback | null = null;

export function setProgressCallback(callback: ProgressCallback | null) {
  progressCallback = callback;
}

async function initializeEmbedder(): Promise<boolean> {
  if (embedder) return true;
  if (isLoading) {
    // Wait for existing initialization
    while (isLoading) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return embedder !== null;
  }

  isLoading = true;
  loadError = null;

  try {
    console.log('Initializing local embedding model:', MODEL_ID);
    
    embedder = await pipeline('feature-extraction', MODEL_ID, {
      progress_callback: (data: any) => {
        if (progressCallback) {
          progressCallback({
            status: data.status || 'loading',
            progress: data.progress,
            file: data.file
          });
        }
        if (data.status === 'progress') {
          console.log(`Loading model: ${data.file} - ${Math.round(data.progress || 0)}%`);
        }
      }
    });

    console.log('Local embedding model loaded successfully');
    isLoading = false;
    return true;
  } catch (error) {
    console.error('Failed to initialize embedding model:', error);
    loadError = error instanceof Error ? error.message : 'Failed to load model';
    isLoading = false;
    return false;
  }
}

async function embed(text: string): Promise<number[]> {
  if (!embedder) {
    const success = await initializeEmbedder();
    if (!success) {
      throw new Error(loadError || 'Embedding model not initialized');
    }
  }

  try {
    const output = await embedder(text, { pooling: 'mean', normalize: true });
    // Convert to regular array
    return Array.from(output.data as Float32Array);
  } catch (error) {
    console.error('Embedding error:', error);
    throw error;
  }
}

async function embedBatch(texts: string[]): Promise<number[][]> {
  if (!embedder) {
    const success = await initializeEmbedder();
    if (!success) {
      throw new Error(loadError || 'Embedding model not initialized');
    }
  }

  try {
    const results: number[][] = [];
    for (const text of texts) {
      const output = await embedder(text, { pooling: 'mean', normalize: true });
      results.push(Array.from(output.data as Float32Array));
    }
    return results;
  } catch (error) {
    console.error('Batch embedding error:', error);
    throw error;
  }
}

export const localEmbeddings: LocalEmbeddingService = {
  get isReady() {
    return embedder !== null;
  },
  get isLoading() {
    return isLoading;
  },
  get error() {
    return loadError;
  },
  modelName: 'all-MiniLM-L6-v2',
  dimensions: DIMENSIONS,
  initialize: initializeEmbedder,
  embed,
  embedBatch
};

export default localEmbeddings;
