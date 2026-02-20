'use client';

import Prism from 'prismjs';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-markup';
import { Highlight } from 'prism-react-renderer';
import { useEffect, useMemo, useState } from 'react';

export type ResponseBodyViewProps = {
  bodyJson: unknown;
  bodyText: string | null;
  bodyBase64: string | null;
  headers?: Record<string, string[]>;
  className?: string;
  maxHeight?: string;
  showViewToggle?: boolean;
};

type BodyType = 'json' | 'html' | 'xml' | 'text' | 'binary';

function getContentType(headers: Record<string, string[]> | undefined): string | null {
  if (!headers) return null;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === 'content-type');
  if (!key) return null;
  const vals = headers[key];
  return vals?.[0]?.trim() ?? null;
}

function detectBodyType(
  bodyJson: unknown,
  bodyText: string | null,
  bodyBase64: string | null,
  contentType: string | null,
): BodyType {
  if (bodyJson != null) return 'json';
  const hasText = bodyText != null && bodyText.length > 0;
  const hasBase64 = bodyBase64 != null && bodyBase64.length > 0;
  const ct = (contentType ?? '').toLowerCase();

  if (hasBase64 && !hasText) return 'binary';
  if (ct.includes('application/octet-stream') && hasBase64) return 'binary';

  if (hasText) {
    const trimmed = bodyText.trim();
    if (ct.includes('application/json') || ct.includes('+json')) {
      try {
        JSON.parse(bodyText);
        return 'json';
      } catch {
        // fall through
      }
    }
    if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && trimmed.length > 1) {
      try {
        JSON.parse(bodyText);
        return 'json';
      } catch {
        // fall through
      }
    }
    if (ct.includes('text/html') || /^\s*<!DOCTYPE/i.test(trimmed) || /^\s*<html[\s>]/i.test(trimmed))
      return 'html';
    if (
      ct.includes('application/xml') ||
      ct.includes('text/xml') ||
      ct.includes('+xml') ||
      /^\s*<\?xml/i.test(trimmed) ||
      (trimmed.startsWith('<') && /^\s*<[\w-]+[\s>]/.test(trimmed))
    )
      return 'xml';
  }

  return hasText ? 'text' : hasBase64 ? 'binary' : 'text';
}

function tryPrettyJson(bodyJson: unknown, bodyText: string | null): string | null {
  if (bodyJson != null) {
    try {
      return JSON.stringify(bodyJson, null, 2);
    } catch {
      return null;
    }
  }
  if (bodyText == null || !bodyText.trim()) return null;
  try {
    const parsed = JSON.parse(bodyText);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return null;
  }
}

function prettyPrintMarkup(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return raw;
  const singleLine = trimmed.replace(/>\s*</g, '>\n<');
  const lines = singleLine.split('\n');
  let depth = 0;
  const out: string[] = [];
  const indent = '  ';
  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;
    const isClose = /^<\s*\//.test(s);
    if (isClose && depth > 0) depth--;
    out.push(indent.repeat(depth) + s);
    if (!isClose && /<([\w-]+)[^>]*>(?!\s*<\/\1>)/.test(s) && !s.startsWith('<?') && !s.startsWith('<!'))
      depth++;
  }
  return out.join('\n');
}

function getDisplayContent(
  bodyJson: unknown,
  bodyText: string | null,
  bodyBase64: string | null,
  bodyType: BodyType,
  pretty: boolean,
): { content: string; type: BodyType; byteLength?: number } {
  if (bodyType === 'binary') {
    const raw = bodyBase64 ?? '';
    let byteLength = 0;
    try {
      byteLength = atob(raw.replace(/\s/g, '')).length;
    } catch {
      byteLength = Math.floor((raw.length * 3) / 4);
    }
    return { content: pretty ? `Binary (${byteLength} bytes)` : raw, type: 'binary', byteLength };
  }

  if (bodyType === 'json') {
    const formatted = tryPrettyJson(bodyJson, bodyText);
    const display = pretty && formatted != null ? formatted : bodyText ?? '';
    return { content: display, type: 'json' };
  }

  if (bodyType === 'html' || bodyType === 'xml') {
    const raw = bodyText ?? '';
    const display = pretty ? prettyPrintMarkup(raw) : raw;
    return { content: display, type: bodyType };
  }

  return { content: bodyText ?? bodyBase64 ?? '(empty)', type: 'text' };
}

