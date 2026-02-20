import { CreateFindingRequestSchema } from '@cipherscope/proto';
import { AgentClient } from '@cipherscope/sdk';

const agentHttpUrl = process.env.AGENT_HTTP_URL ?? 'http://127.0.0.1:17400';

export async function GET(req: Request): Promise<Response> {
  const { searchParams } = new URL(req.url);
  const limit = Math.min(
    2000,
    Math.max(1, parseInt(searchParams.get('limit') ?? '200', 10) || 200),
  );
  const offset = Math.max(0, parseInt(searchParams.get('offset') ?? '0', 10) || 0);

  const client = new AgentClient({ httpBaseUrl: agentHttpUrl });
  try {
    const data = await client.listFindings({ limit, offset });
    return Response.json(data, { headers: { 'cache-control': 'no-store' } });
  } catch {
    return Response.json(
      { ok: false, error: { code: 'agent_unreachable', message: 'Agent is unreachable.' } },
      { status: 502, headers: { 'cache-control': 'no-store' } },
    );
  }
}

export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json(
      { ok: false, error: { code: 'bad_request', message: 'Invalid JSON body.' } },
      { status: 400, headers: { 'cache-control': 'no-store' } },
    );
  }

  let parsed: ReturnType<typeof CreateFindingRequestSchema.parse>;
  try {
    parsed = CreateFindingRequestSchema.parse(body);
  } catch (err) {
    return Response.json(
      {
        ok: false,
        error: { code: 'bad_request', message: err instanceof Error ? err.message : 'Bad body' },
      },
      { status: 400, headers: { 'cache-control': 'no-store' } },
    );
  }

  const upstream = await fetch(`${agentHttpUrl.replace(/\/$/, '')}/findings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(parsed),
    cache: 'no-store',
  }).catch(() => null);

  if (!upstream) {
    return Response.json(
      { ok: false, error: { code: 'agent_unreachable', message: 'Agent is unreachable.' } },
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
