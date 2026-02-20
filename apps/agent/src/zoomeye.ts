type ZoomeyeSubType = 'v4' | 'v6' | 'web';

export type ZoomeyeHostItem = {
  id: string;
  ip: string | null;
  port: number | null;
  service: string | null;
  protocol: string | null;
  domain: string | null;
  hostname: string | null;
  title: string[];
  country: string | null;
  province: string | null;
  city: string | null;
  organization: string | null;
  isp: string | null;
  os: string | null;
  product: string | null;
  version: string | null;
  app: string | null;
  banner: string | null;
  asn: number | null;
  honeypot: number | null;
  updateTime: string | null;
  url: string | null;
  raw: Record<string, unknown>;
};

export class ZoomeyeQueryError extends Error {
  status: number;
  code: string;

  constructor(input: { status: number; code: string; message: string }) {
    super(input.message);
    this.name = 'ZoomeyeQueryError';
    this.status = input.status;
    this.code = input.code;
  }
}

const DEFAULT_ZOOMEYE_BASE_URL = 'https://api.zoomeye.ai';
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 1000;
const DEFAULT_RESULT_FIELDS = [
  'ip',
  'port',
  'domain',
  'hostname',
  'service',
  'protocol',
  'title',
  'country.name',
  'province.name',
  'city.name',
  'organization.name',
  'isp.name',
  'os',
  'product',
  'version',
  'banner',
  'asn',
  'honeypot',
  'url',
  'update_time',
].join(',');

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const out = value.trim();
  return out.length > 0 ? out : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number(value.trim());
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function asInt(value: string | null, fallback: number, min: number, max: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function readQueryValue(query: Record<string, unknown>, key: string): string | null {
  const raw = query[key];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const value = asTrimmedString(item);
      if (value) return value;
    }
    return null;
  }
  return asTrimmedString(raw);
}

function readBool(value: string | null): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'y' || v === 'on';
}

function readDottedValue(record: Record<string, unknown>, path: string): unknown {
  if (path in record) return record[path];
  const parts = path.split('.');
  let cursor: unknown = record;
  for (const part of parts) {
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) return null;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

function asStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => asTrimmedString(item))
      .filter((item): item is string => item != null);
  }
  const asSingle = asTrimmedString(value);
  return asSingle ? [asSingle] : [];
}

function normalizeHostRow(entry: unknown, index: number): ZoomeyeHostItem {
  const rec = asRecord(entry) ?? {};
  const ip = asTrimmedString(rec.ip);
  const port = asNumber(rec.port);
  const domain = asTrimmedString(rec.domain);
  const hostname = asTrimmedString(rec.hostname);
  const url = asTrimmedString(rec.url);

  const idBase = ip ?? domain ?? hostname ?? url ?? `host-${index + 1}`;
  const id = `${idBase}:${port != null ? String(port) : String(index + 1)}`;

  return {
    id,
    ip,
    port,
    service: asTrimmedString(rec.service),
    protocol: asTrimmedString(rec.protocol),
    domain,
    hostname,
    title: asStringList(rec.title),
    country: asTrimmedString(readDottedValue(rec, 'country.name')),
    province: asTrimmedString(readDottedValue(rec, 'province.name')),
    city: asTrimmedString(readDottedValue(rec, 'city.name')),
    organization: asTrimmedString(readDottedValue(rec, 'organization.name')),
    isp: asTrimmedString(readDottedValue(rec, 'isp.name')),
    os: asTrimmedString(rec.os),
    product: asTrimmedString(rec.product),
    version: asTrimmedString(rec.version),
    app: asTrimmedString(rec.app),
    banner: asTrimmedString(rec.banner),
    asn: asNumber(rec.asn),
    honeypot: asNumber(rec.honeypot),
    updateTime: asTrimmedString(rec.update_time),
    url,
    raw: rec,
  };
}

function extractErrorMessage(body: unknown, fallback: string): string {
  const rec = asRecord(body);
  if (!rec) return fallback;

  const direct = asTrimmedString(rec.message) ?? asTrimmedString(rec.msg) ?? asTrimmedString(rec.error);
  if (direct) return direct;

  const nestedError = asRecord(rec.error);
  const nestedMessage = nestedError ? asTrimmedString(nestedError.message) : null;
  return nestedMessage ?? fallback;
}

function withZoomeyeQueryGuidance(message: string): string {
  const normalized = message.trim();
  if (/invalid query/i.test(normalized)) {
    return [
      normalized,
      'Use ZoomEye DSL in q (not natural language).',
      'Examples: app="Apache" && country="US" | service="ssh" && country="NO" | ip="8.8.8.8".',
    ].join(' ');
  }
  return normalized;
}

function statusFromUpstreamError(input: { statusCode: number; message: string }): number {
  if (input.statusCode === 429) return 429;
  if (/rate limit/i.test(input.message)) return 429;
  if (/invalid query/i.test(input.message)) return 400;
  return input.statusCode;
}

