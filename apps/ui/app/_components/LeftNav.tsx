'use client';

import type {
  ContractDecodedItem,
  ContractSummary,
  HttpMessageSummary,
  SitemapHost,
  SitemapPathNode,
} from '@cipherscope/proto';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Activity,
  CircleDot,
  Crosshair,
  ChevronDown,
  ChevronRight,
  Copy,
  Database,
  Eye,
  EyeOff,
  Folder,
  FolderOpen,
  Globe,
  ListChecks,
  Network,
  Pencil,
  RotateCcw,
  Search,
  Send,
  Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { saveContractSandboxPrefill, type ContractSandboxPrefill } from '@/lib/foundry-store';
import { SidebarZapScanner } from './SidebarZapScanner';

const TAB_ITEMS = [
  { id: 'sitemap', label: 'Sitemap', icon: Network },
  { id: 'contracts', label: 'Contracts', icon: Database },
  { id: 'events', label: 'Events', icon: Activity },
  { id: 'scanners', label: 'Scanners', icon: Search },
  { id: 'queue', label: 'Queue', icon: ListChecks },
];

const EVENTS_PAGE_SIZE = 1000;
const CONTRACTS_PAGE_SIZE = 500;
const SITEMAP_ROOT_CHUNK_SIZE = 200;
const LIVE_REFRESH_DEBOUNCE_MS = 250;
const LIVE_RECONNECT_DELAY_MS = 1500;
const defaultWsUrl = process.env.NEXT_PUBLIC_AGENT_WS_URL ?? 'ws://127.0.0.1:17400';

type FolderEventStats = {
  count: number;
  latestEventId: string | null;
};

const EMPTY_EVENTS: HttpMessageSummary[] = [];
const EMPTY_IDS: string[] = [];
const EMPTY_FOLDER_STATS: FolderEventStats = Object.freeze({ count: 0, latestEventId: null });

type MessageListResponse = { ok: true; items: HttpMessageSummary[] };
type ContractListResponse = { ok: true; items: ContractSummary[] };
type DecodedContractListResponse = { ok: true; items: ContractDecodedItem[] };

type ContractMethodTree = {
  key: string;
  label: string;
  selector: string | null;
  riskCount: number;
  transactions: ContractDecodedItem[];
};

type ContractTree = {
  key: string;
  label: string;
  subtitle: string | null;
  chainId: number | null;
  address: string | null;
  riskCount: number;
  txCount: number;
  methods: ContractMethodTree[];
};

type LeftNavPrefs = {
  hostNicknames: Record<string, string>;
  folderNicknames: Record<string, string>;
  eventNicknames: Record<string, string>;
  hiddenHostKeys: string[];
  hiddenFolderKeys: string[];
  hiddenEventIds: string[];
  sitemapHide404: boolean;
};

const LEFT_NAV_PREFS_KEY = 'left-nav-prefs-v1';

function eventsWsUrl(): string {
  return `${defaultWsUrl.replace(/\/$/, '')}/events`;
}

function isHttpMessageScheme(value: unknown): value is HttpMessageSummary['scheme'] {
  return value === 'http' || value === 'https' || value === 'connect' || value === 'ws' || value === 'wss';
}

function isHttpMessageState(value: unknown): value is HttpMessageSummary['state'] {
  return (
    value === 'captured' ||
    value === 'intercepted' ||
    value === 'forwarded' ||
    value === 'replayed' ||
    value === 'dropped' ||
    value === 'error' ||
    value === 'tunnel'
  );
}

function parseHttpMessageEvent(value: unknown): HttpMessageSummary | null {
  const rec = asRecord(value);
  if (!rec || rec.type !== 'http_message') return null;
  const message = asRecord(rec.message);
  if (!message) return null;
  if (
    typeof message.id !== 'string' ||
    typeof message.createdAt !== 'string' ||
    !isHttpMessageScheme(message.scheme) ||
    typeof message.host !== 'string' ||
    typeof message.port !== 'number' ||
    typeof message.method !== 'string' ||
    typeof message.path !== 'string' ||
    typeof message.url !== 'string' ||
    !isHttpMessageState(message.state)
  ) {
    return null;
  }
  return {
    id: message.id,
    parentId: typeof message.parentId === 'string' ? message.parentId : null,
    createdAt: message.createdAt,
    scheme: message.scheme,
    host: message.host,
    port: message.port,
    method: message.method,
    path: message.path,
    url: message.url,
    state: message.state,
    responseStatus: typeof message.responseStatus === 'number' ? message.responseStatus : null,
    totalMs: typeof message.totalMs === 'number' ? message.totalMs : null,
  };
}

function upsertEventItem(items: HttpMessageSummary[], item: HttpMessageSummary): HttpMessageSummary[] {
  const index = items.findIndex((entry) => entry.id === item.id);
  if (index < 0) return [item, ...items];
  const next = [...items];
  next[index] = item;
  return next;
}

