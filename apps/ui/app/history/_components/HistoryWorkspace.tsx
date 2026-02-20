'use client';

import { useState } from 'react';
import { HistoryView } from './HistoryView';
import { RpcHistoryPanel } from './RpcHistoryPanel';

type HistoryPanel = 'http' | 'rpc';

export function HistoryWorkspace(props: {
  initialPanel?: HistoryPanel;
  httpInitialSelectedId?: string | null;
  httpInitialSearch?: string | null;
  rpcInitialSelectedId?: string | null;
  rpcInitialSearch?: string | null;
}) {
  const [activePanel, setActivePanel] = useState<HistoryPanel>(props.initialPanel ?? 'http');

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 border-b border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-3 pt-2">
        <button
          type="button"
          onClick={() => setActivePanel('http')}
          className={[
            'rounded-t-md border border-b-0 px-3 py-1.5 text-[12px] font-semibold',
            activePanel === 'http'
              ? 'border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] text-[color:var(--cs-fg)]'
              : 'border-transparent bg-transparent text-[color:var(--cs-muted)] hover:text-[color:var(--cs-fg)]',
          ].join(' ')}
        >
          HTTP / WS
        </button>
        <button
          type="button"
          onClick={() => setActivePanel('rpc')}
          className={[
            'rounded-t-md border border-b-0 px-3 py-1.5 text-[12px] font-semibold',
            activePanel === 'rpc'
              ? 'border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] text-[color:var(--cs-fg)]'
              : 'border-transparent bg-transparent text-[color:var(--cs-muted)] hover:text-[color:var(--cs-fg)]',
          ].join(' ')}
        >
          Wallet RPC
        </button>
      </div>

      <div className="min-h-0 flex-1">
        {activePanel === 'http' ? (
          <HistoryView
            initialSelectedId={props.httpInitialSelectedId}
            initialSearch={props.httpInitialSearch}
          />
        ) : (
          <RpcHistoryPanel
            initialSelectedId={props.rpcInitialSelectedId}
            initialSearch={props.rpcInitialSearch}
          />
        )}
      </div>
    </div>
  );
}
