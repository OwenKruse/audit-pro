export const runtime = 'nodejs';

const agentHttpUrl = process.env.AGENT_HTTP_URL ?? 'http://127.0.0.1:17400';

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const upstreamUrl = `${agentHttpUrl.replace(/\/+$/, '')}/payloads${url.search}`;

  const upstream = await fetch(upstreamUrl, {
    method: 'GET',
    headers: { accept: 'application/json' },
    cache: 'no-store',
  }).catch(() => null);

  if (!upstream) {
    return Response.json(
      {
        ok: false,
        error: {
          code: 'agent_unreachable',
          message: `Agent is unreachable at ${agentHttpUrl}. Start it with "pnpm dev" (repo root) or "pnpm --filter @cipherscope/agent dev".`,
        },
      },
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
