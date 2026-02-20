type RpcBody = {
  rpcUrl: string;
  method: string;
  params?: unknown;
};

type RpcUpstreamError = {
  code?: unknown;
  message?: unknown;
  data?: unknown;
};

type AgentRpcSuccess = {
  ok: true;
  result: unknown;
};

type AgentRpcError = {
  ok: false;
  error?: {
    code?: unknown;
    message?: unknown;
    rpcCode?: unknown;
    data?: unknown;
  };
};

type AgentStatusResponse = {
  ok?: unknown;
  foundry?: {
    startupError?: unknown;
  };
};

const agentHttpUrl = process.env.AGENT_HTTP_URL ?? 'http://127.0.0.1:17400';
const MAINNET_RPC_FALLBACKS = [
  'https://ethereum-rpc.publicnode.com',
  'https://rpc.flashbots.net',
  'https://eth.merkle.io',
  'https://eth.llamarpc.com',
];

function normalizeRpcUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function parseBody(raw: unknown): RpcBody | null {
  if (!raw || typeof raw !== 'object') return null;
  const body = raw as Record<string, unknown>;
  if (typeof body.rpcUrl !== 'string') return null;
  if (typeof body.method !== 'string') return null;
  return {
    rpcUrl: normalizeRpcUrl(body.rpcUrl),
    method: body.method.trim(),
    params: body.params,
  };
}

function asRpcErrorMessage(err: unknown): string {
  if (!err || typeof err !== 'object') return 'Foundry RPC error.';
  const value = err as RpcUpstreamError;
  if (typeof value.message === 'string' && value.message.trim()) return value.message;
  return 'Foundry RPC error.';
}

function normalizeParams(input: unknown): unknown[] {
  if (input == null) return [];
  if (Array.isArray(input)) return input;
  return [input];
}

function isLocalRpcUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return host === 'localhost' || host === '::1' || host === '0.0.0.0' || host.startsWith('127.');
}

function isLikelyStateChangingMethod(method: string): boolean {
  const m = method.trim().toLowerCase();
  if (!m) return true;
  return (
    m.startsWith('eth_send') ||
    m.startsWith('personal_') ||
    m.startsWith('wallet_') ||
    m.startsWith('anvil_') ||
    m.startsWith('hardhat_') ||
    m.startsWith('evm_') ||
    m.startsWith('miner_') ||
    m.startsWith('debug_tracecall')
  );
}

function looksLikeHtml(text: string): boolean {
  const raw = text.trim().toLowerCase();
  if (!raw) return false;
  return (
    raw.includes('<!doctype html') ||
    raw.includes('<html') ||
    raw.includes('</html>') ||
    raw.includes('cf-wrapper') ||
    raw.includes('_cf_translation')
  );
}

function compactSnippet(text: string, max = 220): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return normalized.length <= max ? normalized : `${normalized.slice(0, max)}...`;
}

function fallbackCandidatesFor(url: URL): string[] {
  const host = url.hostname.toLowerCase();
  const knownMainnetHosts = new Set([
    'eth.llamarpc.com',
    'eth.merkle.io',
    'rpc.flashbots.net',
    'ethereum-rpc.publicnode.com',
  ]);
  if (!knownMainnetHosts.has(host)) return [];
  const current = normalizeRpcUrl(url.toString());
  return MAINNET_RPC_FALLBACKS.filter((candidate) => normalizeRpcUrl(candidate) !== current);
}

type RpcEndpointOutcome =
  | { kind: 'network_error'; message: string }
  | {
      kind: 'response';
      status: number;
      statusText: string;
      rawText: string;
      json: unknown | null;
    };

async function fetchRpcEndpoint(endpoint: string, payload: unknown, timeoutMs = 15_000): Promise<RpcEndpointOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const upstream = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      cache: 'no-store',
      signal: controller.signal,
    });
    const rawText = await upstream.text().catch(() => '');
    let json: unknown | null = null;
    if (rawText) {
      try {
        json = JSON.parse(rawText) as unknown;
      } catch {
        json = null;
      }
    }
    return {
      kind: 'response',
      status: upstream.status,
      statusText: upstream.statusText,
      rawText,
      json,
    };
  } catch (err) {
    return {
      kind: 'network_error',
      message: err instanceof Error ? err.message : 'Failed to reach Foundry RPC endpoint.',
    };
  } finally {
    clearTimeout(timer);
  }
}

