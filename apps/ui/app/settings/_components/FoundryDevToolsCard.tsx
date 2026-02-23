'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { callFoundryRpc, callWalletRpc } from '@/lib/foundry-rpc';
import { getEthereumProvider, useFoundrySettings, useWalletAuthSession } from '@/lib/foundry-store';

type InlineStatus = { ok: boolean; message: string };
type FundingMode = 'set' | 'add';

type TokenPairPreset = {
  id: string;
  name: string;
  baseSymbol: string;
  baseToken: string;
  baseDecimals: number;
  baseBalanceSlot: number;
  quoteSymbol: string;
  quoteToken: string;
  quoteDecimals: number;
  quoteBalanceSlot: number;
};

type TokenPairForm = {
  name: string;
  baseSymbol: string;
  baseToken: string;
  baseDecimals: string;
  baseBalanceSlot: string;
  quoteSymbol: string;
  quoteToken: string;
  quoteDecimals: string;
  quoteBalanceSlot: string;
};

const inputClass =
  'h-7 w-full rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 text-[12px] outline-none focus:border-[color:var(--cs-accent)]';
const textareaClass =
  'min-h-[70px] w-full rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 py-1.5 font-mono text-[11px] outline-none focus:border-[color:var(--cs-accent)]';
const btnClass =
  'inline-flex h-7 items-center gap-1.5 rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 text-[11px] font-medium text-[color:var(--cs-fg)] transition-colors hover:bg-[color:var(--cs-hover)] disabled:opacity-50';
const PAIR_PRESET_STORAGE_KEY = 'cipherscope.foundry.dev-token-pairs.v1';
const UINT256_MAX = (BigInt(1) << BigInt(256)) - BigInt(1);

const EMPTY_PAIR_FORM: TokenPairForm = {
  name: '',
  baseSymbol: '',
  baseToken: '',
  baseDecimals: '18',
  baseBalanceSlot: '0',
  quoteSymbol: '',
  quoteToken: '',
  quoteDecimals: '18',
  quoteBalanceSlot: '0',
};

function isAddress(value: unknown): value is string {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
}

