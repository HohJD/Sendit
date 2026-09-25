/**
 * Shared OpenAI-compatible chat client for every LLM call in the resolver.
 * Provider follows the model id, so there is no way to point a model at the
 * wrong endpoint:
 *   - 'grok-*'   → xAI (https://api.x.ai/v1) with XAI_API_KEY
 *   - namespaced 'vendor/model' → NVIDIA NIM with NVIDIA_API_KEY
 *   - bare id    → OpenAI with OPENAI_API_KEY
 */
import OpenAI from 'openai';

let client: OpenAI | null = null;

/** Test-only: the client is a module-scoped singleton, so tests need a way to clear it between cases. */
export function __resetClientForTests(): void {
  client = null;
}

/**
 * Unset IDENTIFY_MODEL falls back to whichever provider has a key, so a fresh
 * .env with just XAI_API_KEY works without also knowing the model id to type.
 */
export function identifyModel(): string {
  if (process.env.IDENTIFY_MODEL) return process.env.IDENTIFY_MODEL;
  if (process.env.XAI_API_KEY) return 'grok-4.7';
  if (process.env.OPENAI_API_KEY) return 'gpt-4.1-mini';
  return 'moonshotai/kimi-k2.6';
}

export function identifyProvider(): 'xai' | 'nim' | 'openai' {
  const model = identifyModel();
  if (model.startsWith('grok')) return 'xai';
  if (model.includes('/')) return 'nim';
  return 'openai';
}

export function getClient(): OpenAI {
  if (!client) {
    const provider = identifyProvider();
    const apiKey =
      provider === 'xai'
        ? process.env.XAI_API_KEY
        : provider === 'nim'
          ? process.env.NVIDIA_API_KEY
          : process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        `${provider === 'xai' ? 'XAI_API_KEY' : provider === 'nim' ? 'NVIDIA_API_KEY' : 'OPENAI_API_KEY'} is not set`,
      );
    }

    client = new OpenAI({
      ...(provider === 'xai' ? { baseURL: 'https://api.x.ai/v1' } : {}),
      ...(provider === 'nim' ? { baseURL: 'https://integrate.api.nvidia.com/v1' } : {}),
      apiKey,
      // The SDK captures `fetch` once at construction (this.fetch = overriddenFetch ?? fetch)
      // rather than reading globalThis.fetch per call. This thin wrapper defers that lookup to
      // call time instead, so a test-mocked globalThis.fetch is actually honored — without it,
      // requests silently go out over the real network no matter what a test overrides.
      fetch: (url, init) => globalThis.fetch(url as never, init as never) as never,
    });
  }
  return client;
}
