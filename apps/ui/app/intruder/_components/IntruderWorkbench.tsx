'use client';

import type { HttpMessageDetail } from '@cipherscope/proto';
import { Copy, Play, RefreshCw, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

type PayloadFacetResponse =
  | {
      ok: true;
      total: number;
      categories: string[];
      sourceTypes: Array<'intruder' | 'markdown' | 'file'>;
      tags: string[];
      items: Array<{ id: string; value: string; sourcePath: string }>;
    }
  | {
      ok: false;
      error?: { message?: string };
    };

type IntruderPosition = {
  index: number;
  defaultValue: string;
};

type IntruderResultRow = {
  index: number;
  payloads: string[];
  url: string;
  status: number | null;
  durationMs: number | null;
  responseBytes: number;
  responseSnippet: string | null;
  error: string | null;
};

type IntruderAttackResponse =
  | {
      ok: true;
      attackType: 'sniper' | 'battering_ram' | 'pitchfork' | 'cluster_bomb';
      startedAt: string;
      finishedAt: string;
      durationMs: number;
      positions: IntruderPosition[];
      requestCount: number;
      capped: boolean;
      maxRequests: number;
      results: IntruderResultRow[];
    }
  | {
      ok: false;
      error?: { message?: string };
    };

type GetMessageResponse =
  | { ok: true; item: HttpMessageDetail }
  | { ok: false; error?: { message?: string } };

const PLACEHOLDER_REGEX = /§([^§]*)§/g;

function fmtMs(value: number | null): string {
  if (value == null) return '-';
  return `${value.toFixed(1)}ms`;
}

function sourceTypeLabel(value: 'intruder' | 'markdown' | 'file'): string {
  if (value === 'intruder') return 'Intruder';
  if (value === 'markdown') return 'Markdown';
  return 'File';
}

function statusClass(status: number | null): string {
  if (status == null) return 'text-[color:var(--cs-muted)]';
  if (status >= 200 && status < 300) return 'text-emerald-600 dark:text-emerald-400';
  if (status >= 300 && status < 400) return 'text-sky-600 dark:text-sky-400';
  if (status >= 400 && status < 500) return 'text-amber-600 dark:text-amber-400';
  return 'text-rose-600 dark:text-rose-400';
}

function parsePayloadLines(input: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of input.split(/\r?\n/g)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function formatHeaders(headers: Record<string, string[]>): string {
  const lines: string[] = [];
  const keys = Object.keys(headers).sort();
  for (const key of keys) {
    const values = headers[key] ?? [];
    for (const value of values) lines.push(`${key}: ${value}`);
  }
  return lines.join('\n');
}

function normalizeIntruderUrl(input: string): string {
  try {
    const parsed = new URL(input);
    if (parsed.protocol === 'ws:') parsed.protocol = 'http:';
    if (parsed.protocol === 'wss:') parsed.protocol = 'https:';
    return parsed.toString();
  } catch {
    return input;
  }
}

function extractPlaceholderDefaults(values: string[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    for (const match of value.matchAll(PLACEHOLDER_REGEX)) {
      out.push(match[1] ?? '');
    }
  }
  return out;
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

export function IntruderWorkbench() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const openParam = searchParams.get('open');

  const [method, setMethod] = useState('GET');
  const [urlTemplate, setUrlTemplate] = useState('https://example.com/?q=§test§');
  const [headersText, setHeadersText] = useState('');
  const [bodyTemplate, setBodyTemplate] = useState('');
  const [attackType, setAttackType] = useState<'sniper' | 'battering_ram' | 'pitchfork' | 'cluster_bomb'>('sniper');

  const [manualPayloads, setManualPayloads] = useState('');
  const [useCatalog, setUseCatalog] = useState(true);
  const [catalogQuery, setCatalogQuery] = useState('');
  const [catalogCategory, setCatalogCategory] = useState('');
  const [catalogSourceType, setCatalogSourceType] = useState('');
  const [catalogTag, setCatalogTag] = useState('');
  const [catalogLimit, setCatalogLimit] = useState(400);

  const [maxRequests, setMaxRequests] = useState(300);
  const [concurrency, setConcurrency] = useState(4);
  const [timeoutMs, setTimeoutMs] = useState(12000);
  const [delayMs, setDelayMs] = useState(0);

  const [catalogPreview, setCatalogPreview] = useState<PayloadFacetResponse | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<IntruderAttackResponse | null>(null);
  const [selectedRow, setSelectedRow] = useState<number | null>(null);
  const [copiedRow, setCopiedRow] = useState<number | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  const placeholderDefaults = useMemo(
    () => extractPlaceholderDefaults([urlTemplate, headersText, bodyTemplate]),
    [urlTemplate, headersText, bodyTemplate],
  );

  const manualPayloadSet = useMemo(() => parsePayloadLines(manualPayloads), [manualPayloads]);

  useEffect(() => {
    if (!openParam) return;
    const messageId = openParam.trim();
    if (!messageId) return;

    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`/api/messages/${encodeURIComponent(messageId)}`, { cache: 'no-store' });
        const json = (await res.json().catch(() => null)) as GetMessageResponse | null;
        if (!res.ok || !json || json.ok !== true || cancelled) return;

        const item = json.item;
        setMethod(item.method);
        setUrlTemplate(normalizeIntruderUrl(item.url));
        setHeadersText(formatHeaders(item.request.headers));
        setBodyTemplate(item.request.bodyText ?? item.request.bodyBase64 ?? '');
      } catch {
        // ignore prefill failures
      } finally {
        if (!cancelled) {
          router.replace('/intruder', { scroll: false });
        }
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [openParam, router]);

  useEffect(() => {
    if (!useCatalog) return;
    const timer = window.setTimeout(async () => {
      try {
        const params = new URLSearchParams();
        if (catalogQuery.trim()) params.set('q', catalogQuery.trim());
        if (catalogCategory) params.set('category', catalogCategory);
        if (catalogSourceType) params.set('sourceType', catalogSourceType);
        if (catalogTag.trim()) params.set('tag', catalogTag.trim());
        params.set('limit', String(Math.min(1000, Math.max(1, catalogLimit))));
        params.set('offset', '0');

        const res = await fetch(`/api/payloads?${params.toString()}`, { cache: 'no-store' });
        const json = (await res.json().catch(() => null)) as PayloadFacetResponse | null;
        if (!res.ok || !json || json.ok !== true) throw new Error();
        setCatalogPreview(json);
      } catch {
        setCatalogPreview(null);
      }
    }, 180);

    return () => window.clearTimeout(timer);
  }, [useCatalog, catalogQuery, catalogCategory, catalogSourceType, catalogTag, catalogLimit, refreshTick]);

  async function runAttack() {
    setRunning(true);
    setError(null);
    setResult(null);
    setSelectedRow(null);

    try {
      const payloadSets = manualPayloadSet.length > 0 ? [manualPayloadSet] : [];
      const payloadSetQueries =
        useCatalog
          ? [
              {
                q: catalogQuery.trim() || undefined,
                category: catalogCategory || undefined,
                sourceType:
                  catalogSourceType === 'intruder' ||
                  catalogSourceType === 'markdown' ||
                  catalogSourceType === 'file'
                    ? catalogSourceType
                    : undefined,
                tag: catalogTag.trim() || undefined,
                limit: Math.min(3000, Math.max(1, catalogLimit)),
              },
            ]
          : [];

      if (payloadSets.length === 0 && payloadSetQueries.length === 0) {
        throw new Error('Provide at least one payload source (manual list or catalog filter).');
      }
      if (placeholderDefaults.length === 0) {
        throw new Error('Add payload markers with §...§ in URL, headers, or body first.');
      }

      const res = await fetch('/api/intruder/attack', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          method,
          url: urlTemplate,
          headers: headersText || undefined,
          body: bodyTemplate || undefined,
          attackType,
          payloadSets: payloadSets.length > 0 ? payloadSets : undefined,
          payloadSetQueries,
          maxRequests,
          concurrency,
          timeoutMs,
          delayMs,
        }),
      });

      const json = (await res.json().catch(() => null)) as IntruderAttackResponse | null;
      if (!res.ok || !json || json.ok !== true) {
        throw new Error(json?.ok === false ? (json.error?.message ?? 'Intruder attack failed.') : `Intruder attack failed (${res.status}).`);
      }
      setResult(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Intruder attack failed.');
    } finally {
      setRunning(false);
    }
  }

  async function copyPayloadRow(index: number, payloads: string[]) {
    try {
      await navigator.clipboard.writeText(payloads.join('\n'));
      setCopiedRow(index);
      window.setTimeout(() => setCopiedRow((value) => (value === index ? null : value)), 1200);
    } catch {
      // ignore clipboard failures
    }
  }

  const resultRows = result && result.ok ? result.results : [];
  const selectedResult = selectedRow != null ? resultRows.find((row) => row.index === selectedRow) ?? null : null;

  return (
    <div className="flex h-full min-h-0 flex-col bg-[color:var(--cs-panel)]">
      <div className="flex items-center gap-2 border-b border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-3 py-2">
        <h3 className="text-[11px] font-bold uppercase tracking-wider text-[color:var(--cs-fg)]">Intruder</h3>
        <span className="rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 py-1 text-[10px] text-[color:var(--cs-muted)]">
          Positions: {placeholderDefaults.length}
        </span>
        <span className="rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 py-1 text-[10px] text-[color:var(--cs-muted)]">
          Manual payloads: {manualPayloadSet.length}
        </span>
        {catalogPreview && catalogPreview.ok ? (
          <span className="rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 py-1 text-[10px] text-[color:var(--cs-muted)]">
            Catalog matches: {catalogPreview.total.toLocaleString()}
          </span>
        ) : null}
        <button
          type="button"
          onClick={() => setRefreshTick((n) => n + 1)}
          className="ml-auto inline-flex h-7 items-center gap-1 rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 text-[11px] text-[color:var(--cs-muted)] hover:text-[color:var(--cs-fg)]"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Refresh Catalog
        </button>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[420px_minmax(0,1fr)]">
        <div className="min-h-0 overflow-auto border-r border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] p-3">
          <div className="mb-3 text-[11px] font-bold uppercase tracking-wide text-[color:var(--cs-fg)]">Attack Setup</div>

          <div className="mb-3 grid grid-cols-[88px_1fr_130px] gap-2">
            <select
              value={method}
              onChange={(event) => setMethod(event.target.value)}
              className="h-8 rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 text-[12px] font-mono outline-none"
            >
              {['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
            <input
              value={urlTemplate}
              onChange={(event) => setUrlTemplate(event.target.value)}
              className="h-8 rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 text-[12px] font-mono outline-none"
              placeholder="https://target/path?q=§value§"
            />
            <select
              value={attackType}
              onChange={(event) => setAttackType(event.target.value as typeof attackType)}
              className="h-8 rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 text-[12px] outline-none"
            >
              <option value="sniper">Sniper</option>
              <option value="battering_ram">Battering Ram</option>
              <option value="pitchfork">Pitchfork</option>
              <option value="cluster_bomb">Cluster Bomb</option>
            </select>
          </div>

          <label className="mb-1 block text-[10px] font-bold uppercase tracking-wide text-[color:var(--cs-muted)]">Headers</label>
          <textarea
            value={headersText}
            onChange={(event) => setHeadersText(event.target.value)}
            className="mb-3 h-28 w-full resize-y rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] p-2 font-mono text-[11px] outline-none"
            placeholder={'Cookie: session=§token§\nX-Trace: intruder'}
          />

          <label className="mb-1 block text-[10px] font-bold uppercase tracking-wide text-[color:var(--cs-muted)]">Body Template</label>
          <textarea
            value={bodyTemplate}
            onChange={(event) => setBodyTemplate(event.target.value)}
            className="mb-3 h-24 w-full resize-y rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] p-2 font-mono text-[11px] outline-none"
            placeholder={'{"username":"§admin§","password":"§pass§"}'}
          />

          <div className="mb-1 flex items-center gap-2">
            <label className="text-[10px] font-bold uppercase tracking-wide text-[color:var(--cs-muted)]">Manual Payload Set</label>
            <span className="text-[10px] text-[color:var(--cs-muted)]">{manualPayloadSet.length} values</span>
          </div>
          <textarea
            value={manualPayloads}
            onChange={(event) => setManualPayloads(event.target.value)}
            className="mb-3 h-28 w-full resize-y rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] p-2 font-mono text-[11px] outline-none"
            placeholder={'admin\nadministrator\n../../../../etc/passwd\n\' OR 1=1 --'}
          />

          <label className="mb-2 flex items-center gap-2 text-[11px] text-[color:var(--cs-fg)]">
            <input
              type="checkbox"
              checked={useCatalog}
              onChange={(event) => setUseCatalog(event.target.checked)}
              className="h-4 w-4 rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)]"
            />
            Add payloads from PayloadsAllTheThings filters
          </label>

          <div className={['space-y-2', useCatalog ? '' : 'opacity-50'].join(' ')}>
            <input
              value={catalogQuery}
              onChange={(event) => setCatalogQuery(event.target.value)}
              disabled={!useCatalog}
              className="h-8 w-full rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 text-[12px] outline-none"
              placeholder="Catalog query (xss, sqli, traversal...)"
            />
            <div className="grid grid-cols-2 gap-2">
              <select
                value={catalogCategory}
                onChange={(event) => setCatalogCategory(event.target.value)}
                disabled={!useCatalog}
                className="h-8 rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 text-[12px] outline-none"
              >
                <option value="">All categories</option>
                {catalogPreview && catalogPreview.ok
                  ? catalogPreview.categories.map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))
                  : null}
              </select>
              <select
                value={catalogSourceType}
                onChange={(event) => setCatalogSourceType(event.target.value)}
                disabled={!useCatalog}
                className="h-8 rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 text-[12px] outline-none"
              >
                <option value="">All source types</option>
                {catalogPreview && catalogPreview.ok
                  ? catalogPreview.sourceTypes.map((value) => (
                      <option key={value} value={value}>
                        {sourceTypeLabel(value)}
                      </option>
                    ))
                  : null}
              </select>
            </div>
            <div className="grid grid-cols-[1fr_120px] gap-2">
              <input
                value={catalogTag}
                onChange={(event) => setCatalogTag(event.target.value)}
                disabled={!useCatalog}
                className="h-8 rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 text-[12px] outline-none"
                placeholder="Tag filter"
              />
              <input
                type="number"
                min={1}
                max={3000}
                value={catalogLimit}
                onChange={(event) => setCatalogLimit(Number(event.target.value))}
                disabled={!useCatalog}
                className="h-8 rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 text-[12px] outline-none"
                placeholder="Limit"
              />
            </div>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-2">
            <label className="text-[10px] text-[color:var(--cs-muted)]">
              Max Requests
              <input
                type="number"
                min={1}
                max={10000}
                value={maxRequests}
                onChange={(event) => setMaxRequests(Number(event.target.value))}
                className="mt-1 h-8 w-full rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 text-[12px] outline-none"
              />
            </label>
            <label className="text-[10px] text-[color:var(--cs-muted)]">
              Concurrency
              <input
                type="number"
                min={1}
                max={20}
                value={concurrency}
                onChange={(event) => setConcurrency(Number(event.target.value))}
                className="mt-1 h-8 w-full rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 text-[12px] outline-none"
              />
            </label>
            <label className="text-[10px] text-[color:var(--cs-muted)]">
              Timeout (ms)
              <input
                type="number"
                min={100}
                max={60000}
                value={timeoutMs}
                onChange={(event) => setTimeoutMs(Number(event.target.value))}
                className="mt-1 h-8 w-full rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 text-[12px] outline-none"
              />
            </label>
            <label className="text-[10px] text-[color:var(--cs-muted)]">
              Delay (ms)
              <input
                type="number"
                min={0}
                max={5000}
                value={delayMs}
                onChange={(event) => setDelayMs(Number(event.target.value))}
                className="mt-1 h-8 w-full rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 text-[12px] outline-none"
              />
            </label>
          </div>

          <button
            type="button"
            disabled={running}
            onClick={() => void runAttack()}
            className="mt-4 inline-flex h-9 w-full items-center justify-center gap-2 rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-3 text-[12px] font-semibold text-[color:var(--cs-fg)] hover:bg-[color:var(--cs-hover)] disabled:opacity-50"
          >
            <Play className="h-4 w-4" />
            {running ? 'Running Attack...' : 'Start Attack'}
          </button>
        </div>

        <div className="min-h-0 overflow-hidden">
          <div className="grid h-full min-h-0 grid-rows-[auto_auto_minmax(0,1fr)_220px]">
            <div className="border-b border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-3 py-2 text-[11px] font-bold uppercase tracking-wide text-[color:var(--cs-fg)]">
              Positions
            </div>
            <div className="max-h-[120px] overflow-auto border-b border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-3 py-2">
              {placeholderDefaults.length === 0 ? (
                <div className="flex items-center gap-2 text-[11px] text-amber-700 dark:text-amber-300">
                  <TriangleAlert className="h-4 w-4" />
                  No markers found. Wrap mutable values with §...§.
                </div>
              ) : (
                <div className="grid grid-cols-[64px_minmax(0,1fr)] gap-2 text-[11px]">
                  {placeholderDefaults.map((value, index) => (
                    <div key={`${index}-${value}`} className="contents">
                      <div className="text-[color:var(--cs-muted)]">#{index + 1}</div>
                      <code className="truncate font-mono">{value || '(empty)'}</code>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {error ? (
              <div className="border-b border-[color:var(--cs-border)] bg-rose-500/10 px-3 py-2 text-[12px] text-rose-700 dark:text-rose-300">
                {error}
              </div>
            ) : null}

            <div className="min-h-0 overflow-auto">
              <div className="sticky top-0 z-10 grid grid-cols-[52px_74px_72px_72px_220px_minmax(0,1fr)_86px] border-b border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-2 py-1 text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">
                <div>#</div>
                <div>Status</div>
                <div>Time</div>
                <div>Bytes</div>
                <div>Payloads</div>
                <div>URL</div>
                <div>Copy</div>
              </div>
              {running && resultRows.length === 0 ? (
                <div className="flex h-full items-center justify-center text-[12px] text-[color:var(--cs-muted)]">Executing attack…</div>
              ) : resultRows.length === 0 ? (
                <div className="flex h-full items-center justify-center text-[12px] text-[color:var(--cs-muted)]">No attack results yet.</div>
              ) : (
                resultRows.map((row) => (
                  <button
                    key={row.index}
                    type="button"
                    onClick={() => setSelectedRow(row.index)}
                    className={[
                      'grid w-full grid-cols-[52px_74px_72px_72px_220px_minmax(0,1fr)_86px] items-start gap-2 border-b border-[color:var(--cs-border)] px-2 py-2 text-left text-[11px] hover:bg-[color:var(--cs-hover)]',
                      selectedRow === row.index ? 'bg-[color:var(--cs-accent-soft)]' : '',
                    ].join(' ')}
                  >
                    <div className="font-mono text-[color:var(--cs-muted)]">{row.index}</div>
                    <div className={statusClass(row.status)}>{row.status ?? '-'}</div>
                    <div className="text-[color:var(--cs-muted)]">{fmtMs(row.durationMs)}</div>
                    <div className="text-[color:var(--cs-muted)]">{row.responseBytes.toLocaleString()}</div>
                    <div className="truncate font-mono text-[10px]" title={row.payloads.join(' | ')}>
                      {row.payloads.join(' | ')}
                    </div>
                    <div className="truncate font-mono text-[10px]" title={row.url}>
                      {row.url}
                    </div>
                    <div>
                      <span
                        role="button"
                        tabIndex={0}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          void copyPayloadRow(row.index, row.payloads);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            event.stopPropagation();
                            void copyPayloadRow(row.index, row.payloads);
                          }
                        }}
                        className="inline-flex h-7 w-full items-center justify-center gap-1 rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 text-[10px]"
                      >
                        <Copy className="h-3 w-3" />
                        {copiedRow === row.index ? 'Copied' : 'Copy'}
                      </span>
                    </div>
                  </button>
                ))
              )}
            </div>

            <div className="min-h-0 overflow-auto border-t border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] p-3 text-[11px]">
              <div className="mb-2 flex items-center justify-between">
                <div className="text-[11px] font-bold uppercase tracking-wide text-[color:var(--cs-fg)]">Response Detail</div>
                {result && result.ok ? (
                  <div className="text-[10px] text-[color:var(--cs-muted)]">
                    {result.requestCount.toLocaleString()} requests · {result.durationMs}ms total
                    {result.capped ? ' · capped' : ''}
                  </div>
                ) : null}
              </div>
              {selectedResult ? (
                <div className="space-y-2">
                  <div className="rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] p-2">
                    <div className="mb-1 text-[10px] uppercase text-[color:var(--cs-muted)]">Row</div>
                    <pre className="max-h-[120px] overflow-auto font-mono text-[11px]">{toJson(selectedResult)}</pre>
                  </div>
                  {selectedResult.responseSnippet ? (
                    <div className="rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] p-2">
                      <div className="mb-1 text-[10px] uppercase text-[color:var(--cs-muted)]">Response Snippet</div>
                      <pre className="max-h-[120px] overflow-auto font-mono text-[11px]">{selectedResult.responseSnippet}</pre>
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="text-[color:var(--cs-muted)]">Select a result row to inspect request/response detail.</div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