function normalizeAddress(value: string): string | null {
  const out = value.trim();
  if (!isAddress(out)) return null;
  return out.toLowerCase();
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

function toRpcHex(value: bigint): string {
  return `0x${value.toString(16)}`;
}

function toBytes32Hex(value: bigint): string {
  if (value < BigInt(0) || value > UINT256_MAX) {
    throw new Error('Value must be within uint256 range.');
  }
  return `0x${value.toString(16).padStart(64, '0')}`;
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

function parseDecimalUnits(value: string, decimals: number): bigint | null {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null;
  const raw = value.trim();
  if (!raw) return null;
  const match = raw.match(/^(\d+)(?:\.(\d+))?$/);
  if (!match) return null;
  const whole = BigInt(match[1]);
  const fractionRaw = match[2] ?? '';
  if (fractionRaw.length > decimals) return null;
  const fractionPadded = `${fractionRaw}${'0'.repeat(decimals - fractionRaw.length)}`;
  const fraction = fractionPadded ? BigInt(fractionPadded) : BigInt(0);
  const scale = BigInt(10) ** BigInt(decimals);
  return whole * scale + fraction;
}

function parsePositiveSafeInt(value: string): number | null {
  const raw = value.trim();
  if (!/^\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

function parseNonNegativeSafeInt(value: string): number | null {
  const raw = value.trim();
  if (!/^\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return null;
  return parsed;
}

function parseRpcQuantity(value: unknown): bigint | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw) return null;
  try {
    if (/^0x[0-9a-fA-F]+$/.test(raw)) return BigInt(raw);
    if (/^\d+$/.test(raw)) return BigInt(raw);
  } catch {
    return null;
  }
  return null;
}

function uniqueAddresses(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizeAddress(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function parseAddressList(raw: string): { valid: string[]; invalid: string[] } {
  const tokens = raw
    .split(/[\s,;]+/g)
    .map((token) => token.trim())
    .filter(Boolean);
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const token of tokens) {
    const normalized = normalizeAddress(token);
    if (!normalized) {
      invalid.push(token);
      continue;
    }
    valid.push(normalized);
  }
  return {
    valid: uniqueAddresses(valid),
    invalid: uniqueAddresses(invalid),
  };
}

function stringifyJson(value: unknown): string {
  try {
    return JSON.stringify(
      value,
      (_key, item) => (typeof item === 'bigint' ? item.toString() : item),
      2,
    );
  } catch {
    return String(value);
  }
}

function createId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}`;
}

function parsePresets(raw: unknown): TokenPairPreset[] {
  if (!Array.isArray(raw)) return [];
  const out: TokenPairPreset[] = [];
  for (const value of raw) {
    if (!value || typeof value !== 'object') continue;
    const item = value as Record<string, unknown>;
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    const baseSymbol = typeof item.baseSymbol === 'string' ? item.baseSymbol.trim() : '';
    const baseToken = typeof item.baseToken === 'string' ? item.baseToken.trim() : '';
    const quoteSymbol = typeof item.quoteSymbol === 'string' ? item.quoteSymbol.trim() : '';
    const quoteToken = typeof item.quoteToken === 'string' ? item.quoteToken.trim() : '';
    const baseDecimals = typeof item.baseDecimals === 'number' ? item.baseDecimals : NaN;
    const quoteDecimals = typeof item.quoteDecimals === 'number' ? item.quoteDecimals : NaN;
    const baseBalanceSlot = typeof item.baseBalanceSlot === 'number' ? item.baseBalanceSlot : NaN;
    const quoteBalanceSlot = typeof item.quoteBalanceSlot === 'number' ? item.quoteBalanceSlot : NaN;
    if (!id || !name || !baseSymbol || !quoteSymbol) continue;
    if (!isAddress(baseToken) || !isAddress(quoteToken)) continue;
    if (!Number.isInteger(baseDecimals) || baseDecimals < 0 || baseDecimals > 36) continue;
    if (!Number.isInteger(quoteDecimals) || quoteDecimals < 0 || quoteDecimals > 36) continue;
    if (!Number.isInteger(baseBalanceSlot) || baseBalanceSlot < 0) continue;
    if (!Number.isInteger(quoteBalanceSlot) || quoteBalanceSlot < 0) continue;
    out.push({
      id,
      name,
      baseSymbol: baseSymbol.toUpperCase(),
      baseToken: baseToken.toLowerCase(),
      baseDecimals,
      baseBalanceSlot,
      quoteSymbol: quoteSymbol.toUpperCase(),
      quoteToken: quoteToken.toLowerCase(),
      quoteDecimals,
      quoteBalanceSlot,
    });
  }
  return out;
}

function parsePairForm(form: TokenPairForm): TokenPairPreset {
  const baseToken = normalizeAddress(form.baseToken);
  if (!baseToken) throw new Error('Base token must be a valid address.');
  const quoteToken = normalizeAddress(form.quoteToken);
  if (!quoteToken) throw new Error('Quote token must be a valid address.');

  const baseDecimals = parseNonNegativeSafeInt(form.baseDecimals);
  const quoteDecimals = parseNonNegativeSafeInt(form.quoteDecimals);
  const baseBalanceSlot = parseNonNegativeSafeInt(form.baseBalanceSlot);
  const quoteBalanceSlot = parseNonNegativeSafeInt(form.quoteBalanceSlot);
  if (baseDecimals == null || baseDecimals > 36) throw new Error('Base decimals must be 0-36.');
  if (quoteDecimals == null || quoteDecimals > 36) throw new Error('Quote decimals must be 0-36.');
  if (baseBalanceSlot == null) throw new Error('Base balance slot must be a non-negative integer.');
  if (quoteBalanceSlot == null) throw new Error('Quote balance slot must be a non-negative integer.');

  const baseSymbol = form.baseSymbol.trim().toUpperCase();
  const quoteSymbol = form.quoteSymbol.trim().toUpperCase();
  if (!baseSymbol) throw new Error('Base symbol is required.');
  if (!quoteSymbol) throw new Error('Quote symbol is required.');

  const name = form.name.trim() || `${baseSymbol}/${quoteSymbol}`;

  return {
    id: '',
    name,
    baseSymbol,
    baseToken,
    baseDecimals,
    baseBalanceSlot,
    quoteSymbol,
    quoteToken,
    quoteDecimals,
    quoteBalanceSlot,
  };
}

function presetToForm(preset: TokenPairPreset): TokenPairForm {
  return {
    name: preset.name,
    baseSymbol: preset.baseSymbol,
    baseToken: preset.baseToken,
    baseDecimals: String(preset.baseDecimals),
    baseBalanceSlot: String(preset.baseBalanceSlot),
    quoteSymbol: preset.quoteSymbol,
    quoteToken: preset.quoteToken,
    quoteDecimals: String(preset.quoteDecimals),
    quoteBalanceSlot: String(preset.quoteBalanceSlot),
  };
}

export function FoundryDevToolsCard() {
  const { settings } = useFoundrySettings();
  const { wallet } = useWalletAuthSession();

  const [detectedWallets, setDetectedWallets] = useState<string[]>([]);
  const [walletsLoading, setWalletsLoading] = useState(false);
  const [walletsStatus, setWalletsStatus] = useState<InlineStatus | null>(null);

  const [fundAmountEth, setFundAmountEth] = useState('10000');
  const [fundMode, setFundMode] = useState<FundingMode>('set');
  const [manualTargets, setManualTargets] = useState('');
  const [fundingBusy, setFundingBusy] = useState(false);
  const [fundingStatus, setFundingStatus] = useState<InlineStatus | null>(null);

  const [chainBusy, setChainBusy] = useState(false);
  const [chainStatus, setChainStatus] = useState<InlineStatus | null>(null);
  const [latestSnapshotId, setLatestSnapshotId] = useState('');
  const [revertSnapshotId, setRevertSnapshotId] = useState('');
  const [mineBlocks, setMineBlocks] = useState('1');
  const [timeIncreaseSeconds, setTimeIncreaseSeconds] = useState('3600');
  const [mineAfterTimeIncrease, setMineAfterTimeIncrease] = useState(true);
  const [nextTimestamp, setNextTimestamp] = useState('');
  const [mineAfterNextTimestamp, setMineAfterNextTimestamp] = useState(true);
  const [intervalMiningMs, setIntervalMiningMs] = useState('0');
  const [latestBlockText, setLatestBlockText] = useState<string | null>(null);

  const [impersonationBusy, setImpersonationBusy] = useState(false);
  const [impersonationStatus, setImpersonationStatus] = useState<InlineStatus | null>(null);
  const [impersonationAddress, setImpersonationAddress] = useState('');
  const [activeImpersonations, setActiveImpersonations] = useState<string[]>([]);

  const [pairPresets, setPairPresets] = useState<TokenPairPreset[]>([]);
  const [selectedPairPresetId, setSelectedPairPresetId] = useState('');
  const [pairForm, setPairForm] = useState<TokenPairForm>(EMPTY_PAIR_FORM);
  const [pairTargetWallet, setPairTargetWallet] = useState('');
  const [pairBaseAmount, setPairBaseAmount] = useState('100000');
  const [pairQuoteAmount, setPairQuoteAmount] = useState('100');
  const [pairBusy, setPairBusy] = useState(false);
  const [pairStatus, setPairStatus] = useState<InlineStatus | null>(null);

  const [rawMethod, setRawMethod] = useState('eth_getBlockByNumber');
  const [rawParams, setRawParams] = useState('["latest", false]');
  const [rawBusy, setRawBusy] = useState(false);
  const [rawStatus, setRawStatus] = useState<InlineStatus | null>(null);
  const [rawResult, setRawResult] = useState('');

  const isLocalAnvil = useMemo(() => isLocalRpcUrl(settings.rpcUrl), [settings.rpcUrl]);

  const callRpc = useCallback(
    async <T,>(method: string, params: unknown[] = []): Promise<T> =>
      await callFoundryRpc<T>({
        rpcUrl: settings.rpcUrl,
        method,
        params,
        chainId: settings.chainId,
      }),
    [settings.chainId, settings.rpcUrl],
  );

  const callLocalRpc = useCallback(
    async <T,>(method: string, params: unknown[] = []): Promise<T> => {
      if (!isLocalRpcUrl(settings.rpcUrl)) {
        throw new Error('This tool requires local Anvil RPC (localhost / 127.0.0.1).');
      }
      return await callFoundryRpc<T>({
        rpcUrl: settings.rpcUrl,
        method,
        params,
        chainId: settings.chainId,
      });
    },
    [settings.chainId, settings.rpcUrl],
  );

  const refreshDetectedWallets = useCallback(async () => {
    setWalletsLoading(true);
    setWalletsStatus(null);
    try {
      const targets = new Set<string>();

      const accountsRaw = await callRpc<unknown>('eth_accounts');
      if (Array.isArray(accountsRaw)) {
        for (const item of accountsRaw) {
          if (isAddress(item)) targets.add(item.toLowerCase());
        }
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
            for (const item of injectedAccounts) {
              if (isAddress(item)) targets.add(item.toLowerCase());
            }
          }
        } catch {
          // Ignore wallet account read errors so local dev wallets still load.
        }
      }

      const next = [...targets];
      setDetectedWallets(next);
      if (!next.length) {
        setWalletsStatus({
          ok: false,
          message: 'No wallets detected from Foundry/wallet. Refresh after connecting wallet or starting Anvil.',
        });
      }
    } catch (err) {
      setDetectedWallets([]);
      setWalletsStatus({
        ok: false,
        message: err instanceof Error ? err.message : 'Failed to read wallets from Foundry RPC.',
      });
    } finally {
      setWalletsLoading(false);
    }
  }, [callRpc, settings.chainId, settings.rpcUrl, wallet.address]);

  useEffect(() => {
    void refreshDetectedWallets();
  }, [refreshDetectedWallets]);

  const refreshLatestBlock = useCallback(async () => {
    try {
      const block = await callRpc<unknown>('eth_getBlockByNumber', ['latest', false]);
      if (!block || typeof block !== 'object') return;
      const number = (block as { number?: unknown }).number;
      const timestamp = (block as { timestamp?: unknown }).timestamp;
      if (typeof number !== 'string' || typeof timestamp !== 'string') return;
      const blockNumber = parseRpcQuantity(number);
      const blockTimestamp = parseRpcQuantity(timestamp);
      if (blockNumber == null || blockTimestamp == null) return;
      const date = new Date(Number(blockTimestamp) * 1000);
      setLatestBlockText(`#${blockNumber.toString()} @ ${date.toISOString()}`);
    } catch {
      // Ignore display-only refresh errors.
    }
  }, [callRpc]);

  useEffect(() => {
    void refreshLatestBlock();
  }, [refreshLatestBlock]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const raw = window.localStorage.getItem(PAIR_PRESET_STORAGE_KEY);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as unknown;
      setPairPresets(parsePresets(parsed));
    } catch {
      setPairPresets([]);
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(PAIR_PRESET_STORAGE_KEY, JSON.stringify(pairPresets));
  }, [pairPresets]);

  useEffect(() => {
    if (pairTargetWallet.trim()) return;
    if (wallet.address && isAddress(wallet.address)) {
      setPairTargetWallet(wallet.address.toLowerCase());
      return;
    }
    if (detectedWallets[0]) {
      setPairTargetWallet(detectedWallets[0]);
    }
  }, [detectedWallets, pairTargetWallet, wallet.address]);

  function appendManualTargets(addresses: string[]) {
    const existing = parseAddressList(manualTargets).valid;
    const next = uniqueAddresses([...existing, ...addresses]);
    setManualTargets(next.join('\n'));
  }

  async function setNativeBalance(address: string, amountWei: bigint, mode: FundingMode): Promise<void> {
    let nextAmount = amountWei;
    if (mode === 'add') {
      const currentBalance = await callRpc<unknown>('eth_getBalance', [address, 'latest']);
      const currentWei = parseRpcQuantity(currentBalance);
      if (currentWei == null) {
        throw new Error(`RPC returned invalid balance for ${address}.`);
      }
      nextAmount = currentWei + amountWei;
    }
    await callLocalRpc('anvil_setBalance', [address, toRpcHex(nextAmount)]);
  }

  async function onFundTargets(inputTargets: string[], sourceLabel: string) {
    setFundingBusy(true);
    setFundingStatus(null);
    try {
      const amountWei = parseEthToWei(fundAmountEth);
      if (amountWei == null || amountWei <= BigInt(0)) {
        throw new Error('Fund amount must be a positive decimal number with up to 18 decimals.');
      }
      if (!isLocalAnvil) {
        throw new Error('Targeted funding requires local Anvil RPC.');
      }
      const targets = uniqueAddresses(inputTargets);
      if (!targets.length) {
        throw new Error('No valid wallet addresses to fund.');
      }
      for (const address of targets) {
        await setNativeBalance(address, amountWei, fundMode);
      }
      setFundingStatus({
        ok: true,
        message: `${fundMode === 'set' ? 'Set' : 'Added'} ${fundAmountEth.trim()} ${settings.currencySymbol} for ${targets.length} wallet(s) from ${sourceLabel}.`,
      });
      await refreshLatestBlock();
    } catch (err) {
      setFundingStatus({
        ok: false,
        message: err instanceof Error ? err.message : 'Failed to fund wallets.',
      });
    } finally {
      setFundingBusy(false);
    }
  }

  async function onFundManualTargets() {
    const parsed = parseAddressList(manualTargets);
    if (parsed.invalid.length) {
      setFundingStatus({
        ok: false,
        message: `Invalid address entries: ${parsed.invalid.join(', ')}`,
      });
      return;
    }
    await onFundTargets(parsed.valid, 'manual target list');
  }

  async function onFundDetectedTargets() {
    await onFundTargets(detectedWallets, 'detected wallet list');
  }

  async function runChainAction(task: () => Promise<string>) {
    setChainBusy(true);
    setChainStatus(null);
    try {
      const message = await task();
      setChainStatus({ ok: true, message });
      await refreshLatestBlock();
    } catch (err) {
      setChainStatus({
        ok: false,
        message: err instanceof Error ? err.message : 'Failed to run chain action.',
      });
    } finally {
      setChainBusy(false);
    }
  }

  function onSavePairPreset() {
    setPairStatus(null);
    try {
      const parsed = parsePairForm(pairForm);
      const nextPreset: TokenPairPreset = {
        ...parsed,
        id: selectedPairPresetId || createId(),
      };
      setPairPresets((prev) => {
        if (!selectedPairPresetId) return [nextPreset, ...prev];
        return prev.map((item) => (item.id === selectedPairPresetId ? nextPreset : item));
      });
      setSelectedPairPresetId(nextPreset.id);
      setPairStatus({
        ok: true,
        message: `${selectedPairPresetId ? 'Updated' : 'Saved'} pair preset "${nextPreset.name}".`,
      });
    } catch (err) {
      setPairStatus({
        ok: false,
        message: err instanceof Error ? err.message : 'Failed to save token pair preset.',
      });
    }
  }

  function onLoadPairPreset(id: string) {
    setSelectedPairPresetId(id);
    const preset = pairPresets.find((item) => item.id === id);
    if (!preset) return;
    setPairForm(presetToForm(preset));
  }

  function onDeletePairPreset() {
    if (!selectedPairPresetId) {
      setPairStatus({ ok: false, message: 'Select a pair preset first.' });
      return;
    }
    const removed = pairPresets.find((item) => item.id === selectedPairPresetId);
    setPairPresets((prev) => prev.filter((item) => item.id !== selectedPairPresetId));
    setSelectedPairPresetId('');
    setPairStatus({
      ok: true,
      message: removed ? `Deleted pair preset "${removed.name}".` : 'Deleted pair preset.',
    });
  }

  async function resolveMappingStorageSlot(holderAddress: string, slotIndex: number): Promise<string> {
    const holderWord = holderAddress.replace(/^0x/i, '').toLowerCase().padStart(64, '0');
    const slotWord = slotIndex.toString(16).padStart(64, '0');
    const preimage = `0x${holderWord}${slotWord}`;
    const slot = await callRpc<unknown>('web3_sha3', [preimage]);
    if (typeof slot !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(slot)) {
      throw new Error('web3_sha3 returned an invalid storage slot hash.');
    }
    return slot.toLowerCase();
  }

  async function setErc20Balance(input: {
    tokenAddress: string;
    holderAddress: string;
    balanceSlot: number;
    amountUnits: bigint;
  }): Promise<string> {
    const mappingSlot = await resolveMappingStorageSlot(input.holderAddress, input.balanceSlot);
    await callLocalRpc('anvil_setStorageAt', [
      input.tokenAddress.toLowerCase(),
      mappingSlot,
      toBytes32Hex(input.amountUnits),
    ]);
    return mappingSlot;
  }

  async function onProvisionPair() {
    setPairBusy(true);
    setPairStatus(null);
    try {
      if (!isLocalAnvil) {
        throw new Error('Pair provisioning requires local Anvil RPC.');
      }
      const spec = parsePairForm(pairForm);
      const targetWallet = normalizeAddress(pairTargetWallet);
      if (!targetWallet) throw new Error('Target wallet must be a valid address.');

      const baseAmountUnits = parseDecimalUnits(pairBaseAmount, spec.baseDecimals);
      const quoteAmountUnits = parseDecimalUnits(pairQuoteAmount, spec.quoteDecimals);
      if (baseAmountUnits == null) {
        throw new Error(`Invalid ${spec.baseSymbol} amount for ${spec.baseDecimals} decimals.`);
      }
      if (quoteAmountUnits == null) {
        throw new Error(`Invalid ${spec.quoteSymbol} amount for ${spec.quoteDecimals} decimals.`);
      }
      if (baseAmountUnits > UINT256_MAX || quoteAmountUnits > UINT256_MAX) {
        throw new Error('Token amount exceeds uint256 range.');
      }

      const baseSlot = await setErc20Balance({
        tokenAddress: spec.baseToken,
        holderAddress: targetWallet,
        balanceSlot: spec.baseBalanceSlot,
        amountUnits: baseAmountUnits,
      });
      const quoteSlot = await setErc20Balance({
        tokenAddress: spec.quoteToken,
        holderAddress: targetWallet,
        balanceSlot: spec.quoteBalanceSlot,
        amountUnits: quoteAmountUnits,
      });

      await callLocalRpc('evm_mine');
      setPairStatus({
        ok: true,
        message: `Provisioned ${spec.baseSymbol}/${spec.quoteSymbol} balances for ${targetWallet}. Slots: ${baseSlot}, ${quoteSlot}.`,
      });
      await refreshLatestBlock();
    } catch (err) {
      setPairStatus({
        ok: false,
        message: err instanceof Error ? err.message : 'Failed to provision token pair balances.',
      });
    } finally {
      setPairBusy(false);
    }
  }

  async function runImpersonationAction(task: () => Promise<string>) {
    setImpersonationBusy(true);
    setImpersonationStatus(null);
    try {
      const message = await task();
      setImpersonationStatus({ ok: true, message });
    } catch (err) {
      setImpersonationStatus({
        ok: false,
        message: err instanceof Error ? err.message : 'Failed to run impersonation action.',
      });
    } finally {
      setImpersonationBusy(false);
    }
  }

  async function onRunRawRpc() {
    setRawBusy(true);
    setRawStatus(null);
    setRawResult('');
    try {
      const method = rawMethod.trim();
      if (!method) throw new Error('RPC method is required.');
      let params: unknown[] = [];
      if (rawParams.trim()) {
        const parsed = JSON.parse(rawParams) as unknown;
        params = Array.isArray(parsed) ? parsed : [parsed];
      }
      const result = await callRpc<unknown>(method, params);
      setRawResult(stringifyJson(result));
      setRawStatus({ ok: true, message: `RPC method ${method} executed.` });
    } catch (err) {
      setRawStatus({
        ok: false,
        message: err instanceof Error ? err.message : 'Failed to run raw RPC call.',
      });
    } finally {
      setRawBusy(false);
    }
  }

  return (
    <div className="border-b border-[color:var(--cs-border)]">
      <div className="border-b border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-3 py-1.5 text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">
        Foundry Dev Tools
      </div>
      <div className="space-y-3 px-3 py-2">
        <p className="text-[11px] text-[color:var(--cs-muted)]">
          Advanced local-Anvil utilities for funding, mining/time travel, impersonation, token pair provisioning,
          and raw JSON-RPC.
        </p>
        <p className="text-[10px] text-[color:var(--cs-muted)]">
          RPC: <span className="font-mono">{settings.rpcUrl}</span>{' '}
          {isLocalAnvil ? '(local Anvil detected)' : '(non-local RPC: mutating tools are restricted)'}
        </p>

        <section className="space-y-2 rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] p-2">
          <div className="text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">Targeted Wallet Funding</div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => void refreshDetectedWallets()} className={btnClass} disabled={walletsLoading}>
              <RefreshCw className={`h-3.5 w-3.5 ${walletsLoading ? 'animate-spin' : ''}`} />
              {walletsLoading ? 'Refreshing…' : 'Refresh Wallets'}
            </button>
            <label className="text-[10px] text-[color:var(--cs-muted)]">
              Mode
              <select
                className={`${inputClass} ml-1 inline-flex w-[132px]`}
                value={fundMode}
                onChange={(e) => setFundMode(e.target.value === 'add' ? 'add' : 'set')}
              >
                <option value="set">Set balance</option>
                <option value="add">Add amount</option>
              </select>
            </label>
            <label className="text-[10px] text-[color:var(--cs-muted)]">
              Amount ({settings.currencySymbol})
              <input
                className={`${inputClass} ml-1 inline-flex w-[130px]`}
                value={fundAmountEth}
                onChange={(e) => setFundAmountEth(e.target.value)}
                placeholder="10000"
              />
            </label>
          </div>

          <div className="space-y-1">
            <div className="text-[10px] font-medium text-[color:var(--cs-muted)]">Detected Wallets</div>
            {detectedWallets.length ? (
              <div className="flex flex-wrap gap-1.5">
                {detectedWallets.map((address) => (
                  <button
                    key={address}
                    type="button"
                    className="rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-1.5 py-1 font-mono text-[10px] hover:bg-[color:var(--cs-hover)]"
                    onClick={() => appendManualTargets([address])}
                    title="Add to manual target list"
                  >
                    {address}
                  </button>
                ))}
              </div>
            ) : (
              <div className="text-[11px] text-[color:var(--cs-muted)]">No wallets currently detected.</div>
            )}
          </div>

          <label className="block space-y-1">
            <div className="text-[10px] font-medium text-[color:var(--cs-muted)]">
              Manual Target Wallets (comma/newline separated)
            </div>
            <textarea
              className={textareaClass}
              value={manualTargets}
              onChange={(e) => setManualTargets(e.target.value)}
              placeholder="0xabc...
