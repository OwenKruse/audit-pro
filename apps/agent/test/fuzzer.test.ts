import { describe, expect, it } from 'vitest';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { buildApp } from '../src/app.js';
import {
  FuzzCampaignResponseSchema,
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
        path: opts.targetUrl,
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

describe('fuzzer campaign', () => {
  it('runs a campaign, clusters outcomes, and tolerates unavailable Anvil snapshot hooks', async () => {
    const upstream = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      await new Promise<void>((r) => req.on('end', () => r()));

      const raw = Buffer.concat(chunks).toString('utf8');
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        parsed = {};
      }

      const amount = typeof parsed.amount === 'number' ? parsed.amount : null;
      let status = 200;
      if (amount === 0) status = 429;
      else if (amount != null && amount < 0) status = 422;
      else if (amount === Number.MAX_SAFE_INTEGER) status = 500;

      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          ok: status < 400,
          code: status,
          amount,
          amountType: typeof parsed.amount,
        }),
      );
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

    const targetUrl = `http://127.0.0.1:${upstreamPort}/fuzz-number`;
    const capture = await requestViaProxy({
      proxyPort,
      targetUrl,
      method: 'POST',
      headers: {
        host: `127.0.0.1:${upstreamPort}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ amount: 7, note: 'baseline' }),
    });
    expect(capture.statusCode).toBe(200);

    const list = ListMessagesResponseSchema.parse(
      (await app.inject({ method: 'GET', url: '/messages?limit=20&offset=0' })).json(),
    );
    const baseline = list.items.find((m) => m.path === '/fuzz-number');
    if (!baseline) throw new Error('Expected baseline capture not found.');

    const fuzz = FuzzCampaignResponseSchema.parse(
      (
        await app.inject({
          method: 'POST',
          url: '/fuzzer/campaign',
          payload: {
            messageId: baseline.id,
            fieldPath: '/amount',
            maxCases: 10,
            concurrency: 3,
          },
        })
      ).json(),
    );

    expect(fuzz.ok).toBe(true);
    expect(fuzz.campaign.baselineId).toBe(baseline.id);
    expect(fuzz.campaign.totalCases).toBeGreaterThan(0);
    expect(fuzz.campaign.totalCases).toBeLessThanOrEqual(10);
    expect(fuzz.clusters.length).toBeGreaterThan(0);
    expect(fuzz.cases.some((c) => c.status === 429 || c.status === 422 || c.status === 500)).toBe(true);
    expect(fuzz.anomalies.length).toBeGreaterThan(0);
    expect(fuzz.campaign.snapshot.attempted).toBe(true);
    expect(fuzz.campaign.snapshot.snapshotId).toBeNull();
    expect(fuzz.campaign.warnings.length).toBeGreaterThan(0);

    await close();
    upstream.close();
  });

  it('adds JSON-RPC-aware mutation strategies', async () => {
    const upstream = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      await new Promise<void>((r) => req.on('end', () => r()));

      const raw = Buffer.concat(chunks).toString('utf8');
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        parsed = {};
      }

      const method = typeof parsed.method === 'string' ? parsed.method : '';
      res.statusCode = method === 'invalid_method' ? 400 : 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: res.statusCode === 200, method }));
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

    const targetUrl = `http://127.0.0.1:${upstreamPort}/fuzz-jsonrpc`;
    const capture = await requestViaProxy({
      proxyPort,
      targetUrl,
      method: 'POST',
      headers: {
        host: `127.0.0.1:${upstreamPort}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'eth_call',
        params: [{ to: '0x0000000000000000000000000000000000000001', data: '0x1234' }, 'latest'],
        id: 1,
      }),
    });
    expect(capture.statusCode).toBe(200);

    const list = ListMessagesResponseSchema.parse(
      (await app.inject({ method: 'GET', url: '/messages?limit=20&offset=0' })).json(),
    );
    const baseline = list.items.find((m) => m.path === '/fuzz-jsonrpc');
    if (!baseline) throw new Error('Expected JSON-RPC baseline capture not found.');

    const fuzz = FuzzCampaignResponseSchema.parse(
      (
        await app.inject({
          method: 'POST',
          url: '/fuzzer/campaign',
          payload: {
            messageId: baseline.id,
            fieldPath: '/method',
            maxCases: 12,
            anvilSnapshot: false,
          },
        })
      ).json(),
    );

    expect(fuzz.ok).toBe(true);
    expect(fuzz.cases.length).toBeGreaterThan(0);
    expect(fuzz.cases.some((c) => c.mutationKind === 'jsonrpc_method')).toBe(true);

    await close();
    upstream.close();
  });
});
