'use client';

import Link from 'next/link';
import {
  FuzzCampaignResponseSchema,
  type FuzzCampaignResponse,
  type HttpMessageDetail,
  type HttpMessageSummary,
} from '@cipherscope/proto';
import { useEffect, useMemo, useState } from 'react';

type PathOption = {
  path: string;
  type: string;
  preview: string;
};

function pointerEscape(seg: string): string {
  return seg.replace(/~/g, '~0').replace(/\//g, '~1');
}

function formatPreview(value: unknown): string {
  if (typeof value === 'string') return value.length > 48 ? `${value.slice(0, 48)}...` : value;
  if (typeof value === 'number' || typeof value === 'boolean' || value == null) return String(value);
  try {
    const text = JSON.stringify(value);
    return text.length > 64 ? `${text.slice(0, 64)}...` : text;
  } catch {
    return '[unserializable]';
  }
}

function valueType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function collectJsonPaths(value: unknown, max = 600): PathOption[] {
  const out: PathOption[] = [];

  const visit = (v: unknown, path: string) => {
    if (out.length >= max) return;
    out.push({ path, type: valueType(v), preview: formatPreview(v) });

    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i += 1) {
        if (out.length >= max) break;
        const child = path === '/' ? `/${i}` : `${path}/${i}`;
        visit(v[i], child);
      }
      return;
    }

    if (v && typeof v === 'object') {
      const obj = v as Record<string, unknown>;
      const keys = Object.keys(obj).sort();
      for (const key of keys) {
        if (out.length >= max) break;
        const escaped = pointerEscape(key);
        const child = path === '/' ? `/${escaped}` : `${path}/${escaped}`;
        visit(obj[key], child);
      }
    }
  };

  visit(value, '/');
  return out;
}

function parseJsonBody(detail: HttpMessageDetail | null): unknown | null {
  if (!detail) return null;
  if (detail.request.bodyJson != null) return detail.request.bodyJson;
  if (!detail.request.bodyText) return null;
  try {
    return JSON.parse(detail.request.bodyText) as unknown;
  } catch {
    return null;
  }
}

function fmtMs(v: number | null) {
  if (v == null) return '-';
  return `${v.toFixed(1)}ms`;
}

function messageLabel(m: HttpMessageSummary): string {
  const ts = new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `${m.method} ${m.host}${m.path} (${ts})`;
}

