import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { buildApp } from '../src/app.js';

const originalFetch = globalThis.fetch;
const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
const originalOpenAiModel = process.env.OPENAI_MODEL;
const originalOpenRouterApiKey = process.env.OPENROUTER_API_KEY;
const originalGeminiApiKey = process.env.GEMINI_API_KEY;
const originalGeminiBaseUrl = process.env.GEMINI_BASE_URL;
const originalGrokApiKey = process.env.GROK_API_KEY;
const originalXaiApiKey = process.env.XAI_API_KEY;
const originalClaudeApiKey = process.env.CLAUDE_API_KEY;
const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY;
const originalClaudeBaseUrl = process.env.CLAUDE_BASE_URL;
const originalDeepseekApiKey = process.env.DEEPSEEK_API_KEY;
const originalDeepseekBaseUrl = process.env.DEEPSEEK_BASE_URL;
const originalHttpAllowAnyHost = process.env.AGENT_AI_HTTP_ALLOW_ANY_HOST;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalOpenAiApiKey == null) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalOpenAiApiKey;
  if (originalOpenAiModel == null) delete process.env.OPENAI_MODEL;
  else process.env.OPENAI_MODEL = originalOpenAiModel;
  if (originalOpenRouterApiKey == null) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = originalOpenRouterApiKey;
  if (originalGeminiApiKey == null) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = originalGeminiApiKey;
  if (originalGeminiBaseUrl == null) delete process.env.GEMINI_BASE_URL;
  else process.env.GEMINI_BASE_URL = originalGeminiBaseUrl;
  if (originalGrokApiKey == null) delete process.env.GROK_API_KEY;
  else process.env.GROK_API_KEY = originalGrokApiKey;
  if (originalXaiApiKey == null) delete process.env.XAI_API_KEY;
  else process.env.XAI_API_KEY = originalXaiApiKey;
  if (originalClaudeApiKey == null) delete process.env.CLAUDE_API_KEY;
  else process.env.CLAUDE_API_KEY = originalClaudeApiKey;
  if (originalAnthropicApiKey == null) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey;
  if (originalClaudeBaseUrl == null) delete process.env.CLAUDE_BASE_URL;
  else process.env.CLAUDE_BASE_URL = originalClaudeBaseUrl;
  if (originalDeepseekApiKey == null) delete process.env.DEEPSEEK_API_KEY;
  else process.env.DEEPSEEK_API_KEY = originalDeepseekApiKey;
  if (originalDeepseekBaseUrl == null) delete process.env.DEEPSEEK_BASE_URL;
  else process.env.DEEPSEEK_BASE_URL = originalDeepseekBaseUrl;
  if (originalHttpAllowAnyHost == null) delete process.env.AGENT_AI_HTTP_ALLOW_ANY_HOST;
  else process.env.AGENT_AI_HTTP_ALLOW_ANY_HOST = originalHttpAllowAnyHost;
});

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

