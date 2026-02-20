const agentHttpUrl = process.env.AGENT_HTTP_URL ?? 'http://127.0.0.1:17400';

export async function DELETE(): Promise<Response> {
  const base = agentHttpUrl.replace(/\/$/, '');
  const res = await fetch(`${base}/messages/clear`, { method: 'DELETE', cache: 'no-store' }).catch(
    () => null,
  );
  if (!res) {
    return Response.json(
      { ok: false, error: { code: 'agent_unreachable', message: 'Agent is unreachable.' } },
      { status: 502, headers: { 'cache-control': 'no-store' } },
    );
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    return Response.json(data ?? { ok: false }, {
      status: res.status,
      headers: { 'cache-control': 'no-store' },
    });
  }
  return Response.json(data ?? { ok: true }, { headers: { 'cache-control': 'no-store' } });
}
