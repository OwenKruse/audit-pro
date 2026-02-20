'use client';

import type { ContractSummary, HttpMessageSummary, SitemapHost, SitemapPathNode } from '@cipherscope/proto';
import { Activity, Database, Globe, Network, Search as SearchIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRpcInteractions, type RpcInteraction } from '@/lib/foundry-store';

type LoadState = 'idle' | 'loading' | 'loaded' | 'error';

type SitemapEntry = {
  key: string;
  host: string;
  port: number;
  displayHost: string;
  path: string;
  requests: number;
  alerts: number;
};

type SearchItem = {
  key: string;
  group: string;
  title: string;
  subtitle?: string | null;
  href: string;
  icon: React.ReactNode;
  rightLabel?: string | null;
};

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const handle = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(handle);
  }, [value, delayMs]);
  return debounced;
}

function flattenSitemapHosts(hosts: SitemapHost[]): SitemapEntry[] {
  const out: SitemapEntry[] = [];

  function walk(host: SitemapHost, node: SitemapPathNode, currentPath: string) {
    const segment = node.segment === '' ? '' : node.segment;
    const nextPath = segment ? `${currentPath}/${segment}`.replace(/\/+/g, '/') : '/';
    const path = nextPath || '/';

    out.push({
      key: `${host.host}:${host.port}${path}`,
      host: host.host,
      port: host.port,
      displayHost: host.displayLabel,
      path,
      requests: node.requests,
      alerts: node.alerts,
    });

    for (const child of node.children) {
      walk(host, child, path === '/' ? '' : path);
    }
  }

  for (const host of hosts) {
    for (const node of host.pathTree) {
      walk(host, node, '');
    }
  }

  return out;
}

function containsQuery(haystack: string, query: string): boolean {
  if (!query) return true;
  return haystack.toLowerCase().includes(query);
}

function shortHex(value: string | null | undefined, max = 18): string {
  if (!value) return '-';
  if (value.length <= max) return value;
  return `${value.slice(0, max - 6)}...${value.slice(-4)}`;
}

function rpcLabel(item: RpcInteraction): string {
  if (item.source === 'wallet') return 'wallet';
  return 'foundry';
}

