'use client';

import { AgentClient } from '@cipherscope/sdk';
import type { AgentMetrics } from '@cipherscope/proto';
import { useEffect, useMemo, useState } from 'react';

type ConnState = 'connecting' | 'connected' | 'error';

const defaultWsUrl = process.env.NEXT_PUBLIC_AGENT_WS_URL ?? 'ws://127.0.0.1:17400';

export function AgentLiveBadge() {
  const [state, setState] = useState<ConnState>('connecting');

  useEffect(() => {
    const ws = new WebSocket(`${defaultWsUrl.replace(/\/$/, '')}/events`);

    ws.addEventListener('open', () => setState('connected'));
    ws.addEventListener('close', () => setState('connecting'));
    ws.addEventListener('error', () => setState('error'));

    return () => ws.close();
  }, []);

  const pill = (() => {
    switch (state) {
      case 'connected':
        return {
          text: 'Agent: live',
          cls: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
        };
      case 'error':
        return { text: 'Agent: error', cls: 'bg-rose-500/15 text-rose-700 dark:text-rose-300' };
      default:
        return { text: 'Agent: ...', cls: 'bg-amber-500/15 text-amber-700 dark:text-amber-300' };
    }
  })();

  return (
    <div className={`rounded-xl px-3 py-2 text-xs font-medium ${pill.cls}`} title={defaultWsUrl}>
      {pill.text}
    </div>
  );
}

export function AgentLiveStatus() {
  const [conn, setConn] = useState<ConnState>('connecting');
  const [metrics, setMetrics] = useState<AgentMetrics | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);

  const client = useMemo(
    () =>
      new AgentClient({
        httpBaseUrl: defaultWsUrl.replace(/^ws/, 'http').replace(/\/$/, ''),
        wsBaseUrl: defaultWsUrl.replace(/\/$/, ''),
      }),
    [],
  );

  useEffect(() => {
    const ws = client.connectEvents({
      onEvent: (evt) => {
        if (evt.type === 'hello') {
          setConn('connected');
          setLastError(null);
        }
        if (evt.type === 'metrics') {
          setConn('connected');
          setMetrics(evt.metrics);
        }
      },
      onError: (err) => {
        setConn('error');
        setLastError(err instanceof Error ? err.message : String(err));
      },
    });

    ws.addEventListener('close', () => setConn('connecting'));

    return () => ws.close();
  }, [client]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-4">
        <div className="text-sm">
          <span className="font-medium">Connection:</span>{' '}
          <span className="font-mono text-xs text-[color:var(--cs-muted)]">{conn}</span>
        </div>
        <div className="font-mono text-xs text-[color:var(--cs-muted)]">{defaultWsUrl}</div>
      </div>

      {metrics ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Metric label="HTTP Requests" value={metrics.httpRequestsTotal} />
          <Metric label="WS Messages" value={metrics.wsMessagesTotal} />
          <Metric label="DB Writes" value={metrics.db.writesTotal} />
          <Metric
            label="DB Last Write (ms)"
            value={metrics.db.lastWriteMs == null ? 'n/a' : metrics.db.lastWriteMs.toFixed(2)}
          />
        </div>
      ) : (
        <div className="text-sm text-[color:var(--cs-muted)]">
          Waiting for agent metrics events...
        </div>
      )}

      {lastError ? (
        <div className="rounded-lg border border-[color:var(--cs-border)] bg-rose-500/10 p-3 font-mono text-xs text-rose-700 dark:text-rose-200">
          {lastError}
        </div>
      ) : null}
    </div>
  );
}

function Metric(props: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-[color:var(--cs-border)] bg-white/40 p-3 dark:bg-black/20">
      <div className="text-[10px] uppercase tracking-widest text-[color:var(--cs-muted)]">
        {props.label}
      </div>
      <div className="mt-1 font-mono text-xs">{props.value}</div>
    </div>
  );
}
