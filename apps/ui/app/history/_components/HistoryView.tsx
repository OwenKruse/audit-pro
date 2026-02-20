'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { EyeOff, FileWarning, MessageCircle, Repeat } from 'lucide-react';
import { dispatchRunnerReference } from '@/lib/chat-references';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { HorizontalResizable } from '../../_components/HorizontalResizable';

type HttpMessageSummary = {
  id: string;
  parentId: string | null;
  createdAt: string;
  scheme: string;
  host: string;
  port: number;
  method: string;
  path: string;
  url: string;
  state: string;
  responseStatus: number | null;
  totalMs: number | null;
};

type ReplayDiff = {
  baselineId: string;
  variantId: string;
  status: { baseline: number | null; variant: number | null; changed: boolean };
  headers: { added: string[]; removed: string[]; changed: string[] };
  body: {
    changed: boolean;
    kind: string;
    jsonChanges: Array<{ path: string; before?: unknown; after?: unknown }>;
    truncated: boolean;
  };
};

type HttpMessageDetail = HttpMessageSummary & {
  request: {
    headers: Record<string, string[]>;
    cookies: Record<string, string>;
    query: Record<string, string[]>;
    bodyBase64: string | null;
    bodyText: string | null;
    bodyJson: unknown;
  };
  response: {
    headers: Record<string, string[]>;
    bodyBase64: string | null;
    bodyText: string | null;
    bodyJson: unknown;
  };
  timing: {
    dnsMs: number | null;
    connectMs: number | null;
    tlsMs: number | null;
    ttfbMs: number | null;
    totalMs: number | null;
  };
  error: string | null;
  replayDiff: ReplayDiff | null;
};

type WsFrame = {
  id: string;
  createdAt: string;
  direction: 'client_to_server' | 'server_to_client';
  opcode: number;
  payloadBase64: string;
  payloadText: string | null;
  payloadJson: unknown;
};

const PAGE_SIZE = 100;
const ROW_HEIGHT = 32;
const COMMON_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'];
const SEARCH_DEBOUNCE_MS = 250;
const LOAD_MORE_THRESHOLD = 5;
const LIVE_REFRESH_DEBOUNCE_MS = 250;
const LIVE_RECONNECT_DELAY_MS = 1500;
const defaultWsUrl = process.env.NEXT_PUBLIC_AGENT_WS_URL ?? 'ws://127.0.0.1:17400';

function eventsWsUrl(): string {
  return `${defaultWsUrl.replace(/\/$/, '')}/events`;
}

function isHttpMessageEvent(value: unknown): value is { type: 'http_message'; message: HttpMessageSummary } {
  if (!value || typeof value !== 'object') return false;
  const rec = value as { type?: unknown; message?: unknown };
  if (rec.type !== 'http_message' || !rec.message || typeof rec.message !== 'object') return false;
  const msg = rec.message as { id?: unknown; createdAt?: unknown };
  return typeof msg.id === 'string' && typeof msg.createdAt === 'string';
}

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const handle = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(handle);
  }, [value, delayMs]);
  return debounced;
}

function buildMessagesUrl(params: {
  limit: number;
  offset: number;
  search: string;
  source: string;
  method: string;
  scheme: string;
  status: string;
}): string {
  const qs = new URLSearchParams();
  qs.set('limit', String(params.limit));
  qs.set('offset', String(params.offset));
  const searchTrim = params.search.trim();
  if (searchTrim) qs.set('search', searchTrim);
  if (params.source !== 'all') qs.set('source', params.source);
  if (params.method !== 'all') qs.set('method', params.method);
  if (params.scheme !== 'all') qs.set('scheme', params.scheme);
  if (params.status !== 'all') qs.set('status', params.status);
  return `/api/messages?${qs.toString()}`;
}

