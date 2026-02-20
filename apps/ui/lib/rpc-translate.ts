/**
 * Shared translation layer for EVM JSON-RPC responses.
 * Converts raw hex, wei, and ABI-encoded data into human-readable format.
 */

import {
  decodeEventLog,
  decodeFunctionData,
  decodeFunctionResult,
  type Abi,
} from 'viem';
import type { RpcInteractionTx } from './foundry-store';

/** Common function selectors (4 bytes = first 10 hex chars incl 0x) */
export const KNOWN_FUNCTION_SELECTORS: Record<string, string> = {
  '0xa9059cbb': 'transfer(address,uint256)',
  '0x095ea7b3': 'approve(address,uint256)',
  '0x23b872dd': 'transferFrom(address,address,uint256)',
  '0x70a08231': 'balanceOf(address)',
  '0x18160ddd': 'totalSupply()',
  '0x06fdde03': 'name()',
  '0x95d89b41': 'symbol()',
  '0x313ce567': 'decimals()',
  '0xdd62ed3e': 'allowance(address,owner)',
  '0xd78ad95f': 'swap(uint256,uint256,address,bytes)',
  '0x38ed1739': 'swapExactTokensForTokens(uint256,uint256,address[],address,uint256)',
  '0x7ff36ab5': 'swapExactETHForTokens(uint256,address[],address,uint256)',
  '0x18cbafe5': 'swapExactTokensForETH(uint256,uint256,address[],address,uint256)',
  '0x5c11d795': 'swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)',
  '0x42b0b77c': 'flashLoanSimple(address,address,uint256,bytes,uint16)',
  '0xab9c4b5d': 'flashLoan(address,address[],uint256[],uint256[],address,bytes,uint16)',
  '0x5cffe9de': 'flashLoan(address,address,uint256,bytes)',
  '0x5c38449e': 'flashLoan(address,address[],uint256[],bytes)',
  '0x6a719182': 'executeOperation(address,address,uint256,uint256,address,bytes)',
  '0x920f5c84': 'executeOperation(address[],uint256[],uint256[],address,bytes)',
  '0x23e30c8b': 'onFlashLoan(address,address,uint256,uint256,bytes)',
};

/** Common event topic0 selectors (32 bytes = 66 hex chars) */
export const KNOWN_EVENT_TOPICS: Record<string, string> = {
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef':
    'Transfer(address,address,uint256)',
  '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925':
    'Approval(address,address,uint256)',
  '0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1':
    'Sync(uint112,uint112)',
  '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822':
    'Swap(address,uint256,uint256,uint256,uint256,address)',
  '0xefefaba5e921573100900a3ad9cf29f222d995fb3b6045797eaea7521bd8d6f0':
    'FlashLoan(address,address,address,uint256,uint8,uint256,uint16)',
  '0xc76f1b4fe4396ac07a9fa55a415d4ca430e72651d37d3401f3bed7cb13fc4f12':
    'FlashLoan(address,address,uint256)',
};

export type TranslatedTx = {
  from: string | null;
  to: string | null;
  value: string;
  valueEth: string | null;
  gas: string | null;
  data: string | null;
  dataDecoded: string | null;
};

export type TranslatedLog = {
  raw: Record<string, unknown>;
  eventName: string | null;
  args: unknown[] | Record<string, unknown> | null;
};

export type TranslatedResult = {
  raw: unknown;
  summary: string | null;
  decoded: unknown | null;
};

function parseHexQuantity(value: string | null | undefined): bigint | null {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || !/^0x[0-9a-fA-F]*$/.test(trimmed)) return null;
  try {
    return BigInt(trimmed);
  } catch {
    return null;
  }
}

/**
 * Format wei (bigint or hex string) as ETH with up to 6 decimal places.
 */
export function formatWeiToEth(wei: bigint): string {
  const base = BigInt(10) ** BigInt(18);
  const whole = wei / base;
  const fraction = wei % base;
  const fractionRaw = fraction.toString().padStart(18, '0').slice(0, 6);
  const fractionTrimmed = fractionRaw.replace(/0+$/, '');
  return fractionTrimmed ? `${whole.toString()}.${fractionTrimmed}` : whole.toString();
}

/**
 * Format hex wei string as ETH, or return null if invalid.
 */
export function formatWeiHexToEth(weiHex: string | null | undefined): string | null {
  const wei = parseHexQuantity(weiHex);
  if (wei == null) return null;
  return formatWeiToEth(wei);
}

/**
 * Format hex quantity as decimal string (for block numbers, gas, etc.).
 */
export function formatHexQuantity(hex: string | null | undefined): string | null {
  const value = parseHexQuantity(hex);
  if (value == null) return null;
  return value.toString();
}

/**
 * Get function selector from calldata (first 4 bytes = 10 hex chars).
 */
function getSelectorFromData(data: string | null | undefined): string | null {
  if (!data || typeof data !== 'string') return null;
  const trimmed = data.trim().toLowerCase();
  if (!trimmed.startsWith('0x') || trimmed.length < 10) return null;
  return trimmed.slice(0, 10);
}

/**
 * Get known function label from calldata selector.
 */
export function getDataSelectorLabel(data: string | null | undefined): string | null {
  const selector = getSelectorFromData(data);
  if (!selector) return null;
  return KNOWN_FUNCTION_SELECTORS[selector] ?? null;
}

/**
 * Translate transaction params for display (value as ETH, data selector label).
 */
