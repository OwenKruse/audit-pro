const agentHttpUrl = process.env.AGENT_HTTP_URL ?? 'http://127.0.0.1:17400';

async function proxy(method: 'GET' | 'POST' | 'DELETE', req?: Request): Promise<Response> {
  const url = `${agentHttpUrl}/evm/config`;
  const init: RequestInit = { method, cache: 'no-store' };

  if (method === 'POST') {
    init.headers = { 'content-type': 'application/json' };
    init.body = req ? await req.text() : '{}';
  }

  let upstream: Response;
  try {
    upstream = await fetch(url, init);
  } catch (err) {
    return Response.json(
      {
        ok: false,
        error: {
          code: 'agent_unreachable',
          message:
            err instanceof Error
              ? err.message
              : `Agent is unreachable at ${agentHttpUrl}.`,
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

export async function GET(): Promise<Response> {
  return proxy('GET');
}

export async function POST(req: Request): Promise<Response> {
  return proxy('POST', req);
}

export async function DELETE(): Promise<Response> {
  return proxy('DELETE');
}
