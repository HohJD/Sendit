import type { CardCredentials } from '../checkout/shopify.ts';

/**
 * Demo escape hatch: when Prava's hosted passkey step can't complete on stage
 * (sandbox device-binding failures), the checkout UI can offer to run the same
 * agentic purchase with Prava's published sandbox test card instead. These
 * numbers are public test fixtures — they only work against sandbox gateways
 * and never move money. Off by default; never enable in production.
 */
export function DEMO_FALLBACK_ENABLED(): boolean {
  return process.env.DEMO_FALLBACK_CARD === 'true' || DEMO_FALLBACK_DIRECT();
}

/** `direct`: skip the Prava tab entirely — "buy" goes straight to the agent. */
export function DEMO_FALLBACK_DIRECT(): boolean {
  return process.env.DEMO_FALLBACK_CARD === 'direct';
}

/** Sandbox test card from docs.prava.space/api-reference/test-cards. */
export function demoFallbackCard(): CardCredentials {
  return {
    token: '4622943123137854',
    dynamicCvv: '799',
    expiryMonth: '12',
    expiryYear: '2027',
  };
}