describe('agent /ai/chat', () => {
  it('returns ai_unconfigured when OPENAI_API_KEY is missing', async () => {
    delete process.env.OPENAI_API_KEY;

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cipherscope-agent-ai-'));
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
        messages: [{ role: 'user', content: 'Analyze latest traffic.' }],
      },
    });

    expect(res.statusCode).toBe(503);
    const json = res.json();
    expect(json.ok).toBe(false);
    expect(json.error.code).toBe('ai_unconfigured');

    await close();
  });

  it('returns ai_unconfigured for openrouter when OPENROUTER_API_KEY is missing', async () => {
    process.env.OPENAI_API_KEY = 'test-openai-key';
    delete process.env.OPENROUTER_API_KEY;

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cipherscope-agent-ai-'));
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
        provider: 'openrouter',
        mode: 'smart_contract_audit',
        maxSteps: 3,
        messages: [{ role: 'user', content: 'Analyze latest traffic.' }],
      },
    });

    expect(res.statusCode).toBe(503);
    const json = res.json();
    expect(json.ok).toBe(false);
    expect(json.error.code).toBe('ai_unconfigured');
    expect(String(json.error.message)).toContain('OPENROUTER_API_KEY');

    await close();
  });

  it('uses gemini provider config and selected request model', async () => {
    process.env.GEMINI_API_KEY = 'test-gemini-key';
    process.env.GEMINI_BASE_URL = 'https://example.invalid/v1beta/openai';

    let calledUrl = '';
    let calledAuth = '';
    let calledModel = '';
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calledUrl = String(input);
      calledAuth = String((init?.headers as Record<string, string> | undefined)?.authorization ?? '');
      const body = JSON.parse(String(init?.body ?? '{}')) as { model?: unknown };
      calledModel = typeof body.model === 'string' ? body.model : '';

      return new Response(
        JSON.stringify({
          model: calledModel || 'gemini-2.0-flash',
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'Summary\\n- Gemini route works.',
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cipherscope-agent-ai-'));
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
        provider: 'gemini',
        model: 'gemini-2.5-pro',
        mode: 'smart_contract_audit',
        maxSteps: 2,
        messages: [{ role: 'user', content: 'Check call history and summarize.' }],
      },
    });

    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.ok).toBe(true);
    expect(String(json.model)).toBe('gemini-2.5-pro');
    expect(calledUrl).toBe('https://example.invalid/v1beta/openai/chat/completions');
    expect(calledAuth).toBe('Bearer test-gemini-key');
    expect(calledModel).toBe('gemini-2.5-pro');

    await close();
  });

  it('returns ai_unconfigured for claude when CLAUDE_API_KEY is missing', async () => {
    delete process.env.CLAUDE_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cipherscope-agent-ai-'));
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
        provider: 'claude',
        mode: 'smart_contract_audit',
        maxSteps: 3,
        messages: [{ role: 'user', content: 'Analyze latest traffic.' }],
      },
    });

    expect(res.statusCode).toBe(503);
    const json = res.json();
    expect(json.ok).toBe(false);
    expect(json.error.code).toBe('ai_unconfigured');
    expect(String(json.error.message)).toContain('CLAUDE_API_KEY');

    await close();
  });

  it('uses claude provider config and selected request model', async () => {
    process.env.CLAUDE_API_KEY = 'test-claude-key';
    process.env.CLAUDE_BASE_URL = 'https://anthropic.example.invalid';

    let calledUrl = '';
    let calledApiKeyHeader = '';
    let calledAnthropicVersion = '';
    let calledModel = '';
    let firstMessageRole = '';
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calledUrl = String(input);
      const headers = (init?.headers as Record<string, string> | undefined) ?? {};
      calledApiKeyHeader = String(headers['x-api-key'] ?? '');
      calledAnthropicVersion = String(headers['anthropic-version'] ?? '');
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        model?: unknown;
        messages?: Array<{ role?: unknown }>;
      };
      calledModel = typeof body.model === 'string' ? body.model : '';
      firstMessageRole =
        Array.isArray(body.messages) && typeof body.messages[0]?.role === 'string'
          ? body.messages[0].role
          : '';

      return new Response(
        JSON.stringify({
          model: calledModel || 'claude-3-5-sonnet-latest',
          content: [{ type: 'text', text: 'Summary\\n- Claude route works.' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cipherscope-agent-ai-'));
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
        provider: 'claude',
        model: 'claude-3-7-sonnet-latest',
        mode: 'smart_contract_audit',
        maxSteps: 2,
        messages: [{ role: 'user', content: 'Check call history and summarize.' }],
      },
    });

    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.ok).toBe(true);
    expect(String(json.model)).toBe('claude-3-7-sonnet-latest');
    expect(calledUrl).toBe('https://anthropic.example.invalid/v1/messages');
    expect(calledApiKeyHeader).toBe('test-claude-key');
    expect(calledAnthropicVersion).toBe('2023-06-01');
    expect(calledModel).toBe('claude-3-7-sonnet-latest');
    expect(firstMessageRole).toBe('user');

    await close();
  });

  it('returns ai_unconfigured for deepseek when DEEPSEEK_API_KEY is missing', async () => {
    delete process.env.DEEPSEEK_API_KEY;

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cipherscope-agent-ai-'));
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
        provider: 'deepseek',
        mode: 'smart_contract_audit',
        maxSteps: 3,
        messages: [{ role: 'user', content: 'Analyze latest traffic.' }],
      },
    });

    expect(res.statusCode).toBe(503);
    const json = res.json();
    expect(json.ok).toBe(false);
    expect(json.error.code).toBe('ai_unconfigured');
    expect(String(json.error.message)).toContain('DEEPSEEK_API_KEY');

    await close();
  });

  it('uses deepseek provider config and selected request model', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-deepseek-key';
    process.env.DEEPSEEK_BASE_URL = 'https://deepseek.example.invalid/v1';

    let calledUrl = '';
    let calledAuth = '';
    let calledModel = '';
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calledUrl = String(input);
      calledAuth = String((init?.headers as Record<string, string> | undefined)?.authorization ?? '');
      const body = JSON.parse(String(init?.body ?? '{}')) as { model?: unknown };
      calledModel = typeof body.model === 'string' ? body.model : '';

      return new Response(
        JSON.stringify({
          model: calledModel || 'deepseek-chat',
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'Summary\\n- DeepSeek route works.',
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cipherscope-agent-ai-'));
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
        provider: 'deepseek',
        model: 'deepseek-reasoner',
        mode: 'smart_contract_audit',
        maxSteps: 2,
        messages: [{ role: 'user', content: 'Check call history and summarize.' }],
      },
    });

    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.ok).toBe(true);
    expect(String(json.model)).toBe('deepseek-reasoner');
    expect(calledUrl).toBe('https://deepseek.example.invalid/v1/chat/completions');
    expect(calledAuth).toBe('Bearer test-deepseek-key');
    expect(calledModel).toBe('deepseek-reasoner');

    await close();
  });

  it('runs tool-calling loop and returns assistant output', async () => {
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.OPENAI_MODEL = 'gpt-4.1-mini';

    let callCount = 0;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      callCount += 1;
      const body = JSON.parse(String(init?.body ?? '{}')) as { messages?: unknown[] };
      expect(Array.isArray(body.messages)).toBe(true);

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
                      id: 'call_1',
                      type: 'function',
                      function: { name: 'list_messages', arguments: '{"limit":5}' },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }

      return new Response(
        JSON.stringify({
          model: 'gpt-4.1-mini',
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'Summary\\n- Completed analysis.',
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cipherscope-agent-ai-'));
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
        maxSteps: 4,
        messages: [{ role: 'user', content: 'Check call history and summarize.' }],
      },
    });

    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.ok).toBe(true);
    expect(json.assistant.content).toContain('Completed analysis');
    expect(Array.isArray(json.toolCalls)).toBe(true);
    expect(json.toolCalls.length).toBe(1);
    expect(json.toolCalls[0].name).toBe('list_messages');
    expect(callCount).toBe(2);

    await close();
  });

  it('applies status filtering before pagination for list_findings tool', async () => {
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.OPENAI_MODEL = 'gpt-4.1-mini';

    let callCount = 0;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      callCount += 1;
      const body = JSON.parse(String(init?.body ?? '{}')) as { messages?: Array<{ role?: string; content?: string }> };
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
                      id: 'call_list_findings',
                      type: 'function',
                      function: {
                        name: 'list_findings',
                        arguments: JSON.stringify({ status: 'open', limit: 1, offset: 0 }),
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
        count?: number;
        items?: Array<{ status?: string }>;
      };
      expect(toolPayload.count).toBe(1);
      expect(toolPayload.items?.[0]?.status).toBe('open');

      return new Response(
        JSON.stringify({
          model: 'gpt-4.1-mini',
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'Summary\n- Findings filtered correctly.',
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cipherscope-agent-ai-'));
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
      url: '/findings',
      payload: {
        checkId: 'manual.listfindings.open',
        mode: 'passive',
        severity: 'medium',
        confidence: 0.5,
        status: 'open',
        title: 'Older open finding',
        summary: 'open finding',
        remediation: 'n/a',
        reproducibility: ['n/a'],
        tags: ['test'],
        evidence: [{ messageId: 'm1', field: 'request.body', note: 'n/a', replayVariantId: null }],
      },
    });
    await app.inject({
      method: 'POST',
      url: '/findings',
      payload: {
        checkId: 'manual.listfindings.resolved',
        mode: 'passive',
        severity: 'low',
        confidence: 0.5,
        status: 'resolved',
        title: 'Newer resolved finding',
        summary: 'resolved finding',
        remediation: 'n/a',
        reproducibility: ['n/a'],
        tags: ['test'],
        evidence: [{ messageId: 'm2', field: 'request.body', note: 'n/a', replayVariantId: null }],
      },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/ai/chat',
      payload: {
        mode: 'smart_contract_audit',
        maxSteps: 3,
        messages: [{ role: 'user', content: 'List open findings.' }],
      },
    });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.ok).toBe(true);
    expect(json.toolCalls[0].name).toBe('list_findings');
    expect(json.toolCalls[0].ok).toBe(true);

    await close();
  });

  it('generates form-url-encoded array/duplicate-key payload candidates', async () => {
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.OPENAI_MODEL = 'gpt-4.1-mini';

    const upstream = http.createServer((_req, res) => {
      res.setHeader('content-type', 'text/plain');
      res.end('ok');
    });
    const upstreamPort = await listen(upstream);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cipherscope-agent-ai-'));
    const dbPath = path.join(tmpDir, 'agent.db');
    const { app, close } = await buildApp({
      dbPath,
      agentName: 'cipherscope-agent',
      agentVersion: '0.0.0-test',
      proxyHost: '127.0.0.1',
      proxyPort: 0,
    });

    const proxyStatusRes = await app.inject({ method: 'GET', url: '/proxy/status' });
    const proxyPort = (proxyStatusRes.json() as { proxy: { port: number } }).proxy.port;

    const body = 'user=123123&pass=1231231&login_btn=INITIATE+ACCESS';
    const seeded = await requestViaProxy({
      proxyPort,
      targetUrl: `http://127.0.0.1:${upstreamPort}/gate.php`,
      method: 'POST',
      headers: {
        host: `127.0.0.1:${upstreamPort}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body,
    });
    expect(seeded.statusCode).toBe(200);

    const listRes = await app.inject({ method: 'GET', url: '/messages?limit=10&offset=0' });
    const baseline = (listRes.json() as { items: Array<{ id: string; path: string }> }).items.find(
      (item) => item.path === '/gate.php',
    );
    expect(baseline).toBeTruthy();

    let callCount = 0;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      callCount += 1;
      const bodyObj = JSON.parse(String(init?.body ?? '{}')) as { messages?: Array<{ role?: string; content?: string }> };
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
                      id: 'call_payloads',
                      type: 'function',
                      function: {
                        name: 'generate_payload_candidates',
                        arguments: JSON.stringify({ messageId: baseline?.id, maxCases: 12 }),
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

      const toolMessage = findLastToolMessage(bodyObj.messages);
      const toolPayload = JSON.parse(String(toolMessage?.content ?? '{}')) as {
        candidates?: Array<{ label?: string }>;
      };
      const labels = new Set((toolPayload.candidates ?? []).map((candidate) => candidate.label));
      expect(labels.has('array_injection_user')).toBe(true);
      expect(labels.has('array_injection_pass')).toBe(true);
      expect(labels.has('duplicate_scalar_array_user')).toBe(true);

      return new Response(
        JSON.stringify({
          model: 'gpt-4.1-mini',
          choices: [{ message: { role: 'assistant', content: 'Summary\n- Payload candidates generated.' } }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const res = await app.inject({
      method: 'POST',
      url: '/ai/chat',
      payload: {
        mode: 'smart_contract_audit',
        maxSteps: 3,
        messages: [{ role: 'user', content: 'Generate payload candidates for this login form.' }],
      },
    });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.ok).toBe(true);
    expect(json.toolCalls[0].name).toBe('generate_payload_candidates');
    expect(json.toolCalls[0].ok).toBe(true);

    await close();
    upstream.close();
  });

  it('uses raw transport for http_request tool even when fetch cannot reach target hosts', async () => {
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.OPENAI_MODEL = 'gpt-4.1-mini';
    process.env.AGENT_AI_HTTP_ALLOW_ANY_HOST = '1';

    let seenAuthorizationHeader: string | null = null;
    let seenTraceHeader: string | null = null;
    const upstream = http.createServer((req, res) => {
      const auth = req.headers.authorization;
      const trace = req.headers['x-cs-trace'];
      seenAuthorizationHeader = Array.isArray(auth) ? (auth[0] ?? null) : (auth ?? null);
      seenTraceHeader = Array.isArray(trace) ? (trace[0] ?? null) : (trace ?? null);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, source: 'upstream' }));
    });
    const upstreamPort = await listen(upstream);
    const targetUrl = `http://127.0.0.1:${upstreamPort}/health`;

    let callCount = 0;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (!url.includes('/chat/completions')) {
        throw new Error('fetch failed');
      }

      callCount += 1;
      const body = JSON.parse(String(init?.body ?? '{}')) as { messages?: Array<{ role?: string; content?: string }> };
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
                      id: 'call_http',
                      type: 'function',
                      function: {
                        name: 'http_request',
                        arguments: JSON.stringify({
                          method: 'GET',
                          url: targetUrl,
                          headers: ['Authorization: Bearer local-test-token', 'X-CS-Trace: trace-123'],
                        }),
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
        ok?: boolean;
        status?: number;
        bodyJson?: { ok?: boolean };
      };
      expect(toolPayload.ok).toBe(true);
      expect(toolPayload.status).toBe(200);
      expect(toolPayload.bodyJson?.ok).toBe(true);

      return new Response(
        JSON.stringify({
          model: 'gpt-4.1-mini',
          choices: [{ message: { role: 'assistant', content: 'Summary\n- HTTP request succeeded.' } }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cipherscope-agent-ai-'));
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
        messages: [{ role: 'user', content: 'Run an HTTP check.' }],
      },
    });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.ok).toBe(true);
    expect(json.toolCalls[0].name).toBe('http_request');
    expect(json.toolCalls[0].ok).toBe(true);
    expect(seenAuthorizationHeader).toBe('Bearer local-test-token');
    expect(seenTraceHeader).toBe('trace-123');

    const messagesRes = await app.inject({
      method: 'GET',
      url: '/messages?limit=20&offset=0',
    });
    expect(messagesRes.statusCode).toBe(200);
    const messagesJson = messagesRes.json();
    expect(messagesJson.ok).toBe(true);
    expect(Array.isArray(messagesJson.items)).toBe(true);
    expect(messagesJson.items.length).toBeGreaterThan(0);
    expect(messagesJson.items[0]?.state).toBe('replayed');
    expect(messagesJson.items[0]?.method).toBe('GET');
    expect(messagesJson.items[0]?.path).toBe('/health');
    expect(messagesJson.items[0]?.host).toBe('127.0.0.1');

    const sitemapRes = await app.inject({
      method: 'GET',
      url: '/sitemap',
    });
    expect(sitemapRes.statusCode).toBe(200);
    const sitemapJson = sitemapRes.json();
    expect(sitemapJson.ok).toBe(true);
    expect(Array.isArray(sitemapJson.hosts)).toBe(true);
    const hostEntry = sitemapJson.hosts.find((h: { host?: unknown; port?: unknown }) => h.host === '127.0.0.1');
    expect(hostEntry).toBeTruthy();
    expect((hostEntry as { requests?: number }).requests ?? 0).toBeGreaterThan(0);

    await close();
    upstream.close();
  });

  it('persists repeater session state across separate chat requests', async () => {
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.OPENAI_MODEL = 'gpt-4.1-mini';
    process.env.AGENT_AI_HTTP_ALLOW_ANY_HOST = '1';

    let seenMethod = '';
    let seenPath = '';
    let seenRepeatHeader: string | null = null;
    let seenBody = '';

    const upstream = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      req.on('end', () => {
        seenMethod = req.method ?? '';
        seenPath = req.url ?? '';
        const repeat = req.headers['x-repeat'];
        seenRepeatHeader = Array.isArray(repeat) ? (repeat[0] ?? null) : (repeat ?? null);
        seenBody = Buffer.concat(chunks).toString('utf8');
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true, echoedPath: seenPath }));
      });
    });
    const upstreamPort = await listen(upstream);
    const baseUrl = `http://127.0.0.1:${upstreamPort}/initial`;

    let aiCallCount = 0;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (!url.includes('/chat/completions')) throw new Error('fetch failed');

      aiCallCount += 1;
      const bodyObj = JSON.parse(String(init?.body ?? '{}')) as {
        messages?: Array<{ role?: string; content?: string }>;
      };

      if (aiCallCount === 1) {
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
                      id: 'call_repeater_update',
                      type: 'function',
                      function: {
                        name: 'repeater_request',
                        arguments: JSON.stringify({
                          action: 'update',
                          session: 'sticky',
                          url: baseUrl,
                          method: 'POST',
                          headers: ['X-Repeat: yes'],
                          bodyJson: { first: true },
                        }),
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

      if (aiCallCount === 2) {
        return new Response(
          JSON.stringify({
            model: 'gpt-4.1-mini',
            choices: [{ message: { role: 'assistant', content: 'Summary\n- Session configured.' } }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }

      if (aiCallCount === 3) {
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
                      id: 'call_http_followup',
                      type: 'function',
                      function: {
                        name: 'http_request',
                        arguments: JSON.stringify({
                          session: 'sticky',
                          path: '/healthz',
                        }),
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

      const toolMessage = findLastToolMessage(bodyObj.messages);
      const toolPayload = JSON.parse(String(toolMessage?.content ?? '{}')) as {
        ok?: boolean;
        status?: number;
      };
      expect(toolPayload.ok).toBe(true);
      expect(toolPayload.status).toBe(200);

      return new Response(
        JSON.stringify({
          model: 'gpt-4.1-mini',
          choices: [{ message: { role: 'assistant', content: 'Summary\n- Follow-up request succeeded.' } }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cipherscope-agent-ai-'));
    const dbPath = path.join(tmpDir, 'agent.db');
    const { app, close } = await buildApp({
      dbPath,
      agentName: 'cipherscope-agent',
      agentVersion: '0.0.0-test',
      proxyHost: '127.0.0.1',
      proxyPort: 0,
    });

    const firstRes = await app.inject({
      method: 'POST',
      url: '/ai/chat',
      payload: {
        mode: 'smart_contract_audit',
        maxSteps: 3,
        messages: [{ role: 'user', content: 'Set a sticky repeater session.' }],
      },
    });
    expect(firstRes.statusCode).toBe(200);
    const firstJson = firstRes.json();
    expect(firstJson.ok).toBe(true);
    expect(firstJson.toolCalls[0].name).toBe('repeater_request');
    expect(firstJson.toolCalls[0].ok).toBe(true);

    const secondRes = await app.inject({
      method: 'POST',
      url: '/ai/chat',
      payload: {
        mode: 'smart_contract_audit',
        maxSteps: 3,
        messages: [{ role: 'user', content: 'Now send the follow-up using the same session.' }],
      },
    });
    expect(secondRes.statusCode).toBe(200);
    const secondJson = secondRes.json();
    expect(secondJson.ok).toBe(true);
    expect(secondJson.toolCalls[0].name).toBe('http_request');
    expect(secondJson.toolCalls[0].ok).toBe(true);

    expect(seenMethod).toBe('POST');
    expect(seenPath).toBe('/healthz');
    expect(seenRepeatHeader).toBe('yes');
    expect(seenBody).toBe('{"first":true}');

    await close();
    upstream.close();
  });
});
