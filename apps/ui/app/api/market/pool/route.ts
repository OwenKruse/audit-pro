import { fetchJsonWithCache } from '../_lib/cache';
import { GECKO_BASE_URL, normalizePool, normalizeTrades } from '../_lib/gecko';

function isSafeNetworkId(value: string): boolean {
  // GeckoTerminal network ids are url segments like "eth", "arbitrum", "polygon_pos".
  return /^[a-z0-9][a-z0-9_-]*$/.test(value);
}

export async function GET(req: Request): Promise<Response> {
  const { searchParams } = new URL(req.url);
  const network = (searchParams.get('network') ?? '').trim().toLowerCase();
  const address = (searchParams.get('address') ?? '').trim();

  if (!network || !isSafeNetworkId(network)) {
    return Response.json(
      { ok: false, error: { code: 'bad_request', message: 'Invalid network.' } },
      { status: 400, headers: { 'cache-control': 'no-store' } },
    );
  }
  if (!address) {
    return Response.json(
      { ok: false, error: { code: 'bad_request', message: 'Missing address.' } },
      { status: 400, headers: { 'cache-control': 'no-store' } },
    );
  }

  const include = 'base_token,quote_token,dex';
  const poolUrl = `${GECKO_BASE_URL}/networks/${encodeURIComponent(network)}/pools/${encodeURIComponent(address)}?include=${include}`;
  const tradesUrl = `${GECKO_BASE_URL}/networks/${encodeURIComponent(network)}/pools/${encodeURIComponent(address)}/trades`;

  const commonCache = {
    ttlMs: 30_000,
    staleIfErrorMs: 30 * 60 * 1000,
    cooldownOn429Ms: 2 * 60 * 1000,
  } as const;

  const [poolUpstream, tradesUpstream] = await Promise.all([
    fetchJsonWithCache(poolUrl, commonCache),
    fetchJsonWithCache(tradesUrl, commonCache),
  ]);

  if (!poolUpstream.ok) {
    const status = poolUpstream.status === 429 ? 429 : 502;
    return Response.json(
      {
        ok: false,
        error: {
          code: poolUpstream.status === 429 ? 'rate_limited' : 'upstream_error',
          message: poolUpstream.message,
          status: poolUpstream.status,
        },
      },
      { status, headers: { 'cache-control': 'no-store' } },
    );
  }

  if (!tradesUpstream.ok) {
    const status = tradesUpstream.status === 429 ? 429 : 502;
    return Response.json(
      {
        ok: false,
        error: {
          code: tradesUpstream.status === 429 ? 'rate_limited' : 'upstream_error',
          message: tradesUpstream.message,
          status: tradesUpstream.status,
        },
      },
      { status, headers: { 'cache-control': 'no-store' } },
    );
  }

  const pool = normalizePool(poolUpstream.json);
  if (!pool) {
    return Response.json(
      { ok: false, error: { code: 'upstream_error', message: 'Failed to parse pool payload.' } },
      { status: 502, headers: { 'cache-control': 'no-store' } },
    );
  }

  const trades = normalizeTrades(tradesUpstream.json);

  return Response.json(
    { ok: true, network, address, pool, trades },
    { headers: { 'cache-control': 'public, max-age=30, stale-while-revalidate=120' } },
  );
}