export function LeftNav() {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState('sitemap');
  const [sitemapHosts, setSitemapHosts] = useState<SitemapHost[] | null>(null);
  const [sitemapLoading, setSitemapLoading] = useState(false);
  const [sitemapError, setSitemapError] = useState(false);
  const [events, setEvents] = useState<HttpMessageSummary[]>([]);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [eventsError, setEventsError] = useState(false);
  const [contracts, setContracts] = useState<ContractSummary[]>([]);
  const [decodedContracts, setDecodedContracts] = useState<ContractDecodedItem[]>([]);
  const [contractsLoading, setContractsLoading] = useState(false);
  const [contractsError, setContractsError] = useState(false);
  const [openHostKeys, setOpenHostKeys] = useState<Set<string>>(new Set());
  const [openPathKeys, setOpenPathKeys] = useState<Set<string>>(new Set());
  const [openContractKeys, setOpenContractKeys] = useState<Set<string>>(new Set());
  const [openMethodKeys, setOpenMethodKeys] = useState<Set<string>>(new Set());
  const [hostNicknames, setHostNicknames] = useState<Record<string, string>>({});
  const [folderNicknames, setFolderNicknames] = useState<Record<string, string>>({});
  const [eventNicknames, setEventNicknames] = useState<Record<string, string>>({});
  const [hiddenHostKeys, setHiddenHostKeys] = useState<string[]>([]);
  const [hiddenFolderKeys, setHiddenFolderKeys] = useState<string[]>([]);
  const [hiddenEventIds, setHiddenEventIds] = useState<string[]>([]);
  const [sitemapHide404, setSitemapHide404] = useState(false);

  const fetchSitemap = useCallback(async (options?: { silent?: boolean }) => {
    const silent = options?.silent === true;
    if (!silent) {
      setSitemapLoading(true);
      setSitemapError(false);
    }
    try {
      const qs = new URLSearchParams();
      if (sitemapHide404) qs.set('hide404', '1');
      const res = await fetch(`/api/sitemap${qs.size ? `?${qs}` : ''}`, { cache: 'no-store' });
      const data = await res.json();
      if (data?.ok && Array.isArray(data.hosts)) {
        setSitemapError(false);
        const keys: string[] = data.hosts.map((h: SitemapHost) => `${h.host}:${h.port}`);
        setSitemapHosts(data.hosts);
        setOpenHostKeys((prev) => {
          if (prev.size === 0) return new Set();
          return new Set(keys.filter((k: string) => prev.has(k)));
        });
      } else {
        setSitemapHosts([]);
        setSitemapError(true);
      }
    } catch {
      setSitemapHosts([]);
      setSitemapError(true);
    } finally {
      if (!silent) setSitemapLoading(false);
    }
  }, [sitemapHide404]);

  const fetchEvents = useCallback(async (options?: { silent?: boolean }) => {
    const silent = options?.silent === true;
    if (!silent) {
      setEventsLoading(true);
      setEventsError(false);
    }
    try {
      let offset = 0;
      const allItems: HttpMessageSummary[] = [];
      let done = false;
      let failed = false;

      while (!done) {
        const res = await fetch(`/api/messages?limit=${EVENTS_PAGE_SIZE}&offset=${offset}`, {
          cache: 'no-store',
        });
        const data = (await res.json()) as MessageListResponse | { ok: false };
        if (!('ok' in data) || !data.ok || !Array.isArray(data.items)) {
          setEvents([]);
          setEventsError(true);
          failed = true;
          done = true;
          continue;
        }

        allItems.push(...data.items);
        if (data.items.length < EVENTS_PAGE_SIZE) {
          done = true;
        } else {
          offset += EVENTS_PAGE_SIZE;
        }
      }

      if (!failed) {
        const webEvents = allItems.filter((m) => m.scheme === 'http' || m.scheme === 'https');
        setEvents(webEvents);
        setEventsError(false);
      }
    } catch {
      setEvents([]);
      setEventsError(true);
    } finally {
      if (!silent) setEventsLoading(false);
    }
  }, []);

  const refreshTree = useCallback(async (options?: { silent?: boolean }) => {
    await Promise.all([fetchSitemap(options), fetchEvents(options)]);
  }, [fetchSitemap, fetchEvents]);

  const fetchContracts = useCallback(async () => {
    setContractsLoading(true);
    setContractsError(false);
    try {
      const contractsRes = await fetch('/api/contracts', { cache: 'no-store' });
      const contractsJson = (await contractsRes.json().catch(() => null)) as
        | ContractListResponse
        | { ok: false }
        | null;
      if (!contractsRes.ok || !contractsJson || !('ok' in contractsJson) || !contractsJson.ok) {
        throw new Error('failed');
      }

      let offset = 0;
      let done = false;
      const decodedItems: ContractDecodedItem[] = [];

      while (!done) {
        const decodedRes = await fetch(
          `/api/contracts/decoded?limit=${CONTRACTS_PAGE_SIZE}&offset=${offset}`,
          { cache: 'no-store' },
        );
        const decodedJson = (await decodedRes.json().catch(() => null)) as
          | DecodedContractListResponse
          | { ok: false }
          | null;
        if (!decodedRes.ok || !decodedJson || !('ok' in decodedJson) || !decodedJson.ok) {
          throw new Error('failed');
        }
        decodedItems.push(...decodedJson.items);
        if (decodedJson.items.length < CONTRACTS_PAGE_SIZE) {
          done = true;
        } else {
          offset += CONTRACTS_PAGE_SIZE;
        }
      }

      setContracts(contractsJson.items);
      setDecodedContracts(decodedItems);
    } catch {
      setContracts([]);
      setDecodedContracts([]);
      setContractsError(true);
    } finally {
      setContractsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeTab === 'sitemap' || activeTab === 'events') {
      void refreshTree();
    }
    if (activeTab === 'contracts') {
      void fetchContracts();
    }
  }, [activeTab, fetchContracts, refreshTree]);

  useEffect(() => {
    let cancelled = false;
    let ws: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let sitemapRefreshTimer: number | null = null;

    const clearTimers = () => {
      if (reconnectTimer != null) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (sitemapRefreshTimer != null) {
        window.clearTimeout(sitemapRefreshTimer);
        sitemapRefreshTimer = null;
      }
    };

    const scheduleSitemapRefresh = () => {
      if (cancelled) return;
      if (sitemapRefreshTimer != null) window.clearTimeout(sitemapRefreshTimer);
      sitemapRefreshTimer = window.setTimeout(() => {
        sitemapRefreshTimer = null;
        void fetchSitemap({ silent: true });
      }, LIVE_REFRESH_DEBOUNCE_MS);
    };

    const connect = () => {
      if (cancelled) return;
      ws = new WebSocket(eventsWsUrl());
      ws.addEventListener('open', () => {
        void refreshTree({ silent: true });
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
        const message = parseHttpMessageEvent(parsed);
        if (!message) return;
        if (message.scheme === 'http' || message.scheme === 'https') {
          setEvents((prev) => upsertEventItem(prev, message));
          setEventsError(false);
        }
        scheduleSitemapRefresh();
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
  }, [fetchSitemap, refreshTree]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(LEFT_NAV_PREFS_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<LeftNavPrefs>;
      setHostNicknames(parsed.hostNicknames ?? {});
      setFolderNicknames(parsed.folderNicknames ?? {});
      setEventNicknames(parsed.eventNicknames ?? {});
      setHiddenHostKeys(Array.isArray(parsed.hiddenHostKeys) ? parsed.hiddenHostKeys : []);
      setHiddenFolderKeys(Array.isArray(parsed.hiddenFolderKeys) ? parsed.hiddenFolderKeys : []);
      setHiddenEventIds(Array.isArray(parsed.hiddenEventIds) ? parsed.hiddenEventIds : []);
      setSitemapHide404(parsed.sitemapHide404 === true);
    } catch {
      // no-op in sidebar
    }
  }, []);

  useEffect(() => {
    const prefs: LeftNavPrefs = {
      hostNicknames,
      folderNicknames,
      eventNicknames,
      hiddenHostKeys,
      hiddenFolderKeys,
      hiddenEventIds,
      sitemapHide404,
    };
    try {
      window.localStorage.setItem(LEFT_NAV_PREFS_KEY, JSON.stringify(prefs));
    } catch {
      // no-op in sidebar
    }
  }, [eventNicknames, folderNicknames, hiddenEventIds, hiddenFolderKeys, hiddenHostKeys, hostNicknames, sitemapHide404]);

  const hiddenHostSet = useMemo(() => new Set(hiddenHostKeys), [hiddenHostKeys]);
  const hiddenFolderSet = useMemo(() => new Set(hiddenFolderKeys), [hiddenFolderKeys]);
  const hiddenEventSet = useMemo(() => new Set(hiddenEventIds), [hiddenEventIds]);

  const {
    eventsById,
    eventsByHost,
    hostEventIdsByHost,
    latestHostEventIdByHost,
    visibleEventsByHostPath,
    folderStatsByFolder,
  } = useMemo(() => {
    const byId = new Map<string, HttpMessageSummary>();
    const byHost = new Map<string, HttpMessageSummary[]>();
    const idsByHost = new Map<string, string[]>();
    const latestIdByHost = new Map<string, string>();
    const latestCreatedAtByHost = new Map<string, string>();
    const byVisibleHostPath = new Map<string, HttpMessageSummary[]>();
    const statsByFolder = new Map<string, FolderEventStats>();
    const latestCreatedAtByFolder = new Map<string, string>();

    for (const event of events) {
      byId.set(event.id, event);

      const hostKey = `${event.host}:${event.port}`;
      const hostEvents = byHost.get(hostKey);
      if (hostEvents) hostEvents.push(event);
      else byHost.set(hostKey, [event]);

      const hostIds = idsByHost.get(hostKey);
      if (hostIds) hostIds.push(event.id);
      else idsByHost.set(hostKey, [event.id]);

      const hostLatestCreatedAt = latestCreatedAtByHost.get(hostKey);
      if (!hostLatestCreatedAt || event.createdAt > hostLatestCreatedAt) {
        latestCreatedAtByHost.set(hostKey, event.createdAt);
        latestIdByHost.set(hostKey, event.id);
      }

      const normalizedPath = normalizePath(event.path);
      const eventKey = `${hostKey}|${normalizedPath}`;
      if (!hiddenEventSet.has(event.id)) {
        const arr = byVisibleHostPath.get(eventKey);
        if (arr) arr.push(event);
        else byVisibleHostPath.set(eventKey, [event]);
      }

      const folderPaths = getFolderPaths(normalizedPath);
      for (const folderPath of folderPaths) {
        const folderKey = buildFolderKey(event.host, event.port, folderPath);
        const stats = statsByFolder.get(folderKey);
        if (stats) {
          stats.count += 1;
        } else {
          statsByFolder.set(folderKey, { count: 1, latestEventId: null });
        }
        const latestFolderCreatedAt = latestCreatedAtByFolder.get(folderKey);
        if (!latestFolderCreatedAt || event.createdAt > latestFolderCreatedAt) {
          latestCreatedAtByFolder.set(folderKey, event.createdAt);
          const current = statsByFolder.get(folderKey);
          if (current) current.latestEventId = event.id;
        }
      }
    }

    return {
      eventsById: byId,
      eventsByHost: byHost,
      hostEventIdsByHost: idsByHost,
      latestHostEventIdByHost: latestIdByHost,
      visibleEventsByHostPath: byVisibleHostPath,
      folderStatsByFolder: statsByFolder,
    };
  }, [events, hiddenEventSet]);

  const contractTree = useMemo(() => {
    type ContractMethodBuilder = {
      key: string;
      label: string;
      selector: string | null;
      riskCount: number;
      transactions: ContractDecodedItem[];
    };

    type ContractBuilder = {
      key: string;
      label: string;
      subtitle: string | null;
      chainId: number | null;
      address: string | null;
      riskCount: number;
      txCount: number;
      methods: Map<string, ContractMethodBuilder>;
    };

    const contractById = new Map(contracts.map((entry) => [entry.id, entry]));
    const grouped = new Map<string, ContractBuilder>();

    for (const item of decodedContracts) {
      if (item.kind !== 'transaction') continue;

      const resolvedContract = item.contractId ? contractById.get(item.contractId) : undefined;
      const resolvedAddress = resolvedContract?.address ?? item.to ?? null;
      const resolvedChainId = resolvedContract?.chainId ?? item.chainId ?? null;
      const contractKey =
        resolvedContract?.id ?
          `id:${resolvedContract.id}`
        : resolvedAddress ?
          `address:${resolvedAddress.toLowerCase()}`
        : item.contractName ?
          `name:${item.contractName.toLowerCase()}`
        : 'unknown';
      const contractLabel = resolvedContract?.name ?? item.contractName ?? resolvedAddress ?? 'Unknown Contract';
      const subtitle = makeContractSubtitle(contractLabel, resolvedChainId, resolvedAddress);

      let contractNode = grouped.get(contractKey);
      if (!contractNode) {
        contractNode = {
          key: contractKey,
          label: contractLabel,
          subtitle,
          chainId: resolvedChainId,
          address: resolvedAddress,
          riskCount: 0,
          txCount: 0,
          methods: new Map<string, ContractMethodBuilder>(),
        };
        grouped.set(contractKey, contractNode);
      }

      contractNode.txCount += 1;
      contractNode.riskCount += item.risks.length;

      const methodIdentity = methodIdentityKey(item);
      let methodNode = contractNode.methods.get(methodIdentity);
      if (!methodNode) {
        methodNode = {
          key: `${contractKey}|${methodIdentity}`,
          label: methodDisplayLabel(item),
          selector: item.selector ?? null,
          riskCount: 0,
          transactions: [],
        };
        contractNode.methods.set(methodIdentity, methodNode);
      }

      methodNode.transactions.push(item);
      methodNode.riskCount += item.risks.length;
    }

    for (const contract of contracts) {
      const key = `id:${contract.id}`;
      if (grouped.has(key)) continue;
      grouped.set(key, {
        key,
        label: contract.name,
        subtitle: makeContractSubtitle(contract.name, contract.chainId, contract.address),
        chainId: contract.chainId ?? null,
        address: contract.address ?? null,
        riskCount: 0,
        txCount: 0,
        methods: new Map(),
      });
    }

    const tree = [...grouped.values()].map(
      (contract): ContractTree => ({
        key: contract.key,
        label: contract.label,
        subtitle: contract.subtitle,
        chainId: contract.chainId,
        address: contract.address,
        riskCount: contract.riskCount,
        txCount: contract.txCount,
        methods: [...contract.methods.values()]
          .map(
            (method): ContractMethodTree => ({
              key: method.key,
              label: method.label,
              selector: method.selector,
              riskCount: method.riskCount,
              transactions: [...method.transactions].sort((a, b) =>
                b.createdAt.localeCompare(a.createdAt),
              ),
            }),
          )
          .sort(
            (a, b) =>
              b.transactions.length - a.transactions.length || a.label.localeCompare(b.label),
          ),
      }),
    );

    tree.sort((a, b) => b.txCount - a.txCount || a.label.localeCompare(b.label));
    return tree;
  }, [contracts, decodedContracts]);

  useEffect(() => {
    const keys = contractTree.map((contract) => contract.key);
    setOpenContractKeys((prev) => {
      if (prev.size === 0) return new Set(keys);
      return new Set(keys.filter((key) => prev.has(key)));
    });
  }, [contractTree]);

  useEffect(() => {
    const methodKeys = contractTree.flatMap((contract) => contract.methods.map((method) => method.key));
    setOpenMethodKeys((prev) => new Set(methodKeys.filter((key) => prev.has(key))));
  }, [contractTree]);

  const toggleHost = useCallback((key: string) => {
    setOpenHostKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const togglePath = useCallback((pathKey: string) => {
    setOpenPathKeys((prev) => {
      const next = new Set(prev);
      if (next.has(pathKey)) next.delete(pathKey);
      else next.add(pathKey);
      return next;
    });
  }, []);

  const toggleContract = useCallback((key: string) => {
    setOpenContractKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const toggleMethod = useCallback((key: string) => {
    setOpenMethodKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const setNickname = useCallback(
    (
      label: string,
      currentNickname: string | undefined,
      apply: (updater: (prev: Record<string, string>) => Record<string, string>) => void,
      key: string,
    ) => {
      const value = window.prompt(`Set nickname for ${label} (leave empty to clear)`, currentNickname ?? '');
      if (value == null) return;
      const trimmed = value.trim();
      apply((prev) => {
        const next = { ...prev };
        if (trimmed) next[key] = trimmed;
        else delete next[key];
        return next;
      });
    },
    [],
  );

  const hideHost = useCallback((hostKey: string) => {
    setHiddenHostKeys((prev) => (prev.includes(hostKey) ? prev : [...prev, hostKey]));
  }, []);

  const unhideHost = useCallback((hostKey: string) => {
    setHiddenHostKeys((prev) => prev.filter((key) => key !== hostKey));
  }, []);

  const hideFolder = useCallback((folderKey: string) => {
    setHiddenFolderKeys((prev) => (prev.includes(folderKey) ? prev : [...prev, folderKey]));
  }, []);

  const unhideFolder = useCallback((folderKey: string) => {
    setHiddenFolderKeys((prev) => prev.filter((key) => key !== folderKey));
  }, []);

  const hideEvent = useCallback((eventId: string) => {
    setHiddenEventIds((prev) => (prev.includes(eventId) ? prev : [...prev, eventId]));
  }, []);

  const unhideEvent = useCallback((eventId: string) => {
    setHiddenEventIds((prev) => prev.filter((id) => id !== eventId));
  }, []);

  const openInRepeater = useCallback(
    (messageId: string) => {
      router.push(`/repeater?open=${encodeURIComponent(messageId)}`);
    },
    [router],
  );

  const openInIntruder = useCallback(
    (messageId: string) => {
      router.push(`/intruder?open=${encodeURIComponent(messageId)}`);
    },
    [router],
  );

  const openInAnalyzer = useCallback(
    (messageId: string) => {
      router.push(`/audit?messageId=${encodeURIComponent(messageId)}`);
    },
    [router],
  );

  const deleteManyEvents = useCallback(
    async (ids: string[]) => {
      const uniqueIds = [...new Set(ids)];
      if (uniqueIds.length === 0) return;
      await Promise.allSettled(
        uniqueIds.map((id) =>
          fetch(`/api/messages/${encodeURIComponent(id)}`, {
            method: 'DELETE',
          }),
        ),
      );
      setHiddenEventIds((prev) => prev.filter((id) => !uniqueIds.includes(id)));
      await refreshTree();
      router.refresh();
    },
    [refreshTree, router],
  );

  const getFolderEventIdsForDelete = useCallback(
    (host: string, port: number, path: string): string[] => {
      const hostKey = `${host}:${port}`;
      const hostEvents = eventsByHost.get(hostKey) ?? EMPTY_EVENTS;
      const normalizedPath = normalizePath(path);
      const out: string[] = [];
      for (const event of hostEvents) {
        if (pathIncludes(normalizePath(event.path), normalizedPath)) out.push(event.id);
      }
      return out;
    },
    [eventsByHost],
  );

  const visibleSitemapHosts = useMemo(
    () => (sitemapHosts ?? []).filter((host) => !hiddenHostSet.has(`${host.host}:${host.port}`)),
    [hiddenHostSet, sitemapHosts],
  );

  const visibleEvents = useMemo(() => events.filter((event) => !hiddenEventSet.has(event.id)), [events, hiddenEventSet]);

  const hiddenHostItems = useMemo(
    () =>
      hiddenHostKeys.map((key) => {
        const host = (sitemapHosts ?? []).find((entry) => `${entry.host}:${entry.port}` === key);
        const label = hostNicknames[key] ?? host?.displayLabel ?? key;
        return { key, label, detail: host ? `${host.requests} requests` : key };
      }),
    [hiddenHostKeys, hostNicknames, sitemapHosts],
  );

  const hiddenFolderItems = useMemo(
    () =>
      hiddenFolderKeys.map((key) => {
        const parsed = parseFolderKey(key);
        const label = folderNicknames[key] ?? parsed.path;
        return { key, label, detail: parsed.hostPort };
      }),
    [folderNicknames, hiddenFolderKeys],
  );

  const hiddenEventItems = useMemo(
    () =>
      hiddenEventIds.map((id) => {
        const event = eventsById.get(id);
        const label =
          eventNicknames[id] ??
          (event ? `${event.method} ${event.path}` : `Event ${id.slice(0, 8)}`);
        const detail = event ? `${event.host}:${event.port}` : 'Event unavailable';
        return { id, label, detail };
      }),
    [eventNicknames, eventsById, hiddenEventIds],
  );

  const handleDelete = useCallback(
    async (id: string) => {
      const res = await fetch(`/api/messages/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!res.ok) return;
      setHiddenEventIds((prev) => prev.filter((eventId) => eventId !== id));
      await refreshTree();
      router.refresh();
    },
    [refreshTree, router],
  );

  const handleSendToSandbox = useCallback(
    (item: ContractDecodedItem) => {
      const prefill = buildDecodedSandboxPrefill(item);
      if (!prefill) return;
      try {
        saveContractSandboxPrefill(prefill);
        router.push('/');
      } catch {
        // no-op in sidebar
      }
    },
    [router],
  );

  const scannerSuggestedTarget = useMemo(() => {
    const firstHost = (sitemapHosts ?? [])[0];
    if (!firstHost) return null;
    const protocol = firstHost.port === 443 ? 'https' : 'http';
    const includePort =
      (protocol === 'http' && firstHost.port !== 80) ||
      (protocol === 'https' && firstHost.port !== 443);
    return `${protocol}://${firstHost.host}${includePort ? `:${firstHost.port}` : ''}`;
  }, [sitemapHosts]);

  return (
    <aside className="flex h-full min-h-0 w-full flex-col border-y border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] xl:border-y-0 xl:border-r">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex-shrink-0 border-b border-[color:var(--cs-border)] px-2 pt-1.5">
          <div className="flex gap-1 overflow-x-auto pb-1.5 scrollbar-hide">
            {TAB_ITEMS.map((item) => {
              const Icon = item.icon;
              const isActive = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setActiveTab(item.id)}
                  className={[
                    'inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[12px] font-medium transition-all whitespace-nowrap',
                    isActive
                      ? 'bg-[color:var(--cs-accent)] text-white shadow-sm'
                      : 'text-[color:var(--cs-muted)] hover:bg-[color:var(--cs-hover)] hover:text-[color:var(--cs-fg)]',
                  ].join(' ')}
                >
                  <Icon className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{item.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-2 py-3 scrollbar-hide">
          {activeTab === 'sitemap' && (
            <>
              <div className="mb-2 px-1">
                <label className="inline-flex cursor-pointer items-center gap-2 text-[11px] text-[color:var(--cs-muted)]">
                  <input
                    type="checkbox"
                    checked={sitemapHide404}
                    onChange={(e) => setSitemapHide404(e.target.checked)}
                    className="h-3.5 w-3.5"
                  />
                  Hide 404s 
                </label>
              </div>
              {(sitemapLoading || eventsLoading) && (
                <div className="py-4 text-center text-[12px] text-[color:var(--cs-muted)]">Loading…</div>
              )}
              {!sitemapLoading && !eventsLoading && (sitemapError || eventsError) && (
                <div className="py-4 text-center text-[12px] text-[color:var(--cs-muted)]">
                  Agent unreachable.
                </div>
              )}
              {!sitemapLoading &&
              !eventsLoading &&
              !sitemapError &&
              !eventsError &&
              (sitemapHosts?.length ?? 0) === 0 ? (
                <div className="py-4 text-center text-[12px] text-[color:var(--cs-muted)]">
                  No traffic yet. Use the proxy to capture requests.
                </div>
              ) : null}
              {!sitemapLoading &&
              !eventsLoading &&
              !sitemapError &&
              !eventsError &&
              (sitemapHosts?.length ?? 0) > 0 &&
              visibleSitemapHosts.length === 0 ? (
                <div className="py-2 text-center text-[12px] text-[color:var(--cs-muted)]">
                  All hosts are hidden.
                </div>
              ) : null}
              {!sitemapLoading && !eventsLoading && !sitemapError && !eventsError && visibleSitemapHosts.length > 0 && (
                <>
                  {visibleSitemapHosts.map((h) => {
                    const key = `${h.host}:${h.port}`;
                    const isOpen = openHostKeys.has(key);
                    const hostEventIds = hostEventIdsByHost.get(key) ?? EMPTY_IDS;
                    const latestHostEventId = latestHostEventIdByHost.get(key) ?? null;
                    return (
                      <div key={key}>
                        <SiteRow
                          host={hostNicknames[key] ?? h.displayLabel}
                          subtitle={hostNicknames[key] ? h.displayLabel : null}
                          requests={String(h.requests)}
                          alerts={h.alerts > 0 ? String(h.alerts) : undefined}
                          open={isOpen}
                          onToggle={() => toggleHost(key)}
                          onNickname={() => setNickname(h.displayLabel, hostNicknames[key], setHostNicknames, key)}
                          onHide={() => hideHost(key)}
                          onSendToRepeater={
                            latestHostEventId ? () => openInRepeater(latestHostEventId) : undefined
                          }
                          onSendToIntruder={
                            latestHostEventId ? () => openInIntruder(latestHostEventId) : undefined
                          }
                          onAnalyze={
                            latestHostEventId ? () => openInAnalyzer(latestHostEventId) : undefined
                          }
                          onDelete={
                            hostEventIds.length > 0 ?
                              () => {
                                if (
                                  !window.confirm(`Delete ${hostEventIds.length} events for ${h.displayLabel}?`)
                                ) {
                                  return;
                                }
                                void deleteManyEvents(hostEventIds);
                              }
                            : undefined
                          }
                        />
                        {isOpen && h.pathTree.length > 0 && (
                          <div className="ml-4 border-l border-[color:var(--cs-border)]">
                            <HostPathTree
                              host={h.host}
                              port={h.port}
                              pathTree={h.pathTree}
                              pathKeyPrefix={`${key}|`}
                              openPathKeys={openPathKeys}
                              onTogglePath={togglePath}
                              visibleEventsByHostPath={visibleEventsByHostPath}
                              folderStatsByFolder={folderStatsByFolder}
                              onDeleteEvent={handleDelete}
                              eventNicknames={eventNicknames}
                              folderNicknames={folderNicknames}
                              hiddenFolderSet={hiddenFolderSet}
                              onNicknameEvent={(eventId, label) =>
                                setNickname(label, eventNicknames[eventId], setEventNicknames, eventId)
                              }
                              onNicknameFolder={(folderKey, label) =>
                                setNickname(label, folderNicknames[folderKey], setFolderNicknames, folderKey)
                              }
                              onHideEvent={hideEvent}
                              onHideFolder={hideFolder}
                              onOpenRepeater={openInRepeater}
                              onOpenIntruder={openInIntruder}
                              onAnalyzeEvent={openInAnalyzer}
                              onDeleteManyEvents={deleteManyEvents}
                              getFolderEventIdsForDelete={getFolderEventIdsForDelete}
                            />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </>
              )}
              {!sitemapLoading && !eventsLoading && !sitemapError && !eventsError && (
                <HiddenSection
                  hosts={hiddenHostItems}
                  folders={hiddenFolderItems}
                  events={hiddenEventItems}
                  onUnhideHost={unhideHost}
                  onUnhideFolder={unhideFolder}
                  onUnhideEvent={unhideEvent}
                />
              )}
            </>
          )}
          {activeTab === 'contracts' && (
            <>
              {contractsLoading && (
                <div className="py-4 text-center text-[12px] text-[color:var(--cs-muted)]">Loading…</div>
              )}
              {!contractsLoading && contractsError && (
                <div className="py-4 text-center text-[12px] text-[color:var(--cs-muted)]">
                  Agent unreachable.
                </div>
              )}
              {!contractsLoading && !contractsError && contractTree.length === 0 && (
                <div className="py-4 text-center text-[12px] text-[color:var(--cs-muted)]">
                  No contracts or decoded transactions yet.
                </div>
              )}
              {!contractsLoading && !contractsError && contractTree.length > 0 && (
                <>
                  {contractTree.map((contract) => {
                    const isContractOpen = openContractKeys.has(contract.key);
                    return (
                      <div key={contract.key}>
                        <ContractRow
                          label={contract.label}
                          subtitle={contract.subtitle}
                          txCount={String(contract.txCount)}
                          methodCount={String(contract.methods.length)}
                          alerts={contract.riskCount > 0 ? String(contract.riskCount) : undefined}
                          open={isContractOpen}
                          onToggle={() => toggleContract(contract.key)}
                        />
                        {isContractOpen && (
                          <div className="ml-4 border-l border-[color:var(--cs-border)]">
                            {contract.methods.length === 0 ? (
                              <div className="px-2 py-1 text-[11px] text-[color:var(--cs-muted)]">
                                No transaction runs for this contract.
                              </div>
                            ) : (
                              contract.methods.map((method) => {
                                const isMethodOpen = openMethodKeys.has(method.key);
                                return (
                                  <div key={method.key}>
                                    <TreeRow
                                      depth={1}
                                      label={method.label}
                                      requests={String(method.transactions.length)}
                                      alerts={method.riskCount > 0 ? String(method.riskCount) : undefined}
                                      isExpandable={method.transactions.length > 0}
                                      isOpen={isMethodOpen}
                                      onToggle={() => toggleMethod(method.key)}
                                    />
                                    {isMethodOpen
                                      ? method.transactions.map((item) => (
                                          <ContractTransactionRow
                                            key={item.id}
                                            item={item}
                                            depth={2}
                                            onSendToSandbox={handleSendToSandbox}
                                          />
                                        ))
                                      : null}
                                  </div>
                                );
                              })
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </>
              )}
            </>
          )}
          {activeTab === 'events' && (
            <div className="flex flex-col gap-1">
              {visibleEvents.map((event) => (
                <EventRow
                  key={event.id}
                  event={event}
                  nickname={eventNicknames[event.id]}
                  onDeleteEvent={handleDelete}
                  onNicknameEvent={(eventId, label) =>
                    setNickname(label, eventNicknames[eventId], setEventNicknames, eventId)
                  }
                  onHideEvent={hideEvent}
                  onOpenRepeater={openInRepeater}
                  onOpenIntruder={openInIntruder}
                  onAnalyzeEvent={openInAnalyzer}
                />
              ))}
              {!eventsLoading && visibleEvents.length === 0 ? (
                <div className="py-4 text-center text-[12px] text-[color:var(--cs-muted)]">No web events yet.</div>
              ) : null}
              <HiddenSection
                hosts={[]}
                folders={[]}
                events={hiddenEventItems}
                onUnhideHost={unhideHost}
                onUnhideFolder={unhideFolder}
                onUnhideEvent={unhideEvent}
              />
            </div>
          )}
          {activeTab === 'scanners' && (
            <SidebarZapScanner suggestedTarget={scannerSuggestedTarget} />
          )}
          {activeTab === 'queue' && (
            <div className="p-4 text-center text-[color:var(--cs-muted)]">
              No data available in this view.
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}

function ContractRow(props: {
  label: string;
  subtitle: string | null;
  txCount: string;
  methodCount: string;
  alerts?: string;
  open?: boolean;
  onToggle?: () => void;
}) {
  return (
    <div className="mt-1 min-w-0">
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          props.onToggle?.();
        }}
        className="flex w-full cursor-pointer items-center gap-1.5 rounded-md px-1 py-1 hover:bg-[color:var(--cs-hover)] min-w-0 text-left"
      >
        <span className="flex-shrink-0 text-[color:var(--cs-muted)]">
          {props.open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </span>
        <span className="inline-flex min-w-0 flex-1 items-center gap-1.5 truncate text-[13px] font-semibold text-[color:var(--cs-fg)]">
          <Database className="h-3.5 w-3.5 shrink-0 text-[color:var(--cs-accent)]" />
          <span className="truncate">{props.label}</span>
        </span>
        <span
          className="flex-shrink-0 rounded border border-[color:var(--cs-border)] px-1.5 py-0 text-[10px] text-[color:var(--cs-muted)]"
          title="Method count"
        >
          {props.methodCount} m
        </span>
        <span className="flex-shrink-0 text-[11px] text-[color:var(--cs-muted)] whitespace-nowrap">
          {props.txCount}
        </span>
        {props.alerts ? (
          <span className="flex-shrink-0 rounded bg-rose-100 px-1.5 py-0 text-[10px] font-bold text-rose-700 whitespace-nowrap">
            {props.alerts}
          </span>
        ) : null}
      </button>
      {props.subtitle ? (
        <div className="pl-7 text-[10px] text-[color:var(--cs-muted)] truncate">{props.subtitle}</div>
      ) : null}
    </div>
  );
}

function SiteRow(props: {
  host: string;
  subtitle: string | null;
  requests: string;
  alerts?: string;
  open?: boolean;
  onToggle?: () => void;
  onNickname?: () => void;
  onHide?: () => void;
  onDelete?: () => void;
  onSendToRepeater?: () => void;
  onSendToIntruder?: () => void;
  onAnalyze?: () => void;
}) {
  const button = (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        props.onToggle?.();
      }}
      className="flex w-full cursor-pointer items-center gap-1.5 rounded-md px-1 py-1 hover:bg-[color:var(--cs-hover)] min-w-0 text-left"
    >
      <span className="flex-shrink-0 text-[color:var(--cs-muted)]">
        {props.open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
      </span>
      <span className="inline-flex min-w-0 flex-1 items-center gap-1.5 truncate text-[13px] font-semibold text-[color:var(--cs-fg)]">
        <Network className="h-3.5 w-3.5 shrink-0 text-[color:var(--cs-accent)]" />
        <span className="truncate">{props.host}</span>
      </span>
      <span className="flex-shrink-0 text-[11px] text-[color:var(--cs-muted)] whitespace-nowrap">{props.requests}</span>
      {props.alerts ? (
        <span className="flex-shrink-0 rounded bg-rose-100 px-1.5 py-0 text-[10px] font-bold text-rose-700 whitespace-nowrap">
          {props.alerts}
        </span>
      ) : null}
    </button>
  );

  return (
    <div className="mt-1 min-w-0">
      <ContextMenu>
        <ContextMenuTrigger asChild>{button}</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={props.onNickname}>
            <Pencil className="h-3.5 w-3.5" />
            Set Nickname
          </ContextMenuItem>
          <ContextMenuItem onClick={props.onSendToRepeater} disabled={!props.onSendToRepeater}>
            <RotateCcw className="h-3.5 w-3.5" />
            Send Latest to Repeater
          </ContextMenuItem>
          <ContextMenuItem onClick={props.onSendToIntruder} disabled={!props.onSendToIntruder}>
            <Crosshair className="h-3.5 w-3.5" />
            Send Latest to Intruder
          </ContextMenuItem>
          <ContextMenuItem onClick={props.onAnalyze} disabled={!props.onAnalyze}>
            <Search className="h-3.5 w-3.5" />
            Analyze Latest
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={props.onHide}>
            <EyeOff className="h-3.5 w-3.5" />
            Hide Host
          </ContextMenuItem>
          <ContextMenuItem variant="destructive" onClick={props.onDelete} disabled={!props.onDelete}>
            <Trash2 className="h-3.5 w-3.5" />
            Delete Host Events
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {props.subtitle ? (
        <div className="pl-7 text-[10px] text-[color:var(--cs-muted)] truncate">{props.subtitle}</div>
      ) : null}
    </div>
  );
}

function ChunkLoadMoreRow(props: {
  depth: number;
  shown: number;
  total: number;
  label: string;
  onLoadMore: () => void;
}) {
  if (props.shown >= props.total) return null;
  return (
    <div style={{ paddingLeft: `${props.depth * 12}px` }} className="mt-0.5">
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          props.onLoadMore();
        }}
        className="w-full rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 py-1 text-left text-[11px] text-[color:var(--cs-muted)] hover:bg-[color:var(--cs-hover)]"
      >
        Show more {props.label} ({props.shown}/{props.total})
      </button>
    </div>
  );
}

function HostPathTree({
  host,
  port,
  pathTree,
  pathKeyPrefix,
  openPathKeys,
  onTogglePath,
  visibleEventsByHostPath,
  folderStatsByFolder,
  onDeleteEvent,
  eventNicknames,
  folderNicknames,
  hiddenFolderSet,
  onNicknameEvent,
  onNicknameFolder,
  onHideEvent,
  onHideFolder,
  onOpenRepeater,
  onOpenIntruder,
  onAnalyzeEvent,
  onDeleteManyEvents,
  getFolderEventIdsForDelete,
}: {
  host: string;
  port: number;
  pathTree: SitemapPathNode[];
  pathKeyPrefix: string;
  openPathKeys: Set<string>;
  onTogglePath: (pathKey: string) => void;
  visibleEventsByHostPath: Map<string, HttpMessageSummary[]>;
  folderStatsByFolder: Map<string, FolderEventStats>;
  onDeleteEvent: (id: string) => Promise<void>;
  eventNicknames: Record<string, string>;
  folderNicknames: Record<string, string>;
  hiddenFolderSet: Set<string>;
  onNicknameEvent: (eventId: string, label: string) => void;
  onNicknameFolder: (folderKey: string, label: string) => void;
  onHideEvent: (eventId: string) => void;
  onHideFolder: (folderKey: string) => void;
  onOpenRepeater: (eventId: string) => void;
  onOpenIntruder: (eventId: string) => void;
  onAnalyzeEvent: (eventId: string) => void;
  onDeleteManyEvents: (eventIds: string[]) => Promise<void>;
  getFolderEventIdsForDelete: (host: string, port: number, path: string) => string[];
}) {
  const visibleRootNodes = useMemo(
    () =>
      pathTree.filter((node) => {
        const path = normalizePath(node.segment ? `/${node.segment}` : '/');
        return !hiddenFolderSet.has(buildFolderKey(host, port, path));
      }),
    [host, port, pathTree, hiddenFolderSet],
  );

  const [visibleRootCount, setVisibleRootCount] = useState(SITEMAP_ROOT_CHUNK_SIZE);

  const rootCount = Math.min(visibleRootCount, visibleRootNodes.length);
  const rootNodes = visibleRootNodes.slice(0, rootCount);

  return (
    <>
      {rootNodes.map((node, i) => (
        <PathTreeNodes
          key={`${pathKeyPrefix}${i}-${node.segment}`}
          host={host}
          port={port}
          node={node}
          depth={1}
          currentPath=""
          pathKeyPrefix={pathKeyPrefix}
          openPathKeys={openPathKeys}
          onTogglePath={onTogglePath}
          visibleEventsByHostPath={visibleEventsByHostPath}
          folderStatsByFolder={folderStatsByFolder}
          onDeleteEvent={onDeleteEvent}
          eventNicknames={eventNicknames}
          folderNicknames={folderNicknames}
          hiddenFolderSet={hiddenFolderSet}
          onNicknameEvent={onNicknameEvent}
          onNicknameFolder={onNicknameFolder}
          onHideEvent={onHideEvent}
          onHideFolder={onHideFolder}
          onOpenRepeater={onOpenRepeater}
          onOpenIntruder={onOpenIntruder}
          onAnalyzeEvent={onAnalyzeEvent}
          onDeleteManyEvents={onDeleteManyEvents}
          getFolderEventIdsForDelete={getFolderEventIdsForDelete}
        />
      ))}
      <ChunkLoadMoreRow
        depth={1}
        shown={rootCount}
        total={visibleRootNodes.length}
        label="folders"
        onLoadMore={() =>
          setVisibleRootCount((prev) => Math.min(prev + SITEMAP_ROOT_CHUNK_SIZE, visibleRootNodes.length))
        }
      />
    </>
  );
}

function PathTreeNodes({
  host,
  port,
  node,
  depth,
  currentPath,
  pathKeyPrefix,
  openPathKeys,
  onTogglePath,
  visibleEventsByHostPath,
  folderStatsByFolder,
  onDeleteEvent,
  eventNicknames,
  folderNicknames,
  hiddenFolderSet,
  onNicknameEvent,
  onNicknameFolder,
  onHideEvent,
  onHideFolder,
  onOpenRepeater,
  onOpenIntruder,
  onAnalyzeEvent,
  onDeleteManyEvents,
  getFolderEventIdsForDelete,
}: {
  host: string;
  port: number;
  node: SitemapPathNode;
  depth: number;
  currentPath: string;
  pathKeyPrefix: string;
  openPathKeys: Set<string>;
  onTogglePath: (pathKey: string) => void;
  visibleEventsByHostPath: Map<string, HttpMessageSummary[]>;
  folderStatsByFolder: Map<string, FolderEventStats>;
  onDeleteEvent: (id: string) => Promise<void>;
  eventNicknames: Record<string, string>;
  folderNicknames: Record<string, string>;
  hiddenFolderSet: Set<string>;
  onNicknameEvent: (eventId: string, label: string) => void;
  onNicknameFolder: (folderKey: string, label: string) => void;
  onHideEvent: (eventId: string) => void;
  onHideFolder: (folderKey: string) => void;
  onOpenRepeater: (eventId: string) => void;
  onOpenIntruder: (eventId: string) => void;
  onAnalyzeEvent: (eventId: string) => void;
  onDeleteManyEvents: (eventIds: string[]) => Promise<void>;
  getFolderEventIdsForDelete: (host: string, port: number, path: string) => string[];
}) {
  const segment = node.segment === '' ? '' : node.segment;
  const absolutePath = normalizePath(segment ? `${currentPath}/${segment}`.replace(/\/+/g, '/') : '/');
  const pathKey = pathKeyPrefix + node.segment;
  const folderKey = buildFolderKey(host, port, absolutePath);
  if (hiddenFolderSet.has(folderKey)) return null;

  const visibleChildren = node.children.filter((child) => {
    const childPath = normalizePath(
      child.segment ? `${absolutePath}/${child.segment}`.replace(/\/+/g, '/') : absolutePath,
    );
    return !hiddenFolderSet.has(buildFolderKey(host, port, childPath));
  });
  const hasChildren = visibleChildren.length > 0;
  const label = node.segment === '' ? '/' : node.segment;
  const folderLabel = folderNicknames[folderKey] ?? label;

  const eventKey = `${host}:${port}|${normalizePath(absolutePath)}`;
  const pathEvents = visibleEventsByHostPath.get(eventKey) ?? EMPTY_EVENTS;
  const folderStats = folderStatsByFolder.get(folderKey) ?? EMPTY_FOLDER_STATS;
  const canExpand = hasChildren || pathEvents.length > 0;
  const isOpen = openPathKeys.has(pathKey);
  const latestFolderEventId = folderStats.latestEventId;

  return (
    <>
      <TreeRow
        depth={depth}
        label={folderLabel}
        subtitle={folderNicknames[folderKey] ? label : null}
        requests={String(node.requests)}
        alerts={node.alerts > 0 ? String(node.alerts) : undefined}
        isExpandable={canExpand}
        isOpen={isOpen}
        onToggle={canExpand ? () => onTogglePath(pathKey) : undefined}
        onNickname={() => onNicknameFolder(folderKey, label)}
        onHide={() => onHideFolder(folderKey)}
        onSendToRepeater={latestFolderEventId ? () => onOpenRepeater(latestFolderEventId) : undefined}
        onSendToIntruder={latestFolderEventId ? () => onOpenIntruder(latestFolderEventId) : undefined}
        onAnalyze={latestFolderEventId ? () => onAnalyzeEvent(latestFolderEventId) : undefined}
        onDelete={
          folderStats.count > 0 ?
            () => {
              if (!window.confirm(`Delete ${folderStats.count} events under "${absolutePath}"?`)) {
                return;
              }
              const folderEventIds = getFolderEventIdsForDelete(host, port, absolutePath);
              void onDeleteManyEvents(folderEventIds);
            }
          : undefined
        }
      />
      {isOpen
        ? pathEvents.map((event) => (
            <EventRow
              key={event.id}
              event={event}
              depth={depth + 1}
              nickname={eventNicknames[event.id]}
              onDeleteEvent={onDeleteEvent}
              onNicknameEvent={onNicknameEvent}
              onHideEvent={onHideEvent}
              onOpenRepeater={onOpenRepeater}
              onOpenIntruder={onOpenIntruder}
              onAnalyzeEvent={onAnalyzeEvent}
            />
          ))
        : null}
      {hasChildren && isOpen
        ? visibleChildren.map((child, i) => (
            <PathTreeNodes
              key={`${pathKey}-${i}-${child.segment}`}
              host={host}
              port={port}
              node={child}
              depth={depth + 1}
              currentPath={absolutePath === '/' ? '' : absolutePath}
              pathKeyPrefix={`${pathKey}|`}
              openPathKeys={openPathKeys}
              onTogglePath={onTogglePath}
              visibleEventsByHostPath={visibleEventsByHostPath}
              folderStatsByFolder={folderStatsByFolder}
              onDeleteEvent={onDeleteEvent}
              eventNicknames={eventNicknames}
              folderNicknames={folderNicknames}
              hiddenFolderSet={hiddenFolderSet}
              onNicknameEvent={onNicknameEvent}
              onNicknameFolder={onNicknameFolder}
              onHideEvent={onHideEvent}
              onHideFolder={onHideFolder}
              onOpenRepeater={onOpenRepeater}
              onOpenIntruder={onOpenIntruder}
              onAnalyzeEvent={onAnalyzeEvent}
              onDeleteManyEvents={onDeleteManyEvents}
              getFolderEventIdsForDelete={getFolderEventIdsForDelete}
            />
          ))
        : null}
    </>
  );
}

function TreeRow(props: {
  depth: number;
  label: string;
  subtitle?: string | null;
  requests: string;
  alerts?: string;
  isExpandable?: boolean;
  isOpen?: boolean;
  onToggle?: () => void;
  onNickname?: () => void;
  onHide?: () => void;
  onDelete?: () => void;
  onSendToRepeater?: () => void;
  onSendToIntruder?: () => void;
  onAnalyze?: () => void;
}) {
  const { isExpandable = false, isOpen = false, onToggle } = props;
  const content = (
    <>
      <span className="flex-shrink-0 text-[color:var(--cs-muted)]">
        {isExpandable ? (
          isOpen ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )
        ) : (
          <ChevronRight className="h-3.5 w-3.5" />
        )}
      </span>
      <span className="inline-flex min-w-0 flex-1 items-center gap-1.5 truncate text-[13px] text-[color:var(--cs-fg)]">
        {isExpandable ? (
          <FolderOpen className="h-3.5 w-3.5 shrink-0 text-amber-500" />
        ) : (
          <Folder className="h-3.5 w-3.5 shrink-0 text-amber-500" />
        )}
        <span className="truncate">{props.label}</span>
      </span>
      <span className="flex-shrink-0 text-[11px] text-[color:var(--cs-muted)] whitespace-nowrap">{props.requests}</span>
      {props.alerts ? (
        <span className="flex-shrink-0 rounded bg-rose-100 px-1.5 py-0 text-[10px] font-bold text-rose-700 whitespace-nowrap">
          {props.alerts}
        </span>
      ) : (
        <CircleDot className="h-2 w-2 shrink-0 text-transparent" />
      )}
    </>
  );

  const style = { paddingLeft: `${props.depth * 12}px` };
  const className = 'mt-0.5 flex items-center gap-1.5 rounded-md px-1 py-1 hover:bg-[color:var(--cs-hover)] min-w-0';

  const row =
    isExpandable && onToggle ?
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onToggle();
        }}
        className={`w-full text-left cursor-pointer ${className}`}
        style={style}
      >
        {content}
      </button>
    : <div className={className} style={style}>{content}</div>;

  const withContextMenu =
    props.onNickname ||
    props.onHide ||
    props.onDelete ||
    props.onSendToRepeater ||
    props.onSendToIntruder ||
    props.onAnalyze;

  return (
    <>
      {withContextMenu ? (
        <ContextMenu>
          <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem onClick={props.onNickname}>
              <Pencil className="h-3.5 w-3.5" />
              Set Nickname
            </ContextMenuItem>
            <ContextMenuItem onClick={props.onSendToRepeater} disabled={!props.onSendToRepeater}>
              <RotateCcw className="h-3.5 w-3.5" />
              Send Latest to Repeater
            </ContextMenuItem>
            <ContextMenuItem onClick={props.onSendToIntruder} disabled={!props.onSendToIntruder}>
              <Crosshair className="h-3.5 w-3.5" />
              Send Latest to Intruder
            </ContextMenuItem>
            <ContextMenuItem onClick={props.onAnalyze} disabled={!props.onAnalyze}>
              <Search className="h-3.5 w-3.5" />
              Analyze Latest
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={props.onHide}>
              <EyeOff className="h-3.5 w-3.5" />
              Hide Folder
            </ContextMenuItem>
            <ContextMenuItem variant="destructive" onClick={props.onDelete} disabled={!props.onDelete}>
              <Trash2 className="h-3.5 w-3.5" />
              Delete Folder Events
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      ) : (
        row
      )}
      {props.subtitle ? (
        <div
          style={{ paddingLeft: `${props.depth * 12 + 25}px` }}
          className="text-[10px] text-[color:var(--cs-muted)] truncate"
        >
          {props.subtitle}
        </div>
      ) : null}
    </>
  );
}

function ContractTransactionRow(props: {
  item: ContractDecodedItem;
  depth: number;
  onSendToSandbox: (item: ContractDecodedItem) => void;
}) {
  const prefill = buildDecodedSandboxPrefill(props.item);
  const style = { paddingLeft: `${props.depth * 12}px` };
  const riskCount = props.item.risks.length;
  const title = `${props.item.rpcMethod} ${props.item.summary}`;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div style={style} className="mt-0.5">
          <Link
            href={`/history?open=${encodeURIComponent(props.item.messageId)}`}
            className="flex min-w-0 items-center gap-1.5 rounded-md px-1 py-1 text-left hover:bg-[color:var(--cs-hover)]"
            title={title}
          >
            <Activity className="h-3.5 w-3.5 shrink-0 text-[color:var(--cs-accent)]" />
            <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-[color:var(--cs-fg)]">
              {props.item.summary}
            </span>
            <span className="shrink-0 text-[11px] text-[color:var(--cs-muted)]">
              {formatTxTime(props.item.createdAt)}
            </span>
            {riskCount > 0 ? (
              <span className="shrink-0 rounded bg-rose-100 px-1.5 py-0 text-[10px] font-bold text-rose-700">
                {riskCount}
              </span>
            ) : null}
          </Link>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem asChild>
          <Link href={`/history?open=${encodeURIComponent(props.item.messageId)}`}>
            <Activity className="h-3.5 w-3.5" />
            Open in History
          </Link>
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!prefill}
          onClick={() => {
            props.onSendToSandbox(props.item);
          }}
        >
          <Send className="h-3.5 w-3.5" />
          Send to Contract Sandbox
        </ContextMenuItem>
        <ContextMenuItem
          onClick={async () => {
            if (!props.item.selector) return;
            await navigator.clipboard.writeText(props.item.selector);
          }}
          disabled={!props.item.selector}
        >
          <Copy className="h-3.5 w-3.5" />
          Copy Selector
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function EventRow(props: {
  event: HttpMessageSummary;
  depth?: number;
  nickname?: string;
  onDeleteEvent: (id: string) => Promise<void>;
  onNicknameEvent: (eventId: string, label: string) => void;
  onHideEvent: (eventId: string) => void;
  onOpenRepeater: (eventId: string) => void;
  onOpenIntruder: (eventId: string) => void;
  onAnalyzeEvent: (eventId: string) => void;
}) {
  const event = props.event;
  const depth = props.depth ?? 1;
  const style = { paddingLeft: `${depth * 12}px` };
  const titleLabel = props.nickname ? `${props.nickname} (${event.method} ${event.path})` : `${event.method} ${event.path}`;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div style={style} className="mt-0.5">
          <Link
            href={`/history?open=${encodeURIComponent(event.id)}`}
            className="flex min-w-0 items-center gap-1.5 rounded-md px-1 py-1 text-left hover:bg-[color:var(--cs-hover)]"
            title={titleLabel}
          >
            <Globe className="h-3.5 w-3.5 shrink-0 text-[color:var(--cs-accent)]" />
            <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-[color:var(--cs-fg)]">
              {props.nickname ?? `${event.method} ${event.path}`}
            </span>
            <span className="shrink-0 text-[11px] text-[color:var(--cs-muted)]">
              {event.responseStatus ?? '-'}
            </span>
          </Link>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem asChild>
          <Link href={`/history?open=${encodeURIComponent(event.id)}`}>
            <Activity className="h-3.5 w-3.5" />
            Open in Call History
          </Link>
        </ContextMenuItem>
        <ContextMenuItem onClick={() => props.onOpenRepeater(event.id)}>
          <RotateCcw className="h-3.5 w-3.5" />
          Send to Repeater
        </ContextMenuItem>
        <ContextMenuItem onClick={() => props.onOpenIntruder(event.id)}>
          <Crosshair className="h-3.5 w-3.5" />
          Send to Intruder
        </ContextMenuItem>
        <ContextMenuItem onClick={() => props.onAnalyzeEvent(event.id)}>
          <Search className="h-3.5 w-3.5" />
          Analyze Event
        </ContextMenuItem>
        <ContextMenuItem onClick={() => props.onNicknameEvent(event.id, `${event.method} ${event.path}`)}>
          <Pencil className="h-3.5 w-3.5" />
          Set Nickname
        </ContextMenuItem>
        <ContextMenuItem onClick={() => props.onHideEvent(event.id)}>
          <EyeOff className="h-3.5 w-3.5" />
          Hide Event
        </ContextMenuItem>
        <ContextMenuItem
          onClick={async () => {
            await navigator.clipboard.writeText(event.url);
          }}
        >
          <Copy className="h-3.5 w-3.5" />
          Copy URL
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          variant="destructive"
          onClick={async () => {
            await props.onDeleteEvent(event.id);
          }}
        >
          <Trash2 className="h-3.5 w-3.5" />
          Delete Event
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function HiddenSection(props: {
  hosts: Array<{ key: string; label: string; detail: string }>;
  folders: Array<{ key: string; label: string; detail: string }>;
  events: Array<{ id: string; label: string; detail: string }>;
  onUnhideHost: (key: string) => void;
  onUnhideFolder: (key: string) => void;
  onUnhideEvent: (id: string) => void;
}) {
  const hasAny = props.hosts.length > 0 || props.folders.length > 0 || props.events.length > 0;
  if (!hasAny) return null;

  return (
    <div className="mt-3 border-t border-[color:var(--cs-border)] pt-2">
      <div className="px-1 text-[10px] font-bold uppercase tracking-wide text-[color:var(--cs-muted)]">Hidden</div>
      <div className="mt-1 space-y-1">
        {props.hosts.map((host) => (
          <HiddenRow
            key={`host:${host.key}`}
            label={host.label}
            detail={`Host · ${host.detail}`}
            onUnhide={() => props.onUnhideHost(host.key)}
          />
        ))}
        {props.folders.map((folder) => (
          <HiddenRow
            key={`folder:${folder.key}`}
            label={folder.label}
            detail={`Folder · ${folder.detail}`}
            onUnhide={() => props.onUnhideFolder(folder.key)}
          />
        ))}
        {props.events.map((event) => (
          <HiddenRow
            key={`event:${event.id}`}
            label={event.label}
            detail={`Event · ${event.detail}`}
            onUnhide={() => props.onUnhideEvent(event.id)}
          />
        ))}
      </div>
    </div>
  );
}

function HiddenRow(props: { label: string; detail: string; onUnhide: () => void }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 py-1">
      <EyeOff className="h-3.5 w-3.5 shrink-0 text-[color:var(--cs-muted)]" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12px] text-[color:var(--cs-fg)]">{props.label}</div>
        <div className="truncate text-[10px] text-[color:var(--cs-muted)]">{props.detail}</div>
      </div>
      <button
        type="button"
        onClick={props.onUnhide}
        className="inline-flex items-center gap-1 rounded border border-[color:var(--cs-border)] px-1.5 py-0.5 text-[10px] font-semibold text-[color:var(--cs-fg)] hover:bg-[color:var(--cs-hover)]"
      >
        <Eye className="h-3 w-3" />
        Unhide
      </button>
    </div>
  );
}

function normalizePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed || trimmed === '/') return '/';
  return `/${trimmed.replace(/^\/+/, '')}`;
}

function getFolderPaths(path: string): string[] {
  const normalized = normalizePath(path);
  if (normalized === '/') return ['/'];
  const segments = normalized.slice(1).split('/').filter(Boolean);
  const out = ['/'];
  let current = '';
  for (const segment of segments) {
    current = `${current}/${segment}`;
    out.push(current);
  }
  return out;
}

function pathIncludes(path: string, parentPath: string): boolean {
  if (parentPath === '/') return true;
  if (path === parentPath) return true;
  return path.startsWith(`${parentPath}/`);
}

function buildFolderKey(host: string, port: number, path: string): string {
  return `${host}:${port}|${normalizePath(path)}`;
}

function parseFolderKey(key: string): { hostPort: string; path: string } {
  const idx = key.indexOf('|');
  if (idx === -1) return { hostPort: key, path: '/' };
  const hostPort = key.slice(0, idx);
  const path = key.slice(idx + 1) || '/';
  return { hostPort, path: normalizePath(path) };
}

function shortAddress(value: string, max = 18): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 6)}...${value.slice(-4)}`;
}

function makeContractSubtitle(
  label: string,
  chainId: number | null | undefined,
  address: string | null | undefined,
): string | null {
  const parts: string[] = [];
  if (typeof chainId === 'number') parts.push(`chain ${chainId}`);
  if (address && address.toLowerCase() !== label.toLowerCase()) {
    parts.push(shortAddress(address, 20));
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

function methodIdentityKey(item: ContractDecodedItem): string {
  if (item.functionName) {
    return `fn:${item.functionName.toLowerCase()}|${(item.selector ?? '').toLowerCase()}`;
  }
  if (item.selector) return `selector:${item.selector.toLowerCase()}`;
  return `rpc:${item.rpcMethod.toLowerCase()}`;
}

function methodDisplayLabel(item: ContractDecodedItem): string {
  if (item.functionName) {
    if (item.selector) return `${item.functionName} (${item.selector})`;
    return item.functionName;
  }
  if (item.selector) return item.selector;
  return item.rpcMethod;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function asOptionalRpcString(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return asOptionalString(value);
}

function txMethodToSimulateOnly(method: string): boolean {
  const normalized = method.toLowerCase();
  return normalized === 'eth_call' || normalized === 'eth_estimategas';
}

function buildDecodedSandboxPrefill(item: ContractDecodedItem): ContractSandboxPrefill | null {
  if (item.kind !== 'transaction') return null;
  const decoded = asRecord(item.decoded);
  const tx = decoded ? asRecord(decoded.transaction) : null;
  const to = asOptionalString(tx?.to) ?? item.to;
  if (!to) return null;
  return {
    sourceInteractionId: item.id,
    method: item.rpcMethod,
    from: asOptionalString(tx?.from),
    to,
    data: asOptionalString(tx?.data) ?? '0x',
    value: asOptionalRpcString(tx?.value),
    gas: asOptionalRpcString(tx?.gas),
    simulateOnly: txMethodToSimulateOnly(item.rpcMethod),
    abiJson: null,
    label: item.contractName ?? item.functionName ?? null,
    createdAt: new Date().toISOString(),
  };
}

function formatTxTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}
