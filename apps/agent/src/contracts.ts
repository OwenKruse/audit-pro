import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  ContractDecodedItemSchema,
  ContractDetailSchema,
  ContractSummarySchema,
  UpsertContractRequestSchema,
  type ContractAbi,
  type ContractDecodedItem,
  type ContractDetail,
  type ContractSummary,
  type DecodedArg,
  type UpsertContractRequest,
} from '@cipherscope/proto';
import {
  decodeEventLog,
  decodeFunctionData,
  type Abi,
  type AbiParameter,
  type Hex,
} from 'viem';

const UINT256_MAX = (2n ** 256n - 1n).toString();

const COMMON_EVENTS_ABI = [
  {
    type: 'event',
    name: 'Transfer',
    inputs: [
      { indexed: true, name: 'from', type: 'address' },
      { indexed: true, name: 'to', type: 'address' },
      { indexed: false, name: 'value', type: 'uint256' },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'Approval',
    inputs: [
      { indexed: true, name: 'owner', type: 'address' },
      { indexed: true, name: 'spender', type: 'address' },
      { indexed: false, name: 'value', type: 'uint256' },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'FlashLoan',
    inputs: [
      { indexed: true, name: 'target', type: 'address' },
      { indexed: true, name: 'initiator', type: 'address' },
      { indexed: true, name: 'asset', type: 'address' },
      { indexed: false, name: 'amount', type: 'uint256' },
      { indexed: false, name: 'interestRateMode', type: 'uint8' },
      { indexed: false, name: 'premium', type: 'uint256' },
      { indexed: false, name: 'referralCode', type: 'uint16' },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'FlashLoan',
    inputs: [
      { indexed: true, name: 'recipient', type: 'address' },
      { indexed: true, name: 'token', type: 'address' },
      { indexed: false, name: 'amount', type: 'uint256' },
    ],
    anonymous: false,
  },
] as const;

const COMMON_FUNCTIONS_ABI = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'transferFrom',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

const COMMON_FLASH_LOAN_FUNCTIONS_ABI = [
  {
    type: 'function',
    name: 'flashLoanSimple',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'receiverAddress', type: 'address' },
      { name: 'asset', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'params', type: 'bytes' },
      { name: 'referralCode', type: 'uint16' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'flashLoan',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'receiverAddress', type: 'address' },
      { name: 'assets', type: 'address[]' },
      { name: 'amounts', type: 'uint256[]' },
      { name: 'interestRateModes', type: 'uint256[]' },
      { name: 'onBehalfOf', type: 'address' },
      { name: 'params', type: 'bytes' },
      { name: 'referralCode', type: 'uint16' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'flashLoan',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'receiver', type: 'address' },
      { name: 'token', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'data', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'flashLoan',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'recipient', type: 'address' },
      { name: 'tokens', type: 'address[]' },
      { name: 'amounts', type: 'uint256[]' },
      { name: 'userData', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'executeOperation',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'asset', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'premium', type: 'uint256' },
      { name: 'initiator', type: 'address' },
      { name: 'params', type: 'bytes' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'executeOperation',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'assets', type: 'address[]' },
      { name: 'amounts', type: 'uint256[]' },
      { name: 'premiums', type: 'uint256[]' },
      { name: 'initiator', type: 'address' },
      { name: 'params', type: 'bytes' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'onFlashLoan',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'initiator', type: 'address' },
      { name: 'token', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'fee', type: 'uint256' },
      { name: 'data', type: 'bytes' },
    ],
    outputs: [{ name: '', type: 'bytes32' }],
  },
] as const;

type StoredContractRow = {
  id: string;
  created_at: string;
  updated_at: string;
  chain_id: number | null;
  address: string | null;
  name: string;
  source: string;
  notes: string | null;
  abi_json: string;
};

type MessageRow = {
  id: string;
  created_at: string;
  host: string;
  path: string;
  request_body_json: string | null;
  response_body_json: string | null;
};

type ContractRuntime = {
  id: string;
  name: string;
  chainId: number | null;
  address: string | null;
  abi: ContractAbi;
};

type JsonRpcRequest = { id?: unknown; method?: unknown; params?: unknown };
type JsonRpcResponse = { id?: unknown; result?: unknown; error?: unknown };

type RpcPair = {
  request: JsonRpcRequest;
  response: JsonRpcResponse | null;
  requestIndex: number;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeParseJson(raw: string | null): unknown | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function normalizeAddress(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(trimmed)) return null;
  return trimmed.toLowerCase();
}

function parseChainId(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === 'bigint' && value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
    return Number(value);
  }
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (!v) return null;
  try {
    if (v.startsWith('0x') || v.startsWith('0X')) {
      const n = BigInt(v);
      if (n < 0n || n > BigInt(Number.MAX_SAFE_INTEGER)) return null;
      return Number(n);
    }
    const n = Number(v);
    if (Number.isInteger(n) && n >= 0) return n;
  } catch {
    return null;
  }
  return null;
}

function toJsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map((v) => toJsonSafe(v));
  if (isObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = toJsonSafe(v);
    return out;
  }
  return value;
}

function parseAbiFromRow(raw: string): ContractAbi {
  try {
    return UpsertContractRequestSchema.shape.abi.parse(JSON.parse(raw));
  } catch {
    return [];
  }
}

function mapSummary(row: StoredContractRow): ContractSummary {
  const abi = parseAbiFromRow(row.abi_json);
  return ContractSummarySchema.parse({
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    name: row.name,
    chainId: row.chain_id,
    address: row.address,
    source: row.source,
    notes: row.notes,
    abiItemCount: abi.length,
  });
}

function mapDetail(row: StoredContractRow): ContractDetail {
  const abi = parseAbiFromRow(row.abi_json);
  return ContractDetailSchema.parse({
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    name: row.name,
    chainId: row.chain_id,
    address: row.address,
    source: row.source,
    notes: row.notes,
    abiItemCount: abi.length,
    abi,
  });
}

function getStoredContractById(db: DatabaseSync, id: string): StoredContractRow | null {
  const row = db.prepare(`SELECT * FROM contract_abis WHERE id = ?`).get(id) as
    | StoredContractRow
    | undefined;
  return row ?? null;
}

function findContractIdByAddress(
  db: DatabaseSync,
  input: { chainId: number | null; address: string | null },
): string | null {
  if (!input.address) return null;
  const row = db
    .prepare(
      `
      SELECT id
      FROM contract_abis
      WHERE address = ?
        AND (
          (? IS NULL AND chain_id IS NULL)
          OR chain_id = ?
        )
      ORDER BY updated_at DESC
      LIMIT 1
    `,
    )
    .get(input.address, input.chainId, input.chainId) as { id: string } | undefined;
  return row?.id ?? null;
}

function listContractRuntime(db: DatabaseSync): ContractRuntime[] {
  const rows = db.prepare(`SELECT * FROM contract_abis`).all() as StoredContractRow[];
  return rows
    .map((row) => ({
      id: row.id,
      name: row.name,
      chainId: row.chain_id,
      address: row.address,
      abi: parseAbiFromRow(row.abi_json),
    }))
    .filter((row) => row.abi.length > 0);
}

function rpcIdKey(id: unknown): string | null {
  if (typeof id === 'string') return id;
  if (typeof id === 'number' && Number.isFinite(id)) return String(id);
  if (typeof id === 'bigint') return id.toString();
  return null;
}

function normalizeRequests(raw: unknown): JsonRpcRequest[] {
  const arr = Array.isArray(raw) ? raw : [raw];
  const out: JsonRpcRequest[] = [];
  for (const item of arr) {
    if (!isObject(item)) continue;
    if (typeof item.method !== 'string') continue;
    out.push(item as JsonRpcRequest);
  }
  return out;
}

function normalizeResponses(raw: unknown): JsonRpcResponse[] {
  const arr = Array.isArray(raw) ? raw : [raw];
  const out: JsonRpcResponse[] = [];
  for (const item of arr) {
    if (!isObject(item)) continue;
    out.push(item as JsonRpcResponse);
  }
  return out;
}

function pairRequestsAndResponses(requestBody: unknown, responseBody: unknown): RpcPair[] {
  const requests = normalizeRequests(requestBody);
  const responses = normalizeResponses(responseBody);
  const responseById = new Map<string, JsonRpcResponse>();
  responses.forEach((res) => {
    const key = rpcIdKey(res.id);
    if (key) responseById.set(key, res);
  });

  return requests.map((request, requestIndex) => {
    const byId = rpcIdKey(request.id);
    const matched =
      (byId ? responseById.get(byId) : undefined) ??
      (responses.length === 1 ? responses[0] : (responses[requestIndex] ?? null));

    return {
      request,
      response: matched ?? null,
      requestIndex,
    };
  });
}

