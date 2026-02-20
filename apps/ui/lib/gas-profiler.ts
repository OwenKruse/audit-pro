import { callFoundryRpc } from './foundry-rpc';

const BIGINT_ZERO = BigInt(0);
const BIGINT_ONE = BigInt(1);
const BIGINT_TEN_THOUSAND = BigInt(10_000);

type TraceTxReceipt = {
  gasUsed?: unknown;
  status?: unknown;
};

type StructLog = {
  op?: unknown;
  gasCost?: unknown;
};

type StructTrace = {
  structLogs?: unknown;
};

type CallTracerNode = {
  type?: unknown;
  from?: unknown;
  to?: unknown;
  input?: unknown;
  value?: unknown;
  gas?: unknown;
  gasUsed?: unknown;
  calls?: unknown;
};

export type GasCallNode = {
  id: string;
  depth: number;
  type: string | null;
  from: string | null;
  to: string | null;
  selector: string | null;
  inputSize: number | null;
  value: string | null;
  gas: bigint | null;
  gasUsed: bigint | null;
};

export type GasOpcodeHotspot = {
  op: string;
  gas: bigint;
  count: number;
  pct: number | null;
};

export type GasProfile = {
  txHash: string;
  receiptGasUsed: bigint | null;
  receiptStatus: 'success' | 'reverted' | 'unknown';
  traceCoveragePct: number | null;
  calls: GasCallNode[];
  opcodes: GasOpcodeHotspot[];
};

function isHexBytes(v: unknown): v is string {
  return typeof v === 'string' && /^0x[0-9a-fA-F]*$/.test(v);
}

function isAddress(v: unknown): v is string {
  return typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v);
}

function asString(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  return trimmed ? trimmed : null;
}

