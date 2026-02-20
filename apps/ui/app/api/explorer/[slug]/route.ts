import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

const DEFAULT_BASE_URL = 'https://api.llama.fi';

type ProtocolIndexItem = {
  slug?: unknown;
  name?: unknown;
  symbol?: unknown;
  tvl?: unknown;
};

class FetchStatusError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'FetchStatusError';
    this.status = status;
  }
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const out = value.trim();
  return out ? out : null;
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
}

function norm(value: string): string {
  return value.trim().toLowerCase();
}

function compact(value: string): string {
  return norm(value).replace(/[^a-z0-9]/g, '');
}

function scoreCandidate(item: ProtocolIndexItem, query: string): number {
  const q = norm(query);
  const qCompact = compact(query);
  if (!q) return -1;
  const slug = asNonEmptyString(item.slug);
  const name = asNonEmptyString(item.name);
  const symbol = asNonEmptyString(item.symbol);
  const slugNorm = slug ? norm(slug) : null;
  const nameNorm = name ? norm(name) : null;
  const symbolNorm = symbol ? norm(symbol) : null;
  const slugCompact = slug ? compact(slug) : null;
  const nameCompact = name ? compact(name) : null;
  const symbolCompact = symbol ? compact(symbol) : null;

  let score = 0;
  if (slugNorm && slugNorm === q) score += 120;
  if (nameNorm && nameNorm === q) score += 105;
  if (symbolNorm && symbolNorm === q) score += 95;

  if (slugNorm && slugNorm.startsWith(q)) score += 70;
  if (nameNorm && nameNorm.startsWith(q)) score += 65;
  if (symbolNorm && symbolNorm.startsWith(q)) score += 55;

  if (slugNorm && slugNorm.includes(q)) score += 40;
  if (nameNorm && nameNorm.includes(q)) score += 35;
  if (symbolNorm && symbolNorm.includes(q)) score += 25;
  if (slugNorm && q.includes(slugNorm)) score += 30;
  if (nameNorm && q.includes(nameNorm)) score += 25;
  if (symbolNorm && q.includes(symbolNorm)) score += 20;

  if (qCompact) {
    if (slugCompact && slugCompact === qCompact) score += 80;
    if (nameCompact && nameCompact === qCompact) score += 70;
    if (symbolCompact && symbolCompact === qCompact) score += 60;
    if (slugCompact && slugCompact.includes(qCompact)) score += 35;
    if (nameCompact && nameCompact.includes(qCompact)) score += 30;
    if (symbolCompact && symbolCompact.includes(qCompact)) score += 20;
    if (slugCompact && qCompact.includes(slugCompact)) score += 25;
    if (nameCompact && qCompact.includes(nameCompact)) score += 20;
    if (symbolCompact && qCompact.includes(symbolCompact)) score += 15;
  }

  const tvl = asFiniteNumber(item.tvl);
  if (tvl && tvl > 0) score += Math.min(20, Math.log10(tvl + 1));
  return score;
}

function findProtocolSlug(index: ProtocolIndexItem[], query: string): {
  resolvedSlug: string | null;
  suggestions: Array<{ slug: string; name: string | null }>;
} {
  const scored = index
    .map((item) => ({
      item,
      slug: asNonEmptyString(item.slug),
      name: asNonEmptyString(item.name),
      score: scoreCandidate(item, query),
    }))
    .filter((entry) => entry.slug && entry.score > 0)
    .sort((a, b) => b.score - a.score);

  const resolvedSlug = scored[0]?.slug ?? null;
  const suggestions = scored.slice(0, 8).map((entry) => ({
    slug: entry.slug as string,
    name: entry.name ?? null,
  }));

  return { resolvedSlug, suggestions };
}

function getLlamaBaseUrls(): string[] {
  const candidates = [
    process.env.LLAMA_BASE_URL?.trim() ?? '',
    DEFAULT_BASE_URL,
    process.env.LLAMA_PRO_BASE_URL?.trim() ?? '',
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of candidates) {
    if (!raw) continue;
    const normalized = raw.replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(normalized)) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

async function fetchJson<T>(url: string, revalidateSeconds = 300): Promise<T> {
  const res = await fetch(url, {
    next: { revalidate: revalidateSeconds },
    headers: { accept: 'application/json' },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new FetchStatusError(res.status, `Fetch failed ${res.status} ${res.statusText}: ${text}`);
  }

  return (await res.json()) as T;
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ slug: string }> },
): Promise<Response> {
  try {
    const { slug } = await ctx.params;
    const normalizedSlug = slug.trim();
    if (!normalizedSlug) {
      return NextResponse.json(
        { ok: false, error: { message: 'Missing slug.' } },
        { status: 400 },
      );
    }

    const baseUrls = getLlamaBaseUrls();
    const errors: string[] = [];
    let suggestions: Array<{ slug: string; name: string | null }> = [];
    let hadLookupError = false;

    for (const baseUrl of baseUrls) {
      try {
        const data = await fetchJson<unknown>(
          `${baseUrl}/protocol/${encodeURIComponent(normalizedSlug)}`,
          300,
        );
        return NextResponse.json(
          {
            ok: true,
            requestedSlug: normalizedSlug,
            resolvedSlug: normalizedSlug,
            baseUrl,
            triedBaseUrls: baseUrls,
            data,
          },
          { status: 200 },
        );
      } catch (err) {
        if (!(err instanceof FetchStatusError) || err.status !== 404) {
          hadLookupError = true;
          errors.push(`${baseUrl}: ${err instanceof Error ? err.message : String(err)}`);
          continue;
        }
      }

      try {
        const index = await fetchJson<ProtocolIndexItem[]>(`${baseUrl}/protocols`, 300);
        const resolved = findProtocolSlug(index, normalizedSlug);
        if (suggestions.length === 0) suggestions = resolved.suggestions;
        if (!resolved.resolvedSlug) continue;

        const data = await fetchJson<unknown>(
          `${baseUrl}/protocol/${encodeURIComponent(resolved.resolvedSlug)}`,
          300,
        );
        return NextResponse.json(
          {
            ok: true,
            requestedSlug: normalizedSlug,
            resolvedSlug: resolved.resolvedSlug,
            suggestions: resolved.suggestions,
            baseUrl,
            triedBaseUrls: baseUrls,
            data,
          },
          { status: 200 },
        );
      } catch (err) {
        if (err instanceof FetchStatusError && err.status === 404) {
          continue;
        }
        hadLookupError = true;
        errors.push(`${baseUrl}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (!hadLookupError) {
      return NextResponse.json(
        {
          ok: false,
          error: { message: `Protocol "${normalizedSlug}" not found.` },
          suggestions,
          triedBaseUrls: baseUrls,
        },
        { status: 404 },
      );
    }

    throw new Error(
      `Failed to resolve protocol "${normalizedSlug}" across configured bases. ${errors.join(' | ')}`,
    );
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: { message: err instanceof Error ? err.message : 'Unknown error' },
      },
      { status: 500 },
    );
  }
}
