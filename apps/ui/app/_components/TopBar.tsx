'use client';

import Link from 'next/link';
import {
  Circle,
  Download,
  Pause,
  Play,
  Plus,
  Settings,
  Square,
  Upload,
} from 'lucide-react';
import { GlobalSearch } from './GlobalSearch';
import { SystemProxyToggle } from './SystemProxyToggle';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type ProxyStatusOk = {
  ok: true;
  supported: boolean;
  service: string;
  desired: { host: string; port: number; source: 'agent' | 'fallback' };
  systemProxyEnabled: boolean;
  web: { enabled: boolean; host: string | null; port: number | null };
  secureWeb: { enabled: boolean; host: string | null; port: number | null };
};
type ProxyStatusErr = { ok: false; error?: { code?: string; message?: string } };
type ProxyStatusResponse = ProxyStatusOk | ProxyStatusErr;

const TOOL_ICON_CLASS =
  'inline-flex h-8 w-8 items-center justify-center rounded-md border border-transparent text-[color:var(--cs-muted)] transition-colors hover:border-[color:var(--cs-border)] hover:bg-[color:var(--cs-panel)] hover:text-[color:var(--cs-fg)]';

type Project = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
};

type ProjectsOk = {
  ok: true;
  currentId: string;
  projects: Project[];
};

type ProjectsErr = {
  ok: false;
  error: { code: string; message: string };
};

