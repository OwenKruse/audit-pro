import { AiChatRequestSchema } from '@cipherscope/proto';
import { fetch as undiciFetch, Agent } from 'undici';

const agentHttpUrl = process.env.AGENT_HTTP_URL ?? 'http://127.0.0.1:17400';
const RETRY_MAX_ATTEMPTS = 8;
const RETRY_BASE_DELAY_MS = 750;
const RETRY_MAX_DELAY_MS = 8000;

// Reusable agent with no timeouts for long-running AI requests
const aiDispatcher = new Agent({
  bodyTimeout: 0,
  headersTimeout: 0, // AI requests could take a long time to get the first byte too if it's doing heavy thinking
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
    const _res = await undiciFetch(`${agentHttpUrl.replace(/\/$/, '')}/ai/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(parsed),
      dispatcher: aiDispatcher,
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

  const text = await upstream.text();
  const contentType = upstream.headers.get('content-type') ?? 'application/json; charset=utf-8';
  return new Response(text, {
    status: upstream.status,
    headers: { 'content-type': contentType, 'cache-control': 'no-store' },
  });
}
