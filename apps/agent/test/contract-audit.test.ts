import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ContractAuditRunResponseSchema,
  ListFindingsResponseSchema,
} from '@cipherscope/proto';
import { buildApp } from '../src/app.js';

describe('contract audit route', () => {
  it('runs sandbox contract checks and persists findings', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cipherscope-agent-'));
    const dbPath = path.join(tmpDir, 'agent.db');

    const { app, close } = await buildApp({
      dbPath,
      agentName: 'cipherscope-agent',
      agentVersion: '0.0.0-test',
      proxyHost: '127.0.0.1',
      proxyPort: 0,
    });

    const spender = '0000000000000000000000001111111111111111111111111111111111111111';
    const approveData = `0x095ea7b3${spender}${'f'.repeat(64)}`;
    const run = ContractAuditRunResponseSchema.parse(
      (
        await app.inject({
          method: 'POST',
          url: '/audit/contracts/run',
          payload: {
            sourceInteractionId: 'rpc_local_1',
            method: 'eth_sendTransaction',
            chainId: 31337,
            tx: {
              from: '0x2222222222222222222222222222222222222222',
              to: '0x3333333333333333333333333333333333333333',
              data: approveData,
              value: '0',
              gas: '210000',
            },
          },
        })
      ).json(),
    );

    expect(run.ok).toBe(true);
    expect(run.summary.findingsTotal).toBeGreaterThan(0);
    expect(run.findings.some((f) => f.checkId === 'audit.contract.approval.unlimited_erc20')).toBe(
      true,
    );

    const persisted = ListFindingsResponseSchema.parse(
      (await app.inject({ method: 'GET', url: '/findings?limit=200&offset=0' })).json(),
    );
    expect(
      persisted.items.some((f) => f.checkId === 'audit.contract.approval.unlimited_erc20'),
    ).toBe(true);

    await close();
  });
});
