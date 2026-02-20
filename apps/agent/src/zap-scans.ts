import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

const DEFAULT_ZAP_API_URL = 'http://127.0.0.1:8080';
const DEFAULT_POLL_INTERVAL_MS = 1500;
const DEFAULT_MAX_DURATION_MS = 30 * 60 * 1000;
const DEFAULT_MAX_ALERTS = 200;

export const ZapScanStatusSchema = z.enum(['queued', 'running', 'stopping', 'completed', 'failed', 'stopped']);
export type ZapScanStatus = z.infer<typeof ZapScanStatusSchema>;

export const ZapScanStageSchema = z.enum([
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
]);
export type ZapScanStage = z.infer<typeof ZapScanStageSchema>;

export const StartZapScanInputSchema = z.object({
  target: z.string().trim().min(1).max(2048),
  spider: z.boolean().optional(),
  ajaxSpider: z.boolean().optional(),
  activeScan: z.boolean().optional(),
  recurse: z.boolean().optional(),
  inScopeOnly: z.boolean().optional(),
  waitForPassiveScan: z.boolean().optional(),
  contextName: z.string().trim().max(120).optional().nullable(),
  scanPolicyName: z.string().trim().max(120).optional().nullable(),
  maxChildren: z.number().int().min(0).max(50_000).optional().nullable(),
  maxAlerts: z.number().int().min(1).max(1000).optional(),
  pollIntervalMs: z.number().int().min(50).max(10_000).optional(),
  maxDurationMs: z.number().int().min(60_000).max(3_600_000).optional(),
  source: z.enum(['ui', 'ai']).optional(),
});

export type ZapRiskCounts = {
  critical: number;
  high: number;
  medium: number;
  low: number;
  informational: number;
  unknown: number;
};

