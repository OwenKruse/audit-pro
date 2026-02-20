'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { CheckCircle2, ExternalLink, Wallet } from 'lucide-react';
import { callFoundryRpc, callWalletRpc } from '@/lib/foundry-rpc';
import {
  DEFAULT_FOUNDRY_SETTINGS,
  fromChainIdHex,
  getEthereumProvider,
  toChainIdHex,
  type FoundrySettings,
  type WalletAuthSession,
  useFoundrySettings,
  useWalletAuthSession,
} from '@/lib/foundry-store';

type InlineStatus = { ok: boolean; message: string };

const inputClass =
  'h-7 w-full rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 text-[12px] outline-none focus:border-[color:var(--cs-accent)]';
const btnClass =
  'inline-flex h-7 items-center gap-1.5 rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 text-[11px] font-medium text-[color:var(--cs-fg)] transition-colors hover:bg-[color:var(--cs-hover)] disabled:opacity-50';

function shortAddress(value: string | null): string {
  if (!value) return 'Not connected';
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function normalizeSettingsDraft(draft: FoundrySettings): FoundrySettings {
  const chainId = Number.parseInt(String(draft.chainId), 10);
  const pollIntervalMs = Number.parseInt(String(draft.pollIntervalMs), 10);
  const gasRaw = draft.defaultGasLimit.trim();
  const defaultGasLimit = /^\d+$/.test(gasRaw) ? gasRaw : DEFAULT_FOUNDRY_SETTINGS.defaultGasLimit;
  return {
    rpcUrl: draft.rpcUrl.trim().replace(/\/+$/, '') || DEFAULT_FOUNDRY_SETTINGS.rpcUrl,
    chainId: Number.isInteger(chainId) && chainId > 0 ? chainId : DEFAULT_FOUNDRY_SETTINGS.chainId,
    chainName: draft.chainName.trim() || DEFAULT_FOUNDRY_SETTINGS.chainName,
    blockExplorerUrl: draft.blockExplorerUrl.trim(),
    currencySymbol: draft.currencySymbol.trim() || DEFAULT_FOUNDRY_SETTINGS.currencySymbol,
    defaultGasLimit,
    defaultSimulateOnly: draft.defaultSimulateOnly,
    pollIntervalMs:
      Number.isInteger(pollIntervalMs) && pollIntervalMs > 0
        ? pollIntervalMs
        : DEFAULT_FOUNDRY_SETTINGS.pollIntervalMs,
  };
}

function walletErrorMessage(err: unknown, fallback: string): string {
  if (!err || typeof err !== 'object') return fallback;
  const code = (err as { code?: unknown }).code;
  const message = (err as { message?: unknown }).message;
  if (typeof code === 'number' && code === 4001) return 'Wallet request was rejected.';
  if (typeof message === 'string' && message.trim()) return message;
  return fallback;
}

export function FoundrySettingsCard() {
  const { settings, setSettings } = useFoundrySettings();
  const { wallet, setWallet, clearWallet } = useWalletAuthSession();

  const [draft, setDraft] = useState<FoundrySettings>(settings);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [signing, setSigning] = useState(false);
  const [switching, setSwitching] = useState(false);

  const [settingsStatus, setSettingsStatus] = useState<InlineStatus | null>(null);
  const [rpcStatus, setRpcStatus] = useState<InlineStatus | null>(null);
  const [walletStatus, setWalletStatus] = useState<InlineStatus | null>(null);

  useEffect(() => {
    setDraft(settings);
  }, [settings]);

  const walletChainId = useMemo(() => {
    if (!wallet.chainIdHex) return null;
    return fromChainIdHex(wallet.chainIdHex);
  }, [wallet.chainIdHex]);

  async function onSaveSettings(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSaving(true);
    setSettingsStatus(null);
    try {
      const normalized = normalizeSettingsDraft(draft);
      setSettings(normalized);
      setDraft(normalized);
      setSettingsStatus({ ok: true, message: 'Foundry configuration saved.' });
    } catch (err) {
      setSettingsStatus({
        ok: false,
        message: err instanceof Error ? err.message : 'Failed to save Foundry configuration.',
      });
    } finally {
      setSaving(false);
    }
  }

  async function onTestRpc() {
    setTesting(true);
    setRpcStatus(null);
    try {
      const normalized = normalizeSettingsDraft(draft);
      const chainHex = await callFoundryRpc<string>({
        rpcUrl: normalized.rpcUrl,
        method: 'eth_chainId',
        chainId: normalized.chainId,
      });
      const blockHex = await callFoundryRpc<string>({
        rpcUrl: normalized.rpcUrl,
        method: 'eth_blockNumber',
        chainId: normalized.chainId,
      });
      setRpcStatus({
        ok: true,
        message: `RPC OK. chainId=${chainHex}, block=${blockHex}.`,
      });
    } catch (err) {
      setRpcStatus({
        ok: false,
        message: err instanceof Error ? err.message : 'Failed to reach Foundry RPC endpoint.',
      });
    } finally {
      setTesting(false);
    }
  }

  async function onConnectWallet() {
    setConnecting(true);
    setWalletStatus(null);
    try {
      const provider = getEthereumProvider();
      if (!provider) {
        throw new Error('No injected wallet found. Install MetaMask or another EIP-1193 wallet.');
      }
      const accounts = await callWalletRpc<unknown>({
        provider,
        method: 'eth_requestAccounts',
        rpcUrl: settings.rpcUrl,
        chainId: settings.chainId,
      });
      const chainId = await callWalletRpc<unknown>({
        provider,
        method: 'eth_chainId',
        rpcUrl: settings.rpcUrl,
        chainId: settings.chainId,
      });
      const address =
        Array.isArray(accounts) && typeof accounts[0] === 'string' ? accounts[0] : null;
      const chainIdHex = typeof chainId === 'string' ? chainId : null;
      if (!address) throw new Error('Wallet did not return an account.');

      const now = new Date().toISOString();
      const next: WalletAuthSession = {
        address,
        chainIdHex,
        connectedAt: now,
        authMessage: null,
        signature: null,
        authenticatedAt: null,
      };
      setWallet(next);
      setWalletStatus({ ok: true, message: 'Wallet connected.' });
    } catch (err) {
      setWalletStatus({
        ok: false,
        message: walletErrorMessage(err, 'Failed to connect wallet.'),
      });
    } finally {
      setConnecting(false);
    }
  }

  async function onSignAuthMessage() {
    setSigning(true);
    setWalletStatus(null);
    try {
      const provider = getEthereumProvider();
      if (!provider) throw new Error('No injected wallet found.');
      if (!wallet.address) throw new Error('Connect a wallet first.');

      const chainIdHex = wallet.chainIdHex ?? toChainIdHex(settings.chainId);
      const issuedAt = new Date().toISOString();
      const nonce =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `${Date.now()}`;
      const message = [
        'CipherScope Foundry Authentication',
        `Address: ${wallet.address}`,
        `Chain ID: ${chainIdHex}`,
        `RPC URL: ${settings.rpcUrl}`,
        `Issued At: ${issuedAt}`,
        `Nonce: ${nonce}`,
      ].join('\n');

      let signature: unknown;
      try {
        signature = await callWalletRpc<unknown>({
          provider,
          method: 'personal_sign',
          params: [message, wallet.address],
          rpcUrl: settings.rpcUrl,
          chainId: settings.chainId,
        });
      } catch {
        signature = await callWalletRpc<unknown>({
          provider,
          method: 'personal_sign',
          params: [wallet.address, message],
          rpcUrl: settings.rpcUrl,
          chainId: settings.chainId,
        });
      }
      if (typeof signature !== 'string' || !signature) {
        throw new Error('Wallet did not return a signature.');
      }

      const next: WalletAuthSession = {
        ...wallet,
        authMessage: message,
        signature,
        authenticatedAt: issuedAt,
      };
      setWallet(next);
      setWalletStatus({ ok: true, message: 'Wallet authenticated with signed message.' });
    } catch (err) {
      setWalletStatus({
        ok: false,
        message: walletErrorMessage(err, 'Failed to sign authentication message.'),
      });
    } finally {
      setSigning(false);
    }
  }

  async function onSwitchWalletChain() {
    setSwitching(true);
    setWalletStatus(null);
    try {
      const provider = getEthereumProvider();
      if (!provider) throw new Error('No injected wallet found.');
      const targetChainId = normalizeSettingsDraft(draft).chainId;
      const chainIdHex = toChainIdHex(targetChainId);

      try {
        await callWalletRpc({
          provider,
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: chainIdHex }],
          rpcUrl: settings.rpcUrl,
          chainId: targetChainId,
        });
      } catch (err) {
        const code = (err as { code?: unknown } | null)?.code;
        if (code !== 4902) throw err;
        const cfg = normalizeSettingsDraft(draft);
        await callWalletRpc({
          provider,
          method: 'wallet_addEthereumChain',
          params: [
            {
              chainId: chainIdHex,
              chainName: cfg.chainName,
              rpcUrls: [cfg.rpcUrl],
              nativeCurrency: {
                name: cfg.currencySymbol,
                symbol: cfg.currencySymbol,
                decimals: 18,
              },
              blockExplorerUrls: cfg.blockExplorerUrl ? [cfg.blockExplorerUrl] : [],
            },
          ],
          rpcUrl: cfg.rpcUrl,
          chainId: cfg.chainId,
        });
      }

      const accounts = await callWalletRpc<unknown>({
        provider,
        method: 'eth_accounts',
        rpcUrl: settings.rpcUrl,
        chainId: targetChainId,
      });
      const activeAddress =
        Array.isArray(accounts) && typeof accounts[0] === 'string' ? accounts[0] : wallet.address;
      setWallet({
        ...wallet,
        address: activeAddress,
        chainIdHex,
        connectedAt: wallet.connectedAt ?? new Date().toISOString(),
      });
      setWalletStatus({ ok: true, message: `Wallet switched to chain ${targetChainId}.` });
    } catch (err) {
      setWalletStatus({
        ok: false,
        message: walletErrorMessage(err, 'Failed to switch wallet chain.'),
      });
    } finally {
      setSwitching(false);
    }
  }

  return (
    <>
      <div className="border-b border-[color:var(--cs-border)]">
        <div className="border-b border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-3 py-1.5 text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">
          Foundry Runtime
        </div>
        <div className="px-3 py-2">
          <p className="mb-2 text-[11px] text-[color:var(--cs-muted)]">
            Configure the Anvil/Foundry JSON-RPC endpoint used by Contract Sandbox and wallet actions.
          </p>
          <form className="grid grid-cols-1 gap-2 md:grid-cols-2" onSubmit={onSaveSettings}>
            <Field label="RPC URL">
              <input
                className={inputClass}
                value={draft.rpcUrl}
                onChange={(e) => setDraft((prev) => ({ ...prev, rpcUrl: e.target.value }))}
                placeholder="http://127.0.0.1:8545"
              />
            </Field>
            <Field label="Chain ID">
              <input
                type="number"
                min={1}
                step={1}
                className={inputClass}
                value={String(draft.chainId)}
                onChange={(e) =>
                  setDraft((prev) => ({ ...prev, chainId: Number.parseInt(e.target.value, 10) || 0 }))
                }
              />
            </Field>
            <Field label="Chain Name">
              <input
                className={inputClass}
                value={draft.chainName}
                onChange={(e) => setDraft((prev) => ({ ...prev, chainName: e.target.value }))}
              />
            </Field>
            <Field label="Currency Symbol">
              <input
                className={inputClass}
                value={draft.currencySymbol}
                onChange={(e) => setDraft((prev) => ({ ...prev, currencySymbol: e.target.value }))}
                placeholder="ETH"
              />
            </Field>
            <Field label="Block Explorer URL (optional)">
              <input
                className={inputClass}
                value={draft.blockExplorerUrl}
                onChange={(e) => setDraft((prev) => ({ ...prev, blockExplorerUrl: e.target.value }))}
                placeholder="https://etherscan.io"
              />
            </Field>
            <Field label="Receipt Poll Interval (ms)">
              <input
                type="number"
                min={250}
                step={250}
                className={inputClass}
                value={String(draft.pollIntervalMs)}
                onChange={(e) =>
                  setDraft((prev) => ({
                    ...prev,
                    pollIntervalMs: Number.parseInt(e.target.value, 10) || DEFAULT_FOUNDRY_SETTINGS.pollIntervalMs,
                  }))
                }
              />
            </Field>
            <Field label="Default Gas Limit">
              <input
                className={inputClass}
                value={draft.defaultGasLimit}
                onChange={(e) => setDraft((prev) => ({ ...prev, defaultGasLimit: e.target.value }))}
                placeholder="210000"
              />
            </Field>

            <label className="inline-flex items-center gap-2 text-[11px] text-[color:var(--cs-muted)] md:col-span-2">
              <input
                type="checkbox"
                checked={draft.defaultSimulateOnly}
                onChange={(e) =>
                  setDraft((prev) => ({ ...prev, defaultSimulateOnly: e.currentTarget.checked }))
                }
                className="h-3.5 w-3.5 rounded border-[color:var(--cs-border)] accent-[color:var(--cs-accent)]"
              />
              Default Contract Sandbox to simulate-only mode
            </label>

            <div className="flex flex-wrap items-center gap-2 md:col-span-2">
              <button type="submit" disabled={saving} className={btnClass}>
                {saving ? 'Saving…' : 'Save Foundry Config'}
              </button>
              <button type="button" disabled={testing} onClick={() => void onTestRpc()} className={btnClass}>
                {testing ? 'Testing…' : 'Test RPC'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setDraft(DEFAULT_FOUNDRY_SETTINGS);
                  setSettingsStatus(null);
                  setRpcStatus(null);
                }}
                className={btnClass}
              >
                Reset Defaults
              </button>
            </div>
            {settingsStatus ? (
              <InlineMessage ok={settingsStatus.ok} message={settingsStatus.message} />
            ) : null}
            {rpcStatus ? <InlineMessage ok={rpcStatus.ok} message={rpcStatus.message} /> : null}
            <div className="text-[10px] text-[color:var(--cs-muted)] md:col-span-2">
              Default local node: <code className="font-mono">anvil --host 127.0.0.1 --port 8545</code>
            </div>
          </form>
        </div>
      </div>

      <div className="border-b border-[color:var(--cs-border)]">
        <div className="border-b border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-3 py-1.5 text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">
          Wallet Authentication
        </div>
        <div className="space-y-2 px-3 py-2">
          <p className="text-[11px] text-[color:var(--cs-muted)]">
            Connect your injected wallet and authenticate for Contract Sandbox transactions.
          </p>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-[11px] sm:grid-cols-4">
            <Info label="Address" value={shortAddress(wallet.address)} />
            <Info label="Chain" value={wallet.chainIdHex ?? '—'} />
            <Info label="Connected" value={wallet.connectedAt ? 'Yes' : 'Never'} />
            <Info label="Auth" value={wallet.signature ? 'Signed' : '—'} />
          </div>

          <div className="flex flex-wrap gap-2">
            <button disabled={connecting} onClick={() => void onConnectWallet()} className={btnClass}>
              <Wallet className="h-3.5 w-3.5" />
              {connecting ? 'Connecting…' : 'Connect Wallet'}
            </button>
            <button
              disabled={signing || !wallet.address}
              onClick={() => void onSignAuthMessage()}
              className={btnClass}
            >
              {signing ? 'Signing…' : 'Sign Auth Message'}
            </button>
            <button disabled={switching} onClick={() => void onSwitchWalletChain()} className={btnClass}>
              {switching ? 'Switching…' : 'Switch to Foundry Chain'}
            </button>
            <button type="button" onClick={() => clearWallet()} className={btnClass}>
              Clear Session
            </button>
          </div>

          {walletChainId !== null && walletChainId !== settings.chainId ? (
            <div className="border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-700">
              Wallet chain {walletChainId} ≠ Foundry {settings.chainId}. Switch chain before sending.
            </div>
          ) : null}

          {wallet.authMessage ? (
            <div className="border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] p-2">
              <div className="mb-1 flex items-center gap-1 text-[10px] font-bold text-emerald-600">
                <CheckCircle2 className="h-3 w-3" />
                Signed Authentication Message
              </div>
              <pre className="overflow-x-auto font-mono text-[11px] text-[color:var(--cs-muted)]">{wallet.authMessage}</pre>
            </div>
          ) : null}

          {walletStatus ? <InlineMessage ok={walletStatus.ok} message={walletStatus.message} /> : null}

          <p className="text-[10px] text-[color:var(--cs-muted)]">
            Open{' '}
            <Link className="font-medium text-[color:var(--cs-accent)] hover:underline" href="/">
              Contract Sandbox <ExternalLink className="inline h-3 w-3" />
            </Link>{' '}
            to send or simulate transactions.
          </p>
        </div>
      </div>
    </>
  );
}

function Field(props: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-0.5">
      <div className="text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">{props.label}</div>
      {props.children}
    </label>
  );
}

function InlineMessage(props: InlineStatus) {
  return (
    <div
      className={`border px-2 py-1.5 text-[11px] md:col-span-2 ${
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
    <div>
      <span className="text-[10px] text-[color:var(--cs-muted)]">{props.label}: </span>
      <span className="font-medium text-[color:var(--cs-fg)]">{props.value}</span>
    </div>
  );
}
