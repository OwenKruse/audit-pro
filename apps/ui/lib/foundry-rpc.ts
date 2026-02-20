import { recordRpcInteraction, type EthereumProvider } from './foundry-store';

export type FoundryRpcRequest = {
  rpcUrl: string;
  method: string;
  params?: unknown[];
  chainId?: number | null;
};

type FoundryRpcSuccess<T> = {
  ok: true;
  result: T;
};

type FoundryRpcError = {
  ok: false;
  error: { code: string; message: string; data?: unknown };
};

function nowMs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function elapsedMs(start: number): number {
  const value = nowMs() - start;
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function errorMessage(err: unknown, fallback: string): string {
  if (!err || typeof err !== 'object') return fallback;
  const message = (err as { message?: unknown }).message;
  return typeof message === 'string' && message.trim() ? message : fallback;
}

export async function callFoundryRpc<T = unknown>(
  input: FoundryRpcRequest,
  init?: { signal?: AbortSignal },
): Promise<T> {
  const started = nowMs();
  const res = await fetch('/api/foundry/rpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      rpcUrl: input.rpcUrl,
      method: input.method,
      params: input.params ?? [],
    }),
    signal: init?.signal,
  });

  const json = (await res.json().catch(() => null)) as FoundryRpcSuccess<T> | FoundryRpcError | null;

  if (!res.ok || !json || !('ok' in json) || !json.ok) {
    const message =
      json && 'error' in json && json.error?.message
        ? json.error.message
        : `Foundry RPC call failed (${res.status})`;
    recordRpcInteraction({
      source: 'foundry',
      rpcUrl: input.rpcUrl,
      chainId: input.chainId ?? null,
      method: input.method,
      params: input.params ?? [],
      status: 'error',
      error: message,
      durationMs: elapsedMs(started),
    });
    void fetch('/api/rpc/interactions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source: 'foundry',
        rpcUrl: input.rpcUrl,
        chainId: input.chainId ?? null,
        method: input.method,
        params: input.params ?? [],
        status: 'error',
        error: message,
        durationMs: elapsedMs(started),
        tx: null,
        txHash: null,
        result: null,
      }),
    }).catch(() => null);
    throw new Error(message);
  }

  recordRpcInteraction({
    source: 'foundry',
    rpcUrl: input.rpcUrl,
    chainId: input.chainId ?? null,
    method: input.method,
    params: input.params ?? [],
    status: 'success',
    durationMs: elapsedMs(started),
    result: json.result,
  });
  void fetch('/api/rpc/interactions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      source: 'foundry',
      rpcUrl: input.rpcUrl,
      chainId: input.chainId ?? null,
      method: input.method,
      params: input.params ?? [],
      status: 'success',
      error: null,
      durationMs: elapsedMs(started),
      tx: null,
      txHash: null,
      result: json.result,
    }),
  }).catch(() => null);

  return json.result;
}

export async function callWalletRpc<T = unknown>(input: {
  provider: EthereumProvider;
  method: string;
  params?: unknown[] | Record<string, unknown>;
  rpcUrl?: string | null;
  chainId?: number | null;
}): Promise<T> {
  const started = nowMs();
  try {
    const result = await input.provider.request({
      method: input.method,
      params: input.params,
    });
    recordRpcInteraction({
      source: 'wallet',
      rpcUrl: input.rpcUrl ?? null,
      chainId: input.chainId ?? null,
      method: input.method,
      params: input.params ?? [],
      status: 'success',
      durationMs: elapsedMs(started),
      result,
    });
    void fetch('/api/rpc/interactions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source: 'wallet',
        rpcUrl: input.rpcUrl ?? null,
        chainId: input.chainId ?? null,
        method: input.method,
        params: input.params ?? [],
        status: 'success',
        error: null,
        durationMs: elapsedMs(started),
        tx: null,
        txHash: null,
        result,
      }),
    }).catch(() => null);
    return result as T;
  } catch (err) {
    const msg = errorMessage(err, 'Wallet RPC call failed.');
    recordRpcInteraction({
      source: 'wallet',
      rpcUrl: input.rpcUrl ?? null,
      chainId: input.chainId ?? null,
      method: input.method,
      params: input.params ?? [],
      status: 'error',
      error: msg,
      durationMs: elapsedMs(started),
    });
    void fetch('/api/rpc/interactions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source: 'wallet',
        rpcUrl: input.rpcUrl ?? null,
        chainId: input.chainId ?? null,
        method: input.method,
        params: input.params ?? [],
        status: 'error',
        error: msg,
        durationMs: elapsedMs(started),
        tx: null,
        txHash: null,
        result: null,
      }),
    }).catch(() => null);
    throw err;
  }
}