function readCalldataFromParams(params: unknown): { to: string | null; data: string | null; chainId: number | null } {
  if (!Array.isArray(params) || params.length === 0) {
    return { to: null, data: null, chainId: null };
  }
  const tx = params[0];
  if (!isObject(tx)) return { to: null, data: null, chainId: null };

  const to = normalizeAddress(typeof tx.to === 'string' ? tx.to : null);
  const dataRaw =
    typeof tx.data === 'string'
      ? tx.data
      : typeof tx.input === 'string'
        ? tx.input
        : null;
  const data =
    typeof dataRaw === 'string' && /^0x[a-fA-F0-9]*$/.test(dataRaw) && dataRaw.length >= 10
      ? dataRaw.toLowerCase()
      : null;
  const chainId = parseChainId(tx.chainId);

  return { to, data, chainId };
}

function abiInputType(input: unknown): string {
  if (!isObject(input)) return 'unknown';
  const rawType = typeof input.type === 'string' ? input.type : 'unknown';
  if (!rawType.startsWith('tuple')) return rawType;
  const suffix = rawType.slice('tuple'.length);
  const components = Array.isArray(input.components) ? input.components : [];
  const inner = components.map((c) => abiInputType(c)).join(',');
  return `(${inner})${suffix}`;
}

function decodeArgs(functionItem: Record<string, unknown>, args: unknown[]): DecodedArg[] {
  const inputs = Array.isArray(functionItem.inputs) ? functionItem.inputs : [];
  return args.map((arg, index) => {
    const input = inputs[index];
    const inputObj = isObject(input) ? input : {};
    const name = typeof inputObj.name === 'string' && inputObj.name ? inputObj.name : `arg${index}`;
    const type = abiInputType(inputObj as AbiParameter);
    return { name, type, value: toJsonSafe(arg) };
  });
}

function isUint256Max(value: unknown): boolean {
  if (typeof value === 'bigint') return value === 2n ** 256n - 1n;
  if (typeof value === 'number') return Number.isFinite(value) && value === Number(UINT256_MAX);
  if (typeof value !== 'string') return false;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return false;
  try {
    if (trimmed.startsWith('0x')) {
      const n = BigInt(trimmed);
      return n === 2n ** 256n - 1n;
    }
    if (/^\d+$/.test(trimmed)) return BigInt(trimmed) === 2n ** 256n - 1n;
  } catch {
    return false;
  }
  return false;
}

function matchContracts(
  contracts: ContractRuntime[],
  input: { to: string | null; chainId: number | null },
): ContractRuntime[] {
  if (!input.to) return contracts;
  const exact = contracts.filter(
    (c) => c.address === input.to && (input.chainId == null || c.chainId === input.chainId),
  );
  if (exact.length > 0) return exact;
  const byAddress = contracts.filter((c) => c.address === input.to);
  if (byAddress.length > 0) return byAddress;
  return contracts;
}

function toAbi(value: ContractAbi): Abi {
  return value as unknown as Abi;
}

function tryDecodeWithFunctionItem(input: {
  data: string;
  functionItem: Record<string, unknown>;
}): { functionName: string; decodedArgs: DecodedArg[] } | null {
  try {
    const functionAbi = [input.functionItem] as unknown as Abi;
    const decoded = decodeFunctionData({
      abi: functionAbi,
      data: input.data as Hex,
    });
    const args = Array.isArray(decoded.args) ? decoded.args : [];
    const decodedArgs = decodeArgs(input.functionItem, args as unknown[]);
    return { functionName: decoded.functionName, decodedArgs };
  } catch {
    return null;
  }
}

function decodeFunctionFromContracts(input: {
  contracts: ContractRuntime[];
  to: string | null;
  chainId: number | null;
  data: string;
}): {
  contractId: string | null;
  contractName: string | null;
  functionName: string;
  decodedArgs: DecodedArg[];
} | null {
  const candidates = matchContracts(input.contracts, { to: input.to, chainId: input.chainId });
  for (const contract of candidates) {
    for (const abiItem of contract.abi) {
      if (!isObject(abiItem) || abiItem.type !== 'function') continue;
      const decoded = tryDecodeWithFunctionItem({
        data: input.data,
        functionItem: abiItem,
      });
      if (decoded) {
        return {
          contractId: contract.id,
          contractName: contract.name,
          functionName: decoded.functionName,
          decodedArgs: decoded.decodedArgs,
        };
      }
    }
  }

  for (const abiItem of COMMON_FUNCTIONS_ABI) {
    const decoded = tryDecodeWithFunctionItem({
      data: input.data,
      functionItem: abiItem as unknown as Record<string, unknown>,
    });
    if (decoded) {
      return {
        contractId: null,
        contractName: 'Generic ERC20',
        functionName: decoded.functionName,
        decodedArgs: decoded.decodedArgs,
      };
    }
  }

  for (const abiItem of COMMON_FLASH_LOAN_FUNCTIONS_ABI) {
    const decoded = tryDecodeWithFunctionItem({
      data: input.data,
      functionItem: abiItem as unknown as Record<string, unknown>,
    });
    if (decoded) {
      return {
        contractId: null,
        contractName: 'Generic Flash Loan Provider',
        functionName: decoded.functionName,
        decodedArgs: decoded.decodedArgs,
      };
    }
  }

  return null;
}

