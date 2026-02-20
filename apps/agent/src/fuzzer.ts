import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  FuzzCampaignConfigSchema,
  FuzzCampaignResponseSchema,
  type AgentEvent,
  type FuzzCampaignConfig,
  type FuzzCampaignRequest,
  type FuzzCampaignResponse,
  type FuzzCaseResult,
  type FuzzCluster,
  type ReplayOverrides,
} from '@cipherscope/proto';
import { ReplayError, replayOnce } from './replay.js';
import { getHttpMessage } from './store.js';

type MutationOp =
  | {
      operation: 'set';
      kind: string;
      label: string;
      value: unknown;
    }
  | {
      operation: 'remove';
      kind: string;
      label: string;
    };

type MutationCandidate = MutationOp & {
  id: string;
  path: string;
  order: number;
};

type CaseExecution = {
  order: number;
  caseId: string;
  mutationKind: string;
  mutationLabel: string;
  mutationPath: string;
  operation: 'set' | 'remove';
  before?: unknown;
  after?: unknown;
  variantId: string;
  status: number | null;
  error: string | null;
  totalMs: number | null;
  responseShape: string;
  clusterKey: string;
  anomaly: FuzzCaseResult['anomaly'];
  diff: FuzzCaseResult['diff'];
};

export type RunFuzzCampaignInput = {
  db: DatabaseSync;
  request: FuzzCampaignRequest;
  publishEvent?: (evt: AgentEvent) => void;
  invokeLocal?: (input: {
    method: 'POST' | 'GET';
    url: string;
    payload?: unknown;
  }) => Promise<{ statusCode: number; body: unknown }>;
};

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (!isPlainObject(v)) return v;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(v).sort()) out[key] = v[key];
    return out;
  });
}

function cloneJson<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

function classifyType(value: unknown):
  | 'number'
  | 'string'
  | 'boolean'
  | 'array'
  | 'object'
  | 'null'
  | 'unknown' {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'boolean') return 'boolean';
  if (isPlainObject(value)) return 'object';
  return 'unknown';
}

function pointerToSegments(path: string): string[] {
  if (!path.startsWith('/')) {
    throw new ReplayError({
      code: 'bad_request',
      statusCode: 400,
      message: `fieldPath must start with '/': ${path}`,
    });
  }
  if (path === '/') return [];
  return path
    .split('/')
    .slice(1)
    .map((seg) => seg.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function getAtPath(root: unknown, path: string[]): { found: boolean; value: unknown } {
  let cur: unknown = root;
  for (const seg of path) {
    if (Array.isArray(cur)) {
      const idx = Number(seg);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) return { found: false, value: undefined };
      cur = cur[idx];
      continue;
    }
    if (isPlainObject(cur)) {
      if (!Object.prototype.hasOwnProperty.call(cur, seg)) return { found: false, value: undefined };
      cur = cur[seg];
      continue;
    }
    return { found: false, value: undefined };
  }
  return { found: true, value: cur };
}

function setAtPath(root: unknown, path: string[], value: unknown): { ok: boolean; out: unknown } {
  if (path.length === 0) return { ok: true, out: value };
  const out = cloneJson(root);
  let cur: unknown = out;

  for (let i = 0; i < path.length - 1; i += 1) {
    const seg = path[i];
    if (seg == null) return { ok: false, out: root };
    if (Array.isArray(cur)) {
      const idx = Number(seg);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) return { ok: false, out: root };
      cur = cur[idx];
      continue;
    }
    if (isPlainObject(cur)) {
      if (!Object.prototype.hasOwnProperty.call(cur, seg)) return { ok: false, out: root };
      cur = cur[seg];
      continue;
    }
    return { ok: false, out: root };
  }

  const last = path[path.length - 1];
  if (last == null) return { ok: false, out: root };
  if (Array.isArray(cur)) {
    const idx = Number(last);
    if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) return { ok: false, out: root };
    cur[idx] = value;
    return { ok: true, out };
  }
  if (isPlainObject(cur)) {
    cur[last] = value;
    return { ok: true, out };
  }
  return { ok: false, out: root };
}

