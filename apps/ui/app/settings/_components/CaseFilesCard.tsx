'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

type CaseStats = {
  httpMessages: number;
  wsConnections: number;
  wsFrames: number;
  flows: number;
  findings: number;
};

type ImportOk = {
  ok: true;
  manifest: {
    format: 'cipherscope-case';
    version: 1;
    createdAt: string;
    agent: { name: string; version: string };
    dbFile: string;
    stats: CaseStats;
  } | null;
  imported: CaseStats;
};

type ImportErr = {
  ok: false;
  error: { code: string; message: string };
};

export function CaseFilesCard() {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportOk | ImportErr | null>(null);

  async function onImport(e: React.FormEvent) {
    e.preventDefault();
    setResult(null);

    const file = fileRef.current?.files?.[0] ?? null;
    if (!file) {
      setResult({ ok: false, error: { code: 'bad_request', message: 'Choose a .zip case file.' } });
      return;
    }

    const ok = globalThis.confirm(
      'Importing a case file will replace your current capture database (History, WebSockets, Findings, Flows). Continue?',
    );
    if (!ok) return;

    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file, file.name);
      const res = await fetch('/api/case/import', { method: 'POST', body: fd });
      const json = (await res.json().catch(() => null)) as unknown;

      if (!json || typeof json !== 'object') {
        setResult({ ok: false, error: { code: 'bad_response', message: 'Invalid response.' } });
        return;
      }

      if (!res.ok) {
        const err = json as { error?: { code?: unknown; message?: unknown } };
        setResult({
          ok: false,
          error: {
            code: typeof err?.error?.code === 'string' ? err.error.code : 'import_failed',
            message: typeof err?.error?.message === 'string' ? err.error.message : 'Import failed.',
          },
        });
        return;
      }

      setResult(json as ImportOk);
      router.refresh();
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  return (
    <div className="border-b border-[color:var(--cs-border)]">
      <div className="flex items-center justify-between border-b border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-3 py-1.5">
        <span className="text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">Case Files</span>
        <Link
          href="/history"
          className="text-[10px] font-bold uppercase text-[color:var(--cs-accent)] hover:underline"
        >
          Open History
        </Link>
      </div>
      <div className="space-y-2 px-3 py-2">
        <p className="text-[11px] text-[color:var(--cs-muted)]">
          Export a capture as a portable zip. Import replaces your current local capture database.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <a
            href="/api/case/export"
            className="inline-flex h-7 items-center rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 text-[11px] font-medium text-[color:var(--cs-fg)] transition-colors hover:bg-[color:var(--cs-hover)]"
          >
            Export Case (.zip)
          </a>
          <form onSubmit={onImport} className="inline-flex items-center gap-2">
            <input
              ref={fileRef}
              type="file"
              name="file"
              accept=".zip,application/zip"
              disabled={busy}
              className="h-7 max-w-[200px] rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 text-[11px] file:mr-2 file:border-0 file:bg-transparent file:text-[11px] file:text-[color:var(--cs-muted)]"
            />
            <button
              type="submit"
              disabled={busy}
              className="inline-flex h-7 items-center rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 text-[11px] font-medium text-[color:var(--cs-fg)] transition-colors hover:bg-[color:var(--cs-hover)] disabled:opacity-50"
            >
              {busy ? 'Importing…' : 'Import'}
            </button>
          </form>
        </div>

        {result ? (
          result.ok ? (
            <div className="border border-emerald-500/40 bg-emerald-500/10 px-2 py-1.5 text-[11px] text-emerald-700">
              <span className="font-medium">Import complete.</span>{' '}
              <span className="font-mono text-[color:var(--cs-muted)]">
                http: {result.imported.httpMessages} · ws: {result.imported.wsConnections} · frames: {result.imported.wsFrames} · flows: {result.imported.flows} · findings: {result.imported.findings}
              </span>
            </div>
          ) : (
            <div className="border border-rose-500/40 bg-rose-500/10 px-2 py-1.5 text-[11px] text-rose-700">
              <span className="font-medium">Import failed.</span> {result.error.message}
            </div>
          )
        ) : null}
      </div>
    </div>
  );
}
