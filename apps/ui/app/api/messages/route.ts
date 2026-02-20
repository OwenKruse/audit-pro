import { AgentClient } from '@cipherscope/sdk';

const agentHttpUrl = process.env.AGENT_HTTP_URL ?? 'http://127.0.0.1:17400';

export async function GET(req: Request): Promise<Response> {
  const { searchParams } = new URL(req.url);
  const limit = Math.min(
    1000,
    Math.max(1, parseInt(searchParams.get('limit') ?? '500', 10) || 500),
  );
  const offset = Math.max(0, parseInt(searchParams.get('offset') ?? '0', 10) || 0);

  const search = searchParams.get('search') ?? undefined;
  const source = searchParams.get('source') ?? undefined;
  const method = searchParams.get('method') ?? undefined;
  const scheme = searchParams.get('scheme') ?? undefined;
  const status = searchParams.get('status') ?? undefined;

  const client = new AgentClient({ httpBaseUrl: agentHttpUrl });
  try {
    const data = await client.listMessages({
      limit,
      offset,
      ...(search !== undefined && search !== '' && { search }),
      ...(source !== undefined && source !== '' && { source }),
      ...(method !== undefined && method !== '' && { method }),
      ...(scheme !== undefined && scheme !== '' && { scheme }),
      ...(status !== undefined && status !== '' && { status }),
    });
    return Response.json(data, { headers: { 'cache-control': 'no-store' } });
  } catch {
    return Response.json(
      { ok: false, error: { code: 'agent_unreachable', message: 'Agent is unreachable.' } },
      { status: 502, headers: { 'cache-control': 'no-store' } },
    );
  }
}
