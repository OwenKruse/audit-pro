import { Buffer } from 'node:buffer';
import type { DatabaseSync } from 'node:sqlite';
import { brotliDecompressSync, gunzipSync, inflateSync, unzipSync } from 'node:zlib';
import {
  HttpMessageDetailSchema,
  HttpMessageStateSchema,
  HttpMessageSummarySchema,
  SitemapHostSchema,
  WsConnectionSchema,
  WsFrameSchema,
  type HttpMessageDetail,
  type HttpMessageState,
  type HttpMessageSummary,
  type SitemapHost,
  type SitemapPathNode,
  type WsConnection,
  type WsFrame,
} from '@cipherscope/proto';

function parseJson<T>(raw: string): T {
  return JSON.parse(raw) as T;
}

function safeParseJson(raw: string | null): unknown | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function decodeUtf8OrNull(buf: Buffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return null;
  }
}

function headerFirstValue(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return v[0] ?? '';
  return v ?? '';
}

function headerTokens(v: string | string[] | undefined): string[] {
  const raw = Array.isArray(v) ? v.join(',') : (v ?? '');
  return raw
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

function parseCharset(contentType: string | string[] | undefined): string | null {
  const raw = headerFirstValue(contentType);
  const match = /charset\s*=\s*"?([^;"\s]+)"?/i.exec(raw);
  if (!match) return null;
  return match[1]?.trim().toLowerCase() || null;
}

function isTextualContentType(contentType: string | string[] | undefined): boolean {
  const ct = headerFirstValue(contentType).toLowerCase();
  if (!ct) return false;
  return (
    ct.startsWith('text/') ||
    ct.includes('json') ||
    ct.includes('xml') ||
    ct.includes('javascript') ||
    ct.includes('ecmascript') ||
    ct.includes('svg') ||
    ct.includes('x-www-form-urlencoded')
  );
}

function decodeContentEncoding(
  body: Buffer,
  contentEncoding: string | string[] | undefined,
): Buffer | null {
  const encodings = headerTokens(contentEncoding);
  if (!encodings.length) return body;

  try {
    let out = body;
    // Encodings are applied in order; decode in reverse order.
    for (let i = encodings.length - 1; i >= 0; i -= 1) {
      const encoding = encodings[i];
      if (!encoding || encoding === 'identity') continue;
      if (encoding === 'gzip' || encoding === 'x-gzip') {
        out = gunzipSync(out);
        continue;
      }
      if (encoding === 'deflate') {
        try {
          out = inflateSync(out);
        } catch {
          out = unzipSync(out);
        }
        continue;
      }
      if (encoding === 'br') {
        out = brotliDecompressSync(out);
        continue;
      }
      return null;
    }
    return out;
  } catch {
    return null;
  }
}

function decodeWithCharset(buf: Buffer, charset: string): string | null {
  try {
    return new TextDecoder(charset, { fatal: true }).decode(buf);
  } catch {
    return null;
  }
}

export function decodeHttpBodyTextOrNull(
  body: Buffer,
  contentType: string | string[] | undefined,
  contentEncoding: string | string[] | undefined,
): string | null {
  const decodedBytes = decodeContentEncoding(body, contentEncoding);
  if (!decodedBytes) return null;

  const declaredCharset = parseCharset(contentType);
  if (declaredCharset) {
    const declared = decodeWithCharset(decodedBytes, declaredCharset);
    if (declared != null) return declared;
  }

  const utf8 = decodeUtf8OrNull(decodedBytes);
  if (utf8 != null) return utf8;

  if (isTextualContentType(contentType)) {
    // Common fallback for legacy text/html responses without utf-8 bytes.
    const latin1 = decodeWithCharset(decodedBytes, 'latin1');
    if (latin1 != null) return latin1;
  }

  return null;
}

export function looksLikeJson(contentType: string | undefined, text: string | null): boolean {
  if (!text) return false;
  const ct = (contentType ?? '').toLowerCase();
  if (ct.includes('application/json') || ct.includes('+json')) return true;
  const trimmed = text.trimStart();
  return trimmed.startsWith('{') || trimmed.startsWith('[');
}

export function normalizeHeaderRecord(headers: Record<string, unknown>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(headers)) {
    const key = k.toLowerCase();
    if (v == null) continue;
    if (Array.isArray(v)) out[key] = v.map(String);
    else out[key] = [String(v)];
  }
  return out;
}

