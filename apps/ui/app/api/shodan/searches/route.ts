export const runtime = 'nodejs';

const agentHttpUrl = process.env.AGENT_HTTP_URL ?? 'http://127.0.0.1:17400';

export async function GET(req: Request): Promise<Response> {
  const { searchParams } = new URL(req.url);
  const limit = Math.min(250, Math.max(1, Number.parseInt(searchParams.get('limit') ?? '50', 10) || 50));
  const offset = Math.max(0, Number.parseInt(searchParams.get('offset') ?? '0', 10) || 0);

  const qs = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  const upstream = await fetch(`${agentHttpUrl.replace(/\/$/, '')}/shodan/searches?${qs.toString()}`, {
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