function removeAtPath(root: unknown, path: string[]): { ok: boolean; out: unknown } {
  if (path.length === 0) return { ok: false, out: root };
  const out = cloneJson(root);
  let cur: unknown = out;

  for (let i = 0; i < path.length - 1; i += 1) {
    const seg = path[i];
    if (seg == null) return { ok: false, out: root };
    if (Array.isArray(cur)) {
      const idx = Number(seg);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) return { ok: false, out: root };
      cur = cur[idx];
      continue;
    }
    if (isPlainObject(cur)) {
      if (!Object.prototype.hasOwnProperty.call(cur, seg)) return { ok: false, out: root };
      cur = cur[seg];
      continue;
    }
    return { ok: false, out: root };
  }

  const last = path[path.length - 1];
  if (last == null) return { ok: false, out: root };
  if (Array.isArray(cur)) {
    const idx = Number(last);
    if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) return { ok: false, out: root };
    cur.splice(idx, 1);
    return { ok: true, out };
  }

  if (isPlainObject(cur)) {
    if (!Object.prototype.hasOwnProperty.call(cur, last)) return { ok: false, out: root };
    delete cur[last];
    return { ok: true, out };
  }

  return { ok: false, out: root };
}

function shapeSignature(value: unknown, depth = 0): string {
  if (value === null) return 'null';
  if (depth >= 2) {
    if (Array.isArray(value)) return 'array';
    if (isPlainObject(value)) return 'object';
    return typeof value;
  }
  if (Array.isArray(value)) {
    const types = new Set(value.map((v) => shapeSignature(v, depth + 1)));
    return `array<${[...types].sort().join('|')}>`;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    const trimmed = keys.slice(0, 10);
    const parts = trimmed.map((k) => `${k}:${shapeSignature(value[k], depth + 1)}`);
    const suffix = keys.length > trimmed.length ? `,+${keys.length - trimmed.length}` : '';
    return `object{${parts.join(',')}${suffix}}`;
  }
  return typeof value;
}

function responseShapeSignature(input: {
  bodyJson: unknown | null;
  bodyText: string | null;
  bodyBase64: string | null;
}): string {
  if (input.bodyJson != null) return `json:${shapeSignature(input.bodyJson)}`;
  if (input.bodyText != null) {
    const trimmed = input.bodyText.trim();
    if (!trimmed) return 'text:empty';
    if (trimmed.startsWith('<')) return 'text:html';
    return `text:${Math.min(2048, trimmed.length)}`;
  }
  if (input.bodyBase64 != null) return 'binary';
  return 'empty';
}

function errorSignature(error: string | null): string {
  if (!error) return 'none';
  const lower = error.toLowerCase();
  if (lower.includes('timed out')) return 'timeout';
  if (lower.includes('econnrefused')) return 'econnrefused';
  if (lower.includes('econnreset')) return 'econnreset';
  if (lower.includes('enotfound')) return 'enotfound';
  return lower.replace(/\d+/g, '#').slice(0, 100);
}

