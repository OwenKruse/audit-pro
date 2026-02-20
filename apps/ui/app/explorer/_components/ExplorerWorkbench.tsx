'use client';

import type { MarketNetwork, MarketPool, MarketTrade } from '@/lib/market-types';
import { useFoundrySettings } from '@/lib/foundry-store';
import { saveContractInspectorPrefill } from '@/lib/inspector-prefill';
import { HorizontalResizable } from '@/app/_components/HorizontalResizable';
import { Badge } from '@/components/ui/badge';
import { Check, Copy, Database, ExternalLink, RefreshCw, Search, TriangleAlert } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type View = 'new' | 'trending' | 'top' | 'search';

type PoolsApiResponse =
  | { ok: true; items: MarketPool[]; page: number; view: View; network: string | null; order: string; q: string | null }
  | { ok: false; error: { code: string; message: string; status?: number } };

type NetworksApiResponse =
  | { ok: true; items: MarketNetwork[]; page: number; nextPage: number | null }
  | { ok: false; error: { code: string; message: string; status?: number } };

type PoolDetailApiResponse =
  | { ok: true; pool: MarketPool; trades: MarketTrade[]; network: string; address: string }
  | { ok: false; error: { code: string; message: string; status?: number } };

type AbiItem = Record<string, unknown>;

type ContractMetadataData = {
  provider: string;
  fallback: string | null;
  abi: AbiItem[] | null;
  proxyResolution: unknown | null;
  implementation: {
    address: string | null;
    provider: string;
    abi: AbiItem[] | null;
  } | null;
  providerErrors: Record<string, string> | null;
  raw: unknown | null;
};

type ContractMetadataApiResponse =
  | {
      ok: true;
      query: { chainId: string; address: string; resolveProxy: boolean };
      data: ContractMetadataData;
    }
  | { ok: false; error: { message: string } };

type ContractTarget = {
  key: 'pool' | 'base' | 'quote';
  label: string;
  address: string;
};

type ContractMetadataEntry =
  | (ContractTarget & { status: 'loading' })
  | (ContractTarget & { status: 'error'; error: string })
  | (ContractTarget & { status: 'ok'; data: ContractMetadataData });

