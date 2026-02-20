'use client';

import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { RefreshCw, Search, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';

type ZoomeyeHostItem = {
  id: string;
  ip: string | null;
  port: number | null;
  service: string | null;
  protocol: string | null;
  domain: string | null;
  hostname: string | null;
  country: string | null;
  province: string | null;
  city: string | null;
  organization: string | null;
  product: string | null;
  app: string | null;
  updateTime: string | null;
};

type ShodanHostItem = {
  id: string;
  ip: string | null;
  port: number | null;
  transport: string | null;
  domains: string[];
  hostnames: string[];
  organization: string | null;
  isp: string | null;
  asn: string | null;
  os: string | null;
  product: string | null;
  version: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  timestamp: string | null;
  banner: string | null;
  raw: Record<string, unknown>;
};

type ZoomeyeSearchApiResponse =
  | {
      ok: true;
      meta: {
        query: string;
        page: number;
        pageSize: number;
        subType: 'v4' | 'v6' | 'web';
        total: number | null;
        source: 'zoomeye';
      };
      items: ZoomeyeHostItem[];
    }
  | { ok: false; error: { code: string; message: string } };

type ShodanSearchApiResponse =
  | {
      ok: true;
      meta: {
        query: string;
        page: number;
        pageSize: number;
        facets: string | null;
        total: number | null;
        source: 'shodan';
      };
      items: ShodanHostItem[];
    }
  | { ok: false; error: { code: string; message: string } };

type PassedShodanSearchSummary = {
  id: string;
  createdAt: string;
  query: string;
  page: number;
  pageSize: number;
  facets: string | null;
  minify: boolean;
  total: number | null;
  count: number;
  summary: string;
};

type PassedShodanSearchDetail = PassedShodanSearchSummary & {
  args: Record<string, unknown>;
  meta: Record<string, unknown> | null;
  items: Array<Record<string, unknown>>;
};

type PassedShodanSearchListApiResponse =
  | {
      ok: true;
      items: PassedShodanSearchSummary[];
    }
  | { ok: false; error: { code: string; message: string } };

type PassedShodanSearchDetailApiResponse =
  | {
      ok: true;
      item: PassedShodanSearchDetail;
    }
  | { ok: false; error: { code: string; message: string } };

function fmtAgo(iso: string | null | undefined): string {
  if (!iso) return '-';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const diffSec = Math.floor((Date.now() - t) / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 48) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

function fmtStamp(iso: string | null | undefined): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function firstNonEmpty(values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function asText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const out = value.trim();
  return out.length > 0 ? out : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function joinLocation(parts: Array<string | null | undefined>): string {
  const out = parts.filter((part): part is string => typeof part === 'string' && part.trim().length > 0);
  return out.length > 0 ? out.join(', ') : '-';
}

function zoomeyeHostEndpoint(item: ZoomeyeHostItem): string {
  const host = firstNonEmpty([item.ip, item.domain, item.hostname, item.id]) ?? item.id;
  if (item.port == null) return host;
  return `${host}:${item.port}`;
}

function shodanHostEndpoint(item: ShodanHostItem): string {
  const host =
    firstNonEmpty([item.ip, item.hostnames[0], item.domains[0], item.organization, item.id]) ?? item.id;
  if (item.port == null) return host;
  return `${host}:${item.port}`;
}

function rawSearchEndpoint(item: Record<string, unknown>): string {
  const host =
    firstNonEmpty([
      asText(item.ip),
      asText(item.ip_str),
      Array.isArray(item.hostnames) ? asText(item.hostnames[0]) : null,
      Array.isArray(item.domains) ? asText(item.domains[0]) : null,
    ]) ?? 'unknown';
  const port = asNumber(item.port);
  if (port == null) return host;
  return `${host}:${Math.trunc(port)}`;
}

function rawSearchService(item: Record<string, unknown>): string {
  return firstNonEmpty([
    asText(item.product),
    asText(item.transport),
    asText(item.service),
    asText(item.org),
  ]) ?? '-';
}

function toJson(value: unknown): string {
  try {
    return JSON.stringify(
      value,
      (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
      2,
    );
  } catch {
    return String(value);
  }
}

function parseVulnsFromRaw(raw: Record<string, unknown>): string[] {
  const v = raw.vulns;
  if (Array.isArray(v)) {
    return v
      .map((x) => (typeof x === 'string' ? x.trim() : null))
      .filter((x): x is string => x != null && x.length > 0);
  }
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    return Object.keys(v).filter((k) => k.trim().length > 0);
  }
  return [];
}

function parseTagsFromRaw(raw: Record<string, unknown>): string[] {
  const tags = raw.tags;
  if (Array.isArray(tags)) {
    return tags
      .map((x) => (typeof x === 'string' ? x.trim() : null))
      .filter((x): x is string => x != null && x.length > 0);
  }
  const tag = raw.tag;
  if (typeof tag === 'string' && tag.trim()) return [tag.trim()];
  return [];
}

function parsePortsFromRaw(raw: Record<string, unknown>, singlePort: number | null): number[] {
  const ports = raw.ports;
  if (Array.isArray(ports)) {
    const nums = ports
      .map((p) => (typeof p === 'number' && Number.isFinite(p) ? p : typeof p === 'string' ? parseInt(p, 10) : NaN))
      .filter((n) => Number.isFinite(n));
    if (nums.length > 0) return [...new Set(nums)].sort((a, b) => a - b);
  }
  if (singlePort != null) return [singlePort];
  return [];
}

function parseCpeFromRaw(raw: Record<string, unknown>): string[] {
  const cpe = raw.cpe;
  if (Array.isArray(cpe)) {
    return cpe
      .map((x) => (typeof x === 'string' ? x.trim() : null))
      .filter((x): x is string => x != null && x.length > 0);
  }
  if (typeof cpe === 'string' && cpe.trim()) return [cpe.trim()];
  return [];
}

export function ZoomeyeWorkbench() {
  return (
    <div className="flex h-full min-h-0 flex-col bg-[color:var(--cs-panel)]">
      <div className="flex items-center gap-2 border-b border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-3 py-2">
        <h3 className="text-[11px] font-bold uppercase tracking-wider text-[color:var(--cs-fg)]">Host Search</h3>
        <Badge variant="outline" className="text-[10px]">
          ZoomEye + Shodan
        </Badge>
      </div>

      <div className="min-h-0 flex-1 p-3">
        <Tabs defaultValue="shodan" className="h-full min-h-0">
          <TabsList variant="line" className="w-fit">
            <TabsTrigger value="shodan">Shodan</TabsTrigger>
            <TabsTrigger value="zoomeye">ZoomEye</TabsTrigger>
          </TabsList>

          <TabsContent value="shodan" className="h-full min-h-0">
            <ShodanPanel />
          </TabsContent>
          <TabsContent value="zoomeye" className="h-full min-h-0">
            <ZoomeyePanel />
          </TabsContent>
        </Tabs>
      </div>

      <div className="border-t border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-3 py-1.5 text-[10px] text-[color:var(--cs-muted)]">
        <div className="flex items-center gap-1.5">
          <TriangleAlert className="h-3.5 w-3.5" />
          Results depend on your ZoomEye/Shodan API plan, query syntax, and rate limits.
        </div>
      </div>
    </div>
  );
}

function ZoomeyePanel() {
  const [queryInput, setQueryInput] = useState('app="Apache Tomcat"');
  const [subType, setSubType] = useState<'v4' | 'v6' | 'web'>('v4');
  const [pageSize, setPageSize] = useState(20);
  const [page, setPage] = useState(1);
  const [request, setRequest] = useState('app="Apache Tomcat"');
  const [refreshTick, setRefreshTick] = useState(0);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [meta, setMeta] = useState<Extract<ZoomeyeSearchApiResponse, { ok: true }>['meta'] | null>(null);
  const [items, setItems] = useState<ZoomeyeHostItem[]>([]);

  const abortRef = useRef<AbortController | null>(null);

  const loadHosts = useCallback(async () => {
    const q = request.trim();
    if (!q) {
      setItems([]);
      setMeta(null);
      setError('Query is required.');
      return;
    }

    setLoading(true);
    setError(null);
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const qs = new URLSearchParams();
    qs.set('q', q);
    qs.set('subType', subType);
    qs.set('page', String(page));
    qs.set('pageSize', String(pageSize));

    try {
      const res = await fetch(`/api/zoomeye/hosts?${qs.toString()}`, {
        method: 'GET',
        cache: 'no-store',
        signal: controller.signal,
      });
      const json = (await res.json().catch(() => null)) as ZoomeyeSearchApiResponse | null;
      if (!res.ok || !json || json.ok !== true) {
        throw new Error(json && json.ok === false ? json.error.message : `Search failed (${res.status}).`);
      }

      setMeta(json.meta);
      setItems(json.items);
    } catch (err) {
      if (controller.signal.aborted) return;
      setMeta(null);
      setItems([]);
      setError(err instanceof Error ? err.message : 'Search failed.');
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [page, pageSize, request, subType]);

  useEffect(() => {
    void loadHosts();
  }, [loadHosts, refreshTick]);

  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  const onSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const q = queryInput.trim();
      if (!q) {
        setError('Query is required.');
        return;
      }
      setPage(1);
      setRequest(q);
    },
    [queryInput],
  );

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)]">
      <form
        onSubmit={onSubmit}
        className="flex flex-col gap-2 border-b border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-3 py-2"
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h4 className="text-[11px] font-bold uppercase tracking-wider text-[color:var(--cs-fg)]">ZoomEye</h4>
            <Badge variant="outline" className="text-[10px]">
              Host Search
            </Badge>
          </div>
          <button
            type="button"
            onClick={() => setRefreshTick((n) => n + 1)}
            className="inline-flex h-7 items-center gap-1 rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 text-[11px] font-medium text-[color:var(--cs-fg)] hover:bg-[color:var(--cs-hover)]"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[220px] flex-1">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-[color:var(--cs-muted)]" />
            <input
              value={queryInput}
              onChange={(event) => setQueryInput(event.target.value)}
              placeholder='app="Apache Tomcat"'
              className="h-8 w-full rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] pl-8 pr-2 text-[12px] outline-none focus:border-[color:var(--cs-accent)]"
            />
          </div>

          <select
            value={subType}
            onChange={(event) => setSubType(event.target.value as 'v4' | 'v6' | 'web')}
            className="h-8 rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 text-[12px] outline-none focus:border-[color:var(--cs-accent)]"
          >
            <option value="v4">IPv4</option>
            <option value="v6">IPv6</option>
            <option value="web">Web</option>
          </select>

          <select
            value={pageSize}
            onChange={(event) => setPageSize(Number(event.target.value))}
            className="h-8 rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 text-[12px] outline-none focus:border-[color:var(--cs-accent)]"
          >
            <option value={20}>20</option>
            <option value={50}>50</option>
            <option value={100}>100</option>
          </select>

          <button
            type="submit"
            className="inline-flex h-8 items-center gap-1 rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-accent-soft)] px-2 text-[11px] font-semibold text-[color:var(--cs-fg)] hover:bg-[color:var(--cs-hover)]"
          >
            <Search className="h-3.5 w-3.5" />
            Search
          </button>
        </div>

        <div className="flex items-center gap-2 text-[11px] text-[color:var(--cs-muted)]">
          <button
            type="button"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
            className="h-7 rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 text-[11px] text-[color:var(--cs-fg)] hover:bg-[color:var(--cs-hover)] disabled:opacity-50"
          >
            Prev
          </button>
          <span>Page {page}</span>
          <button
            type="button"
            onClick={() => setPage((p) => p + 1)}
            className="h-7 rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 text-[11px] text-[color:var(--cs-fg)] hover:bg-[color:var(--cs-hover)]"
          >
            Next
          </button>
          <span className="ml-auto">{meta?.total != null ? `${meta.total.toLocaleString()} matches` : 'Total unknown'}</span>
        </div>

        {error ? (
          <div className="rounded border border-rose-500/30 bg-rose-500/10 px-2 py-1 text-[11px] text-rose-200">{error}</div>
        ) : null}
      </form>

      <div className="grid grid-cols-[1.5fr_1fr_1fr_88px] border-b border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-3 py-2 text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">
        <div>Host</div>
        <div>Service</div>
        <div>Location</div>
        <div className="text-right">Updated</div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {loading ? (
          <div className="p-6 text-[12px] text-[color:var(--cs-muted)]">Loading ZoomEye results...</div>
        ) : items.length === 0 ? (
          <div className="p-6 text-[12px] text-[color:var(--cs-muted)]">No ZoomEye hosts found for this query.</div>
        ) : (
          items.map((item) => (
            <div
              key={item.id}
              className="grid grid-cols-[1.5fr_1fr_1fr_88px] items-center gap-2 border-b border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-3 py-2 text-[12px]"
            >
              <div className="min-w-0">
                <div className="truncate font-semibold text-[color:var(--cs-fg)]">{zoomeyeHostEndpoint(item)}</div>
                <div className="truncate text-[10px] text-[color:var(--cs-muted)]">
                  {firstNonEmpty([item.product, item.app, item.organization, item.hostname, item.domain]) ?? 'Unknown'}
                </div>
              </div>
              <div className="truncate text-[11px] text-[color:var(--cs-fg)]">
                {firstNonEmpty([item.service, item.protocol]) ?? '-'}
              </div>
              <div className="truncate text-[11px] text-[color:var(--cs-muted)]">
                {joinLocation([item.city, item.province, item.country])}
              </div>
              <div className="text-right text-[11px] text-[color:var(--cs-muted)]">{fmtAgo(item.updateTime)}</div>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function ShodanPanel() {
  const [queryInput, setQueryInput] = useState('apache country:US');
  const [facetsInput, setFacetsInput] = useState('country,org,port');
  const [pageSize, setPageSize] = useState(20);
  const [page, setPage] = useState(1);
  const [request, setRequest] = useState({ q: 'apache country:US', facets: 'country,org,port' });
  const [refreshTick, setRefreshTick] = useState(0);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [meta, setMeta] = useState<Extract<ShodanSearchApiResponse, { ok: true }>['meta'] | null>(null);
  const [items, setItems] = useState<ShodanHostItem[]>([]);
  const [selectedHost, setSelectedHost] = useState<ShodanHostItem | null>(null);

  const [passedLoading, setPassedLoading] = useState(false);
  const [passedError, setPassedError] = useState<string | null>(null);
  const [passedSearches, setPassedSearches] = useState<PassedShodanSearchSummary[]>([]);

  const [selectedPassedId, setSelectedPassedId] = useState<string | null>(null);
  const [selectedPassedLoading, setSelectedPassedLoading] = useState(false);
  const [selectedPassedError, setSelectedPassedError] = useState<string | null>(null);
  const [selectedPassedSearch, setSelectedPassedSearch] = useState<PassedShodanSearchDetail | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const passedAbortRef = useRef<AbortController | null>(null);
  const passedDetailAbortRef = useRef<AbortController | null>(null);

  const loadPassedSearches = useCallback(async () => {
    setPassedLoading(true);
    setPassedError(null);
    passedAbortRef.current?.abort();
    const controller = new AbortController();
    passedAbortRef.current = controller;

    try {
      const res = await fetch('/api/shodan/searches?limit=30', {
        method: 'GET',
        cache: 'no-store',
        signal: controller.signal,
      });
      const json = (await res.json().catch(() => null)) as PassedShodanSearchListApiResponse | null;
      if (!res.ok || !json || json.ok !== true) {
        throw new Error(json && json.ok === false ? json.error.message : `Failed to load passed searches (${res.status}).`);
      }
      setPassedSearches(json.items);
    } catch (err) {
      if (controller.signal.aborted) return;
      setPassedSearches([]);
      setPassedError(err instanceof Error ? err.message : 'Failed to load passed searches.');
    } finally {
      if (!controller.signal.aborted) setPassedLoading(false);
    }
  }, []);

  const openPassedSearch = useCallback(async (id: string) => {
    setSelectedPassedId(id);
    setSelectedPassedSearch(null);
    setSelectedPassedError(null);
    setSelectedPassedLoading(true);

    passedDetailAbortRef.current?.abort();
    const controller = new AbortController();
    passedDetailAbortRef.current = controller;

    try {
      const res = await fetch(`/api/shodan/searches/${encodeURIComponent(id)}`, {
        method: 'GET',
        cache: 'no-store',
        signal: controller.signal,
      });
      const json = (await res.json().catch(() => null)) as PassedShodanSearchDetailApiResponse | null;
      if (!res.ok || !json || json.ok !== true) {
        throw new Error(json && json.ok === false ? json.error.message : `Failed to load details (${res.status}).`);
      }
      setSelectedPassedSearch(json.item);
    } catch (err) {
      if (controller.signal.aborted) return;
      setSelectedPassedError(err instanceof Error ? err.message : 'Failed to load passed search details.');
    } finally {
      if (!controller.signal.aborted) setSelectedPassedLoading(false);
    }
  }, []);

  const closePassedModal = useCallback(() => {
    setSelectedPassedId(null);
    setSelectedPassedSearch(null);
    setSelectedPassedError(null);
    setSelectedPassedLoading(false);
    passedDetailAbortRef.current?.abort();
  }, []);

  const loadHosts = useCallback(async () => {
    const q = request.q.trim();
    if (!q) {
      setItems([]);
      setMeta(null);
      setError('Query is required.');
      return;
    }

    setLoading(true);
    setError(null);
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const qs = new URLSearchParams();
    qs.set('q', q);
    qs.set('page', String(page));
    qs.set('pageSize', String(pageSize));
    if (request.facets.trim()) qs.set('facets', request.facets.trim());

    try {
      const res = await fetch(`/api/shodan/hosts?${qs.toString()}`, {
        method: 'GET',
        cache: 'no-store',
        signal: controller.signal,
      });
      const json = (await res.json().catch(() => null)) as ShodanSearchApiResponse | null;
      if (!res.ok || !json || json.ok !== true) {
        throw new Error(json && json.ok === false ? json.error.message : `Search failed (${res.status}).`);
      }

      setMeta(json.meta);
      setItems(json.items);
      setSelectedHost((prev) => (prev && json.items.some((item) => item.id === prev.id) ? prev : null));
    } catch (err) {
      if (controller.signal.aborted) return;
      setMeta(null);
      setItems([]);
      setSelectedHost(null);
      setError(err instanceof Error ? err.message : 'Search failed.');
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [page, pageSize, request]);

  useEffect(() => {
    void loadHosts();
  }, [loadHosts, refreshTick]);

  useEffect(() => {
    void loadPassedSearches();
  }, [loadPassedSearches, refreshTick]);

  useEffect(
    () => () => {
      abortRef.current?.abort();
      passedAbortRef.current?.abort();
      passedDetailAbortRef.current?.abort();
    },
    [],
  );

  const onSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const q = queryInput.trim();
      if (!q) {
        setError('Query is required.');
        return;
      }
      setPage(1);
      setRequest({ q, facets: facetsInput.trim() });
    },
    [facetsInput, queryInput],
  );

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)]">
      <form
        onSubmit={onSubmit}
        className="flex flex-col gap-2 border-b border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-3 py-2"
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h4 className="text-[11px] font-bold uppercase tracking-wider text-[color:var(--cs-fg)]">Shodan</h4>
            <Badge variant="outline" className="text-[10px]">
              Host Search
            </Badge>
          </div>
          <button
            type="button"
            onClick={() => setRefreshTick((n) => n + 1)}
            className="inline-flex h-7 items-center gap-1 rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 text-[11px] font-medium text-[color:var(--cs-fg)] hover:bg-[color:var(--cs-hover)]"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[220px] flex-1">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-[color:var(--cs-muted)]" />
            <input
              value={queryInput}
              onChange={(event) => setQueryInput(event.target.value)}
              placeholder="apache country:US"
              className="h-8 w-full rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] pl-8 pr-2 text-[12px] outline-none focus:border-[color:var(--cs-accent)]"
            />
          </div>

          <input
            value={facetsInput}
            onChange={(event) => setFacetsInput(event.target.value)}
            placeholder="country,org,port"
            className="h-8 w-44 rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 text-[12px] outline-none focus:border-[color:var(--cs-accent)]"
          />

          <select
            value={pageSize}
            onChange={(event) => setPageSize(Number(event.target.value))}
            className="h-8 rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 text-[12px] outline-none focus:border-[color:var(--cs-accent)]"
          >
            <option value={20}>20</option>
            <option value={50}>50</option>
            <option value={100}>100</option>
          </select>

          <button
            type="submit"
            className="inline-flex h-8 items-center gap-1 rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-accent-soft)] px-2 text-[11px] font-semibold text-[color:var(--cs-fg)] hover:bg-[color:var(--cs-hover)]"
          >
            <Search className="h-3.5 w-3.5" />
            Search
          </button>
        </div>

        <div className="flex items-center gap-2 text-[11px] text-[color:var(--cs-muted)]">
          <button
            type="button"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
            className="h-7 rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 text-[11px] text-[color:var(--cs-fg)] hover:bg-[color:var(--cs-hover)] disabled:opacity-50"
          >
            Prev
          </button>
          <span>Page {page}</span>
          <button
            type="button"
            onClick={() => setPage((p) => p + 1)}
            className="h-7 rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 text-[11px] text-[color:var(--cs-fg)] hover:bg-[color:var(--cs-hover)]"
          >
            Next
          </button>
          <span className="ml-auto">{meta?.total != null ? `${meta.total.toLocaleString()} matches` : 'Total unknown'}</span>
        </div>

        {error ? (
          <div className="rounded border border-rose-500/30 bg-rose-500/10 px-2 py-1 text-[11px] text-rose-200">{error}</div>
        ) : null}
      </form>

      <div className="max-h-[170px] overflow-auto border-b border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-3 py-2">
        <div className="mb-1 flex items-center gap-2 text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">
          Passed AI Searches
          <Badge variant="outline" className="text-[10px]">
            search_shodan_hosts
          </Badge>
          <span className="ml-auto text-[10px] font-medium normal-case text-[color:var(--cs-muted)]">
            {passedSearches.length} recorded
          </span>
        </div>

        {passedLoading ? (
          <div className="text-[11px] text-[color:var(--cs-muted)]">Loading passed searches...</div>
        ) : passedSearches.length === 0 ? (
          <div className="text-[11px] text-[color:var(--cs-muted)]">No successful Shodan AI tool searches recorded yet.</div>
        ) : (
          <div className="space-y-1">
            {passedSearches.slice(0, 10).map((search) => (
              <button
                key={search.id}
                type="button"
                onClick={() => void openPassedSearch(search.id)}
                className="flex w-full items-center gap-2 rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 py-1.5 text-left hover:bg-[color:var(--cs-hover)]"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[11px] font-semibold text-[color:var(--cs-fg)]">{search.query}</div>
                  <div className="truncate text-[10px] text-[color:var(--cs-muted)]">{search.summary}</div>
                </div>
                <div className="whitespace-nowrap text-[10px] text-[color:var(--cs-muted)]">
                  {search.total != null ? `${search.total.toLocaleString()} total` : `${search.count} shown`} · {fmtAgo(search.createdAt)}
                </div>
              </button>
            ))}
          </div>
        )}

        {passedError ? <div className="mt-1 text-[11px] text-rose-300">{passedError}</div> : null}
      </div>

      <div className="grid grid-cols-[1.5fr_1fr_1fr_88px] border-b border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-3 py-2 text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">
        <div>Host</div>
        <div>Service</div>
        <div>Location</div>
        <div className="text-right">Updated</div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {loading ? (
          <div className="p-6 text-[12px] text-[color:var(--cs-muted)]">Loading Shodan results...</div>
        ) : items.length === 0 ? (
          <div className="p-6 text-[12px] text-[color:var(--cs-muted)]">No Shodan hosts found for this query.</div>
        ) : (
          items.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setSelectedHost(item)}
              className="grid w-full grid-cols-[1.5fr_1fr_1fr_88px] items-center gap-2 border-b border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-3 py-2 text-left text-[12px] hover:bg-[color:var(--cs-hover)]"
            >
              <div className="min-w-0">
                <div className="truncate font-semibold text-[color:var(--cs-fg)]">{shodanHostEndpoint(item)}</div>
                <div className="truncate text-[10px] text-[color:var(--cs-muted)]">
                  {firstNonEmpty([item.product, item.organization, item.hostnames[0], item.domains[0]]) ?? 'Unknown'}
                </div>
              </div>
              <div className="truncate text-[11px] text-[color:var(--cs-fg)]">
                {firstNonEmpty([item.product, item.transport]) ?? '-'}
              </div>
              <div className="truncate text-[11px] text-[color:var(--cs-muted)]">
                {joinLocation([item.city, item.region, item.country])}
              </div>
              <div className="text-right text-[11px] text-[color:var(--cs-muted)]">{fmtAgo(item.timestamp)}</div>
            </button>
          ))
        )}
      </div>

      <Dialog open={selectedHost != null} onOpenChange={(open) => !open && setSelectedHost(null)}>
        <DialogContent className="max-h-[90vh] w-full max-w-5xl overflow-hidden p-0">
          {selectedHost ? (
            <>
              <DialogHeader className="border-b border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-5 py-4">
                <DialogTitle className="truncate text-[15px] font-semibold text-[color:var(--cs-fg)]">
                  {shodanHostEndpoint(selectedHost)}
                </DialogTitle>
                <DialogDescription className="mt-0.5 truncate text-[12px] text-[color:var(--cs-muted)]">
                  {joinLocation([selectedHost.city, selectedHost.region, selectedHost.country])}
                  {selectedHost.organization ? ` · ${selectedHost.organization}` : ''}
                </DialogDescription>
              </DialogHeader>

              <div className="max-h-[72vh] overflow-auto px-5 py-4">
                <div className="flex flex-wrap items-center gap-2">
                  {selectedHost.product ? <Badge variant="outline" className="text-[11px]">{selectedHost.product}</Badge> : null}
                  {selectedHost.version ? <Badge variant="outline" className="text-[11px]">{selectedHost.version}</Badge> : null}
                  {selectedHost.transport ? <Badge variant="outline" className="text-[11px]">{selectedHost.transport}</Badge> : null}
                  {selectedHost.os ? <Badge variant="outline" className="text-[11px]">{selectedHost.os}</Badge> : null}
                </div>

                <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  <ShodanDetailField label="IP" value={selectedHost.ip} />
                  <ShodanDetailField label="Port" value={selectedHost.port != null ? String(selectedHost.port) : '-'} />
                  <ShodanDetailField label="Hostnames" value={selectedHost.hostnames.length ? selectedHost.hostnames.join(', ') : null} />
                  <ShodanDetailField label="Domains" value={selectedHost.domains.length ? selectedHost.domains.join(', ') : null} />
                  <ShodanDetailField label="Organization" value={selectedHost.organization} />
                  <ShodanDetailField label="ISP" value={selectedHost.isp} />
                  <ShodanDetailField label="ASN" value={selectedHost.asn} />
                  <ShodanDetailField label="Location" value={joinLocation([selectedHost.city, selectedHost.region, selectedHost.country])} />
                  <ShodanDetailField label="Last Seen" value={selectedHost.timestamp} />
                </div>

                {(() => {
                  const vulns = parseVulnsFromRaw(selectedHost.raw);
                  const tags = parseTagsFromRaw(selectedHost.raw);
                  const ports = parsePortsFromRaw(selectedHost.raw, selectedHost.port);
                  const cpeList = parseCpeFromRaw(selectedHost.raw);
                  const hasExtras = vulns.length > 0 || tags.length > 0 || ports.length > 0 || cpeList.length > 0;
                  if (!hasExtras) return null;
                  return (
                    <div className="mt-4 space-y-4">
                      {ports.length > 0 ? (
                        <div className="rounded-lg border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] p-3">
                          <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-[color:var(--cs-muted)]">Open ports</div>
                          <div className="flex flex-wrap gap-1.5">
                            {ports.map((p) => (
                              <Badge key={p} variant="secondary" className="font-mono text-[11px]">
                                {p}
                              </Badge>
                            ))}
                          </div>
                        </div>
                      ) : null}
                      {vulns.length > 0 ? (
                        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
                          <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-amber-600 dark:text-amber-400">Vulnerabilities</div>
                          <div className="flex flex-wrap gap-1.5">
                            {vulns.map((v) => (
                              <Badge key={v} variant="outline" className="border-amber-500/50 bg-amber-500/20 font-mono text-[11px] text-amber-700 dark:text-amber-300">
                                {v}
                              </Badge>
                            ))}
                          </div>
                        </div>
                      ) : null}
                      {tags.length > 0 ? (
                        <div className="rounded-lg border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] p-3">
                          <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-[color:var(--cs-muted)]">Tags</div>
                          <div className="flex flex-wrap gap-1.5">
                            {tags.map((t) => (
                              <Badge key={t} variant="outline" className="text-[11px]">
                                {t}
                              </Badge>
                            ))}
                          </div>
                        </div>
                      ) : null}
                      {cpeList.length > 0 ? (
                        <div className="rounded-lg border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] p-3">
                          <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-[color:var(--cs-muted)]">CPE</div>
                          <div className="flex flex-wrap gap-1.5">
                            {cpeList.map((c) => (
                              <span key={c} className="rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-2 py-0.5 font-mono text-[10px] text-[color:var(--cs-fg)]">
                                {c}
                              </span>
                            ))}
                          </div>
                        </div>
                      ) : null}
                    </div>
                  );
                })()}

                {selectedHost.banner ? (
                  <div className="mt-4 overflow-hidden rounded-lg border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)]">
                    <div className="border-b border-[color:var(--cs-border)] px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-[color:var(--cs-muted)]">
                      Banner
                    </div>
                    <pre className="max-h-[200px] overflow-auto whitespace-pre-wrap p-3 text-[11px] leading-relaxed text-[color:var(--cs-fg)]">
                      {selectedHost.banner}
                    </pre>
                  </div>
                ) : null}

                <div className="mt-4 overflow-hidden rounded-lg border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)]">
                  <div className="border-b border-[color:var(--cs-border)] px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-[color:var(--cs-muted)]">
                    Raw record
                  </div>
                  <pre className="max-h-[280px] overflow-auto p-3 text-[11px] leading-relaxed text-[color:var(--cs-fg)]">
                    {toJson(selectedHost.raw)}
                  </pre>
                </div>
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={selectedPassedId != null} onOpenChange={(open) => !open && closePassedModal()}>
        <DialogContent className="max-h-[90vh] w-full max-w-4xl overflow-hidden p-0">
          <DialogHeader className="border-b border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-4 py-3">
            <DialogTitle className="truncate text-[14px] font-semibold text-[color:var(--cs-fg)]">Passed Shodan AI Search</DialogTitle>
            <DialogDescription className="truncate text-[12px] text-[color:var(--cs-muted)]">
              {selectedPassedSearch?.query ?? 'Loading details...'}
            </DialogDescription>
          </DialogHeader>

          <div className="max-h-[72vh] overflow-auto px-4 py-3">
            {selectedPassedLoading ? (
              <div className="text-[12px] text-[color:var(--cs-muted)]">Loading passed search details...</div>
            ) : selectedPassedError ? (
              <div className="rounded border border-rose-500/30 bg-rose-500/10 px-2 py-1 text-[11px] text-rose-200">{selectedPassedError}</div>
            ) : selectedPassedSearch ? (
              <>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge variant="outline">Recorded {fmtStamp(selectedPassedSearch.createdAt)}</Badge>
                  <Badge variant="outline">Page {selectedPassedSearch.page}</Badge>
                  <Badge variant="outline">Page Size {selectedPassedSearch.pageSize}</Badge>
                  <Badge variant="outline">
                    {selectedPassedSearch.total != null ? `${selectedPassedSearch.total.toLocaleString()} total` : `${selectedPassedSearch.count} shown`}
                  </Badge>
                  {selectedPassedSearch.minify ? <Badge variant="outline">Minified</Badge> : null}
                </div>

                <div className="mt-3 rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 py-1.5">
                  <div className="text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">Summary</div>
                  <div className="mt-0.5 text-[11px] text-[color:var(--cs-fg)]">{selectedPassedSearch.summary}</div>
                </div>

                <div className="mt-3 overflow-hidden rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)]">
                  <div className="border-b border-[color:var(--cs-border)] px-2 py-1.5 text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">
                    Result Preview ({selectedPassedSearch.items.length})
                  </div>
                  {selectedPassedSearch.items.length === 0 ? (
                    <div className="p-2 text-[11px] text-[color:var(--cs-muted)]">No result items stored.</div>
                  ) : (
                    <div className="max-h-[220px] overflow-auto">
                      {selectedPassedSearch.items.map((item, idx) => (
                        <div
                          key={`${selectedPassedSearch.id}_item_${idx}`}
                          className="grid grid-cols-[1.6fr_1fr] gap-2 border-b border-[color:var(--cs-border)] px-2 py-1.5 text-[11px]"
                        >
                          <div className="truncate text-[color:var(--cs-fg)]">{rawSearchEndpoint(item)}</div>
                          <div className="truncate text-[color:var(--cs-muted)]">{rawSearchService(item)}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  <div className="overflow-hidden rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)]">
                    <div className="border-b border-[color:var(--cs-border)] px-2 py-1.5 text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">
                      Tool Args
                    </div>
                    <pre className="max-h-[220px] overflow-auto p-2 text-[11px] leading-relaxed text-[color:var(--cs-fg)]">
                      {toJson(selectedPassedSearch.args)}
                    </pre>
                  </div>

                  <div className="overflow-hidden rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)]">
                    <div className="border-b border-[color:var(--cs-border)] px-2 py-1.5 text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">
                      Meta
                    </div>
                    <pre className="max-h-[220px] overflow-auto p-2 text-[11px] leading-relaxed text-[color:var(--cs-fg)]">
                      {toJson(selectedPassedSearch.meta)}
                    </pre>
                  </div>
                </div>
              </>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function ShodanDetailField(props: { label: string; value: string | null | undefined }) {
  const value = props.value && props.value.trim().length > 0 ? props.value : '-';
  return (
    <div className="rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 py-1.5">
      <div className="text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">{props.label}</div>
      <div className="mt-0.5 break-words text-[11px] text-[color:var(--cs-fg)]">{value}</div>
    </div>
  );
}
