import { describe, expect, it } from 'vitest';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { gzipSync } from 'node:zlib';
import { buildApp } from '../src/app.js';
import {
  GetMessageResponseSchema,
  ListInterceptQueueResponseSchema,
  ListMessagesResponseSchema,
  ProxyStatusSchema,
} from '@cipherscope/proto';

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') return reject(new Error('Bad address'));
      resolve(addr.port);
    });
  });
}

function requestViaProxy(opts: {
  proxyPort: number;
  targetUrl: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: opts.proxyPort,
        method: opts.method ?? 'GET',
        path: opts.targetUrl, // absolute-form for proxy requests
        headers: opts.headers,
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
    if (opts.body != null) req.end(opts.body);
    else req.end();
  });
}

describe('proxy capture', () => {
  it('captures an HTTP request/response through the proxy', async () => {
    const upstream = http.createServer((req, res) => {
      const payload = JSON.stringify({ ok: true, method: req.method, url: req.url });
      res.setHeader('content-type', 'application/json');
      res.setHeader('content-encoding', 'gzip');
      res.end(gzipSync(Buffer.from(payload, 'utf8')));
    });
    const upstreamPort = await listen(upstream);

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

    const targetUrl = `http://127.0.0.1:${upstreamPort}/hello?x=1`;
    const resp = await requestViaProxy({
      proxyPort,
      targetUrl,
      method: 'POST',
      headers: {
        host: `127.0.0.1:${upstreamPort}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ a: 1 }),
    });

    expect(resp.statusCode).toBe(200);

    const list = ListMessagesResponseSchema.parse(
      (await app.inject({ method: 'GET', url: '/messages?limit=10&offset=0' })).json(),
    );
    expect(list.ok).toBe(true);
    expect(list.items.length).toBeGreaterThan(0);

    const found = list.items.find((m) => m.path === '/hello?x=1');
    if (!found) throw new Error('Expected captured message not found.');
    expect(found.method).toBe('POST');
    expect(found.responseStatus).toBe(200);

    const detail = GetMessageResponseSchema.parse(
      (await app.inject({ method: 'GET', url: `/messages/${found.id}` })).json(),
    );
    expect(detail.ok).toBe(true);
    expect(detail.item.request.bodyText).toContain('"a":1');
    expect(detail.item.response.bodyText).toContain('"ok":true');

    await close();
    upstream.close();
  });

  it('queues requests when intercept is enabled and forwards on command', async () => {
    const upstream = http.createServer((_req, res) => res.end('ok'));
    const upstreamPort = await listen(upstream);

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

    await app.inject({
      method: 'POST',
      url: '/proxy/intercept',
      payload: { enabled: true },
    });

    const targetUrl = `http://127.0.0.1:${upstreamPort}/intercepted`;
    const respPromise = requestViaProxy({
      proxyPort,
      targetUrl,
      method: 'GET',
      headers: { host: `127.0.0.1:${upstreamPort}` },
    });

    let queue = ListInterceptQueueResponseSchema.parse(
      (await app.inject({ method: 'GET', url: '/proxy/queue' })).json(),
    );
    for (let i = 0; i < 20; i += 1) {
      // Wait briefly for the proxy to enqueue the request.
      // This also tolerates slower CI environments.
      await new Promise((r) => setTimeout(r, 25));
      queue = ListInterceptQueueResponseSchema.parse(
        (await app.inject({ method: 'GET', url: '/proxy/queue' })).json(),
      );
      if (queue?.items?.length) break;
    }

    expect(queue.ok).toBe(true);
    expect(queue.items.length).toBe(1);

    const first = queue.items[0];
    if (!first) throw new Error('Expected a queued intercept entry.');
    const id = first.id;
    const forward = (
      await app.inject({ method: 'POST', url: `/proxy/queue/${id}/forward` })
    ).json();
    expect(forward.ok).toBe(true);

    const resp = await respPromise;
    expect(resp.statusCode).toBe(200);
    expect(resp.body).toBe('ok');

    await close();
    upstream.close();
  });
});