export function translateTxParams(tx: RpcInteractionTx | null): TranslatedTx | null {
  if (!tx) return null;
  const valueWei = parseHexQuantity(tx.value);
  const valueEth = valueWei != null ? formatWeiToEth(valueWei) : null;
  const gasFormatted = formatHexQuantity(tx.gas);
  const dataLabel = getDataSelectorLabel(tx.data);

  return {
    from: tx.from ?? null,
    to: tx.to ?? null,
    value: tx.value ?? '-',
    valueEth,
    gas: gasFormatted ?? tx.gas ?? null,
    data: tx.data ?? null,
    dataDecoded: dataLabel,
  };
}

/**
 * Decode calldata using ABI when available.
 */
export function decodeCalldata(data: string | null | undefined, abi: Abi | null): {
  functionName: string;
  args: readonly unknown[];
} | null {
  if (!data || !abi || typeof data !== 'string') return null;
  const trimmed = data.trim();
  if (!trimmed.startsWith('0x') || trimmed.length < 10) return null;
  try {
    const decoded = decodeFunctionData({ abi, data: trimmed as `0x${string}` });
    return {
      functionName: decoded.functionName,
      args: decoded.args ?? [],
    };
  } catch {
    return null;
  }
}

/**
 * Decode eth_call return data using ABI.
 */
export function decodeCallResult(
  data: string | null | undefined,
  abi: Abi | null,
  functionName?: string,
): unknown | null {
  if (!data || !abi) return null;
  if (typeof data !== 'string') return null;
  const trimmed = data.trim();
  if (trimmed === '0x' || trimmed.length < 2) return null;

  // If we have functionName, use it; otherwise try to infer from calldata (caller must provide)
  if (!functionName) return null;

  try {
    return decodeFunctionResult({
      abi,
      functionName,
      data: trimmed as `0x${string}`,
    });
  } catch {
    return null;
  }
}

/** Common event ABIs for decodeEventLog */
const COMMON_EVENTS_ABI = [
  {
    type: 'event',
    name: 'Transfer',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'Approval',
    inputs: [
      { name: 'owner', type: 'address', indexed: true },
      { name: 'spender', type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'FlashLoan',
    inputs: [
      { name: 'target', type: 'address', indexed: true },
      { name: 'initiator', type: 'address', indexed: true },
      { name: 'asset', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'interestRateMode', type: 'uint8', indexed: false },
      { name: 'premium', type: 'uint256', indexed: false },
      { name: 'referralCode', type: 'uint16', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'FlashLoan',
    inputs: [
      { name: 'recipient', type: 'address', indexed: true },
      { name: 'token', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },
] as const;

/**
 * Translate receipt logs - attempt to decode known events.
 */
export function translateReceiptLogs(logs: unknown[]): TranslatedLog[] {
  if (!Array.isArray(logs)) return [];

  return logs.map((log) => {
    const raw = log && typeof log === 'object' ? (log as Record<string, unknown>) : {};
    const topics = raw.topics;
    const data = raw.data;
    const topicsArr = Array.isArray(topics) ? topics : [];

    let eventName: string | null = null;
    let args: unknown[] | Record<string, unknown> | null = null;

    const topic0 = typeof topicsArr[0] === 'string' ? topicsArr[0] : null;
    const knownEvent = topic0 ? KNOWN_EVENT_TOPICS[topic0] : null;

    if (knownEvent) {
      eventName = knownEvent.split('(')[0] ?? knownEvent;
    }

    // Try viem decode with common events when we have topic0
    if (topic0) {
      try {
        const decoded = decodeEventLog({
          abi: COMMON_EVENTS_ABI,
          data: (typeof data === 'string' ? data : '0x') as `0x${string}`,
          topics: topicsArr as [`0x${string}`, ...`0x${string}`[]],
          strict: false,
        });
        eventName = decoded.eventName ?? eventName;
        args = decoded.args as Record<string, unknown>;
      } catch {
        // Keep eventName from known map if we had it
      }
    }

    return { raw, eventName, args };
  });
}

/**
 * Translate RPC result by method (eth_getBalance, eth_call, etc.).
 */
export function translateRpcResult(method: string, result: unknown): TranslatedResult {
  const normalized = method.toLowerCase().trim();

  if (normalized === 'eth_getbalance') {
    const eth = formatWeiHexToEth(result as string);
    return {
      raw: result,
      summary: eth != null ? `${eth} ETH` : null,
      decoded: eth,
    };
  }

  if (normalized === 'eth_call') {
    const hex = result as string;
    if (typeof hex === 'string' && hex.startsWith('0x')) {
      const len = (hex.length - 2) / 2;
      return {
        raw: result,
        summary: `hex (${len} bytes)`,
        decoded: null,
      };
    }
  }

  if (normalized === 'eth_gettransactionreceipt') {
    const receipt = result as Record<string, unknown> | null;
    if (receipt && typeof receipt === 'object') {
      const gasUsed = formatHexQuantity(receipt.gasUsed as string);
      const status = receipt.status;
      const parts: string[] = [];
      if (gasUsed) parts.push(`gasUsed: ${gasUsed}`);
      if (status === '0x1' || status === 1) parts.push('status: success');
      else if (status === '0x0' || status === 0) parts.push('status: reverted');
      return {
        raw: result,
        summary: parts.length > 0 ? parts.join(', ') : null,
        decoded: null,
      };
    }
  }

  if (normalized === 'eth_blocknumber') {
    const blockNum = formatHexQuantity(result as string);
    return {
      raw: result,
      summary: blockNum != null ? `block ${blockNum}` : null,
      decoded: blockNum,
    };
  }

  return { raw: result, summary: null, decoded: null };
}
