'use client';

import { useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { callFoundryRpc } from '@/lib/foundry-rpc';
import { formatHexQuantity, formatWeiHexToEth, getDataSelectorLabel } from '@/lib/rpc-translate';
import { useFoundrySettings, type RpcInteraction } from '@/lib/foundry-store';

type InlineStatus = { ok: boolean; message: string };

type AddressTransaction = {
  hash: string;
  from: string | null;
  to: string | null;
  valueHex: string | null;
  valueEth: string | null;
  nonceDec: string | null;
  methodLabel: string | null;
  blockNumberDec: string | null;
  timestampIso: string | null;
};

type InteractionItem = {
  id: string;
  createdAt: string;
  source: RpcInteraction['source'];
  method: string;
  status: RpcInteraction['status'];
  txHash: string | null;
  from: string | null;
  to: string | null;
  valueEth: string | null;
};

type AddressSnapshot = {
  address: string;
  balanceHex: string | null;
  balanceEth: string | null;
  nonceDec: string | null;
  latestBlockDec: string | null;
  codeSizeBytes: number;
  isContract: boolean;
  scannedBlocks: number;
  recentTransactions: AddressTransaction[];
  recentInteractions: InteractionItem[];
};

type RpcInteractionsResponse = {
  ok: true;
  items: RpcInteraction[];
};

type BlockWithTransactions = {
  number?: unknown;
  timestamp?: unknown;
  transactions?: unknown;
};

type RpcTransaction = {
  hash?: unknown;
  from?: unknown;
  to?: unknown;
  value?: unknown;
  nonce?: unknown;
  input?: unknown;
  blockNumber?: unknown;
};

const inputClass =
  'h-7 w-full rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 text-[12px] outline-none focus:border-[color:var(--cs-accent)]';
const btnClass =
  'inline-flex h-7 items-center gap-1.5 rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 text-[11px] font-medium text-[color:var(--cs-fg)] transition-colors hover:bg-[color:var(--cs-hover)] disabled:opacity-50';

function isAddress(value: unknown): value is string {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
}

function normalizeAddress(value: string): string | null {
  const trimmed = value.trim();
  if (!isAddress(trimmed)) return null;
  return trimmed.toLowerCase();
}

function parsePositiveInt(value: string, fallback: number): number {
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function parseRpcQuantity(value: unknown): bigint | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || !/^0x[0-9a-fA-F]+$/.test(trimmed)) return null;
  try {
    return BigInt(trimmed);
  } catch {
    return null;
  }
}

function toRpcHex(value: bigint): string {
  return `0x${value.toString(16)}`;
}

function asTx(input: unknown): RpcTransaction | null {
  if (!input || typeof input !== 'object') return null;
  return input as RpcTransaction;
}

function asBlock(input: unknown): BlockWithTransactions | null {
  if (!input || typeof input !== 'object') return null;
  return input as BlockWithTransactions;
}

