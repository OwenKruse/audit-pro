type ProtocolRow = {
  id?: string;
  name: string;
  symbol?: string;
  category?: string;
  chains?: string[];
  tvl?: number;
  mcap?: number;
  change_1d?: number;
  change_7d?: number;
  change_1m?: number;
  slug?: string;
};

type FeeLikeSummary = {
  total24h: number | null;
  total7d: number | null;
  total30d: number | null;
  change1d: number | null;
  allTime: number | null;
};

type ScreenerRow = {
  id?: string;
  name: string;
  symbol?: string;
  category?: string;
  chains: string[];
  tvl: number | null;
  mcap: number | null;
  mcapToTvl: number | null;
  change1d: number | null;
  change7d: number | null;
  change1m: number | null;
  slug?: string;
  fees?: FeeLikeSummary | null;
  revenue?: FeeLikeSummary | null;
};

type DataType = 'dailyFees' | 'dailyRevenue' | 'dailyHoldersRevenue';

type FeeSummaryApiResponse = {
  total24h?: unknown;
  total7d?: unknown;
  total30d?: unknown;
  change_1d?: unknown;
  totalAllTime?: unknown;
};

const DEFAULT_BASE_URL = 'https://api.llama.fi';
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function readQueryValue(query: Record<string, unknown>, key: string): string | null {
  const raw = query[key];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (item == null) continue;
      return String(item);
    }
    return null;
  }
  if (raw == null) return null;
  return String(raw);
}

