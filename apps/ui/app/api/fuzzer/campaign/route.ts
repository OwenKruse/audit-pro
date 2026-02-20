import { FuzzCampaignRequestSchema } from '@cipherscope/proto';

const agentHttpUrl = process.env.AGENT_HTTP_URL ?? 'http://127.0.0.1:17400';

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

  let parsed: ReturnType<typeof FuzzCampaignRequestSchema.parse>;
  try {
    parsed = FuzzCampaignRequestSchema.parse(body);
  } catch (err) {
    return Response.json(
      {
        ok: false,
        error: { code: 'bad_request', message: err instanceof Error ? err.message : 'Bad body' },
      },
      { status: 400 },
    );
  }

  const upstream = await fetch(`${agentHttpUrl.replace(/\/$/, '')}/fuzzer/campaign`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(parsed),
    cache: 'no-store',
  }).catch(() => null);

  if (!upstream) {
    return Response.json(
      { ok: false, error: { code: 'agent_unreachable', message: 'Agent is unreachable.' } },
      { status: 502 },
    );
  }

  const text = await upstream.text();
  const contentType = upstream.headers.get('content-type') ?? 'application/json; charset=utf-8';
  return new Response(text, {
    status: upstream.status,
    headers: { 'content-type': contentType, 'cache-control': 'no-store' },
  });
}
