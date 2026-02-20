'use client';

import { useEffect, useState } from 'react';

type StatusOk = {
  ok: true;
  supported: boolean;
  apiUrl: string;
  command: string;
  running: boolean;
  version: string | null;
  notice?: string;
};

type StatusErr = {
  ok: false;
  error?: {
    code?: unknown;
    message?: unknown;
  };
};

type StatusResponse = StatusOk | StatusErr;

type InlineStatus = {
  ok: boolean;
  message: string;
};

const btnClass =
  'inline-flex h-7 items-center gap-1.5 rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 text-[11px] font-medium text-[color:var(--cs-fg)] transition-colors hover:bg-[color:var(--cs-hover)] disabled:opacity-50';

function parseErrorMessage(payload: StatusErr | null, fallback: string): string {
  const raw = payload?.error?.message;
  return typeof raw === 'string' && raw.trim() ? raw : fallback;
}

export function ZapSettingsCard() {
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<StatusOk | null>(null);
  const [inlineStatus, setInlineStatus] = useState<InlineStatus | null>(null);

  async function refresh() {
    setLoading(true);
    try {
      const res = await fetch('/api/system/zap', { cache: 'no-store' });
      const json = (await res.json().catch(() => null)) as StatusResponse | null;
      if (!json || typeof json !== 'object' || json.ok !== true) {
        throw new Error(parseErrorMessage((json as StatusErr | null) ?? null, `Failed to load ZAP status (${res.status}).`));
      }
      setStatus(json);
      setInlineStatus(null);
    } catch (err) {
      setStatus(null);
      setInlineStatus({
        ok: false,
        message: err instanceof Error ? err.message : 'Failed to load ZAP status.',
      });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function onStart() {
    if (busy) return;
    setBusy(true);
    setInlineStatus(null);
    try {
      const res = await fetch('/api/system/zap', { method: 'POST' });
      const json = (await res.json().catch(() => null)) as StatusResponse | null;
      if (!json || typeof json !== 'object' || json.ok !== true) {
        throw new Error(parseErrorMessage((json as StatusErr | null) ?? null, `Failed to start ZAP (${res.status}).`));
      }
      setStatus(json);
      setInlineStatus({
        ok: json.running,
        message: json.notice ?? (json.running ? 'ZAP is running.' : 'ZAP launch command sent.'),
      });
    } catch (err) {
      setInlineStatus({
        ok: false,
        message: err instanceof Error ? err.message : 'Failed to start ZAP.',
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border-b border-[color:var(--cs-border)]">
      <div className="border-b border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-3 py-1.5 text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">
        OWASP ZAP (Local)
      </div>
      <div className="space-y-2 px-3 py-2">
        <p className="text-[11px] text-[color:var(--cs-muted)]">
          Launch the macOS ZAP daemon and verify the API endpoint used by scans and AI tools.
        </p>

        {loading ? (
          <div className="text-[11px] text-[color:var(--cs-muted)]">Loading...</div>
        ) : status ? (
          <div className="grid gap-2 text-[11px] text-[color:var(--cs-muted)] md:grid-cols-2">
            <div className="rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] p-2">
              API URL:{' '}
              <span className="block break-all font-mono text-[color:var(--cs-fg)]">{status.apiUrl}</span>
            </div>
            <div className="rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] p-2">
              Status:{' '}
              <span className="block font-mono text-[color:var(--cs-fg)]">
                {status.running ? `running${status.version ? ` (${status.version})` : ''}` : 'stopped'}
              </span>
              {!status.supported ? (
                <span className="block text-[10px] text-[color:var(--cs-muted)]">macOS only</span>
              ) : null}
            </div>
            <div className="rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] p-2 md:col-span-2">
              Launch command:{' '}
              <span className="block break-all font-mono text-[color:var(--cs-fg)]">{status.command}</span>
            </div>
          </div>
        ) : null}

        {inlineStatus ? (
          <div
            className={[
              'px-2 py-1.5 text-[11px]',
              inlineStatus.ok
                ? 'border border-emerald-500/40 bg-emerald-500/10 text-emerald-700'
                : 'border border-rose-500/40 bg-rose-500/10 text-rose-700',
            ].join(' ')}
          >
            {inlineStatus.message}
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={btnClass}
            onClick={onStart}
            disabled={busy || loading || !status?.supported || status.running}
            title="Run ZAP daemon startup command"
          >
            {busy ? 'Starting...' : status?.running ? 'ZAP Running' : 'Start ZAP'}
          </button>
          <button type="button" className={btnClass} onClick={() => void refresh()} disabled={busy || loading}>
            Refresh
          </button>
        </div>
      </div>
    </div>
  );
}
