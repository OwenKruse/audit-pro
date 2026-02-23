'use client';

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useFoundrySettings, type FoundrySettings } from '@/lib/foundry-store';

type InlineStatus = { ok: boolean; message: string };

type SavedForkConfig = {
  hasSavedConfig: boolean;
  forkUrl: string | null;
  forkBlockNumber: number | null;
  chainId: number | null;
  updatedAt: string | null;
};

type FoundryStatus = {
  rpcUrl: string;
  running: boolean;
  managed: boolean;
  pid: number | null;
  chainId: number;
  forkUrl: string | null;
  forkBlockNumber: number | null;
  startupError: string | null;
};

type NodeInfoForkConfig = {
  forkUrl?: unknown;
  forkBlockNumber?: unknown;
};

type NodeInfo = {
  currentBlockNumber?: unknown;
  forkConfig?: NodeInfoForkConfig;
};

type AgentConfigOk = {
  ok: true;
  saved: SavedForkConfig;
  foundry: FoundryStatus;
  nodeInfo: { forkConfig?: NodeInfoForkConfig; currentBlockNumber?: unknown } | null;
};

type AgentConfigErr = {
  ok: false;
  error?: { code?: unknown; message?: unknown };
  saved?: SavedForkConfig;
  foundry?: FoundryStatus;
  nodeInfo?: NodeInfo | null;
};

type AgentConfigResponse = AgentConfigOk | AgentConfigErr;

type ChainPreset = {
  id: string;
  label: string;
  chainId: number;
  rpcUrl: string;
  currencySymbol: string;
  blockExplorerUrl: string;
};

const inputClass =
  'h-7 w-full rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 text-[12px] outline-none focus:border-[color:var(--cs-accent)]';
const btnClass =
  'inline-flex h-7 items-center gap-1.5 rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 text-[11px] font-medium text-[color:var(--cs-fg)] transition-colors hover:bg-[color:var(--cs-hover)] disabled:opacity-50';
const chainSelectClass = inputClass;

const CHAIN_PRESETS: ChainPreset[] = [
  {
    id: 'anvil',
    label: 'Anvil / Foundry Default',
    chainId: 31337,
    rpcUrl: 'http://127.0.0.1:8545',
    currencySymbol: 'ETH',
    blockExplorerUrl: '',
  },
  {
    id: 'eth',
    label: 'Ethereum Mainnet',
    chainId: 1,
    rpcUrl: 'https://ethereum-rpc.publicnode.com',
    currencySymbol: 'ETH',
    blockExplorerUrl: 'https://etherscan.io',
  },
  {
    id: 'arbitrum',
    label: 'Arbitrum One',
    chainId: 42161,
    rpcUrl: 'https://arb1.arbitrum.io/rpc',
    currencySymbol: 'ETH',
    blockExplorerUrl: 'https://arbiscan.io',
  },
  {
    id: 'base',
    label: 'Base',
    chainId: 8453,
    rpcUrl: 'https://mainnet.base.org',
    currencySymbol: 'ETH',
    blockExplorerUrl: 'https://basescan.org',
  },
  {
    id: 'optimism',
    label: 'Optimism',
    chainId: 10,
    rpcUrl: 'https://mainnet.optimism.io',
    currencySymbol: 'ETH',
    blockExplorerUrl: 'https://optimistic.etherscan.io',
  },
  {
    id: 'polygon',
    label: 'Polygon PoS',
    chainId: 137,
    rpcUrl: 'https://polygon-rpc.com',
    currencySymbol: 'MATIC',
    blockExplorerUrl: 'https://polygonscan.com',
  },
  {
    id: 'bsc',
    label: 'BNB Smart Chain',
    chainId: 56,
    rpcUrl: 'https://bsc-dataseed.binance.org',
    currencySymbol: 'BNB',
    blockExplorerUrl: 'https://bscscan.com',
  },
  {
    id: 'avalanche',
    label: 'Avalanche C-Chain',
    chainId: 43114,
    rpcUrl: 'https://api.avax.network/ext/bc/C/rpc',
    currencySymbol: 'AVAX',
    blockExplorerUrl: 'https://snowtrace.io',
  },
];

