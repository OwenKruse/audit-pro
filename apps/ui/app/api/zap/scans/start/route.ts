const agentHttpUrl = process.env.AGENT_HTTP_URL ?? 'http://127.0.0.1:17400';

export async function POST(req: Request): Promise<Response> {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return Response.json(
      { ok: false, error: { code: 'bad_request', message: 'Body must be a JSON object.' } },
      { status: 400, headers: { 'cache-control': 'no-store' } },
    );
  }

  const upstream = await fetch(`${agentHttpUrl.replace(/\/$/, '')}/zap/scans/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
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
