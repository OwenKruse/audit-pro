import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { randomUUID } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import type { MetricsHandle } from './metrics.js';
import {
  decodeHttpBodyTextOrNull,
  decodeUtf8OrNull,
  insertHttpMessage,
  insertWsConnection,
  insertWsFrame,
  looksLikeJson,
  normalizeHeaderRecord,
  parseCookieHeader,
  parseQueryToRecord,
  updateHttpMessageResponse,
  updateHttpMessageState,
} from './store.js';
import type { AgentEvent, HttpMessageState, HttpMessageSummary } from '@cipherscope/proto';
import WebSocket, { WebSocketServer } from 'ws';
import { CertStore } from './certs.js';
import { normalizeIgnoredHost } from './proxy-settings.js';

export type ProxyControllerOpts = {
  host: string;
  port: number;
  tlsDir: string;
  mitmEnabled: boolean;
  upstreamInsecure: boolean;
  rpcAutoRewriteEnabled?: boolean;
  rpcRewriteUrl?: string | null;
  resolveRpcRewriteUrl?: () => string | null;
  ignoredHosts?: string[];
  getDb: () => DatabaseSync;
  metrics: MetricsHandle;
  log: {
    info: (obj: unknown, msg?: string) => void;
    warn: (obj: unknown, msg?: string) => void;
    error: (obj: unknown, msg?: string) => void;
    debug: (obj: unknown, msg?: string) => void;
  };
  publishEvent: (evt: AgentEvent) => void;
};

type Scheme = HttpMessageSummary['scheme'];
type ForwardScheme = 'http' | 'https';

const MITM_BYPASS_TTL_MS = 30 * 60 * 1000;

type UpstreamTarget = {
  scheme: ForwardScheme;
  host: string;
  port: number;
  path: string;
  url: string;
};

type InterceptEntry = {
  db: DatabaseSync;
  id: string;
  createdAt: string;
  method: string;
  scheme: Scheme;
  host: string;
  port: number;
  path: string;
  url: string;
  headers: Record<string, string[]>;
  cookies: Record<string, string>;
  query: Record<string, string[]>;
  body: Buffer | null;
  bodyText: string | null;
  bodyJson: string | null;
  upstreamTarget: UpstreamTarget;
  clientRes: http.ServerResponse;
  aborted: boolean;
};

function isAbsoluteUrl(u: string): boolean {
  return (
    u.startsWith('http://') ||
    u.startsWith('https://') ||
    u.startsWith('ws://') ||
    u.startsWith('wss://')
  );
}

function normalizeScheme(scheme: string): Scheme {
  if (
    scheme === 'http' ||
    scheme === 'https' ||
    scheme === 'connect' ||
    scheme === 'ws' ||
    scheme === 'wss'
  ) {
    return scheme;
  }
  return 'http';
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

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  if (!normalized) return false;
  if (normalized === 'localhost' || normalized === '::1') return true;
  if (normalized.startsWith('127.')) return true;
  if (normalized.startsWith('::ffff:127.')) return true;
  return false;
}

function formatUrlWithExplicitPort(input: {
  scheme: ForwardScheme;
  host: string;
  port: number;
  path: string;
}): string {
  const host = input.host.includes(':') && !input.host.startsWith('[') ? `[${input.host}]` : input.host;
  return `${input.scheme}://${host}:${input.port}${input.path}`;
}

function parseForwardUrl(raw: string | null | undefined): UpstreamTarget | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const scheme: ForwardScheme = parsed.protocol === 'https:' ? 'https' : 'http';

  const host = parsed.hostname;
  if (!host) return null;
  const port = parsed.port ? Number(parsed.port) : scheme === 'https' ? 443 : 80;
  if (!Number.isFinite(port) || port <= 0) return null;

  const path = `${parsed.pathname || '/'}${parsed.search || ''}`;
  return {
    scheme,
    host,
    port,
    path,
    url: formatUrlWithExplicitPort({ scheme, host, port, path }),
  };
}

function parseBodyJsonValue(input: { contentType: string | undefined; bodyText: string | null }): {
  bodyJson: string | null;
  parsed: unknown | null;
} {
  if (!looksLikeJson(input.contentType, input.bodyText) || !input.bodyText) {
    return { bodyJson: null, parsed: null };
  }
  try {
    const parsed = JSON.parse(input.bodyText) as unknown;
    return { bodyJson: JSON.stringify(parsed), parsed };
  } catch {
    return { bodyJson: null, parsed: null };
  }
}

function listJsonRpcMethodNames(bodyJson: unknown): string[] {
  const out: string[] = [];
  const push = (value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const obj = value as Record<string, unknown>;
    if (obj.jsonrpc !== '2.0') return;
    const method = typeof obj.method === 'string' ? obj.method.trim().toLowerCase() : '';
    if (!method) return;
    out.push(method);
  };

  if (Array.isArray(bodyJson)) {
    for (const item of bodyJson) push(item);
    return out;
  }
  push(bodyJson);
  return out;
}

const EVM_JSON_RPC_EXACT_METHODS = new Set([
  'rpc_modules',
  'eth_chainid',
  'eth_blocknumber',
  'eth_accounts',
  'eth_requestaccounts',
]);

const EVM_JSON_RPC_METHOD_PREFIXES = [
  'eth_',
  'net_',
  'web3_',
  'personal_',
  'wallet_',
  'anvil_',
  'debug_',
  'trace_',
  'txpool_',
  'engine_',
  'erigon_',
];

function isLikelyEvmJsonRpcMethod(method: string): boolean {
  if (!method) return false;
  if (EVM_JSON_RPC_EXACT_METHODS.has(method)) return true;
  return EVM_JSON_RPC_METHOD_PREFIXES.some((prefix) => method.startsWith(prefix));
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
  // Only downgrade to HTTP if there is strong evidence the server does not support HTTPS at all.
  // Generic network errors (ECONNRESET, ETIMEDOUT, EHOSTUNREACH, EPIPE) are transient and do not
  // indicate that plain HTTP would succeed — including them causes spurious HTTP retries that
  // produce confusing 502 responses or wrong content, making the proxy appear to have no internet.
  if (code === 'EPROTO') return true;
  return /wrong version number|tls alert|ssl handshake/i.test(message);
}

function formatUpstreamError(err: unknown, host: string): string {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  const errMessage = err instanceof Error ? err.message : String(err);
  if (code === 'ENOTFOUND') return `ENOTFOUND: DNS lookup failed for ${host}`;
  return typeof code === 'string' ? `${code}: ${errMessage}` : errMessage;
}

function parseConnectAuthority(input: string): { host: string; port: number } | null {
  const raw = input.trim();
  if (!raw) return null;

  if (raw.startsWith('[')) {
    const closeIdx = raw.indexOf(']');
    if (closeIdx <= 1) return null;
    const host = raw.slice(1, closeIdx).trim();
    if (!host) return null;
    const rest = raw.slice(closeIdx + 1).trim();
    if (!rest) return { host, port: 443 };
    if (!rest.startsWith(':')) return null;
    const portRaw = rest.slice(1).trim();
    if (!/^\d+$/.test(portRaw)) return null;
    const port = Number(portRaw);
    if (!Number.isFinite(port) || port <= 0) return null;
    return { host, port };
  }

  const colonCount = (raw.match(/:/g) ?? []).length;
  if (colonCount === 0) return { host: raw, port: 443 };
  if (colonCount > 1) return null;

  const idx = raw.lastIndexOf(':');
  const host = raw.slice(0, idx).trim();
  const portRaw = raw.slice(idx + 1).trim();
  if (!host || !/^\d+$/.test(portRaw)) return null;
  const port = Number(portRaw);
  if (!Number.isFinite(port) || port <= 0) return null;
  return { host, port };
}

function shouldAutoBypassMitm(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (typeof code === 'string' && code.startsWith('ERR_SSL_')) return true;
  return (
    /tls handshake timeout/i.test(message) ||
    /alert certificate unknown/i.test(message) ||
    /unsupported protocol/i.test(message) ||
    /no application protocol/i.test(message) ||
    /wrong version number/i.test(message) ||
    /unknown ca/i.test(message) ||
    /alert bad certificate/i.test(message)
  );
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

function decodeWsPayloadText(buf: Buffer, isBinary: boolean): string | null {
  const text = decodeUtf8OrNull(buf);
  if (!text) return null;
  if (!isBinary) return text;

  // It's common for upstreams to echo text messages using Buffer instances,
  // which `ws` will treat as "binary". For binary frames, keep text only if it
  // looks mostly printable to avoid polluting the DB with gibberish.
  let total = 0;
  let printable = 0;
  for (const ch of text) {
    total += 1;
    const code = ch.codePointAt(0) ?? 0;
    const isWhitespace = code === 9 || code === 10 || code === 13; // \t \n \r
    const isPrintable = isWhitespace || (code >= 32 && code !== 127);
    if (isPrintable) printable += 1;
  }
  if (total === 0) return text;
  return printable / total >= 0.9 ? text : null;
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
    req.on('aborted', () => resolve(Buffer.concat(chunks)));
  });
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

