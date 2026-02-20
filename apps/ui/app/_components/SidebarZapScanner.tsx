'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ScanSummaryModal } from './ScanSummaryModal';

export type ZapScanStatus = 'queued' | 'running' | 'stopping' | 'completed' | 'failed' | 'stopped';
export type ZapRiskLevel = 'critical' | 'high' | 'medium' | 'low' | 'informational' | 'unknown';

export type ZapAlert = {
  pluginId: string;
  alert: string;
  risk: ZapRiskLevel;
  confidence: string | null;
  url: string | null;
  param: string | null;
  attack: string | null;
  evidence: string | null;
  cweId: number | null;
  wascId: number | null;
  description: string | null;
  solution: string | null;
  reference: string | null;
};

export type ZapScanConfig = {
  spider: boolean;
  ajaxSpider: boolean;
  activeScan: boolean;
  recurse: boolean;
  inScopeOnly: boolean;
  waitForPassiveScan: boolean;
  contextName: string | null;
  scanPolicyName: string | null;
  maxChildren: number | null;
  maxAlerts: number;
  pollIntervalMs: number;
  maxDurationMs: number;
  source: 'ui' | 'ai';
};

export type ZapScanState = {
  stage:
    | 'queued'
    | 'connecting'
    | 'spider'
    | 'ajax_spider'
    | 'passive_scan'
    | 'active_scan'
    | 'collecting_alerts'
    | 'completed'
    | 'failed'
    | 'stopped';
  detail: string | null;
  progress: number;
  spiderScanId: string | null;
  spiderProgress: number | null;
  ajaxStatus: string | null;
  ajaxResults: number | null;
  activeScanId: string | null;
  activeProgress: number | null;
  passiveRecordsToScan: number | null;
};

export type ZapScanSummary = {
  alertsTotal: number;
  riskCounts: Record<ZapRiskLevel, number>;
  alerts: ZapAlert[];
};

export type ZapScanRecord = {
  id: string;
  target: string;
  createdAt: string;
  updatedAt: string;
  startedAt: string;
  finishedAt: string | null;
  status: ZapScanStatus;
  config: ZapScanConfig;
  state: ZapScanState;
  summary: ZapScanSummary;
  error: string | null;
};

type ScannerPrefs = {
  target: string;
  spider: boolean;
  ajaxSpider: boolean;
  activeScan: boolean;
  passiveOnly: boolean;
  recurse: boolean;
  inScopeOnly: boolean;
  waitForPassiveScan: boolean;
  maxChildren: string;
  maxAlerts: string;
  contextName: string;
  scanPolicyName: string;
  pollIntervalMs: string;
  maxDurationMs: string;
};

type SubfinderPrefs = {
  domain: string;
  recursive: boolean;
  allSources: boolean;
  activeOnly: boolean;
  timeoutSeconds: string;
  maxTimeMinutes: string;
  rateLimit: string;
  sources: string;
  excludeSources: string;
};

type SubfinderRun = {
  command: string;
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  truncated: boolean;
  stdout: string;
  stderr: string;
  error: string | null;
};

type SubfinderResult = {
  domain: string;
  run: SubfinderRun;
  count: number;
  subdomains: string[];
};

const PREFS_KEY = 'left-nav-zap-scanner-v1';
const SUBFINDER_PREFS_KEY = 'left-nav-subfinder-v1';
const SUBFINDER_RESULT_KEY = 'left-nav-subfinder-result-v1';
const DEFAULT_SUBFINDER_SOURCES = 'anubis,crtsh,hackertarget,rapiddns,threatcrowd,waybackarchive';
const STATUS_VALUES: ZapScanStatus[] = ['queued', 'running', 'stopping', 'completed', 'failed', 'stopped'];
const STAGE_VALUES: ZapScanState['stage'][] = [
  'queued',
  'connecting',
  'spider',
  'ajax_spider',
  'passive_scan',
  'active_scan',
  'collecting_alerts',
  'completed',
  'failed',
  'stopped',
];
const RISK_LEVELS: ZapRiskLevel[] = ['critical', 'high', 'medium', 'low', 'informational', 'unknown'];

const defaultPrefs: ScannerPrefs = {
  target: '',
  spider: true,
  ajaxSpider: false,
  activeScan: true,
  passiveOnly: false,
  recurse: true,
  inScopeOnly: false,
  waitForPassiveScan: true,
  maxChildren: '',
  maxAlerts: '200',
  contextName: '',
  scanPolicyName: '',
  pollIntervalMs: '1500',
  maxDurationMs: String(30 * 60 * 1000),
};

const defaultSubfinderPrefs: SubfinderPrefs = {
  domain: '',
  recursive: true,
  allSources: false,
  activeOnly: false,
  timeoutSeconds: '30',
  maxTimeMinutes: '10',
  rateLimit: '',
  sources: DEFAULT_SUBFINDER_SOURCES,
  excludeSources: '',
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function asInt(value: unknown): number | null {
  const parsed = asNumber(value);
  if (parsed == null) return null;
  return Math.trunc(parsed);
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function parseSourceList(raw: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(/[,\n]+/)) {
    const value = part.trim().toLowerCase();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= 50) break;
  }
  return out;
}

function asStatus(value: unknown): ZapScanStatus | null {
  return typeof value === 'string' && STATUS_VALUES.includes(value as ZapScanStatus)
    ? (value as ZapScanStatus)
    : null;
}

