import { z } from 'zod';
import { sendRawHttpRequest } from './replay.js';
import { resolvePayloadSetFromCatalog, type PayloadSourceType } from './payload-catalog.js';

type HeaderValue = string | string[];
type HeaderRecord = Record<string, string[]>;

export const IntruderAttackTypeSchema = z.enum([
  'sniper',
  'battering_ram',
  'pitchfork',
  'cluster_bomb',
]);

export type IntruderAttackType = z.infer<typeof IntruderAttackTypeSchema>;

const PayloadCatalogQuerySchema = z.object({
  q: z.string().trim().max(500).optional(),
  category: z.string().trim().max(200).optional(),
  subcategory: z.string().trim().max(200).optional(),
  sourceType: z.enum(['intruder', 'markdown', 'file']).optional(),
  sourcePath: z.string().trim().max(600).optional(),
  tag: z.string().trim().max(120).optional(),
  limit: z.number().int().min(1).max(3000).optional(),
});

const HeaderValueSchema = z.union([z.string().max(8192), z.array(z.string().max(8192)).max(64)]);
const HeaderMapSchema = z.record(z.string().max(256), HeaderValueSchema);
const HeaderLineArraySchema = z.array(z.string().max(8192)).max(256);

export const IntruderAttackRequestSchema = z.object({
  method: z.string().trim().min(1).max(16).default('GET'),
  url: z.string().trim().min(1).max(4096),
  headers: z.union([z.string().max(120_000), HeaderLineArraySchema, HeaderMapSchema]).optional(),
  body: z.string().max(500_000).optional(),
  attackType: IntruderAttackTypeSchema.default('sniper'),
  payloadSets: z.array(z.array(z.string().max(1200)).max(20_000)).max(20).optional(),
  payloadSetQueries: z.array(PayloadCatalogQuerySchema).max(20).optional(),
  maxRequests: z.number().int().min(1).max(10_000).optional(),
  concurrency: z.number().int().min(1).max(20).optional(),
  timeoutMs: z.number().int().min(100).max(60_000).optional(),
  delayMs: z.number().int().min(0).max(5_000).optional(),
});

export type IntruderAttackRequest = z.infer<typeof IntruderAttackRequestSchema>;

export type IntruderAttackPosition = {
  index: number;
  defaultValue: string;
};

export type IntruderAttackResultRow = {
  index: number;
  payloads: string[];
  url: string;
  status: number | null;
  durationMs: number | null;
  responseBytes: number;
  responseSnippet: string | null;
  error: string | null;
};

export type IntruderAttackResult = {
  attackType: IntruderAttackType;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  positions: IntruderAttackPosition[];
  requestCount: number;
  capped: boolean;
  maxRequests: number;
  results: IntruderAttackResultRow[];
};

const PLACEHOLDER_REGEX = /§([^§]*)§/g;
const RESPONSE_SNIPPET_MAX = 800;

class InputError extends Error {}

function normalizeMethod(value: string): string {
  const method = value.trim().toUpperCase();
  if (!/^[A-Z]+$/.test(method)) throw new InputError(`Invalid HTTP method: ${value}`);
  return method;
}

function toPort(url: URL): number {
  if (url.port) {
    const parsed = Number(url.port);
    if (Number.isFinite(parsed) && parsed > 0) return Math.trunc(parsed);
  }
  return url.protocol === 'https:' ? 443 : 80;
}

function formatHostHeader(url: URL): string {
  const host = url.hostname.includes(':') && !url.hostname.startsWith('[') ? `[${url.hostname}]` : url.hostname;
  const port = toPort(url);
  const isDefault = (url.protocol === 'https:' && port === 443) || (url.protocol === 'http:' && port === 80);
  return isDefault ? host : `${host}:${port}`;
}

function normalizeHeaderKey(value: string): string {
  return value.trim().toLowerCase();
}

function cloneHeaders(input: HeaderRecord): HeaderRecord {
  const out: HeaderRecord = {};
  for (const [k, v] of Object.entries(input)) out[k] = [...v];
  return out;
}