function publishHttpSummary(
  publishEvent: (evt: AgentEvent) => void,
  msg: Omit<HttpMessageSummary, 'parentId'> & { parentId?: string | null },
) {
  publishEvent({
    type: 'http_message',
    time: new Date().toISOString(),
    message: { ...msg, parentId: msg.parentId ?? null } as HttpMessageSummary,
  } as AgentEvent);
}

export class ProxyController {
  #opts: ProxyControllerOpts;
  #server: http.Server;
  #wss: WebSocketServer;
  #certs: CertStore;
  #guardedSockets = new WeakSet<net.Socket>();
  #interceptEnabled = false;
  #ignoredHosts = new Set<string>();
  #mitmBypassUntil = new Map<string, number>();
  #queue = new Map<string, InterceptEntry>();
  #listeningPort: number;

  #guardSocket(socket: net.Socket, context: string) {
    if (this.#guardedSockets.has(socket)) return;
    this.#guardedSockets.add(socket);
    socket.on('error', (err) => {
      const code = (err as NodeJS.ErrnoException | null)?.code;
      const message = err instanceof Error ? err.message : String(err);
      const transient = code != null && isTransportDowngradeCandidate(code, message);
      const teardown =
        code === 'ECONNRESET' ||
        code === 'EPIPE' ||
        code === 'ERR_STREAM_WRITE_AFTER_END';
      if (transient || teardown) {
        this.#opts.log.debug({ err, context }, 'proxy socket error');
      } else {
        this.#opts.log.warn({ err, context }, 'proxy socket error');
      }
    });
  }

