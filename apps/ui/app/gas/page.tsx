'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { profileGasForTransaction, type GasCallNode, type GasOpcodeHotspot, type GasProfile } from '@/lib/gas-profiler';
import { useFoundrySettings, useRpcInteractions, useSandboxTransactions } from '@/lib/foundry-store';

export default function GasProfilerPage() {
  const { settings } = useFoundrySettings();
  const { transactions } = useSandboxTransactions();
  const { interactions } = useRpcInteractions();

  const [txHash, setTxHash] = useState<string>('');
  const [selectedCallId, setSelectedCallId] = useState<string | null>(null);
  const [profile, setProfile] = useState<GasProfile | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  const txHashSuggestions = useMemo(() => {
    const fromTx = transactions.map((t) => t.hash);
    const fromRpc = interactions.map((it) => it.txHash).filter((v): v is string => typeof v === 'string');
    const unique = new Map<string, string>();
    for (const h of [...fromTx, ...fromRpc]) {
      const key = h.toLowerCase();
      if (!unique.has(key)) unique.set(key, h);
    }
    return [...unique.values()].slice(0, 80);
  }, [transactions, interactions]);

  useEffect(() => {
    // Prefill with most recent hash if the user hasn't typed anything.
    if (txHash.trim()) return;
    if (txHashSuggestions.length) setTxHash(txHashSuggestions[0] ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [txHashSuggestions.join('|')]);

  const selectedCall = useMemo(() => {
    if (!profile || !selectedCallId) return null;
    return profile.calls.find((c) => c.id === selectedCallId) ?? null;
  }, [profile, selectedCallId]);

  const totalGasUsed = useMemo(() => {
    if (!profile?.receiptGasUsed) return null;
    return profile.receiptGasUsed;
  }, [profile]);

  const hotspots = useMemo(() => {
    const ops = profile?.opcodes ?? [];
    return ops.slice(0, 4);
  }, [profile]);

  const runProfile = async () => {
    setError(null);
    setLoading(true);
    setProfile(null);
    setSelectedCallId(null);
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const next = await profileGasForTransaction({
        rpcUrl: settings.rpcUrl,
        chainId: settings.chainId,
        txHash,
        signal: controller.signal,
      });
      setProfile(next);
      if (next.calls.length) setSelectedCallId(next.calls[0]!.id);
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : 'Gas profiling failed (unknown error).';
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-[color:var(--cs-panel)]">
      <div className="flex items-center justify-between border-b border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-3 py-1.5">
        <h3 className="text-[11px] font-bold uppercase tracking-wider text-[color:var(--cs-fg)]">Gas Consumption Profiler</h3>
        <div className="flex items-center gap-3 text-[10px] text-[color:var(--cs-muted)] font-bold uppercase">
          <span className="hidden sm:inline">RPC: {settings.rpcUrl}</span>
          <span>
            Total:{' '}
            <span className="text-[color:var(--cs-fg)]">
              {totalGasUsed != null ? formatInt(totalGasUsed) : 'n/a'}
            </span>{' '}
            Units
          </span>
          <span>
            Trace Coverage:{' '}
            <span className="text-[color:var(--cs-fg)]">
              {profile?.traceCoveragePct != null ? `${profile.traceCoveragePct.toFixed(2)}%` : 'n/a'}
            </span>
          </span>
        </div>
      </div>

      <div className="border-b border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-3 py-2">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <label className="text-[10px] font-bold uppercase text-[color:var(--cs-muted)] shrink-0">Tx Hash</label>
            <input
              value={txHash}
              onChange={(e) => setTxHash(e.target.value)}
              list="txhash-suggestions"
              placeholder="0x…"
              className="min-w-0 flex-1 rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-2 py-1 text-[12px] font-mono text-[color:var(--cs-fg)] outline-none focus:border-[color:var(--cs-accent)]"
            />
            <datalist id="txhash-suggestions">
              {txHashSuggestions.map((h) => (
                <option key={h} value={h} />
              ))}
            </datalist>
            <button
              onClick={() => void runProfile()}
              disabled={loading}
              className={[
                'rounded px-2 py-1 text-[11px] font-bold uppercase',
                loading
                  ? 'bg-[color:var(--cs-border)] text-[color:var(--cs-muted)] cursor-not-allowed'
                  : 'bg-[color:var(--cs-accent)] text-[color:var(--cs-panel)] hover:opacity-90',
              ].join(' ')}
            >
              {loading ? 'Profiling…' : 'Profile'}
            </button>
          </div>

          <div className="flex items-center gap-3 text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">
            <span>Status: {profile?.receiptStatus ?? 'n/a'}</span>
            <span>Calls: {profile?.calls.length ?? 0}</span>
            <span>Ops: {profile?.opcodes.length ?? 0}</span>
          </div>
        </div>
        {error ? (
          <div className="mt-2 rounded border border-rose-500/30 bg-rose-500/10 px-2 py-1 text-[11px] text-rose-200">
            {error}
          </div>
        ) : null}
      </div>

      <div className="flex-1 min-h-0 flex overflow-hidden">
        <div className="w-1/2 border-r border-[color:var(--cs-border)] flex flex-col">
          <div className="px-3 py-1 bg-[color:var(--cs-panel-soft)] text-[10px] font-bold uppercase text-[color:var(--cs-muted)] border-b border-[color:var(--cs-border)]">
            Execution Flow & Stack
          </div>
          <div className="flex-1 overflow-auto p-3 space-y-1">
            {profile?.calls?.length ? (
              profile.calls.map((item, i) => (
                <button
                  type="button"
                  key={item.id}
                  onClick={() => setSelectedCallId(item.id)}
                  className={[
                    'w-full text-left flex items-center justify-between text-[11px] font-mono p-1.5 rounded border transition-colors',
                    selectedCallId === item.id
                      ? 'bg-[color:var(--cs-hover)] border-[color:var(--cs-accent)]'
                      : 'bg-[color:var(--cs-panel)] border-[color:var(--cs-border)] hover:bg-[color:var(--cs-hover)]',
                  ].join(' ')}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-[color:var(--cs-muted)] w-6 text-center shrink-0">{i + 1}</span>
                    <span
                      style={{ paddingLeft: `${item.depth * 12}px` }}
                      className="text-[color:var(--cs-fg)] truncate"
                      title={callLabel(item)}
                    >
                      {item.depth > 0 && '↳ '}
                      {callLabel(item)}
                    </span>
                  </div>
                  <span className="text-[color:var(--cs-accent)] font-bold shrink-0">
                    {item.gasUsed != null ? formatInt(item.gasUsed) : 'n/a'}
                  </span>
                </button>
              ))
            ) : (
              <EmptyPanel
                title={loading ? 'Profiling in progress' : 'No trace yet'}
                subtitle={
                  loading
                    ? 'Waiting for debug_traceTransaction…'
                    : 'Pick a tx hash and click Profile.'
                }
              />
            )}
          </div>
        </div>

        <div className="flex-1 flex flex-col">
          <div className="px-3 py-1 bg-[color:var(--cs-panel-soft)] text-[10px] font-bold uppercase text-[color:var(--cs-muted)] border-b border-[color:var(--cs-border)]">
            Opcode Breakdown
          </div>
          <div className="flex-1 flex flex-col min-h-0">
            <div className="flex-1 min-h-0 overflow-auto p-3">
              {selectedCall ? (
                <div className="mb-3 rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] p-2">
                  <div className="text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">Selected Call</div>
                  <div className="mt-1 grid grid-cols-2 gap-2 text-[11px] font-mono text-[color:var(--cs-fg)]">
                    <Detail label="to" value={selectedCall.to ?? 'n/a'} />
                    <Detail label="from" value={selectedCall.from ?? 'n/a'} />
                    <Detail label="type" value={selectedCall.type ?? 'n/a'} />
                    <Detail label="selector" value={selectedCall.selector ?? 'n/a'} />
                    <Detail
                      label="gasUsed"
                      value={selectedCall.gasUsed != null ? formatInt(selectedCall.gasUsed) : 'n/a'}
                    />
                    <Detail
                      label="input"
                      value={selectedCall.inputSize != null ? `${selectedCall.inputSize} bytes` : 'n/a'}
                    />
                  </div>
                </div>
              ) : null}

              {profile?.opcodes?.length ? (
                <OpcodeTable items={profile.opcodes} totalGasUsed={profile.receiptGasUsed} />
              ) : (
                <EmptyPanel
                  title={loading ? 'Profiling in progress' : 'No opcode data'}
                  subtitle={
                    loading
                      ? 'Waiting for structLogs…'
                      : 'Opcode breakdown appears after a successful trace.'
                  }
                />
              )}
            </div>
            <div className="border-t border-[color:var(--cs-border)] p-3 space-y-2">
               <label className="text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">Efficiency Hotspots</label>
               <div className="grid grid-cols-2 gap-2">
                 {hotspots.length ? (
                   hotspots.map((h, idx) => (
                     <Hotspot
                       key={`${h.op}:${idx}`}
                       label={h.op}
                       value={`${formatInt(h.gas)} units${h.pct != null ? ` (${h.pct.toFixed(2)}%)` : ''}`}
                       color={hotspotColor(h.op, idx)}
                     />
                   ))
                 ) : (
                   <>
                     <Hotspot label="n/a" value={loading ? 'profiling…' : 'no data'} color="amber" />
                     <Hotspot label="n/a" value={loading ? 'profiling…' : 'no data'} color="blue" />
                   </>
                 )}
               </div>
            </div>
          </div>
        </div>
      </div>

      <footer className="bg-[color:var(--cs-panel-soft)] px-3 py-1 border-t border-[color:var(--cs-border)] text-[9px] text-[color:var(--cs-muted)] font-mono uppercase font-bold flex justify-between">
        <span>
          Anvil Trace Capture:{' '}
          <span className="text-[color:var(--cs-fg)]">
            {loading ? 'WORKING' : profile ? 'ACTIVE' : 'IDLE'}
          </span>
        </span>
        <span>ChainId: {settings.chainId}</span>
      </footer>
    </div>
  );
}

function Hotspot({ label, value, color }: { label: string, value: string, color: string }) {
  const colors: any = {
    rose: 'border-rose-500/30 text-rose-500',
    amber: 'border-amber-500/30 text-amber-500',
    blue: 'border-blue-500/30 text-blue-500',
    emerald: 'border-emerald-500/30 text-emerald-500',
  };
  return (
    <div className={['p-2 rounded border bg-[color:var(--cs-panel)] flex flex-col', colors[color]].join(' ')}>
      <span className="text-[9px] font-bold uppercase opacity-70">{label}</span>
      <span className="text-[11px] font-bold font-mono">{value}</span>
    </div>
  );
}

function EmptyPanel(props: { title: string; subtitle: string }) {
  return (
    <div className="w-full border border-[color:var(--cs-border)] border-dashed rounded-lg flex flex-col items-center justify-center gap-2 px-4 py-10">
      <div className="text-[11px] font-bold uppercase text-[color:var(--cs-muted)] tracking-widest">{props.title}</div>
      <div className="text-[10px] text-[color:var(--cs-muted)] italic text-center">{props.subtitle}</div>
    </div>
  );
}

function Detail(props: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[9px] font-bold uppercase text-[color:var(--cs-muted)]">{props.label}</div>
      <div className="truncate">{props.value}</div>
    </div>
  );
}

function shortAddr(addr: string | null): string {
  if (!addr) return 'n/a';
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function callLabel(item: GasCallNode): string {
  const to = item.to ? shortAddr(item.to) : 'n/a';
  const selector = item.selector ?? 'no-selector';
  const type = item.type ?? 'CALL';
  return `${type} ${to} ${selector}`;
}

function formatInt(v: bigint): string {
  const s = v.toString(10);
  // simple group formatting without Intl (keeps deterministic output in tests/builds)
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function hotspotColor(op: string, idx: number): string {
  const o = op.toUpperCase();
  if (o.includes('SSTORE')) return 'rose';
  if (o.includes('SLOAD')) return 'amber';
  if (o.includes('CALL')) return 'blue';
  if (o.startsWith('LOG')) return 'emerald';
  return idx % 2 === 0 ? 'amber' : 'blue';
}

function OpcodeTable(props: { items: GasOpcodeHotspot[]; totalGasUsed: bigint | null }) {
  const top = props.items.slice(0, 30);
  return (
    <div className="rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] overflow-hidden">
      <div className="grid grid-cols-12 gap-2 border-b border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-2 py-1 text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">
        <div className="col-span-3">Opcode</div>
        <div className="col-span-3 text-right">Gas</div>
        <div className="col-span-2 text-right">Count</div>
        <div className="col-span-2 text-right">Pct</div>
        <div className="col-span-2">Share</div>
      </div>
      <div className="divide-y divide-[color:var(--cs-border)]">
        {top.map((row) => {
          const share = row.pct != null ? Math.max(0, Math.min(100, row.pct)) : 0;
          return (
            <div key={row.op} className="grid grid-cols-12 gap-2 px-2 py-1 text-[11px] font-mono text-[color:var(--cs-fg)]">
              <div className="col-span-3 truncate" title={row.op}>{row.op}</div>
              <div className="col-span-3 text-right">{formatInt(row.gas)}</div>
              <div className="col-span-2 text-right">{row.count}</div>
              <div className="col-span-2 text-right">{row.pct != null ? `${row.pct.toFixed(2)}%` : 'n/a'}</div>
              <div className="col-span-2 flex items-center">
                <div className="h-2 w-full rounded bg-[color:var(--cs-border)] overflow-hidden">
                  <div
                    className="h-2 bg-[color:var(--cs-accent)]"
                    style={{ width: `${share}%` }}
                    aria-label={`${row.op} share`}
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <div className="border-t border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-2 py-1 text-[10px] font-bold uppercase text-[color:var(--cs-muted)] flex justify-between">
        <span>Showing top {top.length} ops</span>
        <span>Total gas (receipt): {props.totalGasUsed != null ? formatInt(props.totalGasUsed) : 'n/a'}</span>
      </div>
    </div>
  );
}