const PRE_CLASS =
  'min-w-0 overflow-x-auto whitespace-pre font-mono text-[11px] leading-relaxed rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] p-2';

export function ResponseBodyView(props: ResponseBodyViewProps) {
  const {
    bodyJson,
    bodyText,
    bodyBase64,
    headers,
    className = '',
    maxHeight = '200px',
    showViewToggle = true,
  } = props;

  const contentType = useMemo(() => getContentType(headers), [headers]);
  const bodyType = useMemo(
    () => detectBodyType(bodyJson, bodyText, bodyBase64, contentType),
    [bodyJson, bodyText, bodyBase64, contentType],
  );

  const defaultPretty = bodyType === 'json' || bodyType === 'html' || bodyType === 'xml';
  const [pretty, setPretty] = useState(defaultPretty);
  useEffect(() => {
    setPretty(defaultPretty);
  }, [defaultPretty]);

  const { content, type } = useMemo(
    () => getDisplayContent(bodyJson, bodyText, bodyBase64, bodyType, pretty),
    [bodyJson, bodyText, bodyBase64, bodyType, pretty],
  );

  const isEmpty = bodyJson == null && (bodyText == null || bodyText === '') && (bodyBase64 == null || bodyBase64 === '');
  const usePrism = pretty && (type === 'json' || type === 'html' || type === 'xml') && content && content !== '(empty)';

  return (
    <div className={className}>
      {showViewToggle && !isEmpty && (
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[10px] font-medium uppercase tracking-wider text-[color:var(--cs-muted)]">
            {type}
          </span>
          <div className="flex gap-1">
            <button
              type="button"
              onClick={() => setPretty(true)}
              className={
                pretty
                  ? 'rounded px-2 py-1 text-[10px] font-medium bg-[color:var(--cs-accent-soft)] text-[color:var(--cs-accent)]'
                  : 'rounded px-2 py-1 text-[10px] font-medium text-[color:var(--cs-muted)] hover:bg-[color:var(--cs-hover)]'
              }
            >
              Pretty
            </button>
            <button
              type="button"
              onClick={() => setPretty(false)}
              className={
                !pretty
                  ? 'rounded px-2 py-1 text-[10px] font-medium bg-[color:var(--cs-accent-soft)] text-[color:var(--cs-accent)]'
                  : 'rounded px-2 py-1 text-[10px] font-medium text-[color:var(--cs-muted)] hover:bg-[color:var(--cs-hover)]'
              }
            >
              Raw
            </button>
          </div>
        </div>
      )}
      <div className="overflow-auto rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)]" style={{ maxHeight }}>
        {isEmpty ? (
          <pre className={`${PRE_CLASS} text-[color:var(--cs-muted)]`} style={{ maxHeight }}>(empty)</pre>
        ) : usePrism ? (
          <Highlight
            theme={undefined as never}
            prism={Prism as never}
            code={content}
            language={type === 'json' ? 'json' : 'markup'}
          >
            {({ className: highlightClassName, style, tokens, getLineProps, getTokenProps }) => (
              <pre
                className={`${highlightClassName} ${PRE_CLASS} !m-0 !rounded-md !border-0 !bg-transparent !p-2`}
                style={{ ...style, maxHeight }}
              >
                {tokens.map((line, i) => (
                  <div key={i} {...getLineProps({ line })}>
                    {line.map((token, key) => (
                      <span key={key} {...getTokenProps({ token })} />
                    ))}
                  </div>
                ))}
              </pre>
            )}
          </Highlight>
        ) : (
          <pre className={`${PRE_CLASS} !m-0`} style={{ maxHeight }}>
            {content}
          </pre>
        )}
      </div>
    </div>
  );
}