export function HistoryView(props: { initialSelectedId?: string | null; initialSearch?: string | null }) {
  const [items, setItems] = useState<HttpMessageSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(props.initialSelectedId ?? null);
  const [search, setSearch] = useState(props.initialSearch ?? '');
  const debouncedSearch = useDebouncedValue(search, SEARCH_DEBOUNCE_MS);
  const [filterSource, setFilterSource] = useState<'all' | 'proxy' | 'repeater'>('all');
  const [filterMethod, setFilterMethod] = useState<string>('all');
  const [filterScheme, setFilterScheme] = useState<'all' | 'http' | 'https' | 'ws' | 'wss'>('all');
  const [filterStatus, setFilterStatus] = useState<'all' | '2xx' | '3xx' | '4xx' | '5xx' | 'error'>('all');

  const parentRef = useRef<HTMLDivElement>(null);
  const loadingMoreRef = useRef(false);
  const refreshInFlightRef = useRef(false);
  const itemsLengthRef = useRef(0);
  const fetchParamsRef = useRef<{
    limit: number;
    offset: number;
    search: string;
    source: string;
    method: string;
    scheme: string;
    status: string;
  }>({
    limit: PAGE_SIZE,
    offset: 0,
    search: '',
    source: 'all',
    method: 'all',
    scheme: 'all',
    status: 'all',
  });

  const fetchParams = useMemo(
    () => ({
      limit: PAGE_SIZE,
      offset: 0,
      search: debouncedSearch,
      source: filterSource,
      method: filterMethod,
      scheme: filterScheme,
      status: filterStatus,
    }),
    [debouncedSearch, filterSource, filterMethod, filterScheme, filterStatus],
  );

  const loadFirstPage = useCallback(async () => {
    setItems([]);
    setHasMore(true);
    setLoading(true);
    setSelectedId(null);
    try {
      const url = buildMessagesUrl({ ...fetchParams, offset: 0 });
      const res = await fetch(url, { cache: 'no-store' });
      const json = await res.json();
      if (json?.ok) {
        const list = json.items as HttpMessageSummary[];
        setItems(list);
        setHasMore(list.length === PAGE_SIZE);
      } else {
        setItems([]);
        setHasMore(false);
      }
    } catch {
      setItems([]);
      setHasMore(false);
    } finally {
      setLoading(false);
    }
  }, [fetchParams]);

  useEffect(() => {
    void loadFirstPage();
  }, [loadFirstPage]);

  useEffect(() => {
    fetchParamsRef.current = fetchParams;
  }, [fetchParams]);

  useEffect(() => {
    itemsLengthRef.current = items.length;
  }, [items.length]);

  const refreshLiveWindow = useCallback(async () => {
    if (loading || loadingMoreRef.current || refreshInFlightRef.current) return;
    refreshInFlightRef.current = true;
    try {
      const limit = Math.max(PAGE_SIZE, itemsLengthRef.current || PAGE_SIZE);
      const url = buildMessagesUrl({
        ...fetchParamsRef.current,
        limit,
        offset: 0,
      });
      const res = await fetch(url, { cache: 'no-store' });
      const json = await res.json();
      if (json?.ok) {
        const list = json.items as HttpMessageSummary[];
        setItems(list);
        setHasMore(list.length === limit);
        setSelectedId((prev) => {
          if (prev && list.some((item) => item.id === prev)) return prev;
          return list[0]?.id ?? null;
        });
      }
    } catch {
      // Ignore transient live refresh failures; normal navigation reloads recover state.
    } finally {
      refreshInFlightRef.current = false;
    }
  }, [loading]);

  useEffect(() => {
    let cancelled = false;
    let ws: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let refreshTimer: number | null = null;

    const clearTimers = () => {
      if (reconnectTimer != null) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (refreshTimer != null) {
        window.clearTimeout(refreshTimer);
        refreshTimer = null;
      }
    };

    const scheduleRefresh = () => {
      if (cancelled) return;
      if (refreshTimer != null) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        void refreshLiveWindow();
      }, LIVE_REFRESH_DEBOUNCE_MS);
    };

    const connect = () => {
      if (cancelled) return;
      ws = new WebSocket(eventsWsUrl());
      ws.addEventListener('open', () => {
        void refreshLiveWindow();
      });
      ws.addEventListener('message', (event) => {
        const raw = (event as MessageEvent).data;
        if (typeof raw !== 'string') return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          return;
        }
        if (!isHttpMessageEvent(parsed)) return;
        scheduleRefresh();
      });
      ws.addEventListener('error', () => {
        ws?.close();
      });
      ws.addEventListener('close', () => {
        if (cancelled) return;
        reconnectTimer = window.setTimeout(connect, LIVE_RECONNECT_DELAY_MS);
      });
    };

    connect();

    return () => {
      cancelled = true;
      clearTimers();
      ws?.close();
    };
  }, [refreshLiveWindow]);

  const loadMore = useCallback(async () => {
    if (loadingMoreRef.current || !hasMore) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const url = buildMessagesUrl({
        ...fetchParams,
        offset: items.length,
      });
      const res = await fetch(url, { cache: 'no-store' });
      const json = await res.json();
      if (json?.ok) {
        const list = json.items as HttpMessageSummary[];
        setItems((prev) => [...prev, ...list]);
        setHasMore(list.length === PAGE_SIZE);
      } else {
        setHasMore(false);
      }
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [fetchParams, items.length, hasMore]);

  useEffect(() => {
    if (props.initialSelectedId === undefined) return;
    setSelectedId(props.initialSelectedId ?? null);
  }, [props.initialSelectedId]);

  useEffect(() => {
    if (props.initialSearch === undefined) return;
    setSearch(props.initialSearch ?? '');
  }, [props.initialSearch]);

  useEffect(() => {
    if (loading) return;
    if (selectedId) return;
    if (items.length === 0) return;
    setSelectedId(items[0].id);
  }, [items, loading, selectedId]);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });

  const virtualItems = virtualizer.getVirtualItems();
  const lastVirtualIndex = virtualItems.length > 0 ? virtualItems[virtualItems.length - 1].index : -1;
  useEffect(() => {
    if (lastVirtualIndex < 0 || !hasMore || loadingMore) return;
    if (lastVirtualIndex >= items.length - LOAD_MORE_THRESHOLD) {
      void loadMore();
    }
  }, [lastVirtualIndex, items.length, hasMore, loadingMore, loadMore]);

  const methodsInData = useMemo(() => {
    const set = new Set<string>();
    for (const m of items) set.add(m.method);
    return [...COMMON_METHODS.filter((x) => set.has(x)), ...[...set].filter((x) => !COMMON_METHODS.includes(x)).sort()];
  }, [items]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-[color:var(--cs-panel)]">
      <div className="flex flex-wrap items-center gap-3 border-b border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-3 py-2">
        <div className="flex items-center gap-2">
          <label className="text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">Search</label>
          <input
            type="text"
            placeholder="Host or path..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-7 w-44 rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 text-[12px] outline-none focus:border-[color:var(--cs-accent)]"
          />
        </div>
        <div className="flex items-center gap-2">
          <label className="text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">Source</label>
          <select
            value={filterSource}
            onChange={(e) => setFilterSource(e.target.value as 'all' | 'proxy' | 'repeater')}
            className="h-7 rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 text-[12px] outline-none focus:border-[color:var(--cs-accent)]"
          >
            <option value="all">All</option>
            <option value="proxy">Proxy only</option>
            <option value="repeater">Repeater only</option>
          </select>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">Method</label>
          <select
            value={filterMethod}
            onChange={(e) => setFilterMethod(e.target.value)}
            className="h-7 min-w-[72px] rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 text-[12px] outline-none focus:border-[color:var(--cs-accent)]"
          >
            <option value="all">All</option>
            {methodsInData.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">Scheme</label>
          <select
            value={filterScheme}
            onChange={(e) => setFilterScheme(e.target.value as 'all' | 'http' | 'https' | 'ws' | 'wss')}
            className="h-7 rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 text-[12px] outline-none focus:border-[color:var(--cs-accent)]"
          >
            <option value="all">All</option>
            <option value="http">HTTP</option>
            <option value="https">HTTPS</option>
            <option value="ws">WS</option>
            <option value="wss">WSS</option>
          </select>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">Status</label>
          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value as 'all' | '2xx' | '3xx' | '4xx' | '5xx' | 'error')}
            className="h-7 rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 text-[12px] outline-none focus:border-[color:var(--cs-accent)]"
          >
            <option value="all">All</option>
            <option value="2xx">2xx</option>
            <option value="3xx">3xx</option>
            <option value="4xx">4xx</option>
            <option value="5xx">5xx</option>
            <option value="error">Error / No response</option>
          </select>
        </div>
        <div className="ml-auto text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">{items.length} Results</div>
      </div>

      <HorizontalResizable storageKey="history-inspector-width" defaultRatio={0.33}>
        <div className="flex min-h-0 flex-col overflow-hidden border-r border-[color:var(--cs-border)]">
          <div className="sticky top-0 z-10 grid grid-cols-[80px_60px_140px_1fr_60px_60px] border-b border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-1 py-1 text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">
            <div className="px-2">Time</div>
            <div className="px-2">Method</div>
            <div className="px-2">Host</div>
            <div className="px-2">Path</div>
            <div className="px-2 text-right">Status</div>
            <div className="px-2 text-right">MS</div>
          </div>
          <div ref={parentRef} className="flex-1 overflow-auto bg-[color:var(--cs-panel)]">
            <div style={{ height: `${virtualizer.getTotalSize()}px`, width: '100%', position: 'relative' }}>
              {virtualizer.getVirtualItems().map((v) => {
                const m = items[v.index];
                const isSelected = selectedId === m.id;
                return (
                  <div
                    key={m.id}
                    onClick={() => setSelectedId(m.id)}
                    className={[
                      'absolute left-0 top-0 grid w-full cursor-pointer grid-cols-[80px_60px_140px_1fr_60px_60px] items-center border-b border-[color:var(--cs-border)] font-mono text-[11px] transition-colors',
                      isSelected ? 'bg-[color:var(--cs-accent-soft)]' : 'hover:bg-[color:var(--cs-hover)]',
                    ].join(' ')}
                    style={{ height: `${v.size}px`, transform: `translateY(${v.start}px)` }}
                  >
                    <div className="px-2 text-[color:var(--cs-muted)]">
                      {new Date(m.createdAt).toLocaleTimeString([], { hour12: false })}
                    </div>
                    <div className="px-2 font-bold">{m.method}</div>
                    <div className="truncate px-2">{m.host}</div>
                    <div className="truncate px-2 text-[color:var(--cs-fg)]">{m.path}</div>
                    <div
                      className={[
                        'px-2 text-right font-bold',
                        m.responseStatus && m.responseStatus >= 400 ? 'text-rose-500' : 'text-emerald-500',
                      ].join(' ')}
                    >
                      {m.responseStatus || '-'}
                    </div>
                    <div className="px-2 text-right text-[color:var(--cs-muted)]">
                      {m.totalMs?.toFixed(0) || '-'}
                    </div>
                  </div>
                );
              })}
            </div>
            {items.length === 0 && !loading ? (
              <div className="p-8 text-center text-[13px] text-[color:var(--cs-muted)]">No matching messages.</div>
            ) : null}
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[color:var(--cs-panel-soft)]">
          {selectedId ? (
            <MessageInspector id={selectedId} />
          ) : (
            <div className="flex flex-1 items-center justify-center px-2 text-[12px] text-[color:var(--cs-muted)]">
              Select a message to inspect.
            </div>
          )}
        </div>
      </HorizontalResizable>
    </div>
  );
}

