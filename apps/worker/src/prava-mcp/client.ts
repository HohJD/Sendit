/**
 * Minimal Streamable-HTTP MCP client for Prava's payments server.
 *
 * Deliberately not the full SDK: this speaks the three things the checkout
 * pipeline needs — initialize, initialized, tools/call — over plain fetch, so
 * the worker carries no extra dependency and the transport stays inspectable.
 *
 * Responses arrive as JSON or as a one-shot SSE stream depending on the tool,
 * so both are handled.
 */
export const MCP_URL = 'https://mcp.pay.prava.space/mcp';

export class McpError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = 'McpError';
  }
}

interface RpcEnvelope {
  result?: unknown;
  error?: { code: number; message: string };
}

/** An SSE body carries the payload in `data:` lines; take the last complete one. */
function parseSse(text: string): unknown {
  const payloads = text
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);

  const last = payloads.at(-1);
  return last ? JSON.parse(last) : null;
}

async function rpc(
  token: string,
  method: string,
  params: unknown,
  sessionId?: string,
): Promise<{ envelope: RpcEnvelope; sessionId: string | null }> {
  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
  });

  const text = await res.text();

  if (!res.ok) {
    throw new McpError(`${method} failed: HTTP ${res.status} ${text.slice(0, 200)}`, res.status);
  }

  const body = res.headers.get('content-type')?.includes('text/event-stream')
    ? parseSse(text)
    : text
      ? JSON.parse(text)
      : null;

  return {
    envelope: (body ?? {}) as RpcEnvelope,
    sessionId: res.headers.get('mcp-session-id') ?? sessionId ?? null,
  };
}

/**
 * Call one tool. Each call opens its own session: the pipeline makes a handful
 * of calls spread across user think-time, so holding a session between them
 * would mean managing expiry for no benefit.
 */
export async function callTool<T = unknown>(
  token: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const init = await rpc(token, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'sendit', version: '0.1.0' },
  });

  if (init.envelope.error) {
    throw new McpError(init.envelope.error.message, init.envelope.error.code);
  }

  const session = init.sessionId ?? undefined;

  // Required by the protocol before any tool call.
  await fetch(MCP_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(session ? { 'mcp-session-id': session } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  }).catch(() => undefined);

  const { envelope } = await rpc(token, 'tools/call', { name, arguments: args }, session);

  if (envelope.error) throw new McpError(envelope.error.message, envelope.error.code);

  const result = envelope.result as {
    isError?: boolean;
    structuredContent?: T;
    content?: Array<{ type: string; text?: string }>;
  };

  const text = result?.content?.find((c) => c.type === 'text')?.text;

  // A tool that fails reports it in the result rather than as an RPC error.
  if (result?.isError) throw new McpError(text ?? `${name} reported an error`);

  if (result?.structuredContent) return result.structuredContent;

  if (text) {
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as T;
    }
  }

  return result as T;
}
