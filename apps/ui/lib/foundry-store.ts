'use client';

import { useCallback, useEffect, useState } from 'react';

export type FoundrySettings = {
  rpcUrl: string;
  chainId: number;
  chainName: string;
  blockExplorerUrl: string;
  currencySymbol: string;
  defaultGasLimit: string;
  defaultSimulateOnly: boolean;
  pollIntervalMs: number;
};

export type WalletAuthSession = {
  address: string | null;
  chainIdHex: string | null;
  connectedAt: string | null;
  authMessage: string | null;
  signature: string | null;
  authenticatedAt: string | null;
};

export type SandboxTransactionStatus = 'pending' | 'success' | 'reverted' | 'error';

export type SandboxTransaction = {
  hash: string;
  from: string;
  to: string;
  chainId: number;
  valueWei: string;
  data: string;
  createdAt: string;
  updatedAt: string;
  status: SandboxTransactionStatus;
  receipt: unknown | null;
  error: string | null;
};

export type RpcInteractionSource = 'wallet' | 'foundry';
export type RpcInteractionStatus = 'success' | 'error';

export type RpcInteractionTx = {
  from: string | null;
  to: string | null;
  value: string | null;
  data: string | null;
  gas: string | null;
};

export type RpcInteraction = {
  id: string;
  createdAt: string;
  source: RpcInteractionSource;
  rpcUrl: string | null;
  chainId: number | null;
  method: string;
  params: unknown[];
  status: RpcInteractionStatus;
  error: string | null;
  durationMs: number | null;
  tx: RpcInteractionTx | null;
  txHash: string | null;
};

export type RpcInteractionRecordInput = {
  source: RpcInteractionSource;
  rpcUrl?: string | null;
  chainId?: number | null;
  method: string;
  params?: unknown[] | Record<string, unknown> | null;
  status: RpcInteractionStatus;
  error?: string | null;
  durationMs?: number | null;
  result?: unknown;
  txHash?: string | null;
};

export type ContractSandboxPrefill = {
  sourceInteractionId: string;
  method: string;
  from: string | null;
  to: string;
  data: string;
  value: string | null;
  gas: string | null;
  simulateOnly: boolean;
  abiJson: string | null;
  label: string | null;
  createdAt: string;
};

export type EthereumProvider = {
  request: (args: { method: string; params?: unknown[] | Record<string, unknown> }) => Promise<unknown>;
  on?: (eventName: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (eventName: string, listener: (...args: unknown[]) => void) => void;
};

const SETTINGS_STORAGE_KEY = 'cipherscope.foundry.settings.v1';
const WALLET_STORAGE_KEY = 'cipherscope.foundry.wallet.v1';
const TX_STORAGE_KEY = 'cipherscope.foundry.transactions.v1';
const RPC_HISTORY_STORAGE_KEY = 'cipherscope.foundry.rpc-history.v1';
const SANDBOX_PREFILL_STORAGE_KEY = 'cipherscope.foundry.sandbox-prefill.v1';

const SETTINGS_EVENT = 'cipherscope:foundry-settings:changed';
const WALLET_EVENT = 'cipherscope:foundry-wallet:changed';
const TX_EVENT = 'cipherscope:foundry-transactions:changed';
const RPC_HISTORY_EVENT = 'cipherscope:foundry-rpc-history:changed';

export const DEFAULT_FOUNDRY_SETTINGS: FoundrySettings = {
  rpcUrl: 'http://127.0.0.1:8545',
  chainId: 1,
  chainName: 'Ethereum Mainnet',
  blockExplorerUrl: 'https://etherscan.io',
  currencySymbol: 'ETH',
  defaultGasLimit: '210000',
  defaultSimulateOnly: true,
  pollIntervalMs: 2500,
};

const EMPTY_WALLET_SESSION: WalletAuthSession = {
  address: null,
  chainIdHex: null,
  connectedAt: null,
  authMessage: null,
  signature: null,
  authenticatedAt: null,
};

function hasWindow(): boolean {
  return typeof window !== 'undefined';
}

function dispatch(eventName: string): void {
  if (!hasWindow()) return;
  window.dispatchEvent(new Event(eventName));
}

function readJson<T>(key: string): T | null {
  if (!hasWindow()) return null;
  const raw = window.localStorage.getItem(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  if (!hasWindow()) return;
  window.localStorage.setItem(key, JSON.stringify(value));
}

function asString(v: unknown, fallback: string): string {
  if (typeof v !== 'string') return fallback;
  return v;
}

function asTrimmedString(v: unknown, fallback: string): string {
  if (typeof v !== 'string') return fallback;
  const out = v.trim();
  return out ? out : fallback;
}

function asBool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function asInt(v: unknown, fallback: number): number {
  if (typeof v !== 'number') return fallback;
  if (!Number.isInteger(v) || v <= 0) return fallback;
  return v;
}

function normalizeAddress(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) return null;
  return trimmed;
}

function normalizeHexChainId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^0x[0-9a-fA-F]+$/.test(trimmed)) return null;
  return trimmed.toLowerCase();
}

function normalizeDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return value.trim() ? value : null;
}

function normalizeRpcUrl(value: string): string {
  const trimmed = value.trim();
  return trimmed.replace(/\/+$/, '');
}

function parseSettings(raw: unknown): FoundrySettings {
  if (!raw || typeof raw !== 'object') return DEFAULT_FOUNDRY_SETTINGS;
  const obj = raw as Record<string, unknown>;
  return {
    rpcUrl: normalizeRpcUrl(asTrimmedString(obj.rpcUrl, DEFAULT_FOUNDRY_SETTINGS.rpcUrl)),
    chainId: asInt(obj.chainId, DEFAULT_FOUNDRY_SETTINGS.chainId),
    chainName: asTrimmedString(obj.chainName, DEFAULT_FOUNDRY_SETTINGS.chainName),
    blockExplorerUrl: asTrimmedString(obj.blockExplorerUrl, ''),
    currencySymbol: asTrimmedString(obj.currencySymbol, DEFAULT_FOUNDRY_SETTINGS.currencySymbol),
    defaultGasLimit: asTrimmedString(obj.defaultGasLimit, DEFAULT_FOUNDRY_SETTINGS.defaultGasLimit),
    defaultSimulateOnly: asBool(
      obj.defaultSimulateOnly,
      DEFAULT_FOUNDRY_SETTINGS.defaultSimulateOnly,
    ),
    pollIntervalMs: asInt(obj.pollIntervalMs, DEFAULT_FOUNDRY_SETTINGS.pollIntervalMs),
  };
}

function parseWalletSession(raw: unknown): WalletAuthSession {
  if (!raw || typeof raw !== 'object') return EMPTY_WALLET_SESSION;
  const obj = raw as Record<string, unknown>;
  return {
    address: normalizeAddress(obj.address),
    chainIdHex: normalizeHexChainId(obj.chainIdHex),
    connectedAt: normalizeDate(obj.connectedAt),
    authMessage: typeof obj.authMessage === 'string' ? obj.authMessage : null,
    signature: typeof obj.signature === 'string' ? obj.signature : null,
    authenticatedAt: normalizeDate(obj.authenticatedAt),
  };
}

function parseTransaction(raw: unknown): SandboxTransaction | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.hash !== 'string' || !obj.hash.trim()) return null;
  if (typeof obj.from !== 'string' || !obj.from.trim()) return null;
  if (typeof obj.to !== 'string' || !obj.to.trim()) return null;
  if (typeof obj.valueWei !== 'string') return null;
  if (typeof obj.data !== 'string') return null;
  if (typeof obj.createdAt !== 'string') return null;
  if (typeof obj.updatedAt !== 'string') return null;
  if (
    obj.status !== 'pending' &&
    obj.status !== 'success' &&
    obj.status !== 'reverted' &&
    obj.status !== 'error'
  ) {
    return null;
  }
  if (typeof obj.chainId !== 'number' || !Number.isInteger(obj.chainId) || obj.chainId <= 0) {
    return null;
  }
  return {
    hash: obj.hash,
    from: obj.from,
    to: obj.to,
    chainId: obj.chainId,
    valueWei: obj.valueWei,
    data: obj.data,
    createdAt: obj.createdAt,
    updatedAt: obj.updatedAt,
    status: obj.status,
    receipt: obj.receipt ?? null,
    error: typeof obj.error === 'string' ? obj.error : null,
  };
}