function dedupeMutations(items: MutationOp[], path: string, maxCases: number): MutationCandidate[] {
  const out: MutationCandidate[] = [];
  const seen = new Set<string>();
  let order = 0;

  for (const m of items) {
    const key =
      m.operation === 'set'
        ? `${m.operation}|${m.kind}|${stableStringify(m.value)}`
        : `${m.operation}|${m.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      id: randomUUID(),
      path,
      order,
      ...m,
    });
    order += 1;
    if (out.length >= maxCases) break;
  }

  return out;
}

function looksHexQuantity(value: string): boolean {
  return /^0x[0-9a-f]+$/i.test(value);
}

function looksAddress(value: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(value);
}

function buildMutations(input: {
  root: unknown;
  fieldPath: string;
  fieldValue: unknown;
  maxCases: number;
}): MutationCandidate[] {
  const items: MutationOp[] = [];
  const t = classifyType(input.fieldValue);
  const isJsonRpc =
    isPlainObject(input.root) &&
    typeof input.root.jsonrpc === 'string' &&
    (Array.isArray(input.root.params) || isPlainObject(input.root.params));

  const addSet = (kind: string, label: string, value: unknown) => {
    items.push({ operation: 'set', kind, label, value });
  };
  const addRemove = (kind: string, label: string) => {
    items.push({ operation: 'remove', kind, label });
  };

  switch (t) {
    case 'number': {
      const n = input.fieldValue as number;
      const values = [0, 1, -1, n + 1, n - 1, n * 2, n * 10, Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER].filter(
        Number.isFinite,
      );
      for (const v of values) addSet('number_boundary', `set number = ${v}`, v);
      break;
    }
    case 'string': {
      const s = input.fieldValue as string;
      const long = 'A'.repeat(Math.min(512, Math.max(64, s.length * 4 || 128)));
      addSet('string_boundary', 'set string = empty', '');
      addSet('string_boundary', 'set string = single-space', ' ');
      addSet('string_boundary', 'set string = duplicated', `${s}${s}`.slice(0, 2048));
      addSet('string_boundary', `set string = ${long.length} chars`, long);
      addSet('string_boundary', 'set string = null literal', 'null');
      addSet('string_boundary', 'set string = path traversal sample', '../../etc/passwd');
      if (looksHexQuantity(s)) {
        addSet('hex_quantity', 'set hex quantity = 0x0', '0x0');
        addSet('hex_quantity', 'set hex quantity = 0x1', '0x1');
        addSet('hex_quantity', 'set hex quantity = max uint64', '0xffffffffffffffff');
        addSet('hex_quantity', 'set hex quantity = malformed 0x', '0x');
      }
      if (looksAddress(s)) {
        addSet('eth_address', 'set address = zero address', '0x0000000000000000000000000000000000000000');
        addSet('eth_address', 'set address = malformed short', '0x1234');
      }
      break;
    }
    case 'boolean': {
      const b = input.fieldValue as boolean;
      addSet('boolean_flip', `set boolean = ${String(!b)}`, !b);
      addSet('boolean_flip', 'set boolean = true', true);
      addSet('boolean_flip', 'set boolean = false', false);
      break;
    }
    case 'array': {
      const arr = input.fieldValue as unknown[];
      addSet('array_shape', 'set array = empty', []);
      addSet('array_shape', 'set array = first element only', arr.slice(0, 1));
      addSet('array_shape', 'set array = append null', [...arr, null]);
      if (arr.length > 1) addSet('array_shape', 'set array = drop first element', arr.slice(1));
      break;
    }
    case 'object': {
      const obj = input.fieldValue as Record<string, unknown>;
      addSet('object_shape', 'set object = empty', {});
      const firstKey = Object.keys(obj)[0];
      if (firstKey) addSet('object_shape', 'set object = first key only', { [firstKey]: obj[firstKey] });
      addSet('object_shape', 'set object = add fuzz marker', { ...obj, fuzz: true });
      break;
    }
    case 'null': {
      addSet('null_flip', 'set null = 0', 0);
      addSet('null_flip', 'set null = empty string', '');
      addSet('null_flip', 'set null = false', false);
      addSet('null_flip', 'set null = empty object', {});
      break;
    }
    default: {
      addSet('fallback', 'set value = null', null);
      addSet('fallback', 'set value = empty string', '');
      break;
    }
  }

  if (input.fieldPath !== '/') {
    addRemove('remove_field', 'remove field');
  }

  if (isJsonRpc) {
    if (input.fieldPath.startsWith('/params')) {
      addSet('jsonrpc_params', 'set JSON-RPC params = empty array', []);
      addSet('jsonrpc_params', 'set JSON-RPC params = [null]', [null]);
      if (input.fieldPath !== '/') addRemove('jsonrpc_params', 'remove JSON-RPC param');
    }
    if (input.fieldPath === '/method') {
      addSet('jsonrpc_method', 'set method = eth_call', 'eth_call');
      addSet('jsonrpc_method', 'set method = net_version', 'net_version');
      addSet('jsonrpc_method', 'set method = invalid_method', 'invalid_method');
    }
    if (input.fieldPath === '/id') {
      addSet('jsonrpc_id', 'set id = 0', 0);
      addSet('jsonrpc_id', 'set id = large integer', Number.MAX_SAFE_INTEGER);
      addSet('jsonrpc_id', 'set id = string literal', '999999999999');
    }
  }

  return dedupeMutations(items, input.fieldPath, input.maxCases);
}

async function maybeSnapshot(input: {
  config: FuzzCampaignConfig;
  invokeLocal?: RunFuzzCampaignInput['invokeLocal'];
  warnings: string[];
}): Promise<{ attempted: boolean; snapshotId: string | null; reverted: boolean; warning: string | null }> {
  const out = { attempted: false, snapshotId: null as string | null, reverted: false, warning: null as string | null };
  if (!input.config.anvilSnapshot) return out;
  if (!input.invokeLocal) {
    out.warning = 'Anvil snapshot requested but local invocation is unavailable.';
    input.warnings.push(out.warning);
    return out;
  }

  out.attempted = true;
  try {
    const res = await input.invokeLocal({ method: 'POST', url: '/evm/snapshot' });
    const body = res.body as { ok?: unknown; snapshotId?: unknown; error?: { code?: unknown } };
    if (res.statusCode >= 200 && res.statusCode < 300 && body?.ok === true && typeof body.snapshotId === 'string') {
      out.snapshotId = body.snapshotId;
      return out;
    }
    const code = typeof body?.error?.code === 'string' ? body.error.code : null;
    out.warning = code
      ? `Anvil snapshot unavailable (${code}); campaign continued without snapshot.`
      : 'Anvil snapshot unavailable; campaign continued without snapshot.';
    input.warnings.push(out.warning);
    return out;
  } catch (err) {
    out.warning = `Anvil snapshot failed: ${err instanceof Error ? err.message : String(err)}`;
    input.warnings.push(out.warning);
    return out;
  }
}

async function maybeRevert(input: {
  config: FuzzCampaignConfig;
  snapshotId: string | null;
  invokeLocal?: RunFuzzCampaignInput['invokeLocal'];
  warnings: string[];
}): Promise<{ reverted: boolean; warning: string | null }> {
  if (!input.config.revertAfterRun || !input.snapshotId) {
    return { reverted: false, warning: null };
  }
  if (!input.invokeLocal) {
    const warning = 'Anvil revert requested but local invocation is unavailable.';
    input.warnings.push(warning);
    return { reverted: false, warning };
  }

  try {
    const res = await input.invokeLocal({
      method: 'POST',
      url: '/evm/revert',
      payload: { snapshotId: input.snapshotId },
    });
    const body = res.body as { ok?: unknown; reverted?: unknown; error?: { code?: unknown } };
    if (res.statusCode >= 200 && res.statusCode < 300 && body?.ok === true) {
      return { reverted: body.reverted === true, warning: null };
    }

    const code = typeof body?.error?.code === 'string' ? body.error.code : null;
    const warning = code
      ? `Anvil revert unavailable (${code}); state was not reverted automatically.`
      : 'Anvil revert unavailable; state was not reverted automatically.';
    input.warnings.push(warning);
    return { reverted: false, warning };
  } catch (err) {
    const warning = `Anvil revert failed: ${err instanceof Error ? err.message : String(err)}`;
    input.warnings.push(warning);
    return { reverted: false, warning };
  }
}

export async function runFuzzCampaign(input: RunFuzzCampaignInput): Promise<FuzzCampaignResponse> {
  const baseline = getHttpMessage(input.db, input.request.messageId);
  if (!baseline) {
    throw new ReplayError({ code: 'not_found', statusCode: 404, message: 'No such baseline message.' });
  }

  if (baseline.scheme !== 'http' && baseline.scheme !== 'https') {
    throw new ReplayError({
      code: 'bad_request',
      statusCode: 400,
      message: `Fuzzer only supports http/https messages (got ${baseline.scheme}).`,
    });
  }

  const requestBodyJson =
    baseline.request.bodyJson != null
      ? baseline.request.bodyJson
      : (() => {
          if (!baseline.request.bodyText) return null;
          try {
            return JSON.parse(baseline.request.bodyText) as unknown;
          } catch {
            return null;
          }
        })();

  if (requestBodyJson == null) {
    throw new ReplayError({
      code: 'bad_request',
      statusCode: 400,
      message: 'Fuzzer requires a JSON request body on the selected message.',
    });
  }

  const pathSegments = pointerToSegments(input.request.fieldPath);
  const lookup = getAtPath(requestBodyJson, pathSegments);
  if (!lookup.found) {
    throw new ReplayError({
      code: 'bad_request',
      statusCode: 400,
      message: `fieldPath not found in request JSON: ${input.request.fieldPath}`,
    });
  }

  const config = FuzzCampaignConfigSchema.parse({
    maxCases: input.request.maxCases,
    concurrency: input.request.concurrency,
    perHostDelayMs: input.request.perHostDelayMs,
    timeoutMs: input.request.timeoutMs,
    backoffBaseMs: input.request.backoffBaseMs,
    anvilSnapshot: input.request.anvilSnapshot,
    revertAfterRun: input.request.revertAfterRun,
  });

  const mutations = buildMutations({
    root: requestBodyJson,
    fieldPath: input.request.fieldPath,
    fieldValue: lookup.value,
    maxCases: config.maxCases,
  });

  if (!mutations.length) {
    throw new ReplayError({
      code: 'bad_request',
      statusCode: 400,
      message: 'No mutations could be generated for the selected field.',
    });
  }

  const warnings: string[] = [];
  const startedAtDate = new Date();
  const startedAt = startedAtDate.toISOString();

  const snapshot = await maybeSnapshot({ config, invokeLocal: input.invokeLocal, warnings });

  const hostNextAllowed = new Map<string, number>();
  const hostBackoff = new Map<string, number>();
  const baselineShape = responseShapeSignature(baseline.response);

  const waitForHostSlot = async (host: string) => {
    while (true) {
      const now = Date.now();
      const next = hostNextAllowed.get(host) ?? now;
      if (next <= now) {
        hostNextAllowed.set(host, now + config.perHostDelayMs);
        return;
      }
      await sleep(next - now);
    }
  };

  const applyHostBackoff = (host: string, trigger: boolean) => {
    const prev = hostBackoff.get(host) ?? 0;
    if (trigger) {
      const next = prev > 0 ? Math.min(prev * 2, 30000) : config.backoffBaseMs;
      hostBackoff.set(host, next);
      const now = Date.now();
      const current = hostNextAllowed.get(host) ?? now;
      hostNextAllowed.set(host, Math.max(current, now) + next);
      return;
    }
    if (prev > 0) hostBackoff.set(host, Math.max(0, Math.floor(prev / 2)));
  };

  const executions: CaseExecution[] = [];
  let nextIndex = 0;

  const executeOne = async (mutation: MutationCandidate): Promise<void> => {
    await waitForHostSlot(baseline.host);

    const nextBody =
      mutation.operation === 'set'
        ? setAtPath(requestBodyJson, pathSegments, mutation.value)
        : removeAtPath(requestBodyJson, pathSegments);

    if (!nextBody.ok) return;

    const serialized = JSON.stringify(nextBody.out);
    const overrides: ReplayOverrides = { bodyText: serialized };

    const replay = await replayOnce({
      db: input.db,
      baselineId: baseline.id,
      overrides,
      publishEvent: input.publishEvent,
      timeoutMs: config.timeoutMs,
    });

    const timeout = /timed out/i.test(replay.variant.error ?? '');
    const throttled = replay.variant.responseStatus === 429;
    applyHostBackoff(baseline.host, throttled || timeout);

    const shape = responseShapeSignature(replay.variant.response);
    const status = replay.variant.responseStatus;
    const errSig = errorSignature(replay.variant.error);
    const clusterKey = `status:${status ?? 'null'}|error:${errSig}|shape:${shape}`;

    const anomaly = {
      statusChanged: replay.diff.status.changed,
      errorChanged: (baseline.error ?? null) !== (replay.variant.error ?? null),
      bodyChanged: replay.diff.body.changed,
      shapeChanged: shape !== baselineShape,
      throttled,
      timeout,
    };

    executions.push({
      order: mutation.order,
      caseId: mutation.id,
      mutationKind: mutation.kind,
      mutationLabel: mutation.label,
      mutationPath: mutation.path,
      operation: mutation.operation,
      before: lookup.value,
      after: mutation.operation === 'set' ? mutation.value : undefined,
      variantId: replay.variant.id,
      status: replay.variant.responseStatus,
      error: replay.variant.error,
      totalMs: replay.variant.timing.totalMs,
      responseShape: shape,
      clusterKey,
      anomaly,
      diff: replay.diff,
    });
  };

  const worker = async () => {
    while (true) {
      const i = nextIndex;
      nextIndex += 1;
      if (i >= mutations.length) return;
      const mutation = mutations[i];
      if (!mutation) return;
      try {
        await executeOne(mutation);
      } catch (err) {
        const timeout = /timed out/i.test(err instanceof Error ? err.message : String(err));
        applyHostBackoff(baseline.host, timeout);
        executions.push({
          order: mutation.order,
          caseId: mutation.id,
          mutationKind: mutation.kind,
          mutationLabel: mutation.label,
          mutationPath: mutation.path,
          operation: mutation.operation,
          before: lookup.value,
          after: mutation.operation === 'set' ? mutation.value : undefined,
          variantId: '',
          status: null,
          error: err instanceof Error ? err.message : String(err),
          totalMs: null,
          responseShape: 'none',
          clusterKey: `status:null|error:${errorSignature(err instanceof Error ? err.message : String(err))}|shape:none`,
          anomaly: {
            statusChanged: baseline.responseStatus !== null,
            errorChanged: true,
            bodyChanged: false,
            shapeChanged: true,
            throttled: false,
            timeout,
          },
          diff: {
            baselineId: baseline.id,
            variantId: '',
            status: {
              baseline: baseline.responseStatus,
              variant: null,
              changed: baseline.responseStatus !== null,
            },
            headers: { added: [], removed: [], changed: [] },
            body: { changed: false, kind: 'empty', jsonChanges: [], truncated: false },
          },
        });
      }
    }
  };

  const workerCount = Math.max(1, Math.min(config.concurrency, mutations.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  const revert = await maybeRevert({
    config,
    snapshotId: snapshot.snapshotId,
    invokeLocal: input.invokeLocal,
    warnings,
  });

  const completedAtDate = new Date();
  const completedAt = completedAtDate.toISOString();
  const durationMs = Math.max(0, completedAtDate.getTime() - startedAtDate.getTime());

  executions.sort((a, b) => a.order - b.order);

  const clusterBuckets = new Map<
    string,
    {
      signature: { status: number | null; error: string; shape: string };
      caseIds: string[];
      anomalyCount: number;
    }
  >();

  for (const e of executions) {
    const parts = e.clusterKey.split('|');
    const statusPart = parts[0]?.replace('status:', '') ?? 'null';
    const errorPart = parts[1]?.replace('error:', '') ?? 'none';
    const shapePart = parts[2]?.replace('shape:', '') ?? 'none';
    const status = statusPart === 'null' ? null : Number(statusPart);

    const bucket = clusterBuckets.get(e.clusterKey) ?? {
      signature: {
        status: Number.isFinite(status) ? status : null,
        error: errorPart,
        shape: shapePart,
      },
      caseIds: [],
      anomalyCount: 0,
    };

    bucket.caseIds.push(e.caseId);
    const isAnomaly =
      e.anomaly.statusChanged ||
      e.anomaly.errorChanged ||
      e.anomaly.shapeChanged ||
      e.anomaly.throttled ||
      e.anomaly.timeout;
    if (isAnomaly) bucket.anomalyCount += 1;

    clusterBuckets.set(e.clusterKey, bucket);
  }

  const clusters: FuzzCluster[] = [];
  const clusterIdMap = new Map<string, string>();
  const sortedClusterEntries = [...clusterBuckets.entries()].sort(
    (a, b) => b[1].caseIds.length - a[1].caseIds.length,
  );

  for (const [i, entry] of sortedClusterEntries.entries()) {
    const [key, bucket] = entry;
    const clusterId = `cluster-${i + 1}`;
    clusterIdMap.set(key, clusterId);
    clusters.push({
      id: clusterId,
      signature: bucket.signature,
      caseCount: bucket.caseIds.length,
      anomalyCount: bucket.anomalyCount,
      caseIds: bucket.caseIds,
      sampleCaseId: bucket.caseIds[0] ?? null,
    });
  }

  const cases: FuzzCaseResult[] = executions.map((e) => ({
    caseId: e.caseId,
    mutationKind: e.mutationKind,
    mutationLabel: e.mutationLabel,
    mutationPath: e.mutationPath,
    operation: e.operation,
    before: e.before,
    after: e.after,
    variantId: e.variantId,
    status: e.status,
    error: e.error,
    totalMs: e.totalMs,
    responseShape: e.responseShape,
    clusterId: clusterIdMap.get(e.clusterKey) ?? 'cluster-unknown',
    anomaly: e.anomaly,
    diff: e.diff,
  }));

  const anomalies = cases.filter(
    (c) =>
      c.anomaly.statusChanged ||
      c.anomaly.errorChanged ||
      c.anomaly.shapeChanged ||
      c.anomaly.throttled ||
      c.anomaly.timeout,
  );

  const payload: FuzzCampaignResponse = {
    ok: true,
    campaign: {
      baselineId: baseline.id,
      baselineStatus: baseline.responseStatus,
      startedAt,
      completedAt,
      durationMs,
      totalCases: cases.length,
      warnings,
      config,
      target: {
        fieldPath: input.request.fieldPath,
        baselineType: classifyType(lookup.value),
        baselineValue: lookup.value,
      },
      snapshot: {
        attempted: snapshot.attempted,
        snapshotId: snapshot.snapshotId,
        reverted: revert.reverted,
        warning: snapshot.warning ?? revert.warning,
      },
    },
    cases,
    clusters,
    anomalies,
  };

  return FuzzCampaignResponseSchema.parse(payload);
}