0xdef..."
            />
          </label>

          <div className="flex flex-wrap gap-2">
            <button type="button" className={btnClass} onClick={() => void onFundManualTargets()} disabled={fundingBusy}>
              {fundingBusy ? 'Funding…' : 'Fund Manual Targets'}
            </button>
            <button type="button" className={btnClass} onClick={() => void onFundDetectedTargets()} disabled={fundingBusy || !detectedWallets.length}>
              {fundingBusy ? 'Funding…' : 'Fund All Detected Wallets'}
            </button>
            <button
              type="button"
              className={btnClass}
              onClick={() => appendManualTargets(detectedWallets)}
              disabled={!detectedWallets.length}
            >
              Copy Detected Into Manual
            </button>
            <button type="button" className={btnClass} onClick={() => setManualTargets('')}>
              Clear Manual Targets
            </button>
          </div>

          {walletsStatus ? <InlineMessage ok={walletsStatus.ok} message={walletsStatus.message} /> : null}
          {fundingStatus ? <InlineMessage ok={fundingStatus.ok} message={fundingStatus.message} /> : null}
        </section>

        <section className="space-y-2 rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] p-2">
          <div className="text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">Chain, Block, and Time Controls</div>
          {latestBlockText ? (
            <div className="rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-2 py-1 font-mono text-[10px] text-[color:var(--cs-muted)]">
              Latest block: {latestBlockText}
            </div>
          ) : null}

          <div className="flex flex-wrap items-end gap-2">
            <button
              type="button"
              className={btnClass}
              disabled={chainBusy}
              onClick={() =>
                void runChainAction(async () => {
                  const snapshotId = await callLocalRpc<unknown>('anvil_snapshot');
                  if (typeof snapshotId !== 'string' || !snapshotId.trim()) {
                    throw new Error('anvil_snapshot returned invalid snapshot id.');
                  }
                  setLatestSnapshotId(snapshotId);
                  setRevertSnapshotId(snapshotId);
                  return `Snapshot created: ${snapshotId}.`;
                })
              }
            >
              {chainBusy ? 'Running…' : 'Create Snapshot'}
            </button>
            <label className="block min-w-[220px] space-y-0.5">
              <div className="text-[10px] text-[color:var(--cs-muted)]">Snapshot ID</div>
              <input
                className={inputClass}
                value={revertSnapshotId}
                onChange={(e) => setRevertSnapshotId(e.target.value)}
                placeholder={latestSnapshotId || '0x...'}
              />
            </label>
            <button
              type="button"
              className={btnClass}
              disabled={chainBusy}
              onClick={() =>
                void runChainAction(async () => {
                  const snapshotId = revertSnapshotId.trim() || latestSnapshotId.trim();
                  if (!snapshotId) throw new Error('Provide a snapshot id before reverting.');
                  const reverted = await callLocalRpc<unknown>('anvil_revert', [snapshotId]);
                  if (reverted !== true) throw new Error(`Snapshot ${snapshotId} was not reverted.`);
                  return `Reverted chain state to snapshot ${snapshotId}.`;
                })
              }
            >
              {chainBusy ? 'Running…' : 'Revert Snapshot'}
            </button>
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <label className="block min-w-[130px] space-y-0.5">
              <div className="text-[10px] text-[color:var(--cs-muted)]">Mine Blocks</div>
              <input
                className={inputClass}
                value={mineBlocks}
                onChange={(e) => setMineBlocks(e.target.value)}
                placeholder="1"
              />
            </label>
            <button
              type="button"
              className={btnClass}
              disabled={chainBusy}
              onClick={() =>
                void runChainAction(async () => {
                  const blocks = parsePositiveSafeInt(mineBlocks);
                  if (blocks == null) throw new Error('Blocks must be a positive integer.');
                  if (blocks === 1) {
                    await callLocalRpc('evm_mine');
                  } else {
                    await callLocalRpc('anvil_mine', [toRpcHex(BigInt(blocks))]);
                  }
                  return `Mined ${blocks} block${blocks === 1 ? '' : 's'}.`;
                })
              }
            >
              {chainBusy ? 'Running…' : 'Mine'}
            </button>
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <label className="block min-w-[170px] space-y-0.5">
              <div className="text-[10px] text-[color:var(--cs-muted)]">Increase Time (seconds)</div>
              <input
                className={inputClass}
                value={timeIncreaseSeconds}
                onChange={(e) => setTimeIncreaseSeconds(e.target.value)}
                placeholder="3600"
              />
            </label>
            <label className="inline-flex items-center gap-1.5 pb-1 text-[10px] text-[color:var(--cs-muted)]">
              <input
                type="checkbox"
                checked={mineAfterTimeIncrease}
                onChange={(e) => setMineAfterTimeIncrease(e.currentTarget.checked)}
                className="h-3.5 w-3.5 rounded border-[color:var(--cs-border)] accent-[color:var(--cs-accent)]"
              />
              Mine after increase
            </label>
            <button
              type="button"
              className={btnClass}
              disabled={chainBusy}
              onClick={() =>
                void runChainAction(async () => {
                  const seconds = parsePositiveSafeInt(timeIncreaseSeconds);
                  if (seconds == null) throw new Error('Seconds must be a positive integer.');
                  await callLocalRpc('evm_increaseTime', [seconds]);
                  if (mineAfterTimeIncrease) await callLocalRpc('evm_mine');
                  return `Increased EVM time by ${seconds}s${mineAfterTimeIncrease ? ' and mined 1 block' : ''}.`;
                })
              }
            >
              {chainBusy ? 'Running…' : 'Increase Time'}
            </button>
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <label className="block min-w-[210px] space-y-0.5">
              <div className="text-[10px] text-[color:var(--cs-muted)]">Set Next Block Timestamp (unix seconds)</div>
              <input
                className={inputClass}
                value={nextTimestamp}
                onChange={(e) => setNextTimestamp(e.target.value)}
                placeholder={`${Math.floor(Date.now() / 1000) + 600}`}
              />
            </label>
            <label className="inline-flex items-center gap-1.5 pb-1 text-[10px] text-[color:var(--cs-muted)]">
              <input
                type="checkbox"
                checked={mineAfterNextTimestamp}
                onChange={(e) => setMineAfterNextTimestamp(e.currentTarget.checked)}
                className="h-3.5 w-3.5 rounded border-[color:var(--cs-border)] accent-[color:var(--cs-accent)]"
              />
              Mine after set
            </label>
            <button
              type="button"
              className={btnClass}
              disabled={chainBusy}
              onClick={() =>
                void runChainAction(async () => {
                  const timestamp = parsePositiveSafeInt(nextTimestamp);
                  if (timestamp == null) throw new Error('Timestamp must be a positive integer.');
                  await callLocalRpc('evm_setNextBlockTimestamp', [timestamp]);
                  if (mineAfterNextTimestamp) await callLocalRpc('evm_mine');
                  return `Set next block timestamp to ${timestamp}${mineAfterNextTimestamp ? ' and mined 1 block' : ''}.`;
                })
              }
            >
              {chainBusy ? 'Running…' : 'Set Timestamp'}
            </button>
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <button
              type="button"
              className={btnClass}
              disabled={chainBusy}
              onClick={() =>
                void runChainAction(async () => {
                  await callLocalRpc('evm_setAutomine', [true]);
                  return 'Enabled automine.';
                })
              }
            >
              {chainBusy ? 'Running…' : 'Enable Automine'}
            </button>
            <button
              type="button"
              className={btnClass}
              disabled={chainBusy}
              onClick={() =>
                void runChainAction(async () => {
                  await callLocalRpc('evm_setAutomine', [false]);
                  return 'Disabled automine.';
                })
              }
            >
              {chainBusy ? 'Running…' : 'Disable Automine'}
            </button>
            <label className="block min-w-[170px] space-y-0.5">
              <div className="text-[10px] text-[color:var(--cs-muted)]">Interval Mining (ms)</div>
              <input
                className={inputClass}
                value={intervalMiningMs}
                onChange={(e) => setIntervalMiningMs(e.target.value)}
                placeholder="0"
              />
            </label>
            <button
              type="button"
              className={btnClass}
              disabled={chainBusy}
              onClick={() =>
                void runChainAction(async () => {
                  const intervalMs = parseNonNegativeSafeInt(intervalMiningMs);
                  if (intervalMs == null) throw new Error('Interval must be a non-negative integer.');
                  await callLocalRpc('evm_setIntervalMining', [intervalMs]);
                  return `Set interval mining to ${intervalMs}ms.`;
                })
              }
            >
              {chainBusy ? 'Running…' : 'Set Interval Mining'}
            </button>
          </div>

          {chainStatus ? <InlineMessage ok={chainStatus.ok} message={chainStatus.message} /> : null}
        </section>

        <section className="space-y-2 rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] p-2">
          <div className="text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">Account Impersonation</div>
          <div className="flex flex-wrap items-end gap-2">
            <label className="block min-w-[280px] flex-1 space-y-0.5">
              <div className="text-[10px] text-[color:var(--cs-muted)]">Address</div>
              <input
                className={inputClass}
                value={impersonationAddress}
                onChange={(e) => setImpersonationAddress(e.target.value)}
                placeholder="0x..."
              />
            </label>
            <button
              type="button"
              className={btnClass}
              disabled={impersonationBusy}
              onClick={() =>
                void runImpersonationAction(async () => {
                  const address = normalizeAddress(impersonationAddress);
                  if (!address) throw new Error('Provide a valid address to impersonate.');
                  await callLocalRpc('anvil_impersonateAccount', [address]);
                  setActiveImpersonations((prev) => uniqueAddresses([address, ...prev]));
                  return `Impersonating ${address}.`;
                })
              }
            >
              {impersonationBusy ? 'Running…' : 'Start Impersonation'}
            </button>
            <button
              type="button"
              className={btnClass}
              disabled={impersonationBusy}
              onClick={() =>
                void runImpersonationAction(async () => {
                  const address = normalizeAddress(impersonationAddress);
                  if (!address) throw new Error('Provide a valid address to stop impersonating.');
                  await callLocalRpc('anvil_stopImpersonatingAccount', [address]);
                  setActiveImpersonations((prev) => prev.filter((item) => item !== address));
                  return `Stopped impersonating ${address}.`;
                })
              }
            >
              {impersonationBusy ? 'Running…' : 'Stop Impersonation'}
            </button>
            <button
              type="button"
              className={btnClass}
              disabled={impersonationBusy || !activeImpersonations.length}
              onClick={() =>
                void runImpersonationAction(async () => {
                  for (const address of activeImpersonations) {
                    await callLocalRpc('anvil_stopImpersonatingAccount', [address]);
                  }
                  setActiveImpersonations([]);
                  return 'Stopped all tracked impersonations.';
                })
              }
            >
              {impersonationBusy ? 'Running…' : 'Stop All Tracked'}
            </button>
          </div>

          {activeImpersonations.length ? (
            <div className="flex flex-wrap gap-1.5">
              {activeImpersonations.map((address) => (
                <button
                  key={address}
                  type="button"
                  className="rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-1.5 py-1 font-mono text-[10px] hover:bg-[color:var(--cs-hover)]"
                  onClick={() => setImpersonationAddress(address)}
                >
                  {address}
                </button>
              ))}
            </div>
          ) : (
            <div className="text-[11px] text-[color:var(--cs-muted)]">No tracked impersonations yet.</div>
          )}

          {impersonationStatus ? <InlineMessage ok={impersonationStatus.ok} message={impersonationStatus.message} /> : null}
        </section>

        <section className="space-y-2 rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] p-2">
          <div className="text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">Pair Currency Provisioning (ERC20)</div>
          <p className="text-[10px] text-[color:var(--cs-muted)]">
            Sets pair token balances by writing ERC20 `balanceOf` mapping slots (base/quote token + slot index).
          </p>

          <div className="flex flex-wrap items-end gap-2">
            <label className="block min-w-[220px] space-y-0.5">
              <div className="text-[10px] text-[color:var(--cs-muted)]">Saved Pair Presets</div>
              <select
                className={inputClass}
                value={selectedPairPresetId}
                onChange={(e) => onLoadPairPreset(e.target.value)}
              >
                <option value="">Select preset…</option>
                {pairPresets.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.name} ({preset.baseSymbol}/{preset.quoteSymbol})
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className={btnClass} onClick={() => setPairForm(EMPTY_PAIR_FORM)}>
              New Preset Draft
            </button>
            <button
              type="button"
              className={btnClass}
              disabled={!selectedPairPresetId}
              onClick={() => onDeletePairPreset()}
            >
              Delete Selected Preset
            </button>
          </div>

          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            <label className="block space-y-0.5">
              <div className="text-[10px] text-[color:var(--cs-muted)]">Pair Name</div>
              <input
                className={inputClass}
                value={pairForm.name}
                onChange={(e) => setPairForm((prev) => ({ ...prev, name: e.target.value }))}
                placeholder="USDC / WETH"
              />
            </label>
            <div />

            <label className="block space-y-0.5">
              <div className="text-[10px] text-[color:var(--cs-muted)]">Base Symbol</div>
              <input
                className={inputClass}
                value={pairForm.baseSymbol}
                onChange={(e) => setPairForm((prev) => ({ ...prev, baseSymbol: e.target.value }))}
                placeholder="USDC"
              />
            </label>
            <label className="block space-y-0.5">
              <div className="text-[10px] text-[color:var(--cs-muted)]">Base Token Address</div>
              <input
                className={inputClass}
                value={pairForm.baseToken}
                onChange={(e) => setPairForm((prev) => ({ ...prev, baseToken: e.target.value }))}
                placeholder="0x..."
              />
            </label>
            <label className="block space-y-0.5">
              <div className="text-[10px] text-[color:var(--cs-muted)]">Base Decimals</div>
              <input
                className={inputClass}
                value={pairForm.baseDecimals}
                onChange={(e) => setPairForm((prev) => ({ ...prev, baseDecimals: e.target.value }))}
                placeholder="6"
              />
            </label>
            <label className="block space-y-0.5">
              <div className="text-[10px] text-[color:var(--cs-muted)]">Base balanceOf Slot</div>
              <input
                className={inputClass}
                value={pairForm.baseBalanceSlot}
                onChange={(e) => setPairForm((prev) => ({ ...prev, baseBalanceSlot: e.target.value }))}
                placeholder="9"
              />
            </label>

            <label className="block space-y-0.5">
              <div className="text-[10px] text-[color:var(--cs-muted)]">Quote Symbol</div>
              <input
                className={inputClass}
                value={pairForm.quoteSymbol}
                onChange={(e) => setPairForm((prev) => ({ ...prev, quoteSymbol: e.target.value }))}
                placeholder="WETH"
              />
            </label>
            <label className="block space-y-0.5">
              <div className="text-[10px] text-[color:var(--cs-muted)]">Quote Token Address</div>
              <input
                className={inputClass}
                value={pairForm.quoteToken}
                onChange={(e) => setPairForm((prev) => ({ ...prev, quoteToken: e.target.value }))}
                placeholder="0x..."
              />
            </label>
            <label className="block space-y-0.5">
              <div className="text-[10px] text-[color:var(--cs-muted)]">Quote Decimals</div>
              <input
                className={inputClass}
                value={pairForm.quoteDecimals}
                onChange={(e) => setPairForm((prev) => ({ ...prev, quoteDecimals: e.target.value }))}
                placeholder="18"
              />
            </label>
            <label className="block space-y-0.5">
              <div className="text-[10px] text-[color:var(--cs-muted)]">Quote balanceOf Slot</div>
              <input
                className={inputClass}
                value={pairForm.quoteBalanceSlot}
                onChange={(e) => setPairForm((prev) => ({ ...prev, quoteBalanceSlot: e.target.value }))}
                placeholder="3"
              />
            </label>
          </div>

          <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
            <label className="block space-y-0.5">
              <div className="text-[10px] text-[color:var(--cs-muted)]">Target Wallet</div>
              <input
                className={inputClass}
                value={pairTargetWallet}
                onChange={(e) => setPairTargetWallet(e.target.value)}
                placeholder="0x..."
              />
            </label>
            <label className="block space-y-0.5">
              <div className="text-[10px] text-[color:var(--cs-muted)]">Base Amount</div>
              <input
                className={inputClass}
                value={pairBaseAmount}
                onChange={(e) => setPairBaseAmount(e.target.value)}
                placeholder="100000"
              />
            </label>
            <label className="block space-y-0.5">
              <div className="text-[10px] text-[color:var(--cs-muted)]">Quote Amount</div>
              <input
                className={inputClass}
                value={pairQuoteAmount}
                onChange={(e) => setPairQuoteAmount(e.target.value)}
                placeholder="100"
              />
            </label>
          </div>

          <div className="flex flex-wrap gap-2">
            <button type="button" className={btnClass} onClick={() => onSavePairPreset()}>
              Save Pair Preset
            </button>
            <button type="button" className={btnClass} disabled={pairBusy} onClick={() => void onProvisionPair()}>
              {pairBusy ? 'Provisioning…' : 'Provision Pair Balances'}
            </button>
            <button
              type="button"
              className={btnClass}
              onClick={() => {
                if (!detectedWallets.length) return;
                setPairTargetWallet(detectedWallets[0]);
              }}
              disabled={!detectedWallets.length}
            >
              Use First Detected Wallet
            </button>
          </div>

          {pairStatus ? <InlineMessage ok={pairStatus.ok} message={pairStatus.message} /> : null}
        </section>

        <section className="space-y-2 rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] p-2">
          <div className="text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">Raw JSON-RPC Runner</div>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            <label className="block space-y-0.5">
              <div className="text-[10px] text-[color:var(--cs-muted)]">Method</div>
              <input
                className={inputClass}
                value={rawMethod}
                onChange={(e) => setRawMethod(e.target.value)}
                placeholder="eth_getBlockByNumber"
              />
            </label>
            <div />
          </div>
          <label className="block space-y-0.5">
            <div className="text-[10px] text-[color:var(--cs-muted)]">Params JSON (array preferred)</div>
            <textarea
              className={textareaClass}
              value={rawParams}
              onChange={(e) => setRawParams(e.target.value)}
              placeholder='["latest", false]'
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={btnClass} disabled={rawBusy} onClick={() => void onRunRawRpc()}>
              {rawBusy ? 'Executing…' : 'Execute RPC'}
            </button>
          </div>
          {rawStatus ? <InlineMessage ok={rawStatus.ok} message={rawStatus.message} /> : null}
          {rawResult ? (
            <pre className="max-h-60 overflow-auto rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] p-2 font-mono text-[10px] text-[color:var(--cs-fg)]">
              {rawResult}
            </pre>
          ) : null}
        </section>
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
