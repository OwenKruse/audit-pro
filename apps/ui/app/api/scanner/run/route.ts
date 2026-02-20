import { ScannerRunRequestSchema } from '@cipherscope/proto';
import { AgentClient } from '@cipherscope/sdk';

const agentHttpUrl = process.env.AGENT_HTTP_URL ?? 'http://127.0.0.1:17400';

export async function POST(req: Request): Promise<Response> {
  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  let parsed: ReturnType<typeof ScannerRunRequestSchema.parse>;
  try {
    parsed = ScannerRunRequestSchema.parse(body);
  } catch (err) {
    return Response.json(
      { ok: false, error: { code: 'bad_request', message: err instanceof Error ? err.message : 'Bad body' } },
      { status: 400, headers: { 'cache-control': 'no-store' } },
    );
  }

  const client = new AgentClient({ httpBaseUrl: agentHttpUrl });
  try {
    const data = await client.runScanner(parsed);
    return Response.json(data, { headers: { 'cache-control': 'no-store' } });
  } catch {
    return Response.json(
      { ok: false, error: { code: 'agent_unreachable', message: 'Agent is unreachable.' } },
      { status: 502, headers: { 'cache-control': 'no-store' } },
    );
  }
}