function asStage(value: unknown): ZapScanState['stage'] | null {
  return typeof value === 'string' && STAGE_VALUES.includes(value as ZapScanState['stage'])
    ? (value as ZapScanState['stage'])
    : null;
}

function normalizeRiskCounts(value: unknown): Record<ZapRiskLevel, number> {
  const out: Record<ZapRiskLevel, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    informational: 0,
    unknown: 0,
  };

  const rec = asRecord(value);
  if (!rec) return out;

  for (const key of RISK_LEVELS) {
    const parsed = asNumber(rec[key]);
    if (parsed != null) out[key] = Math.max(0, Math.trunc(parsed));
  }

  return out;
}

function parseAlert(value: unknown): ZapAlert | null {
  const rec = asRecord(value);
  if (!rec) return null;

  const alert = asString(rec.alert);
  const risk = asString(rec.risk) as ZapRiskLevel | null;
  if (!alert || !risk || !RISK_LEVELS.includes(risk)) return null;

  return {
    pluginId: asString(rec.pluginId) ?? '',
    alert,
    risk,
    confidence: asString(rec.confidence),
    url: asString(rec.url),
    param: asString(rec.param),
    attack: asString(rec.attack),
    evidence: asString(rec.evidence),
    cweId: asNumber(rec.cweId),
    wascId: asNumber(rec.wascId),
    description: asString(rec.description),
    solution: asString(rec.solution),
    reference: asString(rec.reference),
  };
}

function parseScan(value: unknown): ZapScanRecord | null {
  const rec = asRecord(value);
  if (!rec) return null;

  const id = asString(rec.id);
  const target = asString(rec.target);
  const status = asStatus(rec.status);
  const createdAt = asString(rec.createdAt);
  const updatedAt = asString(rec.updatedAt);
  const startedAt = asString(rec.startedAt);
  if (!id || !target || !status || !createdAt || !updatedAt || !startedAt) return null;

  const configRec = asRecord(rec.config);
  const stateRec = asRecord(rec.state);
  const summaryRec = asRecord(rec.summary);
  if (!configRec || !stateRec || !summaryRec) return null;

  const stage = asStage(stateRec.stage);
  if (!stage) return null;

  const alertsRaw = Array.isArray(summaryRec.alerts) ? summaryRec.alerts : [];

  return {
    id,
    target,
    createdAt,
    updatedAt,
    startedAt,
    finishedAt: asString(rec.finishedAt),
    status,
    config: {
      spider: asBoolean(configRec.spider, true),
      ajaxSpider: asBoolean(configRec.ajaxSpider, false),
      activeScan: asBoolean(configRec.activeScan, true),
      recurse: asBoolean(configRec.recurse, true),
      inScopeOnly: asBoolean(configRec.inScopeOnly, false),
      waitForPassiveScan: asBoolean(configRec.waitForPassiveScan, true),
      contextName: asString(configRec.contextName),
      scanPolicyName: asString(configRec.scanPolicyName),
      maxChildren: asNumber(configRec.maxChildren),
      maxAlerts: asNumber(configRec.maxAlerts) ?? 200,
      pollIntervalMs: asNumber(configRec.pollIntervalMs) ?? 1500,
      maxDurationMs: asNumber(configRec.maxDurationMs) ?? 30 * 60 * 1000,
      source: asString(configRec.source) === 'ai' ? 'ai' : 'ui',
    },
    state: {
      stage,
      detail: asString(stateRec.detail),
      progress: Math.max(0, Math.min(100, Math.trunc(asNumber(stateRec.progress) ?? 0))),
      spiderScanId: asString(stateRec.spiderScanId),
      spiderProgress: asNumber(stateRec.spiderProgress),
      ajaxStatus: asString(stateRec.ajaxStatus),
      ajaxResults: asNumber(stateRec.ajaxResults),
      activeScanId: asString(stateRec.activeScanId),
      activeProgress: asNumber(stateRec.activeProgress),
      passiveRecordsToScan: asNumber(stateRec.passiveRecordsToScan),
    },
    summary: {
      alertsTotal: Math.max(0, Math.trunc(asNumber(summaryRec.alertsTotal) ?? 0)),
      riskCounts: normalizeRiskCounts(summaryRec.riskCounts),
      alerts: alertsRaw.map((item) => parseAlert(item)).filter((item): item is ZapAlert => item != null),
    },
    error: asString(rec.error),
  };
}

function parseListResponse(value: unknown): ZapScanRecord[] {
  const rec = asRecord(value);
  if (!rec || rec.ok !== true || !Array.isArray(rec.items)) return [];
  return rec.items.map((item) => parseScan(item)).filter((item): item is ZapScanRecord => item != null);
}

function parseSingleScanResponse(value: unknown): ZapScanRecord | null {
  const rec = asRecord(value);
  if (!rec || rec.ok !== true) return null;
  return parseScan(rec.scan);
}

