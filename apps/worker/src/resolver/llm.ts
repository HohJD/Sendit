/**
 * Shared OpenAI-compatible chat client for every LLM call in the resolver.
 * Provider follows the model id, so there is no way to point a model at the
 * wrong endpoint:
 *   - 'grok-*'   → xAI (https://api.x.ai/v1) with XAI_API_KEY
 *   - namespaced 'vendor/model' → NVIDIA NIM with NVIDIA_API_KEY
 *   - bare id    → OpenAI with OPENAI_API_KEY
 */
import OpenAI from 'openai';

const PROVIDERS = {
  openrouter: { key: 'OPENROUTER_API_KEY', baseURL: 'https://openrouter.ai/api/v1', model: 'openrouter/free' },
  openai: { key: 'OPENAI_API_KEY', baseURL: 'https://api.openai.com/v1', model: 'gpt-4.1-mini' },
  xai: { key: 'XAI_API_KEY', baseURL: 'https://api.x.ai/v1', model: 'grok-4.7' },
  nim: { key: 'NVIDIA_API_KEY', baseURL: 'https://integrate.api.nvidia.com/v1', model: 'moonshotai/kimi-k2.6' },
} as const;

export type LlmProvider = keyof typeof PROVIDERS;

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
  return process.env.IDENTIFY_MODEL?.trim() || PROVIDERS[identifyProvider()].model;
}

export function identifyProvider(): LlmProvider {
  const explicit = process.env.LLM_PROVIDER?.trim();
  if (explicit) {
    if (!Object.hasOwn(PROVIDERS, explicit)) {
      throw new Error('LLM_PROVIDER must be openrouter, openai, xai, or nim');
    }
    return explicit as LlmProvider;
  }
  const model = process.env.IDENTIFY_MODEL?.trim();
  if (model) {
    if (model.startsWith('grok')) return 'xai';
    return model.includes('/') ? 'nim' : 'openai';
  }
  if (process.env.XAI_API_KEY?.trim()) return 'xai';
  if (process.env.OPENAI_API_KEY?.trim()) return 'openai';
  if (process.env.NVIDIA_API_KEY?.trim()) return 'nim';
  return process.env.OPENROUTER_API_KEY?.trim() ? 'openrouter' : 'nim';
}

export function identifyApiKeyName(): string {
  return PROVIDERS[identifyProvider()].key;
}

/**
 * OpenRouter request extras. `require_parameters` filters the routing pool to
 * models that accept our JSON mode + image input; `models` is OpenRouter's
 * server-side fallback list — on any error from the primary (including the
 * "no endpoints" routing 404 and upstream 429s) the next model in the list is
 * tried, and the response's `model` field shows which one answered.
 *
 * LLM_FALLBACK_MODELS, comma-separated. Unset → falls back to cheap paid
 * `openai/gpt-4.1-mini` when free capacity is unavailable — reliability for
 * the demo beats free. Present-but-empty disables fallback entirely.
 */
export function providerOptions(): {
  provider?: { require_parameters: boolean };
  models?: string[];
} {
  if (identifyProvider() !== 'openrouter') return {};

  const env = process.env.LLM_FALLBACK_MODELS;
  const fallbacks =
    env === undefined
      ? ['openai/gpt-4.1-mini']
      : env.trim() === ''
        ? []
        : env.split(',').map((m) => m.trim()).filter(Boolean);

  return {
    provider: { require_parameters: true },
    ...(fallbacks.length ? { models: [identifyModel(), ...fallbacks] } : {}),
  };
}

export function getClient(): OpenAI {
  const provider = identifyProvider();
  const { key, baseURL } = PROVIDERS[provider];
  const apiKey = process.env[key]?.trim();
  if (!apiKey) throw new Error(`${key} is not set`);

  if (!client || client.baseURL !== baseURL || client.apiKey !== apiKey) {
    client = new OpenAI({
      baseURL,
      apiKey,
      ...(provider === 'openrouter' ? {
        timeout: 30_000,
        maxRetries: 1,
        defaultHeaders: { 'X-OpenRouter-Title': 'Sendit' },
      } : {}),
      // The SDK captures `fetch` once at construction (this.fetch = overriddenFetch ?? fetch)
      // rather than reading globalThis.fetch per call. This thin wrapper defers that lookup to
      // call time instead, so a test-mocked globalThis.fetch is actually honored — without it,
      // requests silently go out over the real network no matter what a test overrides.
      fetch: (url, init) => globalThis.fetch(url as never, init as never) as never,
    });
  }
  return client;
}