const CUSTOM_CHAIN_PRESET_ID = 'custom';
const DEFAULT_CHAIN_PRESET_ID = 'eth';

function asString(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value;
  return null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return null;
}

function maskSecret(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 16) return '****';
  return `${trimmed.slice(0, 10)}...${trimmed.slice(-6)}`;
}

function normalizeUrl(value: string): string {
  return value.trim().replace(/\/+$/, '').toLowerCase();
}

function findPresetById(id: string): ChainPreset | null {
  return CHAIN_PRESETS.find((item) => item.id === id) ?? null;
}

function findPresetByChainId(chainId: number | null): ChainPreset | null {
  if (!chainId) return null;
  return CHAIN_PRESETS.find((item) => item.chainId === chainId) ?? null;
}

function inferPresetId(input: { chainId: number | null; forkUrl: string | null }): string {
  const byChainId = findPresetByChainId(input.chainId);
  if (!byChainId) return CUSTOM_CHAIN_PRESET_ID;
  if (!input.forkUrl) return byChainId.id;
  if (normalizeUrl(input.forkUrl) === normalizeUrl(byChainId.rpcUrl)) return byChainId.id;
  return byChainId.id;
}

function syncedRuntimeSettings(current: FoundrySettings, payload: AgentConfigOk): FoundrySettings {
  const chainId =
    Number.isInteger(payload.foundry.chainId) && payload.foundry.chainId > 0
      ? payload.foundry.chainId
      : current.chainId;
  const preset = findPresetByChainId(chainId);
  return {
    ...current,
    rpcUrl: payload.foundry.rpcUrl || current.rpcUrl,
    chainId,
    chainName: preset?.label ?? (current.chainId === chainId ? current.chainName : `Chain ${chainId}`),
    currencySymbol: preset?.currencySymbol ?? current.currencySymbol,
    blockExplorerUrl: preset?.blockExplorerUrl ?? current.blockExplorerUrl,
  };
}