function parseHeaderLine(line: string): { key: string; value: string } | null {
  const raw = line.trim();
  if (!raw) return null;
  const idx = raw.indexOf(':');
  if (idx <= 0) return null;
  const key = normalizeHeaderKey(raw.slice(0, idx));
  if (!key) return null;
  return { key, value: raw.slice(idx + 1).trim() };
}

function normalizeHeaders(input: IntruderAttackRequest['headers']): HeaderRecord {
  const out: HeaderRecord = {};
  if (input == null) return out;

  if (typeof input === 'string') {
    const lines = input.split(/\r?\n/g);
    for (const line of lines) {
      const parsed = parseHeaderLine(line);
      if (!parsed) continue;
      if (parsed.key === 'host' || parsed.key === 'content-length') continue;
      const next = out[parsed.key] ?? [];
      next.push(parsed.value);
      out[parsed.key] = next;
    }
    return out;
  }

  if (Array.isArray(input)) {
    for (const line of input) {
      const parsed = parseHeaderLine(line);
      if (!parsed) continue;
      if (parsed.key === 'host' || parsed.key === 'content-length') continue;
      const next = out[parsed.key] ?? [];
      next.push(parsed.value);
      out[parsed.key] = next;
    }
    return out;
  }

  for (const [k, v] of Object.entries(input as Record<string, HeaderValue>)) {
    const key = normalizeHeaderKey(k);
    if (!key || key === 'host' || key === 'content-length') continue;
    if (Array.isArray(v)) out[key] = v.map((item) => String(item));
    else out[key] = [String(v)];
  }
  return out;
}