export function GlobalSearch() {
  const router = useRouter();
  const { interactions } = useRpcInteractions();

  const rootRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [dropdownRect, setDropdownRect] = useState<DOMRect | null>(null);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebouncedValue(query.trim().toLowerCase(), 120);
  const [activeIndex, setActiveIndex] = useState(0);

  const [contractsState, setContractsState] = useState<LoadState>('idle');
  const [contracts, setContracts] = useState<ContractSummary[]>([]);

  const [eventsState, setEventsState] = useState<LoadState>('idle');
  const [events, setEvents] = useState<HttpMessageSummary[]>([]);

  const [sitemapState, setSitemapState] = useState<LoadState>('idle');
  const [sitemapEntries, setSitemapEntries] = useState<SitemapEntry[]>([]);

  const ensureContracts = useCallback(async () => {
    if (contractsState === 'loading' || contractsState === 'loaded') return;
    setContractsState((prev) => {
      if (prev === 'loading' || prev === 'loaded') return prev;
      return 'loading';
    });
    try {
      const res = await fetch('/api/contracts', { cache: 'no-store' });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.ok || !Array.isArray(json.items)) throw new Error('failed');
      setContracts(json.items as ContractSummary[]);
      setContractsState('loaded');
    } catch {
      setContracts([]);
      setContractsState('error');
    }
  }, [contractsState]);

  const ensureEvents = useCallback(async () => {
    if (eventsState === 'loading' || eventsState === 'loaded') return;
    setEventsState((prev) => {
      if (prev === 'loading' || prev === 'loaded') return prev;
      return 'loading';
    });
    try {
      const res = await fetch('/api/messages?limit=500&offset=0', { cache: 'no-store' });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.ok || !Array.isArray(json.items)) throw new Error('failed');
      setEvents(json.items as HttpMessageSummary[]);
      setEventsState('loaded');
    } catch {
      setEvents([]);
      setEventsState('error');
    }
  }, [eventsState]);

  const ensureSitemap = useCallback(async () => {
    if (sitemapState === 'loading' || sitemapState === 'loaded') return;
    setSitemapState((prev) => {
      if (prev === 'loading' || prev === 'loaded') return prev;
      return 'loading';
    });
    try {
      const res = await fetch('/api/sitemap', { cache: 'no-store' });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.ok || !Array.isArray(json.hosts)) throw new Error('failed');
      const hosts = json.hosts as SitemapHost[];
      setSitemapEntries(flattenSitemapHosts(hosts));
      setSitemapState('loaded');
    } catch {
      setSitemapEntries([]);
      setSitemapState('error');
    }
  }, [sitemapState]);

  useEffect(() => {
    if (!open) return;
    void ensureContracts();
    void ensureEvents();
    void ensureSitemap();
  }, [open, ensureContracts, ensureEvents, ensureSitemap]);

  useEffect(() => {
    function onDocMouseDown(e: MouseEvent) {
      const root = rootRef.current;
      const dropdown = dropdownRef.current;
      const target = e.target as Node | null;
      if (target && root?.contains(target)) return;
      if (target && dropdown?.contains(target)) return;
      setOpen(false);
    }

    if (open) document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [open]);

  useEffect(() => {
    if (!open) {
      setDropdownRect(null);
      return;
    }
    function updateRect() {
      const input = inputRef.current;
      if (!input) return;
      const rect = input.getBoundingClientRect();
      setDropdownRect(new DOMRect(rect.left, rect.bottom + 6, rect.width, 0));
    }
    updateRect();
    window.addEventListener('resize', updateRect);
    window.addEventListener('scroll', updateRect, true);
    return () => {
      window.removeEventListener('resize', updateRect);
      window.removeEventListener('scroll', updateRect, true);
    };
  }, [open]);

  const groups = useMemo(() => {
    const q = debouncedQuery;
    const hasQuery = q.length > 0;
    if (!hasQuery) return [] as Array<{ label: string; items: SearchItem[] }>;

    const contractItems: SearchItem[] = contracts
      .filter((c) =>
        containsQuery([c.name, c.address ?? '', String(c.chainId ?? ''), c.id].join(' '), q),
      )
      .slice(0, 6)
      .map((c) => ({
        key: `contract:${c.id}`,
        group: 'Contracts',
        title: c.name,
        subtitle: `${c.chainId ?? '-'} · ${shortHex(c.address, 22)}`,
        href: `/inspector?open=${encodeURIComponent(c.id)}`,
        icon: <Database className="h-3.5 w-3.5 text-[color:var(--cs-accent)]" />,
        rightLabel: 'Inspector',
      }));

    const eventItems: SearchItem[] = events
      .filter((m) =>
        containsQuery([m.method, m.host, m.path, m.url, String(m.responseStatus ?? ''), m.id].join(' '), q),
      )
      .slice(0, 8)
      .map((m) => ({
        key: `event:${m.id}`,
        group: 'Events',
        title: `${m.method} ${m.path}`,
        subtitle: `${m.host}:${m.port} · ${m.scheme.toUpperCase()} · ${m.responseStatus ?? '-'}`,
        href: `/history?panel=http&open=${encodeURIComponent(m.id)}`,
        icon: <Globe className="h-3.5 w-3.5 text-[color:var(--cs-accent)]" />,
        rightLabel: 'History',
      }));

    const sitemapItems: SearchItem[] = sitemapEntries
      .filter((s) => containsQuery([s.displayHost, s.host, String(s.port), s.path].join(' '), q))
      .slice(0, 8)
      .map((s) => ({
        key: `sitemap:${s.key}`,
        group: 'Sitemap',
        title: `${s.displayHost} ${s.path}`,
        subtitle: `${s.requests} req${s.requests === 1 ? '' : 's'}${s.alerts > 0 ? ` · ${s.alerts} alert${s.alerts === 1 ? '' : 's'}` : ''}`,
        href: `/history?panel=http&search=${encodeURIComponent(`${s.host} ${s.path}`)}`,
        icon: <Network className="h-3.5 w-3.5 text-[color:var(--cs-accent)]" />,
        rightLabel: 'History',
      }));

    const rpcItems: SearchItem[] = interactions
      .filter((it) =>
        containsQuery(
          [
            it.method,
            it.source,
            it.txHash ?? '',
            it.tx?.from ?? '',
            it.tx?.to ?? '',
            it.error ?? '',
            it.id,
          ].join(' '),
          q,
        ),
      )
      .slice(0, 8)
      .map((it) => ({
        key: `rpc:${it.id}`,
        group: 'Call History',
        title: `${it.method} · ${rpcLabel(it)}`,
        subtitle: `${shortHex(it.tx?.to, 22)} · ${it.status}${it.txHash ? ` · ${shortHex(it.txHash, 18)}` : ''}`,
        href: `/history?panel=rpc&open=${encodeURIComponent(it.id)}`,
        icon: <Activity className="h-3.5 w-3.5 text-[color:var(--cs-accent)]" />,
        rightLabel: 'Wallet RPC',
      }));

    const out: Array<{ label: string; items: SearchItem[] }> = [];
    if (contractItems.length) out.push({ label: 'Contracts', items: contractItems });
    if (eventItems.length) out.push({ label: 'Events', items: eventItems });
    if (sitemapItems.length) out.push({ label: 'Sitemap', items: sitemapItems });
    if (rpcItems.length) out.push({ label: 'Call History', items: rpcItems });

    return out;
  }, [contracts, debouncedQuery, events, interactions, sitemapEntries]);

  const flatItems = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  const indexByKey = useMemo(() => {
    const map = new Map<string, number>();
    flatItems.forEach((item, idx) => map.set(item.key, idx));
    return map;
  }, [flatItems]);

  useEffect(() => {
    if (!open) return;
    setActiveIndex(0);
  }, [debouncedQuery, open]);

  function closeAndReset() {
    setOpen(false);
    setQuery('');
    setActiveIndex(0);
  }

  const onSelect = useCallback(
    (item: SearchItem) => {
      router.push(item.href);
      closeAndReset();
    },
    [router],
  );

  const statusLine = useMemo(() => {
    const q = debouncedQuery;
    if (!open) return null;
    if (!q) return 'Type to search contracts, events, sitemap paths, and RPC calls.';

    const loading = [contractsState, eventsState, sitemapState].some((s) => s === 'idle' || s === 'loading');
    if (flatItems.length > 0) return null;

    if (loading) return 'Searching…';
    return 'No matches.';
  }, [contractsState, eventsState, sitemapState, debouncedQuery, flatItems.length, open]);

  return (
    <div ref={rootRef} className="relative w-full">
      <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[color:var(--cs-muted)]" />
      <input
        ref={inputRef}
        type="search"
        value={query}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setQuery(e.target.value);
          if (!open) setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            closeAndReset();
            inputRef.current?.blur();
            return;
          }

          if (!open) return;

          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActiveIndex((prev) => Math.min(prev + 1, Math.max(0, flatItems.length - 1)));
            return;
          }
          if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActiveIndex((prev) => Math.max(prev - 1, 0));
            return;
          }
          if (e.key === 'Enter') {
            e.preventDefault();
            const item = flatItems[activeIndex];
            if (item) onSelect(item);
          }
        }}
        placeholder="Search contracts, events, sitemap, calls..."
        className="h-8 w-full rounded-lg border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] pl-8 pr-3 text-xs outline-none transition-colors focus:border-[color:var(--cs-accent)]"
      />

      {open && dropdownRect && typeof document !== 'undefined'
        ? createPortal(
            <div
              ref={dropdownRef}
              className="fixed z-[9999] max-h-[420px] overflow-auto rounded-lg border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] shadow-xl"
              style={{
                left: dropdownRect.left,
                top: dropdownRect.top,
                width: dropdownRect.width,
              }}
            >
          {statusLine ? (
            <div className="px-3 py-2 text-[11px] text-[color:var(--cs-muted)]">{statusLine}</div>
          ) : null}

          {groups.map((group) => (
            <div key={group.label} className="border-t border-[color:var(--cs-border)] first:border-t-0">
              <div className="px-3 py-2 text-[10px] font-bold uppercase tracking-wide text-[color:var(--cs-muted)]">
                {group.label}
              </div>
              <div className="px-1 pb-2">
                {group.items.map((item) => {
                  const idx = indexByKey.get(item.key) ?? -1;
                  const isActive = idx === activeIndex;
                  return (
                    <button
                      key={item.key}
                      type="button"
                      onMouseEnter={() => idx >= 0 && setActiveIndex(idx)}
                      onClick={() => onSelect(item)}
                      className={[
                        'flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-[12px] transition-colors',
                        isActive ? 'bg-[color:var(--cs-hover)]' : 'hover:bg-[color:var(--cs-hover)]',
                      ].join(' ')}
                    >
                      <span className="flex h-6 w-6 items-center justify-center rounded-md bg-[color:var(--cs-panel-soft)]">
                        {item.icon}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium text-[color:var(--cs-fg)]">{item.title}</span>
                        {item.subtitle ? (
                          <span className="block truncate text-[11px] text-[color:var(--cs-muted)]">
                            {item.subtitle}
                          </span>
                        ) : null}
                      </span>
                      {item.rightLabel ? (
                        <span className="shrink-0 rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-1.5 py-0.5 text-[10px] font-semibold text-[color:var(--cs-muted)]">
                          {item.rightLabel}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}

          {debouncedQuery && (contractsState === 'error' || eventsState === 'error' || sitemapState === 'error') ? (
            <div className="border-t border-[color:var(--cs-border)] px-3 py-2 text-[11px] text-rose-500">
              One or more sources failed to load (agent unreachable).
            </div>
          ) : null}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