export function parseCookieHeader(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) return {};
  const out: Record<string, string> = {};
  for (const part of cookieHeader.split(';')) {
    const [k, ...rest] = part.split('=');
    const key = (k ?? '').trim();
    if (!key) continue;
    out[key] = rest.join('=').trim();
  }
  return out;
}

export function parseQueryToRecord(url: URL): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [k, v] of url.searchParams.entries()) {
    (out[k] ??= []).push(v);
  }
  return out;
}

function parseTiming(raw: string): {
  dnsMs: number | null;
  connectMs: number | null;
  tlsMs: number | null;
  ttfbMs: number | null;
  totalMs: number | null;
} {
  try {
    const v = parseJson<{
      dnsMs?: number | null;
      connectMs?: number | null;
      tlsMs?: number | null;
      ttfbMs?: number | null;
      totalMs?: number | null;
    }>(raw);
    return {
      dnsMs: v.dnsMs ?? null,
      connectMs: v.connectMs ?? null,
      tlsMs: v.tlsMs ?? null,
      ttfbMs: v.ttfbMs ?? null,
      totalMs: v.totalMs ?? null,
    };
  } catch {
    return { dnsMs: null, connectMs: null, tlsMs: null, ttfbMs: null, totalMs: null };
  }
}

export type InsertHttpMessageInput = {
  id: string;
  parentId?: string | null;
  createdAt: string;
  scheme: string;
  host: string;
  port: number;
  method: string;
  path: string;
  url: string;
  state: HttpMessageState;
  requestHeaders: Record<string, string[]>;
  requestCookies: Record<string, string>;
  requestQuery: Record<string, string[]>;
  requestBody: Buffer | null;
  requestBodyText: string | null;
  requestBodyJson: string | null;
  timingJson: string;
  error: string | null;
};

export function insertHttpMessage(db: DatabaseSync, input: InsertHttpMessageInput) {
  HttpMessageStateSchema.parse(input.state);
  const stmt = db.prepare(`
    INSERT INTO http_messages (
      id, parent_id, created_at, scheme, host, port, method, path, url, state,
      request_headers_json, request_cookies_json, request_query_json,
      request_body, request_body_text, request_body_json,
      replay_diff_json,
      timing_json, error
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?,
      ?,
      ?, ?
    )
  `);

  stmt.run(
    input.id,
    input.parentId ?? null,
    input.createdAt,
    input.scheme,
    input.host,
    input.port,
    input.method,
    input.path,
    input.url,
    input.state,
    JSON.stringify(input.requestHeaders),
    JSON.stringify(input.requestCookies),
    JSON.stringify(input.requestQuery),
    input.requestBody,
    input.requestBodyText,
    input.requestBodyJson,
    null,
    input.timingJson,
    input.error,
  );
}

export type UpdateHttpMessageResponseInput = {
  id: string;
  state: HttpMessageState;
  responseStatus: number | null;
  responseHeaders: Record<string, string[]>;
  responseBody: Buffer | null;
  responseBodyText: string | null;
  responseBodyJson: string | null;
  timingJson: string;
  error: string | null;
};

export function updateHttpMessageResponse(db: DatabaseSync, input: UpdateHttpMessageResponseInput) {
  HttpMessageStateSchema.parse(input.state);
  const stmt = db.prepare(`
    UPDATE http_messages SET
      state = ?,
      response_status = ?,
      response_headers_json = ?,
      response_body = ?,
      response_body_text = ?,
      response_body_json = ?,
      timing_json = ?,
      error = ?
    WHERE id = ?
  `);

  stmt.run(
    input.state,
    input.responseStatus,
    JSON.stringify(input.responseHeaders),
    input.responseBody,
    input.responseBodyText,
    input.responseBodyJson,
    input.timingJson,
    input.error,
    input.id,
  );
}

export function updateHttpMessageState(
  db: DatabaseSync,
  input: { id: string; state: HttpMessageState; error: string | null },
) {
  HttpMessageStateSchema.parse(input.state);
  const stmt = db.prepare(`UPDATE http_messages SET state = ?, error = ? WHERE id = ?`);
  stmt.run(input.state, input.error, input.id);
}

export function updateHttpMessageReplayDiff(
  db: DatabaseSync,
  input: { id: string; replayDiffJson: string | null },
) {
  const stmt = db.prepare(`UPDATE http_messages SET replay_diff_json = ? WHERE id = ?`);
  stmt.run(input.replayDiffJson, input.id);
}

