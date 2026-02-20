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
      { status: 400, headers: { 'cache-control': 'no-store' } },
    );
  }

  const client = new AgentClient({ httpBaseUrl: agentHttpUrl });
  try {
    const data = await client.getContract(id);
    return Response.json(data, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load contract.';
    const missing = message.includes('404');
    return Response.json(
      { ok: false, error: { code: missing ? 'not_found' : 'agent_unreachable', message } },
      { status: missing ? 404 : 502, headers: { 'cache-control': 'no-store' } },
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
      { status: 400, headers: { 'cache-control': 'no-store' } },
    );
  }

  const client = new AgentClient({ httpBaseUrl: agentHttpUrl });
  try {
    const data = await client.deleteContract(id);
    return Response.json(data, { headers: { 'cache-control': 'no-store' } });
  } catch {
    return Response.json(
      { ok: false, error: { code: 'agent_unreachable', message: 'Agent is unreachable.' } },
      { status: 502, headers: { 'cache-control': 'no-store' } },
    );
  }
}
