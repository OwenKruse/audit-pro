import http from 'node:http';
import https from 'node:https';
import { randomUUID } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import type {
  AgentEvent,
  HttpMessageDetail,
  HttpMessageSummary,
  ReplayDiff,
  ReplayOverrides,
} from '@cipherscope/proto';
import {
  decodeHttpBodyTextOrNull,
  getHttpMessage,
  insertHttpMessage,
  looksLikeJson,
  normalizeHeaderRecord,
  parseCookieHeader,
  parseQueryToRecord,
  updateHttpMessageReplayDiff,
  updateHttpMessageResponse,
} from './store.js';

type Scheme = 'http' | 'https';

export class ReplayError extends Error {
  code: string;
  statusCode: number;
  constructor(input: { code: string; message: string; statusCode: number }) {
    super(input.message);
    this.code = input.code;
    this.statusCode = input.statusCode;
  }
}

function timingEmpty() {
  return {
    dnsMs: null as number | null,
    connectMs: null as number | null,
    tlsMs: null as number | null,
    ttfbMs: null as number | null,
    totalMs: null as number | null,
  };
}

function headerToString(header: string | string[] | undefined): string | undefined {
  if (header == null) return undefined;
  if (Array.isArray(header)) return header.join('; ');
  return header;
}

function formatHostHeader(input: { scheme: Scheme; host: string; port: number }): string {
  const host = input.host.includes(':') && !input.host.startsWith('[') ? `[${input.host}]` : input.host;
  const isDefaultPort =
    (input.scheme === 'https' && input.port === 443) || (input.scheme === 'http' && input.port === 80);
  return isDefaultPort ? host : `${host}:${input.port}`;
}

function isTlsValidationError(code: string | undefined): boolean {
  if (!code) return false;
  return (
    code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
    code === 'SELF_SIGNED_CERT_IN_CHAIN' ||
    code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
    code === 'CERT_HAS_EXPIRED' ||
    code === 'CERT_NOT_YET_VALID' ||
    code === 'ERR_TLS_CERT_ALTNAME_INVALID'
  );
}

function isTransportDowngradeCandidate(code: string | undefined, message: string): boolean {
  if (
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT' ||
    code === 'EHOSTUNREACH' ||
    code === 'EPIPE' ||
    code === 'EPROTO'
  ) {
    return true;
  }
  return /wrong version number|tls|ssl|socket hang up|connection reset/i.test(message);
}

function formatUpstreamError(err: unknown, host: string): string {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  const errMessage = err instanceof Error ? err.message : String(err);
  if (code === 'ENOTFOUND') return `ENOTFOUND: DNS lookup failed for ${host}`;
  return typeof code === 'string' ? `${code}: ${errMessage}` : errMessage;
}

function stripHopByHop(headers: IncomingHttpHeaders): Record<string, string | string[]> {
  const hopByHop = new Set([
    'connection',
    'proxy-connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
  ]);

  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!k) continue;
    const key = k.toLowerCase();
    if (hopByHop.has(key)) continue;
    if (v == null) continue;
    out[key] = v;
  }
  return out;
}

function recordToIncomingHeaders(headers: Record<string, string[]>): IncomingHttpHeaders {
  const out: IncomingHttpHeaders = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!v?.length) continue;
    out[k] = v.length === 1 ? v[0] : v;
  }
  return out;
}

function normalizeTargetUrl(urlStr: string): {
  scheme: Scheme;
  host: string;
  port: number;
  path: string;
  url: string;
  urlObj: URL;
} {
  let u: URL;
  try {
    u = new URL(urlStr);
  } catch {
    throw new ReplayError({
      code: 'bad_request',
      statusCode: 400,
      message: `Invalid url: ${urlStr}`,
    });
  }

  const proto = u.protocol.toLowerCase();
  if (proto !== 'http:' && proto !== 'https:') {
    throw new ReplayError({
      code: 'bad_request',
      statusCode: 400,
      message: `Only http/https urls are supported for replay (got ${u.protocol}).`,
    });
  }

  const scheme: Scheme = proto === 'https:' ? 'https' : 'http';
  const host = u.hostname;
  const port = u.port ? Number(u.port) : scheme === 'https' ? 443 : 80;
  if (!host || !Number.isFinite(port) || port <= 0) {
    throw new ReplayError({
      code: 'bad_request',
      statusCode: 400,
      message: `Invalid target host/port in url: ${urlStr}`,
    });
  }
  const path = `${u.pathname}${u.search}`;
  const url = `${scheme}://${host}:${port}${path}`;
  return { scheme, host, port, path, url, urlObj: u };
}

