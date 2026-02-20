import { describe, expect, it } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import https from 'node:https';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import forge from 'node-forge';
import { buildApp } from '../src/app.js';
import {
  GetMessageResponseSchema,
  ListMessagesResponseSchema,
  ProxyStatusSchema,
} from '@cipherscope/proto';

function listenHttps(server: https.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') return reject(new Error('Bad address'));
      resolve(addr.port);
    });
  });
}

function listenHttp(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') return reject(new Error('Bad address'));
      resolve(addr.port);
    });
  });
}

function listenNet(server: net.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') return reject(new Error('Bad address'));
      resolve(addr.port);
    });
  });
}

function selfSignedCert(host: string): { keyPem: string; certPem: string } {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 24 * 60 * 60 * 1000);
  cert.validity.notAfter = new Date(Date.now() + 24 * 60 * 60 * 1000);

  const attrs = [{ name: 'commonName', value: host }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames: [{ type: 2, value: host }] },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  return {
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
    certPem: forge.pki.certificateToPem(cert),
  };
}

async function connectMitmTls(opts: {
  proxyHost: string;
  proxyPort: number;
  targetHost: string;
  targetPort: number;
  caCertPem: string;
}): Promise<tls.TLSSocket> {
  const socket = await openConnectTunnel({
    proxyHost: opts.proxyHost,
    proxyPort: opts.proxyPort,
    targetHost: opts.targetHost,
    targetPort: opts.targetPort,
  });

  const tlsSocket = tls.connect({
    socket,
    servername: opts.targetHost,
    ca: opts.caCertPem,
    rejectUnauthorized: true,
  });

  await new Promise<void>((resolve, reject) => {
    tlsSocket.once('secureConnect', () => resolve());
    tlsSocket.once('error', reject);
  });

  return tlsSocket;
}

async function openConnectTunnel(opts: {
  proxyHost: string;
  proxyPort: number;
  targetHost: string;
  targetPort: number;
}): Promise<net.Socket> {
  const socket = net.connect(opts.proxyPort, opts.proxyHost);

  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.once('connect', () => resolve());
  });

  const connectReq =
    `CONNECT ${opts.targetHost}:${opts.targetPort} HTTP/1.1\r\n` +
    `Host: ${opts.targetHost}:${opts.targetPort}\r\n` +
    `Connection: keep-alive\r\n` +
    `\r\n`;

  socket.write(connectReq);

  const headerBuf = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const onData = (c: Buffer) => {
      chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
      const joined = Buffer.concat(chunks);
      const idx = joined.indexOf('\r\n\r\n');
      if (idx === -1) return;
      socket.off('data', onData);
      socket.off('error', onErr);
      const extra = joined.subarray(idx + 4);
      if (extra.length) socket.unshift(extra);
      resolve(joined.subarray(0, idx + 4));
    };
    const onErr = (err: Error) => {
      socket.off('data', onData);
      reject(err);
    };
    socket.on('data', onData);
    socket.on('error', onErr);
  });

  const headerText = headerBuf.toString('utf8');
  expect(headerText.startsWith('HTTP/1.1 200')).toBe(true);

  return socket;
}

async function sendRawHttpOverTls(opts: {
  tlsSocket: tls.TLSSocket;
  hostHeader: string;
  method: string;
  path: string;
  body?: string;
}): Promise<{ statusLine: string; body: string }> {
  const body = opts.body ?? '';
  const req =
    `${opts.method} ${opts.path} HTTP/1.1\r\n` +
    `Host: ${opts.hostHeader}\r\n` +
    `Content-Type: application/json\r\n` +
    `Content-Length: ${Buffer.byteLength(body)}\r\n` +
    `Connection: close\r\n` +
    `\r\n` +
    body;

  opts.tlsSocket.write(req);

  const raw = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    opts.tlsSocket.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    opts.tlsSocket.once('error', reject);
    const done = () => resolve(Buffer.concat(chunks));
    opts.tlsSocket.once('end', done);
    opts.tlsSocket.once('close', done);
  });

  const text = raw.toString('utf8');
  const [head, rest] = text.split('\r\n\r\n');
  const statusLine = (head ?? '').split('\r\n')[0] ?? '';
  return { statusLine, body: rest ?? '' };
}

