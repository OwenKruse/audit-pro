import { AgentClient } from '@cipherscope/sdk';
import { UpsertContractRequestSchema } from '@cipherscope/proto';

const agentHttpUrl = process.env.AGENT_HTTP_URL ?? 'http://127.0.0.1:17400';

export async function GET(): Promise<Response> {
  const client = new AgentClient({ httpBaseUrl: agentHttpUrl });
  try {
    const data = await client.listContracts();
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

  let parsed: ReturnType<typeof UpsertContractRequestSchema.parse>;
  try {
    parsed = UpsertContractRequestSchema.parse(body);
  } catch (err) {
    return Response.json(
      {
        ok: false,
        error: { code: 'bad_request', message: err instanceof Error ? err.message : 'Bad body' },
      },
      { status: 400, headers: { 'cache-control': 'no-store' } },
    );
  }

  const client = new AgentClient({ httpBaseUrl: agentHttpUrl });
  try {
    const data = await client.upsertContract(parsed);
    return Response.json(data, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    return Response.json(
      {
        ok: false,
        error: { code: 'agent_error', message: err instanceof Error ? err.message : 'Failed to save contract.' },
      },
      { status: 502, headers: { 'cache-control': 'no-store' } },
    );
  }
}
