import { describe, expect, it } from 'vitest';
import net from 'node:net';
import tls from 'node:tls';
import https from 'node:https';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import forge from 'node-forge';
import { WebSocketServer } from 'ws';
import { buildApp } from '../src/app.js';
import {
  ListMessagesResponseSchema,
  ListWsFramesResponseSchema,
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

function selfSignedCert(host: string): { keyPem: string; certPem: string } {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '02';
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

async function readHttpHeaders(socket: tls.TLSSocket): Promise<string> {
  const buf = await new Promise<Buffer>((resolve, reject) => {
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
  return buf.toString('utf8');
}

function encodeMaskedTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  if (payload.length > 125) throw new Error('test frame too large');
  const maskKey = randomBytes(4);

  const header = Buffer.alloc(2);
  header[0] = 0x81; // FIN + text
  header[1] = 0x80 | payload.length; // masked + length

  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i += 1) {
    masked[i] = payload[i]! ^ maskKey[i % 4]!;
  }

  return Buffer.concat([header, maskKey, masked]);
}

describe('wss capture', () => {
  it('captures wss:// frames through TLS MITM', async () => {
    process.env.AGENT_MITM_ENABLED = '1';
    process.env.AGENT_UPSTREAM_INSECURE = '1';

    const cert = selfSignedCert('localhost');
    const upstream = https.createServer({ key: cert.keyPem, cert: cert.certPem });
    const wss = new WebSocketServer({ server: upstream });
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        ws.send(data);
      });
    });
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

    const tlsSocket = await connectMitmTls({
      proxyHost: '127.0.0.1',
      proxyPort,
      targetHost: 'localhost',
      targetPort: upstreamPort,
      caCertPem: caPem,
    });

    const key = randomBytes(16).toString('base64');
    const handshake =
      `GET /ws HTTP/1.1\r\n` +
      `Host: localhost:${upstreamPort}\r\n` +
      `Upgrade: websocket\r\n` +
      `Connection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${key}\r\n` +
      `Sec-WebSocket-Version: 13\r\n` +
      `\r\n`;

    tlsSocket.write(handshake);
    const headers = await readHttpHeaders(tlsSocket);
    expect(headers.startsWith('HTTP/1.1 101')).toBe(true);

    tlsSocket.write(encodeMaskedTextFrame('hello'));

    // Wait for an echo frame (we don't parse it; just ensure traffic flowed).
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Timed out waiting for ws traffic')), 1000);
      tlsSocket.once('data', () => {
        clearTimeout(t);
        resolve();
      });
    });

    tlsSocket.end();

    let connId: string | null = null;
    for (let i = 0; i < 40; i += 1) {
      const list = ListMessagesResponseSchema.parse(
        (await app.inject({ method: 'GET', url: '/messages?limit=200&offset=0' })).json(),
      );
      const found = list.items.find((m) => m.scheme === 'wss' && m.path === '/ws');
      if (found) {
        connId = found.id;
        break;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    if (!connId) throw new Error('Expected wss connection not found in capture DB.');

    const frames = ListWsFramesResponseSchema.parse(
      (await app.inject({ method: 'GET', url: `/ws/${connId}/frames?limit=50&offset=0` })).json(),
    );

    expect(frames.items.some((f) => f.direction === 'client_to_server' && f.payloadText === 'hello')).toBe(
      true,
    );
    expect(
      frames.items.some((f) => f.direction === 'server_to_client' && f.payloadText === 'hello'),
    ).toBe(true);

    await close();
    wss.close();
    upstream.close();
  });
});