function AddToIgnoreListButton({ host }: { host: string }) {
  const [status, setStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');

  async function handleClick() {
    if (status === 'loading') return;
    setStatus('loading');
    try {
      const res = await fetch('/api/proxy/ignore-hosts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ addHost: host }),
      });
      const json = (await res.json()) as { ok?: boolean };
      setStatus(json.ok ? 'done' : 'error');
    } catch {
      setStatus('error');
    }
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-[color:var(--cs-muted)] hover:text-[color:var(--cs-fg)] disabled:opacity-50"
          onClick={handleClick}
          disabled={status === 'loading' || status === 'done'}
          aria-label="Add host to ignore list"
        >
          {status === 'loading' ? (
            <span className="h-4 w-4 animate-pulse rounded-full bg-[color:var(--cs-muted)]" />
          ) : (
            <EyeOff className="h-4 w-4" />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {status === 'done' ? 'Host added to ignore list' : status === 'error' ? 'Failed to add to ignore list' : 'Add to ignore list'}
      </TooltipContent>
    </Tooltip>
  );
}

function MessageInspector({ id }: { id: string }) {
  const [state, setState] = useState<{
    fetchedId: string | null;
    data: HttpMessageDetail | null;
    error: string | null;
    frames: WsFrame[];
    framesError: string | null;
  }>({ fetchedId: null, data: null, error: null, frames: [], framesError: null });

  const loading = state.fetchedId !== id;
  const data = loading ? null : state.data;
  const [activeTab, setActiveTab] = useState<'request' | 'response' | 'diff' | 'frames'>('request');

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch(`/api/messages/${encodeURIComponent(id)}`, { cache: 'no-store' });
        const json = await res.json();
        const item = (json?.item ?? null) as HttpMessageDetail | null;

        if (!item) {
          if (!cancelled) {
            setState({ fetchedId: id, data: null, error: 'Message not found.', frames: [], framesError: null });
          }
          return;
        }

        let frames: WsFrame[] = [];
        let framesError: string | null = null;
        if (item.scheme === 'ws' || item.scheme === 'wss') {
          const framesRes = await fetch(`/api/ws/${encodeURIComponent(item.id)}/frames?limit=500&offset=0`, {
            cache: 'no-store',
          });
          const framesJson = await framesRes.json();
          if (framesJson?.ok && Array.isArray(framesJson.items)) {
            frames = framesJson.items as WsFrame[];
          } else {
            framesError = 'Unable to load frames.';
          }
        }

        if (!cancelled) {
          setState({ fetchedId: id, data: item, error: null, frames, framesError });
        }
      } catch (err) {
        if (!cancelled) {
          setState({
            fetchedId: id,
            data: null,
            error: err instanceof Error ? err.message : 'Failed to load message.',
            frames: [],
            framesError: null,
          });
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (loading) {
    return <div className="p-4 text-[12px] text-[color:var(--cs-muted)]">Loading inspector...</div>;
  }

  if (state.error || !data) {
    return <div className="p-4 text-[12px] text-rose-500">{state.error ?? 'Error loading message.'}</div>;
  }

  const showFrames = data.scheme === 'ws' || data.scheme === 'wss';
  const showDiff = data.replayDiff != null;

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-[color:var(--cs-border)] px-3 py-2">
        <div>
          <h4 className="text-[11px] font-bold uppercase tracking-wider text-[color:var(--cs-fg)]">Message Inspector</h4>
          <div className="font-mono text-[10px] text-[color:var(--cs-muted)]">{data.id}</div>
        </div>
        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-[color:var(--cs-muted)] hover:text-[color:var(--cs-fg)]"
                onClick={() => dispatchRunnerReference(data.id)}
              >
                <MessageCircle className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Reference in Chat</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Link
                href={`/repeater?open=${encodeURIComponent(data.id)}`}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md text-[color:var(--cs-muted)] hover:bg-[color:var(--cs-panel)] hover:text-[color:var(--cs-fg)]"
              >
                <Repeat className="h-4 w-4" />
              </Link>
            </TooltipTrigger>
            <TooltipContent>Open in Repeater</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Link
                href={`/findings?messageId=${encodeURIComponent(data.id)}`}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md text-[color:var(--cs-muted)] hover:bg-[color:var(--cs-panel)] hover:text-[color:var(--cs-fg)]"
              >
                <FileWarning className="h-4 w-4" />
              </Link>
            </TooltipTrigger>
            <TooltipContent>Create Finding</TooltipContent>
          </Tooltip>
          <AddToIgnoreListButton host={data.host} />
        </div>
      </div>

      <div className="min-w-0 border-b border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-3 py-2 text-[11px] text-[color:var(--cs-muted)]">
        <div className="min-w-0 truncate font-mono text-[12px] text-[color:var(--cs-fg)]" title={data.url}>
          {data.method} {data.url}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <span>status: <span className="font-mono text-[color:var(--cs-fg)]">{data.responseStatus ?? '-'}</span></span>
          <span>state: <span className="font-mono text-[color:var(--cs-fg)]">{data.state}</span></span>
          <span>dns: <span className="font-mono text-[color:var(--cs-fg)]">{fmtMs(data.timing.dnsMs)}</span></span>
          <span>connect: <span className="font-mono text-[color:var(--cs-fg)]">{fmtMs(data.timing.connectMs)}</span></span>
          <span>tls: <span className="font-mono text-[color:var(--cs-fg)]">{fmtMs(data.timing.tlsMs)}</span></span>
          <span>ttfb: <span className="font-mono text-[color:var(--cs-fg)]">{fmtMs(data.timing.ttfbMs)}</span></span>
          <span>total: <span className="font-mono text-[color:var(--cs-fg)]">{fmtMs(data.timing.totalMs)}</span></span>
          <span>{new Date(data.createdAt).toLocaleString()}</span>
        </div>
      </div>

      <div className="flex border-b border-[color:var(--cs-border)] bg-[color:var(--cs-panel)]">
        <TabButton active={activeTab === 'request'} onClick={() => setActiveTab('request')}>Request</TabButton>
        <TabButton active={activeTab === 'response'} onClick={() => setActiveTab('response')}>Response</TabButton>
        {showDiff ? <TabButton active={activeTab === 'diff'} onClick={() => setActiveTab('diff')}>Replay Diff</TabButton> : null}
        {showFrames ? <TabButton active={activeTab === 'frames'} onClick={() => setActiveTab('frames')}>WS Frames</TabButton> : null}
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-3">
        {data.error ? (
          <div className="mb-3 border border-rose-300 bg-rose-50 px-3 py-2 font-mono text-[11px] text-rose-700">
            {data.error}
          </div>
        ) : null}

        {activeTab === 'request' ? (
          <div className="min-w-0 w-full space-y-3">
            <CompactBlock label="Headers" value={data.request.headers} />
            <CompactBlock label="Cookies" value={data.request.cookies} />
            <CompactBlock label="Query" value={data.request.query} />
            <CompactBody label="Body" text={data.request.bodyText} base64={data.request.bodyBase64} json={data.request.bodyJson} />
          </div>
        ) : null}

        {activeTab === 'response' ? (
          <div className="min-w-0 w-full space-y-3">
            <CompactBlock label="Headers" value={data.response.headers} />
            <CompactBody label="Body" text={data.response.bodyText} base64={data.response.bodyBase64} json={data.response.bodyJson} />
          </div>
        ) : null}

        {activeTab === 'diff' && data.replayDiff ? (
          <div className="space-y-3">
            <div className="border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] p-2 text-[11px] text-[color:var(--cs-muted)]">
              <div>Status: <span className="font-mono">{data.replayDiff.status.baseline ?? '-'}{' -> '}{data.replayDiff.status.variant ?? '-'}</span></div>
              <div>Headers: <span className="font-mono">+{data.replayDiff.headers.added.length} -{data.replayDiff.headers.removed.length} d{data.replayDiff.headers.changed.length}</span></div>
              <div>Body changed: <span className="font-mono">{data.replayDiff.body.changed ? 'yes' : 'no'} ({data.replayDiff.body.kind})</span></div>
            </div>
            {data.replayDiff.body.jsonChanges.length > 0 ? (
              <pre className="max-h-[320px] overflow-auto border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] p-2 font-mono text-[11px] leading-relaxed">
                {JSON.stringify(data.replayDiff.body.jsonChanges, null, 2)}
              </pre>
            ) : null}
          </div>
        ) : null}

        {activeTab === 'frames' && showFrames ? (
          state.framesError ? (
            <div className="text-[12px] text-[color:var(--cs-muted)]">{state.framesError}</div>
          ) : state.frames.length === 0 ? (
            <div className="text-[12px] text-[color:var(--cs-muted)]">No frames captured.</div>
          ) : (
            <div className="min-w-0 overflow-hidden border border-[color:var(--cs-border)]">
              <div className="grid min-w-0 grid-cols-[80px_56px_44px_minmax(0,1fr)] border-b border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-2 py-1 text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">
                <div>Time</div>
                <div>Dir</div>
                <div>Op</div>
                <div>Payload</div>
              </div>
              {state.frames.map((f) => (
                <div key={f.id} className="grid min-w-0 grid-cols-[80px_56px_44px_minmax(0,1fr)] gap-2 border-b border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] p-2 text-[11px] last:border-b-0">
                  <div className="font-mono text-[color:var(--cs-muted)]">{new Date(f.createdAt).toLocaleTimeString()}</div>
                  <div className="font-mono">{f.direction === 'client_to_server' ? 'c->s' : 's->c'}</div>
                  <div className="font-mono text-[color:var(--cs-muted)]">{f.opcode}</div>
                  <pre className="min-w-0 max-h-[110px] overflow-auto bg-black/5 p-2 font-mono text-[11px] leading-relaxed dark:bg-white/5">{f.payloadJson != null ? JSON.stringify(f.payloadJson, null, 2) : (f.payloadText ?? f.payloadBase64)}</pre>
                </div>
              ))}
            </div>
          )
        ) : null}
      </div>
    </div>
  );
}

function fmtMs(v: number | null) {
  if (v == null) return '-';
  return `${v.toFixed(1)}ms`;
}

function TabButton(props: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className={[
        'border-b-2 px-3 py-2 text-[11px] font-bold uppercase tracking-tight transition-colors',
        props.active
          ? 'border-[color:var(--cs-accent)] text-[color:var(--cs-accent)]'
          : 'border-transparent text-[color:var(--cs-muted)] hover:text-[color:var(--cs-fg)]',
      ].join(' ')}
    >
      {props.children}
    </button>
  );
}

function CompactBlock(props: { label: string; value: unknown }) {
  return (
    <div className="min-w-0 max-w-full overflow-hidden border border-[color:var(--cs-border)]">
      <div className="border-b border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-2 py-1 text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">
        {props.label}
      </div>
      <div className="max-h-[260px] overflow-auto bg-[color:var(--cs-panel)] p-2">
        <pre className="min-w-0 overflow-x-auto whitespace-pre font-mono text-[11px] leading-relaxed">
          {JSON.stringify(props.value, null, 2)}
        </pre>
      </div>
    </div>
  );
}

function CompactBody(props: { label: string; text: string | null; base64: string | null; json: unknown }) {
  const content =
    props.json != null ? JSON.stringify(props.json, null, 2)
    : props.text != null ? props.text
    : props.base64 != null ? props.base64
    : '(empty)';

  return (
    <div className="min-w-0 max-w-full overflow-hidden border border-[color:var(--cs-border)]">
      <div className="border-b border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-2 py-1 text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">
        {props.label}
      </div>
      <div className="max-h-[260px] overflow-auto bg-[color:var(--cs-panel)] p-2">
        <pre className="min-w-0 overflow-x-auto whitespace-pre font-mono text-[11px] leading-relaxed">
          {content}
        </pre>
      </div>
    </div>
  );
}