export function TopBar() {
  const importRef = useRef<HTMLInputElement | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [proxyStatus, setProxyStatus] = useState<ProxyStatusOk | null>(null);
  const [proxyBusy, setProxyBusy] = useState(false);

  const refreshProxy = useCallback(async () => {
    try {
      const res = await fetch('/api/system/proxy', { cache: 'no-store' });
      const json = (await res.json().catch(() => null)) as ProxyStatusResponse | null;
      if (!json || typeof json !== 'object') return;
      if (res.ok && json.ok === true) setProxyStatus(json);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    void refreshProxy();
  }, [refreshProxy]);

  async function setProxyEnabled(enabled: boolean) {
    const status = proxyStatus;
    if (!status?.supported) return;
    setProxyBusy(true);
    try {
      const res = await fetch('/api/system/proxy', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled, service: status.service }),
      });
      const json = (await res.json().catch(() => null)) as ProxyStatusResponse | null;
      if (json && res.ok && json.ok === true) setProxyStatus(json);
    } finally {
      setProxyBusy(false);
    }
  }

  const current = useMemo(
    () => projects.find((p) => p.id === currentId) ?? null,
    [projects, currentId],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/projects', { cache: 'no-store' });
        const json = (await res.json().catch(() => null)) as unknown;
        if (!json || typeof json !== 'object') throw new Error('Invalid response.');
        if (!res.ok) {
          const err = json as ProjectsErr;
          throw new Error(err?.error?.message ?? 'Failed to load projects.');
        }
        const ok = json as ProjectsOk;
        if (cancelled) return;
        setProjects(Array.isArray(ok.projects) ? ok.projects : []);
        setCurrentId(typeof ok.currentId === 'string' ? ok.currentId : null);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Failed to load projects.');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  async function onCreateProject() {
    const name = globalThis.prompt('New project name:', 'New Project')?.trim() ?? '';
    if (!name) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const json = (await res.json().catch(() => null)) as unknown;
      if (!res.ok) {
        const err = json as ProjectsErr;
        throw new Error(err?.error?.message ?? 'Create failed.');
      }
      // Project context affects nearly every workbench view; simplest is a full reload.
      globalThis.location.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Create failed.');
    } finally {
      setBusy(false);
    }
  }

  async function onSwitchProject(id: string) {
    if (!id || id === currentId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/projects/current', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      const json = (await res.json().catch(() => null)) as unknown;
      if (!res.ok) {
        const err = json as ProjectsErr;
        throw new Error(err?.error?.message ?? 'Switch failed.');
      }
      globalThis.location.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Switch failed.');
      setBusy(false);
    }
  }

  async function onImportFile(file: File) {
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append('file', file, file.name);
      const res = await fetch('/api/projects/import', { method: 'POST', body: fd });
      const json = (await res.json().catch(() => null)) as unknown;
      if (!res.ok) {
        const err = json as ProjectsErr;
        throw new Error(err?.error?.message ?? 'Import failed.');
      }
      globalThis.location.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Import failed.');
    } finally {
      setBusy(false);
      if (importRef.current) importRef.current.value = '';
    }
  }

  return (
    <header className="border-b border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-3 py-1.5">
      <div className="flex items-center gap-2 overflow-x-auto">
        <select
          aria-label="Investigation"
          value={currentId ?? ''}
          onChange={(e) => void onSwitchProject(e.target.value)}
          disabled={busy}
          className="h-8 min-w-[180px] rounded-lg border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-3 text-[13px] text-[color:var(--cs-fg)] outline-none transition-colors focus:border-[color:var(--cs-accent)]"
        >
          {currentId == null ? <option value="">Loading…</option> : null}
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>

        <input
          type="text"
          defaultValue="0x7d1afA7B718fb893db30A3aBc0Cfc608AaCfeBB0"
          aria-label="Target contract address"
          className="h-8 min-w-[320px] flex-1 rounded-lg border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-3 text-[13px] font-mono outline-none transition-colors focus:border-[color:var(--cs-accent)]"
        />

        <button
          type="button"
          className="inline-flex h-8 items-center gap-2 rounded-full bg-emerald-500/10 px-3 text-xs font-semibold text-emerald-600"
        >
          <Circle className="h-2 w-2 fill-current" />
          In Audit
        </button>

        <div className="relative hidden max-w-[420px] flex-1 items-center lg:flex">
          <GlobalSearch />
        </div>

        <div className="ml-auto flex items-center gap-0.5">
          <button
            className={TOOL_ICON_CLASS}
            type="button"
            aria-label="New"
            disabled={busy}
            onClick={() => void onCreateProject()}
            title="New project"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
          <input
            ref={importRef}
            type="file"
            accept=".zip,application/zip"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0] ?? null;
              if (file) void onImportFile(file);
            }}
          />
          <button
            className={TOOL_ICON_CLASS}
            type="button"
            aria-label="Import"
            disabled={busy}
            onClick={() => importRef.current?.click()}
            title="Import case as new project (.zip)"
          >
            <Upload className="h-3.5 w-3.5" />
          </button>
          <button
            className={TOOL_ICON_CLASS}
            type="button"
            aria-label="Export"
            disabled={busy || !current}
            onClick={() => {
              globalThis.location.href = '/api/projects/export';
            }}
            title={current ? `Export ${current.name} (.zip)` : 'Export'}
          >
            <Download className="h-3.5 w-3.5" />
          </button>
          <button
            className={TOOL_ICON_CLASS}
            type="button"
            aria-label="Start proxy"
            disabled={proxyBusy || !proxyStatus?.supported || proxyStatus?.systemProxyEnabled === true}
            onClick={() => void setProxyEnabled(true)}
            title="Start proxy — route system traffic through the proxy to capture requests"
          >
            <Play className="h-3.5 w-3.5 text-emerald-600" />
          </button>
          <button
            className={TOOL_ICON_CLASS}
            type="button"
            aria-label="Pause proxy"
            disabled={proxyBusy || !proxyStatus?.supported || proxyStatus?.systemProxyEnabled !== true}
            onClick={() => void setProxyEnabled(false)}
            title="Pause proxy — stop routing traffic through the proxy temporarily"
          >
            <Pause className="h-3.5 w-3.5 text-amber-600" />
          </button>
          <button
            className={TOOL_ICON_CLASS}
            type="button"
            aria-label="Stop proxy"
            disabled={proxyBusy || !proxyStatus?.supported || proxyStatus?.systemProxyEnabled !== true}
            onClick={() => void setProxyEnabled(false)}
            title="Stop proxy — disable the system proxy and stop capturing traffic"
          >
            <Square className="h-3.5 w-3.5 text-rose-600" />
          </button>
        </div>

        <SystemProxyToggle status={proxyStatus} loading={proxyStatus === null} onRefresh={refreshProxy} />

        <Link
          href="/report"
          className="inline-flex h-8 items-center rounded-lg border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-3 text-[13px] text-[color:var(--cs-fg)]"
        >
          Report
        </Link>

        <Link href="/settings" className={TOOL_ICON_CLASS} aria-label="Settings">
          <Settings className="h-3.5 w-3.5" />
        </Link>
      </div>

      {error ? (
        <div className="mt-1 text-[11px] text-rose-700">
          {error}
        </div>
      ) : null}
    </header>
  );
}
