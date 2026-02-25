import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../src/browser-automation.js', () => ({
  gotoPage: vi.fn(async (input: { session?: string; url: string; waitUntil?: string }) => ({
    payload: {
      session: input.session ?? 'default',
      requestedUrl: input.url,
      url: input.url,
      title: 'Mock Page',
      status: 200,
      ok: true,
      waitUntil: input.waitUntil ?? 'domcontentloaded',
    },
    summary: `Browser goto navigated session "${input.session ?? 'default'}" to ${input.url} (200).`,
  })),
  clickPage: vi.fn(async () => ({ payload: { ok: true }, summary: 'mock click' })),
  typeIntoPage: vi.fn(async () => ({ payload: { ok: true }, summary: 'mock type' })),
  waitForPage: vi.fn(async () => ({ payload: { ok: true }, summary: 'mock wait' })),
  evaluatePageJs: vi.fn(async () => ({ payload: { result: null }, summary: 'mock evaluate' })),
  extractPageText: vi.fn(async () => ({ payload: { text: '' }, summary: 'mock extract_text' })),
  extractPageDom: vi.fn(async () => ({ payload: { html: '' }, summary: 'mock extract_dom' })),
  screenshotPage: vi.fn(async () => ({ payload: { path: '/tmp/mock.png' }, summary: 'mock screenshot' })),
  closeBrowserAutomation: vi.fn(async () => {}),
}));

import { buildApp } from '../src/app.js';
import { gotoPage } from '../src/browser-automation.js';

const originalFetch = globalThis.fetch;
const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
const originalOpenAiModel = process.env.OPENAI_MODEL;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalOpenAiApiKey == null) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalOpenAiApiKey;
  if (originalOpenAiModel == null) delete process.env.OPENAI_MODEL;
  else process.env.OPENAI_MODEL = originalOpenAiModel;
  vi.clearAllMocks();
});

function findLastToolMessage(
  messages: Array<{ role?: string; content?: string }> | undefined,
): { role?: string; content?: string } | undefined {
  if (!messages) return undefined;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const item = messages[i];
    if (item?.role === 'tool') return item;
  }
  return undefined;
}

describe('agent /ai/chat browser tools', () => {
  it('routes goto tool calls through Playwright browser automation helpers', async () => {
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.OPENAI_MODEL = 'gpt-4.1-mini';

    let callCount = 0;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      callCount += 1;
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        messages?: Array<{ role?: string; content?: string }>;
      };

      if (callCount === 1) {
        return new Response(
          JSON.stringify({
            model: 'gpt-4.1-mini',
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: '',
                  tool_calls: [
                    {
                      id: 'call_browser_goto',
                      type: 'function',
                      function: {
                        name: 'goto',
                        arguments: JSON.stringify({ url: 'https://example.com/', waitUntil: 'load' }),
                      },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }

      const toolMessage = findLastToolMessage(body.messages);
      const toolPayload = JSON.parse(String(toolMessage?.content ?? '{}')) as {
        status?: number;
        url?: string;
        title?: string;
      };
      expect(toolPayload.status).toBe(200);
      expect(toolPayload.url).toBe('https://example.com/');
      expect(toolPayload.title).toBe('Mock Page');

      return new Response(
        JSON.stringify({
          model: 'gpt-4.1-mini',
          choices: [{ message: { role: 'assistant', content: 'Summary\n- Browser automation worked.' } }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cipherscope-agent-ai-browser-'));
    const dbPath = path.join(tmpDir, 'agent.db');
    const { app, close } = await buildApp({
      dbPath,
      agentName: 'cipherscope-agent',
      agentVersion: '0.0.0-test',
      proxyHost: '127.0.0.1',
      proxyPort: 0,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/ai/chat',
      payload: {
        mode: 'smart_contract_audit',
        maxSteps: 3,
        messages: [{ role: 'user', content: 'Open example.com in headless mode.' }],
      },
    });

    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.ok).toBe(true);
    expect(json.toolCalls[0].name).toBe('goto');
    expect(json.toolCalls[0].ok).toBe(true);
    expect(vi.mocked(gotoPage)).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://example.com/', waitUntil: 'load' }),
    );

    await close();
  });
});
