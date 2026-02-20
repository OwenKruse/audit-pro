'use client';

import Link from 'next/link';
import {
  Activity,
  Check,
  Code2,
  Copy,
  Database,
  SendHorizontal,
  Settings,
  ShieldCheck,
  Terminal,
  Wallet,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { callFoundryRpc, callWalletRpc } from '@/lib/foundry-rpc';
import {
  consumeContractSandboxPrefill,
  getEthereumProvider,
  patchSandboxTransaction,
  toChainIdHex,
  upsertSandboxTransaction,
  useFoundrySettings,
  useSandboxTransactions,
  useWalletAuthSession,
  type FoundrySettings,
  type SandboxTransaction,
  type SandboxTransactionStatus,
} from '@/lib/foundry-store';
import {
  decodeCalldata,
  decodeCallResult,
  formatWeiToEth,
  formatWeiHexToEth,
  formatHexQuantity,
  translateReceiptLogs,
} from '@/lib/rpc-translate';
import { VerticalResizable } from './_components/VerticalResizable';

const INPUT_TABS = ['Parameters', 'Value', 'Gas Limit', 'Hex Data', 'ABI'];
const OUTPUT_TABS = ['Result', 'Trace', 'Events', 'State Change', 'Raw'];
const DEFAULT_TRANSFER_ABI = `[
  {
    "inputs": [{"name": "to", "type": "address"}, {"name": "amount", "type": "uint256"}],
    "name": "transfer",
    "outputs": [{"name": "success", "type": "bool"}],
    "stateMutability": "nonpayable",
    "type": "function"
  }
]`;

type EvmConfigResponse =
  | {
      ok: true;
      foundry?: {
        rpcUrl?: unknown;
      };
    }
  | {
      ok: false;
      error?: {
        message?: unknown;
      };
    };

type AutoRpcPreset = {
  chainId: number;
  chainName: string;
  rpcUrl: string;
  blockExplorerUrl: string;
  currencySymbol: string;
};

const AUTO_RPC_PRESETS: Record<number, AutoRpcPreset> = {
  1: {
    chainId: 1,
    chainName: 'Ethereum Mainnet',
    rpcUrl: 'https://ethereum-rpc.publicnode.com',
    blockExplorerUrl: 'https://etherscan.io',
    currencySymbol: 'ETH',
  },
  10: {
    chainId: 10,
    chainName: 'Optimism',
    rpcUrl: 'https://mainnet.optimism.io',
    blockExplorerUrl: 'https://optimistic.etherscan.io',
    currencySymbol: 'ETH',
  },
  56: {
    chainId: 56,
    chainName: 'BNB Smart Chain',
    rpcUrl: 'https://bsc-dataseed.binance.org',
    blockExplorerUrl: 'https://bscscan.com',
    currencySymbol: 'BNB',
  },
  137: {
    chainId: 137,
    chainName: 'Polygon PoS',
    rpcUrl: 'https://polygon-rpc.com',
    blockExplorerUrl: 'https://polygonscan.com',
    currencySymbol: 'MATIC',
  },
  8453: {
    chainId: 8453,
    chainName: 'Base',
    rpcUrl: 'https://mainnet.base.org',
    blockExplorerUrl: 'https://basescan.org',
    currencySymbol: 'ETH',
  },
  42161: {
    chainId: 42161,
    chainName: 'Arbitrum One',
    rpcUrl: 'https://arb1.arbitrum.io/rpc',
    blockExplorerUrl: 'https://arbiscan.io',
    currencySymbol: 'ETH',
  },
  43114: {
    chainId: 43114,
    chainName: 'Avalanche C-Chain',
    rpcUrl: 'https://api.avax.network/ext/bc/C/rpc',
    blockExplorerUrl: 'https://snowtrace.io',
    currencySymbol: 'AVAX',
  },
};

type ExecutionResult = {
  kind: 'simulate' | 'transaction' | 'error';
  summary: string;
  payload: unknown;
  gasEstimateHex: string | null;
  txHash: string | null;
  receipt: unknown | null;
  startedAt: string;
  finishedAt: string;
};

type EthereumTxParams = {
  from?: string;
  to: string;
  value?: string;
  data?: string;
  gas?: string;
};

type SignerSource = 'wallet' | 'dev';

type DevSigner = {
  address: string;
  balanceEth: string | null;
};

type SignerOption = {
  address: string;
  source: SignerSource;
  label: string;
};

function isAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

function isHexData(value: string): boolean {
  return /^0x([0-9a-fA-F]{2})*$/.test(value);
}

function toRpcHex(value: bigint): string {
  return `0x${value.toString(16)}`;
}

function parsePositiveIntToHex(value: string): string | null {
  const raw = value.trim();
  if (!raw) return null;
  if (!/^\d+$/.test(raw)) return null;
  const num = BigInt(raw);
  if (num <= BigInt(0)) return null;
  return toRpcHex(num);
}

function parseEthToWei(value: string): bigint | null {
  const raw = value.trim();
  if (!raw) return BigInt(0);
  const match = raw.match(/^(\d+)(?:\.(\d{0,18}))?$/);
  if (!match) return null;
  const whole = BigInt(match[1]);
  const fractionRaw = match[2] ?? '';
  const fractionPadded = `${fractionRaw}${'0'.repeat(18 - fractionRaw.length)}`;
  const fraction = fractionPadded ? BigInt(fractionPadded) : BigInt(0);
  return whole * BigInt(10) ** BigInt(18) + fraction;
}

function parseRpcQuantityToWei(value: string | null): bigint | null {
  if (!value) return BigInt(0);
  const raw = value.trim();
  if (!raw) return BigInt(0);
  try {
    if (/^0x[0-9a-fA-F]+$/.test(raw)) return BigInt(raw);
    if (/^\d+$/.test(raw)) return BigInt(raw);
    return null;
  } catch {
    return null;
  }
}

function shortHex(value: string | null | undefined, max = 16): string {
  if (!value) return '-';
  if (value.length <= max) return value;
  return `${value.slice(0, max - 6)}…${value.slice(-4)}`;
}

function toPrettyJson(value: unknown): string {
  try {
    return JSON.stringify(
      value,
      (_, v) => (typeof v === 'bigint' ? v.toString() : v),
      2,
    );
  } catch {
    return String(value);
  }
}

function statusLabel(status: SandboxTransactionStatus): string {
  if (status === 'pending') return 'Pending';
  if (status === 'success') return 'Success';
  if (status === 'reverted') return 'Reverted';
  return 'Error';
}

function statusClass(status: SandboxTransactionStatus): string {
  if (status === 'success') return 'text-emerald-600';
  if (status === 'reverted') return 'text-rose-600';
  if (status === 'error') return 'text-rose-600';
  return 'text-amber-600';
}

function parseReceiptStatus(receipt: unknown): SandboxTransactionStatus {
  if (!receipt || typeof receipt !== 'object') return 'pending';
  const status = (receipt as { status?: unknown }).status;
  if (status === '0x1' || status === 1 || status === '1') return 'success';
  if (status === '0x0' || status === 0 || status === '0') return 'reverted';
  return 'pending';
}

function isEmptyBytecode(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '0x' || normalized === '0x0' || normalized === '';
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

function errorMessage(value: unknown, fallback: string): string {
  if (!value || typeof value !== 'object') return fallback;
  const message = (value as { message?: unknown }).message;
  return typeof message === 'string' && message.trim() ? message : fallback;
}


async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export default function Home() {
  const { settings, setSettings } = useFoundrySettings();
  const { wallet } = useWalletAuthSession();
  const { transactions } = useSandboxTransactions();

  const [activeInputTab, setActiveInputTab] = useState('Parameters');
  const [activeOutputTab, setActiveOutputTab] = useState('Result');

  const [contractAddress, setContractAddress] = useState(
    '0xdAC17F958D2ee523a2206206994597C13D831ec7',
  );
  const [hexData, setHexData] = useState(
    '0xa9059cbb00000000000000000000000071c7656ec7ab88b098defb751b7401b5f6d8976f0000000000000000000000000000000000000000000000000de0b6b3a7640000',
  );
  const [abiJson, setAbiJson] = useState(DEFAULT_TRANSFER_ABI);
  const [valueEth, setValueEth] = useState('0');
  const [gasLimit, setGasLimit] = useState(settings.defaultGasLimit);
  const [simulateOnly, setSimulateOnly] = useState(settings.defaultSimulateOnly);

  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<ExecutionResult | null>(null);
  const [selectedTxHash, setSelectedTxHash] = useState<string | null>(null);
  const [devSigners, setDevSigners] = useState<DevSigner[]>([]);
  const [devSignersLoading, setDevSignersLoading] = useState(false);
  const [selectedSigner, setSelectedSigner] = useState<string>('');
  // For eth_call you can safely simulate with any "from" address (no signature needed).
  // Keep it separate from the signer dropdown so captured calls can be replayed as-is.
  const [simulateFromOverride, setSimulateFromOverride] = useState<string>('');

  const pollRunId = useRef(0);

  useEffect(() => {
    setGasLimit(settings.defaultGasLimit);
    setSimulateOnly(settings.defaultSimulateOnly);
  }, [settings.defaultGasLimit, settings.defaultSimulateOnly]);

  useEffect(() => {
    const prefill = consumeContractSandboxPrefill();
    if (!prefill) return;

    setContractAddress(prefill.to);
    setHexData(prefill.data || '0x');
    setSimulateOnly(prefill.simulateOnly);
    if (prefill.abiJson) {
      setAbiJson(prefill.abiJson);
    }
    setActiveInputTab('Parameters');
    setError(null);

    const valueWei = parseRpcQuantityToWei(prefill.value);
    if (valueWei != null) {
      setValueEth(formatWeiToEth(valueWei));
    }

    if (prefill.gas) {
      const gasRaw = prefill.gas.trim();
      if (/^\d+$/.test(gasRaw)) {
        setGasLimit(gasRaw);
      } else if (/^0x[0-9a-fA-F]+$/.test(gasRaw)) {
        try {
          setGasLimit(BigInt(gasRaw).toString());
        } catch {
          setGasLimit(settings.defaultGasLimit);
        }
      }
    }

    if (prefill.from) {
      setSelectedSigner(prefill.from);
      setSimulateFromOverride(prefill.from);
    }

    setStatus(`Loaded ${prefill.label ?? prefill.method} into Contract Sandbox.`);
  }, [settings.defaultGasLimit]);

  const loadDevSigners = useCallback(async () => {
    setDevSignersLoading(true);
    try {
      const addresses = await callFoundryRpc<unknown>({
        rpcUrl: settings.rpcUrl,
        method: 'eth_accounts',
        chainId: settings.chainId,
      });

      if (!Array.isArray(addresses)) {
        setDevSigners([]);
        return;
      }

      const normalized = addresses.filter(
        (item): item is string => typeof item === 'string' && isAddress(item),
      );
      const withBalances = await Promise.all(
        normalized.map(async (address) => {
          try {
            const balanceHex = await callFoundryRpc<string>({
              rpcUrl: settings.rpcUrl,
              method: 'eth_getBalance',
              params: [address, 'latest'],
              chainId: settings.chainId,
            });
            return { address, balanceEth: formatWeiHexToEth(balanceHex) };
          } catch {
            return { address, balanceEth: null };
          }
        }),
      );

      setDevSigners(withBalances);
    } catch {
      setDevSigners([]);
    } finally {
      setDevSignersLoading(false);
    }
  }, [settings.chainId, settings.rpcUrl]);

  useEffect(() => {
    void loadDevSigners();
  }, [loadDevSigners]);

  useEffect(() => {
    if (!selectedTxHash && transactions.length > 0) {
      setSelectedTxHash(transactions[0].hash);
    }
  }, [selectedTxHash, transactions]);

  const signerOptions = useMemo<SignerOption[]>(() => {
    const out: SignerOption[] = [];
    if (wallet.address) {
      out.push({
        address: wallet.address,
        source: 'wallet',
        label: `${shortHex(wallet.address, 18)} (Connected wallet)`,
      });
    }
    for (const dev of devSigners) {
      if (wallet.address && dev.address.toLowerCase() === wallet.address.toLowerCase()) continue;
      const balancePart = dev.balanceEth ? `, ${dev.balanceEth} ${settings.currencySymbol}` : '';
      out.push({
        address: dev.address,
        source: 'dev',
        label: `${shortHex(dev.address, 18)} (Anvil prefunded${balancePart})`,
      });
    }
    return out;
  }, [devSigners, settings.currencySymbol, wallet.address]);

  useEffect(() => {
    if (signerOptions.length === 0) {
      setSelectedSigner('');
      return;
    }
    setSelectedSigner((prev) => {
      if (
        prev &&
        signerOptions.some((option) => option.address.toLowerCase() === prev.toLowerCase())
      ) {
        return prev;
      }
      return signerOptions[0].address;
    });
  }, [signerOptions]);

  const selectedSignerOption = useMemo(
    () =>
      signerOptions.find(
        (option) => option.address.toLowerCase() === selectedSigner.toLowerCase(),
      ) ?? null,
    [selectedSigner, signerOptions],
  );

  const selectedTx = useMemo(
    () => transactions.find((tx) => tx.hash === selectedTxHash) ?? null,
    [transactions, selectedTxHash],
  );

  const outputReceipt = useMemo(() => {
    if (lastResult?.receipt) return lastResult.receipt;
    return selectedTx?.receipt ?? null;
  }, [lastResult, selectedTx]);

  const outputLogs = useMemo(() => {
    if (!outputReceipt || typeof outputReceipt !== 'object')
      return [] as Array<Record<string, unknown>>;
    const logs = (outputReceipt as { logs?: unknown }).logs;
    if (!Array.isArray(logs)) return [];
    return logs.filter(
      (entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object',
    );
  }, [outputReceipt]);

  const parsedAbi = useMemo(() => {
    try {
      const parsed = JSON.parse(abiJson) as unknown;
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }, [abiJson]);

  const decodedCallResult = useMemo(() => {
    if (lastResult?.kind !== 'simulate') return null;
    const payload = lastResult.payload;
    if (typeof payload !== 'string' || !payload.startsWith('0x')) return null;
    if (!parsedAbi || payload === '0x') return null;
    const calldataDecoded = decodeCalldata(hexData, parsedAbi);
    if (!calldataDecoded) return null;
    const decoded = decodeCallResult(payload, parsedAbi, calldataDecoded.functionName);
    return decoded !== null ? { functionName: calldataDecoded.functionName, decoded } : null;
  }, [lastResult?.kind, lastResult?.payload, hexData, parsedAbi]);

  async function fetchReceipt(
    rpcUrl: string,
    txHash: string,
    settingsValue: FoundrySettings,
  ): Promise<unknown | null> {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const receipt = await callFoundryRpc<unknown>({
        rpcUrl,
        method: 'eth_getTransactionReceipt',
        params: [txHash],
        chainId: settingsValue.chainId,
      });
      if (receipt) return receipt;
      await wait(Math.max(250, settingsValue.pollIntervalMs));
    }
    return null;
  }

  async function tryAutoResolveMissingBytecode(
    targetAddress: string,
    baseSettings: FoundrySettings,
    forSimulationOnly: boolean,
  ): Promise<{ settings: FoundrySettings; strategy: 'fork' | 'rpc' } | null> {
    const preset = AUTO_RPC_PRESETS[baseSettings.chainId];
    if (!preset) return null;
    const onLocalRpc = isLocalRpcUrl(baseSettings.rpcUrl);
    if (!onLocalRpc) return null;

    try {
      setStatus(
        `No bytecode at ${shortHex(targetAddress, 18)} on local RPC. Attempting automatic Anvil fork recovery...`,
      );
      const res = await fetch('/api/evm/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chainId: preset.chainId,
          forkUrl: preset.rpcUrl,
          forkBlockNumber: null,
        }),
      });
      const json = (await res.json().catch(() => null)) as EvmConfigResponse | null;
      if (res.ok && json && json.ok === true) {
        const recoveredRpcUrl =
          typeof json.foundry?.rpcUrl === 'string' && json.foundry.rpcUrl.trim()
            ? json.foundry.rpcUrl.trim()
            : baseSettings.rpcUrl;
        const nextSettings: FoundrySettings = {
          ...baseSettings,
          rpcUrl: recoveredRpcUrl,
          chainId: preset.chainId,
          chainName: preset.chainName,
          blockExplorerUrl: baseSettings.blockExplorerUrl || preset.blockExplorerUrl,
          currencySymbol: baseSettings.currencySymbol || preset.currencySymbol,
        };
        setSettings(nextSettings);
        setStatus(`Enabled Anvil fork mode for ${preset.chainName}. Retrying...`);
        return { settings: nextSettings, strategy: 'fork' };
      }
    } catch {
      // Fall through to RPC switch fallback below when simulation-only.
    }

    if (!forSimulationOnly) return null;
    if (baseSettings.rpcUrl.trim() === preset.rpcUrl) return null;

    const switchedSettings: FoundrySettings = {
      ...baseSettings,
      rpcUrl: preset.rpcUrl,
      chainId: preset.chainId,
      chainName: preset.chainName,
      blockExplorerUrl: baseSettings.blockExplorerUrl || preset.blockExplorerUrl,
      currencySymbol: baseSettings.currencySymbol || preset.currencySymbol,
    };
    setSettings(switchedSettings);
    setStatus(`Switched Foundry RPC to ${preset.rpcUrl} for ${preset.chainName}. Retrying...`);
    return { settings: switchedSettings, strategy: 'rpc' };
  }

  async function runSimulation(
    txParams: EthereumTxParams,
    startedAt: string,
    runtimeSettings: FoundrySettings = settings,
  ): Promise<void> {
    const [callResult, gasEstimateHex] = await Promise.all([
      callFoundryRpc<unknown>({
        rpcUrl: runtimeSettings.rpcUrl,
        method: 'eth_call',
        params: [txParams, 'latest'],
        chainId: runtimeSettings.chainId,
      }),
      callFoundryRpc<string>({
        rpcUrl: runtimeSettings.rpcUrl,
        method: 'eth_estimateGas',
        params: [txParams],
        chainId: runtimeSettings.chainId,
      }).catch(() => null),
    ]);

    const finishedAt = new Date().toISOString();
    setLastResult({
      kind: 'simulate',
      summary: 'Simulation completed via eth_call.',
      payload: callResult,
      gasEstimateHex,
      txHash: null,
      receipt: null,
      startedAt,
      finishedAt,
    });
    setStatus('Simulation completed.');
    setActiveOutputTab('Result');
  }

  async function runTransaction(
    txParams: EthereumTxParams,
    startedAt: string,
    signerSource: SignerSource,
    runtimeSettings: FoundrySettings = settings,
  ): Promise<void> {
    if (!txParams.from) throw new Error('Select a signer before sending a transaction.');

    let txHashRaw: unknown;
    if (signerSource === 'wallet') {
      const provider = getEthereumProvider();
      if (!provider)
        throw new Error('No injected wallet found. Connect wallet from Settings first.');
      if (!wallet.address)
        throw new Error('No wallet session found. Connect wallet from Settings first.');

      const targetChainHex = toChainIdHex(runtimeSettings.chainId);
      const walletChainHex = wallet.chainIdHex;
      if (walletChainHex && walletChainHex.toLowerCase() !== targetChainHex.toLowerCase()) {
        await callWalletRpc({
          provider,
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: targetChainHex }],
          rpcUrl: runtimeSettings.rpcUrl,
          chainId: runtimeSettings.chainId,
        });
      }

      txHashRaw = await callWalletRpc<unknown>({
        provider,
        method: 'eth_sendTransaction',
        params: [txParams],
        rpcUrl: runtimeSettings.rpcUrl,
        chainId: runtimeSettings.chainId,
      });
    } else {
      txHashRaw = await callFoundryRpc<string>({
        rpcUrl: runtimeSettings.rpcUrl,
        method: 'eth_sendTransaction',
        params: [txParams],
        chainId: runtimeSettings.chainId,
      });
    }

    if (typeof txHashRaw !== 'string' || !txHashRaw) {
      throw new Error('Transaction send failed: missing hash.');
    }

    const now = new Date().toISOString();
    const txRecord: SandboxTransaction = {
      hash: txHashRaw,
      from: txParams.from,
      to: txParams.to,
      chainId: runtimeSettings.chainId,
      valueWei:
        typeof txParams.value === 'string' && txParams.value.startsWith('0x')
          ? BigInt(txParams.value).toString()
          : '0',
      data: txParams.data ?? '0x',
      createdAt: now,
      updatedAt: now,
      status: 'pending',
      receipt: null,
      error: null,
    };
    upsertSandboxTransaction(txRecord);
    setSelectedTxHash(txHashRaw);
    setStatus(`Transaction submitted: ${txHashRaw}`);
    setActiveOutputTab('Result');

    const runId = ++pollRunId.current;
    const receipt = await fetchReceipt(runtimeSettings.rpcUrl, txHashRaw, runtimeSettings);
    if (runId !== pollRunId.current) return;

    const finishedAt = new Date().toISOString();
    if (receipt) {
      const txStatus = parseReceiptStatus(receipt);
      patchSandboxTransaction(txHashRaw, {
        status: txStatus === 'pending' ? 'success' : txStatus,
        receipt,
        error: null,
      });

      setLastResult({
        kind: 'transaction',
        summary: `Transaction mined with status: ${statusLabel(
          txStatus === 'pending' ? 'success' : txStatus,
        )}.`,
        payload: receipt,
        gasEstimateHex: null,
        txHash: txHashRaw,
        receipt,
        startedAt,
        finishedAt,
      });
      setStatus('Transaction mined.');
      return;
    }

    patchSandboxTransaction(txHashRaw, {
      status: 'pending',
      error: 'Transaction receipt not found within polling window.',
    });

    setLastResult({
      kind: 'transaction',
      summary: 'Transaction submitted, awaiting receipt.',
      payload: { txHash: txHashRaw },
      gasEstimateHex: null,
      txHash: txHashRaw,
      receipt: null,
      startedAt,
      finishedAt,
    });
  }

  async function onExecute() {
    setBusy(true);
    setError(null);
    setStatus(null);

    const startedAt = new Date().toISOString();

    try {
      const to = contractAddress.trim();
      const data = hexData.trim();
      let runtimeSettings = settings;
      const gasHex = parsePositiveIntToHex(gasLimit);
      const valueWei = parseEthToWei(valueEth);

      if (!isAddress(to)) {
        throw new Error('Contract address must be a 20-byte hex address.');
      }
      if (!isHexData(data)) {
        throw new Error('Hex data must be valid 0x-prefixed hex bytes.');
      }
      if (valueWei === null) {
        throw new Error('Value must be a valid ETH decimal with up to 18 decimals.');
      }

      const fromOverride = simulateFromOverride.trim();
      if (simulateOnly && fromOverride && !isAddress(fromOverride)) {
        throw new Error('Simulation "from" override must be a 20-byte hex address.');
      }

      // If you're calling a mainnet address on a non-forked Anvil chain, eth_call will usually return `0x`.
      // Make this explicit so it doesn't look like the sandbox is broken.
      if (data.toLowerCase() !== '0x') {
        let code = await callFoundryRpc<string>({
          rpcUrl: runtimeSettings.rpcUrl,
          method: 'eth_getCode',
          params: [to, 'latest'],
          chainId: runtimeSettings.chainId,
        });

        if (isEmptyBytecode(code)) {
          const autoResolved = await tryAutoResolveMissingBytecode(to, runtimeSettings, simulateOnly);
          if (autoResolved) {
            runtimeSettings = autoResolved.settings;
            code = await callFoundryRpc<string>({
              rpcUrl: runtimeSettings.rpcUrl,
              method: 'eth_getCode',
              params: [to, 'latest'],
              chainId: runtimeSettings.chainId,
            });
          }
        }

        if (isEmptyBytecode(code)) {
          throw new Error(
            `No contract bytecode found at ${to} on ${runtimeSettings.rpcUrl} (chainId ${runtimeSettings.chainId}). ` +
              `Automatic recovery was attempted. If this is a mainnet address, verify Anvil fork mode in Settings (or AGENT_FOUNDRY_FORK_URL) or switch Foundry RPC in Settings.`,
          );
        }
      }

      const txParams: EthereumTxParams = {
        from: simulateOnly
          ? fromOverride || selectedSigner || undefined
          : selectedSigner || undefined,
        to,
        data,
        value: toRpcHex(valueWei),
        gas: gasHex ?? undefined,
      };

      if (simulateOnly) {
        await runSimulation(txParams, startedAt, runtimeSettings);
      } else {
        const signerSource = selectedSignerOption?.source;
        if (!signerSource)
          throw new Error('No signer selected. Choose wallet or a prefunded dev account.');
        await runTransaction(txParams, startedAt, signerSource, runtimeSettings);
      }
    } catch (err) {
      const message = errorMessage(err, 'Execution failed.');
      setError(message);
      setLastResult({
        kind: 'error',
        summary: message,
        payload: { error: message },
        gasEstimateHex: null,
        txHash: null,
        receipt: null,
        startedAt,
        finishedAt: new Date().toISOString(),
      });
      setActiveOutputTab('Result');
    } finally {
      setBusy(false);
    }
  }

  async function onCopyAddress() {
    try {
      await navigator.clipboard.writeText(contractAddress);
      setStatus('Contract address copied.');
    } catch {
      setStatus('Failed to copy contract address.');
    }
  }

  async function onCopyResult() {
    if (!lastResult) return;
    try {
      await navigator.clipboard.writeText(toPrettyJson(lastResult.payload));
      setStatus('Result copied to clipboard.');
    } catch {
      setStatus('Failed to copy result.');
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-[color:var(--cs-panel)]">
      <section className="border-b border-[color:var(--cs-border)] px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-2 rounded-lg border border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-3 py-2">
            <Database className="h-4 w-4 text-[color:var(--cs-accent)]" />
            <span className="text-[14px] font-medium text-[color:var(--cs-fg)]">
              {settings.chainName}
            </span>
            <span className="text-[11px] font-mono text-[color:var(--cs-muted)]">
              #{settings.chainId}
            </span>
          </div>

          <div className="relative flex-1">
            <input
              type="text"
              value={contractAddress}
              onChange={(e) => setContractAddress(e.target.value)}
              className="h-11 w-full rounded-lg border border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] pl-4 pr-24 text-[15px] font-mono outline-none focus:border-[color:var(--cs-accent)]"
            />
            <div className="absolute right-2 top-1.5 flex gap-1">
              <span
                className={`rounded px-2 py-1 text-[10px] font-bold ${
                  isAddress(contractAddress.trim())
                    ? 'bg-emerald-500/10 text-emerald-600'
                    : 'bg-amber-500/10 text-amber-600'
                }`}
              >
                {isAddress(contractAddress.trim()) ? 'VALID' : 'CHECK ADDRESS'}
              </span>
            </div>
          </div>

          <button
            type="button"
            onClick={() => void onExecute()}
            disabled={busy || (!simulateOnly && !selectedSigner)}
            className="inline-flex h-11 items-center gap-2 rounded-lg bg-[color:var(--cs-accent)] px-5 text-[14px] font-semibold text-white shadow-lg shadow-blue-500/20 transition-all hover:bg-blue-600 disabled:opacity-60"
          >
            <SendHorizontal className="h-4 w-4" />
            {busy
              ? 'Running…'
              : simulateOnly
                ? 'Simulate'
                : selectedSigner
                  ? 'Send'
                  : 'Select Signer'}
          </button>

          <IconButton label="Copy Result" onClick={() => void onCopyResult()}>
            <Copy className="h-4 w-4" />
          </IconButton>
          <IconButton label="Copy Address" onClick={() => void onCopyAddress()}>
            <Check className="h-4 w-4" />
          </IconButton>
          <Link
            href="/settings"
            className="inline-flex h-11 w-11 items-center justify-center rounded-lg border border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] text-[color:var(--cs-muted)] hover:bg-[color:var(--cs-hover)] hover:text-[color:var(--cs-fg)] transition-colors"
            title="Open Settings"
          >
            <Settings className="h-4 w-4" />
          </Link>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-6 text-[14px]">
          <div className="flex items-center gap-2 text-[color:var(--cs-muted)]">
            <Code2 className="h-4 w-4" />
            Signer:
            <select
              value={selectedSigner}
              onChange={(e) => setSelectedSigner(e.target.value)}
              className="min-w-[240px] rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 py-1 text-[13px] text-[color:var(--cs-fg)] outline-none focus:border-[color:var(--cs-accent)]"
            >
              {signerOptions.length === 0 ? (
                <option value="">No signer available</option>
              ) : (
                signerOptions.map((option) => (
                  <option key={`${option.source}-${option.address}`} value={option.address}>
                    {option.label}
                  </option>
                ))
              )}
            </select>
            <button
              type="button"
              onClick={() => void loadDevSigners()}
              className="rounded-md border border-[color:var(--cs-border)] px-2 py-1 text-[11px] font-medium text-[color:var(--cs-fg)] hover:bg-[color:var(--cs-hover)]"
            >
              Refresh
            </button>
            {devSignersLoading ? <span className="text-[11px]">Loading…</span> : null}
          </div>

          <label className="inline-flex cursor-pointer items-center gap-2 text-[color:var(--cs-fg)]">
            <input
              type="checkbox"
              checked={simulateOnly}
              onChange={(e) => setSimulateOnly(e.currentTarget.checked)}
              className="h-4 w-4 rounded border-[color:var(--cs-border)] accent-[color:var(--cs-accent)]"
            />
            Simulate only
          </label>

          <button
            type="button"
            onClick={() => setActiveOutputTab('Trace')}
            className="rounded-md border border-[color:var(--cs-border)] px-2 py-1 text-[12px] font-medium text-[color:var(--cs-fg)] hover:bg-[color:var(--cs-hover)]"
          >
            View transactions ({transactions.length})
          </button>

          <div className="text-[12px] text-[color:var(--cs-muted)]">
            RPC: <span className="font-mono">{settings.rpcUrl}</span>
          </div>
        </div>
      </section>

      <VerticalResizable storageKey="input-output-resize-ratio" defaultRatio={0.5}>
        <div className="flex min-h-0 flex-col overflow-hidden">
          <div className="flex flex-shrink-0 items-center gap-6 border-b border-[color:var(--cs-border)] px-4">
            {INPUT_TABS.map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setActiveInputTab(tab)}
                className={[
                  'border-b-2 py-3 text-[14px] font-medium transition-colors',
                  activeInputTab === tab
                    ? 'border-[color:var(--cs-accent)] text-[color:var(--cs-accent)]'
                    : 'border-transparent text-[color:var(--cs-muted)] hover:text-[color:var(--cs-fg)]',
                ].join(' ')}
              >
                {tab}
              </button>
            ))}
          </div>

          {activeInputTab === 'Hex Data' || activeInputTab === 'ABI' ? (
            <div className="min-h-0 flex-1 overflow-hidden bg-[color:var(--cs-panel-soft)] px-4 py-4">
              <div className="flex h-full min-h-0">
                {activeInputTab === 'Hex Data' && (
                  <textarea
                    rows={100}
                    spellCheck={false}
                    value={hexData}
                    onChange={(e) => setHexData(e.target.value)}
                    className="h-full w-full resize-none rounded-lg border border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] p-3 font-mono text-[13px] leading-5 text-[color:var(--cs-fg)] outline-none focus:border-[color:var(--cs-accent)]"
                  />
                )}
                {activeInputTab === 'ABI' && (
                  <textarea
                    rows={100}
                    value={abiJson}
                    onChange={(e) => setAbiJson(e.target.value)}
                    className="h-full w-full resize-none rounded-lg border border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] p-3 font-mono text-[13px] leading-5 text-[color:var(--cs-fg)] outline-none focus:border-[color:var(--cs-accent)]"
                  />
                )}
              </div>
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-auto p-4">
              {activeInputTab === 'Parameters' && (
                <div className="space-y-4">
                  <div>
                    <div className="mb-4 flex items-center justify-between">
                      <h3 className="text-sm font-semibold uppercase tracking-wider text-[color:var(--cs-fg)]">
                        Raw Transaction Parameters
                      </h3>
                      <span className="text-[11px] font-mono text-[color:var(--cs-muted)]">
                        {simulateOnly ? 'eth_call' : 'eth_sendTransaction'}
                      </span>
                    </div>
                    <div className="grid gap-4">
                      <ParameterField
                        label={simulateOnly ? 'From (eth_call override)' : 'From (selected signer)'}
                        placeholder="0x..."
                        value={
                          simulateOnly ? simulateFromOverride || selectedSigner : selectedSigner
                        }
                        readOnly={!simulateOnly}
                        onChange={simulateOnly ? setSimulateFromOverride : undefined}
                      />
                      <ParameterField
                        label="To (contract)"
                        placeholder="0x..."
                        value={contractAddress}
                        onChange={setContractAddress}
                      />
                      <ParameterField
                        label="Data (hex calldata)"
                        placeholder="0x..."
                        value={hexData}
                        onChange={setHexData}
                      />
                    </div>
                  </div>
                </div>
              )}

              {activeInputTab === 'Value' && (
                <div className="max-w-md">
                  <ParameterField
                    label="Native Value"
                    placeholder="0"
                    value={valueEth}
                    onChange={setValueEth}
                    unit={settings.currencySymbol}
                  />
                  <p className="mt-2 text-[12px] text-[color:var(--cs-muted)]">
                    Amount of native currency sent with the transaction.
                  </p>
                </div>
              )}

              {activeInputTab === 'Gas Limit' && (
                <div className="max-w-md">
                  <ParameterField
                    label="Gas Limit"
                    placeholder="210000"
                    value={gasLimit}
                    onChange={setGasLimit}
                  />
                  <p className="mt-2 text-[12px] text-[color:var(--cs-muted)]">
                    Leave blank to let wallet or RPC estimate gas.
                  </p>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex min-h-0 flex-col overflow-hidden">
          <div className="flex flex-shrink-0 items-center gap-4 overflow-x-auto border-b border-[color:var(--cs-border)] px-4">
            {OUTPUT_TABS.map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setActiveOutputTab(tab)}
                className={[
                  'whitespace-nowrap border-b-2 py-2 text-[13px] font-medium transition-colors',
                  activeOutputTab === tab
                    ? 'border-[color:var(--cs-accent)] text-[color:var(--cs-accent)]'
                    : 'border-transparent text-[color:var(--cs-muted)] hover:text-[color:var(--cs-fg)]',
                ].join(' ')}
              >
                {tab}
              </button>
            ))}
          </div>

          <div className="min-h-0 flex-1 overflow-auto bg-[color:var(--cs-panel-soft)]">
            {activeOutputTab === 'Result' && (
              <div className="space-y-4 p-4">
                {lastResult ? (
                  <>
                    <div className="rounded-lg border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] p-3 text-[12px]">
                      {lastResult.summary}
                    </div>
                    {decodedCallResult ? (
                      <div className="rounded-lg border border-[color:var(--cs-accent)]/30 bg-[color:var(--cs-panel)] p-3">
                        <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-[color:var(--cs-muted)]">
                          Decoded
                        </div>
                        <div className="text-[12px] font-mono text-[color:var(--cs-fg)]">
                          <span className="text-[color:var(--cs-accent)]">{decodedCallResult.functionName}</span>
                          {' → '}
                          {typeof decodedCallResult.decoded === 'object' &&
                          decodedCallResult.decoded !== null ? (
                            <span>{toPrettyJson(decodedCallResult.decoded)}</span>
                          ) : (
                            <span>{String(decodedCallResult.decoded)}</span>
                          )}
                        </div>
                      </div>
                    ) : null}
                    <pre className="rounded-lg border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] p-3 font-mono text-[12px] leading-5 text-[color:var(--cs-fg)]">
                      {toPrettyJson(lastResult.payload)}
                    </pre>
                  </>
                ) : (
                  <div className="rounded-lg border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] p-3 text-[12px] text-[color:var(--cs-muted)]">
                    Execute a simulation or transaction to see results.
                  </div>
                )}

                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  <StatCard
                    label="Estimated Gas"
                    value={
                      lastResult?.gasEstimateHex
                        ? formatHexQuantity(lastResult.gasEstimateHex) ?? lastResult.gasEstimateHex
                        : 'n/a'
                    }
                    icon={<Activity className="h-3 w-3" />}
                  />
                  <StatCard
                    label="Transaction Hash"
                    value={lastResult?.txHash ?? selectedTx?.hash ?? 'n/a'}
                    icon={<Terminal className="h-3 w-3" />}
                  />
                </div>
              </div>
            )}

            {activeOutputTab === 'Trace' && (
              <div className="space-y-2 p-4 font-mono text-[12px]">
                {transactions.length === 0 ? (
                  <div className="rounded-lg border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] p-3 text-[color:var(--cs-muted)]">
                    No sandbox transactions yet.
                  </div>
                ) : (
                  transactions.map((tx) => {
                    const selected = tx.hash === selectedTxHash;
                    return (
                      <button
                        key={tx.hash}
                        type="button"
                        onClick={() => setSelectedTxHash(tx.hash)}
                        className={`flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-colors ${
                          selected
                            ? 'border-[color:var(--cs-accent)] bg-[color:var(--cs-panel)]'
                            : 'border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] hover:border-[color:var(--cs-accent)]'
                        }`}
                      >
                        <span
                          className={`min-w-[72px] text-[11px] font-bold ${statusClass(tx.status)}`}
                        >
                          {statusLabel(tx.status)}
                        </span>
                        <span className="text-[color:var(--cs-fg)]">{shortHex(tx.hash, 22)}</span>
                        <span className="text-[color:var(--cs-muted)]">
                          to {shortHex(tx.to, 18)}
                        </span>
                        <span className="ml-auto text-[10px] text-[color:var(--cs-muted)]">
                          {new Date(tx.createdAt).toLocaleTimeString()}
                        </span>
                      </button>
                    );
                  })
                )}
              </div>
            )}

            {activeOutputTab === 'Events' && (
              <div className="p-4">
                {outputLogs.length === 0 ? (
                  <div className="rounded-lg border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] p-3 text-[12px] text-[color:var(--cs-muted)]">
                    No logs available for the selected result.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {translateReceiptLogs(outputLogs).map((translated, idx) => (
                      <div
                        key={`log-${idx}`}
                        className="rounded-lg border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] p-3"
                      >
                        <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold text-[color:var(--cs-muted)]">
                          Log #{idx + 1}
                          {translated.eventName ? (
                            <span className="rounded bg-[color:var(--cs-accent)]/20 px-1.5 py-0.5 font-mono text-[color:var(--cs-accent)]">
                              {translated.eventName}
                            </span>
                          ) : null}
                        </div>
                        {translated.eventName && translated.args != null ? (
                          <div className="mb-2 font-mono text-[12px] text-[color:var(--cs-fg)]">
                            <pre>{toPrettyJson(translated.args)}</pre>
                          </div>
                        ) : null}
                        <pre className="font-mono text-[12px] text-[color:var(--cs-fg)]">
                          {toPrettyJson(translated.raw)}
                        </pre>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {activeOutputTab === 'State Change' && (
              <div className="space-y-3 p-4">
                {selectedTx ? (
                  <>
                    <BalanceChange
                      label="From"
                      address={selectedTx.from}
                      value={selectedTx.valueWei}
                      currencySymbol={settings.currencySymbol}
                    />
                    <BalanceChange
                      label="To"
                      address={selectedTx.to}
                      value={selectedTx.valueWei}
                      currencySymbol={settings.currencySymbol}
                    />
                  </>
                ) : (
                  <div className="rounded-lg border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] p-3 text-[12px] text-[color:var(--cs-muted)]">
                    Select a transaction from Trace to inspect state deltas.
                  </div>
                )}
              </div>
            )}

            {activeOutputTab === 'Raw' && (
              <div className="p-4">
                {(() => {
                  const rawPayload = lastResult?.payload ?? selectedTx?.receipt ?? null;
                  const receipt = rawPayload && typeof rawPayload === 'object' ? rawPayload as Record<string, unknown> : null;
                  const gasUsed = receipt?.gasUsed != null ? formatHexQuantity(String(receipt.gasUsed)) : null;
                  const status = receipt?.status;
                  const statusText =
                    status === '0x1' || status === 1
                      ? 'success'
                      : status === '0x0' || status === 0
                        ? 'reverted'
                        : null;
                  const summaryParts =
                    gasUsed || statusText
                      ? [gasUsed ? `gasUsed: ${gasUsed}` : null, statusText ? `status: ${statusText}` : null].filter(
                          Boolean,
                        )
                      : null;
                  return (
                    <>
                      {summaryParts && summaryParts.length > 0 ? (
                        <div className="mb-2 rounded-lg border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-3 py-2 text-[11px] text-[color:var(--cs-muted)]">
                          {summaryParts.join(' · ')}
                        </div>
                      ) : null}
                      <div className="mb-2 flex items-center gap-2 text-[12px] font-medium text-[color:var(--cs-muted)]">
                        <Terminal className="h-3.5 w-3.5" />
                        Raw Output
                      </div>
                      <div className="rounded-lg border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] p-4 font-mono text-[12px] break-all text-[color:var(--cs-fg)]">
                        {toPrettyJson(rawPayload)}
                      </div>
                    </>
                  );
                })()}
              </div>
            )}
          </div>
        </div>
      </VerticalResizable>

      <footer className="flex flex-wrap items-center gap-4 border-t border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-3 py-1.5 text-[11px] text-[color:var(--cs-muted)]">
        <span className="flex items-center gap-1.5">
          <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" />
          Mode:{' '}
          <span className="font-medium text-[color:var(--cs-fg)]">
            {simulateOnly ? 'Simulation' : 'Live Tx'}
          </span>
        </span>
        <span>
          Signer:{' '}
          <span className="font-medium text-[color:var(--cs-fg)]">
            {selectedSigner ? shortHex(selectedSigner, 14) : 'None'}
          </span>
        </span>
        <span>
          Chain:{' '}
          <span className="font-medium text-[color:var(--cs-fg)]">
            {settings.chainName} ({settings.chainId})
          </span>
        </span>
        <span className="ml-auto flex items-center gap-2">
          <Wallet className="h-3.5 w-3.5" />
          <span>
            {selectedSignerOption?.source === 'dev'
              ? 'Anvil Prefunded Account'
              : wallet.signature
                ? 'Authenticated Wallet'
                : 'Unsigned Wallet Session'}
          </span>
        </span>
      </footer>

      {(status || error) && (
        <div className="border-t border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-3 py-2 text-xs">
          {status ? <div className="text-emerald-600">{status}</div> : null}
          {error ? <div className="text-rose-600">{error}</div> : null}
        </div>
      )}
    </div>
  );
}

function ParameterField({
  label,
  placeholder,
  value,
  unit,
  readOnly,
  onChange,
}: {
  label: string;
  placeholder: string;
  value: string;
  unit?: string;
  readOnly?: boolean;
  onChange?: (value: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <label className="text-[12px] font-medium text-[color:var(--cs-muted)]">{label}</label>
      <div className="relative">
        <input
          type="text"
          placeholder={placeholder}
          value={value}
          readOnly={readOnly}
          onChange={(e) => onChange?.(e.target.value)}
          className="h-10 w-full rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-3 font-mono text-[13px] text-[color:var(--cs-fg)] outline-none transition-all focus:border-[color:var(--cs-accent)]"
        />
        {unit && (
          <div className="absolute right-3 top-1/2 -translate-y-1/2 text-[12px] font-bold text-[color:var(--cs-muted)]">
            {unit}
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({ label, value, icon }: { label: string; value: string; icon: ReactNode }) {
  return (
    <div className="rounded-lg border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] p-3">
      <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-[color:var(--cs-muted)]">
        {icon}
        {label}
      </div>
      <div className="break-all text-[14px] font-semibold text-[color:var(--cs-fg)]">{value}</div>
    </div>
  );
}

function BalanceChange({
  label,
  address,
  value,
  currencySymbol = 'ETH',
}: {
  label: string;
  address: string;
  value: string;
  currencySymbol?: string;
}) {
  const valueEth =
    value && /^\d+$/.test(value)
      ? formatWeiToEth(BigInt(value))
      : null;
  return (
    <div className="flex items-center justify-between rounded-lg border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] p-3">
      <div className="space-y-0.5">
        <div className="text-[11px] font-bold uppercase tracking-tight text-[color:var(--cs-muted)]">
          {label}
        </div>
        <div className="text-[12px] font-mono text-[color:var(--cs-fg)]">{address}</div>
      </div>
      <div className="text-right text-[12px] font-mono text-[color:var(--cs-fg)]">
        {valueEth != null ? (
          <>
            <div>{valueEth} {currencySymbol}</div>
            <div className="text-[11px] text-[color:var(--cs-muted)]">{value} wei</div>
          </>
        ) : (
          <div>{value} wei</div>
        )}
      </div>
    </div>
  );
}

function IconButton(props: { label: string; children: ReactNode; onClick?: () => void }) {
  return (
    <button
      type="button"
      aria-label={props.label}
      title={props.label}
      onClick={props.onClick}
      className="inline-flex h-11 w-11 items-center justify-center rounded-lg border border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] text-[color:var(--cs-muted)] transition-colors hover:bg-[color:var(--cs-hover)] hover:text-[color:var(--cs-fg)]"
    >
      {props.children}
    </button>
  );
}
