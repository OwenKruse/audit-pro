import { AgentClient } from '@cipherscope/sdk';
import { revalidatePath } from 'next/cache';
import Link from 'next/link';

const agentHttpUrl = process.env.AGENT_HTTP_URL ?? 'http://127.0.0.1:17400';
const btnClass =
  'inline-flex h-7 items-center rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 text-[11px] font-medium text-[color:var(--cs-fg)] transition-colors hover:bg-[color:var(--cs-hover)] disabled:opacity-50';

async function setIntercept(enabled: boolean) {
  'use server';
  const client = new AgentClient({ httpBaseUrl: agentHttpUrl });
  await client.setIntercept(enabled);
  revalidatePath('/settings');
  revalidatePath('/proxy');
}

function parseIgnoreHostsInput(raw: string): string[] {
  return raw
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

async function saveIgnoreHosts(formData: FormData) {
  'use server';
  const raw = String(formData.get('ignoreHosts') ?? '');
  const hosts = parseIgnoreHostsInput(raw);
  const client = new AgentClient({ httpBaseUrl: agentHttpUrl });
  await client.setProxyIgnoreHosts(hosts);
  revalidatePath('/settings');
  revalidatePath('/proxy');
  revalidatePath('/history');
}

export async function ProxySettingsCard() {
  const client = new AgentClient({ httpBaseUrl: agentHttpUrl });
  const status = await client.proxyStatus().catch(() => null);
  const proxy = status?.ok ? status.proxy : null;
  const interceptEnabled = status?.interceptEnabled ?? false;
  const interceptQueueSize = status?.interceptQueueSize ?? 0;
  const ignoreHosts = status?.ignoreHosts ?? [];
  const agentBaseUrl = agentHttpUrl.replace(/\/$/, '');

  return (
    <div className="border-b border-[color:var(--cs-border)]">
      <div className="flex items-center justify-between border-b border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-3 py-1.5">
        <span className="text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">
          Proxy & Certificates
        </span>
        <Link
          href="/proxy"
          className="text-[10px] font-bold uppercase text-[color:var(--cs-accent)] hover:underline"
        >
          Open Proxy Console
        </Link>
      </div>
      <div className="space-y-2 px-3 py-2">
        {proxy ? (
          <>
            <div className="text-[11px] text-[color:var(--cs-muted)]">
              Listener:{' '}
              <span className="font-mono text-[color:var(--cs-fg)]">
                {proxy.host}:{proxy.port}
              </span>
            </div>
            <div className="text-[11px] text-[color:var(--cs-muted)]">
              Intercept:{' '}
              <span className="font-mono text-[color:var(--cs-fg)]">
                {interceptEnabled ? 'enabled' : 'disabled'}
              </span>{' '}
              · Queue:{' '}
              <span className="font-mono text-[color:var(--cs-fg)]">{interceptQueueSize}</span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <form action={setIntercept.bind(null, true)}>
                <button
                  type="submit"
                  className={btnClass}
                  disabled={interceptEnabled}
                  title="Enable intercept queueing"
                >
                  Enable Intercept
                </button>
              </form>
              <form action={setIntercept.bind(null, false)}>
                <button
                  type="submit"
                  className={btnClass}
                  disabled={!interceptEnabled}
                  title="Disable intercept queueing"
                >
                  Disable Intercept
                </button>
              </form>
              <a className={btnClass} href={`${agentBaseUrl}/tls/ca.der`}>
                Download CA (DER)
              </a>
              <a className={btnClass} href={`${agentBaseUrl}/tls/ca.pem`}>
                Download CA (PEM)
              </a>
            </div>
            <p className="text-[11px] text-[color:var(--cs-muted)]">
              Configure your browser/system proxy to use{' '}
              <span className="font-mono">127.0.0.1:{proxy.port}</span> for HTTP + HTTPS. Install the
              CA certificate to decrypt HTTPS and wss:// traffic.
            </p>
            <form action={saveIgnoreHosts} className="space-y-1">
              <label className="text-[11px] font-semibold text-[color:var(--cs-fg)]">
                Ignore hosts (not captured in History/Sitemap)
              </label>
              <textarea
                name="ignoreHosts"
                defaultValue={ignoreHosts.join('\n')}
                placeholder={`example.com\napi.example.com`}
                rows={4}
                className="w-full rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 py-1.5 font-mono text-[11px] text-[color:var(--cs-fg)] outline-none focus:border-[color:var(--cs-accent)]"
              />
              <div className="flex flex-wrap items-center gap-2">
                <button type="submit" className={btnClass} title="Save ignore host list">
                  Save Ignore List
                </button>
                <span className="text-[10px] text-[color:var(--cs-muted)]">
                  One host per line (or comma-separated), case-insensitive.
                </span>
              </div>
            </form>
          </>
        ) : (
          <div className="text-[11px] text-[color:var(--cs-muted)]">
            Agent offline at <span className="font-mono">{agentBaseUrl}</span>. Start the agent to
            manage proxy settings or download certificates.
          </div>
        )}
      </div>
    </div>
  );
}