function asTimestampIso(hex: unknown): string | null {
  const value = parseRpcQuantity(hex);
  if (value == null) return null;
  const ms = Number(value) * 1000;
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function shortHex(value: string | null, max = 20): string {
  if (!value) return '-';
  if (value.length <= max) return value;
  return `${value.slice(0, max - 8)}...${value.slice(-6)}`;
}

function formatDate(value: string | null): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

export function FoundryAddressInspectorCard() {
  const { settings } = useFoundrySettings();
  const [addressInput, setAddressInput] = useState('');
  const [scanWindowBlocks, setScanWindowBlocks] = useState('120');
  const [maxTransactions, setMaxTransactions] = useState('20');
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<InlineStatus | null>(null);
  const [snapshot, setSnapshot] = useState<AddressSnapshot | null>(null);

  const normalizedAddress = useMemo(() => normalizeAddress(addressInput), [addressInput]);

  async function callRpc<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    return await callFoundryRpc<T>({
      rpcUrl: settings.rpcUrl,
      method,
      params,
      chainId: settings.chainId,
    });
  }

  async function loadRecentTransactions(address: string, windowBlocks: number, limit: number): Promise<{
    txs: AddressTransaction[];
    scannedBlocks: number;
  }> {
    const latestHex = await callRpc<unknown>('eth_blockNumber');
    const latest = parseRpcQuantity(latestHex);
    if (latest == null) {
      throw new Error('Failed to parse latest block number from RPC.');
    }

    const target = address.toLowerCase();
    const blockNumbers: bigint[] = [];
    let current = latest;
    for (let i = 0; i < windowBlocks; i += 1) {
      blockNumbers.push(current);
      if (current === BigInt(0)) break;
      current -= BigInt(1);
    }

    const collected: AddressTransaction[] = [];
    const batchSize = 8;

    for (let i = 0; i < blockNumbers.length && collected.length < limit; i += batchSize) {
      const batch = blockNumbers.slice(i, i + batchSize);
      const blocks = await Promise.all(
        batch.map(async (blockNumber) => {
          try {
            const blockHex = toRpcHex(blockNumber);
            return await callRpc<unknown>('eth_getBlockByNumber', [blockHex, true]);
          } catch {
            return null;
          }
        }),
      );

      for (const blockRaw of blocks) {
        const block = asBlock(blockRaw);
        if (!block || !Array.isArray(block.transactions)) continue;
        const timestampIso = asTimestampIso(block.timestamp);
        const blockNumberDec = formatHexQuantity(
          typeof block.number === 'string' ? block.number : null,
        );

        for (const txRaw of block.transactions) {
          const tx = asTx(txRaw);
          if (!tx) continue;

          const hash = typeof tx.hash === 'string' ? tx.hash : null;
          const from = typeof tx.from === 'string' ? tx.from.toLowerCase() : null;
          const to = typeof tx.to === 'string' ? tx.to.toLowerCase() : null;
          if (!hash) continue;
          if (from !== target && to !== target) continue;

          const input = typeof tx.input === 'string' ? tx.input : null;
          const txBlockNumberDec = formatHexQuantity(
            typeof tx.blockNumber === 'string' ? tx.blockNumber : null,
          );
          collected.push({
            hash,
            from,
            to,
            valueHex: typeof tx.value === 'string' ? tx.value : null,
            valueEth: formatWeiHexToEth(typeof tx.value === 'string' ? tx.value : null),
            nonceDec: formatHexQuantity(typeof tx.nonce === 'string' ? tx.nonce : null),
            methodLabel: input ? getDataSelectorLabel(input) : null,
            blockNumberDec: txBlockNumberDec ?? blockNumberDec,
            timestampIso,
          });

          if (collected.length >= limit) break;
        }
        if (collected.length >= limit) break;
      }
    }

    return { txs: collected, scannedBlocks: blockNumbers.length };
  }

  async function loadRecentInteractions(address: string): Promise<InteractionItem[]> {
    const res = await fetch('/api/rpc/interactions?limit=600', { cache: 'no-store' });
    if (!res.ok) return [];
    const json = (await res.json().catch(() => null)) as RpcInteractionsResponse | null;
    if (!json || json.ok !== true || !Array.isArray(json.items)) return [];
    const target = address.toLowerCase();

    const filtered = json.items
      .filter((item) => {
        const tx = item.tx;
        const from = tx?.from?.toLowerCase() ?? null;
        const to = tx?.to?.toLowerCase() ?? null;
        return from === target || to === target;
      })
      .slice(0, 25)
      .map((item) => ({
        id: item.id,
        createdAt: item.createdAt,
        source: item.source,
        method: item.method,
        status: item.status,
        txHash: item.txHash,
        from: item.tx?.from ?? null,
        to: item.tx?.to ?? null,
        valueEth: formatWeiHexToEth(item.tx?.value ?? null),
      }));
    return filtered;
  }

  async function onInspect() {
    setLoading(true);
    setStatus(null);
    try {
      const address = normalizeAddress(addressInput);
      if (!address) throw new Error('Enter a valid EVM address.');
      const windowBlocks = Math.min(1000, Math.max(10, parsePositiveInt(scanWindowBlocks, 120)));
      const limit = Math.min(100, Math.max(5, parsePositiveInt(maxTransactions, 20)));

      const [balanceRaw, nonceRaw, codeRaw, blockRaw, recent, interactions] = await Promise.all([
        callRpc<unknown>('eth_getBalance', [address, 'latest']),
        callRpc<unknown>('eth_getTransactionCount', [address, 'latest']),
        callRpc<unknown>('eth_getCode', [address, 'latest']),
        callRpc<unknown>('eth_blockNumber'),
        loadRecentTransactions(address, windowBlocks, limit),
        loadRecentInteractions(address),
      ]);

      const balanceHex = typeof balanceRaw === 'string' ? balanceRaw : null;
      const nonceHex = typeof nonceRaw === 'string' ? nonceRaw : null;
      const codeHex = typeof codeRaw === 'string' ? codeRaw : '0x';
      const latestBlockHex = typeof blockRaw === 'string' ? blockRaw : null;
      const normalizedCode = codeHex.startsWith('0x') ? codeHex.slice(2) : codeHex;
      const codeSizeBytes = normalizedCode.length > 0 ? Math.floor(normalizedCode.length / 2) : 0;

      const nextSnapshot: AddressSnapshot = {
        address,
        balanceHex,
        balanceEth: formatWeiHexToEth(balanceHex),
        nonceDec: formatHexQuantity(nonceHex),
        latestBlockDec: formatHexQuantity(latestBlockHex),
        codeSizeBytes,
        isContract: normalizedCode.length > 0,
        scannedBlocks: recent.scannedBlocks,
        recentTransactions: recent.txs,
        recentInteractions: interactions,
      };
      setSnapshot(nextSnapshot);
      setStatus({
        ok: true,
        message: `Loaded address data. Scanned ${recent.scannedBlocks} block(s), found ${recent.txs.length} transaction(s).`,
      });
    } catch (err) {
      setSnapshot(null);
      setStatus({
        ok: false,
        message: err instanceof Error ? err.message : 'Failed to inspect address.',
      });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="border-b border-[color:var(--cs-border)]">
      <div className="border-b border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-3 py-1.5 text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">
        Foundry Address Inspector
      </div>
      <div className="space-y-2 px-3 py-2">
        <p className="text-[11px] text-[color:var(--cs-muted)]">
          Inspect an address for live balance/nonce/code plus recent on-chain transactions and captured RPC interactions.
        </p>
        <div className="grid grid-cols-1 gap-2 md:grid-cols-[1fr_130px_130px_auto]">
          <label className="block space-y-0.5">
            <div className="text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">Address</div>
            <input
              className={inputClass}
              value={addressInput}
              onChange={(e) => setAddressInput(e.target.value)}
              placeholder="0x..."
            />
          </label>
          <label className="block space-y-0.5">
            <div className="text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">Scan Blocks</div>
            <input
              className={inputClass}
              value={scanWindowBlocks}
              onChange={(e) => setScanWindowBlocks(e.target.value)}
              placeholder="120"
            />
          </label>
          <label className="block space-y-0.5">
            <div className="text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">Tx Limit</div>
            <input
              className={inputClass}
              value={maxTransactions}
              onChange={(e) => setMaxTransactions(e.target.value)}
              placeholder="20"
            />
          </label>
          <div className="flex items-end">
            <button
              type="button"
              disabled={loading || !normalizedAddress}
              onClick={() => void onInspect()}
              className={btnClass}
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
              {loading ? 'Inspecting…' : 'Inspect Address'}
            </button>
          </div>
        </div>

        {status ? <InlineMessage ok={status.ok} message={status.message} /> : null}

        {snapshot ? (
          <>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] p-2 font-mono text-[11px] sm:grid-cols-3">
              <Info label="Address" value={snapshot.address} />
              <Info label={`Balance (${settings.currencySymbol})`} value={snapshot.balanceEth ?? '-'} />
              <Info label="Balance (wei hex)" value={snapshot.balanceHex ?? '-'} />
              <Info label="Nonce" value={snapshot.nonceDec ?? '-'} />
              <Info label="Latest Block" value={snapshot.latestBlockDec ?? '-'} />
              <Info label="Type" value={snapshot.isContract ? 'Contract' : 'EOA'} />
              <Info label="Code Size" value={`${snapshot.codeSizeBytes} bytes`} />
              <Info label="Scanned Blocks" value={String(snapshot.scannedBlocks)} />
              <Info label="Recent Tx Found" value={String(snapshot.recentTransactions.length)} />
            </div>

            <div className="space-y-1">
              <div className="text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">
                Recent On-Chain Transactions (from/to address)
              </div>
              {snapshot.recentTransactions.length ? (
                <div className="max-h-72 overflow-auto rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)]">
                  <table className="w-full border-collapse text-left font-mono text-[11px]">
                    <thead>
                      <tr className="border-b border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] text-[10px] uppercase text-[color:var(--cs-muted)]">
                        <th className="px-2 py-1">Time</th>
                        <th className="px-2 py-1">Block</th>
                        <th className="px-2 py-1">Hash</th>
                        <th className="px-2 py-1">From</th>
                        <th className="px-2 py-1">To</th>
                        <th className="px-2 py-1">Value</th>
                        <th className="px-2 py-1">Method</th>
                      </tr>
                    </thead>
                    <tbody>
                      {snapshot.recentTransactions.map((tx) => (
                        <tr key={tx.hash} className="border-b border-[color:var(--cs-border)] last:border-b-0">
                          <td className="px-2 py-1 text-[color:var(--cs-muted)]">{formatDate(tx.timestampIso)}</td>
                          <td className="px-2 py-1">{tx.blockNumberDec ?? '-'}</td>
                          <td className="px-2 py-1" title={tx.hash}>{shortHex(tx.hash, 22)}</td>
                          <td className="px-2 py-1" title={tx.from ?? undefined}>{shortHex(tx.from, 20)}</td>
                          <td className="px-2 py-1" title={tx.to ?? undefined}>{shortHex(tx.to, 20)}</td>
                          <td className="px-2 py-1">{tx.valueEth ?? '-'}</td>
                          <td className="px-2 py-1" title={tx.methodLabel ?? undefined}>{tx.methodLabel ?? '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="text-[11px] text-[color:var(--cs-muted)]">
                  No transactions matched this address in the scanned block window.
                </div>
              )}
            </div>

            <div className="space-y-1">
              <div className="text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">
                Recent Captured RPC Interactions
              </div>
              {snapshot.recentInteractions.length ? (
                <div className="max-h-72 overflow-auto rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)]">
                  <table className="w-full border-collapse text-left font-mono text-[11px]">
                    <thead>
                      <tr className="border-b border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] text-[10px] uppercase text-[color:var(--cs-muted)]">
                        <th className="px-2 py-1">Time</th>
                        <th className="px-2 py-1">Source</th>
                        <th className="px-2 py-1">Method</th>
                        <th className="px-2 py-1">From</th>
                        <th className="px-2 py-1">To</th>
                        <th className="px-2 py-1">Value</th>
                        <th className="px-2 py-1">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {snapshot.recentInteractions.map((item) => (
                        <tr key={item.id} className="border-b border-[color:var(--cs-border)] last:border-b-0">
                          <td className="px-2 py-1 text-[color:var(--cs-muted)]">{formatDate(item.createdAt)}</td>
                          <td className="px-2 py-1 uppercase">{item.source}</td>
                          <td className="px-2 py-1">{item.method}</td>
                          <td className="px-2 py-1" title={item.from ?? undefined}>{shortHex(item.from, 20)}</td>
                          <td className="px-2 py-1" title={item.to ?? undefined}>{shortHex(item.to, 20)}</td>
                          <td className="px-2 py-1">{item.valueEth ?? '-'}</td>
                          <td className={`px-2 py-1 font-bold ${item.status === 'success' ? 'text-emerald-600' : 'text-rose-600'}`}>
                            {item.status}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="text-[11px] text-[color:var(--cs-muted)]">
                  No captured RPC interactions found for this address.
                </div>
              )}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

function InlineMessage(props: InlineStatus) {
  return (
    <div
      className={`border px-2 py-1.5 text-[11px] ${
        props.ok
          ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700'
          : 'border-rose-500/40 bg-rose-500/10 text-rose-700'
      }`}
    >
      {props.message}
    </div>
  );
}

function Info(props: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <span className="text-[10px] text-[color:var(--cs-muted)]">{props.label}: </span>
      <span className="break-all font-medium text-[color:var(--cs-fg)]">{props.value}</span>
    </div>
  );
}