export type ZapAlert = {
  pluginId: string;
  alert: string;
  risk: keyof ZapRiskCounts;
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
  stage: ZapScanStage;
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
  riskCounts: ZapRiskCounts;
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

type ZapScanRow = {
  id: string;
  target: string;
  created_at: string;
  updated_at: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  config_json: string;
  state_json: string;
  summary_json: string;
  error: string | null;
};

type StartZapScanInput = z.infer<typeof StartZapScanInputSchema>;

type ActiveZapTask = {
  cancelled: boolean;
  spiderScanId: string | null;
  activeScanId: string | null;
  ajaxSpiderStarted: boolean;
};

class ZapScanCancelledError extends Error {
  constructor() {
    super('Scan cancelled.');
  }
}

class ZapApiClient {
  #baseUrl: string;
  #apiKey: string | null;

  constructor(baseUrl = DEFAULT_ZAP_API_URL, apiKey = process.env.ZAP_API_KEY ?? null) {
    this.#baseUrl = normalizeZapApiUrl(baseUrl);
    this.#apiKey = normalizeOptionalText(apiKey) ?? null;
  }

  async ping(): Promise<void> {
    await this.#request('/JSON/core/view/version/', {});
  }

  async startSpider(config: { target: string; recurse: boolean; contextName: string | null; maxChildren: number | null }): Promise<string> {
    const out = await this.#request('/JSON/spider/action/scan/', {
      url: config.target,
      recurse: String(config.recurse),
      contextName: config.contextName,
      maxChildren: config.maxChildren,
    });
    const scanId = asString(out.scan) ?? asString(out.scanId);
    if (!scanId) throw new Error('ZAP spider did not return a scan id.');
    return scanId;
  }

  async getSpiderStatus(scanId: string): Promise<number> {
    const out = await this.#request('/JSON/spider/view/status/', { scanId });
    const status = asInt(out.status);
    if (status == null) throw new Error('ZAP spider status payload missing numeric status.');
    return clamp(status, 0, 100);
  }

  async stopSpider(scanId: string): Promise<void> {
    await this.#request('/JSON/spider/action/stop/', { scanId });
  }

  async startAjaxSpider(config: { target: string; inScopeOnly: boolean; contextName: string | null }): Promise<void> {
    await this.#request('/JSON/ajaxSpider/action/scan/', {
      url: config.target,
      inScope: String(config.inScopeOnly),
      contextName: config.contextName,
      subtreeOnly: '',
    });
  }

  async getAjaxSpiderStatus(): Promise<string> {
    const out = await this.#request('/JSON/ajaxSpider/view/status/', {});
    return (asString(out.status) ?? 'unknown').toLowerCase();
  }

  async getAjaxSpiderResultCount(): Promise<number | null> {
    const out = await this.#request('/JSON/ajaxSpider/view/numberOfResults/', {});
    const raw = out.numberOfResults ?? out.numberofresults;
    return asInt(raw);
  }

  async stopAjaxSpider(): Promise<void> {
    await this.#request('/JSON/ajaxSpider/action/stop/', {});
  }

  async getPassiveRecordsToScan(): Promise<number | null> {
    const out = await this.#request('/JSON/pscan/view/recordsToScan/', {});
    return asInt(out.recordsToScan);
  }

  async startActiveScan(config: {
    target: string;
    recurse: boolean;
    inScopeOnly: boolean;
    scanPolicyName: string | null;
  }): Promise<string> {
    const out = await this.#request('/JSON/ascan/action/scan/', {
      url: config.target,
      recurse: String(config.recurse),
      inScopeOnly: String(config.inScopeOnly),
      scanPolicyName: config.scanPolicyName,
      method: '',
      postData: '',
      contextId: '',
    });
    const scanId = asString(out.scan) ?? asString(out.scanId);
    if (!scanId) throw new Error('ZAP active scan did not return a scan id.');
    return scanId;
  }

  async getActiveScanStatus(scanId: string): Promise<number> {
    const out = await this.#request('/JSON/ascan/view/status/', { scanId });
    const status = asInt(out.status);
    if (status == null) throw new Error('ZAP active scan status payload missing numeric status.');
    return clamp(status, 0, 100);
  }

  async stopActiveScan(scanId: string): Promise<void> {
    await this.#request('/JSON/ascan/action/stop/', { scanId });
  }

  async listAlerts(baseUrl: string, maxAlerts: number): Promise<ZapAlert[]> {
    const out: ZapAlert[] = [];
    let offset = 0;
    const pageSize = 500;

    while (out.length < maxAlerts) {
      const count = Math.min(pageSize, maxAlerts - out.length);
      const payload = await this.#request('/JSON/alert/view/alerts/', {
        baseurl: baseUrl,
        start: offset,
        count,
      });
      const items = Array.isArray(payload.alerts) ? payload.alerts : [];
      if (items.length === 0) break;
      for (const item of items) {
        const parsed = parseAlert(item);
        if (parsed) out.push(parsed);
        if (out.length >= maxAlerts) break;
      }
      offset += items.length;
      if (items.length < count) break;
    }

    return out;
  }

  async alertsSummary(baseUrl: string): Promise<ZapRiskCounts | null> {
    const payload = await this.#request('/JSON/alert/view/alertsSummary/', { baseurl: baseUrl });
    const raw = asRecord(payload.alertsSummary);
    if (!raw) return null;

    const counts = emptyRiskCounts();
    counts.critical = asInt(raw.Critical) ?? asInt(raw.critical) ?? 0;
    counts.high = asInt(raw.High) ?? asInt(raw.high) ?? 0;
    counts.medium = asInt(raw.Medium) ?? asInt(raw.medium) ?? 0;
    counts.low = asInt(raw.Low) ?? asInt(raw.low) ?? 0;
    counts.informational = asInt(raw.Informational) ?? asInt(raw.informational) ?? asInt(raw.Info) ?? 0;
    counts.unknown = asInt(raw.Unknown) ?? asInt(raw.unknown) ?? 0;
    return counts;
  }

  async #request(path: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const url = new URL(`${this.#baseUrl}${path}`);
    if (this.#apiKey) url.searchParams.set('apikey', this.#apiKey);
    for (const [key, value] of Object.entries(params)) {
      if (value == null) continue;
      if (typeof value === 'string' && value.length === 0) continue;
      url.searchParams.set(key, String(value));
    }

    const res = await fetch(url.toString(), {
      method: 'GET',
      cache: 'no-store',
    });

    const text = await res.text();
    let payload: unknown;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`ZAP returned non-JSON response for ${path}.`);
    }

    if (!res.ok) {
      throw new Error(`ZAP request failed (${res.status}) for ${path}.`);
    }

    const rec = asRecord(payload);
    if (!rec) {
      throw new Error(`ZAP returned unexpected payload for ${path}.`);
    }

    if (typeof rec.code === 'string' && typeof rec.message === 'string') {
      throw new Error(`ZAP error (${rec.code}): ${rec.message}`);
    }

    const err = asRecord(rec.error);
    if (err && typeof err.code === 'string' && typeof err.message === 'string') {
      throw new Error(`ZAP error (${err.code}): ${err.message}`);
    }

    return rec;
  }
}

