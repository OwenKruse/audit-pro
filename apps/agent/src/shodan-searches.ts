import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export type PassedShodanSearchSummary = {
  id: string;
  createdAt: string;
  query: string;
  page: number;
  pageSize: number;
  facets: string | null;
  minify: boolean;
  total: number | null;
  count: number;
  summary: string;
};

export type PassedShodanSearchDetail = PassedShodanSearchSummary & {
  args: Record<string, unknown>;
  meta: Record<string, unknown> | null;
  items: Array<Record<string, unknown>>;
};

type RawRow = {
  id: string;
  created_at: string;
  query: string;
  page: number;
  page_size: number;
  facets: string | null;
  minify: number;
  total: number | null;
  count: number;
  summary: string;
  args_json: string;
  meta_json: string | null;
  items_json: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asArrayOfRecords(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => item != null);
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

function toInt(value: number | null, fallback: number, min: number, max: number): number {
  if (value == null) return fallback;
  const n = Math.trunc(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function toJson(value: unknown): string {
  try {
    return JSON.stringify(
      value,
      (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
      0,
    );
  } catch {
    return '{}';
  }
}

function parseJsonRecord(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

function parseJsonRecordArray(value: string | null): Array<Record<string, unknown>> {
  if (!value) return [];
  try {
    return asArrayOfRecords(JSON.parse(value));
  } catch {
    return [];
  }
}

function rowToSummary(row: RawRow): PassedShodanSearchSummary {
  return {
    id: row.id,
    createdAt: row.created_at,
    query: row.query,
    page: row.page,
    pageSize: row.page_size,
    facets: row.facets,
    minify: row.minify === 1,
    total: row.total,
    count: row.count,
    summary: row.summary,
  };
}

function rowToDetail(row: RawRow): PassedShodanSearchDetail {
  return {
    ...rowToSummary(row),
    args: parseJsonRecord(row.args_json) ?? {},
    meta: parseJsonRecord(row.meta_json),
    items: parseJsonRecordArray(row.items_json),
  };
}

export function recordPassedShodanSearch(
  db: DatabaseSync,
  input: {
    args: Record<string, unknown>;
    payload: { total: number | null; count: number; meta: unknown; items: unknown[] };
    summary: string;
  },
): PassedShodanSearchSummary {
  const args = asRecord(input.args) ?? {};
  const payloadMeta = asRecord(input.payload.meta);
  const payloadItems = asArrayOfRecords(input.payload.items).slice(0, 100);
  const query = asTrimmedString(args.q) ?? asTrimmedString(payloadMeta?.query) ?? '(unknown query)';
  const page = toInt(
    asNumber(args.page) ?? asNumber(payloadMeta?.page),
    1,
    1,
    10_000,
  );
  const pageSize = toInt(
    asNumber(args.pageSize) ?? asNumber(payloadMeta?.pageSize),
    payloadItems.length > 0 ? payloadItems.length : 20,
    1,
    100,
  );
  const facetsRaw = args.facets;
  const facets =
    typeof facetsRaw === 'string'
      ? asTrimmedString(facetsRaw)
      : Array.isArray(facetsRaw)
        ? facetsRaw
            .map((item) => asTrimmedString(item))
            .filter((item): item is string => item != null)
            .join(',')
        : asTrimmedString(payloadMeta?.facets);
  const minifyRaw = args.minify;
  const minify =
    typeof minifyRaw === 'boolean'
      ? minifyRaw
      : typeof payloadMeta?.minify === 'boolean'
        ? payloadMeta.minify
        : false;
  const total =
    typeof input.payload.total === 'number' && Number.isFinite(input.payload.total)
      ? input.payload.total
      : asNumber(payloadMeta?.total);
  const count =
    typeof input.payload.count === 'number' && Number.isFinite(input.payload.count)
      ? Math.max(0, Math.trunc(input.payload.count))
      : payloadItems.length;

  const row: RawRow = {
    id: randomUUID(),
    created_at: new Date().toISOString(),
    query,
    page,
    page_size: pageSize,
    facets: facets && facets.trim().length > 0 ? facets : null,
    minify: minify ? 1 : 0,
    total: total != null ? Math.trunc(total) : null,
    count,
    summary: input.summary,
    args_json: toJson(args),
    meta_json: payloadMeta ? toJson(payloadMeta) : null,
    items_json: toJson(payloadItems),
  };

  db.prepare(
    `
      INSERT INTO ai_shodan_searches (
        id,
        created_at,
        query,
        page,
        page_size,
        facets,
        minify,
        total,
        count,
        summary,
        args_json,
        meta_json,
        items_json
      ) VALUES (
        @id,
        @created_at,
        @query,
        @page,
        @page_size,
        @facets,
        @minify,
        @total,
        @count,
        @summary,
        @args_json,
        @meta_json,
        @items_json
      )
    `,
  ).run(row);

  return rowToSummary(row);
}

export function listPassedShodanSearches(
  db: DatabaseSync,
  input: { limit?: number; offset?: number } = {},
): { ok: true; items: PassedShodanSearchSummary[] } {
  const limitRaw = typeof input.limit === 'number' && Number.isFinite(input.limit) ? input.limit : 50;
  const offsetRaw = typeof input.offset === 'number' && Number.isFinite(input.offset) ? input.offset : 0;
  const limit = Math.max(1, Math.min(250, Math.trunc(limitRaw)));
  const offset = Math.max(0, Math.trunc(offsetRaw));

  const rows = db
    .prepare(
      `
        SELECT
          id,
          created_at,
          query,
          page,
          page_size,
          facets,
          minify,
          total,
          count,
          summary,
          args_json,
          meta_json,
          items_json
        FROM ai_shodan_searches
        ORDER BY created_at DESC
        LIMIT @limit OFFSET @offset
      `,
    )
    .all({ limit, offset }) as RawRow[];

  return { ok: true, items: rows.map((row) => rowToSummary(row)) };
}

export function getPassedShodanSearch(
  db: DatabaseSync,
  id: string,
): { ok: true; item: PassedShodanSearchDetail } | null {
  const row = db
    .prepare(
      `
        SELECT
          id,
          created_at,
          query,
          page,
          page_size,
          facets,
          minify,
          total,
          count,
          summary,
          args_json,
          meta_json,
          items_json
        FROM ai_shodan_searches
        WHERE id = ?
        LIMIT 1
      `,
    )
    .get(id) as RawRow | undefined;

  if (!row) return null;
  return { ok: true, item: rowToDetail(row) };
}
