import { AiChatRequestSchema } from '@cipherscope/proto';
import { fetch as undiciFetch, Agent } from 'undici';

const agentHttpUrl = process.env.AGENT_HTTP_URL ?? 'http://127.0.0.1:17400';
const RETRY_MAX_ATTEMPTS = 8;
const RETRY_BASE_DELAY_MS = 750;
const RETRY_MAX_DELAY_MS = 8000;

// Reusable agent with no timeouts for long-running streams
const streamDispatcher = new Agent({
  bodyTimeout: 0,
  headersTimeout: 0,
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json(
      { ok: false, error: { code: 'bad_request', message: 'Invalid JSON body.' } },
      { status: 400 },
    );
  }

  let parsed: ReturnType<typeof AiChatRequestSchema.parse>;
  try {
    parsed = AiChatRequestSchema.parse(body);
  } catch (err) {
    return Response.json(
      { ok: false, error: { code: 'bad_request', message: err instanceof Error ? err.message : 'Bad body' } },
      { status: 400 },
    );
  }

  let upstream: Response | null = null;
  for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt += 1) {
    const _res = await undiciFetch(`${agentHttpUrl.replace(/\/$/, '')}/ai/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(parsed),
      dispatcher: streamDispatcher,
    }).catch(console.error);
    upstream = _res ? (_res as unknown as Response) : null;
    
    if (upstream) break;
    if (attempt >= RETRY_MAX_ATTEMPTS) break;
    const delayMs = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
    await sleep(delayMs);
  }

  if (!upstream) {
    const hint = `Agent is unreachable at ${agentHttpUrl}. Start it with "pnpm dev" (repo root) or "pnpm --filter @cipherscope/agent dev".`;
    return Response.json(
      { ok: false, error: { code: 'agent_unreachable', message: hint } },
      { status: 502, headers: { 'cache-control': 'no-store' } },
    );
  }

  if (!upstream.body) {
    const text = await upstream.text().catch(() => '');
    return new Response(text || JSON.stringify({ ok: false, error: { code: 'bad_upstream_response', message: 'Agent stream returned an empty body.' } }), {
      status: upstream.status || 502,
      headers: {
        'content-type': upstream.headers.get('content-type') ?? 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      },
    });
  }

  const headers = new Headers();
  headers.set('content-type', upstream.headers.get('content-type') ?? 'text/event-stream; charset=utf-8');
  headers.set('cache-control', 'no-store, no-transform');
  headers.set('x-accel-buffering', 'no');
  headers.set('x-vercel-buffering', 'no');
  headers.set('x-no-compression', '1');
  headers.set('content-encoding', 'none');
  headers.set('connection', 'keep-alive');

  const stream = new ReadableStream({
    async start(controller) {
      if (!upstream!.body) {
        controller.close();
        return;
      }
      
      const reader = (upstream!.body as any).getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }
      } catch (err) {
        console.error('Stream read error:', err);
        controller.error(err);
      } finally {
        controller.close();
      }
    }
  });

  return new Response(stream, {
    status: upstream.status,
    headers,
  });
}