function extractTypedData(params: unknown): { signer: string | null; typedData: Record<string, unknown> | null } {
  const values = Array.isArray(params) ? params : [params];
  let signer: string | null = null;
  let typedData: Record<string, unknown> | null = null;

  for (const value of values) {
    if (typeof value === 'string') {
      const maybeAddress = normalizeAddress(value);
      if (maybeAddress) signer = maybeAddress;

      if (!typedData) {
        try {
          const parsed = JSON.parse(value) as unknown;
          if (
            isObject(parsed) &&
            (isObject(parsed.domain) || isObject(parsed.types) || isObject(parsed.message))
          ) {
            typedData = parsed;
          }
        } catch {
          // ignore
        }
      }
      continue;
    }

    if (
      isObject(value) &&
      (isObject(value.domain) || isObject(value.types) || isObject(value.message))
    ) {
      typedData = value;
    }
  }

  return { signer, typedData };
}

function collectRiskFields(
  value: unknown,
  out: Array<{ path: string; key: string; value: unknown }>,
  path: string[] = [],
) {
  if (Array.isArray(value)) {
    value.forEach((item, i) => collectRiskFields(item, out, [...path, String(i)]));
    return;
  }
  if (!isObject(value)) return;

  for (const [k, v] of Object.entries(value)) {
    const lowered = k.toLowerCase();
    const nextPath = [...path, k];
    const fieldPath = nextPath.join('.');
    if (
      lowered.includes('spender') ||
      lowered.includes('operator') ||
      lowered.includes('amount') ||
      lowered.includes('value') ||
      lowered.includes('deadline') ||
      lowered.includes('expiry') ||
      lowered.includes('expiration')
    ) {
      out.push({ path: fieldPath, key: lowered, value: v });
    }
    collectRiskFields(v, out, nextPath);
  }
}

function decodeReceiptLogs(
  response: JsonRpcResponse | null,
): { events: Array<Record<string, unknown>>; risks: string[] } {
  if (!response || !isObject(response.result)) return { events: [], risks: [] };
  const logs = Array.isArray(response.result.logs) ? response.result.logs : [];
  const events: Array<Record<string, unknown>> = [];
  const risks: string[] = [];

  for (const log of logs) {
    if (!isObject(log)) continue;
    const topics = Array.isArray(log.topics)
      ? log.topics.filter((t): t is Hex => typeof t === 'string' && t.startsWith('0x'))
      : [];
    if (topics.length === 0) continue;
    const data = typeof log.data === 'string' && log.data.startsWith('0x') ? (log.data as Hex) : null;
    if (!data) continue;
    try {
      const decoded = decodeEventLog({
        abi: toAbi(COMMON_EVENTS_ABI as unknown as ContractAbi),
        topics: [topics[0], ...topics.slice(1)] as [Hex, ...Hex[]],
        data,
      });
      const entry = {
        address: normalizeAddress(typeof log.address === 'string' ? log.address : null),
        eventName: decoded.eventName,
        args: toJsonSafe(decoded.args),
      };
      events.push(entry);
      if (decoded.eventName === 'Approval') {
        const val =
          isObject(decoded.args) && 'value' in decoded.args
            ? (decoded.args as Record<string, unknown>).value
            : null;
        if (isUint256Max(val)) {
          risks.push('Unlimited ERC20 approval detected in receipt log.');
        }
      }
      if (decoded.eventName === 'FlashLoan') {
        risks.push('Flash loan event detected in receipt log.');
      }
    } catch {
      // ignore non-matching logs
    }
  }

  return { events, risks };
}

function firstArgValue(args: DecodedArg[], keys: string[]): unknown {
  for (const key of keys) {
    const found = args.find((a) => a.name.toLowerCase() === key.toLowerCase());
    if (found) return found.value;
  }
  return null;
}

