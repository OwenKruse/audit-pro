import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openAgentDb } from '../src/db.js';
import { createMetrics } from '../src/metrics.js';
import { listHttpMessages } from '../src/store.js';
import { runSubfinder } from '../src/subfinder.js';

function makeScript(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cipherscope-subfinder-'));
  const scriptPath = path.join(dir, 'mock-subfinder.sh');
  fs.writeFileSync(scriptPath, contents, { encoding: 'utf8', mode: 0o755 });
  fs.chmodSync(scriptPath, 0o755);
  return scriptPath;
}

describe('runSubfinder', () => {
  it('runs command and parses discovered subdomains', async () => {
    const binary = makeScript(`#!/bin/sh
echo "api.example.com"
echo "www.example.com"
echo "api.example.com"
echo "other.com"
exit 0
`);

    const out = await runSubfinder({
      request: {
        domain: 'https://example.com',
        recursive: true,
        allSources: false,
        activeOnly: false,
      },
      binary,
      timeoutMs: 5_000,
    });

    expect(out.domain).toBe('example.com');
    expect(out.run.ok).toBe(true);
    expect(out.run.exitCode).toBe(0);
    expect(out.count).toBe(2);
    expect(out.subdomains).toEqual(['api.example.com', 'www.example.com']);
  });

  it('returns non-zero exits with error metadata', async () => {
    const binary = makeScript(`#!/bin/sh
echo "tool failed" >&2
exit 2
`);

    const out = await runSubfinder({
      request: {
        domain: 'example.com',
      },
      binary,
      timeoutMs: 5_000,
    });

    expect(out.run.ok).toBe(false);
    expect(out.run.exitCode).toBe(2);
    expect(out.run.error).toContain('code 2');
    expect(out.run.stderr).toContain('tool failed');
  });

  it('records discovered hosts into call history when db is provided', async () => {
    const binary = makeScript(`#!/bin/sh
echo "api.example.com"
echo "docs.example.com"
exit 0
`);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cipherscope-subfinder-db-'));
    const dbPath = path.join(tmpDir, 'agent.db');
    const metrics = createMetrics();
    const opened = openAgentDb({ dbPath, metrics });
    const db = opened.db;
    try {
      const out = await runSubfinder({
        request: { domain: 'example.com' },
        binary,
        db,
      });

      expect(out.count).toBe(2);
      const messages = listHttpMessages(db, { limit: 20, offset: 0 });
      const hosts = new Set(messages.map((item) => item.host));
      expect(hosts.has('api.example.com')).toBe(true);
      expect(hosts.has('docs.example.com')).toBe(true);
    } finally {
      opened.close();
    }
  });
});
