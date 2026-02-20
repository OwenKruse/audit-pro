import { describe, expect, it } from 'vitest';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { buildApp } from '../src/app.js';
import {
  ListContractsResponseSchema,
  ListDecodedContractsResponseSchema,
  ProxyStatusSchema,
  UpsertContractResponseSchema,
} from '@cipherscope/proto';
import { encodeFunctionData } from 'viem';

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

describe('contracts api', () => {
  it('stores and deletes ABI entries', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cipherscope-agent-'));
    const dbPath = path.join(tmpDir, 'agent.db');

    const { app, close } = await buildApp({
      dbPath,
      agentName: 'cipherscope-agent',
      agentVersion: '0.0.0-test',
      proxyHost: '127.0.0.1',
      proxyPort: 0,
    });

    const upsert = UpsertContractResponseSchema.parse(
      (
        await app.inject({
          method: 'POST',
          url: '/contracts',
          payload: {
            name: 'TestToken',
            chainId: 1,
            address: '0x2222222222222222222222222222222222222222',
            abi: [
              {
                type: 'function',
                name: 'approve',
                inputs: [
                  { name: 'spender', type: 'address' },
                  { name: 'amount', type: 'uint256' },
                ],
                outputs: [{ name: '', type: 'bool' }],
                stateMutability: 'nonpayable',
              },
            ],
          },
        })
      ).json(),
    );
    expect(upsert.ok).toBe(true);
    expect(upsert.item.name).toBe('TestToken');

    const list = ListContractsResponseSchema.parse(
      (await app.inject({ method: 'GET', url: '/contracts' })).json(),
    );
    expect(list.items.length).toBe(1);
    expect(list.items[0]?.name).toBe('TestToken');

    const detail = UpsertContractResponseSchema.parse(
      (await app.inject({ method: 'GET', url: `/contracts/${encodeURIComponent(upsert.item.id)}` })).json(),
    );
    expect(detail.item.id).toBe(upsert.item.id);
    expect(detail.item.abi.length).toBe(1);

    const deleted = (
      await app.inject({ method: 'DELETE', url: `/contracts/${encodeURIComponent(upsert.item.id)}` })
    ).json() as { ok: boolean; deleted: boolean };
    expect(deleted.ok).toBe(true);
    expect(deleted.deleted).toBe(true);

    await close();
  });

  it('decodes eth_sendTransaction call data using vault ABI', async () => {
    const upstream = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: '0xabc123',
          }),
        );
      });
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

    await app.inject({
      method: 'POST',
      url: '/contracts',
      payload: {
        name: 'USDC',
        chainId: 1,
        address: '0x2222222222222222222222222222222222222222',
        abi: [
          {
            type: 'function',
            name: 'approve',
            inputs: [
              { name: 'spender', type: 'address' },
              { name: 'amount', type: 'uint256' },
            ],
            outputs: [{ name: '', type: 'bool' }],
            stateMutability: 'nonpayable',
          },
        ],
      },
    });

    const proxyStatus = ProxyStatusSchema.parse(
      (await app.inject({ method: 'GET', url: '/proxy/status' })).json(),
    );
    const proxyPort = proxyStatus.proxy.port;

    const targetUrl = `http://127.0.0.1:${upstreamPort}/rpc`;
    const data =
      '0x095ea7b3' +
      '0000000000000000000000001111111111111111111111111111111111111111' +
      'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';

    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_sendTransaction',
      params: [
        {
          to: '0x2222222222222222222222222222222222222222',
          data,
          chainId: '0x1',
        },
      ],
    });

    const resp = await requestViaProxy({
      proxyPort,
      targetUrl,
      method: 'POST',
      headers: {
        host: `127.0.0.1:${upstreamPort}`,
        'content-type': 'application/json',
      },
      body,
    });
    expect(resp.statusCode).toBe(200);

    const decoded = ListDecodedContractsResponseSchema.parse(
      (await app.inject({ method: 'GET', url: '/contracts/decoded?limit=50&offset=0' })).json(),
    );
    expect(decoded.items.length).toBeGreaterThan(0);
    const approve = decoded.items.find((d) => d.functionName === 'approve');
    expect(approve).toBeTruthy();
    expect(approve?.contractName).toBe('USDC');
    expect(approve?.risks.some((r) => r.includes('Unlimited approval'))).toBe(true);

    await close();
    upstream.close();
  });

  it('decodes flash-loan calldata using common fallback ABI', async () => {
    const upstream = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: '0xabc123',
          }),
        );
      });
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

    const targetUrl = `http://127.0.0.1:${upstreamPort}/rpc`;
    const data = encodeFunctionData({
      abi: [
        {
          type: 'function',
          name: 'flashLoanSimple',
          stateMutability: 'nonpayable',
          inputs: [
            { name: 'receiverAddress', type: 'address' },
            { name: 'asset', type: 'address' },
            { name: 'amount', type: 'uint256' },
            { name: 'params', type: 'bytes' },
            { name: 'referralCode', type: 'uint16' },
          ],
          outputs: [],
        },
      ],
      functionName: 'flashLoanSimple',
      args: [
        '0x1111111111111111111111111111111111111111',
        '0x2222222222222222222222222222222222222222',
        1_000_000n,
        '0x',
        0,
      ],
    });

    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_sendTransaction',
      params: [
        {
          to: '0x3333333333333333333333333333333333333333',
          data,
          chainId: '0x1',
        },
      ],
    });

    const resp = await requestViaProxy({
      proxyPort,
      targetUrl,
      method: 'POST',
      headers: {
        host: `127.0.0.1:${upstreamPort}`,
        'content-type': 'application/json',
      },
      body,
    });
    expect(resp.statusCode).toBe(200);

    const decoded = ListDecodedContractsResponseSchema.parse(
      (await app.inject({ method: 'GET', url: '/contracts/decoded?limit=50&offset=0' })).json(),
    );
    const flashLoan = decoded.items.find((d) => d.functionName === 'flashLoanSimple');
    expect(flashLoan).toBeTruthy();
    expect(flashLoan?.contractName).toBe('Generic Flash Loan Provider');
    expect(flashLoan?.risks.some((r) => r.includes('Flash loan interaction'))).toBe(true);

    await close();
    upstream.close();
  });
});