function parseSubfinderResult(value: unknown): SubfinderResult | null {
  const rec = asRecord(value);
  if (!rec || rec.ok !== true) return null;

  const domain = asString(rec.domain);
  const count = asInt(rec.count);
  const runRec = asRecord(rec.run);
  const subsRaw = Array.isArray(rec.subdomains) ? rec.subdomains : [];
  if (!domain || !runRec || count == null) return null;

  const run: SubfinderRun = {
    command: asString(runRec.command) ?? 'subfinder',
    ok: runRec.ok === true,
    exitCode: asInt(runRec.exitCode),
    timedOut: runRec.timedOut === true,
    durationMs: Math.max(0, asInt(runRec.durationMs) ?? 0),
    truncated: runRec.truncated === true,
    stdout: typeof runRec.stdout === 'string' ? runRec.stdout : '',
    stderr: typeof runRec.stderr === 'string' ? runRec.stderr : '',
    error: asString(runRec.error),
  };

  const set = new Set<string>();
  for (const item of subsRaw) {
    const host = asString(item)?.toLowerCase();
    if (host) set.add(host);
  }

  const subdomains = [...set].sort((a, b) => a.localeCompare(b));
  return {
    domain,
    run,
    count: Math.max(0, count),
    subdomains,
  };
}

function extractDomainCandidate(input: string | null): string | null {
  if (!input) return null;
  const value = input.trim();
  if (!value) return null;

  try {
    const parsed = new URL(value.includes('://') ? value : `https://${value}`);
    const host = parsed.hostname.trim().toLowerCase().replace(/\.+$/g, '');
    if (!host) return null;
    if (!/^[a-z0-9.-]+$/.test(host)) return null;
    if (host.includes('..')) return null;
    return host;
  } catch {
    return null;
  }
}

export function statusBadgeClass(status: ZapScanStatus): string {
  switch (status) {
    case 'completed':
      return 'bg-emerald-500/15 text-emerald-600';
    case 'failed':
      return 'bg-rose-500/15 text-rose-600';
    case 'stopped':
      return 'bg-amber-500/15 text-amber-700';
    case 'stopping':
      return 'bg-amber-500/15 text-amber-700';
    case 'running':
      return 'bg-blue-500/15 text-blue-600';
    default:
      return 'bg-[color:var(--cs-hover)] text-[color:var(--cs-muted)]';
  }
}

export function formatStamp(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString();
}

export function isActiveStatus(status: ZapScanStatus): boolean {
  return status === 'queued' || status === 'running' || status === 'stopping';
}