function parseTransactions(raw: unknown): SandboxTransaction[] {
  if (!Array.isArray(raw)) return [];
  const parsed = raw.map(parseTransaction).filter((item): item is SandboxTransaction => item !== null);
  return parsed.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function asNullableString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function parseRpcInteractionTx(raw: unknown): RpcInteractionTx | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const tx: RpcInteractionTx = {
    from: asNullableString(obj.from),
    to: asNullableString(obj.to),
    value: asNullableString(obj.value),
    data: asNullableString(obj.data),
    gas: asNullableString(obj.gas),
  };
  if (!tx.from && !tx.to && !tx.value && !tx.data && !tx.gas) return null;
  return tx;
}

function parseTxHash(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return /^0x[0-9a-fA-F]{64}$/.test(trimmed) ? trimmed : null;
}

function parseRpcInteraction(raw: unknown): RpcInteraction | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.id !== 'string' || !obj.id.trim()) return null;
  if (typeof obj.createdAt !== 'string' || !obj.createdAt.trim()) return null;
  if (obj.source !== 'wallet' && obj.source !== 'foundry') return null;
  if (typeof obj.method !== 'string' || !obj.method.trim()) return null;
  if (obj.status !== 'success' && obj.status !== 'error') return null;

  const paramsRaw = obj.params;
  const params =
    Array.isArray(paramsRaw) ? paramsRaw
    : paramsRaw == null ? []
    : [paramsRaw];

  const durationMsRaw = obj.durationMs;
  const durationMs =
    typeof durationMsRaw === 'number' && Number.isFinite(durationMsRaw) && durationMsRaw >= 0
      ? durationMsRaw
      : null;

  const chainIdRaw = obj.chainId;
  const chainId =
    typeof chainIdRaw === 'number' && Number.isInteger(chainIdRaw) && chainIdRaw > 0
      ? chainIdRaw
      : null;

  return {
    id: obj.id,
    createdAt: obj.createdAt,
    source: obj.source,
    rpcUrl: asNullableString(obj.rpcUrl),
    chainId,
    method: obj.method.trim(),
    params,
    status: obj.status,
    error: asNullableString(obj.error),
    durationMs,
    tx: parseRpcInteractionTx(obj.tx),
    txHash: parseTxHash(obj.txHash),
  };
}

