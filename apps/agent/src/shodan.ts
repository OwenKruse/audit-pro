export type ShodanHostItem = {
  id: string;
  ip: string | null;
  port: number | null;
  transport: string | null;
  domains: string[];
  hostnames: string[];
  organization: string | null;
  isp: string | null;
  asn: string | null;
  os: string | null;
  product: string | null;
  version: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  timestamp: string | null;
  banner: string | null;
  raw: Record<string, unknown>;
};

export class ShodanQueryError extends Error {
  status: number;
  code: string;

  constructor(input: { status: number; code: string; message: string }) {
    super(input.message);
    this.name = 'ShodanQueryError';
    this.status = input.status;
    this.code = input.code;
  }
}

const DEFAULT_SHODAN_BASE_URL = 'https://api.shodan.io';
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

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
  const single = asTrimmedString(value);
  return single ? [single] : [];
}

function normalizeHostRow(entry: unknown, index: number): ShodanHostItem {
  const rec = asRecord(entry) ?? {};
  const ip = asTrimmedString(rec.ip_str) ?? asTrimmedString(rec.ip);
  const port = asNumber(rec.port);
  const hostnames = asStringList(rec.hostnames);
  const domains = asStringList(rec.domains);
  const idBase = ip ?? hostnames[0] ?? domains[0] ?? `host-${index + 1}`;
  const id = `${idBase}:${port != null ? String(port) : String(index + 1)}`;

  return {
    id,
    ip,
    port,
    transport: asTrimmedString(rec.transport),
    domains,
    hostnames,
    organization: asTrimmedString(rec.org),
    isp: asTrimmedString(rec.isp),
    asn: asTrimmedString(rec.asn),
    os: asTrimmedString(rec.os),
    product: asTrimmedString(rec.product),
    version: asTrimmedString(rec.version),
    country: asTrimmedString(readDottedValue(rec, 'location.country_name')),
    region: asTrimmedString(readDottedValue(rec, 'location.region_code')),
    city: asTrimmedString(readDottedValue(rec, 'location.city')),
    timestamp: asTrimmedString(rec.timestamp),
    banner: asTrimmedString(rec.data),
    raw: rec,
  };
}

function extractErrorMessage(body: unknown, fallback: string): string {
  const rec = asRecord(body);
  if (!rec) return fallback;

  const direct = asTrimmedString(rec.error) ?? asTrimmedString(rec.message);
  if (direct) return direct;

  const nestedError = asRecord(rec.error);
  const nestedMessage = nestedError ? asTrimmedString(nestedError.message) : null;
  return nestedMessage ?? fallback;
}

function withShodanQueryGuidance(message: string): string {
  const normalized = message.trim();
  if (/invalid|parse error|unable to parse|syntax/i.test(normalized)) {
    return [
      normalized,
      'Use Shodan search syntax with filters, e.g. apache country:US or product:nginx port:443.',
    ].join(' ');
  }
  return normalized;
}

function statusFromUpstreamError(input: { statusCode: number; message: string }): number {
  if (input.statusCode === 429) return 429;
  if (/rate limit/i.test(input.message)) return 429;
  if (input.statusCode === 401 || input.statusCode === 403) return 401;
  if (/invalid api key|unauthorized/i.test(input.message)) return 401;
  if (/invalid|parse error|unable to parse|syntax/i.test(input.message)) return 400;
  return input.statusCode;
}

export async function runShodanHostSearch(input: {
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
    facets: string | null;
    minify: boolean;
    total: number | null;
    source: 'shodan';
  };
  items: ShodanHostItem[];
}> {
  const q = readQueryValue(input.query, 'q');
  if (!q) {
    throw new ShodanQueryError({
      status: 400,
      code: 'bad_request',
      message: 'Missing required query parameter: q.',
    });
  }

  const apiKey = input.apiKey ?? process.env.SHODAN_API_KEY ?? '';
  if (!apiKey.trim()) {
    throw new ShodanQueryError({
      status: 503,
      code: 'shodan_unconfigured',
      message: 'SHODAN_API_KEY is not configured in the agent environment.',
    });
  }

  const page = asInt(readQueryValue(input.query, 'page'), 1, 1, 10_000);
  const pageSize = asInt(readQueryValue(input.query, 'pageSize'), DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
  const facets = readQueryValue(input.query, 'facets');
  const minify = readBool(readQueryValue(input.query, 'minify'));

  const baseUrl = (input.apiBaseUrl ?? DEFAULT_SHODAN_BASE_URL).replace(/\/+$/, '');
  const params = new URLSearchParams();
  params.set('key', apiKey.trim());
  params.set('query', q);
  params.set('page', String(page));
  if (facets) params.set('facets', facets);
  if (minify) params.set('minify', 'true');

  const url = `${baseUrl}/shodan/host/search?${params.toString()}`;
  const fetchImpl = input.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
    });
  } catch (err) {
    throw new ShodanQueryError({
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
        throw new ShodanQueryError({
          status: response.status === 429 ? 429 : 502,
          code: response.status === 429 ? 'rate_limited' : 'upstream_error',
          message: text,
        });
      }
      throw new ShodanQueryError({
        status: 502,
        code: 'bad_upstream_json',
        message: 'Shodan returned non-JSON response.',
      });
    }
  }

  if (!response.ok) {
    const message = withShodanQueryGuidance(
      extractErrorMessage(body, `Shodan request failed with status ${response.status}.`),
    );
    throw new ShodanQueryError({
      status: statusFromUpstreamError({ statusCode: response.status, message }),
      code: response.status === 429 ? 'rate_limited' : 'upstream_error',
      message,
    });
  }

  const rec = asRecord(body);
  const apiError = rec ? asTrimmedString(rec.error) : null;
  if (apiError) {
    const message = withShodanQueryGuidance(apiError);
    throw new ShodanQueryError({
      status: statusFromUpstreamError({ statusCode: 400, message }),
      code: /rate limit/i.test(message) ? 'rate_limited' : 'upstream_error',
      message,
    });
  }

  const rawItems = rec && Array.isArray(rec.matches) ? rec.matches : [];
  const items = rawItems.map((item, idx) => normalizeHostRow(item, idx)).slice(0, pageSize);

  return {
    ok: true,
    meta: {
      query: q,
      page,
      pageSize,
      facets,
      minify,
      total: rec ? asNumber(rec.total) : null,
      source: 'shodan',
    },
    items,
  };
}