  constructor(opts: ProxyControllerOpts) {
    this.#opts = opts;
    this.#listeningPort = opts.port;
    this.#wss = new WebSocketServer({ noServer: true });
    this.#certs = new CertStore({ dir: opts.tlsDir });
    this.#ignoredHosts = new Set(
      (opts.ignoredHosts ?? [])
        .map((host) => normalizeIgnoredHost(host))
        .filter((host): host is string => host != null),
    );
    this.#server = http.createServer((req, res) => void this.#handleHttpRequest(req, res));
    this.#server.on('connect', (req, clientSocket, head) => {
      const socket = clientSocket as unknown as net.Socket;
      this.#guardSocket(socket, 'proxy incoming CONNECT');
      void this.#handleConnect(req, socket, head).catch((err) => {
        this.#opts.log.error({ err }, 'proxy CONNECT handler failed');
        try {
          socket.destroy();
        } catch {
          // ignore
        }
      });
    });
    this.#server.on('upgrade', (req, socket, head) => {
      const netSocket = socket as unknown as net.Socket;
      this.#guardSocket(netSocket, 'proxy incoming upgrade');
      void this.#handleUpgrade(req, netSocket, head).catch((err) => {
        this.#opts.log.error({ err }, 'proxy upgrade handler failed');
        try {
          netSocket.destroy();
        } catch {
          // ignore
        }
      });
    });
    this.#server.on('clientError', (err, socket) => {
      this.#opts.log.debug({ err }, 'proxy clientError');
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    });
  }

  #buildOriginalUpstreamTarget(input: {
    scheme: Scheme;
    host: string;
    port: number;
    path: string;
  }): UpstreamTarget {
    const scheme: ForwardScheme = input.scheme === 'https' ? 'https' : 'http';
    return {
      scheme,
      host: input.host,
      port: input.port,
      path: input.path,
      url: formatUrlWithExplicitPort({
        scheme,
        host: input.host,
        port: input.port,
        path: input.path,
      }),
    };
  }

  #resolveConfiguredRpcRewriteTarget(): UpstreamTarget | null {
    const explicit = parseForwardUrl(this.#opts.rpcRewriteUrl);
    if (explicit) return explicit;
    if (!this.#opts.resolveRpcRewriteUrl) return null;
    try {
      return parseForwardUrl(this.#opts.resolveRpcRewriteUrl());
    } catch {
      return null;
    }
  }

  #shouldAutoRewriteRpcRequest(input: {
    method: string;
    host: string;
    headers: Record<string, string[]>;
    bodyJsonParsed: unknown | null;
    target: UpstreamTarget;
  }): boolean {
    const enabled = this.#opts.rpcAutoRewriteEnabled ?? true;
    if (!enabled) return false;
    if (isLoopbackHost(input.host)) return false;
    if (input.method.toUpperCase() !== 'POST') return false;
    if (headerToString(input.headers['x-cipherscope-no-rpc-rewrite']) != null) return false;
    if (input.bodyJsonParsed == null) return false;

    const methods = listJsonRpcMethodNames(input.bodyJsonParsed);
    if (!methods.length) return false;
    if (!methods.every((method) => isLikelyEvmJsonRpcMethod(method))) return false;

    const rewriteTarget = this.#resolveConfiguredRpcRewriteTarget();
    if (!rewriteTarget) return false;

    const sameDestination =
      input.target.scheme === rewriteTarget.scheme &&
      input.target.host === rewriteTarget.host &&
      input.target.port === rewriteTarget.port &&
      input.target.path === rewriteTarget.path;
    if (sameDestination) return false;

    return true;
  }

  #resolveUpstreamTarget(input: {
    scheme: Scheme;
    host: string;
    port: number;
    path: string;
    method: string;
    headers: Record<string, string[]>;
    bodyJsonParsed: unknown | null;
  }): UpstreamTarget {
    const originalTarget = this.#buildOriginalUpstreamTarget({
      scheme: input.scheme,
      host: input.host,
      port: input.port,
      path: input.path,
    });

    if (
      !this.#shouldAutoRewriteRpcRequest({
        method: input.method,
        host: input.host,
        headers: input.headers,
        bodyJsonParsed: input.bodyJsonParsed,
        target: originalTarget,
      })
    ) {
      return originalTarget;
    }

    const rewriteTarget = this.#resolveConfiguredRpcRewriteTarget();
    if (!rewriteTarget) return originalTarget;

    this.#opts.log.debug(
      { method: input.method, fromUrl: originalTarget.url, toUrl: rewriteTarget.url },
      'rewriting outbound evm json-rpc request to configured local rpc url',
    );
    return rewriteTarget;
  }

  async start(): Promise<{ host: string; port: number }> {
    if (this.#opts.mitmEnabled) {
      // Generate the local CA on first run so the UI can provide install instructions immediately.
      this.#certs.ensureCa();
    }

    await new Promise<void>((resolve, reject) => {
      this.#server.once('error', reject);
      this.#server.listen(this.#opts.port, this.#opts.host, () => resolve());
    });

    const addr = this.#server.address();
    if (addr && typeof addr === 'object') this.#listeningPort = addr.port;
    this.#opts.log.info({ host: this.#opts.host, port: this.#listeningPort }, 'proxy listening');
    return { host: this.#opts.host, port: this.#listeningPort };
  }

  async stop(): Promise<void> {
    for (const [, entry] of this.#queue) {
      try {
        entry.clientRes.statusCode = 504;
        entry.clientRes.end('Proxy stopped while request was intercepted.');
      } catch {
        // ignore
      }
    }
    this.#queue.clear();

    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  #db(): DatabaseSync {
    return this.#opts.getDb();
  }

  status() {
    return {
      host: this.#opts.host,
      port: this.#listeningPort,
      interceptEnabled: this.#interceptEnabled,
      interceptQueueSize: this.#queue.size,
      ignoredHosts: [...this.#ignoredHosts].sort(),
    };
  }

  ignoredHosts(): string[] {
    return [...this.#ignoredHosts].sort();
  }

  setIgnoredHosts(hosts: string[]): string[] {
    const normalized = hosts
      .map((host) => normalizeIgnoredHost(host))
      .filter((host): host is string => host != null);
    this.#ignoredHosts = new Set(normalized);
    return this.ignoredHosts();
  }

  #isHostIgnored(host: string): boolean {
    const normalized = normalizeIgnoredHost(host);
    if (!normalized) return false;
    return this.#ignoredHosts.has(normalized);
  }

  #isHostMitmBypassed(host: string): boolean {
    const normalized = normalizeIgnoredHost(host);
    if (!normalized) return false;
    const until = this.#mitmBypassUntil.get(normalized);
    if (!until) return false;
    if (until <= Date.now()) {
      this.#mitmBypassUntil.delete(normalized);
      return false;
    }
    return true;
  }

  #markHostMitmBypassed(host: string, err: unknown) {
    if (!shouldAutoBypassMitm(err)) return;
    const normalized = normalizeIgnoredHost(host);
    if (!normalized) return;
    const existing = this.#mitmBypassUntil.get(normalized);
    if (existing && existing > Date.now()) return;
    const until = Date.now() + MITM_BYPASS_TTL_MS;
    this.#mitmBypassUntil.set(normalized, until);
    this.#opts.log.warn(
      { host, until: new Date(until).toISOString(), err },
      'host marked as temporary MITM bypass after TLS negotiation failure',
    );
  }

  caPaths() {
    return this.#certs.getCaPaths();
  }

  caCertPem(): string {
    return this.#certs.getCaCertPem();
  }

  caCertDer(): Buffer {
    return this.#certs.getCaCertDer();
  }

  async smokeTest(): Promise<{ messageId: string; url: string; statusCode: number }> {
    const token = randomUUID();
    const smokePath = `/__cipherscope_smoke__/${token}`;

    const upstream = http.createServer((req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          ok: true,
          token,
          method: req.method ?? 'GET',
          url: req.url ?? '/',
        }),
      );
    });

    const upstreamPort = await new Promise<number>((resolve, reject) => {
      upstream.once('error', reject);
      upstream.listen(0, '127.0.0.1', () => {
        const addr = upstream.address();
        if (!addr || typeof addr === 'string') return reject(new Error('Bad upstream address'));
        resolve(addr.port);
      });
    });

    const proxyConnectHost = (() => {
      // If the proxy listens on "any" addresses, connect to a loopback IP explicitly.
      if (this.#opts.host === '0.0.0.0') return '127.0.0.1';
      if (this.#opts.host === '::') return '::1';
      return this.#opts.host;
    })();

    const targetUrl = `http://127.0.0.1:${upstreamPort}${smokePath}`;
    const resp = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
      const req = http.request(
        {
          host: proxyConnectHost,
          port: this.#listeningPort,
          method: 'GET',
          path: targetUrl, // absolute-form for proxy requests
          headers: {
            host: `127.0.0.1:${upstreamPort}`,
            // Ensure the smoke test isn't blocked when intercept mode is enabled.
            'x-cipherscope-no-intercept': '1',
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
          res.on('end', () =>
            resolve({
              statusCode: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString('utf8'),
            }),
          );
        },
      );
      req.on('error', reject);
      req.end();
    }).finally(() => {
      upstream.close();
    });

    if (resp.statusCode < 200 || resp.statusCode >= 400) {
      throw new Error(`Smoke test upstream failed (${resp.statusCode}).`);
    }

    let messageId: string | null = null;
    for (let i = 0; i < 30; i += 1) {
      const row = this.#db()
        .prepare(
          `
          SELECT id
          FROM http_messages
          WHERE host = ? AND port = ? AND path = ?
          ORDER BY created_at DESC
          LIMIT 1
        `,
        )
        .get('127.0.0.1', upstreamPort, smokePath) as { id: string } | undefined;
      if (row?.id) {
        messageId = row.id;
        break;
      }
      await new Promise((r) => setTimeout(r, 10));
    }

    if (!messageId) {
      throw new Error('Smoke test request completed but no captured message was found.');
    }

    return { messageId, url: targetUrl, statusCode: resp.statusCode };
  }

  setIntercept(enabled: boolean) {
    this.#interceptEnabled = enabled;
    this.#opts.publishEvent({
      type: 'intercept_queue',
      time: new Date().toISOString(),
      size: this.#queue.size,
    } as AgentEvent);
  }

  listQueue() {
    return [...this.#queue.values()].map((e) => ({
      id: e.id,
      createdAt: e.createdAt,
      method: e.method,
      host: e.host,
      port: e.port,
      path: e.path,
      url: e.url,
    }));
  }

  async forward(id: string): Promise<boolean> {
    const entry = this.#queue.get(id);
    if (!entry) return false;
    this.#queue.delete(id);
    this.#opts.publishEvent({
      type: 'intercept_queue',
      time: new Date().toISOString(),
      size: this.#queue.size,
    } as AgentEvent);

    if (entry.aborted) {
      updateHttpMessageState(entry.db, {
        id,
        state: 'error',
        error: 'Client disconnected before forward.',
      });
      return true;
    }

    await this.#forwardUpstream({
      db: entry.db,
      id,
      createdAt: entry.createdAt,
      scheme: entry.scheme,
      host: entry.host,
      port: entry.port,
      method: entry.method,
      path: entry.path,
      url: entry.url,
      headers: entry.headers,
      body: entry.body,
      upstreamTarget: entry.upstreamTarget,
      stateOnSuccess: 'forwarded',
      clientRes: entry.clientRes,
    });
    return true;
  }

  async drop(id: string): Promise<boolean> {
    const entry = this.#queue.get(id);
    if (!entry) return false;
    this.#queue.delete(id);
    this.#opts.publishEvent({
      type: 'intercept_queue',
      time: new Date().toISOString(),
      size: this.#queue.size,
    } as AgentEvent);

    updateHttpMessageState(entry.db, { id, state: 'dropped', error: null });
    try {
      entry.clientRes.statusCode = 403;
      entry.clientRes.setHeader('content-type', 'text/plain; charset=utf-8');
      entry.clientRes.end('Dropped by CipherScope intercept.');
    } catch {
      // ignore
    }
    return true;
  }

  async #handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    const rawUrl = req.url ?? '/';
    const method = req.method ?? 'GET';
    const createdAt = new Date().toISOString();
    const db = this.#db();

    let target: URL;
    try {
      if (isAbsoluteUrl(rawUrl)) target = new URL(rawUrl);
      else target = new URL(rawUrl, `http://${req.headers.host ?? 'localhost'}`);
    } catch (err) {
      res.statusCode = 400;
      res.end('Invalid URL');
      this.#opts.log.debug({ err, rawUrl }, 'invalid proxy url');
      return;
    }

    const scheme = normalizeScheme(target.protocol.slice(0, -1));
    const host = target.hostname;
    const port = target.port ? Number(target.port) : scheme === 'https' ? 443 : 80;
    const path = `${target.pathname}${target.search}`;
    const url = `${scheme}://${host}:${port}${path}`;

    const id = randomUUID();

    const headers = normalizeHeaderRecord(req.headers as unknown as Record<string, unknown>);
    const cookieHeader = headerToString(req.headers.cookie);
    const cookies = parseCookieHeader(cookieHeader);
    const query = parseQueryToRecord(target);
    const bypassIntercept = headerToString(req.headers['x-cipherscope-no-intercept']) != null;
    const willIntercept = this.#interceptEnabled && !bypassIntercept;

    const bodyBuf = (await readBody(req)) as Buffer;
    const body = bodyBuf.length ? bodyBuf : null;
    const bodyText = body
      ? decodeHttpBodyTextOrNull(body, req.headers['content-type'], req.headers['content-encoding'])
      : null;
    const contentType = headerToString(req.headers['content-type']);
    const parsedJson = parseBodyJsonValue({ contentType, bodyText });
    const bodyJson = parsedJson.bodyJson;

    const upstreamTarget = this.#resolveUpstreamTarget({
      scheme,
      host,
      port,
      path,
      method,
      headers,
      bodyJsonParsed: parsedJson.parsed,
    });

    if (this.#isHostIgnored(host)) {
      await this.#forwardUpstreamPassthrough({
        method,
        headers,
        body,
        upstreamTarget,
        clientRes: res,
      });
      return;
    }

    const timing = timingEmpty();
    insertHttpMessage(db, {
      id,
      createdAt,
      scheme,
      host,
      port,
      method,
      path,
      url,
      state: willIntercept ? 'intercepted' : 'captured',
      requestHeaders: headers,
      requestCookies: cookies,
      requestQuery: query,
      requestBody: body,
      requestBodyText: bodyText,
      requestBodyJson: bodyJson,
      timingJson: JSON.stringify(timing),
      error: null,
    });

    publishHttpSummary(this.#opts.publishEvent, {
      id,
      createdAt,
      scheme,
      host,
      port,
      method,
      path,
      url,
      state: willIntercept ? 'intercepted' : 'captured',
      responseStatus: null,
      totalMs: null,
    });

    if (willIntercept) {
      const entry: InterceptEntry = {
        db,
        id,
        createdAt,
        method,
        scheme,
        host,
        port,
        path,
        url,
        headers,
        cookies,
        query,
        body,
        bodyText,
        bodyJson,
        upstreamTarget,
        clientRes: res,
        aborted: false,
      };

      res.on('close', () => {
        // Close fires both for normal completion and aborts; treat incomplete response as abort.
        if (!res.writableEnded) {
          entry.aborted = true;
          this.#queue.delete(id);
          updateHttpMessageState(entry.db, {
            id,
            state: 'error',
            error: 'Client disconnected while intercepted.',
          });
          this.#opts.publishEvent({
            type: 'intercept_queue',
            time: new Date().toISOString(),
            size: this.#queue.size,
          } as AgentEvent);
        }
      });

      this.#queue.set(id, entry);
      this.#opts.publishEvent({
        type: 'intercept_queue',
        time: new Date().toISOString(),
        size: this.#queue.size,
      } as AgentEvent);
      return;
    }

    await this.#forwardUpstream({
      db,
      id,
      createdAt,
      scheme,
      host,
      port,
      method,
      path,
      url,
      headers,
      body,
      upstreamTarget,
      stateOnSuccess: 'captured',
      clientRes: res,
    });
  }

  async #forwardUpstream(input: {
    db: DatabaseSync;
    id: string;
    createdAt: string;
    scheme: Scheme;
    host: string;
    port: number;
    method: string;
    path: string;
    url: string;
    headers: Record<string, string[]>;
    body: Buffer | null;
    upstreamTarget: UpstreamTarget;
    stateOnSuccess: HttpMessageState;
    clientRes: http.ServerResponse;
  }) {
    const startedAt = performance.now();
    const timing = timingEmpty();

    const outgoingHeaders = stripHopByHop(
      Object.fromEntries(
        Object.entries(input.headers).map(([k, v]) => [k, v.length === 1 ? v[0] : v]),
      ) as IncomingHttpHeaders,
    );
    delete outgoingHeaders['x-cipherscope-no-intercept'];

    // Ensure Host reflects the upstream target while keeping default ports omitted.
    outgoingHeaders.host = formatHostHeader({
      scheme: input.upstreamTarget.scheme,
      host: input.upstreamTarget.host,
      port: input.upstreamTarget.port,
    });

    await new Promise<void>((resolve) => {
      const canRetryTlsValidationFailure = input.upstreamTarget.scheme === 'https' && !this.#opts.upstreamInsecure;
      const canDowngradeToHttp = input.upstreamTarget.scheme === 'https';
      let attemptedHttpFallback = false;

      const buildRequestOpts = (scheme: 'http' | 'https', port: number) => ({
        hostname: input.upstreamTarget.host,
        port,
        method: input.method,
        path: input.upstreamTarget.path,
        headers: {
          ...outgoingHeaders,
          host: formatHostHeader({ scheme, host: input.upstreamTarget.host, port }),
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
            ? decodeHttpBodyTextOrNull(
                bodyBuf,
                upRes.headers['content-type'],
                upRes.headers['content-encoding'],
              )
            : null;
          const contentType = headerToString(upRes.headers['content-type']);
          const bodyJson = parseBodyJsonValue({ contentType, bodyText }).bodyJson;

          const resHeaders = normalizeHeaderRecord(upRes.headers as unknown as Record<string, unknown>);
          updateHttpMessageResponse(input.db, {
            id: input.id,
            state: input.stateOnSuccess,
            responseStatus: upRes.statusCode ?? null,
            responseHeaders: resHeaders,
            responseBody: bodyBuf,
            responseBodyText: bodyText,
            responseBodyJson: bodyJson,
            timingJson: JSON.stringify(timing),
            error: null,
          });

          publishHttpSummary(this.#opts.publishEvent, {
            id: input.id,
            createdAt: input.createdAt,
            scheme: input.scheme,
            host: input.host,
            port: input.port,
            method: input.method,
            path: input.path,
            url: input.url,
            state: input.stateOnSuccess,
            responseStatus: upRes.statusCode ?? null,
            totalMs: timing.totalMs,
          });

          try {
            const clientHeaders = stripHopByHop(upRes.headers);
            input.clientRes.writeHead(upRes.statusCode ?? 502, clientHeaders);
            input.clientRes.end(bodyBuf ?? Buffer.alloc(0));
          } catch (err) {
            this.#opts.log.debug({ err }, 'failed sending response to client');
          }

          resolve();
        });
      };

      const sendUpstream = (scheme: 'http' | 'https', port: number, allowInsecureTls: boolean) => {
        const requestOpts = buildRequestOpts(scheme, port);
        const upstreamReq =
          scheme === 'https'
            ? https.request(
                { ...requestOpts, rejectUnauthorized: !allowInsecureTls },
                handleResponse,
              )
            : http.request(requestOpts, handleResponse);

        upstreamReq.setTimeout(30_000, () => {
          upstreamReq.destroy(Object.assign(new Error('Upstream request timed out'), { code: 'ETIMEDOUT' }));
        });

        upstreamReq.on('socket', (socket) => {
          // Only attach timing listeners on a fresh connection; a reused keep-alive socket
          // has already fired these events and the once() listeners would accumulate.
          if (!socket.connecting) return;
          const sockStart = performance.now();
          socket.once('lookup', () => {
            timing.dnsMs = performance.now() - sockStart;
          });
          socket.once('connect', () => {
            timing.connectMs = performance.now() - sockStart;
          });
          // For HTTPS, secureConnect will fire. For HTTP it won't.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (socket as any).once?.('secureConnect', () => {
            timing.tlsMs = performance.now() - sockStart;
          });
        });

        upstreamReq.on('error', (err) => {
          const code = (err as NodeJS.ErrnoException | null)?.code;
          const errMessage = err instanceof Error ? err.message : String(err);
          const errorDetail = formatUpstreamError(err, input.upstreamTarget.host);

          if (
            canRetryTlsValidationFailure &&
            scheme === 'https' &&
            !allowInsecureTls &&
            (isTlsValidationError(code) || /certificate/i.test(errMessage))
          ) {
            this.#opts.log.warn(
              { host: input.upstreamTarget.host, port, code, message: errMessage },
              'upstream tls verification failed; retrying once with insecure tls',
            );
            sendUpstream(scheme, port, true);
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
            this.#opts.log.warn(
              { host: input.upstreamTarget.host, fromPort: port, toPort: fallbackPort, code, message: errMessage },
              'upstream https transport failed; retrying once over plain http',
            );
            sendUpstream('http', fallbackPort, false);
            return;
          }

          timing.totalMs = performance.now() - startedAt;
          updateHttpMessageResponse(input.db, {
            id: input.id,
            state: 'error',
            responseStatus: null,
            responseHeaders: {},
            responseBody: null,
            responseBodyText: null,
            responseBodyJson: null,
            timingJson: JSON.stringify(timing),
            error: errorDetail,
          });

          publishHttpSummary(this.#opts.publishEvent, {
            id: input.id,
            createdAt: input.createdAt,
            scheme: input.scheme,
            host: input.host,
            port: input.port,
            method: input.method,
            path: input.path,
            url: input.url,
            state: 'error',
            responseStatus: null,
            totalMs: timing.totalMs,
          });

          try {
            input.clientRes.statusCode = 502;
            input.clientRes.setHeader('content-type', 'text/plain; charset=utf-8');
            input.clientRes.end(`Upstream request failed: ${errorDetail}`);
          } catch {
            // ignore
          }
          resolve();
        });

        if (input.body) upstreamReq.end(input.body);
        else upstreamReq.end();
      };

      sendUpstream(input.upstreamTarget.scheme, input.upstreamTarget.port, this.#opts.upstreamInsecure);
    });
  }

  async #forwardUpstreamPassthrough(input: {
    method: string;
    headers: Record<string, string[]>;
    body: Buffer | null;
    upstreamTarget: UpstreamTarget;
    clientRes: http.ServerResponse;
  }) {
    const outgoingHeaders = stripHopByHop(
      Object.fromEntries(
        Object.entries(input.headers).map(([k, v]) => [k, v.length === 1 ? v[0] : v]),
      ) as IncomingHttpHeaders,
    );
    delete outgoingHeaders['x-cipherscope-no-intercept'];
    outgoingHeaders.host = formatHostHeader({
      scheme: input.upstreamTarget.scheme,
      host: input.upstreamTarget.host,
      port: input.upstreamTarget.port,
    });

    await new Promise<void>((resolve) => {
      const canRetryTlsValidationFailure = input.upstreamTarget.scheme === 'https' && !this.#opts.upstreamInsecure;
      const canDowngradeToHttp = input.upstreamTarget.scheme === 'https';
      let attemptedHttpFallback = false;

      const buildRequestOpts = (scheme: 'http' | 'https', port: number) => ({
        hostname: input.upstreamTarget.host,
        port,
        method: input.method,
        path: input.upstreamTarget.path,
        headers: {
          ...outgoingHeaders,
          host: formatHostHeader({ scheme, host: input.upstreamTarget.host, port }),
        },
        autoSelectFamily: true,
      });

      const handleResponse = (upRes: http.IncomingMessage) => {
        const resChunks: Buffer[] = [];
        upRes.on('data', (c) => resChunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        upRes.on('end', () => {
          const body = Buffer.concat(resChunks);
          const bodyBuf = body.length ? body : null;

          try {
            const clientHeaders = stripHopByHop(upRes.headers);
            input.clientRes.writeHead(upRes.statusCode ?? 502, clientHeaders);
            input.clientRes.end(bodyBuf ?? Buffer.alloc(0));
          } catch (err) {
            this.#opts.log.debug({ err }, 'failed sending passthrough response to client');
          }
          resolve();
        });
      };

      const sendUpstream = (scheme: 'http' | 'https', port: number, allowInsecureTls: boolean) => {
        const requestOpts = buildRequestOpts(scheme, port);
        const upstreamReq =
          scheme === 'https'
            ? https.request(
                { ...requestOpts, rejectUnauthorized: !allowInsecureTls },
                handleResponse,
              )
            : http.request(requestOpts, handleResponse);

        upstreamReq.setTimeout(30_000, () => {
          upstreamReq.destroy(Object.assign(new Error('Upstream request timed out'), { code: 'ETIMEDOUT' }));
        });

        upstreamReq.on('error', (err) => {
          const code = (err as NodeJS.ErrnoException | null)?.code;
          const errMessage = err instanceof Error ? err.message : String(err);
          const errorDetail = formatUpstreamError(err, input.upstreamTarget.host);

          if (
            canRetryTlsValidationFailure &&
            scheme === 'https' &&
            !allowInsecureTls &&
            (isTlsValidationError(code) || /certificate/i.test(errMessage))
          ) {
            this.#opts.log.warn(
              { host: input.upstreamTarget.host, port, code, message: errMessage },
              'upstream tls verification failed for ignored host; retrying once with insecure tls',
            );
            sendUpstream(scheme, port, true);
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
            this.#opts.log.warn(
              { host: input.upstreamTarget.host, fromPort: port, toPort: fallbackPort, code, message: errMessage },
              'upstream https transport failed for ignored host; retrying once over plain http',
            );
            sendUpstream('http', fallbackPort, false);
            return;
          }

          try {
            input.clientRes.statusCode = 502;
            input.clientRes.setHeader('content-type', 'text/plain; charset=utf-8');
            input.clientRes.end(`Upstream request failed: ${errorDetail}`);
          } catch {
            // ignore
          }
          resolve();
        });

        if (input.body) upstreamReq.end(input.body);
        else upstreamReq.end();
      };

      sendUpstream(input.upstreamTarget.scheme, input.upstreamTarget.port, this.#opts.upstreamInsecure);
    });
  }

  async #tunnelPassthrough(clientSocket: net.Socket, head: Buffer, host: string, port: number) {
    await new Promise<void>((resolve) => {
      this.#guardSocket(clientSocket, 'proxy CONNECT passthrough client');
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };

      const serverSocket = net.connect(port, host, () => {
        this.#guardSocket(serverSocket, 'proxy CONNECT passthrough upstream');
        try {
          clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (head?.length) serverSocket.write(head);
          serverSocket.pipe(clientSocket);
          clientSocket.pipe(serverSocket);
        } catch {
          // ignore
        }
        finish();
      });

      const safeDestroy = (peer: net.Socket) => {
        try {
          peer.unpipe();
          if (peer === serverSocket) clientSocket.unpipe(serverSocket);
          else serverSocket.unpipe(clientSocket);
        } catch {
          // ignore
        }
        try {
          if (!peer.destroyed) peer.destroy();
        } catch {
          // ignore
        }
      };

      clientSocket.on('close', () => {
        safeDestroy(serverSocket);
        finish();
      });

      clientSocket.on('error', () => {
        safeDestroy(serverSocket);
        finish();
      });

      serverSocket.on('close', () => {
        safeDestroy(clientSocket);
        finish();
      });

      serverSocket.on('error', () => {
        try {
          if (!clientSocket.destroyed && clientSocket.writable) {
            clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
          }
        } catch {
          // ignore write errors (e.g. client already closed)
        }
        safeDestroy(clientSocket);
        finish();
      });
    });
  }

  async #handleConnect(req: http.IncomingMessage, clientSocket: net.Socket, head: Buffer) {
    this.#guardSocket(clientSocket, 'proxy CONNECT client');
    const createdAt = new Date().toISOString();
    const id = randomUUID();

    const raw = req.url ?? '';
    const target = parseConnectAuthority(raw);
    const host = target?.host ?? '';
    const port = target?.port ?? 0;
    const scheme: Scheme = 'connect';
    if (!target) {
      try {
        clientSocket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      } finally {
        clientSocket.destroy();
      }
      return;
    }

    if (this.#isHostIgnored(host)) {
      await this.#tunnelPassthrough(clientSocket, head, host, port);
      return;
    }

    const path = raw;
    const authority = host.includes(':') && !host.startsWith('[') ? `[${host}]:${port}` : `${host}:${port}`;
    const url = `connect://${authority}`;

    const headers = normalizeHeaderRecord(req.headers as unknown as Record<string, unknown>);
    const cookieHeader = headerToString(req.headers.cookie);
    const cookies = parseCookieHeader(cookieHeader);

    insertHttpMessage(this.#db(), {
      id,
      createdAt,
      scheme,
      host,
      port,
      method: 'CONNECT',
      path,
      url,
      state: 'tunnel',
      requestHeaders: headers,
      requestCookies: cookies,
      requestQuery: {},
      requestBody: null,
      requestBodyText: null,
      requestBodyJson: null,
      timingJson: JSON.stringify(timingEmpty()),
      error: null,
    });

    publishHttpSummary(this.#opts.publishEvent, {
      id,
      createdAt,
      scheme,
      host,
      port,
      method: 'CONNECT',
      path,
      url,
      state: 'tunnel',
      responseStatus: null,
      totalMs: null,
    });

    const mitmAllowed = this.#opts.mitmEnabled && !this.#isHostMitmBypassed(host);

    if (mitmAllowed) {
      let hostCert: { keyPem: string; certPem: string } | null = null;
      try {
        hostCert = this.#certs.getOrCreateHostCert(host);
      } catch (err) {
        updateHttpMessageState(this.#db(), {
          id,
          state: 'error',
          error: err instanceof Error ? err.message : String(err),
        });
        try {
          clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        } finally {
          clientSocket.destroy();
        }
        return;
      }

      const startedAt = performance.now();
      try {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head?.length) clientSocket.unshift(head);
      } catch (err) {
        updateHttpMessageState(this.#db(), {
          id,
          state: 'error',
          error: err instanceof Error ? err.message : String(err),
        });
        clientSocket.destroy();
        return;
      }

      const timing = timingEmpty();
      timing.totalMs = performance.now() - startedAt;
      updateHttpMessageResponse(this.#db(), {
        id,
        state: 'tunnel',
        responseStatus: 200,
        responseHeaders: {},
        responseBody: null,
        responseBodyText: null,
        responseBodyJson: null,
        timingJson: JSON.stringify(timing),
        error: null,
      });

      publishHttpSummary(this.#opts.publishEvent, {
        id,
        createdAt,
        scheme,
        host,
        port,
        method: 'CONNECT',
        path,
        url,
        state: 'tunnel',
        responseStatus: 200,
        totalMs: timing.totalMs,
      });

      const tlsServer = tls.createServer(
        {
          key: hostCert.keyPem,
          cert: hostCert.certPem,
          // Force HTTP/1.1 to keep the MITM pipeline simple.
          ALPNProtocols: ['http/1.1'],
        },
        (tlsSocket) => {
          this.#guardSocket(tlsSocket, 'proxy MITM tls client');
          const mitmServer = http.createServer((innerReq, innerRes) =>
            void this.#handleMitmHttpRequest(innerReq, innerRes, host, port),
          );
          mitmServer.on('upgrade', (innerReq, innerSocket, innerHead) =>
            void this.#handleMitmUpgrade(
              innerReq,
              innerSocket as unknown as net.Socket,
              innerHead,
              host,
              port,
            ).catch((err) => {
              this.#opts.log.error({ err, host, port }, 'mitm upgrade handler failed');
              try {
                (innerSocket as unknown as net.Socket).destroy();
              } catch {
                // ignore
              }
            }),
          );
          mitmServer.on('clientError', (_err, sock) => {
            try {
              sock.end('HTTP/1.1 400 Bad Request\r\n\r\n');
            } catch {
              // ignore
            }
          });

          tlsSocket.on('close', () => {
            try {
              mitmServer.close();
            } catch {
              // ignore
            }
            try {
              tlsServer.close();
            } catch {
              // ignore
            }
          });

          mitmServer.emit('connection', tlsSocket);
        },
      );

      tlsServer.on('tlsClientError', (err) => {
        this.#opts.log.debug({ err, host, port }, 'mitm tls client error');
        this.#markHostMitmBypassed(host, err);
        updateHttpMessageState(this.#db(), {
          id,
          state: 'error',
          error: err instanceof Error ? err.message : String(err),
        });
        try {
          tlsServer.close();
        } catch {
          // ignore
        }
        try {
          clientSocket.destroy();
        } catch {
          // ignore
        }
      });

      tlsServer.on('error', (err) => {
        this.#opts.log.debug({ err, host, port }, 'mitm tls server error');
        this.#markHostMitmBypassed(host, err);
        updateHttpMessageState(this.#db(), {
          id,
          state: 'error',
          error: err instanceof Error ? err.message : String(err),
        });
        try {
          tlsServer.close();
        } catch {
          // ignore
        }
        try {
          clientSocket.destroy();
        } catch {
          // ignore
        }
      });

      tlsServer.emit('connection', clientSocket);
      return;
    }

    const startedAt = performance.now();
    const serverSocket = net.connect(port, host, () => {
      this.#guardSocket(serverSocket, 'proxy CONNECT upstream');
      const timing = timingEmpty();
      timing.totalMs = performance.now() - startedAt;
      updateHttpMessageResponse(this.#db(), {
        id,
        state: 'tunnel',
        responseStatus: 200,
        responseHeaders: {},
        responseBody: null,
        responseBodyText: null,
        responseBodyJson: null,
        timingJson: JSON.stringify(timing),
        error: null,
      });

      publishHttpSummary(this.#opts.publishEvent, {
        id,
        createdAt,
        scheme,
        host,
        port,
        method: 'CONNECT',
        path,
        url,
        state: 'tunnel',
        responseStatus: 200,
        totalMs: timing.totalMs,
      });

      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) serverSocket.write(head);
      serverSocket.pipe(clientSocket);
      clientSocket.pipe(serverSocket);
    });

    clientSocket.on('close', () => {
      try {
        serverSocket.destroy();
      } catch {
        // ignore
      }
    });

    clientSocket.on('error', () => {
      try {
        serverSocket.destroy();
      } catch {
        // ignore
      }
    });

    serverSocket.on('close', () => {
      try {
        clientSocket.destroy();
      } catch {
        // ignore
      }
    });

    serverSocket.on('error', (err) => {
      const timing = timingEmpty();
      timing.totalMs = performance.now() - startedAt;
      updateHttpMessageResponse(this.#db(), {
        id,
        state: 'error',
        responseStatus: null,
        responseHeaders: {},
        responseBody: null,
        responseBodyText: null,
        responseBodyJson: null,
        timingJson: JSON.stringify(timing),
        error: err instanceof Error ? err.message : String(err),
      });

      try {
        clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      } finally {
        clientSocket.destroy();
      }
    });
  }

  async #handleUpgrade(req: http.IncomingMessage, socket: net.Socket, head: Buffer) {
    this.#guardSocket(socket, 'proxy ws upgrade socket');
    // Only ws:// is supported without TLS MITM. For wss://, the browser uses CONNECT.
    const rawUrl = req.url ?? '/';
    let target: URL;
    try {
      if (isAbsoluteUrl(rawUrl)) target = new URL(rawUrl);
      else target = new URL(rawUrl, `ws://${req.headers.host ?? 'localhost'}`);
    } catch (err) {
      this.#opts.log.debug({ err, rawUrl }, 'invalid ws upgrade url');
      socket.destroy();
      return;
    }

    const scheme = normalizeScheme(target.protocol.slice(0, -1));
    const host = target.hostname;
    const port = target.port ? Number(target.port) : scheme === 'wss' ? 443 : 80;
    const path = `${target.pathname}${target.search}`;
    const url = `${scheme}://${host}:${port}${path}`;
    const capture = !this.#isHostIgnored(host);
    const connectionId = capture ? randomUUID() : null;
    const createdAt = new Date().toISOString();

    if (connectionId) {
      insertWsConnection(this.#db(), {
        id: connectionId,
        createdAt,
        scheme,
        host,
        port,
        path,
        url,
      });

      // Also insert a history row so WebSockets are visible in History.
      insertHttpMessage(this.#db(), {
        id: connectionId,
        createdAt,
        scheme,
        host,
        port,
        method: 'GET',
        path,
        url,
        state: 'captured',
        requestHeaders: normalizeHeaderRecord(req.headers as unknown as Record<string, unknown>),
        requestCookies: parseCookieHeader(headerToString(req.headers.cookie)),
        requestQuery: parseQueryToRecord(target),
        requestBody: null,
        requestBodyText: null,
        requestBodyJson: null,
        timingJson: JSON.stringify(timingEmpty()),
        error: null,
      });

      updateHttpMessageResponse(this.#db(), {
        id: connectionId,
        state: 'captured',
        responseStatus: 101,
        responseHeaders: {},
        responseBody: null,
        responseBodyText: null,
        responseBodyJson: null,
        timingJson: JSON.stringify(timingEmpty()),
        error: null,
      });

      publishHttpSummary(this.#opts.publishEvent, {
        id: connectionId,
        createdAt,
        scheme,
        host,
        port,
        method: 'GET',
        path,
        url,
        state: 'captured',
        responseStatus: 101,
        totalMs: null,
      });
    }

    this.#wss.handleUpgrade(req, socket, head, (clientWs) => {
      const protocolsHeader = headerToString(req.headers['sec-websocket-protocol']);
      const protocols = protocolsHeader
        ? protocolsHeader
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined;

      const upstreamHeaders = stripHopByHop(req.headers);
      delete upstreamHeaders['x-cipherscope-no-intercept'];
      delete upstreamHeaders['sec-websocket-key'];
      delete upstreamHeaders['sec-websocket-version'];
      delete upstreamHeaders['sec-websocket-extensions'];
      delete upstreamHeaders['sec-websocket-protocol'];
      delete upstreamHeaders['host'];

      const upstreamWs = new WebSocket(url, protocols, {
        headers: upstreamHeaders,
        rejectUnauthorized: !this.#opts.upstreamInsecure,
      });

      const rawToBuffer = (data: WebSocket.RawData): Buffer => {
        if (typeof data === 'string') return Buffer.from(data, 'utf8');
        if (Buffer.isBuffer(data)) return data;
        if (data instanceof ArrayBuffer) return Buffer.from(data);
        if (Array.isArray(data)) {
          return Buffer.concat(
            data.map((d) => (Buffer.isBuffer(d) ? d : Buffer.from(d as ArrayBuffer))),
          );
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return Buffer.from(data as any);
      };

      const recordFrame = (
        direction: 'client_to_server' | 'server_to_client',
        data: WebSocket.RawData,
        isBinary: boolean,
      ) => {
        if (!connectionId) return;
        const buf = rawToBuffer(data);
        const text = decodeWsPayloadText(buf, isBinary);
        const json =
          text && looksLikeJson(undefined, text)
            ? (() => {
                try {
                  return JSON.stringify(JSON.parse(text));
                } catch {
                  return null;
                }
              })()
            : null;

        insertWsFrame(this.#db(), {
          id: randomUUID(),
          createdAt: new Date().toISOString(),
          connectionId,
          direction,
          opcode: isBinary ? 2 : 1,
          payload: buf,
          payloadText: text,
          payloadJson: json,
        });
      };

      const closeBoth = () => {
        try {
          clientWs.close();
        } catch {
          // ignore
        }
        try {
          upstreamWs.close();
        } catch {
          // ignore
        }
      };

      type PendingToUpstream =
        | { type: 'message'; data: WebSocket.RawData; isBinary: boolean }
        | { type: 'ping'; data: Buffer }
        | { type: 'pong'; data: Buffer };

      const pendingToUpstream: PendingToUpstream[] = [];

      const flushToUpstream = () => {
        if (upstreamWs.readyState !== WebSocket.OPEN) return;
        for (const item of pendingToUpstream.splice(0)) {
          try {
            if (item.type === 'message') upstreamWs.send(item.data, { binary: item.isBinary });
            else if (item.type === 'ping') upstreamWs.ping(item.data);
            else upstreamWs.pong(item.data);
          } catch (err) {
            this.#opts.log.debug({ err }, 'failed flushing pending upstream ws data');
            closeBoth();
            return;
          }
        }
      };

      upstreamWs.on('open', flushToUpstream);
      // If the socket is already open (unlikely), flush immediately.
      flushToUpstream();

      const sendToUpstream = (item: PendingToUpstream) => {
        if (upstreamWs.readyState === WebSocket.OPEN) {
          pendingToUpstream.push(item);
          flushToUpstream();
          return;
        }
        if (upstreamWs.readyState === WebSocket.CONNECTING) {
          pendingToUpstream.push(item);
          return;
        }
        // CLOSED/CLOSING: drop.
      };

      clientWs.on('message', (data, isBinary) => {
        recordFrame('client_to_server', data, Boolean(isBinary));
        sendToUpstream({ type: 'message', data, isBinary: Boolean(isBinary) });
      });

      upstreamWs.on('message', (data, isBinary) => {
        recordFrame('server_to_client', data, Boolean(isBinary));
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(data, { binary: Boolean(isBinary) });
        }
      });

      clientWs.on('ping', (data) => {
        if (!connectionId) {
          sendToUpstream({ type: 'ping', data: Buffer.from(data) });
          return;
        }
        insertWsFrame(this.#db(), {
          id: randomUUID(),
          createdAt: new Date().toISOString(),
          connectionId,
          direction: 'client_to_server',
          opcode: 9,
          payload: Buffer.from(data),
          payloadText: null,
          payloadJson: null,
        });
        sendToUpstream({ type: 'ping', data: Buffer.from(data) });
      });

      upstreamWs.on('ping', (data) => {
        if (!connectionId) {
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.ping(data);
          }
          return;
        }
        insertWsFrame(this.#db(), {
          id: randomUUID(),
          createdAt: new Date().toISOString(),
          connectionId,
          direction: 'server_to_client',
          opcode: 9,
          payload: Buffer.from(data),
          payloadText: null,
          payloadJson: null,
        });
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.ping(data);
        }
      });

      clientWs.on('pong', (data) => {
        if (!connectionId) {
          sendToUpstream({ type: 'pong', data: Buffer.from(data) });
          return;
        }
        insertWsFrame(this.#db(), {
          id: randomUUID(),
          createdAt: new Date().toISOString(),
          connectionId,
          direction: 'client_to_server',
          opcode: 10,
          payload: Buffer.from(data),
          payloadText: null,
          payloadJson: null,
        });
        sendToUpstream({ type: 'pong', data: Buffer.from(data) });
      });

      upstreamWs.on('pong', (data) => {
        if (!connectionId) {
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.pong(data);
          }
          return;
        }
        insertWsFrame(this.#db(), {
          id: randomUUID(),
          createdAt: new Date().toISOString(),
          connectionId,
          direction: 'server_to_client',
          opcode: 10,
          payload: Buffer.from(data),
          payloadText: null,
          payloadJson: null,
        });
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.pong(data);
        }
      });

      clientWs.on('close', closeBoth);
      upstreamWs.on('close', closeBoth);

      upstreamWs.on('error', (err) => {
        this.#opts.log.debug({ err }, 'upstream ws error');
        closeBoth();
      });

      clientWs.on('error', (err) => {
        this.#opts.log.debug({ err }, 'client ws error');
        closeBoth();
      });
    });
  }

  async #handleMitmHttpRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    tunnelHost: string,
    tunnelPort: number,
  ) {
    const rawUrl = req.url ?? '/';
    const method = req.method ?? 'GET';
    const createdAt = new Date().toISOString();
    const db = this.#db();

    let target: URL;
    try {
      target = new URL(rawUrl, `https://${tunnelHost}:${tunnelPort}`);
    } catch (err) {
      res.statusCode = 400;
      res.end('Invalid URL');
      this.#opts.log.debug({ err, rawUrl }, 'invalid mitm url');
      return;
    }

    const scheme: Scheme = 'https';
    const host = tunnelHost;
    const port = tunnelPort;
    const path = `${target.pathname}${target.search}`;
    const url = `${scheme}://${host}:${port}${path}`;

    const id = randomUUID();

    const headers = normalizeHeaderRecord(req.headers as unknown as Record<string, unknown>);
    const cookieHeader = headerToString(req.headers.cookie);
    const cookies = parseCookieHeader(cookieHeader);
    const query = parseQueryToRecord(target);
    const bypassIntercept = headerToString(req.headers['x-cipherscope-no-intercept']) != null;
    const willIntercept = this.#interceptEnabled && !bypassIntercept;

    const bodyBuf = (await readBody(req)) as Buffer;
    const body = bodyBuf.length ? bodyBuf : null;
    const bodyText = body
      ? decodeHttpBodyTextOrNull(body, req.headers['content-type'], req.headers['content-encoding'])
      : null;
    const contentType = headerToString(req.headers['content-type']);
    const parsedJson = parseBodyJsonValue({ contentType, bodyText });
    const bodyJson = parsedJson.bodyJson;

    const upstreamTarget = this.#resolveUpstreamTarget({
      scheme,
      host,
      port,
      path,
      method,
      headers,
      bodyJsonParsed: parsedJson.parsed,
    });

    if (this.#isHostIgnored(host)) {
      await this.#forwardUpstreamPassthrough({
        method,
        headers,
        body,
        upstreamTarget,
        clientRes: res,
      });
      return;
    }

    const timing = timingEmpty();
    insertHttpMessage(db, {
      id,
      createdAt,
      scheme,
      host,
      port,
      method,
      path,
      url,
      state: willIntercept ? 'intercepted' : 'captured',
      requestHeaders: headers,
      requestCookies: cookies,
      requestQuery: query,
      requestBody: body,
      requestBodyText: bodyText,
      requestBodyJson: bodyJson,
      timingJson: JSON.stringify(timing),
      error: null,
    });

    publishHttpSummary(this.#opts.publishEvent, {
      id,
      createdAt,
      scheme,
      host,
      port,
      method,
      path,
      url,
      state: willIntercept ? 'intercepted' : 'captured',
      responseStatus: null,
      totalMs: null,
    });

    if (willIntercept) {
      const entry: InterceptEntry = {
        db,
        id,
        createdAt,
        method,
        scheme,
        host,
        port,
        path,
        url,
        headers,
        cookies,
        query,
        body,
        bodyText,
        bodyJson,
        upstreamTarget,
        clientRes: res,
        aborted: false,
      };

      res.on('close', () => {
        if (!res.writableEnded) {
          entry.aborted = true;
          this.#queue.delete(id);
          updateHttpMessageState(entry.db, {
            id,
            state: 'error',
            error: 'Client disconnected while intercepted.',
          });
          this.#opts.publishEvent({
            type: 'intercept_queue',
            time: new Date().toISOString(),
            size: this.#queue.size,
          } as AgentEvent);
        }
      });

      this.#queue.set(id, entry);
      this.#opts.publishEvent({
        type: 'intercept_queue',
        time: new Date().toISOString(),
        size: this.#queue.size,
      } as AgentEvent);
      return;
    }

    await this.#forwardUpstream({
      db,
      id,
      createdAt,
      scheme,
      host,
      port,
      method,
      path,
      url,
      headers,
      body,
      upstreamTarget,
      stateOnSuccess: 'captured',
      clientRes: res,
    });
  }

  async #handleMitmUpgrade(
    req: http.IncomingMessage,
    socket: net.Socket,
    head: Buffer,
    tunnelHost: string,
    tunnelPort: number,
  ) {
    this.#guardSocket(socket, 'proxy wss mitm upgrade socket');
    const rawUrl = req.url ?? '/';
    let target: URL;
    try {
      target = new URL(rawUrl, `wss://${tunnelHost}:${tunnelPort}`);
    } catch (err) {
      this.#opts.log.debug({ err, rawUrl }, 'invalid wss upgrade url');
      socket.destroy();
      return;
    }

    const scheme: Scheme = 'wss';
    const host = tunnelHost;
    const port = tunnelPort;
    const path = `${target.pathname}${target.search}`;
    const url = `${scheme}://${host}:${port}${path}`;
    const capture = !this.#isHostIgnored(host);
    const connectionId = capture ? randomUUID() : null;
    const createdAt = new Date().toISOString();

    if (connectionId) {
      insertWsConnection(this.#db(), {
        id: connectionId,
        createdAt,
        scheme,
        host,
        port,
        path,
        url,
      });

      insertHttpMessage(this.#db(), {
        id: connectionId,
        createdAt,
        scheme,
        host,
        port,
        method: 'GET',
        path,
        url,
        state: 'captured',
        requestHeaders: normalizeHeaderRecord(req.headers as unknown as Record<string, unknown>),
        requestCookies: parseCookieHeader(headerToString(req.headers.cookie)),
        requestQuery: parseQueryToRecord(target),
        requestBody: null,
        requestBodyText: null,
        requestBodyJson: null,
        timingJson: JSON.stringify(timingEmpty()),
        error: null,
      });

      updateHttpMessageResponse(this.#db(), {
        id: connectionId,
        state: 'captured',
        responseStatus: 101,
        responseHeaders: {},
        responseBody: null,
        responseBodyText: null,
        responseBodyJson: null,
        timingJson: JSON.stringify(timingEmpty()),
        error: null,
      });

      publishHttpSummary(this.#opts.publishEvent, {
        id: connectionId,
        createdAt,
        scheme,
        host,
        port,
        method: 'GET',
        path,
        url,
        state: 'captured',
        responseStatus: 101,
        totalMs: null,
      });
    }

    this.#wss.handleUpgrade(req, socket, head, (clientWs) => {
      const protocolsHeader = headerToString(req.headers['sec-websocket-protocol']);
      const protocols = protocolsHeader
        ? protocolsHeader
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined;

      const upstreamHeaders = stripHopByHop(req.headers);
      delete upstreamHeaders['x-cipherscope-no-intercept'];
      delete upstreamHeaders['sec-websocket-key'];
      delete upstreamHeaders['sec-websocket-version'];
      delete upstreamHeaders['sec-websocket-extensions'];
      delete upstreamHeaders['sec-websocket-protocol'];
      delete upstreamHeaders['host'];

      const upstreamWs = new WebSocket(url, protocols, {
        headers: upstreamHeaders,
        rejectUnauthorized: !this.#opts.upstreamInsecure,
      });

      const rawToBuffer = (data: WebSocket.RawData): Buffer => {
        if (typeof data === 'string') return Buffer.from(data, 'utf8');
        if (Buffer.isBuffer(data)) return data;
        if (data instanceof ArrayBuffer) return Buffer.from(data);
        if (Array.isArray(data)) {
          return Buffer.concat(
            data.map((d) => (Buffer.isBuffer(d) ? d : Buffer.from(d as ArrayBuffer))),
          );
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return Buffer.from(data as any);
      };

      const recordFrame = (
        direction: 'client_to_server' | 'server_to_client',
        data: WebSocket.RawData,
        isBinary: boolean,
      ) => {
        if (!connectionId) return;
        const buf = rawToBuffer(data);
        const text = decodeWsPayloadText(buf, isBinary);
        const json =
          text && looksLikeJson(undefined, text)
            ? (() => {
                try {
                  return JSON.stringify(JSON.parse(text));
                } catch {
                  return null;
                }
              })()
            : null;

        insertWsFrame(this.#db(), {
          id: randomUUID(),
          createdAt: new Date().toISOString(),
          connectionId,
          direction,
          opcode: isBinary ? 2 : 1,
          payload: buf,
          payloadText: text,
          payloadJson: json,
        });
      };

      const closeBoth = () => {
        try {
          clientWs.close();
        } catch {
          // ignore
        }
        try {
          upstreamWs.close();
        } catch {
          // ignore
        }
      };

      type PendingToUpstream =
        | { type: 'message'; data: WebSocket.RawData; isBinary: boolean }
        | { type: 'ping'; data: Buffer }
        | { type: 'pong'; data: Buffer };

      const pendingToUpstream: PendingToUpstream[] = [];

      const flushToUpstream = () => {
        if (upstreamWs.readyState !== WebSocket.OPEN) return;
        for (const item of pendingToUpstream.splice(0)) {
          try {
            if (item.type === 'message') upstreamWs.send(item.data, { binary: item.isBinary });
            else if (item.type === 'ping') upstreamWs.ping(item.data);
            else upstreamWs.pong(item.data);
          } catch (err) {
            this.#opts.log.debug({ err }, 'failed flushing pending upstream wss data');
            closeBoth();
            return;
          }
        }
      };

      upstreamWs.on('open', flushToUpstream);
      flushToUpstream();

      const sendToUpstream = (item: PendingToUpstream) => {
        if (upstreamWs.readyState === WebSocket.OPEN) {
          pendingToUpstream.push(item);
          flushToUpstream();
          return;
        }
        if (upstreamWs.readyState === WebSocket.CONNECTING) {
          pendingToUpstream.push(item);
          return;
        }
        // CLOSED/CLOSING: drop.
      };

      clientWs.on('message', (data, isBinary) => {
        recordFrame('client_to_server', data, Boolean(isBinary));
        sendToUpstream({ type: 'message', data, isBinary: Boolean(isBinary) });
      });

      upstreamWs.on('message', (data, isBinary) => {
        recordFrame('server_to_client', data, Boolean(isBinary));
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(data, { binary: Boolean(isBinary) });
        }
      });

      clientWs.on('ping', (data) => {
        if (!connectionId) {
          sendToUpstream({ type: 'ping', data: Buffer.from(data) });
          return;
        }
        insertWsFrame(this.#db(), {
          id: randomUUID(),
          createdAt: new Date().toISOString(),
          connectionId,
          direction: 'client_to_server',
          opcode: 9,
          payload: Buffer.from(data),
          payloadText: null,
          payloadJson: null,
        });
        sendToUpstream({ type: 'ping', data: Buffer.from(data) });
      });

      upstreamWs.on('ping', (data) => {
        if (!connectionId) {
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.ping(data);
          }
          return;
        }
        insertWsFrame(this.#db(), {
          id: randomUUID(),
          createdAt: new Date().toISOString(),
          connectionId,
          direction: 'server_to_client',
          opcode: 9,
          payload: Buffer.from(data),
          payloadText: null,
          payloadJson: null,
        });
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.ping(data);
        }
      });

      clientWs.on('pong', (data) => {
        if (!connectionId) {
          sendToUpstream({ type: 'pong', data: Buffer.from(data) });
          return;
        }
        insertWsFrame(this.#db(), {
          id: randomUUID(),
          createdAt: new Date().toISOString(),
          connectionId,
          direction: 'client_to_server',
          opcode: 10,
          payload: Buffer.from(data),
          payloadText: null,
          payloadJson: null,
        });
        sendToUpstream({ type: 'pong', data: Buffer.from(data) });
      });

      upstreamWs.on('pong', (data) => {
        if (!connectionId) {
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.pong(data);
          }
          return;
        }
        insertWsFrame(this.#db(), {
          id: randomUUID(),
          createdAt: new Date().toISOString(),
          connectionId,
          direction: 'server_to_client',
          opcode: 10,
          payload: Buffer.from(data),
          payloadText: null,
          payloadJson: null,
        });
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.pong(data);
        }
      });

      clientWs.on('close', closeBoth);
      upstreamWs.on('close', closeBoth);

      upstreamWs.on('error', (err) => {
        this.#opts.log.debug({ err }, 'upstream wss error');
        closeBoth();
      });

      clientWs.on('error', (err) => {
        this.#opts.log.debug({ err }, 'client wss error');
        closeBoth();
      });
    });
  }
}
