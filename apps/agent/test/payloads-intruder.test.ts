import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';

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

describe('payload catalog + intruder endpoints', () => {
  it('returns payload catalog search results', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cipherscope-agent-payloads-'));
    const dbPath = path.join(tmpDir, 'agent.db');
    const { app, close } = await buildApp({
      dbPath,
      agentName: 'cipherscope-agent',
      agentVersion: '0.0.0-test',
      proxyHost: '127.0.0.1',
      proxyPort: 0,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/payloads?q=xss&sourceType=intruder&limit=10&offset=0',
    });

    expect(res.statusCode).toBe(200);
    const json = res.json() as {
      ok: boolean;
      total: number;
      count: number;
      items: Array<{ id: string; value: string; sourceType: string }>;
    };
    expect(json.ok).toBe(true);
    expect(json.count).toBeGreaterThan(0);
    expect(json.count).toBeLessThanOrEqual(10);
    expect(json.total).toBeGreaterThan(0);
    expect(Array.isArray(json.items)).toBe(true);
    expect(json.items[0]?.sourceType).toBe('intruder');

    await close();
  });

  it('executes intruder attack with sniper payload set', async () => {
    const upstream = http.createServer((req, res) => {
      const target = new URL(req.url ?? '/', 'http://127.0.0.1');
      const value = target.searchParams.get('u') ?? 'none';
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, value }));
    });
    const upstreamPort = await listen(upstream);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cipherscope-agent-intruder-'));
    const dbPath = path.join(tmpDir, 'agent.db');
    const { app, close } = await buildApp({
      dbPath,
      agentName: 'cipherscope-agent',
      agentVersion: '0.0.0-test',
      proxyHost: '127.0.0.1',
      proxyPort: 0,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/intruder/attack',
      payload: {
        method: 'GET',
        url: `http://127.0.0.1:${upstreamPort}/echo?u=§seed§`,
        attackType: 'sniper',
        payloadSets: [['alpha', 'beta', 'gamma']],
        maxRequests: 20,
        concurrency: 2,
      },
    });

    expect(res.statusCode).toBe(200);
    const json = res.json() as {
      ok: boolean;
      positions: Array<{ index: number; defaultValue: string }>;
      requestCount: number;
      results: Array<{ status: number | null; payloads: string[] }>;
    };
    expect(json.ok).toBe(true);
    expect(json.positions.length).toBe(1);
    expect(json.requestCount).toBe(3);
    expect(json.results.length).toBe(3);
    expect(json.results.every((item) => item.status === 200)).toBe(true);
    expect(json.results[0]?.payloads.length).toBe(1);

    await close();
    upstream.close();
  });
});
