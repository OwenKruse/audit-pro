import { fetchJsonWithCache } from '../_lib/cache';
import { GECKO_BASE_URL, normalizePools } from '../_lib/gecko';

type View = 'new' | 'trending' | 'top' | 'search';

function isValidView(value: string | null): value is View {
  return value === 'new' || value === 'trending' || value === 'top' || value === 'search';
}

export async function GET(req: Request): Promise<Response> {
  const { searchParams } = new URL(req.url);

  const viewParam = searchParams.get('view');
  const view: View = isValidView(viewParam) ? viewParam : 'new';

  const network = (searchParams.get('network') ?? 'eth').trim().toLowerCase();
  const order = (searchParams.get('order') ?? 'h24_volume_usd_desc').trim();
  const q = (searchParams.get('q') ?? '').trim();
  const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10) || 1);

  if (view !== 'search' && !network) {
    return Response.json(
      { ok: false, error: { code: 'bad_request', message: 'Missing network.' } },
      { status: 400, headers: { 'cache-control': 'no-store' } },
    );
  }

  if (view === 'search' && !q) {
    return Response.json(
      { ok: false, error: { code: 'bad_request', message: 'Missing query.' } },
      { status: 400, headers: { 'cache-control': 'no-store' } },
    );
  }

  const include = 'base_token,quote_token,dex';
  const upstreamUrl = (() => {
    if (view === 'new') return `${GECKO_BASE_URL}/networks/${encodeURIComponent(network)}/new_pools?include=${include}&page=${page}`;
    if (view === 'trending')
      return `${GECKO_BASE_URL}/networks/${encodeURIComponent(network)}/trending_pools?include=${include}&page=${page}`;
    if (view === 'top')
      return `${GECKO_BASE_URL}/networks/${encodeURIComponent(network)}/pools?include=${include}&order=${encodeURIComponent(order)}&page=${page}`;
    return `${GECKO_BASE_URL}/search/pools?include=${include}&query=${encodeURIComponent(q)}&page=${page}`;
  })();

  const ttlMs = view === 'top' ? 60_000 : 30_000;
  const upstream = await fetchJsonWithCache(upstreamUrl, {
    ttlMs,
    staleIfErrorMs: 30 * 60 * 1000,
    cooldownOn429Ms: 2 * 60 * 1000,
  });
  if (!upstream.ok) {
    const status = upstream.status === 429 ? 429 : 502;
    return Response.json(
      {
        ok: false,
        error: {
          code: upstream.status === 429 ? 'rate_limited' : 'upstream_error',
          message: upstream.message,
          status: upstream.status,
        },
      },
      { status, headers: { 'cache-control': 'no-store' } },
    );
  }

  let items = normalizePools(upstream.json);
  if (view === 'search' && network) {
    items = items.filter((p) => (p.networkId ?? '').toLowerCase() === network.toLowerCase());
  }

  return Response.json(
    { ok: true, view, network: network || null, order, q: q || null, page, items },
    { headers: { 'cache-control': 'public, max-age=30, stale-while-revalidate=120' } },
  );
}
