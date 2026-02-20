'use client';

import { ContractAuditRunResponseSchema } from '@cipherscope/proto';
import { Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  saveContractSandboxPrefill,
  useRpcInteractions,
  type ContractSandboxPrefill,
  type RpcInteraction,
} from '@/lib/foundry-store';
import { translateTxParams } from '@/lib/rpc-translate';
import { HorizontalResizable } from '../../_components/HorizontalResizable';

type SourceFilter = 'all' | 'wallet' | 'dev' | 'foundry';
type StatusFilter = 'all' | 'success' | 'error';

function toPrettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function shortHex(value: string | null | undefined, max = 18): string {
  if (!value) return '-';
  if (value.length <= max) return value;
  return `${value.slice(0, max - 6)}...${value.slice(-4)}`;
}

function txMethodToSimulateOnly(method: string): boolean {
  const normalized = method.toLowerCase();
  return normalized === 'eth_call' || normalized === 'eth_estimategas';
}

function isDevAccountTransaction(item: RpcInteraction): boolean {
  return item.source === 'foundry' && item.method.toLowerCase() === 'eth_sendtransaction' && !!item.tx?.from;
}

function sourceLabel(item: RpcInteraction): string {
  if (item.source === 'wallet') return 'wallet';
  if (isDevAccountTransaction(item)) return 'dev';
  return 'foundry';
}

function buildSandboxPrefill(item: RpcInteraction): ContractSandboxPrefill | null {
  if (!item.tx?.to) return null;
  return {
    sourceInteractionId: item.id,
    method: item.method,
    from: item.tx.from,
    to: item.tx.to,
    data: item.tx.data ?? '0x',
    value: item.tx.value,
    gas: item.tx.gas,
    simulateOnly: txMethodToSimulateOnly(item.method),
    abiJson: null,
    label: null,
    createdAt: new Date().toISOString(),
  };
}