export function FuzzerClient(props: {
  initialMessages: HttpMessageSummary[];
  agentReachable: boolean;
}) {
  const messages = useMemo(
    () => props.initialMessages.filter((m) => m.scheme === 'http' || m.scheme === 'https'),
    [props.initialMessages],
  );

  const [messageId, setMessageId] = useState<string>(messages[0]?.id ?? '');
  const [message, setMessage] = useState<HttpMessageDetail | null>(null);
  const [messageError, setMessageError] = useState<string | null>(null);
  const [loadingMessage, setLoadingMessage] = useState(false);

  const [fieldOptions, setFieldOptions] = useState<PathOption[]>([]);
  const [fieldPath, setFieldPath] = useState('/');

  const [maxCases, setMaxCases] = useState(24);
  const [concurrency, setConcurrency] = useState(4);
  const [perHostDelayMs, setPerHostDelayMs] = useState(50);
  const [timeoutMs, setTimeoutMs] = useState(15000);
  const [anvilSnapshot, setAnvilSnapshot] = useState(true);

  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [result, setResult] = useState<FuzzCampaignResponse | null>(null);
  const [clusterFilter, setClusterFilter] = useState<string>('');

  useEffect(() => {
    if (!messageId) {
      setMessage(null);
      setFieldOptions([]);
      return;
    }

    let cancelled = false;
    setLoadingMessage(true);
    setMessageError(null);

    fetch(`/api/messages/${encodeURIComponent(messageId)}`, { cache: 'no-store' })
      .then(async (r) => {
        const json = (await r.json().catch(() => null)) as { item?: HttpMessageDetail; error?: { message?: string } } | null;
        if (!r.ok || !json?.item) {
          throw new Error(json?.error?.message ?? `Failed to load message (${r.status})`);
        }
        return json.item;
      })
      .then((item) => {
        if (cancelled) return;
        setMessage(item);

        const body = parseJsonBody(item);
        if (body == null) {
          setFieldOptions([]);
          setFieldPath('/');
          return;
        }

        const paths = collectJsonPaths(body);
        setFieldOptions(paths);
        setFieldPath((prev) => (paths.some((p) => p.path === prev) ? prev : paths[0]?.path ?? '/'));
      })
      .catch((err) => {
        if (cancelled) return;
        setMessage(null);
        setFieldOptions([]);
        setMessageError(err instanceof Error ? err.message : 'Failed to load message');
      })
      .finally(() => {
        if (cancelled) return;
        setLoadingMessage(false);
      });

    return () => {
      cancelled = true;
    };
  }, [messageId]);

  const selectedPath = useMemo(() => fieldOptions.find((p) => p.path === fieldPath) ?? null, [fieldOptions, fieldPath]);

  const visibleCases = useMemo(() => {
    const cases = result?.cases ?? [];
    if (!clusterFilter) return cases;
    return cases.filter((c) => c.clusterId === clusterFilter);
  }, [result?.cases, clusterFilter]);

  async function runCampaign() {
    if (!messageId) return;
    setRunning(true);
    setRunError(null);
    setClusterFilter('');

    try {
      const res = await fetch('/api/fuzzer/campaign', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messageId,
          fieldPath,
          maxCases,
          concurrency,
          perHostDelayMs,
          timeoutMs,
          anvilSnapshot,
        }),
      });

      const json = await res.json();
      if (!res.ok) throw new Error(json.error?.message || 'Campaign failed');

      const parsed = FuzzCampaignResponseSchema.safeParse(json);
      if (!parsed.success) throw new Error('Invalid response from agent');

      setResult(parsed.data);
    } catch (err) {
      setRunError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-[color:var(--cs-panel)]">
      <section className="grid grid-cols-[380px_1fr] border-b border-[color:var(--cs-border)] flex-1 min-h-0">
        <div className="flex flex-col border-r border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)]">
          <div className="px-3 py-1.5 border-b border-[color:var(--cs-border)]">
            <h3 className="text-[11px] font-bold uppercase tracking-wider text-[color:var(--cs-fg)]">Campaign Setup</h3>
          </div>
          
          <div className="flex-1 overflow-auto p-3 space-y-4">
            <Field label="Baseline Message">
              <select
                value={messageId}
                onChange={(e) => setMessageId(e.target.value)}
                className="h-8 w-full rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 text-[12px] font-mono outline-none"
              >
                {messages.map((m) => (
                  <option key={m.id} value={m.id}>{messageLabel(m)}</option>
                ))}
              </select>
            </Field>

            <Field label="Target Path">
              <select
                value={fieldPath}
                onChange={(e) => setFieldPath(e.target.value)}
                disabled={!fieldOptions.length}
                className="h-8 w-full rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 text-[12px] font-mono outline-none"
              >
                {fieldOptions.map((p) => (
                  <option key={p.path} value={p.path}>{p.path} ({p.type})</option>
                ))}
              </select>
              {selectedPath && (
                <div className="mt-1 text-[10px] font-mono text-[color:var(--cs-muted)] truncate">
                  Value: {selectedPath.preview}
                </div>
              )}
            </Field>

            <div className="grid grid-cols-2 gap-2">
              <Field label="Max Cases">
                <input
                  type="number"
                  value={maxCases}
                  onChange={(e) => setMaxCases(Number(e.target.value))}
                  className="h-8 w-full rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 text-[12px] outline-none"
                />
              </Field>
              <Field label="Concurrency">
                <input
                  type="number"
                  value={concurrency}
                  onChange={(e) => setConcurrency(Number(e.target.value))}
                  className="h-8 w-full rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 text-[12px] outline-none"
                />
              </Field>
            </div>

            <label className="flex items-center gap-2 text-[12px] text-[color:var(--cs-fg)] cursor-pointer">
              <input
                type="checkbox"
                checked={anvilSnapshot}
                onChange={(e) => setAnvilSnapshot(e.target.checked)}
                className="h-3.5 w-3.5 accent-[color:var(--cs-accent)]"
              />
              Snapshot before run
            </label>

            <button
              type="button"
              onClick={runCampaign}
              disabled={running || loadingMessage}
              className="w-full h-9 rounded-md bg-[color:var(--cs-accent)] text-white text-[13px] font-bold shadow-lg shadow-blue-500/20 hover:bg-blue-600 active:scale-95 transition-all"
            >
              {running ? 'Running...' : 'Run Fuzz Campaign'}
            </button>

            {runError && <div className="text-[11px] text-rose-500 bg-rose-500/10 p-2 rounded border border-rose-500/20">{runError}</div>}
          </div>
        </div>

        <div className="flex flex-col min-h-0">
          <div className="px-3 py-1.5 border-b border-[color:var(--cs-border)] flex justify-between items-center">
            <h3 className="text-[11px] font-bold uppercase tracking-wider text-[color:var(--cs-fg)]">Campaign Results</h3>
            {result && (
              <div className="flex gap-3 text-[10px] text-[color:var(--cs-muted)]">
                <span>TOTAL: {result.campaign.totalCases}</span>
                <span>CLUSTERS: {result.clusters.length}</span>
                <span className="text-rose-500">ANOMALIES: {result.anomalies.length}</span>
              </div>
            )}
          </div>

          <div className="flex-1 overflow-hidden flex flex-col">
            {!result ? (
              <div className="flex-1 flex items-center justify-center text-[color:var(--cs-muted)] text-[13px]">
                {loadingMessage ? 'Loading message...' : 'Configure and run a campaign to see results'}
              </div>
            ) : (
              <div className="flex flex-1 min-h-0">
                <div className="w-1/3 border-r border-[color:var(--cs-border)] overflow-auto">
                  <TableCompact
                    headers={['Cluster', 'Cases', 'Status']}
                    rows={result.clusters.map(c => [
                      c.id, String(c.caseCount), String(c.signature.status ?? 'OK')
                    ])}
                    selectedId={clusterFilter}
                    onSelect={(id) => setClusterFilter(prev => prev === id ? '' : id)}
                  />
                </div>
                <div className="flex-1 overflow-auto bg-[color:var(--cs-panel-soft)]">
                  <TableCompact
                    headers={['Case', 'Mutation', 'Latency', 'Status']}
                    rows={visibleCases.slice(0, 100).map(c => [
                      c.caseId.slice(0, 8), c.mutationLabel, fmtMs(c.totalMs), String(c.status ?? 'OK')
                    ])}
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      </section>

      <footer className="px-3 py-1.5 border-t border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] flex gap-4 text-[10px] text-[color:var(--cs-muted)]">
        <span>Agent Status: <span className="text-emerald-500 font-bold">ALIVE</span></span>
        <span>Anvil Proxy: <span className="text-emerald-500 font-bold">READY</span></span>
      </footer>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">{label}</label>
      {children}
    </div>
  );
}

function TableCompact({ 
  headers, 
  rows, 
  selectedId, 
  onSelect 
}: { 
  headers: string[], 
  rows: string[][], 
  selectedId?: string, 
  onSelect?: (id: string) => void 
}) {
  return (
    <table className="w-full text-left border-collapse">
      <thead className="sticky top-0 bg-[color:var(--cs-panel-soft)] border-b border-[color:var(--cs-border)] z-10">
        <tr>
          {headers.map(h => (
            <th key={h} className="px-3 py-1.5 text-[10px] uppercase font-bold text-[color:var(--cs-muted)]">{h}</th>
          ))}
        </tr>
      </thead>
      <tbody className="divide-y divide-[color:var(--cs-border)]">
        {rows.map((row, i) => (
          <tr 
            key={i} 
            onClick={() => onSelect?.(row[0])}
            className={[
              'text-[11px] transition-colors',
              onSelect ? 'cursor-pointer' : '',
              selectedId === row[0] ? 'bg-[color:var(--cs-accent-soft)]' : 'hover:bg-[color:var(--cs-hover)]'
            ].join(' ')}
          >
            {row.map((cell, j) => (
              <td key={j} className="px-3 py-1 font-mono">{cell}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
