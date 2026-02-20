import { AgentClient } from '@cipherscope/sdk';

const agentHttpUrl = process.env.AGENT_HTTP_URL ?? 'http://127.0.0.1:17400';

export async function GET(
  _req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  if (!id) {
    return Response.json(
      { ok: false, error: { code: 'bad_request', message: 'Missing id.' } },
      { status: 400 },
    );
  }

  const client = new AgentClient({ httpBaseUrl: agentHttpUrl });
  try {
    const data = await client.getMessage(id);
    return Response.json(data, { headers: { 'cache-control': 'no-store' } });
  } catch {
    return Response.json(
      { ok: false, error: { code: 'not_found', message: 'Message not found or agent unreachable.' } },
      { status: 404, headers: { 'cache-control': 'no-store' } },
    );
  }
}

export async function DELETE(
  _req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  if (!id) {
    return Response.json(
      { ok: false, error: { code: 'bad_request', message: 'Missing id.' } },
      { status: 400 },
    );
  }

  const upstream = await fetch(`${agentHttpUrl.replace(/\/$/, '')}/messages/${encodeURIComponent(id)}`, {
    method: 'DELETE',
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