function toNumber(v: string | null): number | null {
  if (v === null || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toBool(v: string | null): boolean {
  if (!v) return false;
  return ['1', 'true', 'yes', 'y', 'on'].includes(v.toLowerCase());
}

function splitList(v: string | null): string[] {
  if (!v) return [];
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function includesAny(haystack: string[], needles: string[]): boolean {
  if (needles.length === 0) return true;
  const set = new Set(haystack.map((x) => x.toLowerCase()));
  return needles.some((n) => set.has(n.toLowerCase()));
}

function matchesQuery(row: ProtocolRow, q: string): boolean {
  const needle = q.toLowerCase();
  const name = (row.name || '').toLowerCase();
  const symbol = (row.symbol || '').toLowerCase();
  const category = (row.category || '').toLowerCase();
  return name.includes(needle) || symbol.includes(needle) || category.includes(needle);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    method: 'GET',
    headers: { accept: 'application/json' },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Fetch failed ${res.status} ${res.statusText}: ${text}`);
  }

  return (await res.json()) as T;
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, idx: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;

  async function worker(): Promise<void> {
    while (true) {
      const idx = i;
      i += 1;
      if (idx >= items.length) return;
      const item = items[idx];
      if (item === undefined) continue;
      out[idx] = await fn(item, idx);
    }
  }

  const workers = Array.from({ length: Math.max(1, limit) }, () => worker());
  await Promise.all(workers);
  return out;
}

function normalizeProtocol(p: ProtocolRow): ScreenerRow {
  const tvl = typeof p.tvl === 'number' ? p.tvl : null;
  const mcap = typeof p.mcap === 'number' ? p.mcap : null;
  const mcapToTvl = tvl && mcap && tvl > 0 ? Number((mcap / tvl).toFixed(6)) : null;

  return {
    id: p.id,
    name: p.name,
    symbol: p.symbol,
    category: p.category,
    chains: Array.isArray(p.chains) ? p.chains : [],
    tvl,
    mcap,
    mcapToTvl,
    change1d: typeof p.change_1d === 'number' ? p.change_1d : null,
    change7d: typeof p.change_7d === 'number' ? p.change_7d : null,
    change1m: typeof p.change_1m === 'number' ? p.change_1m : null,
    slug: typeof p.slug === 'string' && p.slug.trim() ? p.slug.trim() : undefined,
  };
}

async function fetchFeeLikeSummary(
  baseUrl: string,
  slug: string,
  dataType: DataType,
): Promise<FeeLikeSummary> {
  const url = `${baseUrl}/api/summary/fees/${encodeURIComponent(slug)}?dataType=${encodeURIComponent(dataType)}`;
  const j = await fetchJson<FeeSummaryApiResponse>(url);

  const total24h = typeof j.total24h === 'number' ? j.total24h : null;
  const total7d = typeof j.total7d === 'number' ? j.total7d : null;
  const total30d = typeof j.total30d === 'number' ? j.total30d : null;
  const change1d = typeof j.change_1d === 'number' ? j.change_1d : null;
  const allTime = typeof j.totalAllTime === 'number' ? j.totalAllTime : null;

  return { total24h, total7d, total30d, change1d, allTime };
}

export async function runDexExplorerQuery(input: {
  query: Record<string, unknown>;
  baseUrl?: string;
}): Promise<{
  ok: true;
  meta: {
    total: number;
    limit: number;
    offset: number;
    sort: string;
    order: string;
    filters: {
      q: string | null;
      category: string[];
      chain: string[];
      minTvl: number | null;
      maxTvl: number | null;
      minMcap: number | null;
      maxMcap: number | null;
      minMcapToTvl: number | null;
      maxMcapToTvl: number | null;
      minChange1d: number | null;
      maxChange1d: number | null;
      minChange7d: number | null;
      maxChange7d: number | null;
      includeFees: boolean;
      includeRevenue: boolean;
    };
    source: 'defillama';
  };
  data: ScreenerRow[];
}> {
  const q = (readQueryValue(input.query, 'q') || '').trim();
  const categories = splitList(readQueryValue(input.query, 'category'));
  const chains = splitList(readQueryValue(input.query, 'chain'));

  const minTvl = toNumber(readQueryValue(input.query, 'minTvl'));
  const maxTvl = toNumber(readQueryValue(input.query, 'maxTvl'));
  const minMcap = toNumber(readQueryValue(input.query, 'minMcap'));
  const maxMcap = toNumber(readQueryValue(input.query, 'maxMcap'));
  const minMcapToTvl = toNumber(readQueryValue(input.query, 'minMcapToTvl'));
  const maxMcapToTvl = toNumber(readQueryValue(input.query, 'maxMcapToTvl'));

  const minChange1d = toNumber(readQueryValue(input.query, 'minChange1d'));
  const maxChange1d = toNumber(readQueryValue(input.query, 'maxChange1d'));
  const minChange7d = toNumber(readQueryValue(input.query, 'minChange7d'));
  const maxChange7d = toNumber(readQueryValue(input.query, 'maxChange7d'));

  const sort = (readQueryValue(input.query, 'sort') || 'tvl').trim();
  const order = (readQueryValue(input.query, 'order') || 'desc').trim().toLowerCase();
  const limitRaw = toNumber(readQueryValue(input.query, 'limit')) ?? DEFAULT_LIMIT;
  const offsetRaw = toNumber(readQueryValue(input.query, 'offset')) ?? 0;

  const limit = clamp(Math.trunc(limitRaw), 1, MAX_LIMIT);
  const offset = Math.max(0, Math.trunc(offsetRaw));

  const includeFees = toBool(readQueryValue(input.query, 'includeFees'));
  const includeRevenue = toBool(readQueryValue(input.query, 'includeRevenue'));
  const dataSourceBaseUrl = input.baseUrl || DEFAULT_BASE_URL;

  const protocols = await fetchJson<ProtocolRow[]>(`${dataSourceBaseUrl}/protocols`);

  const normalized = protocols
    .filter((p) => p && typeof p.name === 'string' && p.name.length > 0)
    .filter((p) => (q ? matchesQuery(p, q) : true))
    .filter((p) => {
      if (categories.length === 0) return true;
      const category = typeof p.category === 'string' ? p.category.toLowerCase() : null;
      if (!category) return false;
      return categories.some((c) => c.toLowerCase() === category);
    })
    .filter((p) => includesAny(p.chains || [], chains))
    .map(normalizeProtocol)
    .filter((r) => {
      if (minTvl !== null && (r.tvl === null || r.tvl < minTvl)) return false;
      if (maxTvl !== null && (r.tvl === null || r.tvl > maxTvl)) return false;

      if (minMcap !== null && (r.mcap === null || r.mcap < minMcap)) return false;
      if (maxMcap !== null && (r.mcap === null || r.mcap > maxMcap)) return false;

      if (minMcapToTvl !== null && (r.mcapToTvl === null || r.mcapToTvl < minMcapToTvl)) return false;
      if (maxMcapToTvl !== null && (r.mcapToTvl === null || r.mcapToTvl > maxMcapToTvl)) return false;

      if (minChange1d !== null && (r.change1d === null || r.change1d < minChange1d)) return false;
      if (maxChange1d !== null && (r.change1d === null || r.change1d > maxChange1d)) return false;

      if (minChange7d !== null && (r.change7d === null || r.change7d < minChange7d)) return false;
      if (maxChange7d !== null && (r.change7d === null || r.change7d > maxChange7d)) return false;

      return true;
    });

  const dir = order === 'asc' ? 1 : -1;

  const keyFn = {
    tvl: (r: ScreenerRow) => r.tvl ?? -Infinity,
    mcap: (r: ScreenerRow) => r.mcap ?? -Infinity,
    mcapToTvl: (r: ScreenerRow) => r.mcapToTvl ?? -Infinity,
    change1d: (r: ScreenerRow) => r.change1d ?? -Infinity,
    change7d: (r: ScreenerRow) => r.change7d ?? -Infinity,
    change1m: (r: ScreenerRow) => r.change1m ?? -Infinity,
    name: (r: ScreenerRow) => (r.name ? r.name.toLowerCase().charCodeAt(0) : -Infinity),
  };
  const sortKey = sort in keyFn ? (sort as keyof typeof keyFn) : 'tvl';
  const getKey = keyFn[sortKey];

  if (sortKey === 'name') {
    normalized.sort((a, b) => (order === 'asc' ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name)));
  } else {
    normalized.sort((a, b) => {
      const ka = getKey(a);
      const kb = getKey(b);
      if (ka === kb) return a.name.localeCompare(b.name);
      return ka > kb ? dir : -dir;
    });
  }

  const total = normalized.length;
  const page = normalized.slice(offset, offset + limit);

  let enriched: ScreenerRow[] = page;
  const wantsAnyEnrichment = includeFees || includeRevenue;

  if (wantsAnyEnrichment) {
    enriched = await mapLimit(page, 6, async (row): Promise<ScreenerRow> => {
      const slug =
        row.slug ||
        row.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/(^-|-$)/g, '');

      const out: ScreenerRow = { ...row };

      try {
        if (includeFees) {
          out.fees = await fetchFeeLikeSummary(dataSourceBaseUrl, slug, 'dailyFees');
        }
      } catch {
        out.fees = null;
      }

      try {
        if (includeRevenue) {
          out.revenue = await fetchFeeLikeSummary(dataSourceBaseUrl, slug, 'dailyRevenue');
        }
      } catch {
        out.revenue = null;
      }

      return out;
    });
  }

  return {
    ok: true,
    meta: {
      total,
      limit,
      offset,
      sort,
      order,
      filters: {
        q: q || null,
        category: categories,
        chain: chains,
        minTvl,
        maxTvl,
        minMcap,
        maxMcap,
        minMcapToTvl,
        maxMcapToTvl,
        minChange1d,
        maxChange1d,
        minChange7d,
        maxChange7d,
        includeFees,
        includeRevenue,
      },
      source: 'defillama',
    },
    data: enriched,
  };
}
