/**
 * The identify stage: a reel keyframe + its caption in, a structured product
 * signal out. Runs against NVIDIA's OpenAI-compatible NIM endpoint using
 * Kimi K2.6 (moonshotai/kimi-k2.6) — confirmed genuinely multimodal (native
 * vision via a MoonViT encoder), not text-only like gpt-oss.
 *
 * The exact image-content shape isn't spelled out in Kimi's per-model NVIDIA
 * docs, so this uses the standard OpenAI vision format (`image_url` with a
 * data URI) that NIM's "OpenAI-compatible" claim implies. That's a reasonable
 * bet given how standardized that shape is across OpenAI-compatible serving
 * stacks, but it's still the one part of this file to double-check against a
 * real response before trusting it fully — the same discipline that caught
 * the wrong Prava poll endpoint and the wrong Catalog auth guess earlier in
 * this build.
 *
 * response_format is "json_object" (broad json-mode support) rather than the
 * newer strict "json_schema" mode, since strict schema enforcement isn't
 * confirmed on this serving stack — the schema is spelled out in the system
 * prompt instead, and the response is parsed defensively.
 */
import OpenAI from 'openai';

let client: OpenAI | null = null;

/** Test-only: the client is a module-scoped singleton, so tests need a way to clear it between cases. */
export function __resetIdentifyClientForTests(): void {
  client = null;
}

export function identifyModel(): string {
  return process.env.IDENTIFY_MODEL ?? 'moonshotai/kimi-k2.6';
}

/**
 * Provider follows the model id: NIM ids are namespaced ("vendor/model"),
 * OpenAI's are bare ("gpt-4.1"). One env var picks both, so there is no way
 * to point a model at the wrong endpoint.
 */
function getClient(): OpenAI {
  if (!client) {
    const onNim = identifyModel().includes('/');

    const apiKey = onNim ? process.env.NVIDIA_API_KEY : process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error(`${onNim ? 'NVIDIA_API_KEY' : 'OPENAI_API_KEY'} is not set`);

    client = new OpenAI({
      ...(onNim ? { baseURL: 'https://integrate.api.nvidia.com/v1' } : {}),
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

export interface ProductSignal {
  brand: string | null;
  productType: string;
  color: string | null;
  distinguishingFeatures: string[];
  /** Feed this straight into Catalog search — it's the whole point of this stage. */
  searchQuery: string;
  confidence: 'high' | 'medium' | 'low';
}

const SYSTEM = `You identify the single most prominent purchasable product in a reel keyframe.
If several products are visible, pick the one the caption and framing emphasize.
"confidence" is "low" whenever the frame is ambiguous, occluded, or generic enough that a
merchant search is unlikely to find the exact item — don't inflate it to seem useful.
"search_query" should be a plain-text product search a shopping engine would understand,
e.g. "Nike Air Max 90 white leather sneakers", not a description of the scene. Name the
fabric or material whenever you can tell it (denim, linen, leather, knit) — it narrows a
shopping search far more than colour does.

Respond with ONLY a JSON object matching this exact shape, no other text:
{
  "brand": string | null,
  "product_type": string,
  "color": string | null,
  "distinguishing_features": string[],
  "search_query": string,
  "confidence": "high" | "medium" | "low"
}`;

interface RawSignal {
  brand: string | null;
  product_type: string;
  color: string | null;
  distinguishing_features: string[];
  search_query: string;
  confidence: 'high' | 'medium' | 'low';
}

export async function identify(params: {
  imageBase64: string;
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp';
  caption?: string;
}): Promise<ProductSignal> {
  const model = identifyModel();

  const completion = await getClient().chat.completions.create({
    model,
    temperature: 0.2, // consistent structured extraction, not creative generation
    top_p: 1,
    max_tokens: 1024,
    stream: false,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: `data:${params.mediaType};base64,${params.imageBase64}` },
          },
          {
            type: 'text',
            text: params.caption
              ? `Caption: ${params.caption}`
              : 'No caption was provided with this reel.',
          },
        ],
      },
    ],
  });

  // Mirrors the getattr(..., "reasoning_content", None) defensiveness from the
  // reference snippet — not every model on this endpoint returns it.
  const message = completion.choices[0]?.message as { content?: string | null; reasoning_content?: string };
  if (message?.reasoning_content) {
    console.debug('identify: reasoning_content:', message.reasoning_content);
  }

  const content = message?.content;
  if (!content) throw new Error('identify: no content in completion response');

  let parsed: RawSignal;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`identify: model did not return valid JSON: ${content.slice(0, 200)}`);
  }

  return {
    brand: parsed.brand,
    productType: parsed.product_type,
    color: parsed.color,
    distinguishingFeatures: parsed.distinguishing_features,
    searchQuery: parsed.search_query,
    confidence: parsed.confidence,
  };
}
