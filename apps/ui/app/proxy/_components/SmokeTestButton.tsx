'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Button } from '@/components/ui/button';

type SmokeOk = { ok: true; messageId: string; url: string; statusCode: number };
type SmokeErr = { ok: false; error?: { code?: string; message?: string } };

export function SmokeTestButton() {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<SmokeOk | SmokeErr | null>(null);

  async function run() {
    setLoading(true);
    setResult(null);
    try {
      const res = await fetch('/api/proxy/smoke', { method: 'POST' });
      const json = (await res.json()) as unknown;
      if (json && typeof json === 'object' && 'ok' in json) {
        setResult(json as SmokeOk | SmokeErr);
      } else {
        setResult({ ok: false, error: { code: 'bad_response', message: 'Bad response.' } });
      }
    } catch (err) {
      setResult({
        ok: false,
        error: { code: 'network_error', message: err instanceof Error ? err.message : 'Failed.' },
      });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="secondary" onClick={run} disabled={loading}>
          {loading ? 'Running…' : 'Generate Test Traffic'}
        </Button>
        {result && result.ok ? (
          <Button asChild variant="outline">
            <Link href={`/history/${encodeURIComponent(result.messageId)}`}>Open Captured Message</Link>
          </Button>
        ) : null}
      </div>

      {result ? (
        result.ok ? (
          <div className="font-mono text-xs text-muted-foreground">
            Captured: {result.statusCode} {result.url}
          </div>
        ) : (
          <div className="font-mono text-xs text-destructive">
            {result.error?.message ?? 'Smoke test failed.'}
          </div>
        )
      ) : (
        <div className="text-xs text-muted-foreground">
          This creates internal traffic through the proxy to confirm capture is working (it does
          not prove your browser is configured correctly).
        </div>
      )}
    </div>
  );
}

