import { fetchJsonWithCache } from '../_lib/cache';
import { GECKO_BASE_URL, normalizeNetwork } from '../_lib/gecko';

export async function GET(req: Request): Promise<Response> {
  const { searchParams } = new URL(req.url);
  const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10) || 1);

  const url = `${GECKO_BASE_URL}/networks?page=${page}`;
  const upstream = await fetchJsonWithCache(url, { ttlMs: 6 * 60 * 60 * 1000 });
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

  const root = upstream.json;
  const rootRec =
    root && typeof root === 'object' && !Array.isArray(root)
      ? (root as Record<string, unknown>)
      : null;
  const data = rootRec && Array.isArray(rootRec.data) ? rootRec.data : [];
  const items = data
    .map((entry) => normalizeNetwork(entry))
    .filter((v): v is NonNullable<typeof v> => Boolean(v));

  let nextPage: number | null = null;
  const linksRec =
    rootRec && rootRec.links && typeof rootRec.links === 'object' && !Array.isArray(rootRec.links)
      ? (rootRec.links as Record<string, unknown>)
      : null;
  const next = linksRec && typeof linksRec.next === 'string' ? linksRec.next : null;
  if (next) {
    try {
      const nextUrl = new URL(next);
      const p = parseInt(nextUrl.searchParams.get('page') ?? '', 10);
      if (Number.isFinite(p) && p > page) nextPage = p;
    } catch {
      nextPage = null;
    }
  }

  return Response.json(
    { ok: true, items, page, nextPage },
    { headers: { 'cache-control': 'public, max-age=600, stale-while-revalidate=600' } },
  );
}
