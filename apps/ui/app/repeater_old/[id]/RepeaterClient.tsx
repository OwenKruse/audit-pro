'use client';

import {
  ReplayResponseSchema,
  type HttpMessageDetail,
  type ReplayDiff,
  type ReplayOverrides,
  type ReplayResponse,
} from '@cipherscope/proto';
import { useMemo, useState } from 'react';

type BodyMode = 'text' | 'base64';

function formatHeaders(headers: Record<string, string[]>): string {
  const lines: string[] = [];
  const keys = Object.keys(headers).sort();
  for (const k of keys) {
    const vals = headers[k] ?? [];
    for (const v of vals) lines.push(`${k}: ${v}`);
  }
  return lines.join('\n');
}

function parseHeaderLines(raw: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(':');
    if (idx <= 0) continue;
    const name = trimmed.slice(0, idx).trim().toLowerCase();
    const value = trimmed.slice(idx + 1).trim();
    if (!name) continue;
    (out[name] ??= []).push(value);
  }
  return out;
}

function fmtMs(v: number | null) {
  if (v == null) return '-';
  return `${v.toFixed(1)}ms`;
}

export function RepeaterClient(props: { baseline: HttpMessageDetail }) {
  const baseline = props.baseline;

  const initialBodyMode: BodyMode =
    baseline.request.bodyText != null ? 'text' : baseline.request.bodyBase64 != null ? 'base64' : 'text';

  const [method, setMethod] = useState(baseline.method);
  const [url, setUrl] = useState(baseline.url);
  const [headersText, setHeadersText] = useState(() => formatHeaders(baseline.request.headers));
  const [bodyMode, setBodyMode] = useState<BodyMode>(initialBodyMode);
  const [body, setBody] = useState(() => baseline.request.bodyText ?? baseline.request.bodyBase64 ?? '');

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ReplayResponse | null>(null);

  const diff: ReplayDiff | null = result?.diff ?? null;
  const variant = result?.variant ?? null;

  const diffSummary = useMemo(() => {
    if (!diff) return null;
    const headerCount = diff.headers.added.length + diff.headers.removed.length + diff.headers.changed.length;
    return {
      statusChanged: diff.status.changed,
      headerCount,
      jsonChangeCount: diff.body.kind === 'json' ? diff.body.jsonChanges.length : 0,
    };
  }, [diff]);

	  async function send() {
	    setLoading(true);
	    setError(null);
	    try {
	      const headers = parseHeaderLines(headersText);
	      const overrides: ReplayOverrides = { method, url, headers };

	      if (bodyMode === 'text') overrides.bodyText = body;
	      else overrides.bodyBase64 = body;

      const res = await fetch('/api/replay', {
        method: 'POST',
	        headers: { 'content-type': 'application/json' },
	        body: JSON.stringify({ messageId: baseline.id, overrides }),
	      });

	      const json = (await res.json().catch(() => null)) as unknown;
	      if (!json || typeof json !== 'object') {
	        setResult(null);
	        setError(`Replay failed (${res.status})`);
	        return;
	      }

	      if (!res.ok) {
	        const msg = (json as { error?: { message?: unknown } })?.error?.message;
	        setResult(null);
	        setError(typeof msg === 'string' ? msg : `Replay failed (${res.status})`);
	        return;
	      }

	      const parsed = ReplayResponseSchema.safeParse(json);
	      if (!parsed.success) {
	        setResult(null);
	        setError('Unexpected replay response shape from agent.');
	        return;
	      }

	      setResult(parsed.data as ReplayResponse);
	    } catch (err) {
	      setResult(null);
	      setError(err instanceof Error ? err.message : String(err));
	    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-[color:var(--cs-border)] bg-white/40 p-4 dark:bg-black/30">
          <div className="text-xs uppercase tracking-widest text-[color:var(--cs-muted)]">Request</div>

          <div className="mt-3 grid grid-cols-1 gap-3">
            <div className="flex gap-2">
              <input
                value={method}
                onChange={(e) => setMethod(e.target.value)}
                className="w-[110px] rounded-lg border border-[color:var(--cs-border)] bg-white/60 px-3 py-2 font-mono text-xs outline-none dark:bg-black/20"
              />
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                className="min-w-0 flex-1 rounded-lg border border-[color:var(--cs-border)] bg-white/60 px-3 py-2 font-mono text-xs outline-none dark:bg-black/20"
              />
            </div>

            <div>
              <div className="text-[10px] uppercase tracking-widest text-[color:var(--cs-muted)]">Headers</div>
              <textarea
                value={headersText}
                onChange={(e) => setHeadersText(e.target.value)}
                className="mt-2 h-[220px] w-full resize-none rounded-lg border border-[color:var(--cs-border)] bg-white/60 p-3 font-mono text-[11px] leading-relaxed outline-none dark:bg-black/20"
              />
            </div>

            <div>
              <div className="flex items-center justify-between gap-4">
                <div className="text-[10px] uppercase tracking-widest text-[color:var(--cs-muted)]">Body</div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setBodyMode('text')}
                    className={[
                      'rounded-lg px-2 py-1 text-[10px] font-medium',
                      bodyMode === 'text'
                        ? 'bg-black/10 text-[color:var(--cs-fg)] dark:bg-white/10'
                        : 'text-[color:var(--cs-muted)] hover:bg-black/5 dark:hover:bg-white/5',
                    ].join(' ')}
                  >
                    text
                  </button>
                  <button
                    type="button"
                    onClick={() => setBodyMode('base64')}
                    className={[
                      'rounded-lg px-2 py-1 text-[10px] font-medium',
                      bodyMode === 'base64'
                        ? 'bg-black/10 text-[color:var(--cs-fg)] dark:bg-white/10'
                        : 'text-[color:var(--cs-muted)] hover:bg-black/5 dark:hover:bg-white/5',
                    ].join(' ')}
                  >
                    base64
                  </button>
                </div>
              </div>
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                className="mt-2 h-[220px] w-full resize-none rounded-lg border border-[color:var(--cs-border)] bg-white/60 p-3 font-mono text-[11px] leading-relaxed outline-none dark:bg-black/20"
              />
              <div className="mt-2 text-xs text-[color:var(--cs-muted)]">
                {bodyMode === 'base64'
                  ? 'Sending body as base64 bytes.'
                  : 'Sending body as UTF-8 text.'}
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={send}
                disabled={loading}
                className="rounded-xl bg-[color:var(--cs-accent)] px-3 py-2 text-xs font-medium text-white disabled:opacity-60"
              >
                {loading ? 'Sending…' : 'Send'}
              </button>
              {diffSummary ? (
                <div className="text-xs text-[color:var(--cs-muted)]">
                  {diffSummary.statusChanged ? (
                    <span className="rounded-md bg-amber-500/20 px-2 py-1 text-amber-700 dark:text-amber-200">
                      status changed
                    </span>
                  ) : (
                    <span className="rounded-md bg-emerald-500/15 px-2 py-1 text-emerald-700 dark:text-emerald-200">
                      status same
                    </span>
                  )}{' '}
                  <span className="font-mono text-[11px]">
                    headersΔ={diffSummary.headerCount} jsonΔ={diffSummary.jsonChangeCount}
                  </span>
                </div>
              ) : null}
            </div>
          </div>

          {error ? (
            <div className="mt-3 rounded-lg border border-[color:var(--cs-border)] bg-rose-500/10 p-3 font-mono text-xs text-rose-700 dark:text-rose-200">
              {error}
            </div>
          ) : null}
        </div>

        <div className="rounded-xl border border-[color:var(--cs-border)] bg-white/40 p-4 dark:bg-black/30">
          <div className="text-xs uppercase tracking-widest text-[color:var(--cs-muted)]">Response</div>

          {variant ? (
            <div className="mt-3 flex flex-col gap-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-lg border border-[color:var(--cs-border)] bg-white/40 p-3 dark:bg-black/20">
                  <div className="text-[10px] uppercase tracking-widest text-[color:var(--cs-muted)]">
                    Baseline
                  </div>
                  <div className="mt-2 font-mono text-xs">
                    {baseline.responseStatus == null ? '-' : baseline.responseStatus}
                  </div>
                  <div className="mt-2 font-mono text-[11px] text-[color:var(--cs-muted)]">
                    total {fmtMs(baseline.timing.totalMs)}
                  </div>
                </div>
                <div className="rounded-lg border border-[color:var(--cs-border)] bg-white/40 p-3 dark:bg-black/20">
                  <div className="text-[10px] uppercase tracking-widest text-[color:var(--cs-muted)]">
                    Variant
                  </div>
                  <div className="mt-2 font-mono text-xs">
                    {variant.responseStatus == null ? '-' : variant.responseStatus}
                  </div>
                  <div className="mt-2 font-mono text-[11px] text-[color:var(--cs-muted)]">
                    total {fmtMs(variant.timing.totalMs)}
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                <div>
                  <div className="text-[10px] uppercase tracking-widest text-[color:var(--cs-muted)]">
                    Baseline Body
                  </div>
                  <pre className="mt-2 max-h-[260px] overflow-auto rounded-lg bg-black/5 p-3 font-mono text-[11px] leading-relaxed dark:bg-white/5">
                    {baseline.response.bodyJson != null
                      ? JSON.stringify(baseline.response.bodyJson, null, 2)
                      : (baseline.response.bodyText ?? baseline.response.bodyBase64 ?? '')}
                  </pre>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-widest text-[color:var(--cs-muted)]">
                    Variant Body
                  </div>
                  <pre className="mt-2 max-h-[260px] overflow-auto rounded-lg bg-black/5 p-3 font-mono text-[11px] leading-relaxed dark:bg-white/5">
                    {variant.response.bodyJson != null
                      ? JSON.stringify(variant.response.bodyJson, null, 2)
                      : (variant.response.bodyText ?? variant.response.bodyBase64 ?? '')}
                  </pre>
                </div>
              </div>

              {diff ? (
                <div className="rounded-lg border border-[color:var(--cs-border)] bg-white/40 p-3 dark:bg-black/20">
                  <div className="text-[10px] uppercase tracking-widest text-[color:var(--cs-muted)]">
                    Diff Summary
                  </div>
                  <div className="mt-2 grid grid-cols-1 gap-2 text-xs text-[color:var(--cs-muted)]">
                    <div>
                      Status:{' '}
                      <span className="font-mono text-[11px]">
                        {diff.status.baseline ?? '-'} {'->'} {diff.status.variant ?? '-'}
                      </span>
                    </div>
                    <div>
                      Headers:{' '}
                      <span className="font-mono text-[11px]">
                        +{diff.headers.added.length} -{diff.headers.removed.length} Δ
                        {diff.headers.changed.length}
                      </span>
                    </div>
                    {diff.body.kind === 'json' ? (
                      <div>
                        JSON fields changed:{' '}
                        <span className="font-mono text-[11px]">{diff.body.jsonChanges.length}</span>
                        {diff.body.truncated ? ' (truncated)' : ''}
                      </div>
                    ) : (
                      <div>
                        Body changed:{' '}
                        <span className="font-mono text-[11px]">
                          {diff.body.changed ? 'yes' : 'no'} ({diff.body.kind})
                        </span>
                      </div>
                    )}
                  </div>

                  {diff.body.kind === 'json' && diff.body.jsonChanges.length ? (
                    <div className="mt-3">
                      <div className="text-[10px] uppercase tracking-widest text-[color:var(--cs-muted)]">
                        Changed Paths
                      </div>
                      <div className="mt-2 max-h-[220px] overflow-auto rounded-lg bg-black/5 p-2 font-mono text-[11px] leading-relaxed dark:bg-white/5">
                        {diff.body.jsonChanges.map((c) => (
                          <div key={c.path} className="border-b border-black/5 py-1 dark:border-white/5">
                            <div className="text-[color:var(--cs-fg)]">{c.path}</div>
                            <div className="text-[color:var(--cs-muted)]">
                              {JSON.stringify(c.before)} {'->'} {JSON.stringify(c.after)}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : (
            <div className="mt-3 text-sm text-[color:var(--cs-muted)]">
              Send a variant to view response + diff.
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
