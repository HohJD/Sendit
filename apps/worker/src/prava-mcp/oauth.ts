import { createHash, randomBytes } from 'node:crypto';

/**
 * OAuth 2.1 client for Prava's MCP, using dynamic client registration + PKCE.
 *
 * The server allowlists redirect URIs: loopback is accepted for local clients,
 * but a hosted domain has to be registered with Prava first. That is why
 * PRAVA_MCP_REDIRECT_URI is configurable rather than derived from the request.
 */
const AUTH = 'https://mcp.pay.prava.space/auth';
export const SCOPES = 'payments:read payments:write checkout:run';

/**
 * RFC 8707 resource indicator. MCP requires every authorize and token request
 * to name the exact MCP URI it is for, so a token issued for one server can't
 * be replayed against another. Omitting it fails with `invalid_target`.
 */
const RESOURCE = 'https://mcp.pay.prava.space/mcp';

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date;
}

export function redirectUri(): string {
  return process.env.PRAVA_MCP_REDIRECT_URI ?? 'http://localhost:4321/prava/callback';
}

let cachedClientId: string | null = process.env.PRAVA_MCP_CLIENT_ID ?? null;

/** Registration is idempotent from our side: register once, then reuse. */
export async function clientId(): Promise<string> {
  if (cachedClientId) return cachedClientId;

  const res = await fetch(`${AUTH}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'sendit',
      redirect_uris: [redirectUri()],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: SCOPES,
    }),
  });

  const body = (await res.json()) as { client_id?: string; error_description?: string };
  if (!body.client_id) {
    throw new Error(`prava mcp registration failed: ${body.error_description ?? 'unknown'}`);
  }

  cachedClientId = body.client_id;
  return cachedClientId;
}

export interface AuthorizeRequest {
  url: string;
  /** Held server-side until the callback; never sent to the browser. */
  codeVerifier: string;
  state: string;
}

export async function buildAuthorizeUrl(): Promise<AuthorizeRequest> {
  const codeVerifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(codeVerifier).digest('base64url');
  const state = randomBytes(16).toString('base64url');

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: await clientId(),
    redirect_uri: redirectUri(),
    scope: SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: RESOURCE,
  });

  return { url: `${AUTH}/authorize?${params}`, codeVerifier, state };
}

async function token(body: Record<string, string>): Promise<TokenSet> {
  const res = await fetch(`${AUTH}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...body, resource: RESOURCE }),
  });

  const parsed = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error_description?: string;
    error?: string;
  };

  if (!parsed.access_token) {
    throw new Error(`prava mcp token exchange failed: ${parsed.error_description ?? parsed.error}`);
  }

  return {
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token ?? null,
    // A minute of slack so a token never expires mid-pipeline.
    expiresAt: new Date(Date.now() + ((parsed.expires_in ?? 3600) - 60) * 1000),
  };
}

export async function exchangeCode(code: string, codeVerifier: string): Promise<TokenSet> {
  return token({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(),
    client_id: await clientId(),
    code_verifier: codeVerifier,
  });
}

export async function refresh(refreshToken: string): Promise<TokenSet> {
  return token({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: await clientId(),
  });
}
