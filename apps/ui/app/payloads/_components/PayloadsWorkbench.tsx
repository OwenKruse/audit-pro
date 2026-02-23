'use client';

import { Copy, RefreshCw, Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

type PayloadItem = {
  id: string;
  value: string;
  category: string;
  subcategory: string | null;
  sourcePath: string;
  sourceType: 'intruder' | 'markdown' | 'file';
  tags: string[];
};

type PayloadCatalogMeta = {
  repo: string;
  url: string;
  commit: string;
  generatedAt: string;
  fileCount: number;
  payloadCount: number;
};

type PayloadSearchResponse =
  | {
      ok: true;
      source: PayloadCatalogMeta;
      total: number;
      count: number;
      limit: number;
      offset: number;
      categories: string[];
      subcategories: string[];
      sourceTypes: Array<'intruder' | 'markdown' | 'file'>;
      tags: string[];
      items: PayloadItem[];
    }
  | {
      ok: false;
      error?: { code?: string; message?: string };
    };

const DEFAULT_PAGE_SIZE = 200;

function sourceTypeLabel(value: PayloadItem['sourceType']): string {
  if (value === 'intruder') return 'Intruder';
  if (value === 'markdown') return 'Markdown';
  return 'File';
}

function fmtStamp(iso: string | null | undefined): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

export function PayloadsWorkbench() {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [subcategory, setSubcategory] = useState('');
  const [sourceType, setSourceType] = useState('');
  const [tag, setTag] = useState('');
  const [sourcePath, setSourcePath] = useState('');
  const [offset, setOffset] = useState(0);
  const [limit, setLimit] = useState(DEFAULT_PAGE_SIZE);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<PayloadSearchResponse | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  const canPageBack = offset > 0;
  const canPageForward = useMemo(() => {
    if (!data || !data.ok) return false;
    return offset + limit < data.total;
  }, [data, limit, offset]);

  useEffect(() => {
    const timer = window.setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        if (query.trim()) params.set('q', query.trim());
        if (category) params.set('category', category);
        if (subcategory) params.set('subcategory', subcategory);
        if (sourceType) params.set('sourceType', sourceType);
        if (tag.trim()) params.set('tag', tag.trim());
        if (sourcePath.trim()) params.set('sourcePath', sourcePath.trim());
        params.set('limit', String(limit));
        params.set('offset', String(offset));

        const res = await fetch(`/api/payloads?${params.toString()}`, { cache: 'no-store' });
        const json = (await res.json().catch(() => null)) as PayloadSearchResponse | null;
        if (!res.ok || !json || json.ok !== true) {
          throw new Error(json?.ok === false ? (json.error?.message ?? 'Failed to load payload catalog.') : `Failed to load payload catalog (${res.status}).`);
        }
        setData(json);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load payload catalog.');
      } finally {
        setLoading(false);
      }
    }, 220);

    return () => window.clearTimeout(timer);
  }, [query, category, subcategory, sourceType, tag, sourcePath, limit, offset, refreshTick]);

  useEffect(() => {
    setOffset(0);
  }, [query, category, subcategory, sourceType, tag, sourcePath]);

  const categoryOptions = data && data.ok ? data.categories : [];
  const subcategoryOptions = data && data.ok ? data.subcategories : [];
  const sourceTypeOptions = data && data.ok ? data.sourceTypes : [];
  const tagOptions = data && data.ok ? data.tags.slice(0, 300) : [];
  const rows = data && data.ok ? data.items : [];

  async function copyPayload(id: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedId(id);
      window.setTimeout(() => {
        setCopiedId((current) => (current === id ? null : current));
      }, 1200);
    } catch {
      // Clipboard failures are non-fatal.
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-[color:var(--cs-panel)]">
      <div className="flex items-center gap-2 border-b border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-3 py-2">
        <h3 className="text-[11px] font-bold uppercase tracking-wider text-[color:var(--cs-fg)]">Payload Library</h3>
        {data && data.ok ? (
          <span className="rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 py-1 text-[10px] font-mono text-[color:var(--cs-muted)]">
            {data.total.toLocaleString()} entries
          </span>
        ) : null}
        <button
          type="button"
          onClick={() => setRefreshTick((n) => n + 1)}
          className="ml-auto inline-flex h-7 items-center gap-1 rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 text-[11px] text-[color:var(--cs-muted)] hover:text-[color:var(--cs-fg)]"
        >
          <RefreshCw className={['h-3.5 w-3.5', loading ? 'animate-spin' : ''].join(' ')} />
          Refresh
        </button>
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)_160px_160px_130px_150px_220px] gap-2 border-b border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-3 py-2">
        <label className="flex min-w-0 items-center gap-2 rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-2">
          <Search className="h-3.5 w-3.5 text-[color:var(--cs-muted)]" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search payloads, category, source path..."
            className="h-8 w-full bg-transparent text-[12px] outline-none"
          />
        </label>

        <select
          value={category}
          onChange={(event) => setCategory(event.target.value)}
          className="h-8 rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-2 text-[12px] outline-none"
        >
          <option value="">All categories</option>
          {categoryOptions.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>

        <select
          value={subcategory}
          onChange={(event) => setSubcategory(event.target.value)}
          className="h-8 rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-2 text-[12px] outline-none"
        >
          <option value="">All subcategories</option>
          {subcategoryOptions.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>

        <select
          value={sourceType}
          onChange={(event) => setSourceType(event.target.value)}
          className="h-8 rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-2 text-[12px] outline-none"
        >
          <option value="">All sources</option>
          {sourceTypeOptions.map((value) => (
            <option key={value} value={value}>
              {sourceTypeLabel(value)}
            </option>
          ))}
        </select>

        <input
          value={tag}
          onChange={(event) => setTag(event.target.value)}
          list="payload-tag-options"
          placeholder="Tag filter"
          className="h-8 rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-2 text-[12px] outline-none"
        />
        <datalist id="payload-tag-options">
          {tagOptions.map((value) => (
            <option key={value} value={value} />
          ))}
        </datalist>

        <input
          value={sourcePath}
          onChange={(event) => setSourcePath(event.target.value)}
          placeholder="Source path contains..."
          className="h-8 rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-2 text-[12px] font-mono outline-none"
        />
      </div>

      {data && data.ok ? (
        <div className="border-b border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-3 py-1 text-[10px] text-[color:var(--cs-muted)]">
          Source: {data.source.repo} @ {data.source.commit.slice(0, 12)} · Generated {fmtStamp(data.source.generatedAt)}
        </div>
      ) : null}

      {error ? (
        <div className="border-b border-[color:var(--cs-border)] bg-rose-500/10 px-3 py-2 text-[12px] text-rose-700 dark:text-rose-300">
          {error}
        </div>
      ) : null}

      <div className="grid grid-cols-[minmax(0,1fr)_150px_200px_110px_84px] border-b border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-3 py-1 text-[10px] font-bold uppercase tracking-wide text-[color:var(--cs-muted)]">
        <div>Payload</div>
        <div>Category</div>
        <div>Source</div>
        <div>Type</div>
        <div>Copy</div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {loading && rows.length === 0 ? (
          <div className="flex h-full items-center justify-center text-[12px] text-[color:var(--cs-muted)]">Loading payloads…</div>
        ) : rows.length === 0 ? (
          <div className="flex h-full items-center justify-center text-[12px] text-[color:var(--cs-muted)]">No payloads match current filters.</div>
        ) : (
          rows.map((row) => (
            <div
              key={row.id}
              className="grid grid-cols-[minmax(0,1fr)_150px_200px_110px_84px] gap-2 border-b border-[color:var(--cs-border)] px-3 py-2 text-[11px] last:border-b-0"
            >
              <pre className="max-h-[120px] overflow-auto rounded bg-black/5 p-2 font-mono leading-relaxed dark:bg-white/5">
                {row.value}
              </pre>
              <div className="truncate text-[color:var(--cs-fg)]">{row.category}</div>
              <div className="truncate font-mono text-[10px] text-[color:var(--cs-muted)]" title={row.sourcePath}>
                {row.sourcePath}
              </div>
              <div>
                <span className="rounded border border-[color:var(--cs-border)] px-2 py-0.5 text-[10px] text-[color:var(--cs-muted)]">
                  {sourceTypeLabel(row.sourceType)}
                </span>
              </div>
              <div>
                <button
                  type="button"
                  onClick={() => void copyPayload(row.id, row.value)}
                  className="inline-flex h-7 w-full items-center justify-center gap-1 rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-2 text-[11px] text-[color:var(--cs-fg)] hover:bg-[color:var(--cs-hover)]"
                >
                  <Copy className="h-3.5 w-3.5" />
                  {copiedId === row.id ? 'Copied' : 'Copy'}
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      <div className="flex items-center gap-2 border-t border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-3 py-2 text-[11px] text-[color:var(--cs-muted)]">
        <button
          type="button"
          disabled={!canPageBack}
          onClick={() => setOffset((v) => Math.max(0, v - limit))}
          className="rounded-md border border-[color:var(--cs-border)] px-2 py-1 disabled:opacity-40"
        >
          Previous
        </button>
        <button
          type="button"
          disabled={!canPageForward}
          onClick={() => setOffset((v) => v + limit)}
          className="rounded-md border border-[color:var(--cs-border)] px-2 py-1 disabled:opacity-40"
        >
          Next
        </button>
        <span className="ml-2">
          Offset {offset.toLocaleString()} · Page size
        </span>
        <select
          value={String(limit)}
          onChange={(event) => {
            const next = Number(event.target.value);
            setLimit(Number.isFinite(next) ? next : DEFAULT_PAGE_SIZE);
            setOffset(0);
          }}
          className="h-7 rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 text-[11px] outline-none"
        >
          <option value="100">100</option>
          <option value="200">200</option>
          <option value="500">500</option>
          <option value="1000">1000</option>
        </select>
      </div>
    </div>
  );
}