function escapeJsonPointer(seg: string): string {
  return seg.replace(/~/g, '~0').replace(/\//g, '~1');
}

function diffJson(
  a: unknown,
  b: unknown,
  opts: { maxChanges: number },
): { changes: Array<{ path: string; before?: unknown; after?: unknown }>; truncated: boolean } {
  const changes: Array<{ path: string; before?: unknown; after?: unknown }> = [];
  let truncated = false;

  const push = (c: { path: string; before?: unknown; after?: unknown }) => {
    if (changes.length >= opts.maxChanges) {
      truncated = true;
      return;
    }
    changes.push(c);
  };

  const isObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

  const walk = (va: unknown, vb: unknown, path: string) => {
    if (changes.length >= opts.maxChanges) {
      truncated = true;
      return;
    }
    if (Object.is(va, vb)) return;

    if (Array.isArray(va) && Array.isArray(vb)) {
      const max = Math.max(va.length, vb.length);
      for (let i = 0; i < max; i += 1) {
        const nextPath = `${path}/${i}`;
        if (i >= va.length) push({ path: nextPath, after: vb[i] });
        else if (i >= vb.length) push({ path: nextPath, before: va[i] });
        else walk(va[i], vb[i], nextPath);
        if (changes.length >= opts.maxChanges) break;
      }
      return;
    }

    if (isObject(va) && isObject(vb)) {
      const keys = new Set([...Object.keys(va), ...Object.keys(vb)]);
      const sorted = [...keys].sort();
      for (const k of sorted) {
        const nextPath = `${path}/${escapeJsonPointer(k)}`;
        if (!(k in vb)) push({ path: nextPath, before: va[k] });
        else if (!(k in va)) push({ path: nextPath, after: vb[k] });
        else walk(va[k], vb[k], nextPath);
        if (changes.length >= opts.maxChanges) break;
      }
      return;
    }

    push({ path: path || '/', before: va, after: vb });
  };

  walk(a, b, '');
  return { changes, truncated };
}

function diffHeaders(baseline: Record<string, string[]>, variant: Record<string, string[]>) {
  const keys = new Set([...Object.keys(baseline), ...Object.keys(variant)]);
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];

  for (const k of keys) {
    const a = baseline[k];
    const b = variant[k];
    if (a == null && b != null) {
      added.push(k);
      continue;
    }
    if (a != null && b == null) {
      removed.push(k);
      continue;
    }
    if (a != null && b != null) {
      if (a.length !== b.length || a.some((v, i) => v !== b[i])) changed.push(k);
    }
  }

  added.sort();
  removed.sort();
  changed.sort();
  return { added, removed, changed };
}