export type ListHttpMessagesFilters = {
  search?: string;
  source?: 'all' | 'proxy' | 'repeater';
  method?: string;
  scheme?: string;
  status?: 'all' | '2xx' | '3xx' | '4xx' | '5xx' | 'error';
};

export function listHttpMessages(
  db: DatabaseSync,
  input: {
    limit: number;
    offset: number;
    search?: string;
    source?: 'all' | 'proxy' | 'repeater';
    method?: string;
    scheme?: string;
    status?: 'all' | '2xx' | '3xx' | '4xx' | '5xx' | 'error';
  },
): HttpMessageSummary[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  const searchTerm = input.search?.trim();
  if (searchTerm) {
    const pattern = `%${searchTerm.toLowerCase()}%`;
    conditions.push(
      `(LOWER(host) LIKE LOWER(?) OR LOWER(path) LIKE LOWER(?) OR LOWER(url) LIKE LOWER(?) OR LOWER(method) LIKE LOWER(?) OR LOWER(scheme) LIKE LOWER(?) OR CAST(COALESCE(response_status, '') AS TEXT) LIKE ?)`,
    );
    params.push(pattern, pattern, pattern, pattern, pattern, pattern);
  }

  if (input.source === 'proxy') {
    conditions.push('parent_id IS NULL');
  } else if (input.source === 'repeater') {
    conditions.push('parent_id IS NOT NULL');
  }

  if (input.method) {
    conditions.push('method = ?');
    params.push(input.method);
  }

  if (input.scheme) {
    conditions.push('scheme = ?');
    params.push(input.scheme);
  }

  if (input.status && input.status !== 'all') {
    if (input.status === 'error') {
      conditions.push('(response_status IS NULL OR response_status >= 400)');
    } else {
      const digit = input.status.charAt(0);
      const min = (digit ? parseInt(digit, 10) : 0) * 100;
      const max = min + 99;
      conditions.push('response_status >= ? AND response_status <= ?');
      params.push(min, max);
    }
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const sql = `
    SELECT id, parent_id, created_at, scheme, host, port, method, path, url, state, response_status, timing_json
    FROM http_messages
    ${whereClause}
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `;
  params.push(input.limit, input.offset);

  const stmt = db.prepare(sql);

  const rows = stmt.all(...params) as Array<{
    id: string;
    parent_id: string | null;
    created_at: string;
    scheme: string;
    host: string;
    port: number;
    method: string;
    path: string;
    url: string;
    state: string;
    response_status: number | null;
    timing_json: string;
  }>;

  return rows.map((r) =>
    HttpMessageSummarySchema.parse({
      id: r.id,
      parentId: r.parent_id,
      createdAt: r.created_at,
      scheme: r.scheme,
      host: r.host,
      port: r.port,
      method: r.method,
      path: r.path,
      url: r.url,
      state: r.state,
      responseStatus: r.response_status,
      totalMs: parseTiming(r.timing_json).totalMs,
    }),
  );
}

export function getHttpMessage(db: DatabaseSync, id: string): HttpMessageDetail | null {
  const stmt = db.prepare(`SELECT * FROM http_messages WHERE id = ?`);
  const r = stmt.get(id) as
    | undefined
    | {
        id: string;
        parent_id: string | null;
        created_at: string;
        scheme: string;
        host: string;
        port: number;
        method: string;
        path: string;
        url: string;
        state: string;
        request_headers_json: string;
        request_cookies_json: string;
        request_query_json: string;
        request_body: Buffer | null;
        request_body_text: string | null;
        request_body_json: string | null;
        response_status: number | null;
        response_headers_json: string | null;
        response_body: Buffer | null;
        response_body_text: string | null;
        response_body_json: string | null;
        replay_diff_json: string | null;
        timing_json: string;
        error: string | null;
      };

  if (!r) return null;

  const timing = parseTiming(r.timing_json);
  const reqBodyBase64 = r.request_body ? Buffer.from(r.request_body).toString('base64') : null;
  const resBodyBase64 = r.response_body ? Buffer.from(r.response_body).toString('base64') : null;

  const item = {
    id: r.id,
    parentId: r.parent_id,
    createdAt: r.created_at,
    scheme: r.scheme,
    host: r.host,
    port: r.port,
    method: r.method,
    path: r.path,
    url: r.url,
    state: r.state,
    responseStatus: r.response_status,
    totalMs: timing.totalMs,
    request: {
      headers: parseJson<Record<string, string[]>>(r.request_headers_json),
      cookies: parseJson<Record<string, string>>(r.request_cookies_json),
      query: parseJson<Record<string, string[]>>(r.request_query_json),
      bodyBase64: reqBodyBase64,
      bodyText: r.request_body_text,
      bodyJson: safeParseJson(r.request_body_json),
    },
    response: {
      headers: r.response_headers_json
        ? parseJson<Record<string, string[]>>(r.response_headers_json)
        : {},
      bodyBase64: resBodyBase64,
      bodyText: r.response_body_text,
      bodyJson: safeParseJson(r.response_body_json),
    },
    timing,
    error: r.error,
    replayDiff: safeParseJson(r.replay_diff_json),
  };

  return HttpMessageDetailSchema.parse(item);
}

export function deleteHttpMessage(db: DatabaseSync, id: string): boolean {
  const exists = db.prepare(`SELECT 1 FROM http_messages WHERE id = ?`).get(id) != null;
  if (!exists) return false;

  // Delete the selected message and any replay descendants.
  const stmt = db.prepare(`
    WITH RECURSIVE to_delete(id) AS (
      SELECT ?
      UNION ALL
      SELECT m.id
      FROM http_messages m
      JOIN to_delete d ON m.parent_id = d.id
    )
    DELETE FROM http_messages
    WHERE id IN (SELECT id FROM to_delete)
  `);
  stmt.run(id);
  return true;
}

export type InsertWsConnectionInput = {
  id: string;
  createdAt: string;
  scheme: string;
  host: string;
  port: number;
  path: string;
  url: string;
};

export function insertWsConnection(db: DatabaseSync, input: InsertWsConnectionInput) {
  const stmt = db.prepare(`
    INSERT INTO ws_connections (id, created_at, scheme, host, port, path, url)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(input.id, input.createdAt, input.scheme, input.host, input.port, input.path, input.url);
}

export type InsertWsFrameInput = {
  id: string;
  createdAt: string;
  connectionId: string;
  direction: 'client_to_server' | 'server_to_client';
  opcode: number;
  payload: Buffer;
  payloadText: string | null;
  payloadJson: string | null;
};

export function insertWsFrame(db: DatabaseSync, input: InsertWsFrameInput) {
  const stmt = db.prepare(`
    INSERT INTO ws_frames (
      id, created_at, connection_id, direction, opcode, payload, payload_text, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    input.id,
    input.createdAt,
    input.connectionId,
    input.direction,
    input.opcode,
    input.payload,
    input.payloadText,
    input.payloadJson,
  );
}

export function listWsFrames(
  db: DatabaseSync,
  input: { connectionId: string; limit: number; offset: number },
): WsFrame[] {
  const stmt = db.prepare(`
    SELECT id, created_at, direction, opcode, payload, payload_text, payload_json
    FROM ws_frames
    WHERE connection_id = ?
    ORDER BY created_at ASC
    LIMIT ? OFFSET ?
  `);

  const rows = stmt.all(input.connectionId, input.limit, input.offset) as Array<{
    id: string;
    created_at: string;
    direction: string;
    opcode: number;
    payload: unknown;
    payload_text: string | null;
    payload_json: string | null;
  }>;

  return rows.map((r) => {
    const buf = Buffer.isBuffer(r.payload)
      ? r.payload
      : r.payload instanceof Uint8Array
        ? Buffer.from(r.payload)
        : r.payload instanceof ArrayBuffer
          ? Buffer.from(new Uint8Array(r.payload))
          : Buffer.from(String(r.payload), 'utf8');
    return WsFrameSchema.parse({
      id: r.id,
      createdAt: r.created_at,
      direction: r.direction,
      opcode: r.opcode,
      payloadBase64: buf.toString('base64'),
      payloadText: r.payload_text,
      payloadJson: safeParseJson(r.payload_json),
    });
  });
}

export function listWsConnections(
  db: DatabaseSync,
  input: { limit: number; offset: number },
): WsConnection[] {
  const stmt = db.prepare(`
    SELECT id, created_at, scheme, host, port, path, url
    FROM ws_connections
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `);

  const rows = stmt.all(input.limit, input.offset) as Array<{
    id: string;
    created_at: string;
    scheme: string;
    host: string;
    port: number;
    path: string;
    url: string;
  }>;

  return rows.map((r) =>
    WsConnectionSchema.parse({
      id: r.id,
      createdAt: r.created_at,
      scheme: r.scheme,
      host: r.host,
      port: r.port,
      path: r.path,
      url: r.url,
    }),
  );
}

type SitemapRow = {
  host: string;
  port: number;
  path: string;
  requests: number;
  alerts: number;
  not_found_requests: number;
  alerts_without_404: number;
};

type SitemapPathRow = { host: string; port: number; path: string; requests: number; alerts: number };

function pathToSegments(path: string): string[] {
  const normalized = path.trim().replace(/\/+/g, '/').replace(/^\//, '') || '';
  if (!normalized) return [];
  return normalized.split('/').filter(Boolean);
}

function mergePathIntoTree(
  root: Map<string, SitemapPathNode>,
  segments: string[],
  requests: number,
  alerts: number,
): void {
  if (segments.length === 0) return;
  const [head, ...rest] = segments;
  const key = head ?? '';
  let node = root.get(key);
  if (!node) {
    node = { segment: key, requests: 0, alerts: 0, children: [] };
    root.set(key, node);
  }
  if (rest.length === 0) {
    node.requests += requests;
    node.alerts += alerts;
    return;
  }
  const childMap = new Map<string, SitemapPathNode>();
  for (const c of node.children) childMap.set(c.segment, c);
  mergePathIntoTree(childMap, rest, requests, alerts);
  node.children = Array.from(childMap.values()).sort((a, b) => a.segment.localeCompare(b.segment));
}

function rollupTree(node: SitemapPathNode): void {
  for (const child of node.children) rollupTree(child);
  node.requests += node.children.reduce((s, c) => s + c.requests, 0);
  node.alerts += node.children.reduce((s, c) => s + c.alerts, 0);
}

export function getSitemap(db: DatabaseSync, input?: { hide404?: boolean }): SitemapHost[] {
  const hide404 = input?.hide404 === true;
  const stmt = db.prepare(`
    SELECT host, port, path,
      COUNT(*) AS requests,
      SUM(CASE WHEN state = 'error' OR (response_status IS NOT NULL AND response_status >= 400) THEN 1 ELSE 0 END) AS alerts,
      SUM(CASE WHEN response_status = 404 THEN 1 ELSE 0 END) AS not_found_requests,
      SUM(CASE WHEN state = 'error' OR (response_status IS NOT NULL AND response_status >= 400 AND response_status != 404) THEN 1 ELSE 0 END) AS alerts_without_404
    FROM http_messages
    WHERE scheme IN ('http', 'https', 'ws', 'wss')
    GROUP BY host, port, path
  `);
  const rows = stmt.all() as SitemapRow[];

  const byHost = new Map<string, { host: string; port: number; pathRows: SitemapPathRow[] }>();
  for (const raw of rows) {
    const requests = hide404 ? Math.max(0, raw.requests - raw.not_found_requests) : raw.requests;
    if (requests <= 0) continue;
    const alerts = hide404 ? raw.alerts_without_404 : raw.alerts;
    const r: SitemapPathRow = { host: raw.host, port: raw.port, path: raw.path, requests, alerts };
    const key = `${r.host}:${r.port}`;
    let entry = byHost.get(key);
    if (!entry) {
      entry = { host: r.host, port: r.port, pathRows: [] };
      byHost.set(key, entry);
    }
    entry.pathRows.push(r);
  }

  const hosts: SitemapHost[] = [];
  for (const [, entry] of byHost) {
    const pathRoot = new Map<string, SitemapPathNode>();
    for (const pr of entry.pathRows) {
      const segments = pathToSegments(pr.path);
      if (segments.length === 0) {
        mergePathIntoTree(pathRoot, [''], pr.requests, pr.alerts);
      } else {
        mergePathIntoTree(pathRoot, segments, pr.requests, pr.alerts);
      }
    }
    const pathTree = Array.from(pathRoot.values()).sort((a, b) => a.segment.localeCompare(b.segment));
    for (const node of pathTree) rollupTree(node);

    const requests = entry.pathRows.reduce((s, r) => s + r.requests, 0);
    const alerts = entry.pathRows.reduce((s, r) => s + r.alerts, 0);
    const displayLabel =
      entry.port === 80 || entry.port === 443 ? entry.host : `${entry.host}:${entry.port}`;
    hosts.push({
      host: entry.host,
      port: entry.port,
      displayLabel,
      requests,
      alerts,
      pathTree,
    });
  }
  hosts.sort((a, b) => a.displayLabel.localeCompare(b.displayLabel));

  return hosts.map((h) => SitemapHostSchema.parse(h));
}
