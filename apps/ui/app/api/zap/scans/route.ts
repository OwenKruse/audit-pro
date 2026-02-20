const agentHttpUrl = process.env.AGENT_HTTP_URL ?? 'http://127.0.0.1:17400';

export async function GET(req: Request): Promise<Response> {
  const incomingUrl = new URL(req.url);
  const target = new URL(`${agentHttpUrl.replace(/\/$/, '')}/zap/scans`);

  const limitRaw = Number.parseInt(incomingUrl.searchParams.get('limit') ?? '25', 10);
  const offsetRaw = Number.parseInt(incomingUrl.searchParams.get('offset') ?? '0', 10);
  const statusRaw = incomingUrl.searchParams.get('status');

  const limit = Number.isFinite(limitRaw) ? Math.min(200, Math.max(1, limitRaw)) : 25;
  const offset = Number.isFinite(offsetRaw) ? Math.max(0, offsetRaw) : 0;

  target.searchParams.set('limit', String(limit));
  target.searchParams.set('offset', String(offset));
  if (statusRaw) target.searchParams.set('status', statusRaw);

  const upstream = await fetch(target.toString(), { cache: 'no-store' }).catch(() => null);
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