const activeTasks = new Map<string, ActiveZapTask>();

function emptyRiskCounts(): ZapRiskCounts {
  return {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    informational: 0,
    unknown: 0,
  };
}

function defaultSummary(): ZapScanSummary {
  return {
    alertsTotal: 0,
    riskCounts: emptyRiskCounts(),
    alerts: [],
  };
}

function defaultState(): ZapScanState {
  return {
    stage: 'queued',
    detail: 'Queued',
    progress: 0,
    spiderScanId: null,
    spiderProgress: null,
    ajaxStatus: null,
    ajaxResults: null,
    activeScanId: null,
    activeProgress: null,
    passiveRecordsToScan: null,
  };
}

function ensureNotCancelled(task: ActiveZapTask) {
  if (task.cancelled) throw new ZapScanCancelledError();
}

function nowIso(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeZapApiUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return DEFAULT_ZAP_API_URL;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Invalid ZAP_API_URL: ${trimmed}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Invalid ZAP_API_URL protocol: ${parsed.protocol}`);
  }
  const base = parsed.toString().replace(/\/+$/, '');
  return base;
}

function sanitizeTarget(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error('Target must be a valid URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Target must use http or https.');
  }
  url.hash = '';
  return url.toString();
}

function normalizeOptionalText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function asInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function parseJsonObject<T extends object>(value: string, fallback: T): T {
  try {
    const parsed = JSON.parse(value) as unknown;
    const rec = asRecord(parsed);
    if (!rec) return fallback;
    return rec as T;
  } catch {
    return fallback;
  }
}

function parseAlert(value: unknown): ZapAlert | null {
  const rec = asRecord(value);
  if (!rec) return null;

  const pluginId = asString(rec.pluginId) ?? '';
  const alert = asString(rec.alert) ?? asString(rec.name) ?? '';
  if (!alert) return null;

  const risk = normalizeRisk(rec.risk, rec.riskdesc);

  return {
    pluginId,
    alert,
    risk,
    confidence: asString(rec.confidence),
    url: asString(rec.url),
    param: asString(rec.param),
    attack: asString(rec.attack),
    evidence: asString(rec.evidence),
    cweId: asInt(rec.cweid),
    wascId: asInt(rec.wascid),
    description: asString(rec.description),
    solution: asString(rec.solution),
    reference: asString(rec.reference),
  };
}

function normalizeRisk(risk: unknown, riskDesc: unknown): keyof ZapRiskCounts {
  const raw = `${asString(risk) ?? ''} ${asString(riskDesc) ?? ''}`.trim().toLowerCase();
  if (raw.includes('critical')) return 'critical';
  if (raw.includes('high')) return 'high';
  if (raw.includes('medium')) return 'medium';
  if (raw.includes('low')) return 'low';
  if (raw.includes('inform')) return 'informational';
  return 'unknown';
}

function toZapScanRecord(row: ZapScanRow): ZapScanRecord | null {
  const status = ZapScanStatusSchema.safeParse(row.status);
  if (!status.success) return null;

  const config = parseJsonObject<ZapScanConfig>(row.config_json, {
    spider: true,
    ajaxSpider: false,
    activeScan: true,
    recurse: true,
    inScopeOnly: false,
    waitForPassiveScan: true,
    contextName: null,
    scanPolicyName: null,
    maxChildren: null,
    maxAlerts: DEFAULT_MAX_ALERTS,
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    maxDurationMs: DEFAULT_MAX_DURATION_MS,
    source: 'ui',
  });

  const state = parseJsonObject<ZapScanState>(row.state_json, defaultState());
  const summary = parseJsonObject<ZapScanSummary>(row.summary_json, defaultSummary());

  return {
    id: row.id,
    target: row.target,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    status: status.data,
    config,
    state,
    summary,
    error: row.error,
  };
}

function saveScan(db: DatabaseSync, scan: ZapScanRecord): void {
  db.prepare(
    `
      INSERT INTO zap_scans (
        id,
        target,
        created_at,
        updated_at,
        started_at,
        finished_at,
        status,
        config_json,
        state_json,
        summary_json,
        error
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        target=excluded.target,
        updated_at=excluded.updated_at,
        finished_at=excluded.finished_at,
        status=excluded.status,
        config_json=excluded.config_json,
        state_json=excluded.state_json,
        summary_json=excluded.summary_json,
        error=excluded.error
    `,
  ).run(
    scan.id,
    scan.target,
    scan.createdAt,
    scan.updatedAt,
    scan.startedAt,
    scan.finishedAt,
    scan.status,
    JSON.stringify(scan.config),
    JSON.stringify(scan.state),
    JSON.stringify(scan.summary),
    scan.error,
  );
}

function setScanStatus(
  db: DatabaseSync,
  scan: ZapScanRecord,
  update: {
    status?: ZapScanStatus;
    finishedAt?: string | null;
    error?: string | null;
    state?: Partial<ZapScanState>;
    summary?: ZapScanSummary;
  },
): ZapScanRecord {
  const next: ZapScanRecord = {
    ...scan,
    updatedAt: nowIso(),
    status: update.status ?? scan.status,
    finishedAt: update.finishedAt === undefined ? scan.finishedAt : update.finishedAt,
    error: update.error === undefined ? scan.error : update.error,
    state: update.state ? { ...scan.state, ...update.state } : scan.state,
    summary: update.summary ?? scan.summary,
  };
  saveScan(db, next);
  return next;
}

function isTerminalStatus(status: ZapScanStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'stopped';
}

function loadScanRow(db: DatabaseSync, scanId: string): ZapScanRecord | null {
  const row = db
    .prepare(
      `
      SELECT
        id,
        target,
        created_at,
        updated_at,
        started_at,
        finished_at,
        status,
        config_json,
        state_json,
        summary_json,
        error
      FROM zap_scans
      WHERE id = ?
      LIMIT 1
    `,
    )
    .get(scanId) as ZapScanRow | undefined;

  if (!row) return null;
  return toZapScanRecord(row);
}

function computeRiskCounts(alerts: ZapAlert[]): ZapRiskCounts {
  const counts = emptyRiskCounts();
  for (const alert of alerts) {
    counts[alert.risk] += 1;
  }
  return counts;
}

function resolveProgressStartEnd(config: ZapScanConfig): Record<'spider' | 'ajax_spider' | 'passive_scan' | 'active_scan', { start: number; end: number }> {
  const phases: Array<'spider' | 'ajax_spider' | 'passive_scan' | 'active_scan'> = [];
  if (config.spider) phases.push('spider');
  if (config.ajaxSpider) phases.push('ajax_spider');
  if (config.waitForPassiveScan) phases.push('passive_scan');
  if (config.activeScan) phases.push('active_scan');

  const plan: Record<'spider' | 'ajax_spider' | 'passive_scan' | 'active_scan', { start: number; end: number }> = {
    spider: { start: 5, end: 5 },
    ajax_spider: { start: 5, end: 5 },
    passive_scan: { start: 5, end: 5 },
    active_scan: { start: 5, end: 5 },
  };

  if (phases.length === 0) return plan;

  const start = 5;
  const end = 95;
  const span = (end - start) / phases.length;

  for (let i = 0; i < phases.length; i += 1) {
    const phase = phases[i];
    if (!phase) continue;
    plan[phase] = {
      start: Math.round(start + i * span),
      end: Math.round(start + (i + 1) * span),
    };
  }

  return plan;
}

function phaseProgress(
  plan: Record<'spider' | 'ajax_spider' | 'passive_scan' | 'active_scan', { start: number; end: number }>,
  phase: 'spider' | 'ajax_spider' | 'passive_scan' | 'active_scan',
  percent: number,
): number {
  const bounded = clamp(percent, 0, 100);
  const range = plan[phase];
  const delta = range.end - range.start;
  return clamp(Math.round(range.start + (delta * bounded) / 100), 0, 100);
}

async function stopScanInZap(client: ZapApiClient, task: ActiveZapTask): Promise<void> {
  if (task.spiderScanId) {
    await client.stopSpider(task.spiderScanId).catch(() => undefined);
  }
  if (task.activeScanId) {
    await client.stopActiveScan(task.activeScanId).catch(() => undefined);
  }
  if (task.ajaxSpiderStarted) {
    await client.stopAjaxSpider().catch(() => undefined);
  }
}

async function executeScanTask(db: DatabaseSync, scanId: string, task: ActiveZapTask): Promise<void> {
  let scan = loadScanRow(db, scanId);
  if (!scan) return;

  const deadline = Date.now() + scan.config.maxDurationMs;
  const progressPlan = resolveProgressStartEnd(scan.config);
  const client = new ZapApiClient(process.env.ZAP_API_URL ?? DEFAULT_ZAP_API_URL);

  const ensureWithinDeadline = (stageLabel: string) => {
    if (Date.now() > deadline) {
      throw new Error(`ZAP scan exceeded maxDurationMs while ${stageLabel}.`);
    }
  };

  try {
    scan = setScanStatus(db, scan, {
      status: 'running',
      error: null,
      state: {
        stage: 'connecting',
        detail: 'Connecting to ZAP API',
        progress: 1,
      },
    });

    ensureNotCancelled(task);
    ensureWithinDeadline('connecting to ZAP');
    await client.ping();

    if (scan.config.spider) {
      ensureNotCancelled(task);
      ensureWithinDeadline('starting spider');
      const spiderScanId = await client.startSpider({
        target: scan.target,
        recurse: scan.config.recurse,
        contextName: scan.config.contextName,
        maxChildren: scan.config.maxChildren,
      });
      task.spiderScanId = spiderScanId;

      scan = setScanStatus(db, scan, {
        state: {
          stage: 'spider',
          detail: `Spider scan ${spiderScanId} started`,
          spiderScanId,
          spiderProgress: 0,
          progress: phaseProgress(progressPlan, 'spider', 0),
        },
      });

      while (true) {
        ensureNotCancelled(task);
        ensureWithinDeadline('running spider');
        const status = await client.getSpiderStatus(spiderScanId);
        scan = setScanStatus(db, scan, {
          state: {
            stage: 'spider',
            detail: `Spider scan ${status}%`,
            spiderProgress: status,
            progress: phaseProgress(progressPlan, 'spider', status),
          },
        });
        if (status >= 100) break;
        await sleep(scan.config.pollIntervalMs);
      }
    }

    if (scan.config.ajaxSpider) {
      ensureNotCancelled(task);
      ensureWithinDeadline('starting ajax spider');
      await client.startAjaxSpider({
        target: scan.target,
        inScopeOnly: scan.config.inScopeOnly,
        contextName: scan.config.contextName,
      });
      task.ajaxSpiderStarted = true;

      scan = setScanStatus(db, scan, {
        state: {
          stage: 'ajax_spider',
          detail: 'Ajax spider running',
          ajaxStatus: 'running',
          progress: phaseProgress(progressPlan, 'ajax_spider', 10),
        },
      });

      while (true) {
        ensureNotCancelled(task);
        ensureWithinDeadline('running ajax spider');
        const [status, resultCount] = await Promise.all([
          client.getAjaxSpiderStatus(),
          client.getAjaxSpiderResultCount(),
        ]);
        const done = status === 'stopped';
        scan = setScanStatus(db, scan, {
          state: {
            stage: 'ajax_spider',
            detail: done ? 'Ajax spider completed' : 'Ajax spider running',
            ajaxStatus: status,
            ajaxResults: resultCount,
            progress: phaseProgress(progressPlan, 'ajax_spider', done ? 100 : 55),
          },
        });
        if (done) break;
        await sleep(scan.config.pollIntervalMs);
      }
    }

    if (scan.config.waitForPassiveScan) {
      ensureNotCancelled(task);
      ensureWithinDeadline('waiting for passive scanner');
      let initialRecords: number | null = null;
      while (true) {
        ensureNotCancelled(task);
        ensureWithinDeadline('waiting for passive scanner');
        const records = await client.getPassiveRecordsToScan();
        if (records != null && initialRecords == null && records > 0) {
          initialRecords = records;
        }
        const pct =
          records == null ? 5
          : records <= 0 ? 100
          : initialRecords && initialRecords > 0 ? Math.round((1 - records / initialRecords) * 100)
          : 10;

        scan = setScanStatus(db, scan, {
          state: {
            stage: 'passive_scan',
            detail:
              records == null ? 'Waiting for passive scanner queue'
              : records <= 0 ? 'Passive scanner queue drained'
              : `Passive scanner queue: ${records}`,
            passiveRecordsToScan: records,
            progress: phaseProgress(progressPlan, 'passive_scan', clamp(pct, 0, 100)),
          },
        });

        if (records != null && records <= 0) break;
        await sleep(scan.config.pollIntervalMs);
      }
    }

    if (scan.config.activeScan) {
      ensureNotCancelled(task);
      ensureWithinDeadline('starting active scan');
      const activeScanId = await client.startActiveScan({
        target: scan.target,
        recurse: scan.config.recurse,
        inScopeOnly: scan.config.inScopeOnly,
        scanPolicyName: scan.config.scanPolicyName,
      });
      task.activeScanId = activeScanId;

      scan = setScanStatus(db, scan, {
        state: {
          stage: 'active_scan',
          detail: `Active scan ${activeScanId} started`,
          activeScanId,
          activeProgress: 0,
          progress: phaseProgress(progressPlan, 'active_scan', 0),
        },
      });

      while (true) {
        ensureNotCancelled(task);
        ensureWithinDeadline('running active scan');
        const status = await client.getActiveScanStatus(activeScanId);
        scan = setScanStatus(db, scan, {
          state: {
            stage: 'active_scan',
            detail: `Active scan ${status}%`,
            activeProgress: status,
            progress: phaseProgress(progressPlan, 'active_scan', status),
          },
        });

        if (status >= 100) break;
        await sleep(scan.config.pollIntervalMs);
      }
    }

    ensureNotCancelled(task);
    ensureWithinDeadline('collecting alerts');
    scan = setScanStatus(db, scan, {
      state: {
        stage: 'collecting_alerts',
        detail: 'Collecting ZAP alerts',
        progress: 97,
      },
    });

    const alerts = await client.listAlerts(scan.target, scan.config.maxAlerts);
    let riskCounts = computeRiskCounts(alerts);
    const summaryCounts = await client.alertsSummary(scan.target).catch(() => null);
    if (summaryCounts) riskCounts = summaryCounts;

    const alertsTotalFromCounts = Object.values(riskCounts).reduce((sum, value) => sum + value, 0);
    const summary: ZapScanSummary = {
      alertsTotal: Math.max(alerts.length, alertsTotalFromCounts),
      riskCounts,
      alerts,
    };

    scan = setScanStatus(db, scan, {
      status: 'completed',
      finishedAt: nowIso(),
      error: null,
      summary,
      state: {
        stage: 'completed',
        detail: 'Scan completed',
        progress: 100,
        passiveRecordsToScan: 0,
      },
    });
  } catch (err) {
    if (err instanceof ZapScanCancelledError) {
      await stopScanInZap(client, task);
      scan = setScanStatus(db, scan, {
        status: 'stopped',
        finishedAt: nowIso(),
        error: null,
        state: {
          stage: 'stopped',
          detail: 'Scan stopped',
        },
      });
      return;
    }

    const message = err instanceof Error ? err.message : String(err);
    scan = setScanStatus(db, scan, {
      status: 'failed',
      finishedAt: nowIso(),
      error: message,
      state: {
        stage: 'failed',
        detail: message,
      },
    });
  }
}

function normalizeStartInput(input: StartZapScanInput): { target: string; config: ZapScanConfig } {
  const target = sanitizeTarget(input.target);
  const config: ZapScanConfig = {
    spider: input.spider ?? true,
    ajaxSpider: input.ajaxSpider ?? false,
    activeScan: input.activeScan ?? true,
    recurse: input.recurse ?? true,
    inScopeOnly: input.inScopeOnly ?? false,
    waitForPassiveScan: input.waitForPassiveScan ?? true,
    contextName: normalizeOptionalText(input.contextName),
    scanPolicyName: normalizeOptionalText(input.scanPolicyName),
    maxChildren: input.maxChildren ?? null,
    maxAlerts: input.maxAlerts ?? DEFAULT_MAX_ALERTS,
    pollIntervalMs: input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    maxDurationMs: input.maxDurationMs ?? DEFAULT_MAX_DURATION_MS,
    source: input.source ?? 'ui',
  };

  if (!config.spider && !config.ajaxSpider && !config.activeScan) {
    throw new Error('Select at least one scan stage (spider, ajax spider, or active scan).');
  }

  return { target, config };
}

export async function startZapScan(input: { db: DatabaseSync; request: unknown }): Promise<ZapScanRecord> {
  const parsed = StartZapScanInputSchema.parse(input.request);
  const normalized = normalizeStartInput(parsed);
  const createdAt = nowIso();

  const scan: ZapScanRecord = {
    id: randomUUID(),
    target: normalized.target,
    createdAt,
    updatedAt: createdAt,
    startedAt: createdAt,
    finishedAt: null,
    status: 'queued',
    config: normalized.config,
    state: defaultState(),
    summary: defaultSummary(),
    error: null,
  };

  saveScan(input.db, scan);

  const task: ActiveZapTask = {
    cancelled: false,
    spiderScanId: null,
    activeScanId: null,
    ajaxSpiderStarted: false,
  };
  activeTasks.set(scan.id, task);

  queueMicrotask(() => {
    void executeScanTask(input.db, scan.id, task)
      .catch(() => undefined)
      .finally(() => {
        activeTasks.delete(scan.id);
      });
  });

  return scan;
}

export function getZapScan(input: { db: DatabaseSync; scanId: string }): ZapScanRecord | null {
  return loadScanRow(input.db, input.scanId);
}

export function listZapScans(input: {
  db: DatabaseSync;
  limit?: number;
  offset?: number;
  status?: ZapScanStatus;
}): ZapScanRecord[] {
  const limit = clamp(input.limit ?? 50, 1, 200);
  const offset = Math.max(0, input.offset ?? 0);

  const rows =
    input.status ?
      (input.db
        .prepare(
          `
          SELECT
            id,
            target,
            created_at,
            updated_at,
            started_at,
            finished_at,
            status,
            config_json,
            state_json,
            summary_json,
            error
          FROM zap_scans
          WHERE status = ?
          ORDER BY created_at DESC
          LIMIT ? OFFSET ?
        `,
        )
        .all(input.status, limit, offset) as ZapScanRow[])
    : (input.db
        .prepare(
          `
          SELECT
            id,
            target,
            created_at,
            updated_at,
            started_at,
            finished_at,
            status,
            config_json,
            state_json,
            summary_json,
            error
          FROM zap_scans
          ORDER BY created_at DESC
          LIMIT ? OFFSET ?
        `,
        )
        .all(limit, offset) as ZapScanRow[]);

  const out: ZapScanRecord[] = [];
  for (const row of rows) {
    const parsed = toZapScanRecord(row);
    if (parsed) out.push(parsed);
  }
  return out;
}

export async function stopZapScan(input: { db: DatabaseSync; scanId: string }): Promise<ZapScanRecord | null> {
  let scan = loadScanRow(input.db, input.scanId);
  if (!scan) return null;
  if (isTerminalStatus(scan.status)) return scan;

  const task = activeTasks.get(input.scanId);
  if (!task) {
    scan = setScanStatus(input.db, scan, {
      status: 'stopped',
      finishedAt: nowIso(),
      error: null,
      state: {
        stage: 'stopped',
        detail: 'Scan stopped',
      },
    });
    return scan;
  }

  task.cancelled = true;
  const client = new ZapApiClient(process.env.ZAP_API_URL ?? DEFAULT_ZAP_API_URL);
  await stopScanInZap(client, task);

  scan = loadScanRow(input.db, input.scanId) ?? scan;
  if (!isTerminalStatus(scan.status)) {
    scan = setScanStatus(input.db, scan, {
      status: 'stopping',
      state: {
        stage: scan.state.stage,
        detail: 'Stop requested',
      },
    });
  }

  return scan;
}
