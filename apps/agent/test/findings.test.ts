import { describe, expect, it } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import {
  CreateFindingResponseSchema,
  ListFindingsResponseSchema,
  UpdateFindingResponseSchema,
} from '@cipherscope/proto';
import { buildApp } from '../src/app.js';

describe('findings api', () => {
  it('creates, lists, and updates manual findings', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cipherscope-agent-findings-'));
    const dbPath = path.join(tmpDir, 'agent.db');
    const { app, close } = await buildApp({
      dbPath,
      agentName: 'cipherscope-agent',
      agentVersion: '0.0.0-test',
      proxyHost: '127.0.0.1',
      proxyPort: 0,
    });

    const created = CreateFindingResponseSchema.parse(
      (
        await app.inject({
          method: 'POST',
          url: '/findings',
          payload: {
            checkId: 'manual.custom',
            mode: 'passive',
            severity: 'high',
            confidence: 0.88,
            status: 'open',
            title: 'Replay accepted for stale signature',
            summary: 'Endpoint accepted stale SIWE signature.',
            remediation: 'Enforce nonce + short expiration.',
            reproducibility: ['Capture login request', 'Replay with stale signature'],
            tags: ['auth', 'replay'],
            evidence: [
              {
                messageId: 'msg_123',
                field: 'request.bodyJson.signature',
                note: 'Same signature accepted repeatedly.',
                replayVariantId: null,
              },
            ],
          },
        })
      ).json(),
    );

    expect(created.ok).toBe(true);
    expect(created.item.id.startsWith('manual_')).toBe(true);

    const listed = ListFindingsResponseSchema.parse(
      (await app.inject({ method: 'GET', url: '/findings?limit=20&offset=0' })).json(),
    );
    expect(listed.ok).toBe(true);
    expect(listed.items.some((item) => item.id === created.item.id)).toBe(true);

    const updated = UpdateFindingResponseSchema.parse(
      (
        await app.inject({
          method: 'PATCH',
          url: `/findings/${encodeURIComponent(created.item.id)}`,
          payload: {
            status: 'triaged',
            summary: 'Triaged: stale SIWE signature replay is accepted.',
            tags: ['auth', 'replay', 'siwe'],
          },
        })
      ).json(),
    );
    expect(updated.ok).toBe(true);
    expect(updated.item.status).toBe('triaged');
    expect(updated.item.tags).toContain('siwe');

    const listedAgain = ListFindingsResponseSchema.parse(
      (await app.inject({ method: 'GET', url: '/findings?limit=20&offset=0' })).json(),
    );
    const changed = listedAgain.items.find((item) => item.id === created.item.id);
    expect(changed?.status).toBe('triaged');
    expect(changed?.summary).toContain('Triaged');

    await close();
  });
});