async function tryAgentRpcFallback(method: string, params: unknown[]): Promise<AgentRpcSuccess | AgentRpcError> {
  const res = await fetch(`${agentHttpUrl}/evm/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, params }),
    cache: 'no-store',
  });
  const json = (await res.json().catch(() => null)) as AgentRpcSuccess | AgentRpcError | null;
  if (!json || typeof json !== 'object' || !('ok' in json) || typeof json.ok !== 'boolean') {
    const message = `Agent returned invalid response (${res.status}).`;
    return { ok: false, error: { code: 'agent_invalid_response', message } };
  }
  if (res.ok) return json;
  const errorCode =
    !json.ok && json.error && typeof json.error.code === 'string'
      ? json.error.code
      : 'agent_rpc_failed';
  const message =
    !json.ok && json.error && typeof json.error.message === 'string' && json.error.message.trim()
      ? json.error.message
      : `Agent RPC failed (${res.status}).`;
  return { ok: false, error: { code: errorCode, message } };
}

async function tryReadAgentStartupError(): Promise<string | null> {
  try {
    const res = await fetch(`${agentHttpUrl}/evm/status`, { cache: 'no-store' });
    if (!res.ok) return null;
    const json = (await res.json().catch(() => null)) as AgentStatusResponse | null;
    if (!json || json.ok !== true || !json.foundry) return null;
    const startupError = json.foundry.startupError;
    if (typeof startupError === 'string' && startupError.trim()) return startupError;
    return null;
  } catch {
    return null;
  }
}

export async function POST(req: Request): Promise<Response> {
  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return Response.json(
      { ok: false, error: { code: 'bad_request', message: 'Invalid JSON body.' } },
      { status: 400, headers: { 'cache-control': 'no-store' } },
    );
  }

  const body = parseBody(rawBody);
  if (!body) {
    return Response.json(
      { ok: false, error: { code: 'bad_request', message: 'rpcUrl and method are required.' } },
      { status: 400, headers: { 'cache-control': 'no-store' } },
    );
  }

  if (!body.method) {
    return Response.json(
      { ok: false, error: { code: 'bad_request', message: 'method cannot be empty.' } },
      { status: 400, headers: { 'cache-control': 'no-store' } },
    );
  }

  let url: URL;
  try {
    url = new URL(body.rpcUrl);
  } catch {
    return Response.json(
      { ok: false, error: { code: 'bad_request', message: 'rpcUrl must be a valid URL.' } },
      { status: 400, headers: { 'cache-control': 'no-store' } },
    );
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return Response.json(
      { ok: false, error: { code: 'bad_request', message: 'rpcUrl must use http or https.' } },
      { status: 400, headers: { 'cache-control': 'no-store' } },
    );
  }

  const params = normalizeParams(body.params);
  const payload = {
    jsonrpc: '2.0',
    id: Date.now(),
    method: body.method,
    params,
  };

  const allowFallbackRetry = !isLocalRpcUrl(url) && !isLikelyStateChangingMethod(body.method);
  const candidateUrls = [
    url.toString(),
    ...(allowFallbackRetry ? fallbackCandidatesFor(url) : []),
  ];

  for (let i = 0; i < candidateUrls.length; i += 1) {
    const endpoint = candidateUrls[i];
    const hasNext = i < candidateUrls.length - 1;
    const outcome = await fetchRpcEndpoint(endpoint, payload);

    if (outcome.kind === 'network_error') {
      if (i === 0 && isLocalRpcUrl(url)) {
        try {
          const agentResult = await tryAgentRpcFallback(body.method, params);
          if (agentResult.ok) {
            return Response.json(
              { ok: true, result: agentResult.result },
              { headers: { 'cache-control': 'no-store' } },
            );
          }
          const agentMessage =
            agentResult.error?.message && typeof agentResult.error.message === 'string'
              ? agentResult.error.message
              : 'Agent fallback failed.';
          let startupHint: string | null = null;
          if (agentResult.error?.code === 'evm_unavailable') {
            startupHint = await tryReadAgentStartupError();
          }
          return Response.json(
            {
              ok: false,
              error: {
                code: 'upstream_unreachable',
                message: startupHint
                  ? `Direct RPC failed: ${outcome.message}. Agent fallback failed: ${agentMessage}. Foundry startup error: ${startupHint}`
                  : `Direct RPC failed: ${outcome.message}. Agent fallback failed: ${agentMessage}`,
              },
            },
            { status: 502, headers: { 'cache-control': 'no-store' } },
          );
        } catch (agentErr) {
          const fallbackMessage = agentErr instanceof Error ? agentErr.message : 'Agent fallback failed.';
          const startupHint = await tryReadAgentStartupError();
          return Response.json(
            {
              ok: false,
              error: {
                code: 'upstream_unreachable',
                message: startupHint
                  ? `Direct RPC failed: ${outcome.message}. Agent fallback failed: ${fallbackMessage}. Foundry startup error: ${startupHint}`
                  : `Direct RPC failed: ${outcome.message}. Agent fallback failed: ${fallbackMessage}`,
              },
            },
            { status: 502, headers: { 'cache-control': 'no-store' } },
          );
        }
      }

      if (hasNext) continue;
      return Response.json(
        {
          ok: false,
          error: {
            code: 'upstream_unreachable',
            message: `Failed to reach RPC endpoint ${endpoint}: ${outcome.message}`,
          },
        },
        { status: 502, headers: { 'cache-control': 'no-store' } },
      );
    }

    if (outcome.status < 200 || outcome.status >= 300) {
      const htmlLike = looksLikeHtml(outcome.rawText);
      if (hasNext && (outcome.status === 429 || outcome.status >= 500 || htmlLike)) {
        continue;
      }
      const snippet = compactSnippet(outcome.rawText);
      return Response.json(
        {
          ok: false,
          error: {
            code: 'upstream_http_error',
            message: `Foundry RPC HTTP ${outcome.status}: ${outcome.statusText} at ${endpoint}${snippet ? `. Body: ${snippet}` : ''}`,
          },
        },
        { status: 502, headers: { 'cache-control': 'no-store' } },
      );
    }

    if (!outcome.json || typeof outcome.json !== 'object') {
      const htmlLike = looksLikeHtml(outcome.rawText);
      if (hasNext && (htmlLike || !outcome.rawText.trim())) {
        continue;
      }
      const snippet = compactSnippet(outcome.rawText);
      return Response.json(
        {
          ok: false,
          error: {
            code: 'upstream_invalid_json',
            message: `Foundry RPC at ${endpoint} returned invalid JSON.${htmlLike ? ' Upstream returned HTML instead of JSON-RPC.' : ''}${snippet ? ` Body: ${snippet}` : ''}`,
          },
        },
        { status: 502, headers: { 'cache-control': 'no-store' } },
      );
    }

    const rpc = outcome.json as Record<string, unknown>;
    if ('error' in rpc && rpc.error != null) {
      return Response.json(
        {
          ok: false,
          error: {
            code: 'rpc_error',
            message: asRpcErrorMessage(rpc.error),
            data: (rpc.error as RpcUpstreamError).data,
          },
        },
        { headers: { 'cache-control': 'no-store' } },
      );
    }

    return Response.json(
      {
        ok: true,
        result: 'result' in rpc ? rpc.result : null,
      },
      { headers: { 'cache-control': 'no-store' } },
    );
  }

  return Response.json(
    {
      ok: false,
      error: {
        code: 'upstream_unreachable',
        message: 'All RPC endpoints failed to return a valid JSON-RPC response.',
      },
    },
    { status: 502, headers: { 'cache-control': 'no-store' } },
  );
}