function parseRpcInteractions(raw: unknown): RpcInteraction[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(parseRpcInteraction)
    .filter((item): item is RpcInteraction => item !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function parseContractSandboxPrefill(raw: unknown): ContractSandboxPrefill | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const sourceInteractionId = asNullableString(obj.sourceInteractionId);
  const method = asNullableString(obj.method);
  const to = asNullableString(obj.to);
  const data = asNullableString(obj.data) ?? '0x';
  const createdAt = asNullableString(obj.createdAt);
  if (!sourceInteractionId || !method || !to || !createdAt) return null;
  return {
    sourceInteractionId,
    method,
    from: asNullableString(obj.from),
    to,
    data,
    value: asNullableString(obj.value),
    gas: asNullableString(obj.gas),
    simulateOnly: obj.simulateOnly === true,
    abiJson: asNullableString(obj.abiJson),
    label: asNullableString(obj.label),
    createdAt,
  };
}

function makeId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function methodExpectsTx(method: string): boolean {
  const normalized = method.toLowerCase();
  return (
    normalized === 'eth_sendtransaction' ||
    normalized === 'eth_call' ||
    normalized === 'eth_estimategas'
  );
}

function extractTxForMethod(method: string, params: unknown[]): RpcInteractionTx | null {
  if (!methodExpectsTx(method)) return null;
  if (!Array.isArray(params) || params.length === 0) return null;
  return parseRpcInteractionTx(params[0]);
}

export function loadFoundrySettings(): FoundrySettings {
  return parseSettings(readJson<unknown>(SETTINGS_STORAGE_KEY));
}

export function saveFoundrySettings(settings: FoundrySettings): FoundrySettings {
  const normalized = parseSettings(settings);
  writeJson(SETTINGS_STORAGE_KEY, normalized);
  dispatch(SETTINGS_EVENT);
  return normalized;
}

export function loadWalletAuthSession(): WalletAuthSession {
  return parseWalletSession(readJson<unknown>(WALLET_STORAGE_KEY));
}

export function saveWalletAuthSession(session: WalletAuthSession): WalletAuthSession {
  const normalized = parseWalletSession(session);
  writeJson(WALLET_STORAGE_KEY, normalized);
  dispatch(WALLET_EVENT);
  return normalized;
}

export function clearWalletAuthSession(): void {
  if (!hasWindow()) return;
  window.localStorage.removeItem(WALLET_STORAGE_KEY);
  dispatch(WALLET_EVENT);
}

export function loadSandboxTransactions(): SandboxTransaction[] {
  return parseTransactions(readJson<unknown>(TX_STORAGE_KEY));
}

export function saveSandboxTransactions(items: SandboxTransaction[]): SandboxTransaction[] {
  const parsed = parseTransactions(items).slice(0, 300);
  writeJson(TX_STORAGE_KEY, parsed);
  dispatch(TX_EVENT);
  return parsed;
}

export function upsertSandboxTransaction(item: SandboxTransaction): SandboxTransaction[] {
  const current = loadSandboxTransactions();
  const index = current.findIndex((entry) => entry.hash.toLowerCase() === item.hash.toLowerCase());
  const next = [...current];
  if (index >= 0) next[index] = item;
  else next.unshift(item);
  return saveSandboxTransactions(next);
}

export function patchSandboxTransaction(
  hash: string,
  patch: Partial<Omit<SandboxTransaction, 'hash' | 'createdAt'>>,
): SandboxTransaction[] {
  const current = loadSandboxTransactions();
  const next = current.map((item) => {
    if (item.hash.toLowerCase() !== hash.toLowerCase()) return item;
    return { ...item, ...patch, updatedAt: new Date().toISOString() };
  });
  return saveSandboxTransactions(next);
}

export function loadRpcInteractions(): RpcInteraction[] {
  return parseRpcInteractions(readJson<unknown>(RPC_HISTORY_STORAGE_KEY));
}

export function saveRpcInteractions(items: RpcInteraction[]): RpcInteraction[] {
  const parsed = parseRpcInteractions(items).slice(0, 400);
  writeJson(RPC_HISTORY_STORAGE_KEY, parsed);
  dispatch(RPC_HISTORY_EVENT);
  return parsed;
}

export function clearRpcInteractions(): void {
  if (!hasWindow()) return;
  window.localStorage.removeItem(RPC_HISTORY_STORAGE_KEY);
  dispatch(RPC_HISTORY_EVENT);
}

export function recordRpcInteraction(input: RpcInteractionRecordInput): RpcInteraction[] {
  const method = input.method.trim();
  if (!method) return loadRpcInteractions();
  const paramsRaw = input.params;
  const params =
    Array.isArray(paramsRaw) ? paramsRaw
    : paramsRaw == null ? []
    : [paramsRaw];

  const tx = extractTxForMethod(method, params);
  const txHash = parseTxHash(input.txHash) ?? parseTxHash(input.result);
  const durationMs =
    typeof input.durationMs === 'number' && Number.isFinite(input.durationMs) && input.durationMs >= 0
      ? input.durationMs
      : null;

  const item: RpcInteraction = {
    id: makeId('rpc'),
    createdAt: new Date().toISOString(),
    source: input.source,
    rpcUrl: asNullableString(input.rpcUrl),
    chainId:
      typeof input.chainId === 'number' && Number.isInteger(input.chainId) && input.chainId > 0
        ? input.chainId
        : null,
    method,
    params,
    status: input.status,
    error: asNullableString(input.error),
    durationMs,
    tx,
    txHash,
  };

  const current = loadRpcInteractions();
  return saveRpcInteractions([item, ...current]);
}

export function saveContractSandboxPrefill(prefill: ContractSandboxPrefill): ContractSandboxPrefill {
  const parsed = parseContractSandboxPrefill(prefill);
  if (!parsed) {
    throw new Error('Invalid contract sandbox prefill payload.');
  }
  writeJson(SANDBOX_PREFILL_STORAGE_KEY, parsed);
  return parsed;
}

export function consumeContractSandboxPrefill(): ContractSandboxPrefill | null {
  if (!hasWindow()) return null;
  const parsed = parseContractSandboxPrefill(readJson<unknown>(SANDBOX_PREFILL_STORAGE_KEY));
  window.localStorage.removeItem(SANDBOX_PREFILL_STORAGE_KEY);
  return parsed;
}

export function toChainIdHex(chainId: number): string {
  return `0x${chainId.toString(16)}`;
}

export function fromChainIdHex(chainIdHex: string): number | null {
  if (!/^0x[0-9a-fA-F]+$/.test(chainIdHex)) return null;
  try {
    const value = Number.parseInt(chainIdHex, 16);
    if (!Number.isInteger(value) || value <= 0) return null;
    return value;
  } catch {
    return null;
  }
}

export function getEthereumProvider(): EthereumProvider | null {
  if (!hasWindow()) return null;
  const candidate = (window as Window & { ethereum?: unknown }).ethereum;
  if (!candidate || typeof candidate !== 'object') return null;
  const provider = candidate as Partial<EthereumProvider>;
  if (typeof provider.request !== 'function') return null;
  return provider as EthereumProvider;
}

export function useFoundrySettings(): {
  settings: FoundrySettings;
  setSettings: (next: FoundrySettings) => FoundrySettings;
  reload: () => void;
} {
  const [settings, setSettingsState] = useState<FoundrySettings>(DEFAULT_FOUNDRY_SETTINGS);

  const reload = useCallback(() => {
    setSettingsState(loadFoundrySettings());
  }, []);

  useEffect(() => {
    reload();
    const onLocal = () => reload();
    const onStorage = (event: StorageEvent) => {
      if (!event.key || event.key === SETTINGS_STORAGE_KEY) reload();
    };
    window.addEventListener(SETTINGS_EVENT, onLocal);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(SETTINGS_EVENT, onLocal);
      window.removeEventListener('storage', onStorage);
    };
  }, [reload]);

  const setSettings = useCallback((next: FoundrySettings) => {
    const normalized = saveFoundrySettings(next);
    setSettingsState(normalized);
    return normalized;
  }, []);

  return { settings, setSettings, reload };
}

