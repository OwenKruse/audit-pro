import { describe, expect, it } from 'vitest';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { buildApp } from '../src/app.js';

type CapturedRpcCall = {
  method: string;
  params: unknown[];
};

const FOUNDRY_ENV_KEYS = [
  'AGENT_FOUNDRY_ENABLED',
  'AGENT_FOUNDRY_AUTOSTART',
  'AGENT_FOUNDRY_RPC_HOST',
  'AGENT_FOUNDRY_RPC_PORT',
] as const;

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

function snapshotEnv(): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const key of FOUNDRY_ENV_KEYS) out[key] = process.env[key];
  return out;
}

function restoreEnv(snapshot: Record<string, string | undefined>) {
  for (const key of FOUNDRY_ENV_KEYS) {
    const value = snapshot[key];
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
}

function createMockFoundryRpc(calls: CapturedRpcCall[]): http.Server {
  return http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    await new Promise<void>((resolve) => req.on('end', () => resolve()));
    const raw = Buffer.concat(chunks).toString('utf8');

    let parsed: { id?: unknown; method?: unknown; params?: unknown } = {};
    try {
      parsed = JSON.parse(raw) as { id?: unknown; method?: unknown; params?: unknown };
    } catch {
      parsed = {};
    }

    const method = typeof parsed.method === 'string' ? parsed.method : '';
    const params = Array.isArray(parsed.params) ? parsed.params : [];
    if (method && method !== 'web3_clientVersion') {
      calls.push({ method, params });
    }

    let result: unknown = true;
    if (method === 'web3_clientVersion') result = 'mock-anvil/1.0.0';
    if (method === 'eth_getBalance') result = '0x1234';
    if (method === 'eth_getCode') result = '0x';

    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: parsed.id ?? 1,
        result,
      }),
    );
  });
}

describe('evm rpc block-tag normalization', () => {
  it('rewrites genesis-style balance block tags to latest on /evm/jsonrpc', async () => {
    const calls: CapturedRpcCall[] = [];
    const rpc = createMockFoundryRpc(calls);
    const rpcPort = await listen(rpc);
    const envSnapshot = snapshotEnv();

    process.env.AGENT_FOUNDRY_ENABLED = '1';
    process.env.AGENT_FOUNDRY_AUTOSTART = '0';
    process.env.AGENT_FOUNDRY_RPC_HOST = '127.0.0.1';
    process.env.AGENT_FOUNDRY_RPC_PORT = String(rpcPort);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cipherscope-agent-'));
    const dbPath = path.join(tmpDir, 'agent.db');
    const { app, close } = await buildApp({
      dbPath,
      agentName: 'cipherscope-agent',
      agentVersion: '0.0.0-test',
      proxyHost: '127.0.0.1',
      proxyPort: 0,
    });

    try {
      const address = '0x000000000000000000000000000000000000dead';
      const tags: unknown[] = ['0x0', '0x00', '0x000000', 'earliest', 0, '0'];
      for (const tag of tags) {
        const res = await app.inject({
          method: 'POST',
          url: '/evm/jsonrpc',
          payload: {
            jsonrpc: '2.0',
            id: `tag-${String(tag)}`,
            method: 'eth_getBalance',
            params: [address, tag],
          },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({ jsonrpc: '2.0', result: '0x1234' });
      }

      const keepTagRes = await app.inject({
        method: 'POST',
        url: '/evm/jsonrpc',
        payload: {
          jsonrpc: '2.0',
          id: 'non-genesis',
          method: 'eth_getBalance',
          params: [address, '0x1'],
        },
      });
      expect(keepTagRes.statusCode).toBe(200);

      const balanceCalls = calls.filter((item) => item.method === 'eth_getBalance');
      expect(balanceCalls).toHaveLength(7);
      for (const call of balanceCalls.slice(0, 6)) {
        expect(call.params[1]).toBe('latest');
      }
      expect(balanceCalls[6]?.params[1]).toBe('0x1');
    } finally {
      await close();
      rpc.close();
      restoreEnv(envSnapshot);
    }
  });

  it('applies the same normalization on /evm/rpc and leaves non-state methods unchanged', async () => {
    const calls: CapturedRpcCall[] = [];
    const rpc = createMockFoundryRpc(calls);
    const rpcPort = await listen(rpc);
    const envSnapshot = snapshotEnv();

    process.env.AGENT_FOUNDRY_ENABLED = '1';
    process.env.AGENT_FOUNDRY_AUTOSTART = '0';
    process.env.AGENT_FOUNDRY_RPC_HOST = '127.0.0.1';
    process.env.AGENT_FOUNDRY_RPC_PORT = String(rpcPort);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cipherscope-agent-'));
    const dbPath = path.join(tmpDir, 'agent.db');
    const { app, close } = await buildApp({
      dbPath,
      agentName: 'cipherscope-agent',
      agentVersion: '0.0.0-test',
      proxyHost: '127.0.0.1',
      proxyPort: 0,
    });

    try {
      const address = '0x000000000000000000000000000000000000dead';
      const stateRes = await app.inject({
        method: 'POST',
        url: '/evm/rpc',
        payload: {
          method: 'eth_getCode',
          params: [address, '0x0000'],
        },
      });
      expect(stateRes.statusCode).toBe(200);
      expect(stateRes.json()).toMatchObject({ ok: true, result: '0x' });

      const nonStateRes = await app.inject({
        method: 'POST',
        url: '/evm/rpc',
        payload: {
          method: 'eth_getBlockByNumber',
          params: ['0x0', false],
        },
      });
      expect(nonStateRes.statusCode).toBe(200);
      expect(nonStateRes.json()).toMatchObject({ ok: true, result: true });

      expect(calls[0]).toMatchObject({
        method: 'eth_getCode',
      });
      expect(calls[0]?.params[1]).toBe('latest');
      expect(calls[1]).toMatchObject({
        method: 'eth_getBlockByNumber',
      });
      expect(calls[1]?.params[0]).toBe('0x0');
    } finally {
      await close();
      rpc.close();
      restoreEnv(envSnapshot);
    }
  });
});
