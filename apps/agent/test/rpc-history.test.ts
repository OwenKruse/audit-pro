import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../src/app.js';

describe('rpc interactions history', () => {
  it('records and lists rpc interactions', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cipherscope-agent-rpc-'));
    const dbPath = path.join(tmpDir, 'agent.db');

    const { app, close } = await buildApp({
      dbPath,
      agentName: 'cipherscope-agent',
      agentVersion: '0.0.0-test',
      proxyHost: '127.0.0.1',
      proxyPort: 0,
    });

    const created = await app.inject({
      method: 'POST',
      url: '/rpc/interactions',
      payload: {
        source: 'foundry',
        rpcUrl: 'http://127.0.0.1:8545',
        chainId: 31337,
        method: 'eth_call',
        params: [{ to: '0x0000000000000000000000000000000000000000', data: '0x' }, 'latest'],
        status: 'success',
        error: null,
        durationMs: 12.34,
        tx: { from: null, to: null, value: null, data: null, gas: null },
        txHash: null,
        result: { ok: true },
      },
    });
    expect(created.statusCode).toBe(200);
    const createdJson = created.json();
    expect(createdJson.ok).toBe(true);
    expect(createdJson.item.source).toBe('foundry');
    expect(typeof createdJson.item.id).toBe('string');

    const listed = await app.inject({ method: 'GET', url: '/rpc/interactions?limit=10&offset=0' });
    expect(listed.statusCode).toBe(200);
    const listJson = listed.json();
    expect(listJson.ok).toBe(true);
    expect(Array.isArray(listJson.items)).toBe(true);
    expect(listJson.items.length).toBeGreaterThanOrEqual(1);

    const got = await app.inject({ method: 'GET', url: `/rpc/interactions/${encodeURIComponent(createdJson.item.id)}` });
    expect(got.statusCode).toBe(200);
    const gotJson = got.json();
    expect(gotJson.ok).toBe(true);
    expect(gotJson.item.id).toBe(createdJson.item.id);

    await close();
  });

  it('lists ws connections (may be empty)', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cipherscope-agent-ws-'));
    const dbPath = path.join(tmpDir, 'agent.db');

    const { app, close } = await buildApp({
      dbPath,
      agentName: 'cipherscope-agent',
      agentVersion: '0.0.0-test',
      proxyHost: '127.0.0.1',
      proxyPort: 0,
    });

    const res = await app.inject({ method: 'GET', url: '/ws/connections?limit=10&offset=0' });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.ok).toBe(true);
    expect(Array.isArray(json.items)).toBe(true);

    await close();
  });
});