export function RpcHistoryPanel(props: {
  initialSelectedId?: string | null;
  initialSearch?: string | null;
} = {}) {
  const router = useRouter();
  const { interactions, clear } = useRpcInteractions();
  const [search, setSearch] = useState(props.initialSearch ?? '');
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(props.initialSelectedId ?? null);
  const [actionStatus, setActionStatus] = useState<string | null>(null);
  const [auditRunning, setAuditRunning] = useState(false);

  useEffect(() => {
    if (props.initialSearch === undefined) return;
    setSearch(props.initialSearch ?? '');
  }, [props.initialSearch]);

  useEffect(() => {
    if (props.initialSelectedId === undefined) return;
    setSelectedId(props.initialSelectedId ?? null);
  }, [props.initialSelectedId]);

  const filtered = useMemo(() => {
    let out = interactions;
    if (sourceFilter !== 'all') {
      out = out.filter((item) => {
        if (sourceFilter === 'wallet') return item.source === 'wallet';
        if (sourceFilter === 'dev') return isDevAccountTransaction(item);
        return item.source === 'foundry';
      });
    }
    if (statusFilter !== 'all') out = out.filter((item) => item.status === statusFilter);
    if (search) {
      const query = search.toLowerCase();
      out = out.filter((item) => {
        const tx = item.tx;
        return (
          item.method.toLowerCase().includes(query) ||
          item.source.toLowerCase().includes(query) ||
          (item.txHash ?? '').toLowerCase().includes(query) ||
          (tx?.from ?? '').toLowerCase().includes(query) ||
          (tx?.to ?? '').toLowerCase().includes(query) ||
          (item.error ?? '').toLowerCase().includes(query)
        );
      });
    }
    return out;
  }, [interactions, search, sourceFilter, statusFilter]);

  useEffect(() => {
    if (filtered.length === 0) {
      setSelectedId(null);
      return;
    }
    if (!selectedId || !filtered.some((item) => item.id === selectedId)) {
      setSelectedId(filtered[0].id);
    }
  }, [filtered, selectedId]);

  const selected = useMemo(
    () => filtered.find((item) => item.id === selectedId) ?? null,
    [filtered, selectedId],
  );

  const selectedPrefill = useMemo(
    () => (selected ? buildSandboxPrefill(selected) : null),
    [selected],
  );

  const translatedTx = useMemo(
    () => (selected?.tx ? translateTxParams(selected.tx) : null),
    [selected?.tx],
  );

  function onSendToSandbox() {
    if (!selected || !selectedPrefill) {
      setActionStatus('Selected RPC interaction cannot populate Contract Sandbox.');
      return;
    }
    saveContractSandboxPrefill(selectedPrefill);
    router.push('/');
  }

  function onClearHistory() {
    clear();
    setActionStatus('RPC history cleared.');
  }

  async function onRunSecurityAudit() {
    if (!selected || !selected.tx?.to) {
      setActionStatus('Selected RPC interaction does not include tx.to for contract audit.');
      return;
    }
    setAuditRunning(true);
    setActionStatus(null);
    try {
      const res = await fetch('/api/audit/contracts/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sourceInteractionId: selected.id,
          method: selected.method,
          rpcUrl: selected.rpcUrl ?? null,
          chainId: selected.chainId ?? null,
          tx: {
            from: selected.tx.from ?? null,
            to: selected.tx.to,
            data: selected.tx.data ?? '0x',
            value: selected.tx.value ?? null,
            gas: selected.tx.gas ?? null,
          },
        }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        const message = (json as { error?: { message?: unknown } } | null)?.error?.message;
        throw new Error(typeof message === 'string' ? message : `Contract audit failed (${res.status}).`);
      }

      const parsed = ContractAuditRunResponseSchema.safeParse(json);
      if (!parsed.success) {
        throw new Error('Unexpected contract audit payload.');
      }

      const findingsCount = parsed.data.summary.findingsTotal;
      setActionStatus(
        `Contract audit completed: ${findingsCount} finding${findingsCount === 1 ? '' : 's'} updated.`,
      );
      router.push(`/audit?messageId=${encodeURIComponent(selected.id)}`);
    } catch (err) {
      setActionStatus(err instanceof Error ? err.message : 'Failed to run contract audit.');
    } finally {
      setAuditRunning(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-[color:var(--cs-panel)]">
      <div className="flex flex-wrap items-center gap-3 border-b border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-3 py-2">
        <div className="flex items-center gap-2">
          <label className="text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">Search</label>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="method, address, hash..."
            className="h-7 w-56 rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 text-[12px] outline-none focus:border-[color:var(--cs-accent)]"
          />
        </div>
        <div className="flex items-center gap-2">
          <label className="text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">Source</label>
          <select
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value as SourceFilter)}
            className="h-7 rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 text-[12px] outline-none focus:border-[color:var(--cs-accent)]"
          >
            <option value="all">All</option>
            <option value="wallet">Wallet</option>
            <option value="dev">Dev Account Tx</option>
            <option value="foundry">Foundry</option>
          </select>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">Status</label>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
            className="h-7 rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 text-[12px] outline-none focus:border-[color:var(--cs-accent)]"
          >
            <option value="all">All</option>
            <option value="success">Success</option>
            <option value="error">Error</option>
          </select>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <div className="text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">{filtered.length} Results</div>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-[color:var(--cs-muted)] hover:text-[color:var(--cs-fg)]"
                onClick={onClearHistory}
                aria-label="Clear history"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Clear history</TooltipContent>
          </Tooltip>
        </div>
      </div>

      <HorizontalResizable storageKey="rpc-history-inspector-width" defaultRatio={0.42}>
        <div className="flex min-h-0 flex-col overflow-hidden border-r border-[color:var(--cs-border)]">
          <div className="grid grid-cols-[90px_68px_1fr_72px] border-b border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-2 py-1 text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">
            <div>Time</div>
            <div>Source</div>
            <div>Method</div>
            <div className="text-right">Status</div>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {filtered.length === 0 ? (
              <div className="p-6 text-[12px] text-[color:var(--cs-muted)]">No RPC interactions captured yet.</div>
            ) : (
              filtered.map((item) => {
                const isSelected = item.id === selectedId;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setSelectedId(item.id)}
                    className={[
                      'grid w-full grid-cols-[90px_68px_1fr_72px] items-center border-b border-[color:var(--cs-border)] px-2 py-2 text-left font-mono text-[11px]',
                      isSelected ? 'bg-[color:var(--cs-accent-soft)]' : 'bg-[color:var(--cs-panel)] hover:bg-[color:var(--cs-hover)]',
                    ].join(' ')}
                  >
                    <div className="text-[color:var(--cs-muted)]">
                      {new Date(item.createdAt).toLocaleTimeString([], { hour12: false })}
                    </div>
                    <div className="uppercase">{sourceLabel(item)}</div>
                    <div className="truncate pr-2">{item.method}</div>
                    <div className={['text-right font-bold', item.status === 'error' ? 'text-rose-600' : 'text-emerald-600'].join(' ')}>
                      {item.status}
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[color:var(--cs-panel-soft)]">
          {!selected ? (
            <div className="flex min-h-0 flex-1 items-center justify-center p-4 text-[12px] text-[color:var(--cs-muted)]">
              Select an RPC interaction.
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              <div className="flex flex-wrap items-center gap-2 border-b border-[color:var(--cs-border)] px-3 py-2 text-[12px]">
                <span className="rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 py-1 font-mono">{selected.method}</span>
                <span className="rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 py-1 font-mono uppercase">{sourceLabel(selected)}</span>
                <span className="text-[color:var(--cs-muted)]">{new Date(selected.createdAt).toLocaleString()}</span>
                {selected.durationMs != null ? (
                  <span className="text-[color:var(--cs-muted)]">{selected.durationMs.toFixed(1)}ms</span>
                ) : null}
                <button
                  type="button"
                  onClick={onSendToSandbox}
                  disabled={!selectedPrefill}
                  className="ml-auto rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 py-1 text-[11px] font-semibold text-[color:var(--cs-fg)] hover:bg-[color:var(--cs-hover)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Send to Contract Sandbox
                </button>
                <button
                  type="button"
                  onClick={() => void onRunSecurityAudit()}
                  disabled={auditRunning || !selected.tx?.to}
                  className="rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-accent)] px-2 py-1 text-[11px] font-semibold text-white hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {auditRunning ? 'Auditing…' : 'Run Security Audit'}
                </button>
              </div>
              <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto p-3">
                {actionStatus ? (
                  <div className="mb-3 rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 py-1 text-[11px] text-[color:var(--cs-muted)]">
                    {actionStatus}
                  </div>
                ) : null}

                <div className="mb-3 grid min-w-0 gap-2 text-[11px] text-[color:var(--cs-muted)] md:grid-cols-2">
                  <div className="min-w-0 rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] p-2">
                    RPC URL: <span className="block min-w-0 break-all font-mono text-[color:var(--cs-fg)]">{selected.rpcUrl ?? '-'}</span>
                  </div>
                  <div className="min-w-0 rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] p-2">
                    Chain: <span className="block min-w-0 break-all font-mono text-[color:var(--cs-fg)]">{selected.chainId ?? '-'}</span>
                  </div>
                  <div className="min-w-0 rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] p-2">
                    Tx Hash: <span className="block min-w-0 break-all font-mono text-[color:var(--cs-fg)]">{shortHex(selected.txHash, 28)}</span>
                  </div>
                  <div className="min-w-0 rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] p-2">
                    Error: <span className="block min-w-0 break-all font-mono text-[color:var(--cs-fg)]">{selected.error ?? '-'}</span>
                  </div>
                </div>

                {selected.tx ? (
                  <div className="mb-3 min-w-0 rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] p-2">
                    <div className="mb-1 text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">Transaction Params</div>
                    <div className="grid min-w-0 gap-1 font-mono text-[11px] text-[color:var(--cs-fg)]">
                      <div className="min-w-0 break-all">from: {translatedTx?.from ?? selected.tx.from ?? '-'}</div>
                      <div className="min-w-0 break-all">to: {translatedTx?.to ?? selected.tx.to ?? '-'}</div>
                      <div className="min-w-0 break-all">
                        value: {selected.tx.value ?? '-'}
                        {translatedTx?.valueEth != null ? (
                          <span className="ml-1 text-[color:var(--cs-muted)]">({translatedTx.valueEth} ETH)</span>
                        ) : null}
                      </div>
                      <div className="min-w-0 break-all">
                        gas: {translatedTx?.gas ?? selected.tx.gas ?? '-'}
                      </div>
                      <div className="min-w-0 break-all">
                        data: {selected.tx.data ?? '-'}
                        {translatedTx?.dataDecoded ? (
                          <span className="ml-1 text-[color:var(--cs-accent)]">({translatedTx.dataDecoded})</span>
                        ) : null}
                      </div>
                    </div>
                  </div>
                ) : null}

                <div className="min-w-0 rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)]">
                  <div className="border-b border-[color:var(--cs-border)] px-2 py-1 text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">
                    Params
                  </div>
                  <pre className="max-h-[280px] overflow-x-hidden overflow-y-auto p-2 font-mono text-[11px] leading-relaxed text-[color:var(--cs-fg)] whitespace-pre-wrap break-all">
                    {toPrettyJson(selected.params)}
                  </pre>
                </div>
              </div>
            </div>
          )}
        </div>
      </HorizontalResizable>
    </div>
  );
}
