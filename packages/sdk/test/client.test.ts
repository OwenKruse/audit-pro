import { describe, expect, it } from 'vitest';
import type { ScannerFinding } from '@cipherscope/proto';
import { AgentClient } from '../src/client';

describe('AgentClient', () => {
  it('normalizes base URLs and parses health', async () => {
    const client = new AgentClient({
      httpBaseUrl: 'http://127.0.0.1:17400/',
      fetch: async () =>
        new Response(
          JSON.stringify({
            ok: true,
            name: 'cipherscope-agent',
            version: '0.0.0',
            time: new Date().toISOString(),
            db: { path: '/tmp/agent.db', ok: true },
            metrics: {
              httpRequestsTotal: 0,
              wsMessagesTotal: 0,
              uptimeSeconds: 1,
              httpRequestsPerSecond: 0,
              wsMessagesPerSecond: 0,
              db: { writesTotal: 0, lastWriteMs: null, avgWriteMs: null },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    });

    const health = await client.health();
    expect(health.ok).toBe(true);
    expect(health.db.ok).toBe(true);
  });

  it('runs scanner and parses findings response', async () => {
    const client = new AgentClient({
      httpBaseUrl: 'http://127.0.0.1:17400',
      fetch: async (input) => {
        expect(String(input)).toContain('/scanner/run');
        return new Response(
          JSON.stringify({
            ok: true,
            runId: 'run-1',
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
            includeActive: false,
            summary: {
              scannedMessages: 1,
              passiveChecks: 2,
              activeChecks: 0,
              findingsTotal: 1,
              bySeverity: {
                info: 0,
                low: 0,
                medium: 1,
                high: 0,
                critical: 0,
              },
            },
            findings: [
              {
                id: 'scanner_1',
                createdAt: new Date().toISOString(),
                checkId: 'passive.approval.unlimited_erc20',
                mode: 'passive',
                severity: 'medium',
                confidence: 0.8,
                status: 'open',
                title: 'Unlimited approval',
                summary: 'Approval amount is too large.',
                remediation: 'Use bounded approvals.',
                reproducibility: ['Open message msg-1.'],
                tags: ['approval'],
                evidence: [
                  {
                    messageId: 'msg-1',
                    field: 'request.bodyJson',
                    note: 'amount=max',
                    replayVariantId: null,
                  },
                ],
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    });

    const run = await client.runScanner({ includeActive: false, limit: 50 });
    expect(run.ok).toBe(true);
    expect(run.summary.findingsTotal).toBe(1);
  });

  it('creates, lists, and updates findings', async () => {
    const createdAt = new Date().toISOString();
    let stored: ScannerFinding = {
      id: 'manual_1',
      createdAt,
      checkId: 'manual.custom',
      mode: 'passive',
      severity: 'medium',
      confidence: 0.8,
      status: 'open',
      title: 'Initial title',
      summary: 'Initial summary',
      remediation: 'Initial remediation',
      reproducibility: ['step 1'],
      tags: ['manual'],
      evidence: [
        {
          messageId: 'msg-1',
          field: 'request.bodyJson',
          note: 'note',
          replayVariantId: null,
        },
      ],
    };

    const client = new AgentClient({
      httpBaseUrl: 'http://127.0.0.1:17400',
      fetch: async (input, init) => {
        const url = String(input);
        const method = (init?.method ?? 'GET').toUpperCase();

        if (url.includes('/findings') && method === 'GET') {
          return new Response(JSON.stringify({ ok: true, items: [stored] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }

        if (url.endsWith('/findings') && method === 'POST') {
          const body = JSON.parse(String(init?.body ?? '{}')) as {
            title?: string;
            summary?: string;
          };
          stored = {
            ...stored,
            title: body.title ?? stored.title,
            summary: body.summary ?? stored.summary,
          };
          return new Response(JSON.stringify({ ok: true, item: stored }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }

        if (url.includes('/findings/manual_1') && method === 'PATCH') {
          const patch = JSON.parse(String(init?.body ?? '{}')) as {
            status?: 'open' | 'triaged' | 'resolved';
            summary?: string;
          };
          stored = {
            ...stored,
            status: patch.status ?? stored.status,
            summary: patch.summary ?? stored.summary,
          };
          return new Response(JSON.stringify({ ok: true, item: stored }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }

        return new Response('not found', { status: 404 });
      },
    });

    const created = await client.createFinding({
      checkId: 'manual.custom',
      mode: 'passive',
      severity: 'medium',
      confidence: 0.8,
      status: 'open',
      title: 'Created title',
      summary: 'Created summary',
      remediation: 'Initial remediation',
      reproducibility: ['step 1'],
      tags: ['manual'],
      evidence: [
        {
          messageId: 'msg-1',
          field: 'request.bodyJson',
          note: 'note',
          replayVariantId: null,
        },
      ],
    });
    expect(created.ok).toBe(true);
    expect(created.item.title).toBe('Created title');

    const listed = await client.listFindings({ limit: 10, offset: 0 });
    expect(listed.ok).toBe(true);
    expect(listed.items.length).toBe(1);

    const updated = await client.updateFinding('manual_1', {
      status: 'triaged',
      summary: 'Updated summary',
    });
    expect(updated.ok).toBe(true);
    expect(updated.item.status).toBe('triaged');
    expect(updated.item.summary).toBe('Updated summary');
  });

  it('chats with autonomous agent endpoint', async () => {
    const client = new AgentClient({
      httpBaseUrl: 'http://127.0.0.1:17400',
      fetch: async (input, init) => {
        expect(String(input)).toContain('/ai/chat');
        expect((init?.method ?? 'GET').toUpperCase()).toBe('POST');
        return new Response(
          JSON.stringify({
            ok: true,
            status: 'completed',
            mode: 'smart_contract_audit',
            model: 'gpt-4.1-mini',
            assistant: {
              role: 'assistant',
              content: 'Finished analysis.',
              createdAt: new Date().toISOString(),
            },
            toolCalls: [],
            warnings: [],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    });

    const out = await client.chatWithAgent({
      messages: [{ role: 'user', content: 'Analyze latest call history.' }],
      mode: 'smart_contract_audit',
      maxSteps: 4,
    });
    expect(out.ok).toBe(true);
    expect(out.assistant.role).toBe('assistant');
  });
});
