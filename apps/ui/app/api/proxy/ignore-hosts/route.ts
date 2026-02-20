import { AgentClient } from '@cipherscope/sdk';
import { NextResponse } from 'next/server';

const agentHttpUrl = process.env.AGENT_HTTP_URL ?? 'http://127.0.0.1:17400';

export async function POST(req: Request): Promise<NextResponse> {
  let body: { addHost?: string; hosts?: string[] };
  try {
    body = (await req.json()) as { addHost?: string; hosts?: string[] };
  } catch {
    return NextResponse.json(
      { ok: false, error: { code: 'bad_request', message: 'Invalid JSON body.' } },
      { status: 400 },
    );
  }

  const client = new AgentClient({ httpBaseUrl: agentHttpUrl });

  try {
    if (body.addHost != null && typeof body.addHost === 'string') {
      const current = await client.proxyIgnoreHosts();
      const host = body.addHost.trim().toLowerCase();
      if (!host) {
        return NextResponse.json(
          { ok: false, error: { code: 'bad_request', message: 'addHost must be non-empty.' } },
          { status: 400 },
        );
      }
      const next = current.hosts.includes(host) ? current.hosts : [...current.hosts, host].sort();
      const result = await client.setProxyIgnoreHosts(next);
      return NextResponse.json(result, { headers: { 'cache-control': 'no-store' } });
    }

    if (Array.isArray(body.hosts)) {
      const result = await client.setProxyIgnoreHosts(body.hosts);
      return NextResponse.json(result, { headers: { 'cache-control': 'no-store' } });
    }

    return NextResponse.json(
      { ok: false, error: { code: 'bad_request', message: 'Body must include addHost (string) or hosts (string[]).' } },
      { status: 400 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to update ignore list.';
    return NextResponse.json(
      { ok: false, error: { code: 'server_error', message } },
      { status: 500 },
    );
  }
}