function headersTemplateFromInput(input: IntruderAttackRequest['headers']): string {
  if (input == null) return '';
  if (typeof input === 'string') return input;
  if (Array.isArray(input)) return input.join('\n');

  const lines: string[] = [];
  for (const [key, value] of Object.entries(input as Record<string, HeaderValue>)) {
    if (Array.isArray(value)) {
      for (const item of value) lines.push(`${key}: ${item}`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  return lines.join('\n');
}

function extractPlaceholders(template: string): string[] {
  const out: string[] = [];
  for (const match of template.matchAll(PLACEHOLDER_REGEX)) {
    out.push(match[1] ?? '');
  }
  return out;
}

function countPlaceholders(template: string): number {
  return extractPlaceholders(template).length;
}

function applyTemplateWithSlice(input: {
  template: string;
  payloads: string[];
  startIndex: number;
}): { text: string; nextIndex: number } {
  let index = input.startIndex;
  const text = input.template.replaceAll(PLACEHOLDER_REGEX, () => {
    const value = input.payloads[index];
    index += 1;
    return value ?? '';
  });
  return { text, nextIndex: index };
}

function normalizePayloadSet(values: string[] | undefined): string[] {
  if (!values || values.length === 0) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function mergePayloadSets(input: {
  manualSets: string[][];
  querySets: Array<{
    q?: string;
    category?: string;
    subcategory?: string;
    sourceType?: PayloadSourceType;
    sourcePath?: string;
    tag?: string;
    limit?: number;
  }>;
}): string[][] {
  const fromQueries = input.querySets.map((query) =>
    normalizePayloadSet(
      resolvePayloadSetFromCatalog({
        q: query.q,
        category: query.category,
        subcategory: query.subcategory,
        sourceType: query.sourceType,
        sourcePath: query.sourcePath,
        tag: query.tag,
        limit: query.limit,
      }),
    ),
  );

  const out: string[][] = [];
  const max = Math.max(input.manualSets.length, fromQueries.length);
  for (let i = 0; i < max; i += 1) {
    const merged = normalizePayloadSet([...(input.manualSets[i] ?? []), ...(fromQueries[i] ?? [])]);
    out.push(merged);
  }
  return out.filter((set) => set.length > 0);
}

function buildAssignments(input: {
  attackType: IntruderAttackType;
  defaults: string[];
  payloadSets: string[][];
  maxRequests: number;
}): { assignments: string[][]; capped: boolean } {
  const defaults = [...input.defaults];
  const positionCount = defaults.length;
  const set0 = input.payloadSets[0] ?? [];
  if (positionCount <= 0) throw new InputError('No payload positions found. Mark positions with §...§.');
  if (set0.length === 0) throw new InputError('At least one payload set is required.');

  const assignments: string[][] = [];
  let capped = false;

  const push = (values: string[]) => {
    if (assignments.length >= input.maxRequests) {
      capped = true;
      return;
    }
    assignments.push(values);
  };

  if (input.attackType === 'sniper') {
    for (let pos = 0; pos < positionCount; pos += 1) {
      for (const value of set0) {
        const next = [...defaults];
        next[pos] = value;
        push(next);
        if (capped) return { assignments, capped };
      }
    }
    return { assignments, capped };
  }

  if (input.attackType === 'battering_ram') {
    for (const value of set0) {
      push(Array.from({ length: positionCount }, () => value));
      if (capped) break;
    }
    return { assignments, capped };
  }

  if (input.attackType === 'pitchfork') {
    const setsForPositions = Array.from({ length: positionCount }, (_, index) => {
      return input.payloadSets[index] ?? set0;
    });
    if (setsForPositions.some((set) => set.length === 0)) {
      throw new InputError('Pitchfork attack requires non-empty payload sets for each position.');
    }
    const size = Math.min(...setsForPositions.map((set) => set.length));
    for (let i = 0; i < size; i += 1) {
      const next = [...defaults];
      for (let pos = 0; pos < positionCount; pos += 1) {
        next[pos] = setsForPositions[pos]?.[i] ?? defaults[pos] ?? '';
      }
      push(next);
      if (capped) break;
    }
    return { assignments, capped };
  }

  const setsForPositions = Array.from({ length: positionCount }, (_, index) => {
    return input.payloadSets[index] ?? set0;
  });
  if (setsForPositions.some((set) => set.length === 0)) {
    throw new InputError('Cluster bomb attack requires non-empty payload sets for each position.');
  }
  const current = [...defaults];

  const visit = (index: number) => {
    if (capped) return;
    if (index >= positionCount) {
      push([...current]);
      return;
    }
    const set = setsForPositions[index] ?? [];
    for (const value of set) {
      current[index] = value;
      visit(index + 1);
      if (capped) return;
    }
  };

  visit(0);
  return { assignments, capped };
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 3))}...`;
}

async function mapConcurrent<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  const out = new Array<R>(items.length);
  let cursor = 0;

  const worker = async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      out[index] = await fn(items[index] as T, index);
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return out;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runIntruderAttack(rawInput: IntruderAttackRequest): Promise<IntruderAttackResult> {
  const input = IntruderAttackRequestSchema.parse(rawInput);
  const method = normalizeMethod(input.method);
  const timeoutMs = input.timeoutMs ?? 15_000;
  const concurrency = input.concurrency ?? 4;
  const delayMs = input.delayMs ?? 0;
  const maxRequests = input.maxRequests ?? 300;

  const bodyTemplate = input.body ?? '';
  const headersTemplate = headersTemplateFromInput(input.headers);

  const urlPlaceholders = extractPlaceholders(input.url);
  const headerPlaceholders = extractPlaceholders(headersTemplate);
  const bodyPlaceholders = extractPlaceholders(bodyTemplate);
  const defaults = [...urlPlaceholders, ...headerPlaceholders, ...bodyPlaceholders];

  if (defaults.length === 0) {
    throw new InputError('No payload positions found. Mark mutable parts with §...§.');
  }

  const manualSets = (input.payloadSets ?? []).map((set) => normalizePayloadSet(set));
  const mergedPayloadSets = mergePayloadSets({
    manualSets,
    querySets: input.payloadSetQueries ?? [],
  });

  if (mergedPayloadSets.length === 0) {
    throw new InputError('No payload set available. Provide payloadSets or payloadSetQueries.');
  }

  const positions: IntruderAttackPosition[] = defaults.map((value, index) => ({
    index,
    defaultValue: value,
  }));

  const { assignments, capped } = buildAssignments({
    attackType: input.attackType,
    defaults,
    payloadSets: mergedPayloadSets,
    maxRequests,
  });

  if (assignments.length === 0) throw new InputError('No requests were generated from the payload setup.');

  const headerBase = normalizeHeaders(input.headers);
  const urlPlaceholderCount = countPlaceholders(input.url);
  const headerPlaceholderCount = countPlaceholders(headersTemplate);
  const bodyPlaceholderCount = countPlaceholders(bodyTemplate);
  const payloadSliceEnd = urlPlaceholderCount + headerPlaceholderCount + bodyPlaceholderCount;
  const startedAt = new Date().toISOString();
  const startedTime = Date.now();

  const results = await mapConcurrent(assignments, concurrency, async (payloads, index) => {
    let cursor = 0;
    const urlApplied = applyTemplateWithSlice({
      template: input.url,
      payloads,
      startIndex: cursor,
    });
    cursor = urlApplied.nextIndex;
    const headersApplied = applyTemplateWithSlice({
      template: headersTemplate,
      payloads,
      startIndex: cursor,
    });
    cursor = headersApplied.nextIndex;
    const bodyApplied = applyTemplateWithSlice({
      template: bodyTemplate,
      payloads,
      startIndex: cursor,
    });

    const usedPayloads = payloads.slice(0, payloadSliceEnd);
    const fallbackUrl = urlApplied.text;

    try {
      const targetUrl = new URL(urlApplied.text);
      if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
        throw new InputError(`Unsupported URL protocol: ${targetUrl.protocol}`);
      }

      const perRequestHeaders = cloneHeaders(headerBase);
      if (headersTemplate.trim()) {
        const appliedHeaders = normalizeHeaders(headersApplied.text);
        for (const [key, values] of Object.entries(appliedHeaders)) perRequestHeaders[key] = values;
      }
      perRequestHeaders.host = [formatHostHeader(targetUrl)];

      const shouldSendBody = method !== 'GET' && method !== 'HEAD';
      const bodyText = shouldSendBody ? bodyApplied.text : '';
      const bodyBuffer = shouldSendBody && bodyText.length > 0 ? Buffer.from(bodyText, 'utf8') : null;
      if (bodyBuffer) perRequestHeaders['content-length'] = [String(bodyBuffer.length)];
      else delete perRequestHeaders['content-length'];

      const upstream = await sendRawHttpRequest({
        url: targetUrl.toString(),
        method,
        headers: perRequestHeaders,
        body: bodyBuffer,
        timeoutMs,
      });

      const responseBytes = upstream.responseBody?.length ?? 0;
      const snippet = upstream.responseBodyText
        ? truncate(upstream.responseBodyText, RESPONSE_SNIPPET_MAX)
        : null;

      if (delayMs > 0) await sleep(delayMs);

      return {
        index: index + 1,
        payloads: usedPayloads,
        url: targetUrl.toString(),
        status: upstream.responseStatus,
        durationMs: upstream.timing.totalMs,
        responseBytes,
        responseSnippet: snippet,
        error: upstream.error,
      };
    } catch (err) {
      return {
        index: index + 1,
        payloads: usedPayloads,
        url: fallbackUrl,
        status: null,
        durationMs: null,
        responseBytes: 0,
        responseSnippet: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  const finishedAt = new Date().toISOString();
  const durationMs = Date.now() - startedTime;

  return {
    attackType: input.attackType,
    startedAt,
    finishedAt,
    durationMs,
    positions,
    requestCount: results.length,
    capped,
    maxRequests,
    results,
  };
}

export function isIntruderInputError(err: unknown): boolean {
  return err instanceof InputError;
}