function isFlashLoanFunctionName(name: string | null | undefined): boolean {
  if (!name) return false;
  const normalized = name.toLowerCase();
  return (
    normalized === 'flashloan' ||
    normalized === 'flashloansimple' ||
    normalized === 'executeoperation' ||
    normalized === 'onflashloan'
  );
}

function decodeMessageRows(
  rows: MessageRow[],
  contracts: ContractRuntime[],
): ContractDecodedItem[] {
  const items: ContractDecodedItem[] = [];

  for (const row of rows) {
    const requestBody = safeParseJson(row.request_body_json);
    if (!requestBody) continue;
    const responseBody = safeParseJson(row.response_body_json);
    const pairs = pairRequestsAndResponses(requestBody, responseBody);

    for (const pair of pairs) {
      const method = typeof pair.request.method === 'string' ? pair.request.method : null;
      if (!method) continue;

      if (
        method === 'eth_sendTransaction' ||
        method === 'eth_call' ||
        method === 'eth_estimateGas'
      ) {
        const tx = readCalldataFromParams(pair.request.params);
        if (!tx.data) continue;

        const selector = tx.data.slice(0, 10);
        const decoded = decodeFunctionFromContracts({
          contracts,
          to: tx.to,
          chainId: tx.chainId,
          data: tx.data,
        });

        const risks: string[] = [];
        if (decoded?.functionName === 'approve') {
          const amount = firstArgValue(decoded.decodedArgs, ['amount', 'value']);
          if (isUint256Max(amount)) {
            risks.push('Unlimited approval amount detected.');
          }
        }
        if (isFlashLoanFunctionName(decoded?.functionName ?? null)) {
          risks.push('Flash loan interaction detected.');
        }

        const summary = decoded
          ? `${decoded.functionName} on ${decoded.contractName ?? tx.to ?? 'unknown target'}`
          : `${method} selector ${selector}`;

        items.push(
          ContractDecodedItemSchema.parse({
            id: `${row.id}:${pair.requestIndex}:tx`,
            messageId: row.id,
            requestIndex: pair.requestIndex,
            createdAt: row.created_at,
            host: row.host,
            path: row.path,
            rpcMethod: method,
            kind: 'transaction',
            chainId: tx.chainId,
            to: tx.to,
            selector,
            contractId: decoded?.contractId ?? null,
            contractName: decoded?.contractName ?? null,
            functionName: decoded?.functionName ?? null,
            summary,
            risks,
            decodedArgs: decoded?.decodedArgs ?? [],
            decoded: {
              transaction: toJsonSafe(
                Array.isArray(pair.request.params) && pair.request.params.length > 0
                  ? pair.request.params[0]
                  : null,
              ),
              response:
                pair.response?.result != null
                  ? toJsonSafe(pair.response.result)
                  : pair.response?.error != null
                    ? toJsonSafe(pair.response.error)
                    : null,
            },
          }),
        );
      } else if (
        method === 'eth_signTypedData' ||
        method === 'eth_signTypedData_v1' ||
        method === 'eth_signTypedData_v3' ||
        method === 'eth_signTypedData_v4'
      ) {
        const { signer, typedData } = extractTypedData(pair.request.params);
        if (!typedData) continue;

        const domain = isObject(typedData.domain) ? typedData.domain : {};
        const message = typedData.message;
        const primaryType = typeof typedData.primaryType === 'string' ? typedData.primaryType : null;
        const verifyingContract = normalizeAddress(
          typeof domain.verifyingContract === 'string' ? domain.verifyingContract : null,
        );
        const chainId = parseChainId(domain.chainId);

        const risks: string[] = [];
        if (verifyingContract) {
          risks.push(`verifyingContract: ${verifyingContract}`);
        }
        if (chainId != null) {
          risks.push(`chainId: ${chainId}`);
        }

        const riskyFields: Array<{ path: string; key: string; value: unknown }> = [];
        collectRiskFields(message, riskyFields);
        for (const field of riskyFields) {
          if (field.key.includes('spender') || field.key.includes('operator')) {
            risks.push(`spender field: ${field.path}`);
          } else if (field.key.includes('deadline') || field.key.includes('expiry') || field.key.includes('expiration')) {
            risks.push(`deadline field: ${field.path}`);
          } else if (field.key.includes('amount') || field.key.includes('value')) {
            risks.push(`amount/value field: ${field.path}`);
            if (isUint256Max(field.value)) {
              risks.push(`potential unlimited amount at ${field.path}`);
            }
          }
        }

        items.push(
          ContractDecodedItemSchema.parse({
            id: `${row.id}:${pair.requestIndex}:typed`,
            messageId: row.id,
            requestIndex: pair.requestIndex,
            createdAt: row.created_at,
            host: row.host,
            path: row.path,
            rpcMethod: method,
            kind: 'typed_data',
            chainId,
            to: verifyingContract,
            selector: null,
            contractId: null,
            contractName: null,
            functionName: primaryType,
            summary: `${primaryType ?? 'Typed data'} signature request`,
            risks,
            decodedArgs: [],
            decoded: toJsonSafe({ signer, typedData }),
          }),
        );
      } else if (method === 'eth_getTransactionReceipt') {
        const decoded = decodeReceiptLogs(pair.response);
        if (decoded.events.length === 0) continue;
        items.push(
          ContractDecodedItemSchema.parse({
            id: `${row.id}:${pair.requestIndex}:logs`,
            messageId: row.id,
            requestIndex: pair.requestIndex,
            createdAt: row.created_at,
            host: row.host,
            path: row.path,
            rpcMethod: method,
            kind: 'logs',
            chainId: null,
            to: null,
            selector: null,
            contractId: null,
            contractName: null,
            functionName:
              typeof decoded.events[0]?.eventName === 'string'
                ? decoded.events[0].eventName
                : null,
            summary: `${decoded.events.length} decoded log(s)`,
            risks: decoded.risks,
            decodedArgs: [],
            decoded: toJsonSafe({
              txHash:
                pair.response && isObject(pair.response.result) && typeof pair.response.result.transactionHash === 'string'
                  ? pair.response.result.transactionHash
                  : null,
              events: decoded.events,
            }),
          }),
        );
      }
    }
  }

  return items;
}

