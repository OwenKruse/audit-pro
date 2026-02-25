'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { CheckCircle2, Copy, ExternalLink, RefreshCw, Wallet } from 'lucide-react';
import { mnemonicToAccount } from 'viem/accounts';
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
type DevWalletSeed = {
  address: string;
  derivationPath: string;
  privateKey: string | null;
};

const inputClass =
  'h-7 w-full rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 text-[12px] outline-none focus:border-[color:var(--cs-accent)]';
const btnClass =
  'inline-flex h-7 items-center gap-1.5 rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 text-[11px] font-medium text-[color:var(--cs-fg)] transition-colors hover:bg-[color:var(--cs-hover)] disabled:opacity-50';
const DEFAULT_ANVIL_DEV_MNEMONIC = 'test test test test test test test test test test test junk';

function isAddress(value: unknown): value is string {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
}

function bytesToHex(bytes: Uint8Array): string {
  return `0x${Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')}`;
}

function deriveDefaultAnvilWallet(index: number): { address: string; privateKey: string | null } {
  const derived = mnemonicToAccount(DEFAULT_ANVIL_DEV_MNEMONIC, { addressIndex: index });
  const hdKey = derived.getHdKey();
  const privateKey = hdKey.privateKey ? bytesToHex(hdKey.privateKey) : null;
  return { address: derived.address.toLowerCase(), privateKey };
}

function deriveDefaultAnvilPrivateKeys(addresses: string[]): string[] | null {
  const keys: string[] = [];
  for (let index = 0; index < addresses.length; index += 1) {
    const derived = deriveDefaultAnvilWallet(index);
    if (derived.address !== addresses[index] || !derived.privateKey) return null;
    keys.push(derived.privateKey);
  }
  return keys;
}

function isLocalRpcUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    return host === '127.0.0.1' || host === 'localhost' || host === '::1';
  } catch {
    return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?/i.test(trimmed);
  }
}

function resolveWalletChainRpcUrl(rpcUrl: string): string {
  if (!isLocalRpcUrl(rpcUrl)) return rpcUrl;
  if (typeof window === 'undefined') return rpcUrl;
  return `${window.location.origin}/api/foundry/wallet-rpc`;
}

function toRpcHex(value: bigint): string {
  return `0x${value.toString(16)}`;
}

