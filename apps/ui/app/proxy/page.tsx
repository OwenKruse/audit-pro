import { AgentClient } from '@cipherscope/sdk';
import { revalidatePath } from 'next/cache';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { SmokeTestButton } from './_components/SmokeTestButton';

const agentHttpUrl = process.env.AGENT_HTTP_URL ?? 'http://127.0.0.1:17400';

async function setIntercept(enabled: boolean) {
  'use server';
  const client = new AgentClient({ httpBaseUrl: agentHttpUrl });
  await client.setIntercept(enabled);
  revalidatePath('/proxy');
}

async function forwardIntercept(id: string) {
  'use server';
  const client = new AgentClient({ httpBaseUrl: agentHttpUrl });
  await client.forwardIntercept(id);
  revalidatePath('/proxy');
  revalidatePath('/history');
}

async function dropIntercept(id: string) {
  'use server';
  const client = new AgentClient({ httpBaseUrl: agentHttpUrl });
  await client.dropIntercept(id);
  revalidatePath('/proxy');
  revalidatePath('/history');
}

export default async function ProxyPage() {
  const client = new AgentClient({ httpBaseUrl: agentHttpUrl });
  const status = await client.proxyStatus().catch((err) => ({ ok: false as const, err }));
  const queue = await client.listInterceptQueue().catch(() => ({ ok: false as const }));
  const proxy = 'ok' in status && status.ok ? status.proxy : null;
  const latest =
    proxy
      ? await client.listMessages({ limit: 1, offset: 0 }).catch(() => null)
      : null;
  const agentBaseUrl = agentHttpUrl.replace(/\/$/, '');
  const proxyPort = proxy?.port ?? null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-end justify-between gap-4">
        <div className="flex flex-col">
          <h1 className="text-2xl font-semibold tracking-tight">Proxy</h1>
          <div className="mt-1 text-sm text-muted-foreground">
            Configure your browser/system proxy to use the local listener below. Installing the CA
            is only required to decrypt HTTPS and wss:// traffic.
          </div>
        </div>
      </div>

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Proxy Listener</CardTitle>
            <CardDescription>Use this address for your browser/system proxy settings.</CardDescription>
          </CardHeader>
          <CardContent>
            {proxy ? (
              <div className="flex flex-col gap-2">
                <div className="font-mono text-sm">
                  {proxy.host}:{proxy.port}
                </div>
                <div className="text-xs text-muted-foreground">
                  macOS: set both Web Proxy (HTTP) and Secure Web Proxy (HTTPS) to{' '}
                  <span className="font-mono">127.0.0.1:{proxy.port}</span>
                </div>
                <div className="text-xs text-muted-foreground">
                  Agent API (do not set as proxy): <span className="font-mono">{agentBaseUrl}</span>
                </div>
                <div className="text-xs text-muted-foreground">
                  Latest capture:{' '}
                  <span className="font-mono">
                    {latest?.ok && latest.items[0]?.createdAt
                      ? new Date(latest.items[0].createdAt).toLocaleString()
                      : '—'}
                  </span>
                </div>
              </div>
            ) : (
              <div className="text-sm text-muted-foreground">
                Agent offline: <span className="font-mono">{agentBaseUrl}</span>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Intercept</CardTitle>
            <CardDescription>Queue requests for manual forward/drop.</CardDescription>
          </CardHeader>
          <CardContent>
            {'ok' in status && status.ok ? (
              <div className="flex flex-col gap-3">
                <div className="text-sm">
                  <span className="font-medium">Status:</span>{' '}
                  <span className="font-mono text-xs text-muted-foreground">
                    {status.interceptEnabled ? 'enabled' : 'disabled'}
                  </span>
                </div>
                <div className="flex gap-2">
                  <form action={setIntercept.bind(null, true)}>
                    <Button type="submit" disabled={status.interceptEnabled}>
                      Enable
                    </Button>
                  </form>
                  <form action={setIntercept.bind(null, false)}>
                    <Button type="submit" variant="outline" disabled={!status.interceptEnabled}>
                      Disable
                    </Button>
                  </form>
                </div>
                <div className="text-xs text-muted-foreground">
                  Queue size: <span className="font-mono">{status.interceptQueueSize}</span>
                </div>
              </div>
            ) : (
              <div className="text-sm text-muted-foreground">Waiting for agent…</div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>TLS MITM (HTTPS + wss://)</CardTitle>
            <CardDescription>
              Install the local CA to decrypt HTTPS and wss:// (WebSocket) traffic.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col gap-3 text-sm">
              <div className="flex flex-wrap gap-2">
                <Button asChild variant="secondary">
                  <a href={`${agentBaseUrl}/tls/ca.der`}>Download CA (DER)</a>
                </Button>
                <Button asChild variant="outline">
                  <a href={`${agentBaseUrl}/tls/ca.pem`}>Download CA (PEM)</a>
                </Button>
              </div>

              <div className="text-xs text-muted-foreground">
                macOS: open <span className="font-mono">ca.der</span> in Keychain Access and set
                Trust to “Always Trust”. Restart the browser after installing.
              </div>

              <div className="text-xs text-muted-foreground">
                Firefox: Settings → Privacy &amp; Security → Certificates → View Certificates →
                Authorities → Import (or enable enterprise roots).
              </div>
            </div>
          </CardContent>
        </Card>
      </section>

      <Card>
        <CardHeader>
          <CardTitle>macOS Setup + Troubleshooting</CardTitle>
          <CardDescription>
            If you installed the CA but see no History rows, your browser is not using the proxy.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="space-y-2">
              <div className="text-sm font-medium">1) Set the system proxy</div>
              <div className="text-xs text-muted-foreground">
                System Settings → Network → (your interface) → Details → Proxies:
                enable Web Proxy (HTTP) and Secure Web Proxy (HTTPS) to{' '}
                <span className="font-mono">127.0.0.1:{proxyPort ?? 'PORT'}</span>.
              </div>
              <pre className="overflow-auto rounded-lg bg-muted p-3 font-mono text-xs leading-relaxed">
                {`# Optional: via Terminal (service name may be "Wi-Fi")\nnetworksetup -setwebproxy \"Wi-Fi\" 127.0.0.1 ${proxyPort ?? '18080'}\nnetworksetup -setsecurewebproxy \"Wi-Fi\" 127.0.0.1 ${proxyPort ?? '18080'}\nnetworksetup -setwebproxystate \"Wi-Fi\" on\nnetworksetup -setsecurewebproxystate \"Wi-Fi\" on\n\n# Check current proxy state\nscutil --proxy`}
              </pre>
              <div className="text-xs text-muted-foreground">
                To disable later:{' '}
                <span className="font-mono">
                  {`networksetup -setwebproxystate "Wi-Fi" off`}
                </span>{' '}
                and{' '}
                <span className="font-mono">
                  {`networksetup -setsecurewebproxystate "Wi-Fi" off`}
                </span>
                .
              </div>
            </div>
            <div className="space-y-2">
              <div className="text-sm font-medium">2) Confirm CipherScope is capturing</div>
              <SmokeTestButton />
              <div className="text-xs text-muted-foreground">
                After setting the system proxy, browse any site and then open{' '}
                <Button asChild variant="link" className="h-auto p-0 text-xs">
                  <Link href="/history">History</Link>
                </Button>
                .
              </div>
              <div className="text-xs text-muted-foreground">
                If intercept is enabled, your browser will stall until you Forward/Drop items in
                the queue.
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Intercept Queue</CardTitle>
          <CardDescription>Forward or drop requests while intercept is enabled.</CardDescription>
        </CardHeader>
        <CardContent>
          {'ok' in queue && queue.ok ? (
            queue.items.length ? (
              <div className="rounded-lg border border-border bg-card">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-[10px] uppercase tracking-widest text-muted-foreground">
                        Method
                      </TableHead>
                      <TableHead className="text-[10px] uppercase tracking-widest text-muted-foreground">
                        Target
                      </TableHead>
                      <TableHead className="text-[10px] uppercase tracking-widest text-muted-foreground">
                        Path
                      </TableHead>
                      <TableHead className="text-[10px] uppercase tracking-widest text-muted-foreground">
                        Actions
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {queue.items.map((q) => (
                      <TableRow key={q.id}>
                        <TableCell className="font-mono text-xs">{q.method}</TableCell>
                        <TableCell className="font-mono text-xs">
                          {q.host}:{q.port}
                        </TableCell>
                        <TableCell className="font-mono text-xs">{q.path}</TableCell>
                        <TableCell>
                          <div className="flex gap-2">
                            <form action={forwardIntercept.bind(null, q.id)}>
                              <Button type="submit" size="sm">
                                Forward
                              </Button>
                            </form>
                            <form action={dropIntercept.bind(null, q.id)}>
                              <Button type="submit" size="sm" variant="destructive">
                                Drop
                              </Button>
                            </form>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <div className="text-sm text-muted-foreground">Queue is empty.</div>
            )
          ) : (
            <div className="text-sm text-muted-foreground">
              Unable to load queue. Ensure the agent is running.
            </div>
          )}
        </CardContent>
      </Card>

      <Todo
        title="Completion Specs (Milestone A: Proxy + History)"
        items={[
          'Intercept on/off works against an HTTPS target and history is populated.',
          'WebSockets are visible (ws:// and wss:// frames captured via MITM).',
        ]}
        acceptance={[
          'Repro: visit a dapp in a browser configured to use the proxy; see HTTP entries in History.',
          'Repro: open a WebSocket (ws:// or wss://) and observe frames captured in SQLite.',
        ]}
      />
    </div>
  );
}

function Todo(props: { title: string; items: string[]; acceptance: string[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{props.title}</CardTitle>
        <CardDescription>Engineering checklist for Milestone A.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="text-xs font-semibold text-muted-foreground">TODO</div>
        <ul className="list-disc pl-5 text-sm text-muted-foreground">
          {props.items.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
        <div className="text-xs font-semibold text-muted-foreground">Completion Specs</div>
        <ul className="list-disc pl-5 text-sm text-muted-foreground">
          {props.acceptance.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
