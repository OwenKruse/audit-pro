import { AgentClient } from '@cipherscope/sdk';

const agentHttpUrl = process.env.AGENT_HTTP_URL ?? 'http://127.0.0.1:17400';

export async function GET(
  req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  if (!id) {
    return Response.json(
      { ok: false, error: { code: 'bad_request', message: 'Missing id.' } },
      { status: 400, headers: { 'cache-control': 'no-store' } },
    );
  }

  const { searchParams } = new URL(req.url);
  const limit = Math.min(
    1000,
    Math.max(1, parseInt(searchParams.get('limit') ?? '500', 10) || 500),
  );
  const offset = Math.max(0, parseInt(searchParams.get('offset') ?? '0', 10) || 0);

  const client = new AgentClient({ httpBaseUrl: agentHttpUrl });
  try {
    const data = await client.listWsFrames(id, { limit, offset });
    return Response.json(data, { headers: { 'cache-control': 'no-store' } });
  } catch {
    return Response.json(
      { ok: false, error: { code: 'agent_unreachable', message: 'Agent is unreachable.' } },
      { status: 502, headers: { 'cache-control': 'no-store' } },
    );
  }
}
