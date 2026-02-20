import { describe, expect, it } from 'vitest';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { buildApp } from '../src/app.js';
import { ListMessagesResponseSchema, ProxyStatusSchema } from '@cipherscope/proto';

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

describe('case files', () => {
  it('exports a zip and can import it into a fresh DB', async () => {
    const upstream = http.createServer((_req, res) => res.end('hello'));
    const upstreamPort = await listen(upstream);

    const tmpDir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'cipherscope-agent-case-'));
    const dbPath1 = path.join(tmpDir1, 'agent.db');
    const { app: app1, close: close1 } = await buildApp({
      dbPath: dbPath1,
      agentName: 'cipherscope-agent',
      agentVersion: '0.0.0-test',
      proxyHost: '127.0.0.1',
      proxyPort: 0,
    });

    const proxyStatus = ProxyStatusSchema.parse(
      (await app1.inject({ method: 'GET', url: '/proxy/status' })).json(),
    );
    const proxyPort = proxyStatus.proxy.port as number;

    const targetUrl = `http://127.0.0.1:${upstreamPort}/hello`;
    const resp = await requestViaProxy({
      proxyPort,
      targetUrl,
      method: 'GET',
      headers: { host: `127.0.0.1:${upstreamPort}` },
    });
    expect(resp.statusCode).toBe(200);

    const list1 = ListMessagesResponseSchema.parse(
      (await app1.inject({ method: 'GET', url: '/messages?limit=50&offset=0' })).json(),
    );
    expect(list1.items.some((m) => m.path === '/hello')).toBe(true);

    const exported = await app1.inject({ method: 'GET', url: '/case/export' });
    expect(exported.statusCode).toBe(200);
    expect(exported.headers['content-type']).toContain('application/zip');
    const zipBytes = exported.rawPayload;
    expect(Buffer.isBuffer(zipBytes)).toBe(true);
    expect(zipBytes.length).toBeGreaterThan(100);

    await close1();

    const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cipherscope-agent-case-'));
    const dbPath2 = path.join(tmpDir2, 'agent.db');
    const { app: app2, close: close2 } = await buildApp({
      dbPath: dbPath2,
      agentName: 'cipherscope-agent',
      agentVersion: '0.0.0-test',
      proxyHost: '127.0.0.1',
      proxyPort: 0,
    });

    const imported = await app2.inject({
      method: 'POST',
      url: '/case/import',
      headers: { 'content-type': 'application/zip' },
      payload: zipBytes,
    });
    if (imported.statusCode !== 200) {
      throw new Error(`Case import failed (${imported.statusCode}): ${imported.body}`);
    }
    const importedJson = imported.json() as { ok?: unknown };
    expect(importedJson.ok).toBe(true);

    const list2 = ListMessagesResponseSchema.parse(
      (await app2.inject({ method: 'GET', url: '/messages?limit=50&offset=0' })).json(),
    );
    expect(list2.items.some((m) => m.path === '/hello')).toBe(true);

    await close2();
    upstream.close();
  });
});
