const agentHttpUrl = process.env.AGENT_HTTP_URL ?? 'http://127.0.0.1:17400';

export async function POST(req: Request): Promise<Response> {
  let upstream: Response;
  try {
    upstream = await fetch(`${agentHttpUrl.replace(/\/$/, '')}/subfinder/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: await req.text(),
      cache: 'no-store',
    });
  } catch (err) {
    return Response.json(
      {
        ok: false,
        error: {
          code: 'agent_unreachable',
          message: err instanceof Error ? err.message : `Agent is unreachable at ${agentHttpUrl}.`,
        },
      },
      { status: 502, headers: { 'cache-control': 'no-store' } },
    );
  }

  const text = await upstream.text();
  const contentType = upstream.headers.get('content-type') ?? 'application/json; charset=utf-8';
  return new Response(text, {
    status: upstream.status,
    headers: {
      'cache-control': 'no-store',
      'content-type': contentType,
    },
  });
}
