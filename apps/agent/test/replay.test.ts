import { describe, expect, it } from 'vitest';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { gzipSync } from 'node:zlib';
import { buildApp } from '../src/app.js';
import {
  GetMessageResponseSchema,
  ListMessagesResponseSchema,
  ProxyStatusSchema,
  ReplayResponseSchema,
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

describe('replay', () => {
  it('replays a captured request with edits and persists a variant + diff', async () => {
    const upstream = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      await new Promise<void>((r) => req.on('end', () => r()));
      const raw = Buffer.concat(chunks).toString('utf8');
      let parsed: unknown = null;
      try {
        parsed = raw ? JSON.parse(raw) : null;
      } catch {
        parsed = null;
      }
      const payload = JSON.stringify({ ok: true, path: req.url, method: req.method, received: parsed });
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

    const targetUrl = `http://127.0.0.1:${upstreamPort}/replay-me?x=1`;
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
    const baseline = list.items.find((m) => m.path === '/replay-me?x=1');
    expect(baseline).toBeTruthy();

    const replay = ReplayResponseSchema.parse(
      (
        await app.inject({
          method: 'POST',
          url: '/replay',
          payload: {
            messageId: baseline!.id,
            overrides: {
              bodyText: JSON.stringify({ a: 2 }),
            },
          },
        })
      ).json(),
    );

    expect(replay.ok).toBe(true);
    expect(replay.baseline.id).toBe(baseline!.id);
    expect(replay.variant.parentId).toBe(baseline!.id);
    expect(replay.diff.baselineId).toBe(baseline!.id);
    expect(replay.diff.variantId).toBe(replay.variant.id);
    expect(replay.diff.body.kind).toBe('json');
    expect(replay.diff.body.jsonChanges.some((c) => c.path === '/received/a')).toBe(true);

    const variantDetail = GetMessageResponseSchema.parse(
      (await app.inject({ method: 'GET', url: `/messages/${replay.variant.id}` })).json(),
    );
    expect(variantDetail.ok).toBe(true);
    expect(variantDetail.item.parentId).toBe(baseline!.id);
    expect(variantDetail.item.replayDiff?.variantId).toBe(replay.variant.id);

    await close();
    upstream.close();
  });

  it('records DNS failures on replay variants instead of silent empty responses', async () => {
    const upstream = http.createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
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

    const seedUrl = `http://127.0.0.1:${upstreamPort}/seed-replay`;
    const seedResp = await requestViaProxy({
      proxyPort,
      targetUrl: seedUrl,
      method: 'GET',
      headers: {
        host: `127.0.0.1:${upstreamPort}`,
      },
    });
    expect(seedResp.statusCode).toBe(200);

    const list = ListMessagesResponseSchema.parse(
      (await app.inject({ method: 'GET', url: '/messages?limit=50&offset=0' })).json(),
    );
    const baseline = list.items.find((m) => m.path === '/seed-replay');
    expect(baseline).toBeTruthy();

    const replay = ReplayResponseSchema.parse(
      (
        await app.inject({
          method: 'POST',
          url: '/replay',
          payload: {
            messageId: baseline!.id,
            overrides: {
              url: 'http://does-not-resolve.invalid/replay',
            },
          },
        })
      ).json(),
    );

    expect(replay.ok).toBe(true);
    expect(replay.variant.responseStatus).toBeNull();
    expect(Object.keys(replay.variant.response.headers)).toHaveLength(0);
    expect(replay.variant.error).toBeTruthy();
    expect(replay.variant.error?.toLowerCase()).toContain('enotfound');
    expect(replay.variant.error?.toLowerCase()).toContain('dns lookup failed');

    await close();
    upstream.close();
  });
});
