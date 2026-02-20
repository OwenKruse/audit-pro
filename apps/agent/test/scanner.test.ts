import { describe, expect, it } from 'vitest';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { buildApp } from '../src/app.js';
import {
  ListScannerFindingsResponseSchema,
  ProxyStatusSchema,
  ScannerRunResponseSchema,
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

describe('scanner', () => {
  it('runs passive checks and persists findings', async () => {
    const upstream = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      await new Promise<void>((r) => req.on('end', () => r()));

      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, path: req.url, received: Buffer.concat(chunks).toString('utf8') }));
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
    const proxyPort = proxyStatus.proxy.port;
    const hostHeader = `127.0.0.1:${upstreamPort}`;

    const siweMessage =
      'app.example wants you to sign in with your Ethereum account:\n' +
      '0x000000000000000000000000000000000000dead\n\n' +
      'URI: https://app.example/login\n' +
      'Version: 1\n' +
      'Chain ID: 1\n' +
      'Issued At: 2026-01-01T00:00:00.000Z';

    const siweCapture = await requestViaProxy({
      proxyPort,
      targetUrl: `http://127.0.0.1:${upstreamPort}/rpc`,
      method: 'POST',
      headers: {
        host: hostHeader,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'personal_sign',
        params: [siweMessage, '0x000000000000000000000000000000000000dead'],
        id: 1,
      }),
    });
    expect(siweCapture.statusCode).toBe(200);

    const spender = '000000000000000000000000000000000000dead';
    const approveData = `0x095ea7b3${'0'.repeat(24)}${spender}${'f'.repeat(64)}`;
    const approveCapture = await requestViaProxy({
      proxyPort,
      targetUrl: `http://127.0.0.1:${upstreamPort}/rpc`,
      method: 'POST',
      headers: {
        host: hostHeader,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'eth_sendTransaction',
        params: [
          {
            to: '0x0000000000000000000000000000000000000001',
            data: approveData,
          },
        ],
        id: 2,
      }),
    });
    expect(approveCapture.statusCode).toBe(200);

    const run = ScannerRunResponseSchema.parse(
      (
        await app.inject({
          method: 'POST',
          url: '/scanner/run',
          payload: { includeActive: false, limit: 50 },
        })
      ).json(),
    );
    expect(run.ok).toBe(true);
    expect(run.summary.scannedMessages).toBeGreaterThanOrEqual(2);
    expect(run.findings.some((f) => f.checkId === 'passive.siwe.correctness')).toBe(true);
    expect(run.findings.some((f) => f.checkId === 'passive.approval.unlimited_erc20')).toBe(true);

    const persisted = ListScannerFindingsResponseSchema.parse(
      (await app.inject({ method: 'GET', url: '/scanner/findings?limit=50&offset=0' })).json(),
    );
    expect(persisted.ok).toBe(true);
    expect(persisted.items.length).toBeGreaterThan(0);

    await close();
    upstream.close();
  });
});