function normalizeSubType(value: string | null): ZoomeyeSubType {
  if (!value) return 'v4';
  const v = value.trim().toLowerCase();
  if (v === 'v6') return 'v6';
  if (v === 'web') return 'web';
  return 'v4';
}

export async function runZoomeyeHostSearch(input: {
  query: Record<string, unknown>;
  apiKey?: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<{
  ok: true;
  meta: {
    query: string;
    page: number;
    pageSize: number;
    subType: ZoomeyeSubType;
    fields: string | null;
    facets: string | null;
    ignoreCache: boolean;
    total: number | null;
    code: number | null;
    message: string | null;
    source: 'zoomeye';
  };
  items: ZoomeyeHostItem[];
}> {
  const q = readQueryValue(input.query, 'q');
  if (!q) {
    throw new ZoomeyeQueryError({
      status: 400,
      code: 'bad_request',
      message: 'Missing required query parameter: q.',
    });
  }

  const apiKey = input.apiKey ?? process.env.ZOOMEYE_API_KEY ?? '';
  if (!apiKey.trim()) {
    throw new ZoomeyeQueryError({
      status: 503,
      code: 'zoomeye_unconfigured',
      message: 'ZOOMEYE_API_KEY is not configured in the agent environment.',
    });
  }

  const page = asInt(readQueryValue(input.query, 'page'), 1, 1, 10_000);
  const pageSize = asInt(
    readQueryValue(input.query, 'pageSize') ?? readQueryValue(input.query, 'pagesize'),
    DEFAULT_PAGE_SIZE,
    1,
    MAX_PAGE_SIZE,
  );
  const subType = normalizeSubType(
    readQueryValue(input.query, 'subType') ?? readQueryValue(input.query, 'sub_type'),
  );
  const fields = readQueryValue(input.query, 'fields');
  const effectiveFields = fields ?? DEFAULT_RESULT_FIELDS;
  const facets = readQueryValue(input.query, 'facets');
  const ignoreCache = readBool(readQueryValue(input.query, 'ignoreCache'));

  const baseUrl = (input.apiBaseUrl ?? DEFAULT_ZOOMEYE_BASE_URL).replace(/\/+$/, '');
  const url = `${baseUrl}/v2/search`;
  const fetchImpl = input.fetchImpl ?? fetch;

  const requestBody: Record<string, unknown> = {
    qbase64: Buffer.from(q, 'utf8').toString('base64'),
    page,
    pagesize: pageSize,
    sub_type: subType,
  };
  requestBody.fields = effectiveFields;
  if (facets) requestBody.facets = facets;
  if (ignoreCache) requestBody.ignore_cache = true;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'API-KEY': apiKey.trim(),
      },
      body: JSON.stringify(requestBody),
    });
  } catch (err) {
    throw new ZoomeyeQueryError({
      status: 502,
      code: 'upstream_unreachable',
      message: err instanceof Error ? err.message : String(err),
    });
  }

  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      if (!response.ok) {
        throw new ZoomeyeQueryError({
          status: response.status === 429 ? 429 : 502,
          code: response.status === 429 ? 'rate_limited' : 'upstream_error',
          message: text,
        });
      }
      throw new ZoomeyeQueryError({
        status: 502,
        code: 'bad_upstream_json',
        message: 'ZoomEye returned non-JSON response.',
      });
    }
  }

  if (!response.ok) {
    const message = withZoomeyeQueryGuidance(
      extractErrorMessage(body, `ZoomEye request failed with status ${response.status}.`),
    );
    throw new ZoomeyeQueryError({
      status: statusFromUpstreamError({ statusCode: response.status, message }),
      code: response.status === 429 ? 'rate_limited' : 'upstream_error',
      message,
    });
  }

  const rec = asRecord(body);
  const upstreamCode = rec ? asNumber(rec.code) : null;
  const upstreamMessage = withZoomeyeQueryGuidance(
    rec ? asTrimmedString(rec.message) ?? asTrimmedString(rec.msg) ?? 'Unknown upstream error.' : 'Unknown upstream error.',
  );
  if (upstreamCode != null && upstreamCode !== 60000) {
    throw new ZoomeyeQueryError({
      status: statusFromUpstreamError({ statusCode: 502, message: upstreamMessage }),
      code: /rate limit/i.test(upstreamMessage) ? 'rate_limited' : 'upstream_error',
      message: upstreamMessage,
    });
  }

  const rawItems = rec && Array.isArray(rec.data) ? rec.data : [];
  const items = rawItems.map((item, idx) => normalizeHostRow(item, idx));

  return {
    ok: true,
    meta: {
      query: q,
      page,
      pageSize,
      subType,
      fields: effectiveFields,
      facets: facets ?? null,
      ignoreCache,
      total: rec ? asNumber(rec.total) : null,
      code: rec ? asNumber(rec.code) : null,
      message: rec ? asTrimmedString(rec.message) : null,
      source: 'zoomeye',
    },
    items,
  };
}