function computeReplayDiff(baseline: HttpMessageDetail, variant: HttpMessageDetail): ReplayDiff {
  const status = {
    baseline: baseline.responseStatus,
    variant: variant.responseStatus,
    changed: baseline.responseStatus !== variant.responseStatus,
  };

  const headers = diffHeaders(baseline.response.headers ?? {}, variant.response.headers ?? {});

  const baseJson = baseline.response.bodyJson;
  const varJson = variant.response.bodyJson;
  const baseText = baseline.response.bodyText;
  const varText = variant.response.bodyText;
  const baseB64 = baseline.response.bodyBase64;
  const varB64 = variant.response.bodyBase64;

  if (baseJson != null && varJson != null) {
    const { changes, truncated } = diffJson(baseJson, varJson, { maxChanges: 200 });
    return {
      baselineId: baseline.id,
      variantId: variant.id,
      status,
      headers,
      body: {
        changed: changes.length > 0,
        kind: 'json',
        jsonChanges: changes,
        truncated,
      },
    };
  }

  if (baseText != null && varText != null) {
    return {
      baselineId: baseline.id,
      variantId: variant.id,
      status,
      headers,
      body: {
        changed: baseText !== varText,
        kind: 'text',
        jsonChanges: [],
        truncated: false,
      },
    };
  }

  if (baseB64 != null && varB64 != null) {
    return {
      baselineId: baseline.id,
      variantId: variant.id,
      status,
      headers,
      body: {
        changed: baseB64 !== varB64,
        kind: 'binary',
        jsonChanges: [],
        truncated: false,
      },
    };
  }

  const anyBody = baseJson != null || varJson != null || baseText != null || varText != null || baseB64 != null || varB64 != null;
  return {
    baselineId: baseline.id,
    variantId: variant.id,
    status,
    headers,
    body: {
      changed: anyBody,
      kind: anyBody ? (baseJson != null || varJson != null ? 'json' : baseText != null || varText != null ? 'text' : 'binary') : 'empty',
      jsonChanges: [],
      truncated: false,
    },
  };
}

function publishHttpSummary(
  publishEvent: ((evt: AgentEvent) => void) | undefined,
  msg: Omit<HttpMessageSummary, 'parentId'> & { parentId?: string | null },
) {
  if (!publishEvent) return;
  publishEvent({
    type: 'http_message',
    time: new Date().toISOString(),
    message: { ...msg, parentId: msg.parentId ?? null } as HttpMessageSummary,
  } as AgentEvent);
}

