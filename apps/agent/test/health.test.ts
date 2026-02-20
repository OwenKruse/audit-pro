import { describe, expect, it } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { buildApp } from '../src/app.js';

describe('agent /health', () => {
  it('returns a valid health payload', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cipherscope-agent-'));
    const dbPath = path.join(tmpDir, 'agent.db');

    const { app, close } = await buildApp({
      dbPath,
      agentName: 'cipherscope-agent',
      agentVersion: '0.0.0-test',
      proxyHost: '127.0.0.1',
      proxyPort: 0,
    });

    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.ok).toBe(true);
    expect(json.db.ok).toBe(true);

    await close();
  });
});
