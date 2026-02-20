import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AgentClient } from '@cipherscope/sdk';
import { RepeaterClient } from './RepeaterClient';

const agentHttpUrl = process.env.AGENT_HTTP_URL ?? 'http://127.0.0.1:17400';

export default async function RepeaterMessagePage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const client = new AgentClient({ httpBaseUrl: agentHttpUrl });
  const data = await client.getMessage(id).catch(() => null);
  if (!data) notFound();

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Repeater</h1>
          <div className="mt-1 font-mono text-xs text-[color:var(--cs-muted)]">{id}</div>
        </div>
        <div className="flex gap-2">
          <Link
            href={`/history/${id}`}
            className="rounded-xl border border-[color:var(--cs-border)] bg-white/40 px-3 py-2 text-xs font-medium text-[color:var(--cs-muted)] hover:bg-white/60 dark:bg-black/30 dark:hover:bg-black/40"
          >
            History
          </Link>
          <Link
            href="/repeater"
            className="rounded-xl border border-[color:var(--cs-border)] bg-white/40 px-3 py-2 text-xs font-medium text-[color:var(--cs-muted)] hover:bg-white/60 dark:bg-black/30 dark:hover:bg-black/40"
          >
            Back
          </Link>
        </div>
      </div>

      <div className="text-sm text-[color:var(--cs-muted)]">
        Edit and resend the captured request through the local agent. HTTPS replay works even
        without MITM, but baseline capture for HTTPS requires TLS MITM (install the CA cert).
      </div>

      <RepeaterClient baseline={data.item} />
    </div>
  );
}