export function AnvilForkSettingsCard() {
  const { settings: runtimeSettings, setSettings: setRuntimeSettings } = useFoundrySettings();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [showForkUrl, setShowForkUrl] = useState(false);
  const [status, setStatus] = useState<InlineStatus | null>(null);
  const [data, setData] = useState<AgentConfigOk | null>(null);

  const [forkUrlDraft, setForkUrlDraft] = useState('');
  const [pinBlock, setPinBlock] = useState(false);
  const [forkBlockDraft, setForkBlockDraft] = useState('');
  const [selectedChainPresetId, setSelectedChainPresetId] = useState(DEFAULT_CHAIN_PRESET_ID);
  const [chainIdDraft, setChainIdDraft] = useState('1');

  const runningForkUrl = useMemo(() => {
    const forkConfig = (data?.nodeInfo as NodeInfo | null)?.forkConfig ?? null;
    return asString(forkConfig?.forkUrl) ?? null;
  }, [data?.nodeInfo]);

  const runningForkBlock = useMemo(() => {
    const forkConfig = (data?.nodeInfo as NodeInfo | null)?.forkConfig ?? null;
    const raw = forkConfig?.forkBlockNumber;
    return asNumber(raw) ?? asString(raw) ?? null;
  }, [data?.nodeInfo]);

  const runningBlockNumber = useMemo(() => {
    return asString((data?.nodeInfo as NodeInfo | null)?.currentBlockNumber) ?? null;
  }, [data?.nodeInfo]);

  const selectedPreset = useMemo(() => findPresetById(selectedChainPresetId), [selectedChainPresetId]);
  const usingCustomPreset = selectedChainPresetId === CUSTOM_CHAIN_PRESET_ID;

  const syncRuntimeFromAgent = useCallback(
    (payload: AgentConfigOk) => {
      const next = syncedRuntimeSettings(runtimeSettings, payload);
      if (
        next.rpcUrl === runtimeSettings.rpcUrl &&
        next.chainId === runtimeSettings.chainId &&
        next.chainName === runtimeSettings.chainName &&
        next.currencySymbol === runtimeSettings.currencySymbol &&
        next.blockExplorerUrl === runtimeSettings.blockExplorerUrl
      ) {
        return;
      }
      setRuntimeSettings(next);
    },
    [runtimeSettings, setRuntimeSettings],
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    setStatus(null);
    try {
      const res = await fetch('/api/evm/config', { cache: 'no-store' });
      const json = (await res.json().catch(() => null)) as AgentConfigResponse | null;
      if (!json || typeof json !== 'object') {
        throw new Error('Invalid response from agent.');
      }
      if (!res.ok || json.ok !== true) {
        const errMsg = (json as AgentConfigErr).error?.message;
        const message =
          typeof errMsg === 'string' && errMsg.trim() ? errMsg : `Agent responded with ${res.status}.`;
        throw new Error(message);
      }

      setData(json);
      const saved = json.saved;
      const baseForkUrl = saved.hasSavedConfig ? saved.forkUrl : json.foundry.forkUrl;
      const baseForkBlock = saved.hasSavedConfig ? saved.forkBlockNumber : json.foundry.forkBlockNumber;
      const baseChainId = saved.hasSavedConfig ? (saved.chainId ?? json.foundry.chainId) : json.foundry.chainId;
      const presetId = inferPresetId({ chainId: baseChainId, forkUrl: baseForkUrl });
      const preset = findPresetById(presetId);

      setSelectedChainPresetId(presetId);
      setChainIdDraft(String(baseChainId > 0 ? baseChainId : 1));
      setForkUrlDraft(baseForkUrl ?? preset?.rpcUrl ?? findPresetById(DEFAULT_CHAIN_PRESET_ID)?.rpcUrl ?? '');
      setPinBlock(!!baseForkUrl && baseForkBlock != null);
      setForkBlockDraft(baseForkBlock != null ? String(baseForkBlock) : '');
      syncRuntimeFromAgent(json);
    } catch (err) {
      setData(null);
      setStatus({
        ok: false,
        message: err instanceof Error ? err.message : 'Failed to load Anvil fork settings.',
      });
    } finally {
      setLoading(false);
    }
  }, [syncRuntimeFromAgent]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function onSave(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setStatus(null);
    try {
      const chainId =
        usingCustomPreset
          ? Number.parseInt(chainIdDraft.trim(), 10)
          : (selectedPreset?.chainId ?? findPresetById(DEFAULT_CHAIN_PRESET_ID)?.chainId ?? 1);
      if (!Number.isInteger(chainId) || chainId <= 0) {
        throw new Error('Chain ID must be a positive integer.');
      }

      const forkUrl = forkUrlDraft.trim() || null;
      const forkBlockNumber =
        forkUrl && pinBlock && forkBlockDraft.trim()
          ? Number.parseInt(forkBlockDraft.trim(), 10) || null
          : null;

      const res = await fetch('/api/evm/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ forkUrl, forkBlockNumber, chainId }),
      });
      const json = (await res.json().catch(() => null)) as AgentConfigResponse | null;
      if (!res.ok || !json || typeof json !== 'object' || json.ok !== true) {
        const errMsg = (json as AgentConfigErr | null)?.error?.message;
        const message =
          typeof errMsg === 'string' && errMsg.trim()
            ? errMsg
            : `Failed to apply fork settings (${res.status}).`;
        throw new Error(message);
      }

      setStatus({ ok: true, message: 'Fork settings saved and Anvil restarted.' });
      await refresh();
    } catch (err) {
      setStatus({
        ok: false,
        message: err instanceof Error ? err.message : 'Failed to apply Anvil fork settings.',
      });
    } finally {
      setBusy(false);
    }
  }

  function onPresetChange(nextId: string) {
    setSelectedChainPresetId(nextId);
    if (nextId === CUSTOM_CHAIN_PRESET_ID) return;
    const nextPreset = findPresetById(nextId);
    if (!nextPreset) return;
    setChainIdDraft(String(nextPreset.chainId));
    setForkUrlDraft(nextPreset.rpcUrl);
  }

  async function onClearSavedConfig() {
    setBusy(true);
    setStatus(null);
    try {
      const res = await fetch('/api/evm/config', { method: 'DELETE' });
      const json = (await res.json().catch(() => null)) as AgentConfigResponse | null;
      if (!res.ok || !json || typeof json !== 'object' || json.ok !== true) {
        const errMsg = (json as AgentConfigErr | null)?.error?.message;
        const message =
          typeof errMsg === 'string' && errMsg.trim()
            ? errMsg
            : `Failed to clear saved config (${res.status}).`;
        throw new Error(message);
      }
      setStatus({ ok: true, message: 'Saved fork override cleared. Agent restarted Anvil using .env defaults.' });
      await refresh();
    } catch (err) {
      setStatus({
        ok: false,
        message: err instanceof Error ? err.message : 'Failed to clear saved config.',
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border-b border-[color:var(--cs-border)]">
      <div className="border-b border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-3 py-1.5 text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">
        Anvil Fork (Agent)
      </div>
      <div className="space-y-2 px-3 py-2">
        <p className="text-[11px] text-[color:var(--cs-muted)]">
          Configure the agent-managed Anvil to fork a remote chain. Leave block number blank to fork the latest block
          whenever the agent starts.
        </p>
        <p className="text-[11px] text-[color:var(--cs-muted)]">
          Chain/RPC choices here automatically sync the Foundry Runtime card and wallet switch target.
        </p>

        {loading ? (
          <div className="text-[11px] text-[color:var(--cs-muted)]">Loading...</div>
        ) : data ? (
          <div className="grid gap-2 text-[11px] text-[color:var(--cs-muted)] md:grid-cols-2">
            <div className="rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] p-2">
              Agent RPC URL:{' '}
              <span className="block break-all font-mono text-[color:var(--cs-fg)]">{data.foundry.rpcUrl}</span>
            </div>
            <div className="rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] p-2">
              Status:{' '}
              <span className="block font-mono text-[color:var(--cs-fg)]">
                {data.foundry.running ? 'running' : 'stopped'} | {data.foundry.managed ? 'managed' : 'external'} |
                chainId {data.foundry.chainId}
              </span>
            </div>
            <div className="rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] p-2">
              Fork (running):{' '}
              <span className="block break-all font-mono text-[color:var(--cs-fg)]">
                {runningForkUrl
                  ? showForkUrl
                    ? runningForkUrl
                    : maskSecret(runningForkUrl)
                  : '(none)'}
              </span>
              <span className="block font-mono text-[color:var(--cs-muted)]">
                block {runningForkUrl ? runningForkBlock ?? '(latest)' : '(n/a)'} | head {runningBlockNumber ?? '-'}
              </span>
            </div>
            <div className="rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] p-2">
              Override (saved):{' '}
              <span className="block break-all font-mono text-[color:var(--cs-fg)]">
                {data.saved.hasSavedConfig
                  ? data.saved.forkUrl
                    ? showForkUrl
                      ? data.saved.forkUrl
                      : maskSecret(data.saved.forkUrl)
                    : '(disabled)'
                  : '(using .env)'}
              </span>
              <span className="block font-mono text-[color:var(--cs-muted)]">
                block {data.saved.forkUrl ? data.saved.forkBlockNumber ?? '(latest)' : '(n/a)'}
                {` | chainId ${data.saved.chainId ?? '(env default)'}`}
                {data.saved.updatedAt ? ` | updated ${data.saved.updatedAt}` : ''}
              </span>
            </div>
          </div>
        ) : null}

        {data?.foundry.startupError ? (
          <div className="border border-rose-500/40 bg-rose-500/10 px-2 py-1.5 text-[11px] text-rose-700">
            <span className="font-medium">Anvil startup error:</span> {data.foundry.startupError}
          </div>
        ) : null}

        {status ? (
          <div
            className={[
              'px-2 py-1.5 text-[11px]',
              status.ok
                ? 'border border-emerald-500/40 bg-emerald-500/10 text-emerald-700'
                : 'border border-rose-500/40 bg-rose-500/10 text-rose-700',
            ].join(' ')}
          >
            {status.message}
          </div>
        ) : null}

        <form onSubmit={onSave} className="space-y-2">
          <div className="grid gap-2 md:grid-cols-2">
            <div className="space-y-1">
              <label className="text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">Chain</label>
              <select
                className={chainSelectClass}
                value={selectedChainPresetId}
                onChange={(e) => onPresetChange(e.target.value)}
                disabled={busy}
              >
                {CHAIN_PRESETS.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label} (chainId {item.chainId})
                  </option>
                ))}
                <option value={CUSTOM_CHAIN_PRESET_ID}>Custom</option>
              </select>
            </div>

            <div className="space-y-1">
              <label className="text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">Chain ID</label>
              <input
                className={inputClass}
                type="number"
                inputMode="numeric"
                min={1}
                step={1}
                value={usingCustomPreset ? chainIdDraft : String(selectedPreset?.chainId ?? 1)}
                onChange={(e) => setChainIdDraft(e.target.value)}
                disabled={busy || !usingCustomPreset}
              />
            </div>

            <div className="space-y-1">
              <label className="text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">Fork URL</label>
              <div className="flex items-center gap-2">
                <input
                  className={inputClass}
                  type={showForkUrl ? 'text' : 'password'}
                  placeholder={selectedPreset?.rpcUrl ?? 'https://rpc.example.com'}
                  value={forkUrlDraft}
                  onChange={(e) => setForkUrlDraft(e.target.value)}
                  disabled={busy}
                />
                <button
                  type="button"
                  className={btnClass}
                  onClick={() => setShowForkUrl((v) => !v)}
                  disabled={busy}
                >
                  {showForkUrl ? 'Hide' : 'Show'}
                </button>
              </div>
            </div>

            <div className="space-y-1">
              <label className="text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">Fork Block</label>
              <div className="flex items-center gap-2">
                <label className="inline-flex items-center gap-2 text-[11px] text-[color:var(--cs-muted)]">
                  <input
                    type="checkbox"
                    checked={pinBlock}
                    onChange={(e) => setPinBlock(e.target.checked)}
                    disabled={busy || !forkUrlDraft.trim()}
                  />
                  Pin block number
                </label>
                <input
                  className={inputClass}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  step={1}
                  placeholder="(latest)"
                  value={forkBlockDraft}
                  onChange={(e) => setForkBlockDraft(e.target.value)}
                  disabled={busy || !pinBlock || !forkUrlDraft.trim()}
                />
              </div>
            </div>
          </div>

          <p className="text-[10px] text-[color:var(--cs-muted)]">
            Presets use public RPC endpoints by default. Replace with your provider URL if you hit rate limits.
          </p>

          <div className="flex flex-wrap items-center gap-2">
            <button type="submit" className={btnClass} disabled={busy}>
              {busy ? 'Applying...' : 'Save & Restart Anvil'}
            </button>
            <button type="button" className={btnClass} disabled={busy} onClick={onClearSavedConfig}>
              Clear Saved Override (Use .env)
            </button>
            <button
              type="button"
              className={btnClass}
              disabled={busy}
              onClick={() => {
                setForkUrlDraft('');
                setPinBlock(false);
                setForkBlockDraft('');
                const defaultPreset = findPresetById(DEFAULT_CHAIN_PRESET_ID);
                setSelectedChainPresetId(defaultPreset?.id ?? DEFAULT_CHAIN_PRESET_ID);
                setChainIdDraft(String(defaultPreset?.chainId ?? 1));
              }}
            >
              Disable Fork (Draft)
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