async function sendUpstream(input: {
  scheme: Scheme;
  host: string;
  port: number;
  method: string;
  path: string;
  url: string;
  requestHeaders: Record<string, string[]>;
  requestBody: Buffer | null;
  timeoutMs?: number;
}): Promise<{
  responseStatus: number | null;
  responseHeaders: Record<string, string[]>;
  responseBody: Buffer | null;
  responseBodyText: string | null;
  responseBodyJson: string | null;
  timing: ReturnType<typeof timingEmpty>;
  error: string | null;
}> {
  const startedAt = performance.now();
  const timing = timingEmpty();
  const upstreamInsecure = process.env.AGENT_UPSTREAM_INSECURE === '1';

  const outgoingHeaders = stripHopByHop(recordToIncomingHeaders(input.requestHeaders));

  if (input.requestBody) outgoingHeaders['content-length'] = String(input.requestBody.length);
  else delete outgoingHeaders['content-length'];

  return await new Promise((resolve) => {
    const canRetryTlsValidationFailure = input.scheme === 'https' && !upstreamInsecure;
    const canDowngradeToHttp = input.scheme === 'https';
    let attemptedHttpFallback = false;

    const buildRequestOpts = (scheme: Scheme, port: number) => ({
      hostname: input.host,
      port,
      method: input.method,
      path: input.path,
      headers: {
        ...outgoingHeaders,
        host: formatHostHeader({ scheme, host: input.host, port }),
      },
      autoSelectFamily: true,
    });

    const handleResponse = (upRes: http.IncomingMessage) => {
      timing.ttfbMs = performance.now() - startedAt;

      const resChunks: Buffer[] = [];
      upRes.on('data', (c) => resChunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      upRes.on('end', () => {
        timing.totalMs = performance.now() - startedAt;

        const body = Buffer.concat(resChunks);
        const bodyBuf = body.length ? body : null;
        const bodyText = bodyBuf
          ? decodeHttpBodyTextOrNull(bodyBuf, upRes.headers['content-type'], upRes.headers['content-encoding'])
          : null;
        const contentType = headerToString(upRes.headers['content-type']);
        const bodyJson =
          looksLikeJson(contentType, bodyText) && bodyText
            ? (() => {
                try {
                  return JSON.stringify(JSON.parse(bodyText));
                } catch {
                  return null;
                }
              })()
            : null;

        const resHeaders = normalizeHeaderRecord(upRes.headers as unknown as Record<string, unknown>);

        resolve({
          responseStatus: upRes.statusCode ?? null,
          responseHeaders: resHeaders,
          responseBody: bodyBuf,
          responseBodyText: bodyText,
          responseBodyJson: bodyJson,
          timing,
          error: null,
        });
      });
    };

    const sendAttempt = (scheme: Scheme, port: number, allowInsecureTls: boolean) => {
      const requestOpts = buildRequestOpts(scheme, port);
      const upstreamReq =
        scheme === 'https'
          ? https.request({ ...requestOpts, rejectUnauthorized: !allowInsecureTls }, handleResponse)
          : http.request(requestOpts, handleResponse);

      if (input.timeoutMs != null && input.timeoutMs > 0) {
        upstreamReq.setTimeout(input.timeoutMs, () => {
          upstreamReq.destroy(new Error(`Upstream request timed out after ${input.timeoutMs}ms`));
        });
      }

      upstreamReq.on('socket', (socket) => {
        const sockStart = performance.now();
        socket.once('lookup', () => {
          timing.dnsMs = performance.now() - sockStart;
        });
        socket.once('connect', () => {
          timing.connectMs = performance.now() - sockStart;
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (socket as any).once?.('secureConnect', () => {
          timing.tlsMs = performance.now() - sockStart;
        });
      });

      upstreamReq.on('error', (err) => {
        const code = (err as NodeJS.ErrnoException | null)?.code;
        const errMessage = err instanceof Error ? err.message : String(err);
        if (
          canRetryTlsValidationFailure &&
          scheme === 'https' &&
          !allowInsecureTls &&
          (isTlsValidationError(code) || /certificate/i.test(errMessage))
        ) {
          sendAttempt('https', port, true);
          return;
        }

        if (
          canDowngradeToHttp &&
          scheme === 'https' &&
          !attemptedHttpFallback &&
          isTransportDowngradeCandidate(code, errMessage)
        ) {
          attemptedHttpFallback = true;
          const fallbackPort = port === 443 ? 80 : port;
          sendAttempt('http', fallbackPort, false);
          return;
        }

        timing.totalMs = performance.now() - startedAt;
        resolve({
          responseStatus: null,
          responseHeaders: {},
          responseBody: null,
          responseBodyText: null,
          responseBodyJson: null,
          timing,
          error: formatUpstreamError(err, input.host),
        });
      });

      if (input.requestBody) upstreamReq.end(input.requestBody);
      else upstreamReq.end();
    };

    sendAttempt(input.scheme, input.port, upstreamInsecure);
  });
}

export async function sendRawHttpRequest(input: {
  url: string;
  method: string;
  headers: Record<string, string[]>;
  body: Buffer | null;
  timeoutMs?: number;
}): Promise<{
  responseStatus: number | null;
  responseHeaders: Record<string, string[]>;
  responseBody: Buffer | null;
  responseBodyText: string | null;
  responseBodyJson: string | null;
  timing: ReturnType<typeof timingEmpty>;
  error: string | null;
}> {
  const target = normalizeTargetUrl(input.url);
  return await sendUpstream({
    scheme: target.scheme,
    host: target.host,
    port: target.port,
    method: input.method,
    path: target.path,
    url: target.url,
    requestHeaders: input.headers,
    requestBody: input.body,
    timeoutMs: input.timeoutMs,
  });
}

function parseSetCookie(headers: Record<string, string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = headers['set-cookie'];
  if (!raw?.length) return out;

  for (const line of raw) {
    const first = (line ?? '').split(';')[0] ?? '';
    const idx = first.indexOf('=');
    if (idx <= 0) continue;
    const name = first.slice(0, idx).trim();
    const value = first.slice(idx + 1).trim();
    if (!name) continue;
    out[name] = value;
  }
  return out;
}

function serializeCookies(cookies: Record<string, string>): string {
  return Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

function hasExplicitCookieOverride(overrides: ReplayOverrides | undefined): boolean {
  const h = overrides?.headers;
  if (!h) return false;
  return Object.prototype.hasOwnProperty.call(h, 'cookie') || Object.prototype.hasOwnProperty.call(h, 'Cookie');
}

export async function replayOnce(input: {
  db: DatabaseSync;
  baselineId: string;
  overrides?: ReplayOverrides;
  publishEvent?: (evt: AgentEvent) => void;
  timeoutMs?: number;
}): Promise<{ baseline: HttpMessageDetail; variant: HttpMessageDetail; diff: ReplayDiff }> {
  const baseline = getHttpMessage(input.db, input.baselineId);
  if (!baseline) {
    throw new ReplayError({ code: 'not_found', statusCode: 404, message: 'No such message.' });
  }

  if (baseline.scheme !== 'http' && baseline.scheme !== 'https') {
    throw new ReplayError({
      code: 'bad_request',
      statusCode: 400,
      message: `Replay only supports http/https messages (got scheme=${baseline.scheme}).`,
    });
  }

  const method = input.overrides?.method ?? baseline.method;
  const targetUrl = input.overrides?.url ?? baseline.url;
  const target = normalizeTargetUrl(targetUrl);

  const overrideHeaders =
    input.overrides?.headers != null
      ? normalizeHeaderRecord(input.overrides.headers as unknown as Record<string, unknown>)
      : null;

  const requestHeaders = overrideHeaders ?? baseline.request.headers;

  const requestBody = (() => {
    if (input.overrides?.bodyText != null) {
      const buf = Buffer.from(input.overrides.bodyText, 'utf8');
      return buf.length ? buf : null;
    }
    if (input.overrides?.bodyBase64 != null) {
      try {
        const buf = Buffer.from(input.overrides.bodyBase64, 'base64');
        return buf.length ? buf : null;
      } catch {
        throw new ReplayError({
          code: 'bad_request',
          statusCode: 400,
          message: 'Invalid bodyBase64.',
        });
      }
    }
    if (baseline.request.bodyBase64 != null) {
      const buf = Buffer.from(baseline.request.bodyBase64, 'base64');
      return buf.length ? buf : null;
    }
    return null;
  })();

  // Store the headers we actually intend to send (host/content-length can diverge from capture).
  const sentRequestHeaders: Record<string, string[]> = { ...requestHeaders };
  sentRequestHeaders.host = [formatHostHeader({ scheme: target.scheme, host: target.host, port: target.port })];
  if (requestBody) sentRequestHeaders['content-length'] = [String(requestBody.length)];
  else delete sentRequestHeaders['content-length'];

  const requestBodyText =
    input.overrides?.bodyText != null
      ? input.overrides.bodyText
      : requestBody
        ? decodeHttpBodyTextOrNull(
            requestBody,
            recordToIncomingHeaders(sentRequestHeaders)['content-type'],
            recordToIncomingHeaders(sentRequestHeaders)['content-encoding'],
          )
        : null;

  const contentType = headerToString(recordToIncomingHeaders(sentRequestHeaders)['content-type']);
  const requestBodyJson =
    looksLikeJson(contentType, requestBodyText) && requestBodyText
      ? (() => {
          try {
            return JSON.stringify(JSON.parse(requestBodyText));
          } catch {
            return null;
          }
        })()
      : null;

  // Apply cookie jar for batch flows (if provided by caller).
  const cookieHeader = headerToString(recordToIncomingHeaders(sentRequestHeaders)['cookie']);
  const requestCookies = parseCookieHeader(cookieHeader);
  const query = parseQueryToRecord(target.urlObj);

  const createdAt = new Date().toISOString();
  const variantId = randomUUID();

  insertHttpMessage(input.db, {
    id: variantId,
    parentId: baseline.id,
    createdAt,
    scheme: target.scheme,
    host: target.host,
    port: target.port,
    method,
    path: target.path,
    url: target.url,
    state: 'replayed',
    requestHeaders: sentRequestHeaders,
    requestCookies,
    requestQuery: query,
    requestBody,
    requestBodyText,
    requestBodyJson,
    timingJson: JSON.stringify(timingEmpty()),
    error: null,
  });

  publishHttpSummary(input.publishEvent, {
    id: variantId,
    parentId: baseline.id,
    createdAt,
    scheme: target.scheme,
    host: target.host,
    port: target.port,
    method,
    path: target.path,
    url: target.url,
    state: 'replayed',
    responseStatus: null,
    totalMs: null,
  });

  const upstream = await sendUpstream({
    scheme: target.scheme,
    host: target.host,
    port: target.port,
    method,
    path: target.path,
    url: target.url,
    requestHeaders: sentRequestHeaders,
    requestBody,
    timeoutMs: input.timeoutMs,
  });

  updateHttpMessageResponse(input.db, {
    id: variantId,
    state: upstream.error ? 'error' : 'replayed',
    responseStatus: upstream.responseStatus,
    responseHeaders: upstream.responseHeaders,
    responseBody: upstream.responseBody,
    responseBodyText: upstream.responseBodyText,
    responseBodyJson: upstream.responseBodyJson,
    timingJson: JSON.stringify(upstream.timing),
    error: upstream.error,
  });

  publishHttpSummary(input.publishEvent, {
    id: variantId,
    parentId: baseline.id,
    createdAt,
    scheme: target.scheme,
    host: target.host,
    port: target.port,
    method,
    path: target.path,
    url: target.url,
    state: upstream.error ? 'error' : 'replayed',
    responseStatus: upstream.responseStatus,
    totalMs: upstream.timing.totalMs,
  });

  const variantBeforeDiff = getHttpMessage(input.db, variantId);
  if (!variantBeforeDiff) {
    throw new ReplayError({
      code: 'internal_error',
      statusCode: 500,
      message: 'Replay persisted but could not be reloaded from SQLite.',
    });
  }

  const diff = computeReplayDiff(baseline, variantBeforeDiff);
  updateHttpMessageReplayDiff(input.db, { id: variantId, replayDiffJson: JSON.stringify(diff) });

  const variant = getHttpMessage(input.db, variantId);
  if (!variant) {
    throw new ReplayError({
      code: 'internal_error',
      statusCode: 500,
      message: 'Replay persisted but could not be reloaded from SQLite.',
    });
  }

  return { baseline, variant, diff };
}

export async function replayBatch(input: {
  db: DatabaseSync;
  items: Array<{ messageId: string; overrides?: ReplayOverrides }>;
  publishEvent?: (evt: AgentEvent) => void;
}): Promise<
  Array<
    | { ok: true; baselineId: string; variantId: string; diff: ReplayDiff }
    | { ok: false; baselineId: string; error: { code: string; message: string } }
  >
> {
  const jar: Record<string, string> = {};
  const results: Array<
    | { ok: true; baselineId: string; variantId: string; diff: ReplayDiff }
    | { ok: false; baselineId: string; error: { code: string; message: string } }
  > = [];

  for (const item of input.items) {
    try {
      const baseline = getHttpMessage(input.db, item.messageId);
      if (!baseline) {
        results.push({
          ok: false,
          baselineId: item.messageId,
          error: { code: 'not_found', message: 'No such message.' },
        });
        continue;
      }

      // For batches, update cookies unless caller explicitly overrides Cookie.
      const mergedOverrides: ReplayOverrides = item.overrides ? { ...item.overrides } : {};
      if (!hasExplicitCookieOverride(item.overrides)) {
        const merged = { ...baseline.request.cookies, ...jar };
        const headers =
          mergedOverrides.headers != null
            ? normalizeHeaderRecord(mergedOverrides.headers as unknown as Record<string, unknown>)
            : { ...baseline.request.headers };
        if (Object.keys(merged).length) headers.cookie = [serializeCookies(merged)];
        else delete headers.cookie;
        mergedOverrides.headers = headers;
      }

      const { variant, diff } = await replayOnce({
        db: input.db,
        baselineId: item.messageId,
        overrides: mergedOverrides,
        publishEvent: input.publishEvent,
      });

      const newCookies = parseSetCookie(variant.response.headers);
      for (const [k, v] of Object.entries(newCookies)) jar[k] = v;

      results.push({ ok: true, baselineId: item.messageId, variantId: variant.id, diff });
    } catch (err) {
      if (err instanceof ReplayError) {
        results.push({
          ok: false,
          baselineId: item.messageId,
          error: { code: err.code, message: err.message },
        });
      } else {
        results.push({
          ok: false,
          baselineId: item.messageId,
          error: { code: 'unknown_error', message: err instanceof Error ? err.message : String(err) },
        });
      }
    }
  }

  return results;
}
