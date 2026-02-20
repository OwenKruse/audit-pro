const agentHttpUrl = process.env.AGENT_HTTP_URL ?? 'http://127.0.0.1:17400';

export async function GET(): Promise<Response> {
  let upstream: Response;
  try {
    upstream = await fetch(`${agentHttpUrl.replace(/\/$/, '')}/projects/export`, {
      cache: 'no-store',
    });
  } catch {
    return Response.json(
      { ok: false, error: { code: 'agent_unreachable', message: 'Agent is unreachable.' } },
      { status: 502, headers: { 'cache-control': 'no-store' } },
    );
  }

  if (!upstream.ok || !upstream.body) {
    return Response.json(
      { ok: false, error: { code: 'agent_error', message: 'Agent export failed.' } },
      { status: 502, headers: { 'cache-control': 'no-store' } },
    );
  }

  const headers = new Headers();
  headers.set('cache-control', 'no-store');
  headers.set('content-type', upstream.headers.get('content-type') ?? 'application/zip');
  const disp = upstream.headers.get('content-disposition');
  if (disp) headers.set('content-disposition', disp);
  const len = upstream.headers.get('content-length');
  if (len) headers.set('content-length', len);

  return new Response(upstream.body, { status: upstream.status, headers });
}