export function useWalletAuthSession(): {
  wallet: WalletAuthSession;
  setWallet: (next: WalletAuthSession) => WalletAuthSession;
  clearWallet: () => void;
  reload: () => void;
} {
  const [wallet, setWalletState] = useState<WalletAuthSession>(EMPTY_WALLET_SESSION);

  const reload = useCallback(() => {
    setWalletState(loadWalletAuthSession());
  }, []);

  useEffect(() => {
    reload();
    const onLocal = () => reload();
    const onStorage = (event: StorageEvent) => {
      if (!event.key || event.key === WALLET_STORAGE_KEY) reload();
    };
    window.addEventListener(WALLET_EVENT, onLocal);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(WALLET_EVENT, onLocal);
      window.removeEventListener('storage', onStorage);
    };
  }, [reload]);

  const setWallet = useCallback((next: WalletAuthSession) => {
    const normalized = saveWalletAuthSession(next);
    setWalletState(normalized);
    return normalized;
  }, []);

  const clearWallet = useCallback(() => {
    clearWalletAuthSession();
    setWalletState(EMPTY_WALLET_SESSION);
  }, []);

  return { wallet, setWallet, clearWallet, reload };
}

export function useSandboxTransactions(): {
  transactions: SandboxTransaction[];
  reload: () => void;
} {
  const [transactions, setTransactions] = useState<SandboxTransaction[]>([]);

  const reload = useCallback(() => {
    setTransactions(loadSandboxTransactions());
  }, []);

  useEffect(() => {
    reload();
    const onLocal = () => reload();
    const onStorage = (event: StorageEvent) => {
      if (!event.key || event.key === TX_STORAGE_KEY) reload();
    };
    window.addEventListener(TX_EVENT, onLocal);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(TX_EVENT, onLocal);
      window.removeEventListener('storage', onStorage);
    };
  }, [reload]);

  return { transactions, reload };
}

export function useRpcInteractions(): {
  interactions: RpcInteraction[];
  reload: () => void;
  clear: () => void;
} {
  const [interactions, setInteractions] = useState<RpcInteraction[]>([]);

  const reload = useCallback(() => {
    setInteractions(loadRpcInteractions());
  }, []);

  const clear = useCallback(() => {
    clearRpcInteractions();
    setInteractions([]);
  }, []);

  useEffect(() => {
    reload();
    const onLocal = () => reload();
    const onStorage = (event: StorageEvent) => {
      if (!event.key || event.key === RPC_HISTORY_STORAGE_KEY) reload();
    };
    window.addEventListener(RPC_HISTORY_EVENT, onLocal);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(RPC_HISTORY_EVENT, onLocal);
      window.removeEventListener('storage', onStorage);
    };
  }, [reload]);

  return { interactions, reload, clear };
}

export function asNonEmptyString(value: unknown, fallback: string): string {
  return asTrimmedString(value, fallback);
}

export function asOptionalString(value: unknown): string {
  return asString(value, '').trim();
}
