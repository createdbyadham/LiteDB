import { pipeline, env } from '@xenova/transformers';

type FeatureExtractor = {
  (text: string, options?: { pooling?: string; normalize?: boolean }): Promise<{ data: Float32Array }>;
};

type PipelineProgress = {
  status?: string;
  progress?: number;
  file?: string;
};

// Configure transformers.js to use local cache
env.allowLocalModels = false;
env.useBrowserCache = true;

// Available models
export interface EmbeddingModel {
  id: string;
  name: string;
  huggingFaceId: string;
  dimensions: number;
  size: string;
  description: string;
}

export const AVAILABLE_MODELS: EmbeddingModel[] = [
  {
    id: 'minilm',
    name: 'all-MiniLM-L6-v2',
    huggingFaceId: 'Xenova/all-MiniLM-L6-v2',
    dimensions: 384,
    size: '~23MB',
    description: 'Fast & lightweight'
  },
  {
    id: 'bge-base',
    name: 'bge-base-en-v1.5',
    huggingFaceId: 'Xenova/bge-base-en-v1.5',
    dimensions: 768,
    size: '~110MB',
    description: 'Balanced quality/speed'
  },
  {
    id: 'bge-large',
    name: 'bge-large-en-v1.5',
    huggingFaceId: 'Xenova/bge-large-en-v1.5',
    dimensions: 1024,
    size: '~335MB',
    description: 'Best quality'
  }
];

// Current loaded model state
let currentModel: EmbeddingModel | null = null;
let embedder: FeatureExtractor | null = null;
let isLoading = false;
let loadError: string | null = null;

export interface LocalEmbeddingService {
  isReady: boolean;
  isLoading: boolean;
  error: string | null;
  currentModel: EmbeddingModel | null;
  availableModels: EmbeddingModel[];
  initialize: (modelId: string) => Promise<boolean>;
  embed: (text: string) => Promise<number[]>;
  embedBatch: (texts: string[]) => Promise<number[][]>;
  unload: () => void;
}

// Progress callback type
type ProgressCallback = (progress: { status: string; progress?: number; file?: string }) => void;

let progressCallback: ProgressCallback | null = null;

export function setProgressCallback(callback: ProgressCallback | null) {
  progressCallback = callback;
}

async function initializeEmbedder(modelId: string): Promise<boolean> {
  const model = AVAILABLE_MODELS.find(m => m.id === modelId);
  if (!model) {
    loadError = `Unknown model: ${modelId}`;
    return false;
  }

  // If same model is already loaded, return true
  if (embedder && currentModel?.id === modelId) {
    return true;
  }

  // If different model, unload first
  if (embedder && currentModel?.id !== modelId) {
    embedder = null;
    currentModel = null;
  }

  if (isLoading) {
    // Wait for existing initialization
    while (isLoading) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return embedder !== null && currentModel?.id === modelId;
  }

  isLoading = true;
  loadError = null;

  try {
    embedder = (await pipeline('feature-extraction', model.huggingFaceId, {
      progress_callback: (data: PipelineProgress) => {
        if (progressCallback) {
          progressCallback({
            status: data.status || 'loading',
            progress: data.progress,
            file: data.file
          });
        }
      }
    })) as unknown as FeatureExtractor;

    currentModel = model;
    isLoading = false;
    return true;
  } catch (error) {
    console.error('Failed to initialize embedding model:', error);
    loadError = error instanceof Error ? error.message : 'Failed to load model';
    isLoading = false;
    embedder = null;
    currentModel = null;
    return false;
  }
}

async function embed(text: string): Promise<number[]> {
  if (!embedder || !currentModel) {
    throw new Error('No embedding model loaded. Call initialize() first.');
  }

  try {
    const output = await embedder(text, { pooling: 'mean', normalize: true });
    return Array.from(output.data as Float32Array);
  } catch (error) {
    console.error('Embedding error:', error);
    throw error;
  }
}

async function embedBatch(texts: string[]): Promise<number[][]> {
  if (!embedder || !currentModel) {
    throw new Error('No embedding model loaded. Call initialize() first.');
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

function unload() {
  embedder = null;
  currentModel = null;
  loadError = null;
}

export const localEmbeddings: LocalEmbeddingService = {
  get isReady() {
    return embedder !== null && currentModel !== null;
  },
  get isLoading() {
    return isLoading;
  },
  get error() {
    return loadError;
  },
  get currentModel() {
    return currentModel;
  },
  availableModels: AVAILABLE_MODELS,
  initialize: initializeEmbedder,
  embed,
  embedBatch,
  unload
};

export default localEmbeddings;
