'use client';

import {
  ReplayResponseSchema,
  type HttpMessageDetail,
  type ReplayDiff,
  type ReplayOverrides,
  type ReplayResponse,
} from '@cipherscope/proto';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ResponseBodyView } from '@/app/_components/ResponseBodyView';

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

function ResponseHeadersCollapsible(props: {
  variant: HttpMessageDetail;
  baseline: HttpMessageDetail;
}) {
  const [open, setOpen] = useState(false);
  const { variant, baseline } = props;
  return (
    <div className="rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)]">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-2 py-1.5 text-left text-[10px] font-bold uppercase tracking-widest text-[color:var(--cs-muted)] hover:bg-[color:var(--cs-hover)]"
      >
        Response headers
        <span className="font-normal text-[color:var(--cs-muted)]">{open ? '▼' : '▶'}</span>
      </button>
      {open && (
        <div className="grid grid-cols-1 gap-2 border-t border-[color:var(--cs-border)] p-2 lg:grid-cols-2">
          <div>
            <div className="text-[10px] font-medium text-[color:var(--cs-muted)]">Baseline</div>
            <pre className="mt-1 max-h-[120px] overflow-auto rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] p-2 font-mono text-[11px] leading-relaxed">
              {formatHeaders(baseline.response?.headers ?? {}) || '(none)'}
            </pre>
          </div>
          <div>
            <div className="text-[10px] font-medium text-[color:var(--cs-muted)]">Variant</div>
            <pre className="mt-1 max-h-[120px] overflow-auto rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] p-2 font-mono text-[11px] leading-relaxed">
              {formatHeaders(variant.response?.headers ?? {}) || '(none)'}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

const COMMON_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'CONNECT', 'TRACE'] as const;
const CUSTOM_VALUE = '__custom__';

/** Methods that typically have no request body; switching to these strips body and body-related headers. */
const NO_BODY_METHODS = new Set<string>(['GET', 'HEAD', 'OPTIONS', 'CONNECT', 'TRACE']);
/** Methods that typically allow a body; we may add a default Content-Type when body is present. */
const BODY_METHODS = new Set<string>(['POST', 'PUT', 'PATCH', 'DELETE']);
const BODY_RELATED_HEADER_NAMES = new Set<string>(['content-type', 'content-length', 'transfer-encoding']);

/**
 * Transform headers and body when switching HTTP method. Resilient: never throws; returns
 * unchanged values on any error or when no transform applies.
 */
function applyMethodTransform(
  _prevMethod: string,
  nextMethod: string,
  headersText: string,
  body: string,
): { headersText: string; body: string } {
  try {
    const nextUpper = String(nextMethod).trim().toUpperCase() || 'GET';

    if (NO_BODY_METHODS.has(nextUpper)) {
      const headers = parseHeaderLines(headersText);
      const filtered: Record<string, string[]> = {};
      for (const [name, values] of Object.entries(headers)) {
        const key = name.toLowerCase();
        if (!BODY_RELATED_HEADER_NAMES.has(key) && values?.length) {
          filtered[name] = values;
        }
      }
      return { headersText: formatHeaders(filtered), body: '' };
    }

    if (BODY_METHODS.has(nextUpper) && body.trim().length > 0) {
      const headers = parseHeaderLines(headersText);
      const hasContentType = Object.keys(headers).some((k) => k.toLowerCase() === 'content-type');
      if (!hasContentType) {
        const added = { ...headers, 'Content-Type': ['text/plain; charset=utf-8'] };
        return { headersText: formatHeaders(added), body };
      }
    }

    return { headersText, body };
  } catch {
    return { headersText, body };
  }
}

const EMPTY_BASELINE = {
  method: 'GET',
  url: '',
  request: { headers: {} as Record<string, string[]>, bodyText: null, bodyBase64: null },
  response: { bodyJson: null, bodyText: null, bodyBase64: null },
  responseStatus: null,
  timing: { totalMs: null },
} as unknown as HttpMessageDetail;

export function RepeaterClient(props: {
  baseline: HttpMessageDetail | null;
  loading?: boolean;
}) {
  const baseline = props.baseline ?? EMPTY_BASELINE;
  const hasBaseline = props.baseline != null;

  const initialBodyMode: BodyMode =
    baseline.request?.bodyText != null ? 'text' : baseline.request?.bodyBase64 != null ? 'base64' : 'text';

  const [method, setMethod] = useState(baseline.method ?? 'GET');
  const [url, setUrl] = useState(baseline.url ?? '');
  const [headersText, setHeadersText] = useState(() =>
    baseline.request ? formatHeaders(baseline.request.headers) : '',
  );
  const [bodyMode, setBodyMode] = useState<BodyMode>(initialBodyMode);
  const [body, setBody] = useState(() =>
    baseline.request?.bodyText ?? baseline.request?.bodyBase64 ?? '',
  );

  // Sync form when baseline loads (e.g. tab restored from sessionStorage)
  const prevBaselineId = useRef<string | null>(null);
  useEffect(() => {
    const b = props.baseline;
    if (!b) {
      prevBaselineId.current = null;
      return;
    }
    if (prevBaselineId.current === b.id) return;
    prevBaselineId.current = b.id;
    setMethod(b.method ?? 'GET');
    setUrl(b.url ?? '');
    setHeadersText(b.request ? formatHeaders(b.request.headers) : '');
    setBodyMode(b.request?.bodyText != null ? 'text' : b.request?.bodyBase64 != null ? 'base64' : 'text');
    setBody(b.request?.bodyText ?? b.request?.bodyBase64 ?? '');
  }, [props.baseline]);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ReplayResponse | null>(null);

  const changeMethod = useCallback(
    (newMethod: string) => {
      const next = newMethod.trim() || 'GET';
      if (next === method) return;
      const transformed = applyMethodTransform(method, next, headersText, body);
      setMethod(next);
      setHeadersText(transformed.headersText);
      setBody(transformed.body);
    },
    [method, headersText, body],
  );

  const diff: ReplayDiff | null = result?.diff ?? null;
  const variant = result?.variant ?? null;
  const variantError = variant?.error ?? null;
  const variantHasResponseData =
    variant != null &&
    (variant.responseStatus != null ||
      Object.keys(variant.response?.headers ?? {}).length > 0 ||
      variant.response?.bodyJson != null ||
      variant.response?.bodyText != null ||
      variant.response?.bodyBase64 != null);

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
    if (!hasBaseline) {
      setError('Open a request from Call History to replay.');
      return;
    }
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

  if (props.loading) {
    return (
      <div className="flex flex-1 items-center justify-center p-4 text-[13px] text-[color:var(--cs-muted)]">
        Loading request…
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <section className="grid min-h-0 flex-1 grid-cols-1 gap-px bg-[color:var(--cs-border)] lg:grid-cols-2">
        {/* Request */}
        <div className="flex min-h-0 flex-col overflow-hidden bg-[color:var(--cs-panel)]">
          <div className="flex-shrink-0 border-b border-[color:var(--cs-border)] px-3 py-2 text-[10px] font-bold uppercase tracking-widest text-[color:var(--cs-muted)]">
            Request
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-3">
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={COMMON_METHODS.includes(method as (typeof COMMON_METHODS)[number]) ? method : CUSTOM_VALUE}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === CUSTOM_VALUE) return;
                  changeMethod(v);
                }}
                className="w-[110px] rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-2 py-1.5 font-mono text-[12px] outline-none focus:border-[color:var(--cs-accent)]"
              >
                {COMMON_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
                <option value={CUSTOM_VALUE}>Custom</option>
              </select>
              {!COMMON_METHODS.includes(method as (typeof COMMON_METHODS)[number]) && (
                <input
                  value={method}
                  onChange={(e) => changeMethod(e.target.value)}
                  placeholder="Method"
                  className="w-[100px] rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-2 py-1.5 font-mono text-[12px] outline-none focus:border-[color:var(--cs-accent)]"
                />
              )}
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://..."
                className="min-w-0 flex-1 rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-2 py-1.5 font-mono text-[12px] outline-none focus:border-[color:var(--cs-accent)]"
              />
            </div>

            <div className="mt-3">
              <div className="text-[10px] font-bold uppercase tracking-widest text-[color:var(--cs-muted)]">
                Headers
              </div>
              <textarea
                value={headersText}
                onChange={(e) => setHeadersText(e.target.value)}
                className="mt-2 h-[180px] w-full resize-none rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] p-2 font-mono text-[11px] leading-relaxed outline-none focus:border-[color:var(--cs-accent)]"
              />
            </div>

            <div className="mt-3">
              <div className="flex items-center justify-between">
                <div className="text-[10px] font-bold uppercase tracking-widest text-[color:var(--cs-muted)]">
                  Body
                </div>
                <div className="flex gap-1">
                  <button
                    type="button"
                    onClick={() => setBodyMode('text')}
                    className={[
                      'rounded px-2 py-1 text-[10px] font-medium',
                      bodyMode === 'text'
                        ? 'bg-[color:var(--cs-accent-soft)] text-[color:var(--cs-accent)]'
                        : 'text-[color:var(--cs-muted)] hover:bg-[color:var(--cs-hover)]',
                    ].join(' ')}
                  >
                    text
                  </button>
                  <button
                    type="button"
                    onClick={() => setBodyMode('base64')}
                    className={[
                      'rounded px-2 py-1 text-[10px] font-medium',
                      bodyMode === 'base64'
                        ? 'bg-[color:var(--cs-accent-soft)] text-[color:var(--cs-accent)]'
                        : 'text-[color:var(--cs-muted)] hover:bg-[color:var(--cs-hover)]',
                    ].join(' ')}
                  >
                    base64
                  </button>
                </div>
              </div>
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                className="mt-2 h-[180px] w-full resize-none rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] p-2 font-mono text-[11px] leading-relaxed outline-none focus:border-[color:var(--cs-accent)]"
              />
              <div className="mt-1 text-[11px] text-[color:var(--cs-muted)]">
                {bodyMode === 'base64'
                  ? 'Sending body as base64 bytes.'
                  : 'Sending body as UTF-8 text.'}
              </div>
            </div>

            <div className="mt-3 flex items-center gap-2">
              <button
                type="button"
                onClick={send}
                disabled={loading || !hasBaseline}
                className="rounded-lg bg-[color:var(--cs-accent)] px-3 py-2 text-[12px] font-medium text-white disabled:opacity-50"
              >
                {loading ? 'Sending…' : 'Send'}
              </button>
              {!hasBaseline && (
                <span className="text-[11px] text-[color:var(--cs-muted)]">
                  Open from Call History to replay.
                </span>
              )}
              {diffSummary && (
                <div className="text-[11px] text-[color:var(--cs-muted)]">
                  {diffSummary.statusChanged ? (
                    <span className="rounded bg-amber-500/20 px-2 py-0.5 text-amber-700 dark:text-amber-200">
                      status changed
                    </span>
                  ) : (
                    <span className="rounded bg-emerald-500/15 px-2 py-0.5 text-emerald-700 dark:text-emerald-200">
                      status same
                    </span>
                  )}{' '}
                  <span className="font-mono">
                    headersΔ={diffSummary.headerCount} jsonΔ={diffSummary.jsonChangeCount}
                  </span>
                </div>
              )}
            </div>

            {error && (
              <div className="mt-3 rounded-md border border-rose-500/30 bg-rose-500/10 p-2 font-mono text-[11px] text-rose-700 dark:text-rose-200">
                {error}
              </div>
            )}
          </div>
        </div>

        {/* Response */}
        <div className="flex min-h-0 flex-col overflow-hidden bg-[color:var(--cs-panel)]">
          <div className="flex-shrink-0 border-b border-[color:var(--cs-border)] px-3 py-2 text-[10px] font-bold uppercase tracking-widest text-[color:var(--cs-muted)]">
            Response
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-3">
            {variant ? (
              <div className="space-y-3">
                {variantError ? (
                  <div className="rounded-md border border-rose-500/40 bg-rose-500/10 p-2 font-mono text-[11px] text-rose-700 dark:text-rose-200">
                    {variantError}
                  </div>
                ) : null}
                {!variantError && !variantHasResponseData ? (
                  <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-[11px] text-amber-800 dark:text-amber-200">
                    Replayer returned no response data and no upstream error. This is unexpected.
                  </div>
                ) : null}

                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] p-2">
                    <div className="text-[10px] font-bold uppercase tracking-widest text-[color:var(--cs-muted)]">
                      Baseline
                    </div>
                    <div className="mt-1 font-mono text-[12px]">
                      {baseline.responseStatus == null ? '-' : baseline.responseStatus}
                    </div>
                    <div className="font-mono text-[11px] text-[color:var(--cs-muted)]">
                      total {fmtMs(baseline.timing?.totalMs ?? null)}
                    </div>
                  </div>
                  <div className="rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] p-2">
                    <div className="text-[10px] font-bold uppercase tracking-widest text-[color:var(--cs-muted)]">
                      Variant
                    </div>
                    <div className="mt-1 font-mono text-[12px]">
                      {variant.responseStatus == null ? '-' : variant.responseStatus}
                    </div>
                    <div className="font-mono text-[11px] text-[color:var(--cs-muted)]">
                      total {fmtMs(variant.timing?.totalMs ?? null)}
                    </div>
                  </div>
                </div>

                <ResponseHeadersCollapsible variant={variant} baseline={baseline} />

                <div className=" ">
                  <div>
                    <div className="text-[10px] font-bold uppercase tracking-widest text-[color:var(--cs-muted)]">
                      Baseline Body
                    </div>
                    <div className="mt-2">
                      <ResponseBodyView
                        bodyJson={baseline.response?.bodyJson ?? null}
                        bodyText={baseline.response?.bodyText ?? null}
                        bodyBase64={baseline.response?.bodyBase64 ?? null}
                        headers={baseline.response?.headers}
                        maxHeight="200px"
                        showViewToggle={true}
                      />
                    </div>
                  </div>
                  <div>
                    
                    <div className="mt-2">
                      <ResponseBodyView
                        bodyJson={variant.response?.bodyJson ?? null}
                        bodyText={variant.response?.bodyText ?? null}
                        bodyBase64={variant.response?.bodyBase64 ?? null}
                        headers={variant.response?.headers}
                        maxHeight="200px"
                        showViewToggle={true}
                      />
                    </div>
                  </div>
                </div>

                {diff && (
                  <div className="rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] p-2">
                    <div className="text-[10px] font-bold uppercase tracking-widest text-[color:var(--cs-muted)]">
                      Diff Summary
                    </div>
                    <div className="mt-2 space-y-1 text-[11px] text-[color:var(--cs-muted)]">
                      <div>
                        Status:{' '}
                        <span className="font-mono">
                          {diff.status.baseline ?? '-'} → {diff.status.variant ?? '-'}
                        </span>
                      </div>
                      <div>
                        Headers:{' '}
                        <span className="font-mono">
                          +{diff.headers.added.length} -{diff.headers.removed.length} Δ
                          {diff.headers.changed.length}
                        </span>
                      </div>
                      {diff.body.kind === 'json' ? (
                        <div>
                          JSON fields changed:{' '}
                          <span className="font-mono">{diff.body.jsonChanges.length}</span>
                          {diff.body.truncated ? ' (truncated)' : ''}
                        </div>
                      ) : (
                        <div>
                          Body changed:{' '}
                          <span className="font-mono">
                            {diff.body.changed ? 'yes' : 'no'} ({diff.body.kind})
                          </span>
                        </div>
                      )}
                    </div>
                    {diff.body.kind === 'json' && diff.body.jsonChanges.length > 0 && (
                      <div className="mt-2">
                        <div className="text-[10px] font-bold uppercase tracking-widest text-[color:var(--cs-muted)]">
                          Changed Paths
                        </div>
                        <div className="mt-2 max-h-[160px] overflow-auto rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] p-2 font-mono text-[11px]">
                          {diff.body.jsonChanges.map((c) => (
                            <div
                              key={c.path}
                              className="border-b border-[color:var(--cs-border)] py-1 last:border-0"
                            >
                              <div className="text-[color:var(--cs-fg)]">{c.path}</div>
                              <div className="text-[color:var(--cs-muted)]">
                                {JSON.stringify(c.before)} → {JSON.stringify(c.after)}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <div className="text-[13px] text-[color:var(--cs-muted)]">
                Send a variant to view response + diff.
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