function parseEthToWei(value: string): bigint | null {
  const raw = value.trim();
  if (!raw) return null;
  const match = raw.match(/^(\d+)(?:\.(\d{0,18}))?$/);
  if (!match) return null;
  const whole = BigInt(match[1]);
  const fractionRaw = match[2] ?? '';
  const fractionPadded = `${fractionRaw}${'0'.repeat(18 - fractionRaw.length)}`;
  const fraction = fractionPadded ? BigInt(fractionPadded) : BigInt(0);
  return whole * BigInt(10) ** BigInt(18) + fraction;
}

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
  const [probingWalletBalance, setProbingWalletBalance] = useState(false);

  const [settingsStatus, setSettingsStatus] = useState<InlineStatus | null>(null);
  const [rpcStatus, setRpcStatus] = useState<InlineStatus | null>(null);
  const [walletStatus, setWalletStatus] = useState<InlineStatus | null>(null);
  const [devWalletSeeds, setDevWalletSeeds] = useState<DevWalletSeed[]>([]);
  const [devWalletStatus, setDevWalletStatus] = useState<InlineStatus | null>(null);
  const [loadingDevWallets, setLoadingDevWallets] = useState(false);
  const [fundingDevWallets, setFundingDevWallets] = useState(false);
  const [fundAmountEth, setFundAmountEth] = useState('10000');
  const [walletRpcUrl, setWalletRpcUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setDraft(settings);
  }, [settings]);

  useEffect(() => {
    fetch('/api/foundry/wallet-rpc-info')
      .then((r) => r.json())
      .then((data: unknown) => {
        const url = (data as { walletRpcUrl?: unknown })?.walletRpcUrl;
        if (typeof url === 'string' && url) {
          setWalletRpcUrl(url);
          // #region agent log
          fetch('http://127.0.0.1:7683/ingest/826eec37-4705-4e23-8b79-6677a4f37c3e',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'4aeaa9'},body:JSON.stringify({sessionId:'4aeaa9',location:'FoundrySettingsCard.tsx:wallet-rpc-info',message:'resolved wallet rpc url',data:{walletRpcUrl:url},timestamp:Date.now(),hypothesisId:'H-I'})}).catch(()=>{});
          // #endregion
        }
      })
      .catch(() => {});
  }, []);

  function copyWalletRpcUrl() {
    if (!walletRpcUrl) return;
    navigator.clipboard.writeText(walletRpcUrl).then(() => {
      setCopied(true);
    }).catch(() => {});
    // #region agent log
    fetch('http://127.0.0.1:7683/ingest/826eec37-4705-4e23-8b79-6677a4f37c3e',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'4aeaa9'},body:JSON.stringify({sessionId:'4aeaa9',location:'FoundrySettingsCard.tsx:copyWalletRpcUrl',message:'user copied wallet rpc url',data:{walletRpcUrl},timestamp:Date.now(),hypothesisId:'H-G'})}).catch(()=>{});
    // #endregion
  }

  const walletChainId = useMemo(() => {
    if (!wallet.chainIdHex) return null;
    return fromChainIdHex(wallet.chainIdHex);
  }, [wallet.chainIdHex]);
  const localMainnetWarning = useMemo(
    () => isLocalRpcUrl(draft.rpcUrl) && draft.chainId === 1,
    [draft.chainId, draft.rpcUrl],
  );
  const effectiveWalletRpcUrl = useMemo(() => resolveWalletChainRpcUrl(draft.rpcUrl), [draft.rpcUrl]);

  const loadDevWalletSeeds = useCallback(async () => {
    setLoadingDevWallets(true);
    setDevWalletStatus(null);
    try {
      const addressesRaw = await callFoundryRpc<unknown>({
        rpcUrl: settings.rpcUrl,
        method: 'eth_accounts',
        chainId: settings.chainId,
      });
      if (!Array.isArray(addressesRaw)) {
        throw new Error('Foundry RPC returned an invalid account list.');
      }
      const addresses = addressesRaw.filter(isAddress).map((address) => address.toLowerCase());
      const derivedPrivateKeys = deriveDefaultAnvilPrivateKeys(addresses);

      const next = addresses.map((address, index) => ({
        address,
        derivationPath: `m/44'/60'/0'/0/${index}`,
        privateKey: derivedPrivateKeys?.[index] ?? null,
      }));
      setDevWalletSeeds(next);

      if (!next.length) {
        setDevWalletStatus({ ok: false, message: 'No preloaded dev wallets were returned by this RPC endpoint.' });
      } else if (!derivedPrivateKeys) {
        setDevWalletStatus({
          ok: false,
          message:
            'Detected custom dev wallets. Private keys can only be derived automatically for the default Anvil mnemonic.',
        });
      }
    } catch (err) {
      setDevWalletSeeds([]);
      setDevWalletStatus({
        ok: false,
        message: err instanceof Error ? err.message : 'Failed to read preloaded dev wallets.',
      });
    } finally {
      setLoadingDevWallets(false);
    }
  }, [settings.chainId, settings.rpcUrl]);

  async function onCopyPrivateKey(privateKey: string | null, label: string) {
    if (!privateKey) return;
    try {
      await navigator.clipboard.writeText(privateKey);
      setDevWalletStatus({ ok: true, message: `Private key copied for ${label}.` });
    } catch {
      setDevWalletStatus({ ok: false, message: `Failed to copy private key for ${label}.` });
    }
  }

  async function onFundWallets() {
    setFundingDevWallets(true);
    setDevWalletStatus(null);
    try {
      if (!isLocalRpcUrl(settings.rpcUrl)) {
        throw new Error('Funding wallets is only supported on local Anvil RPC endpoints.');
      }
      const wei = parseEthToWei(fundAmountEth);
      if (wei == null || wei <= BigInt(0)) {
        throw new Error('Fund amount must be a positive decimal number with up to 18 decimals.');
      }
      const balanceHex = toRpcHex(wei);
      const targets = new Set<string>();
      for (const item of devWalletSeeds) {
        if (isAddress(item.address)) targets.add(item.address.toLowerCase());
      }
      if (wallet.address && isAddress(wallet.address)) {
        targets.add(wallet.address.toLowerCase());
      }
      const provider = getEthereumProvider();
      if (provider) {
        try {
          const injectedAccounts = await callWalletRpc<unknown>({
            provider,
            method: 'eth_accounts',
            rpcUrl: settings.rpcUrl,
            chainId: settings.chainId,
          });
          if (Array.isArray(injectedAccounts)) {
            for (const account of injectedAccounts) {
              if (isAddress(account)) targets.add(account.toLowerCase());
            }
          }
        } catch {
          // Ignore wallet account read errors and continue with available targets.
        }
      }
      if (!targets.size) {
        throw new Error('No wallets available to fund. Refresh wallet list and connect wallet first.');
      }

      for (const address of targets) {
        await callFoundryRpc({
          rpcUrl: settings.rpcUrl,
          method: 'anvil_setBalance',
          params: [address, balanceHex],
          chainId: settings.chainId,
        });
      }
      setDevWalletStatus({
        ok: true,
        message: `Set ${targets.size} wallet balance(s) to ${fundAmountEth.trim()} ${settings.currencySymbol}.`,
      });
    } catch (err) {
      setDevWalletStatus({
        ok: false,
        message: err instanceof Error ? err.message : 'Failed to fund wallets.',
      });
    } finally {
      setFundingDevWallets(false);
    }
  }

  useEffect(() => {
    void loadDevWalletSeeds();
  }, [loadDevWalletSeeds]);

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
        const cfg = normalizeSettingsDraft(draft);
        const walletRpcUrl = resolveWalletChainRpcUrl(cfg.rpcUrl);
        await callWalletRpc({
          provider,
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: chainIdHex }],
          rpcUrl: walletRpcUrl,
          chainId: targetChainId,
        });
      } catch (err) {
        const code = (err as { code?: unknown } | null)?.code;
        if (code !== 4902) throw err;
        const cfg = normalizeSettingsDraft(draft);
        const walletRpcUrl = resolveWalletChainRpcUrl(cfg.rpcUrl);
        await callWalletRpc({
          provider,
          method: 'wallet_addEthereumChain',
          params: [
            {
              chainId: chainIdHex,
              chainName: cfg.chainName,
              rpcUrls: [walletRpcUrl],
              nativeCurrency: {
                name: cfg.currencySymbol,
                symbol: cfg.currencySymbol,
                decimals: 18,
              },
              blockExplorerUrls: cfg.blockExplorerUrl ? [cfg.blockExplorerUrl] : [],
            },
          ],
          rpcUrl: walletRpcUrl,
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

  async function onProbeWalletBalance() {
    setProbingWalletBalance(true);
    setWalletStatus(null);
    try {
      const provider = getEthereumProvider();
      if (!provider) throw new Error('No injected wallet found.');

      const accounts = await callWalletRpc<unknown>({
        provider,
        method: 'eth_accounts',
        rpcUrl: walletRpcUrl ?? settings.rpcUrl,
        chainId: settings.chainId,
      });
      const activeAddress =
        Array.isArray(accounts) && typeof accounts[0] === 'string' ? accounts[0].toLowerCase() : null;
      if (!activeAddress || !isAddress(activeAddress)) {
        throw new Error('Wallet did not return a valid active account.');
      }

      const walletBalance = await callWalletRpc<unknown>({
        provider,
        method: 'eth_getBalance',
        params: [activeAddress, 'latest'],
        rpcUrl: walletRpcUrl ?? settings.rpcUrl,
        chainId: settings.chainId,
      });
      const foundryBalance = await callFoundryRpc<unknown>({
        rpcUrl: settings.rpcUrl,
        method: 'eth_getBalance',
        params: [activeAddress, 'latest'],
        chainId: settings.chainId,
      });

      // #region agent log
      fetch('http://127.0.0.1:7683/ingest/826eec37-4705-4e23-8b79-6677a4f37c3e',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'4aeaa9'},body:JSON.stringify({sessionId:'4aeaa9',location:'FoundrySettingsCard.tsx:onProbeWalletBalance',message:'wallet vs foundry balance probe',data:{activeAddress,walletBalanceHex:walletBalance,foundryBalanceHex:foundryBalance,walletRpcUrl:walletRpcUrl ?? settings.rpcUrl},timestamp:Date.now(),hypothesisId:'H-I,H-J,H-K'})}).catch(()=>{});
      // #endregion

      setWalletStatus({
        ok: true,
        message: `Probe ${activeAddress}: wallet=${String(walletBalance)} foundry=${String(foundryBalance)}`,
      });
    } catch (err) {
      setWalletStatus({
        ok: false,
        message: walletErrorMessage(err, 'Failed to probe wallet balance.'),
      });
    } finally {
      setProbingWalletBalance(false);
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
          <p className="mb-2 text-[11px] text-[color:var(--cs-muted)]">
            Chain ID and chain name are managed in <span className="font-medium">Anvil Fork (Agent)</span> below.
          </p>
          <p className="mb-2 text-[10px] text-[color:var(--cs-muted)]">
            Wallet chain registration uses <span className="font-mono">{effectiveWalletRpcUrl}</span>
            {isLocalRpcUrl(draft.rpcUrl) ? ' (HTTPS bridge for local Anvil).' : '.'}
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
            <Field label="Effective Chain (from Anvil Fork)">
              <div className="flex h-7 items-center rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-2 font-mono text-[12px] text-[color:var(--cs-fg)]">
                {draft.chainName} (#{draft.chainId})
              </div>
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
                  setDraft((prev) => ({
                    ...DEFAULT_FOUNDRY_SETTINGS,
                    rpcUrl: prev.rpcUrl,
                    chainId: prev.chainId,
                    chainName: prev.chainName,
                    currencySymbol: prev.currencySymbol,
                    blockExplorerUrl: prev.blockExplorerUrl,
                  }));
                  setSettingsStatus(null);
                  setRpcStatus(null);
                }}
                className={btnClass}
              >
                Reset Runtime Defaults
              </button>
            </div>
            {settingsStatus ? (
              <InlineMessage ok={settingsStatus.ok} message={settingsStatus.message} />
            ) : null}
            {rpcStatus ? <InlineMessage ok={rpcStatus.ok} message={rpcStatus.message} /> : null}
            {localMainnetWarning ? (
              <div className="border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-700 md:col-span-2">
                Local RPC with chainId 1 can conflict with MetaMask mainnet. In Anvil Fork settings, use a
                non-mainnet chainId (for example 31337) for reliable wallet switching.
              </div>
            ) : null}
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
          {walletRpcUrl ? (
            <div className="rounded border border-[color:var(--cs-accent)]/40 bg-[color:var(--cs-accent)]/5 p-2">
              <div className="mb-1 text-[10px] font-bold uppercase text-[color:var(--cs-accent)]">
                Wallet RPC URL — add this to MetaMask / Rabby
              </div>
              <div className="mb-1.5 flex items-center gap-1.5">
                <code className="flex-1 overflow-x-auto rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 py-1 font-mono text-[11px] text-[color:var(--cs-fg)]">
                  {walletRpcUrl}
                </code>
                <button
                  type="button"
                  onClick={copyWalletRpcUrl}
                  className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 text-[10px] font-medium transition-colors hover:bg-[color:var(--cs-hover)]"
                >
                  <Copy className="h-3 w-3" />
                  {copied ? 'Copied!' : 'Copy'}
                </button>
              </div>
              <ol className="list-decimal space-y-0.5 pl-4 text-[10px] text-[color:var(--cs-muted)]">
                <li>Open MetaMask → Settings → Networks → Ethereum Mainnet → <strong>Add RPC URL</strong></li>
                <li>Paste the URL above and save</li>
                <li><strong>Click on it in the dropdown to SELECT it</strong> as the active provider</li>
                <li>Switch to a different network, then switch back to Ethereum Mainnet to refresh your balance</li>
                <li>For Rabby: go to Settings → Networks → Ethereum Mainnet → set the RPC URL above</li>
              </ol>
            </div>
          ) : null}
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
            <button disabled={probingWalletBalance} onClick={() => void onProbeWalletBalance()} className={btnClass}>
              {probingWalletBalance ? 'Probing…' : 'Probe Wallet Balance'}
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

      <div className="border-b border-[color:var(--cs-border)]">
        <div className="border-b border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-3 py-1.5 text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">
          Preloaded Dev Wallet Private Keys
        </div>
        <div className="space-y-2 px-3 py-2">
          <p className="text-[11px] text-[color:var(--cs-muted)]">
            Foundry preloads local wallets for testing. Copy each private key to import that wallet.
          </p>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={loadingDevWallets}
              onClick={() => void loadDevWalletSeeds()}
              className={btnClass}
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loadingDevWallets ? 'animate-spin' : ''}`} />
              {loadingDevWallets ? 'Refreshing…' : 'Refresh Wallet List'}
            </button>
            <label className="flex items-center gap-2 rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 text-[10px] text-[color:var(--cs-muted)]">
              Fund amount ({settings.currencySymbol})
              <input
                className="h-6 w-24 rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-1.5 font-mono text-[11px] text-[color:var(--cs-fg)] outline-none focus:border-[color:var(--cs-accent)]"
                value={fundAmountEth}
                onChange={(e) => setFundAmountEth(e.target.value)}
                placeholder="10000"
              />
            </label>
            <button
              type="button"
              disabled={fundingDevWallets}
              onClick={() => void onFundWallets()}
              className={btnClass}
              title="Set listed wallet balances via anvil_setBalance on the current local Foundry RPC."
            >
              {fundingDevWallets ? 'Funding…' : 'Fund Wallets'}
            </button>
          </div>

          <p className="text-[10px] text-[color:var(--cs-muted)]">
            Funds listed dev wallets and detected injected wallet accounts. Uses local Anvil only.
          </p>

          {devWalletSeeds.length ? (
            <div className="space-y-1">
              {devWalletSeeds.map((walletSeed, index) => (
                <div
                  key={walletSeed.address}
                  className="space-y-1 rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] p-2"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">
                      Wallet {index + 1}
                    </span>
                    <span className="font-mono text-[10px] text-[color:var(--cs-muted)]">
                      {walletSeed.derivationPath}
                    </span>
                  </div>
                  <div className="font-mono text-[11px] text-[color:var(--cs-fg)]">{walletSeed.address}</div>
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-1.5 py-1 font-mono text-[10px] text-[color:var(--cs-fg)]">
                      {walletSeed.privateKey ?? 'Private key unavailable (custom wallet configuration).'}
                    </code>
                    <button
                      type="button"
                      disabled={!walletSeed.privateKey}
                      onClick={() => void onCopyPrivateKey(walletSeed.privateKey, `Wallet ${index + 1}`)}
                      className={btnClass}
                    >
                      <Copy className="h-3.5 w-3.5" />
                      Copy Private Key
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : loadingDevWallets ? (
            <div className="text-[11px] text-[color:var(--cs-muted)]">Loading dev wallets…</div>
          ) : (
            <div className="text-[11px] text-[color:var(--cs-muted)]">
              No preloaded wallets found. Confirm Foundry RPC is running locally.
            </div>
          )}

          {devWalletStatus ? <InlineMessage ok={devWalletStatus.ok} message={devWalletStatus.message} /> : null}
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