function parseQuantityToBigInt(v: unknown): bigint | null {
  if (typeof v === 'bigint') return v >= BIGINT_ZERO ? v : null;
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v < 0) return null;
    return BigInt(Math.trunc(v));
  }
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return null;
    if (/^0x[0-9a-fA-F]+$/.test(s)) {
      try {
        const out = BigInt(s);
        return out >= BIGINT_ZERO ? out : null;
      } catch {
        return null;
      }
    }
    if (/^[0-9]+$/.test(s)) {
      try {
        const out = BigInt(s);
        return out >= BIGINT_ZERO ? out : null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

function selectorFromInput(input: unknown): string | null {
  if (!isHexBytes(input)) return null;
  if (input.length < 10) return null;
  return input.slice(0, 10).toLowerCase();
}

function inputSizeBytes(input: unknown): number | null {
  if (!isHexBytes(input)) return null;
  // "0x" => 0 bytes; each 2 hex chars => 1 byte
  const hexLen = input.length - 2;
  if (hexLen < 0 || hexLen % 2 !== 0) return null;
  return hexLen / 2;
}

function walkCallTracer(
  node: CallTracerNode,
  out: GasCallNode[],
  depth: number,
  path: number[],
): void {
  const id = `call:${path.join('.') || '0'}`;
  const type = asString(node.type);
  const from = isAddress(node.from) ? node.from : asString(node.from);
  const to = isAddress(node.to) ? node.to : asString(node.to);
  const input = node.input;

  out.push({
    id,
    depth,
    type,
    from,
    to,
    selector: selectorFromInput(input),
    inputSize: inputSizeBytes(input),
    value: asString(node.value),
    gas: parseQuantityToBigInt(node.gas),
    gasUsed: parseQuantityToBigInt(node.gasUsed),
  });

  const calls = Array.isArray(node.calls) ? (node.calls as CallTracerNode[]) : [];
  for (let i = 0; i < calls.length; i++) {
    walkCallTracer(calls[i] ?? ({} as CallTracerNode), out, depth + 1, [...path, i]);
  }
}

function parseStructLogs(trace: StructTrace): StructLog[] {
  if (!trace || typeof trace !== 'object') return [];
  const raw = (trace as StructTrace).structLogs;
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is StructLog => !!item && typeof item === 'object');
}

function pct(n: bigint, d: bigint): number | null {
  if (d <= BIGINT_ZERO) return null;
  if (n < BIGINT_ZERO) return null;
  // 2dp with integer math to avoid floats on bigints.
  const scaled = (n * BIGINT_TEN_THOUSAND) / d; // basis points
  return Number(scaled) / 100;
}

export async function profileGasForTransaction(input: {
  rpcUrl: string;
  chainId?: number | null;
  txHash: string;
  signal?: AbortSignal;
}): Promise<GasProfile> {
  const txHash = input.txHash.trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    throw new Error('Invalid tx hash. Expected 0x-prefixed 32-byte hash.');
  }

  const receipt = await callFoundryRpc<TraceTxReceipt>(
    { rpcUrl: input.rpcUrl, chainId: input.chainId ?? null, method: 'eth_getTransactionReceipt', params: [txHash] },
    { signal: input.signal },
  );

  const receiptGasUsed = parseQuantityToBigInt(receipt?.gasUsed);
  const receiptStatusRaw = parseQuantityToBigInt(receipt?.status);
  const receiptStatus: GasProfile['receiptStatus'] =
    receiptStatusRaw === BIGINT_ONE ? 'success'
    : receiptStatusRaw === BIGINT_ZERO ? 'reverted'
    : 'unknown';

  // 1) Call tree via callTracer (fast, gives per-call gasUsed)
  // 2) Opcode breakdown via structLogs (slower, gives per-op gasCost)
  const [callTrace, structTrace] = await Promise.all([
    callFoundryRpc<unknown>(
      {
        rpcUrl: input.rpcUrl,
        chainId: input.chainId ?? null,
        method: 'debug_traceTransaction',
        params: [txHash, { tracer: 'callTracer' }],
      },
      { signal: input.signal },
    ),
    (async () => {
      try {
        return await callFoundryRpc<unknown>(
          {
            rpcUrl: input.rpcUrl,
            chainId: input.chainId ?? null,
            method: 'debug_traceTransaction',
            params: [
              txHash,
              {
                disableStorage: true,
                disableStack: true,
                enableMemory: false,
                enableReturnData: false,
              },
            ],
          },
          { signal: input.signal },
        );
      } catch {
        // Some RPCs reject the options object; fall back to defaults.
        return await callFoundryRpc<unknown>(
          { rpcUrl: input.rpcUrl, chainId: input.chainId ?? null, method: 'debug_traceTransaction', params: [txHash] },
          { signal: input.signal },
        );
      }
    })(),
  ]);

  const calls: GasCallNode[] = [];
  if (callTrace && typeof callTrace === 'object') {
    walkCallTracer(callTrace as CallTracerNode, calls, 0, []);
  }

  const logs = parseStructLogs(structTrace as StructTrace);
  const byOp = new Map<string, { gas: bigint; count: number }>();
  let sumGasCost = BIGINT_ZERO;
  for (const log of logs) {
    const op = typeof log.op === 'string' && log.op.trim() ? log.op.trim().toUpperCase() : null;
    const gasCost = parseQuantityToBigInt(log.gasCost) ?? BIGINT_ZERO;
    if (!op) continue;
    sumGasCost += gasCost;
    const cur = byOp.get(op) ?? { gas: BIGINT_ZERO, count: 0 };
    cur.gas += gasCost;
    cur.count += 1;
    byOp.set(op, cur);
  }

  const denom = receiptGasUsed ?? (sumGasCost > BIGINT_ZERO ? sumGasCost : BIGINT_ZERO);
  const opcodes: GasOpcodeHotspot[] = [...byOp.entries()]
    .map(([op, v]) => ({ op, gas: v.gas, count: v.count, pct: denom > BIGINT_ZERO ? pct(v.gas, denom) : null }))
    .sort((a, b) => (a.gas === b.gas ? b.count - a.count : a.gas > b.gas ? -1 : 1))
    .slice(0, 40);

  const traceCoveragePct =
    receiptGasUsed && receiptGasUsed > BIGINT_ZERO && sumGasCost > BIGINT_ZERO ? pct(sumGasCost, receiptGasUsed) : null;

  return {
    txHash,
    receiptGasUsed,
    receiptStatus,
    traceCoveragePct,
    calls,
    opcodes,
  };
}