export function listContracts(db: DatabaseSync): ContractSummary[] {
  const rows = db
    .prepare(`SELECT * FROM contract_abis ORDER BY updated_at DESC`)
    .all() as StoredContractRow[];
  return rows.map((row) => mapSummary(row));
}

export function getContract(db: DatabaseSync, id: string): ContractDetail | null {
  const row = getStoredContractById(db, id);
  if (!row) return null;
  return mapDetail(row);
}

export function upsertContract(db: DatabaseSync, input: UpsertContractRequest): ContractDetail {
  const parsed = UpsertContractRequestSchema.parse(input);
  const now = new Date().toISOString();
  const chainId = parsed.chainId ?? null;
  const address = normalizeAddress(parsed.address ?? null);
  const existingId =
    parsed.id ?? findContractIdByAddress(db, { chainId, address }) ?? randomUUID();
  const existing = getStoredContractById(db, existingId);

  if (existing) {
    db.prepare(
      `
      UPDATE contract_abis
      SET
        updated_at = ?,
        chain_id = ?,
        address = ?,
        name = ?,
        source = ?,
        notes = ?,
        abi_json = ?
      WHERE id = ?
    `,
    ).run(
      now,
      chainId,
      address,
      parsed.name.trim(),
      parsed.source?.trim() || 'manual',
      parsed.notes ?? null,
      JSON.stringify(parsed.abi),
      existingId,
    );
  } else {
    db.prepare(
      `
      INSERT INTO contract_abis (
        id, created_at, updated_at, chain_id, address, name, source, notes, abi_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      existingId,
      now,
      now,
      chainId,
      address,
      parsed.name.trim(),
      parsed.source?.trim() || 'manual',
      parsed.notes ?? null,
      JSON.stringify(parsed.abi),
    );
  }

  const out = getContract(db, existingId);
  if (!out) {
    throw new Error('Failed to persist contract ABI.');
  }
  return out;
}

export function deleteContract(db: DatabaseSync, id: string): boolean {
  const result = db.prepare(`DELETE FROM contract_abis WHERE id = ?`).run(id) as { changes?: number };
  return (result.changes ?? 0) > 0;
}

export function listDecodedContracts(
  db: DatabaseSync,
  input: { limit: number; offset: number },
): ContractDecodedItem[] {
  const rows = db
    .prepare(
      `
      SELECT id, created_at, host, path, request_body_json, response_body_json
      FROM http_messages
      WHERE request_body_json IS NOT NULL
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `,
    )
    .all(input.limit, input.offset) as MessageRow[];
  const contracts = listContractRuntime(db);
  return decodeMessageRows(rows, contracts);
}
