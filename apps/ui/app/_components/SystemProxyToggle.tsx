'use client';

import { useEffect, useState } from 'react';
import { Circle } from 'lucide-react';

type StatusOk = {
  ok: true;
  supported: boolean;
  service: string;
  desired: { host: string; port: number; source: 'agent' | 'fallback' };
  systemProxyEnabled: boolean;
  web: { enabled: boolean; host: string | null; port: number | null };
  secureWeb: { enabled: boolean; host: string | null; port: number | null };
};

type StatusErr = { ok: false; error?: { code?: string; message?: string } };
type StatusResponse = StatusOk | StatusErr;

type SystemProxyToggleProps = {
  /** When provided, use this status instead of fetching and hide the Turn On/Off button (use header Play/Pause/Stop instead). */
  status?: StatusOk | null;
  loading?: boolean;
  onRefresh?: () => void | Promise<void>;
};

export function SystemProxyToggle(props: SystemProxyToggleProps = {}) {
  const { status: statusProp, loading: loadingProp, onRefresh } = props;
  const [status, setStatus] = useState<StatusOk | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const effectiveStatus = statusProp ?? status;
  const effectiveLoading = statusProp !== undefined ? loadingProp : loading;
  const controlledByHeader = statusProp !== undefined;

  async function refresh() {
    if (controlledByHeader) {
      await onRefresh?.();
      return;
    }
    setLoading(true);
    try {
      const res = await fetch('/api/system/proxy', { cache: 'no-store' });
      const json = (await res.json().catch(() => null)) as StatusResponse | null;
      if (!json || typeof json !== 'object') throw new Error('Invalid response.');
      if (!res.ok || json.ok !== true) {
        const msg = (json as StatusErr).error?.message;
        throw new Error(typeof msg === 'string' && msg.trim() ? msg : `Proxy status failed (${res.status}).`);
      }
      setStatus(json);
      setError(null);
    } catch (err) {
      setStatus(null);
      setError(err instanceof Error ? err.message : 'Failed to load proxy status.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!controlledByHeader) void refresh();
  }, [controlledByHeader]);

  async function onToggle() {
    if (!effectiveStatus || !effectiveStatus.supported) return;
    setBusy(true);
    try {
      const res = await fetch('/api/system/proxy', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: !effectiveStatus.systemProxyEnabled, service: effectiveStatus.service }),
      });
      const json = (await res.json().catch(() => null)) as StatusResponse | null;
      if (!json || typeof json !== 'object') throw new Error('Invalid response.');
      if (!res.ok || json.ok !== true) {
        const msg = (json as StatusErr).error?.message;
        throw new Error(typeof msg === 'string' && msg.trim() ? msg : `Proxy toggle failed (${res.status}).`);
      }
      setStatus(json);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to toggle system proxy.');
    } finally {
      setBusy(false);
    }
  }

  if (effectiveLoading) {
    return (
      <div className="hidden min-w-[180px] items-start gap-2 border-l border-[color:var(--cs-border)] pl-2 text-[13px] text-[color:var(--cs-muted)] xl:flex">
        <Circle className="mt-1 h-2.5 w-2.5 text-amber-500" />
        <div>
          <div className="leading-tight text-[color:var(--cs-fg)]">Proxy</div>
          <div className="leading-tight text-[11px]">Loading…</div>
        </div>
      </div>
    );
  }

  if (!effectiveStatus) {
    return (
      <div className="hidden min-w-[220px] items-start gap-2 border-l border-[color:var(--cs-border)] pl-2 text-[11px] text-rose-700 xl:flex">
        {error ?? 'Proxy status unavailable.'}
      </div>
    );
  }

  if (!effectiveStatus.supported) {
    return (
      <div className="hidden min-w-[180px] items-start gap-2 border-l border-[color:var(--cs-border)] pl-2 text-[13px] text-[color:var(--cs-muted)] xl:flex">
        <Circle className="mt-1 h-2.5 w-2.5 text-[color:var(--cs-muted)]" />
        <div>
          <div className="leading-tight text-[color:var(--cs-fg)]">Proxy</div>
          <div className="leading-tight text-[11px]">macOS only</div>
        </div>
      </div>
    );
  }

  return (
    <div className="hidden min-w-[220px] items-start gap-2 border-l border-[color:var(--cs-border)] pl-2 xl:flex">
      <Circle
        className={[
          'mt-1 h-2.5 w-2.5',
          effectiveStatus.systemProxyEnabled
            ? 'fill-emerald-500 text-emerald-500'
            : 'fill-[color:var(--cs-muted)] text-[color:var(--cs-muted)]',
        ].join(' ')}
      />
      <div className="min-w-0">
        <div className="leading-tight text-[13px] text-[color:var(--cs-fg)]">
          Proxy {effectiveStatus.systemProxyEnabled ? 'On' : 'Off'}
        </div>
        <div className="truncate leading-tight text-[11px] text-[color:var(--cs-muted)]">
          {effectiveStatus.desired.host}:{effectiveStatus.desired.port} · {effectiveStatus.service}
        </div>
        {!controlledByHeader ? (
          <button
            type="button"
            disabled={busy}
            onClick={onToggle}
            className="mt-1 inline-flex h-6 items-center rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 text-[10px] font-medium text-[color:var(--cs-fg)] transition-colors hover:bg-[color:var(--cs-hover)] disabled:opacity-50"
            title={effectiveStatus.systemProxyEnabled ? 'Disable macOS web/secure web proxy' : 'Enable macOS web/secure web proxy'}
          >
            {busy ? 'Working…' : effectiveStatus.systemProxyEnabled ? 'Turn Off' : 'Turn On'}
          </button>
        ) : null}
        {error ? (
          <div className="mt-1 text-[10px] text-rose-700">{error}</div>
        ) : null}
      </div>
    </div>
  );
}