function isHexAddress(value: string | null | undefined): boolean {
  if (!value) return false;
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

function shortHex(value: string | null | undefined, max = 16): string {
  if (!value) return '-';
  if (value.length <= max) return value;
  return `${value.slice(0, max - 6)}…${value.slice(-4)}`;
}

function toNumber(value: string | null | undefined): number | null {
  if (!value) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const USD_COMPACT = new Intl.NumberFormat(undefined, {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2,
  notation: 'compact',
});

const USD_FULL = new Intl.NumberFormat(undefined, {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2,
});

function fmtUsdCompact(value: string | null | undefined): string {
  const n = toNumber(value);
  if (n == null) return '-';
  return USD_COMPACT.format(n);
}

function fmtUsd(value: string | null | undefined): string {
  const n = toNumber(value);
  if (n == null) return '-';
  return USD_FULL.format(n);
}

function fmtPct(value: string | null | undefined): { text: string; className: string } {
  const n = toNumber(value);
  if (n == null) return { text: '-', className: 'text-[color:var(--cs-muted)]' };
  const text = `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
  const className = n >= 0 ? 'text-emerald-600' : 'text-rose-600';
  return { text, className };
}

function fmtTimeAgo(iso: string | null | undefined): string {
  if (!iso) return '-';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const diffMs = Date.now() - t;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 48) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

function poolLabel(pool: MarketPool): string {
  if (pool.baseToken?.symbol && pool.quoteToken?.symbol) {
    return `${pool.baseToken.symbol} / ${pool.quoteToken.symbol}`;
  }
  return pool.name ?? pool.poolName ?? shortHex(pool.address, 22);
}

function geckoPoolUrl(network: string, address: string): string {
  const base = 'https://www.geckoterminal.com';
  return `${base}/${encodeURIComponent(network)}/pools/${encodeURIComponent(address)}`;
}

function geckoNetworkToChainId(networkId: string): number | null {
  const key = networkId.trim().toLowerCase();
  if (key === 'eth') return 1;
  if (key === 'arbitrum') return 42161;
  if (key === 'optimism') return 10;
  if (key === 'base') return 8453;
  if (key === 'polygon_pos') return 137;
  if (key === 'bsc') return 56;
  if (key === 'avalanche') return 43114;
  if (key === 'fantom') return 250;
  if (key === 'xdai') return 100;
  if (key === 'celo') return 42220;
  if (key === 'linea') return 59144;
  if (key === 'zksync') return 324;
  if (key === 'scroll') return 534352;
  if (key === 'blast') return 81457;
  if (key === 'mantle') return 5000;
  if (key === 'polygon_zkevm') return 1101;
  return null;
}

function toBlockscoutBase(explorerBase: string): string | null {
  const trimmed = explorerBase.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (!parsed.hostname.toLowerCase().includes('blockscout')) return null;
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}

function explorerAddressUrl(explorerBase: string, address: string): string {
  const trimmed = explorerBase.replace(/\/+$/, '');
  return `${trimmed}/address/${address}`;
}

function explorerTxUrl(explorerBase: string, txHash: string): string {
  const trimmed = explorerBase.replace(/\/+$/, '');
  return `${trimmed}/tx/${txHash}`;
}

async function copyToClipboard(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

function abiKindCount(abi: AbiItem[] | null, kind: string): number {
  if (!abi) return 0;
  let count = 0;
  for (const item of abi) {
    if (item.type === kind) count += 1;
  }
  return count;
}

function abiNamedEntries(abi: AbiItem[] | null, kind: string, max = 10): string[] {
  if (!abi) return [];
  const out: string[] = [];
  for (const item of abi) {
    if (item.type !== kind) continue;
    if (typeof item.name !== 'string' || !item.name.trim()) continue;
    out.push(item.name.trim());
    if (out.length >= max) break;
  }
  return out;
}

function abiPreviewJson(abi: AbiItem[] | null, maxItems = 40): string {
  if (!abi) return 'No ABI found.';
  const sliced = abi.slice(0, maxItems);
  const suffix = abi.length > maxItems ? `\n\n/* truncated: showing ${maxItems} of ${abi.length} ABI entries */` : '';
  return `${JSON.stringify(sliced, null, 2)}${suffix}`;
}

export function ExplorerWorkbench() {
  const router = useRouter();
  const { settings } = useFoundrySettings();

  const [networks, setNetworks] = useState<MarketNetwork[] | null>(null);
  const [networksLoading, setNetworksLoading] = useState(false);
  const [networksError, setNetworksError] = useState<string | null>(null);
  const [networksNextPage, setNetworksNextPage] = useState<number | null>(null);

  const [networkId, setNetworkId] = useState('eth');
  const [view, setView] = useState<View>('new');
  const [order, setOrder] = useState('h24_volume_usd_desc');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);

  const [pools, setPools] = useState<MarketPool[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [selectedPoolId, setSelectedPoolId] = useState<string | null>(null);

  const [detail, setDetail] = useState<{ pool: MarketPool; trades: MarketTrade[] } | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [contractEntries, setContractEntries] = useState<ContractMetadataEntry[]>([]);

  const [tradeView, setTradeView] = useState<'latest' | 'largest'>('latest');
  const [minTradeUsd, setMinTradeUsd] = useState('10000');
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const poolsAbortRef = useRef<AbortController | null>(null);
  const detailAbortRef = useRef<AbortController | null>(null);
  const contractAbortRef = useRef<AbortController | null>(null);
  const copiedTimerRef = useRef<number | null>(null);

  const effectiveNetworkId = useMemo(() => networkId.trim().toLowerCase(), [networkId]);

  const selectedPool = useMemo(
    () => pools.find((p) => p.id === selectedPoolId) ?? null,
    [pools, selectedPoolId],
  );

  const loadNetworks = useCallback(
    async (requestedPage: number, mode: 'replace' | 'append') => {
      setNetworksLoading(true);
      setNetworksError(null);
      try {
        const res = await fetch(`/api/market/networks?page=${requestedPage}`, { cache: 'no-store' });
        const json = (await res.json().catch(() => null)) as NetworksApiResponse | null;
        if (!res.ok || !json || json.ok !== true) {
          throw new Error(json && json.ok === false ? json.error.message : 'Failed to load networks.');
        }

        setNetworks((prev) => {
          if (mode === 'replace') return json.items;
          const existing = prev ?? [];
          const byId = new Map(existing.map((n) => [n.id, n] as const));
          for (const n of json.items) byId.set(n.id, n);
          return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
        });
        setNetworksNextPage(json.nextPage);
      } catch (err) {
        setNetworksError(err instanceof Error ? err.message : 'Failed to load networks.');
      } finally {
        setNetworksLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    // Prefill a small network list for better UX, but don't block the explorer if it fails.
    void loadNetworks(1, 'replace');
  }, [loadNetworks]);

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current) window.clearTimeout(copiedTimerRef.current);
      poolsAbortRef.current?.abort();
      detailAbortRef.current?.abort();
      contractAbortRef.current?.abort();
    };
  }, []);

  const markCopied = useCallback((key: string) => {
    setCopiedKey(key);
    if (copiedTimerRef.current) window.clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = window.setTimeout(() => {
      setCopiedKey((prev) => (prev === key ? null : prev));
    }, 900);
  }, []);

  const onCopy = useCallback(
    async (key: string, value: string) => {
      const ok = await copyToClipboard(value);
      if (ok) markCopied(key);
    },
    [markCopied],
  );

  const loadPools = useCallback(
    async (mode: 'replace' | 'append') => {
      setLoading(true);
      setError(null);
      poolsAbortRef.current?.abort();
      const controller = new AbortController();
      poolsAbortRef.current = controller;

      const qs = new URLSearchParams();
      qs.set('view', view);
      qs.set('page', String(page));
      if (view !== 'search') qs.set('network', effectiveNetworkId || 'eth');
      if (view === 'search') qs.set('q', query.trim());
      if (view === 'top') qs.set('order', order);
      if (view === 'search' && effectiveNetworkId) qs.set('network', effectiveNetworkId);

      try {
        const res = await fetch(`/api/market/pools?${qs.toString()}`, {
          cache: 'no-store',
          signal: controller.signal,
        });
        const json = (await res.json().catch(() => null)) as PoolsApiResponse | null;
        if (!res.ok || !json || json.ok !== true) {
          throw new Error(json && json.ok === false ? json.error.message : 'Failed to load pools.');
        }

        setPools((prev) => (mode === 'replace' ? json.items : [...prev, ...json.items]));
        setSelectedPoolId((prevSelected) => {
          const nextItems = mode === 'replace' ? json.items : [...pools, ...json.items];
          if (prevSelected && nextItems.some((p) => p.id === prevSelected)) return prevSelected;
          return nextItems[0]?.id ?? null;
        });
      } catch (err) {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : 'Failed to load pools.');
        if (mode === 'replace') {
          setPools([]);
          setSelectedPoolId(null);
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    },
    [effectiveNetworkId, order, page, pools, query, view],
  );

  // Reset paging when switching views.
  useEffect(() => {
    setPage(1);
  }, [view, effectiveNetworkId, order, query]);

  useEffect(() => {
    void loadPools('replace');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, effectiveNetworkId, order, query, page]);

  const loadPoolDetail = useCallback(async () => {
    if (!selectedPool) {
      setDetail(null);
      setDetailError(null);
      return;
    }

    setDetailLoading(true);
    setDetailError(null);
    setDetail(null);
    detailAbortRef.current?.abort();
    const controller = new AbortController();
    detailAbortRef.current = controller;

    const net = selectedPool.networkId ?? effectiveNetworkId;
    if (!net) {
      setDetailError('Missing network id for selected pool.');
      setDetailLoading(false);
      return;
    }

    const qs = new URLSearchParams({ network: net, address: selectedPool.address });
    try {
      const res = await fetch(`/api/market/pool?${qs.toString()}`, {
        cache: 'no-store',
        signal: controller.signal,
      });
      const json = (await res.json().catch(() => null)) as PoolDetailApiResponse | null;
      if (!res.ok || !json || json.ok !== true) {
        throw new Error(json && json.ok === false ? json.error.message : 'Failed to load pool detail.');
      }
      setDetail({ pool: json.pool, trades: json.trades });
    } catch (err) {
      if (controller.signal.aborted) return;
      setDetailError(err instanceof Error ? err.message : 'Failed to load pool detail.');
    } finally {
      if (!controller.signal.aborted) setDetailLoading(false);
    }
  }, [effectiveNetworkId, selectedPool]);

  useEffect(() => {
    void loadPoolDetail();
  }, [loadPoolDetail]);

  useEffect(() => {
    contractAbortRef.current?.abort();
    const currentPool = detail?.pool;
    if (!currentPool) {
      setContractEntries([]);
      return;
    }

    const networkKey = (currentPool.networkId ?? effectiveNetworkId ?? '').trim().toLowerCase();
    const chainId = networkKey ? geckoNetworkToChainId(networkKey) : null;
    if (!chainId) {
      setContractEntries([
        {
          key: 'pool',
          label: 'Pool Contract',
          address: currentPool.address,
          status: 'error',
          error: `Unsupported or unknown network id: ${networkKey || 'unknown'}`,
        },
      ]);
      return;
    }

    const targets: ContractTarget[] = [];
    if (isHexAddress(currentPool.address)) {
      targets.push({ key: 'pool', label: 'Pool Contract', address: currentPool.address });
    }
    const baseAddress = currentPool.baseToken?.address ?? null;
    if (isHexAddress(baseAddress)) {
      targets.push({ key: 'base', label: 'Base Token Contract', address: baseAddress as string });
    }
    const quoteAddress = currentPool.quoteToken?.address ?? null;
    if (isHexAddress(quoteAddress)) {
      targets.push({ key: 'quote', label: 'Quote Token Contract', address: quoteAddress as string });
    }

    if (targets.length === 0) {
      setContractEntries([]);
      return;
    }

    setContractEntries(targets.map((target) => ({ ...target, status: 'loading' })));
    const controller = new AbortController();
    contractAbortRef.current = controller;

    const run = async () => {
      const blockscoutBase = toBlockscoutBase(settings.blockExplorerUrl);
      const next = await Promise.all(
        targets.map(async (target): Promise<ContractMetadataEntry> => {
          const qs = new URLSearchParams();
          qs.set('chainId', String(chainId));
          qs.set('address', target.address);
          qs.set('resolveProxy', '1');
          if (blockscoutBase) qs.set('blockscout', blockscoutBase);

          try {
            const res = await fetch(`/api/contracts/metadata?${qs.toString()}`, {
              cache: 'no-store',
              signal: controller.signal,
            });
            const json = (await res.json().catch(() => null)) as ContractMetadataApiResponse | null;
            if (!res.ok || !json || json.ok !== true) {
              const message =
                json && json.ok === false ? json.error.message : `Failed to load metadata (${res.status}).`;
              return { ...target, status: 'error', error: message };
            }
            return { ...target, status: 'ok', data: json.data };
          } catch (err) {
            if (controller.signal.aborted) {
              return { ...target, status: 'error', error: 'Request cancelled.' };
            }
            return {
              ...target,
              status: 'error',
              error: err instanceof Error ? err.message : 'Failed to load contract metadata.',
            };
          }
        }),
      );

      if (!controller.signal.aborted) {
        setContractEntries(next);
      }
    };

    void run();
    return () => {
      controller.abort();
    };
  }, [detail?.pool, effectiveNetworkId, settings.blockExplorerUrl]);

  const filteredTrades = useMemo(() => {
    const base = detail?.trades ?? [];
    const minUsd = toNumber(minTradeUsd.trim()) ?? 0;
    const withMin = base.filter((t) => (toNumber(t.volumeUsd) ?? 0) >= minUsd);
    if (tradeView === 'latest') {
      return withMin.slice(0, 60);
    }
    const sorted = [...withMin].sort((a, b) => (toNumber(b.volumeUsd) ?? 0) - (toNumber(a.volumeUsd) ?? 0));
    return sorted.slice(0, 60);
  }, [detail?.trades, minTradeUsd, tradeView]);

  const onSavePoolToInspector = useCallback(() => {
    if (!detail?.pool) return;
    if (!isHexAddress(detail.pool.address)) return;
    const net = (detail.pool.networkId ?? effectiveNetworkId ?? 'eth').trim().toLowerCase();
    saveContractInspectorPrefill({
      address: detail.pool.address,
      chainId: geckoNetworkToChainId(net),
      name: `Pool: ${poolLabel(detail.pool)}`,
      notes: `Imported from GeckoTerminal (${net}). DEX: ${detail.pool.dex?.name ?? 'unknown'}.`,
      source: 'geckoterminal',
      abiJson: null,
      createdAt: new Date().toISOString(),
    });
  }, [detail?.pool, effectiveNetworkId]);

  const onOpenInInspector = useCallback(
    (entry: ContractMetadataEntry) => {
      if (!detail?.pool) return;
      if (!isHexAddress(entry.address)) return;
      const net = (detail.pool.networkId ?? effectiveNetworkId ?? '').trim().toLowerCase();
      const abiJson =
        entry.status === 'ok' && entry.data.abi && Array.isArray(entry.data.abi)
          ? JSON.stringify(entry.data.abi, null, 2)
          : null;
      saveContractInspectorPrefill({
        address: entry.address,
        chainId: geckoNetworkToChainId(net),
        name: `${entry.label}: ${poolLabel(detail.pool)}`,
        notes: `Imported from DEX Explorer (${net || 'unknown'}). Contract role: ${entry.label}.`,
        source: 'geckoterminal',
        abiJson,
        createdAt: new Date().toISOString(),
      });
      router.push('/inspector');
    },
    [detail?.pool, effectiveNetworkId, router],
  );

  const blockExplorerBase = settings.blockExplorerUrl.trim();
  const canUseBlockExplorer = Boolean(blockExplorerBase);

  return (
    <div className="flex h-full min-h-0 flex-col bg-[color:var(--cs-panel)]">
      <div className="flex flex-col gap-2 border-b border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-3 py-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h3 className="text-[11px] font-bold uppercase tracking-wider text-[color:var(--cs-fg)]">
              DEX Explorer
            </h3>
            <Badge variant="outline" className="text-[10px]">
              GeckoTerminal
            </Badge>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void loadPools('replace')}
              className="inline-flex h-7 items-center gap-1.5 rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 text-[11px] font-medium text-[color:var(--cs-fg)] hover:bg-[color:var(--cs-hover)]"
              title="Refresh"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Refresh
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <label className="text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">
              View
            </label>
            <select
              value={view}
              onChange={(e) => setView(e.target.value as View)}
              className="h-7 rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 text-[12px] outline-none focus:border-[color:var(--cs-accent)]"
            >
              <option value="new">New Pairs</option>
              <option value="trending">Trending</option>
              <option value="top">Top Volume</option>
              <option value="search">Search</option>
            </select>
          </div>

          <div className="flex items-center gap-2">
            <label className="text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">
              Network
            </label>
            <input
              value={networkId}
              onChange={(e) => setNetworkId(e.target.value)}
              list="cs-market-networks"
              placeholder="eth"
              className="h-7 w-44 rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 font-mono text-[12px] outline-none focus:border-[color:var(--cs-accent)]"
            />
            <datalist id="cs-market-networks">
              {(networks ?? []).map((n) => (
                <option key={n.id} value={n.id}>
                  {n.name ?? n.id}
                </option>
              ))}
            </datalist>
            <button
              type="button"
              onClick={() => void loadNetworks(1, 'replace')}
              disabled={networksLoading}
              className="inline-flex h-7 items-center gap-1.5 rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 text-[11px] font-medium text-[color:var(--cs-fg)] hover:bg-[color:var(--cs-hover)] disabled:opacity-50"
              title="Reload network ids"
            >
              {networksLoading ? 'Loading…' : 'Load'}
            </button>
            {networksNextPage ? (
              <button
                type="button"
                onClick={() => void loadNetworks(networksNextPage, 'append')}
                disabled={networksLoading}
                className="inline-flex h-7 items-center rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 text-[11px] font-medium text-[color:var(--cs-fg)] hover:bg-[color:var(--cs-hover)] disabled:opacity-50"
                title="Load more networks"
              >
                More
              </button>
            ) : null}
            {networksError ? (
              <span className="text-[11px] text-rose-600">{networksError}</span>
            ) : null}
          </div>

          {view === 'top' ? (
            <div className="flex items-center gap-2">
              <label className="text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">
                Order
              </label>
              <select
                value={order}
                onChange={(e) => setOrder(e.target.value)}
                className="h-7 rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 text-[12px] outline-none focus:border-[color:var(--cs-accent)]"
              >
                <option value="h24_volume_usd_desc">24h Volume</option>
                <option value="h24_tx_count_desc">24h Tx Count</option>
              </select>
            </div>
          ) : null}

          {view === 'search' ? (
            <div className="flex min-w-[240px] flex-1 items-center gap-2">
              <label className="text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">
                Query
              </label>
              <div className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-[color:var(--cs-muted)]" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="token, symbol, pool address…"
                  className="h-7 w-full rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] pl-8 pr-2 text-[12px] outline-none focus:border-[color:var(--cs-accent)]"
                />
              </div>

            </div>
          ) : null}

          <div className="ml-auto flex items-center gap-2 text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">
            <span>Page</span>
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="h-7 rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 text-[11px] font-medium text-[color:var(--cs-fg)] hover:bg-[color:var(--cs-hover)] disabled:opacity-50"
              disabled={page <= 1}
            >
              Prev
            </button>
            <span className="min-w-[32px] text-center text-[color:var(--cs-fg)]">{page}</span>
            <button
              type="button"
              onClick={() => setPage((p) => p + 1)}
              className="h-7 rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 text-[11px] font-medium text-[color:var(--cs-fg)] hover:bg-[color:var(--cs-hover)]"
            >
              Next
            </button>
          </div>
        </div>

        {error ? (
          <div className="rounded border border-rose-500/30 bg-rose-500/10 px-2 py-1 text-[11px] text-rose-200">
            {error}
          </div>
        ) : null}
      </div>

      <HorizontalResizable storageKey="cs-market-explorer-detail-width" defaultRatio={0.42}>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="grid grid-cols-[1.2fr_92px_92px_92px_84px] border-b border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-3 py-2 text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">
            <div>Pool</div>
            <div className="text-right">Liquidity</div>
            <div className="text-right">Vol 24h</div>
            <div className="text-right">Tx 24h</div>
            <div className="text-right">Age</div>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {loading ? (
              <div className="p-6 text-[12px] text-[color:var(--cs-muted)]">Loading pools…</div>
            ) : pools.length === 0 ? (
              <div className="p-6 text-[12px] text-[color:var(--cs-muted)]">
                No pools found for this view.
              </div>
            ) : (
              pools.map((pool) => {
                const selected = pool.id === selectedPoolId;
                const tx24hRaw = (() => {
                  const tx = pool.transactions;
                  if (!tx || typeof tx !== 'object' || Array.isArray(tx)) return null;
                  return (tx as Record<string, unknown>).h24 ?? null;
                })();
                const tx24h =
                  tx24hRaw && typeof tx24hRaw === 'object' && !Array.isArray(tx24hRaw)
                    ? (tx24hRaw as Record<string, unknown>)
                    : null;
                const buys = tx24h ? Number(tx24h.buys ?? 0) : 0;
                const sells = tx24h ? Number(tx24h.sells ?? 0) : 0;
                const tx24hCount = Number.isFinite(buys) && Number.isFinite(sells) ? String(buys + sells) : '-';
                return (
                  <button
                    key={pool.id}
                    type="button"
                    onClick={() => setSelectedPoolId(pool.id)}
                    className={[
                      'grid w-full grid-cols-[1.2fr_92px_92px_92px_84px] items-center gap-2 border-b border-[color:var(--cs-border)] px-3 py-2 text-left text-[12px] transition-colors',
                      selected
                        ? 'bg-[color:var(--cs-accent-soft)]'
                        : 'bg-[color:var(--cs-panel)] hover:bg-[color:var(--cs-hover)]',
                    ].join(' ')}
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-semibold text-[color:var(--cs-fg)]">
                          {poolLabel(pool)}
                        </span>
                        {pool.dex?.name ? (
                          <Badge variant="outline" className="text-[10px]">
                            {pool.dex.name}
                          </Badge>
                        ) : null}
                      </div>
                      <div className="mt-0.5 flex items-center gap-2 font-mono text-[10px] text-[color:var(--cs-muted)]">
                        <span>{(pool.networkId ?? effectiveNetworkId ?? '—').toUpperCase()}</span>
                        <span title={pool.address}>{shortHex(pool.address, 22)}</span>
                      </div>
                    </div>
                    <div className="text-right font-mono text-[11px] text-[color:var(--cs-fg)]">
                      {fmtUsdCompact(pool.reserveUsd)}
                    </div>
                    <div className="text-right font-mono text-[11px] text-[color:var(--cs-fg)]">
                      {fmtUsdCompact(pool.volumeUsd?.h24)}
                    </div>
                    <div className="text-right font-mono text-[11px] text-[color:var(--cs-fg)]">
                      {tx24hCount}
                    </div>
                    <div className="text-right font-mono text-[10px] text-[color:var(--cs-muted)]">
                      {fmtTimeAgo(pool.poolCreatedAt)}
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>

        <div className="flex min-h-0 flex-col overflow-hidden bg-[color:var(--cs-panel-soft)]">
          <div className="border-b border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-3 py-2">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h4 className="truncate text-[12px] font-bold text-[color:var(--cs-fg)]">
                    {detail?.pool ? poolLabel(detail.pool) : selectedPool ? poolLabel(selectedPool) : 'Pool Detail'}
                  </h4>
                  {detail?.pool?.dex?.name ? (
                    <Badge variant="outline" className="text-[10px]">
                      {detail.pool.dex.name}
                    </Badge>
                  ) : null}
                </div>
                <div className="mt-0.5 font-mono text-[10px] text-[color:var(--cs-muted)]">
                  {detail?.pool?.networkId ?? selectedPool?.networkId ?? effectiveNetworkId ?? '—'} ·{' '}
                  <span title={detail?.pool?.address ?? selectedPool?.address ?? undefined}>
                    {shortHex(detail?.pool?.address ?? selectedPool?.address ?? null, 26)}
                  </span>
                </div>
              </div>
              {detail?.pool ? (
                <div className="flex shrink-0 items-center gap-1.5">
                  <a
                    className="inline-flex h-7 items-center gap-1.5 rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 text-[11px] font-medium text-[color:var(--cs-fg)] hover:bg-[color:var(--cs-hover)]"
                    href={geckoPoolUrl(detail.pool.networkId ?? effectiveNetworkId ?? 'eth', detail.pool.address)}
                    target="_blank"
                    rel="noreferrer"
                    title="Open in GeckoTerminal"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    Gecko
                  </a>
                  <button
                    type="button"
                    onClick={() => void onCopy('pool:address', detail.pool.address)}
                    className="inline-flex h-7 items-center gap-1.5 rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 text-[11px] font-medium text-[color:var(--cs-fg)] hover:bg-[color:var(--cs-hover)]"
                    title="Copy pool address"
                  >
                    {copiedKey === 'pool:address' ? (
                      <Check className="h-3.5 w-3.5" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => onSavePoolToInspector()}
                    disabled={!isHexAddress(detail.pool.address)}
                    className="inline-flex h-7 items-center gap-1.5 rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 text-[11px] font-medium text-[color:var(--cs-fg)] hover:bg-[color:var(--cs-hover)] disabled:opacity-50"
                    title="Save pool address to Contract Inspector"
                  >
                    <Database className="h-3.5 w-3.5" />
                    Inspector
                  </button>
                </div>
              ) : null}
            </div>

            {detailLoading ? (
              <div className="mt-2 text-[11px] text-[color:var(--cs-muted)]">Loading pool details…</div>
            ) : null}
            {detailError ? (
              <div className="mt-2 flex items-center gap-2 rounded border border-rose-500/30 bg-rose-500/10 px-2 py-1 text-[11px] text-rose-200">
                <TriangleAlert className="h-4 w-4" />
                <span>{detailError}</span>
              </div>
            ) : null}
          </div>

          <div className="min-h-0 flex-1 overflow-auto p-3">
            {!detail?.pool ? (
              <div className="flex h-full items-center justify-center text-[12px] text-[color:var(--cs-muted)]">
                Select a pool to inspect price, volume, and trade events.
              </div>
            ) : (
              <div className="space-y-3">
                <div className="grid gap-2 md:grid-cols-2">
                  <Metric label="Liquidity" value={fmtUsd(detail.pool.reserveUsd)} />
                  <Metric label="FDV" value={fmtUsd(detail.pool.fdvUsd)} />
                  <Metric label="Vol (24h)" value={fmtUsd(detail.pool.volumeUsd?.h24)} />
                  <Metric label="Vol (1h)" value={fmtUsd(detail.pool.volumeUsd?.h1)} />
                  <Metric
                    label="Price Change (24h)"
                    value={fmtPct(detail.pool.priceChangePercentage?.h24).text}
                    valueClass={fmtPct(detail.pool.priceChangePercentage?.h24).className}
                  />
                  <Metric label="Created" value={detail.pool.poolCreatedAt ? new Date(detail.pool.poolCreatedAt).toLocaleString() : '-'} />
                </div>

                <div className="rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] p-2">
                  <div className="mb-2 text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">
                    Tokens
                  </div>
                  <div className="space-y-2">
                    <TokenRow
                      label="Base"
                      token={detail.pool.baseToken}
                      blockExplorerBase={blockExplorerBase}
                      canUseBlockExplorer={canUseBlockExplorer}
                      copied={Boolean(detail.pool.baseToken?.address && copiedKey === `token:${detail.pool.baseToken.address}`)}
                      onCopy={(address) => void onCopy(`token:${address}`, address)}
                    />
                    <TokenRow
                      label="Quote"
                      token={detail.pool.quoteToken}
                      blockExplorerBase={blockExplorerBase}
                      canUseBlockExplorer={canUseBlockExplorer}
                      copied={Boolean(detail.pool.quoteToken?.address && copiedKey === `token:${detail.pool.quoteToken.address}`)}
                      onCopy={(address) => void onCopy(`token:${address}`, address)}
                    />
                  </div>
                </div>

                <div className="rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] p-2">
                  <div className="mb-2 text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">
                    Contracts & ABI
                  </div>
                  {contractEntries.length === 0 ? (
                    <div className="text-[11px] text-[color:var(--cs-muted)]">
                      No EVM contract addresses available for this pool.
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {contractEntries.map((entry) => (
                        <div
                          key={`${entry.key}:${entry.address}`}
                          className="rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] p-2"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <div className="min-w-0">
                              <div className="text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">
                                {entry.label}
                              </div>
                              <div className="mt-0.5 font-mono text-[11px] text-[color:var(--cs-fg)]" title={entry.address}>
                                {shortHex(entry.address, 30)}
                              </div>
                            </div>
                            <button
                              type="button"
                              onClick={() => void onCopy(`contract:${entry.address}`, entry.address)}
                              className="inline-flex h-7 items-center gap-1 rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 text-[10px] font-medium text-[color:var(--cs-fg)] hover:bg-[color:var(--cs-hover)]"
                              title="Copy contract address"
                            >
                              {copiedKey === `contract:${entry.address}` ? (
                                <Check className="h-3.5 w-3.5" />
                              ) : (
                                <Copy className="h-3.5 w-3.5" />
                              )}
                            </button>
                            <button
                              type="button"
                              onClick={() => onOpenInInspector(entry)}
                              className="inline-flex h-7 items-center gap-1 rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 text-[10px] font-medium text-[color:var(--cs-fg)] hover:bg-[color:var(--cs-hover)]"
                              title="Open in Contract Inspector"
                            >
                              <Database className="h-3.5 w-3.5" />
                              Inspector
                            </button>
                          </div>

                          {entry.status === 'loading' ? (
                            <div className="mt-2 text-[11px] text-[color:var(--cs-muted)]">Loading metadata…</div>
                          ) : null}

                          {entry.status === 'error' ? (
                            <div className="mt-2 rounded border border-rose-500/30 bg-rose-500/10 px-2 py-1 text-[11px] text-rose-200">
                              {entry.error}
                            </div>
                          ) : null}

                          {entry.status === 'ok' ? (
                            <div className="mt-2 space-y-2">
                              <div className="grid gap-1 sm:grid-cols-2">
                                <MiniMetric label="Provider" value={entry.data.provider} />
                                <MiniMetric label="Fallback" value={entry.data.fallback ?? '-'} />
                                <MiniMetric label="ABI Entries" value={String(entry.data.abi?.length ?? 0)} />
                                <MiniMetric
                                  label="Proxy"
                                  value={
                                    entry.data.proxyResolution &&
                                    typeof entry.data.proxyResolution === 'object' &&
                                    !Array.isArray(entry.data.proxyResolution) &&
                                    (entry.data.proxyResolution as { isProxy?: unknown }).isProxy === true
                                      ? 'Yes'
                                      : 'No'
                                  }
                                />
                              </div>

                              <div className="grid gap-1 sm:grid-cols-3">
                                <MiniMetric label="Functions" value={String(abiKindCount(entry.data.abi, 'function'))} />
                                <MiniMetric label="Events" value={String(abiKindCount(entry.data.abi, 'event'))} />
                                <MiniMetric label="Errors" value={String(abiKindCount(entry.data.abi, 'error'))} />
                              </div>

                              {entry.data.implementation?.address ? (
                                <div className="rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 py-1.5 text-[11px]">
                                  <div className="text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">
                                    Implementation
                                  </div>
                                  <div className="mt-0.5 font-mono text-[color:var(--cs-fg)]" title={entry.data.implementation.address}>
                                    {shortHex(entry.data.implementation.address, 30)}
                                  </div>
                                </div>
                              ) : null}

                              {abiNamedEntries(entry.data.abi, 'function', 8).length > 0 ? (
                                <div>
                                  <div className="text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">
                                    Top Functions
                                  </div>
                                  <div className="mt-1 flex flex-wrap gap-1">
                                    {abiNamedEntries(entry.data.abi, 'function', 8).map((name) => (
                                      <span
                                        key={`${entry.address}:fn:${name}`}
                                        className="rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-1.5 py-0.5 font-mono text-[10px] text-[color:var(--cs-fg)]"
                                      >
                                        {name}
                                      </span>
                                    ))}
                                  </div>
                                </div>
                              ) : null}

                              {entry.data.providerErrors ? (
                                <details className="rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1">
                                  <summary className="cursor-pointer text-[10px] font-bold uppercase text-amber-700">
                                    Provider Errors
                                  </summary>
                                  <pre className="mt-1 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] text-amber-700">
                                    {JSON.stringify(entry.data.providerErrors, null, 2)}
                                  </pre>
                                </details>
                              ) : null}

                              <details className="rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 py-1">
                                <summary className="cursor-pointer text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">
                                  ABI JSON
                                </summary>
                                <div className="mt-1 flex justify-end">
                                  <button
                                    type="button"
                                    onClick={() =>
                                      void onCopy(
                                        `abi:${entry.address}`,
                                        JSON.stringify(entry.data.abi ?? [], null, 2),
                                      )
                                    }
                                    className="inline-flex h-6 items-center gap-1 rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-2 text-[10px] font-medium text-[color:var(--cs-fg)] hover:bg-[color:var(--cs-hover)]"
                                  >
                                    {copiedKey === `abi:${entry.address}` ? (
                                      <Check className="h-3 w-3" />
                                    ) : (
                                      <Copy className="h-3 w-3" />
                                    )}
                                    Copy ABI
                                  </button>
                                </div>
                                <pre className="mt-1 max-h-44 overflow-auto whitespace-pre-wrap break-words rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] p-2 font-mono text-[10px] text-[color:var(--cs-fg)]">
                                  {abiPreviewJson(entry.data.abi)}
                                </pre>
                              </details>
                            </div>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] p-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">
                      Trade Events
                    </div>
                    <div className="flex items-center gap-2">
                      <label className="text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">
                        View
                      </label>
                      <select
                        value={tradeView}
                        onChange={(e) => setTradeView(e.target.value as 'latest' | 'largest')}
                        className="h-7 rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-2 text-[12px] outline-none focus:border-[color:var(--cs-accent)]"
                      >
                        <option value="latest">Latest</option>
                        <option value="largest">Largest</option>
                      </select>
                      <label className="text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">
                        Min USD
                      </label>
                      <input
                        value={minTradeUsd}
                        onChange={(e) => setMinTradeUsd(e.target.value)}
                        className="h-7 w-24 rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-2 font-mono text-[12px] outline-none focus:border-[color:var(--cs-accent)]"
                        placeholder="10000"
                      />
                    </div>
                  </div>

                  <div className="mt-2 overflow-hidden rounded border border-[color:var(--cs-border)]">
                    <div className="grid grid-cols-[78px_60px_1fr_88px_92px] bg-[color:var(--cs-panel-soft)] px-2 py-1 text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">
                      <div>Time</div>
                      <div>Side</div>
                      <div>Tx</div>
                      <div className="text-right">USD</div>
                      <div className="text-right">Price</div>
                    </div>
                    <div className="max-h-[340px] overflow-auto bg-[color:var(--cs-panel)]">
                      {filteredTrades.length === 0 ? (
                        <div className="px-2 py-3 text-[12px] text-[color:var(--cs-muted)]">
                          No trades match this filter.
                        </div>
                      ) : (
                        filteredTrades.map((t) => {
                          const time = t.blockTimestamp ? new Date(t.blockTimestamp).toLocaleTimeString([], { hour12: false }) : '--';
                          const side = (t.kind ?? '').toLowerCase();
                          const sideClass =
                            side === 'buy'
                              ? 'text-emerald-600'
                              : side === 'sell'
                                ? 'text-rose-600'
                                : 'text-[color:var(--cs-muted)]';
                          const txHash = t.txHash ?? null;
                          const price = t.priceFromUsd ?? t.priceToUsd ?? null;
                          return (
                            <div
                              key={t.id}
                              className="grid grid-cols-[78px_60px_1fr_88px_92px] items-center gap-2 border-t border-[color:var(--cs-border)] px-2 py-1.5 text-[11px]"
                            >
                              <div className="font-mono text-[10px] text-[color:var(--cs-muted)]">
                                {time}
                              </div>
                              <div className={`font-mono text-[10px] font-bold uppercase ${sideClass}`}>
                                {t.kind ?? '--'}
                              </div>
                              <div className="min-w-0">
                                {txHash ? (
                                  <div className="flex items-center gap-2">
                                    <button
                                      type="button"
                                      onClick={() => void copyToClipboard(txHash)}
                                      className="font-mono text-[10px] text-[color:var(--cs-fg)] hover:underline truncate"
                                      title={txHash}
                                    >
                                      {shortHex(txHash, 18)}
                                    </button>
                                    {canUseBlockExplorer ? (
                                      <a
                                        href={explorerTxUrl(blockExplorerBase, txHash)}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="text-[color:var(--cs-accent)] hover:underline text-[10px]"
                                        title="Open tx in block explorer"
                                      >
                                        View
                                      </a>
                                    ) : null}
                                  </div>
                                ) : (
                                  <span className="text-[color:var(--cs-muted)]">—</span>
                                )}
                              </div>
                              <div className="text-right font-mono text-[10px] text-[color:var(--cs-fg)]">
                                {fmtUsdCompact(t.volumeUsd)}
                              </div>
                              <div className="text-right font-mono text-[10px] text-[color:var(--cs-fg)]">
                                {price ? fmtUsdCompact(price) : '-'}
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </HorizontalResizable>
    </div>
  );
}

function Metric(props: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] p-2">
      <div className="text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">{props.label}</div>
      <div className={['mt-1 font-mono text-[12px] text-[color:var(--cs-fg)]', props.valueClass ?? ''].join(' ')}>
        {props.value}
      </div>
    </div>
  );
}

function MiniMetric(props: { label: string; value: string }) {
  return (
    <div className="rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 py-1">
      <div className="text-[9px] font-bold uppercase text-[color:var(--cs-muted)]">{props.label}</div>
      <div className="mt-0.5 truncate font-mono text-[10px] text-[color:var(--cs-fg)]" title={props.value}>
        {props.value}
      </div>
    </div>
  );
}

function TokenRow(props: {
  label: string;
  token: MarketPool['baseToken'] | null;
  blockExplorerBase: string;
  canUseBlockExplorer: boolean;
  copied: boolean;
  onCopy: (address: string) => void;
}) {
  const token = props.token;
  const address = token?.address ?? null;
  const isEvm = isHexAddress(address);

  return (
    <div className="flex items-center justify-between gap-2 rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-2 py-1.5">
      <div className="min-w-0">
        <div className="text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">{props.label}</div>
        <div className="mt-0.5 flex items-center gap-2">
          <span className="font-semibold text-[12px] text-[color:var(--cs-fg)]">
            {token?.symbol ?? token?.name ?? 'Unknown'}
          </span>
          <span className="font-mono text-[10px] text-[color:var(--cs-muted)]" title={address ?? undefined}>
            {address ? shortHex(address, 24) : '—'}
          </span>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {address ? (
          <button
            type="button"
            onClick={() => props.onCopy(address)}
            className="inline-flex h-7 items-center gap-1.5 rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 text-[11px] font-medium text-[color:var(--cs-fg)] hover:bg-[color:var(--cs-hover)]"
            title="Copy address"
          >
            {props.copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          </button>
        ) : null}
        {props.canUseBlockExplorer && address && isEvm ? (
          <a
            href={explorerAddressUrl(props.blockExplorerBase, address)}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-7 items-center gap-1.5 rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 text-[11px] font-medium text-[color:var(--cs-fg)] hover:bg-[color:var(--cs-hover)]"
            title="Open in block explorer"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            Explorer
          </a>
        ) : null}
      </div>
    </div>
  );
}
