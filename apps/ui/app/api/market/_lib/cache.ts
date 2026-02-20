type CacheEntry = {
  expiresAt: number;
  staleExpiresAt: number;
  retryAt: number | null;
  json: unknown;
};

declare global {
  var __csMarketApiCache: Map<string, CacheEntry> | undefined;
  var __csMarketApiInflight: Map<string, Promise<FetchJsonResult>> | undefined;
}

const cache: Map<string, CacheEntry> = globalThis.__csMarketApiCache ?? new Map();
globalThis.__csMarketApiCache = cache;

type FetchJsonOk = { ok: true; json: unknown; cached: boolean; stale: boolean };
type FetchJsonErr = { ok: false; status: number; message: string; bodyText: string | null };
type FetchJsonResult = FetchJsonOk | FetchJsonErr;

const inflight: Map<string, Promise<FetchJsonResult>> = globalThis.__csMarketApiInflight ?? new Map();
globalThis.__csMarketApiInflight = inflight;

const DEFAULT_STALE_IF_ERROR_MS = 10 * 60 * 1000; // Serve stale cache for up to 10 minutes on upstream failures.
const DEFAULT_COOLDOWN_ON_429_MS = 60_000; // Backoff 1m when we see upstream 429 for a URL.
const MAX_ENTRIES = 800;
const EVICT_COUNT = 80;

function maybeEvict(): void {
  if (cache.size <= MAX_ENTRIES) return;
  const it = cache.keys();
  for (let i = 0; i < EVICT_COUNT; i += 1) {
    const next = it.next();
    if (next.done) break;
    cache.delete(next.value);
  }
}

export async function fetchJsonWithCache(
  url: string,
  opts: { ttlMs: number; staleIfErrorMs?: number; cooldownOn429Ms?: number; signal?: AbortSignal },
): Promise<FetchJsonResult> {
  const staleIfErrorMs = Math.max(0, opts.staleIfErrorMs ?? DEFAULT_STALE_IF_ERROR_MS);
  const cooldownOn429Ms = Math.max(0, opts.cooldownOn429Ms ?? DEFAULT_COOLDOWN_ON_429_MS);

  const now = Date.now();
  const hit = cache.get(url);
  if (hit && hit.expiresAt > now) {
    return { ok: true, json: hit.json, cached: true, stale: false };
  }

  if (hit && hit.retryAt && hit.retryAt > now) {
    // During cooldown, serve stale if we have it instead of hammering upstream.
    return { ok: true, json: hit.json, cached: true, stale: true };
  }

  const inflightHit = inflight.get(url);
  if (inflightHit) {
    const result = await inflightHit;
    if (result.ok) return result;
    if (hit && hit.staleExpiresAt > now) {
      return { ok: true, json: hit.json, cached: true, stale: true };
    }
    return result;
  }

  const promise = (async (): Promise<FetchJsonResult> => {
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        cache: 'no-store',
        signal: opts.signal,
      });
    } catch (err) {
      return {
        ok: false,
        status: 502,
        message: err instanceof Error ? err.message : 'Upstream request failed.',
        bodyText: null,
      };
    }

    if (!res.ok) {
      let bodyText: string | null = null;
      try {
        bodyText = await res.text();
      } catch {
        bodyText = null;
      }

      // If we have cached data, start a cooldown on 429 to avoid spamming the upstream.
      if (res.status === 429 && hit) {
        cache.set(url, {
          ...hit,
          retryAt: now + cooldownOn429Ms,
        });
      }

      return {
        ok: false,
        status: res.status,
        message: `Upstream returned ${res.status} ${res.statusText}`,
        bodyText,
      };
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch {
      return {
        ok: false,
        status: 502,
        message: 'Upstream returned invalid JSON.',
        bodyText: null,
      };
    }

    cache.set(url, {
      expiresAt: now + opts.ttlMs,
      staleExpiresAt: now + opts.ttlMs + staleIfErrorMs,
      retryAt: null,
      json,
    });
    maybeEvict();
    return { ok: true, json, cached: false, stale: false };
  })();

  inflight.set(url, promise);
  let result: FetchJsonResult;
  try {
    result = await promise;
  } finally {
    inflight.delete(url);
  }

  if (!result.ok && hit && hit.staleExpiresAt > now) {
    return { ok: true, json: hit.json, cached: true, stale: true };
  }
  return result;
}