export function SidebarZapScanner(props: { suggestedTarget: string | null }) {
  const [prefs, setPrefs] = useState<ScannerPrefs>(defaultPrefs);
  const [subfinderPrefs, setSubfinderPrefs] = useState<SubfinderPrefs>(defaultSubfinderPrefs);
  const [hydrated, setHydrated] = useState(false);
  const appliedSuggestedTargetRef = useRef(false);
  const appliedSuggestedDomainRef = useRef(false);

  const [scans, setScans] = useState<ZapScanRecord[]>([]);
  const [selectedScanId, setSelectedScanId] = useState<string | null>(null);
  const [summaryModalOpen, setSummaryModalOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [starting, setStarting] = useState(false);
  const [stoppingScanId, setStoppingScanId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [subfinderBusy, setSubfinderBusy] = useState(false);
  const [subfinderError, setSubfinderError] = useState<string | null>(null);
  const [subfinderResult, setSubfinderResult] = useState<SubfinderResult | null>(null);
  const suggestedDomain = useMemo(() => extractDomainCandidate(props.suggestedTarget), [props.suggestedTarget]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(PREFS_KEY);
      if (raw) {
        const parsed = asRecord(JSON.parse(raw));
        if (parsed) {
          setPrefs((prev) => ({
            ...prev,
            target: asString(parsed.target) ?? prev.target,
            spider: asBoolean(parsed.spider, prev.spider),
            ajaxSpider: asBoolean(parsed.ajaxSpider, prev.ajaxSpider),
            activeScan: asBoolean(parsed.activeScan, prev.activeScan),
            passiveOnly: asBoolean(parsed.passiveOnly, prev.passiveOnly),
            recurse: asBoolean(parsed.recurse, prev.recurse),
            inScopeOnly: asBoolean(parsed.inScopeOnly, prev.inScopeOnly),
            waitForPassiveScan: asBoolean(parsed.waitForPassiveScan, prev.waitForPassiveScan),
            maxChildren: asString(parsed.maxChildren) ?? prev.maxChildren,
            maxAlerts: asString(parsed.maxAlerts) ?? prev.maxAlerts,
            contextName: asString(parsed.contextName) ?? prev.contextName,
            scanPolicyName: asString(parsed.scanPolicyName) ?? prev.scanPolicyName,
            pollIntervalMs: asString(parsed.pollIntervalMs) ?? prev.pollIntervalMs,
            maxDurationMs: asString(parsed.maxDurationMs) ?? prev.maxDurationMs,
          }));
        }
      }

      const rawSubfinderPrefs = window.localStorage.getItem(SUBFINDER_PREFS_KEY);
      if (rawSubfinderPrefs) {
        const parsedSubfinderPrefs = asRecord(JSON.parse(rawSubfinderPrefs));
        if (parsedSubfinderPrefs) {
          setSubfinderPrefs((prev) => ({
            ...prev,
            domain: asString(parsedSubfinderPrefs.domain) ?? prev.domain,
            recursive: asBoolean(parsedSubfinderPrefs.recursive, prev.recursive),
            allSources: asBoolean(parsedSubfinderPrefs.allSources, prev.allSources),
            activeOnly: asBoolean(parsedSubfinderPrefs.activeOnly, prev.activeOnly),
            timeoutSeconds: asString(parsedSubfinderPrefs.timeoutSeconds) ?? prev.timeoutSeconds,
            maxTimeMinutes: asString(parsedSubfinderPrefs.maxTimeMinutes) ?? prev.maxTimeMinutes,
            rateLimit: asString(parsedSubfinderPrefs.rateLimit) ?? prev.rateLimit,
            sources: asString(parsedSubfinderPrefs.sources) ?? prev.sources,
            excludeSources: asString(parsedSubfinderPrefs.excludeSources) ?? prev.excludeSources,
          }));
        }
      }

      const rawSubfinderResult = window.localStorage.getItem(SUBFINDER_RESULT_KEY);
      if (rawSubfinderResult) {
        const parsedSubfinderResult = parseSubfinderResult(JSON.parse(rawSubfinderResult));
        if (parsedSubfinderResult) setSubfinderResult(parsedSubfinderResult);
      }
    } catch {
      // ignore bad persisted state
    } finally {
      setHydrated(true);
    }
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      // ignore localStorage errors
    }
  }, [hydrated, prefs]);

  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(SUBFINDER_PREFS_KEY, JSON.stringify(subfinderPrefs));
    } catch {
      // ignore localStorage errors
    }
  }, [hydrated, subfinderPrefs]);

  useEffect(() => {
    if (!hydrated) return;
    try {
      if (!subfinderResult) {
        window.localStorage.removeItem(SUBFINDER_RESULT_KEY);
      } else {
        window.localStorage.setItem(SUBFINDER_RESULT_KEY, JSON.stringify(subfinderResult));
      }
    } catch {
      // ignore localStorage errors
    }
  }, [hydrated, subfinderResult]);

  useEffect(() => {
    if (!hydrated) return;
    if (appliedSuggestedTargetRef.current) return;
    if (prefs.target.trim()) return;
    if (!props.suggestedTarget) return;
    appliedSuggestedTargetRef.current = true;
    setPrefs((prev) => ({ ...prev, target: props.suggestedTarget ?? prev.target }));
  }, [hydrated, prefs.target, props.suggestedTarget]);

  useEffect(() => {
    if (!hydrated) return;
    if (appliedSuggestedDomainRef.current) return;
    if (subfinderPrefs.domain.trim()) return;
    const candidate = suggestedDomain ?? extractDomainCandidate(prefs.target);
    if (!candidate) return;
    appliedSuggestedDomainRef.current = true;
    setSubfinderPrefs((prev) => ({ ...prev, domain: candidate }));
  }, [hydrated, prefs.target, subfinderPrefs.domain, suggestedDomain]);

  const fetchScans = useCallback(async (options?: { silent?: boolean }) => {
    const silent = options?.silent === true;
    if (!silent) setLoading(true);

    try {
      const res = await fetch('/api/zap/scans?limit=25', { cache: 'no-store' });
      const json = (await res.json().catch(() => null)) as unknown;

      if (!res.ok) {
        const rec = asRecord(json);
        const errRec = asRecord(rec?.error);
        const message = asString(errRec?.message) ?? `Failed to load scans (${res.status}).`;
        throw new Error(message);
      }

      const items = parseListResponse(json);
      setScans(items);
      setSelectedScanId((prev) => {
        if (!items.length) return null;
        if (prev && items.some((item) => item.id === prev)) return prev;
        return items[0]?.id ?? null;
      });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load scans.');
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchScans();
  }, [fetchScans]);

  useEffect(() => {
    const hasActive = scans.some((scan) => isActiveStatus(scan.status));
    const delayMs = hasActive ? 2000 : 10000;
    const timer = window.setInterval(() => {
      void fetchScans({ silent: true });
    }, delayMs);
    return () => window.clearInterval(timer);
  }, [fetchScans, scans]);

  const runStartScan = useCallback(async () => {
    if (starting) return;

    const target = prefs.target.trim();
    if (!target) {
      setError('Target URL is required.');
      return;
    }

    const payload: Record<string, unknown> = {
      target,
      spider: prefs.spider,
      ajaxSpider: prefs.ajaxSpider,
      activeScan: prefs.passiveOnly ? false : prefs.activeScan,
      recurse: prefs.recurse,
      inScopeOnly: prefs.inScopeOnly,
      waitForPassiveScan: prefs.waitForPassiveScan,
      contextName: prefs.contextName.trim() || undefined,
      scanPolicyName: prefs.scanPolicyName.trim() || undefined,
    };

    const maxChildren = Number.parseInt(prefs.maxChildren.trim(), 10);
    if (Number.isFinite(maxChildren) && maxChildren >= 0) payload.maxChildren = maxChildren;

    const maxAlerts = Number.parseInt(prefs.maxAlerts.trim(), 10);
    if (Number.isFinite(maxAlerts) && maxAlerts > 0) payload.maxAlerts = maxAlerts;

    const pollIntervalMs = Number.parseInt(prefs.pollIntervalMs.trim(), 10);
    if (Number.isFinite(pollIntervalMs) && pollIntervalMs >= 50) payload.pollIntervalMs = pollIntervalMs;

    const maxDurationMs = Number.parseInt(prefs.maxDurationMs.trim(), 10);
    if (Number.isFinite(maxDurationMs) && maxDurationMs >= 60_000) payload.maxDurationMs = maxDurationMs;

    setStarting(true);
    setError(null);

    try {
      const res = await fetch('/api/zap/scans/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = (await res.json().catch(() => null)) as unknown;

      if (!res.ok) {
        const rec = asRecord(json);
        const errRec = asRecord(rec?.error);
        const message = asString(errRec?.message) ?? `Failed to start scan (${res.status}).`;
        throw new Error(message);
      }

      const scan = parseSingleScanResponse(json);
      if (!scan) throw new Error('Unexpected scan response payload.');

      setScans((prev) => [scan, ...prev.filter((item) => item.id !== scan.id)]);
      setSelectedScanId(scan.id);
      setError(null);

      void fetchScans({ silent: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start scan.');
    } finally {
      setStarting(false);
    }
  }, [fetchScans, prefs, starting]);

  const runStopScan = useCallback(
    async (scanId: string) => {
      if (stoppingScanId) return;
      setStoppingScanId(scanId);
      setError(null);

      try {
        const res = await fetch(`/api/zap/scans/${encodeURIComponent(scanId)}/stop`, {
          method: 'POST',
        });
        const json = (await res.json().catch(() => null)) as unknown;

        if (!res.ok) {
          const rec = asRecord(json);
          const errRec = asRecord(rec?.error);
          const message = asString(errRec?.message) ?? `Failed to stop scan (${res.status}).`;
          throw new Error(message);
        }

        const scan = parseSingleScanResponse(json);
        if (scan) {
          setScans((prev) => prev.map((item) => (item.id === scan.id ? scan : item)));
        }
        void fetchScans({ silent: true });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to stop scan.');
      } finally {
        setStoppingScanId(null);
      }
    },
    [fetchScans, stoppingScanId],
  );

  const applySubdomainTarget = useCallback(
    (host: string) => {
      const nextHost = host.trim();
      if (!nextHost) return;
      const existing = prefs.target.trim().toLowerCase();
      const scheme = existing.startsWith('http://') ? 'http://' : 'https://';
      setPrefs((prev) => ({ ...prev, target: `${scheme}${nextHost}` }));
    },
    [prefs.target],
  );

  const runSubfinder = useCallback(async () => {
    if (subfinderBusy) return;

    const domain = extractDomainCandidate(subfinderPrefs.domain);
    if (!domain) {
      setSubfinderError('A valid domain (or URL) is required.');
      return;
    }

    const payload: Record<string, unknown> = {
      domain,
      recursive: subfinderPrefs.recursive,
      allSources: subfinderPrefs.allSources,
      activeOnly: subfinderPrefs.activeOnly,
    };

    const timeoutSeconds = Number.parseInt(subfinderPrefs.timeoutSeconds.trim(), 10);
    if (Number.isFinite(timeoutSeconds) && timeoutSeconds >= 5) payload.timeoutSeconds = timeoutSeconds;

    const maxTimeMinutes = Number.parseInt(subfinderPrefs.maxTimeMinutes.trim(), 10);
    if (Number.isFinite(maxTimeMinutes) && maxTimeMinutes >= 1) payload.maxTimeMinutes = maxTimeMinutes;

    const rateLimit = Number.parseInt(subfinderPrefs.rateLimit.trim(), 10);
    if (Number.isFinite(rateLimit) && rateLimit >= 1) payload.rateLimit = rateLimit;

    const sources = parseSourceList(subfinderPrefs.sources);
    if (sources.length > 0) payload.sources = sources;

    const excludeSources = parseSourceList(subfinderPrefs.excludeSources);
    if (excludeSources.length > 0) payload.excludeSources = excludeSources;

    setSubfinderBusy(true);
    setSubfinderError(null);

    try {
      const res = await fetch('/api/system/subfinder', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = (await res.json().catch(() => null)) as unknown;

      if (!res.ok) {
        const rec = asRecord(json);
        const errRec = asRecord(rec?.error);
        const message = asString(errRec?.message) ?? `Failed to run Subfinder (${res.status}).`;
        throw new Error(message);
      }

      const parsed = parseSubfinderResult(json);
      if (!parsed) throw new Error('Unexpected Subfinder response payload.');

      setSubfinderResult(parsed);
      setSubfinderError(null);

      if (!prefs.target.trim()) {
        const first = parsed.subdomains[0] ?? parsed.domain;
        applySubdomainTarget(first);
      }
    } catch (err) {
      setSubfinderError(err instanceof Error ? err.message : 'Failed to run Subfinder.');
    } finally {
      setSubfinderBusy(false);
    }
  }, [applySubdomainTarget, prefs.target, subfinderBusy, subfinderPrefs]);

  const selectedScan = useMemo(() => {
    if (!selectedScanId) return scans[0] ?? null;
    return scans.find((scan) => scan.id === selectedScanId) ?? scans[0] ?? null;
  }, [scans, selectedScanId]);

  const canStart =
    !!prefs.target.trim() && (prefs.spider || prefs.ajaxSpider || prefs.passiveOnly || prefs.activeScan);

  return (
    <div className="space-y-3">
      <section className="rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] p-2">
        <div className="text-[10px] font-bold uppercase tracking-wide text-[color:var(--cs-muted)]">Subfinder</div>
        <div className="mt-1 text-[11px] text-[color:var(--cs-muted)]">
          Enumerate passive subdomains and quickly set one as your ZAP target.
        </div>

        <label className="mt-2 block">
          <div className="mb-1 text-[11px] text-[color:var(--cs-muted)]">Domain</div>
          <input
            type="text"
            value={subfinderPrefs.domain}
            onChange={(e) => setSubfinderPrefs((prev) => ({ ...prev, domain: e.target.value }))}
            placeholder="example.com or https://example.com"
            className="h-8 w-full rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-2 font-mono text-[11px] outline-none focus:border-[color:var(--cs-accent)]"
          />
        </label>

        <div className="mt-2 space-y-2 rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] p-2">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-[color:var(--cs-muted)]">Options</div>
          <label className="flex items-center gap-2 text-[11px] text-[color:var(--cs-fg)]">
            <input
              type="checkbox"
              checked={subfinderPrefs.recursive}
              onChange={(e) => setSubfinderPrefs((prev) => ({ ...prev, recursive: e.target.checked }))}
            />
            Recursive sources only
          </label>
          <label className="flex items-center gap-2 text-[11px] text-[color:var(--cs-fg)]">
            <input
              type="checkbox"
              checked={subfinderPrefs.allSources}
              onChange={(e) => setSubfinderPrefs((prev) => ({ ...prev, allSources: e.target.checked }))}
            />
            Use all sources (slower)
          </label>
          <label className="flex items-center gap-2 text-[11px] text-[color:var(--cs-fg)]">
            <input
              type="checkbox"
              checked={subfinderPrefs.activeOnly}
              onChange={(e) => setSubfinderPrefs((prev) => ({ ...prev, activeOnly: e.target.checked }))}
            />
            Active validation only
          </label>

          <div className="grid grid-cols-3 gap-2">
            <label className="block">
              <div className="mb-1 text-[10px] text-[color:var(--cs-muted)]">Timeout (s)</div>
              <input
                type="text"
                value={subfinderPrefs.timeoutSeconds}
                onChange={(e) => setSubfinderPrefs((prev) => ({ ...prev, timeoutSeconds: e.target.value }))}
                className="h-7 w-full rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 font-mono text-[11px] outline-none focus:border-[color:var(--cs-accent)]"
              />
            </label>
            <label className="block">
              <div className="mb-1 text-[10px] text-[color:var(--cs-muted)]">Max Time (m)</div>
              <input
                type="text"
                value={subfinderPrefs.maxTimeMinutes}
                onChange={(e) => setSubfinderPrefs((prev) => ({ ...prev, maxTimeMinutes: e.target.value }))}
                className="h-7 w-full rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 font-mono text-[11px] outline-none focus:border-[color:var(--cs-accent)]"
              />
            </label>
            <label className="block">
              <div className="mb-1 text-[10px] text-[color:var(--cs-muted)]">Rate Limit</div>
              <input
                type="text"
                value={subfinderPrefs.rateLimit}
                onChange={(e) => setSubfinderPrefs((prev) => ({ ...prev, rateLimit: e.target.value }))}
                placeholder="optional"
                className="h-7 w-full rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 font-mono text-[11px] outline-none focus:border-[color:var(--cs-accent)]"
              />
            </label>
          </div>

          <label className="block">
            <div className="mb-1 text-[10px] text-[color:var(--cs-muted)]">Sources (optional)</div>
            <input
              type="text"
              value={subfinderPrefs.sources}
              onChange={(e) => setSubfinderPrefs((prev) => ({ ...prev, sources: e.target.value }))}
              placeholder="crtsh,github,alienvault"
              className="h-7 w-full rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 font-mono text-[11px] outline-none focus:border-[color:var(--cs-accent)]"
            />
          </label>

          <label className="block">
            <div className="mb-1 text-[10px] text-[color:var(--cs-muted)]">Exclude Sources (optional)</div>
            <input
              type="text"
              value={subfinderPrefs.excludeSources}
              onChange={(e) => setSubfinderPrefs((prev) => ({ ...prev, excludeSources: e.target.value }))}
              placeholder="shodan,zoomeyeapi"
              className="h-7 w-full rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 font-mono text-[11px] outline-none focus:border-[color:var(--cs-accent)]"
            />
          </label>
        </div>

        <div className="mt-2 flex gap-2">
          <button
            type="button"
            onClick={() => void runSubfinder()}
            disabled={subfinderBusy || !subfinderPrefs.domain.trim()}
            className="inline-flex h-8 items-center rounded-md bg-[color:var(--cs-accent)] px-2.5 text-[11px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            {subfinderBusy ? 'Running…' : 'Run Subfinder'}
          </button>
          <button
            type="button"
            onClick={() => {
              setSubfinderResult(null);
              setSubfinderError(null);
            }}
            disabled={subfinderBusy || (!subfinderResult && !subfinderError)}
            className="inline-flex h-8 items-center rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2.5 text-[11px] font-semibold text-[color:var(--cs-fg)] disabled:cursor-not-allowed disabled:opacity-40"
          >
            Clear
          </button>
        </div>

        {subfinderError ? (
          <div className="mt-2 rounded border border-rose-500/30 bg-rose-500/10 px-2 py-1.5 text-[11px] text-rose-300">
            {subfinderError}
          </div>
        ) : null}

        {subfinderResult ? (
          <div className="mt-2 space-y-2 rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] p-2">
            <div className="flex items-center justify-between gap-2">
              <div className="truncate font-mono text-[11px] text-[color:var(--cs-fg)]">{subfinderResult.domain}</div>
              <div
                className={[
                  'rounded px-1.5 py-0.5 text-[10px] font-bold uppercase',
                  subfinderResult.run.ok ? 'bg-emerald-500/15 text-emerald-600' : 'bg-rose-500/15 text-rose-600',
                ].join(' ')}
              >
                {subfinderResult.run.ok ? 'ok' : 'error'}
              </div>
            </div>

            <div className="text-[10px] text-[color:var(--cs-muted)]">
              {subfinderResult.count} discovered · {(subfinderResult.run.durationMs / 1000).toFixed(1)}s
              {subfinderResult.run.timedOut ? ' · timed out' : ''}
            </div>

            {subfinderResult.run.error ? (
              <div className="rounded border border-rose-500/30 bg-rose-500/10 px-2 py-1 text-[10px] text-rose-300">
                {subfinderResult.run.error}
              </div>
            ) : null}

            {subfinderResult.run.stderr.trim() ? (
              <div className="max-h-20 overflow-auto rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 py-1 font-mono text-[10px] text-[color:var(--cs-muted)]">
                {subfinderResult.run.stderr.trim()}
              </div>
            ) : null}

            {subfinderResult.subdomains.length > 0 ? (
              <div className="max-h-48 space-y-1 overflow-auto">
                {subfinderResult.subdomains.slice(0, 60).map((host) => (
                  <div
                    key={host}
                    className="flex items-center justify-between gap-2 rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 py-1"
                  >
                    <div className="truncate font-mono text-[10px] text-[color:var(--cs-fg)]">{host}</div>
                    <button
                      type="button"
                      onClick={() => applySubdomainTarget(host)}
                      className="inline-flex h-6 items-center rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-1.5 text-[10px] font-semibold text-[color:var(--cs-fg)] hover:bg-[color:var(--cs-hover)]"
                    >
                      Set target
                    </button>
                  </div>
                ))}
                {subfinderResult.subdomains.length > 60 ? (
                  <div className="text-[10px] text-[color:var(--cs-muted)]">
                    Showing first 60 of {subfinderResult.subdomains.length} subdomains.
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="text-[10px] text-[color:var(--cs-muted)]">No subdomains discovered.</div>
            )}
          </div>
        ) : null}
      </section>

      <section className="rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] p-2">
        <div className="text-[10px] font-bold uppercase tracking-wide text-[color:var(--cs-muted)]">
          OWASP ZAP Scanner
        </div>


        <label className="mt-2 block">
          <div className="mb-1 text-[11px] text-[color:var(--cs-muted)]">Target URL</div>
          <input
            type="text"
            value={prefs.target}
            onChange={(e) => setPrefs((prev) => ({ ...prev, target: e.target.value }))}
            placeholder="https://target.tld"
            className="h-8 w-full rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-2 font-mono text-[11px] outline-none focus:border-[color:var(--cs-accent)]"
          />
        </label>

        <div className="mt-2 space-y-2 rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] p-2">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-[color:var(--cs-muted)]">
            Scan Stages
          </div>
          <label className="flex items-center gap-2 text-[11px] text-[color:var(--cs-fg)]">
            <input
              type="checkbox"
              checked={prefs.spider}
              onChange={(e) => setPrefs((prev) => ({ ...prev, spider: e.target.checked }))}
            />
            Run spider
          </label>
          <label className="flex items-center gap-2 text-[11px] text-[color:var(--cs-fg)]">
            <input
              type="checkbox"
              checked={prefs.ajaxSpider}
              onChange={(e) => setPrefs((prev) => ({ ...prev, ajaxSpider: e.target.checked }))}
            />
            Run ajax spider
          </label>
          <label className="flex items-center gap-2 text-[11px] text-[color:var(--cs-fg)]">
            <input
              type="checkbox"
              checked={prefs.passiveOnly}
              onChange={(e) =>
                setPrefs((prev) => ({
                  ...prev,
                  passiveOnly: e.target.checked,
                  activeScan: e.target.checked ? false : prev.activeScan,
                }))
              }
            />
            Passive-only (skip active scan)
          </label>
          <label className="flex items-center gap-2 text-[11px] text-[color:var(--cs-fg)]">
            <input
              type="checkbox"
              checked={prefs.passiveOnly ? false : prefs.activeScan}
              disabled={prefs.passiveOnly}
              onChange={(e) => setPrefs((prev) => ({ ...prev, activeScan: e.target.checked }))}
            />
            Run active scan
          </label>
        </div>

        <div className="mt-2 space-y-2 rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] p-2">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-[color:var(--cs-muted)]">
            Options
          </div>
          <label className="flex items-center gap-2 text-[11px] text-[color:var(--cs-fg)]">
            <input
              type="checkbox"
              checked={prefs.recurse}
              onChange={(e) => setPrefs((prev) => ({ ...prev, recurse: e.target.checked }))}
            />
            Recurse
          </label>
          <label className="flex items-center gap-2 text-[11px] text-[color:var(--cs-fg)]">
            <input
              type="checkbox"
              checked={prefs.inScopeOnly}
              onChange={(e) => setPrefs((prev) => ({ ...prev, inScopeOnly: e.target.checked }))}
            />
            In-scope only
          </label>
          <label className="flex items-center gap-2 text-[11px] text-[color:var(--cs-fg)]">
            <input
              type="checkbox"
              checked={prefs.waitForPassiveScan}
              onChange={(e) => setPrefs((prev) => ({ ...prev, waitForPassiveScan: e.target.checked }))}
            />
            Wait for passive queue drain
          </label>

          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <div className="mb-1 text-[10px] text-[color:var(--cs-muted)]">Max children</div>
              <input
                type="text"
                value={prefs.maxChildren}
                onChange={(e) => setPrefs((prev) => ({ ...prev, maxChildren: e.target.value }))}
                placeholder="optional"
                className="h-7 w-full rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 font-mono text-[11px] outline-none focus:border-[color:var(--cs-accent)]"
              />
            </label>
            <label className="block">
              <div className="mb-1 text-[10px] text-[color:var(--cs-muted)]">Max alerts</div>
              <input
                type="text"
                value={prefs.maxAlerts}
                onChange={(e) => setPrefs((prev) => ({ ...prev, maxAlerts: e.target.value }))}
                className="h-7 w-full rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 font-mono text-[11px] outline-none focus:border-[color:var(--cs-accent)]"
              />
            </label>
            <label className="block">
              <div className="mb-1 text-[10px] text-[color:var(--cs-muted)]">Poll ms</div>
              <input
                type="text"
                value={prefs.pollIntervalMs}
                onChange={(e) => setPrefs((prev) => ({ ...prev, pollIntervalMs: e.target.value }))}
                className="h-7 w-full rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 font-mono text-[11px] outline-none focus:border-[color:var(--cs-accent)]"
              />
            </label>
            <label className="block">
              <div className="mb-1 text-[10px] text-[color:var(--cs-muted)]">Max duration ms</div>
              <input
                type="text"
                value={prefs.maxDurationMs}
                onChange={(e) => setPrefs((prev) => ({ ...prev, maxDurationMs: e.target.value }))}
                className="h-7 w-full rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 font-mono text-[11px] outline-none focus:border-[color:var(--cs-accent)]"
              />
            </label>
          </div>

          <label className="block">
            <div className="mb-1 text-[10px] text-[color:var(--cs-muted)]">Context (optional)</div>
            <input
              type="text"
              value={prefs.contextName}
              onChange={(e) => setPrefs((prev) => ({ ...prev, contextName: e.target.value }))}
              className="h-7 w-full rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 font-mono text-[11px] outline-none focus:border-[color:var(--cs-accent)]"
            />
          </label>
          <label className="block">
            <div className="mb-1 text-[10px] text-[color:var(--cs-muted)]">Scan policy (optional)</div>
            <input
              type="text"
              value={prefs.scanPolicyName}
              onChange={(e) => setPrefs((prev) => ({ ...prev, scanPolicyName: e.target.value }))}
              className="h-7 w-full rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 font-mono text-[11px] outline-none focus:border-[color:var(--cs-accent)]"
            />
          </label>
        </div>

        <div className="mt-2 flex gap-2">
          <button
            type="button"
            onClick={() => void runStartScan()}
            disabled={!canStart || starting}
            className="inline-flex h-8 items-center rounded-md bg-[color:var(--cs-accent)] px-2.5 text-[11px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            {starting ? 'Starting…' : 'Start scan'}
          </button>
          <button
            type="button"
            onClick={() => void fetchScans()}
            disabled={loading}
            className="inline-flex h-8 items-center rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2.5 text-[11px] font-semibold text-[color:var(--cs-fg)] disabled:cursor-not-allowed disabled:opacity-40"
          >
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>

        {error ? (
          <div className="mt-2 rounded border border-rose-500/30 bg-rose-500/10 px-2 py-1.5 text-[11px] text-rose-300">
            {error}
          </div>
        ) : null}
      </section>

      {scans.length === 0 ? (
        <div className="rounded-md border border-dashed border-[color:var(--cs-border)] px-2 py-3 text-[11px] text-[color:var(--cs-muted)]">
          No ZAP scans yet.
        </div>
      ) : (
        <div className="space-y-2">
          {scans.map((scan) => {
            const selected = selectedScan?.id === scan.id;
            return (
              <section
                key={scan.id}
                className={[
                  'rounded-md border p-2',
                  selected
                    ? 'border-[color:var(--cs-accent)] bg-[color:var(--cs-panel)]'
                    : 'border-[color:var(--cs-border)] bg-[color:var(--cs-panel)]',
                ].join(' ')}
              >
                <button
                  type="button"
                  onClick={() => {
                    setSelectedScanId(scan.id);
                    setSummaryModalOpen(true);
                  }}
                  className="w-full text-left"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="truncate font-mono text-[11px] font-semibold text-[color:var(--cs-fg)]">
                      {scan.id.slice(0, 8)}
                    </div>
                    <div className={['rounded px-1.5 py-0.5 text-[10px] font-bold uppercase', statusBadgeClass(scan.status)].join(' ')}>
                      {scan.status}
                    </div>
                  </div>
                  <div className="mt-1 truncate text-[10px] text-[color:var(--cs-muted)]">{scan.target}</div>
                  <div className="mt-1 text-[10px] text-[color:var(--cs-muted)]">
                    {scan.state.stage} · {scan.state.progress}% · {formatStamp(scan.startedAt)}
                  </div>
                  <div className="mt-1 h-1.5 w-full overflow-hidden rounded bg-[color:var(--cs-hover)]">
                    <div
                      className="h-full bg-[color:var(--cs-accent)] transition-all"
                      style={{ width: `${scan.state.progress}%` }}
                    />
                  </div>
                </button>
              </section>
            );
          })}
        </div>
      )}

      <ScanSummaryModal
        open={summaryModalOpen}
        onOpenChange={setSummaryModalOpen}
        scan={selectedScan}
        onStopScan={runStopScan}
        stoppingScanId={stoppingScanId}
      />
    </div>
  );
}
