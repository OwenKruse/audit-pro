import { describe, expect, it } from 'vitest';
import {
  AiChatResponseSchema,
  AiChatStreamEventSchema,
  HealthResponseSchema,
  ScannerRunResponseSchema,
} from '../src/schemas';

describe('HealthResponseSchema', () => {
  it('accepts a valid payload', () => {
    const parsed = HealthResponseSchema.parse({
      ok: true,
      name: 'cipherscope-agent',
      version: '0.0.0',
      time: new Date().toISOString(),
      db: { path: '/tmp/agent.db', ok: true },
      metrics: {
        httpRequestsTotal: 1,
        wsMessagesTotal: 2,
        uptimeSeconds: 3,
        httpRequestsPerSecond: 0.33,
        wsMessagesPerSecond: 0.66,
        db: { writesTotal: 0, lastWriteMs: null, avgWriteMs: null },
      },
    });

    expect(parsed.ok).toBe(true);
  });
});

describe('ScannerRunResponseSchema', () => {
  it('accepts a valid scanner payload', () => {
    const parsed = ScannerRunResponseSchema.parse({
      ok: true,
      runId: 'run-1',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      includeActive: true,
      summary: {
        scannedMessages: 12,
        passiveChecks: 20,
        activeChecks: 4,
        findingsTotal: 2,
        bySeverity: {
          info: 0,
          low: 0,
          medium: 1,
          high: 1,
          critical: 0,
        },
      },
      findings: [
        {
          id: 'scanner_1',
          createdAt: new Date().toISOString(),
          checkId: 'passive.siwe.correctness',
          mode: 'passive',
          severity: 'high',
          confidence: 0.95,
          status: 'open',
          title: 'SIWE issue',
          summary: 'Missing nonce.',
          remediation: 'Require nonce.',
          reproducibility: ['Open message 1'],
          tags: ['siwe'],
          evidence: [
            {
              messageId: 'msg-1',
              field: 'request.bodyJson',
              note: 'nonce missing',
              replayVariantId: null,
            },
          ],
        },
      ],
    });

    expect(parsed.ok).toBe(true);
    expect(parsed.findings.length).toBe(1);
  });
});

describe('AiChatResponseSchema', () => {
  it('accepts a valid AI chat payload', () => {
    const parsed = AiChatResponseSchema.parse({
      ok: true,
      status: 'completed',
      mode: 'smart_contract_audit',
      model: 'gpt-4.1-mini',
      assistant: {
        role: 'assistant',
        content: 'I checked the latest calls and found one high-risk replay path.',
        createdAt: new Date().toISOString(),
      },
      toolCalls: [
        {
          id: 'tool_1',
          name: 'list_messages',
          args: { limit: 20 },
          ok: true,
          summary: 'Loaded 20 messages.',
          error: null,
        },
      ],
      warnings: [],
    });

    expect(parsed.ok).toBe(true);
    expect(parsed.toolCalls.length).toBe(1);
  });
});

describe('AiChatStreamEventSchema', () => {
  it('accepts a done event with a full ai response payload', () => {
    const parsed = AiChatStreamEventSchema.parse({
      type: 'done',
      createdAt: new Date().toISOString(),
      response: {
        ok: true,
        status: 'completed',
        mode: 'smart_contract_audit',
        model: 'gpt-4.1-mini',
        assistant: {
          role: 'assistant',
          content: 'Summary\n- Completed.',
          createdAt: new Date().toISOString(),
        },
        toolCalls: [],
        warnings: [],
      },
    });

    expect(parsed.type).toBe('done');
    if (parsed.type === 'done') {
      expect(parsed.response.ok).toBe(true);
    }
  });
});