describe('tls mitm', () => {
  it('decrypts/captures https requests through CONNECT mitm', async () => {
    process.env.AGENT_MITM_ENABLED = '1';
    // Keep strict TLS on first attempt; proxy should retry cert-validation failures once.
    process.env.AGENT_UPSTREAM_INSECURE = '0';

    const cert = selfSignedCert('localhost');
    const upstream = https.createServer(
      { key: cert.keyPem, cert: cert.certPem },
      async (req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        await new Promise<void>((r) => req.on('end', () => r()));
        const raw = Buffer.concat(chunks).toString('utf8');
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            ok: true,
            method: req.method,
            url: req.url,
            received: raw ? JSON.parse(raw) : null,
          }),
        );
      },
    );
    const upstreamPort = await listenHttps(upstream);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cipherscope-agent-'));
    const dbPath = path.join(tmpDir, 'agent.db');
    const { app, close } = await buildApp({
      dbPath,
      agentName: 'cipherscope-agent',
      agentVersion: '0.0.0-test',
      proxyHost: '127.0.0.1',
      proxyPort: 0,
    });

    const proxyStatus = ProxyStatusSchema.parse(
      (await app.inject({ method: 'GET', url: '/proxy/status' })).json(),
    );
    const proxyPort = proxyStatus.proxy.port as number;

    const caPem = (await app.inject({ method: 'GET', url: '/tls/ca.pem' })).body as string;
    expect(caPem).toContain('BEGIN CERTIFICATE');

    const tlsSocket = await connectMitmTls({
      proxyHost: '127.0.0.1',
      proxyPort,
      targetHost: 'localhost',
      targetPort: upstreamPort,
      caCertPem: caPem,
    });

    const resp = await sendRawHttpOverTls({
      tlsSocket,
      hostHeader: `localhost:${upstreamPort}`,
      method: 'POST',
      path: '/hello?x=1',
      body: JSON.stringify({ a: 1 }),
    });

    expect(resp.statusLine.startsWith('HTTP/1.1 200')).toBe(true);
    expect(resp.body).toContain('"ok":true');

    let foundId: string | null = null;
    for (let i = 0; i < 40; i += 1) {
      const list = ListMessagesResponseSchema.parse(
        (await app.inject({ method: 'GET', url: '/messages?limit=50&offset=0' })).json(),
      );
      const found = list.items.find((m) => m.scheme === 'https' && m.path === '/hello?x=1');
      if (found) {
        foundId = found.id;
        break;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    if (!foundId) throw new Error('Expected https message not found in capture DB.');

    const detail = GetMessageResponseSchema.parse(
      (await app.inject({ method: 'GET', url: `/messages/${foundId}` })).json(),
    );
    expect(detail.item.request.bodyText).toContain('"a":1');
    expect(detail.item.response.bodyText).toContain('"ok":true');

    await close();
    upstream.close();
  });

  it('falls back to plain http when upstream https transport fails', async () => {
    process.env.AGENT_MITM_ENABLED = '1';
    process.env.AGENT_UPSTREAM_INSECURE = '0';

    const upstream = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, scheme: 'http', path: req.url }));
    });
    const upstreamPort = await listenHttp(upstream);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cipherscope-agent-'));
    const dbPath = path.join(tmpDir, 'agent.db');
    const { app, close } = await buildApp({
      dbPath,
      agentName: 'cipherscope-agent',
      agentVersion: '0.0.0-test',
      proxyHost: '127.0.0.1',
      proxyPort: 0,
    });

    const proxyStatus = ProxyStatusSchema.parse(
      (await app.inject({ method: 'GET', url: '/proxy/status' })).json(),
    );
    const proxyPort = proxyStatus.proxy.port as number;

    const caPem = (await app.inject({ method: 'GET', url: '/tls/ca.pem' })).body as string;

    const tlsSocket = await connectMitmTls({
      proxyHost: '127.0.0.1',
      proxyPort,
      targetHost: 'localhost',
      targetPort: upstreamPort,
      caCertPem: caPem,
    });

    const resp = await sendRawHttpOverTls({
      tlsSocket,
      hostHeader: `localhost:${upstreamPort}`,
      method: 'GET',
      path: '/http-only',
    });

    expect(resp.statusLine.startsWith('HTTP/1.1 200')).toBe(true);
    expect(resp.body).toContain('"scheme":"http"');
    expect(resp.body).toContain('"path":"/http-only"');

    await close();
    upstream.close();
  });

  it('bypasses MITM after repeated TLS negotiation failures for a host', async () => {
    process.env.AGENT_MITM_ENABLED = '1';
    process.env.AGENT_UPSTREAM_INSECURE = '0';

    const upstream = net.createServer((sock) => {
      sock.on('data', (chunk) => {
        sock.write(chunk);
      });
    });
    const upstreamPort = await listenNet(upstream);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cipherscope-agent-'));
    const dbPath = path.join(tmpDir, 'agent.db');
    const { app, close } = await buildApp({
      dbPath,
      agentName: 'cipherscope-agent',
      agentVersion: '0.0.0-test',
      proxyHost: '127.0.0.1',
      proxyPort: 0,
    });

    const proxyStatus = ProxyStatusSchema.parse(
      (await app.inject({ method: 'GET', url: '/proxy/status' })).json(),
    );
    const proxyPort = proxyStatus.proxy.port as number;

    const first = await openConnectTunnel({
      proxyHost: '127.0.0.1',
      proxyPort,
      targetHost: 'localhost',
      targetPort: upstreamPort,
    });
    first.write('plain-text-not-tls');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => resolve(), 400);
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      first.once('data', done);
      first.once('close', done);
      first.once('error', done);
    });
    first.destroy();

    const second = await openConnectTunnel({
      proxyHost: '127.0.0.1',
      proxyPort,
      targetHost: 'localhost',
      targetPort: upstreamPort,
    });
    const echo = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for tunneled echo')), 2000);
      second.once('data', (chunk) => {
        clearTimeout(timer);
        resolve(Buffer.from(chunk).toString('utf8'));
      });
      second.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      second.write('plain-text-through-bypass');
    });
    expect(echo).toContain('plain-text-through-bypass');
    second.destroy();

    const list = ListMessagesResponseSchema.parse(
      (await app.inject({ method: 'GET', url: '/messages?limit=50&offset=0' })).json(),
    );
    const connectRows = list.items.filter(
      (m) => m.scheme === 'connect' && m.host === 'localhost' && m.port === upstreamPort,
    );
    expect(connectRows.length).toBeGreaterThanOrEqual(2);
    expect(connectRows.some((m) => m.state === 'error')).toBe(true);
    expect(connectRows.some((m) => m.state === 'tunnel' && m.responseStatus === 200)).toBe(true);

    await close();
    upstream.close();
  });
});
