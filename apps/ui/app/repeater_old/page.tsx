import Link from 'next/link';
import { AgentClient } from '@cipherscope/sdk';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

const agentHttpUrl = process.env.AGENT_HTTP_URL ?? 'http://127.0.0.1:17400';

export default async function RepeaterPage() {
  const client = new AgentClient({ httpBaseUrl: agentHttpUrl });
  const data = await client.listMessages({ limit: 50, offset: 0 }).catch(() => null);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-end justify-between gap-4">
        <div className="flex flex-col">
          <h1 className="text-2xl font-semibold tracking-tight">Repeater</h1>
          <div className="mt-1 text-sm text-[color:var(--cs-muted)]">
            Pick a captured message to edit and replay.
          </div>
        </div>
      </div>

      {data ? (
        data.items.length ? (
          <div className="rounded-xl border border-border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-[10px] uppercase tracking-widest text-muted-foreground">
                    Time
                  </TableHead>
                  <TableHead className="text-[10px] uppercase tracking-widest text-muted-foreground">
                    Method
                  </TableHead>
                  <TableHead className="text-[10px] uppercase tracking-widest text-muted-foreground">
                    Host
                  </TableHead>
                  <TableHead className="text-[10px] uppercase tracking-widest text-muted-foreground">
                    Path
                  </TableHead>
                  <TableHead className="text-[10px] uppercase tracking-widest text-muted-foreground">
                    Status
                  </TableHead>
                  <TableHead className="text-[10px] uppercase tracking-widest text-muted-foreground">
                    Actions
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((m) => (
                  <TableRow key={m.id}>
                    <TableCell className="font-mono text-[11px] text-muted-foreground">
                      {new Date(m.createdAt).toLocaleTimeString()}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{m.method}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {m.host}:{m.port}
                    </TableCell>
                    <TableCell className="max-w-[240px]">
                      <Link
                        href={`/repeater/${m.id}`}
                        className="block truncate font-mono text-xs text-foreground underline decoration-black/20 underline-offset-4 hover:decoration-black/60 dark:decoration-white/20 dark:hover:decoration-white/60"
                        title={m.path}
                      >
                        {m.path.length > 60 ? `${m.path.slice(0, 60)}…` : m.path}
                      </Link>
                      {m.parentId ? (
                        <div className="mt-1 font-mono text-[10px] text-muted-foreground">
                          variant of {m.parentId.slice(0, 8)}…
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {m.responseStatus == null ? '-' : m.responseStatus}
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-2">
                        <Link
                          href={`/repeater/${m.id}`}
                          className="rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground"
                        >
                          Open
                        </Link>
                        <Link
                          href={`/history/${m.id}`}
                          className="rounded-lg border border-border bg-muted px-3 py-2 text-xs font-medium text-muted-foreground"
                        >
                          History
                        </Link>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <div className="rounded-xl border border-[color:var(--cs-border)] bg-white/40 p-4 text-sm text-[color:var(--cs-muted)] dark:bg-black/30">
            No messages yet. Capture traffic in <Link className="underline" href="/proxy">Proxy</Link> then come back.
          </div>
        )
      ) : (
        <div className="rounded-xl border border-[color:var(--cs-border)] bg-white/40 p-4 text-sm text-[color:var(--cs-muted)] dark:bg-black/30">
          Unable to load messages. Ensure the agent is running.
        </div>
      )}

      <section className="rounded-xl border border-[color:var(--cs-border)] bg-white/40 p-4 dark:bg-black/30">
        <div className="text-xs uppercase tracking-widest text-[color:var(--cs-muted)]">Notes</div>
        <ul className="mt-2 list-disc pl-5 text-sm text-[color:var(--cs-muted)]">
          <li>Replay variants are stored as new History rows with a parent id.</li>
          <li>Batch replay exists at <span className="font-mono">POST /replay/batch</span> (UI TODO).</li>
        </ul>
      </section>
    </div>
  );
}

