import { AgentClient } from '@cipherscope/sdk';

const agentHttpUrl = process.env.AGENT_HTTP_URL ?? 'http://127.0.0.1:17400';

export async function GET(request: Request): Promise<Response> {
  const client = new AgentClient({ httpBaseUrl: agentHttpUrl });
  try {
    const url = new URL(request.url);
    const rawHide404 = url.searchParams.get('hide404');
    const hide404 = rawHide404 === '1' || rawHide404 === 'true';
    const data = await client.getSitemap({ hide404 });
    return Response.json(data, { headers: { 'cache-control': 'no-store' } });
  } catch {
    return Response.json(
      { ok: false, error: { code: 'agent_unreachable', message: 'Agent is unreachable.' } },
      { status: 502, headers: { 'cache-control': 'no-store' } },
    );
  }
}
