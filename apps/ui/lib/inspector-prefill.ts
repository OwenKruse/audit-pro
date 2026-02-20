export type ContractInspectorPrefill = {
  address: string;
  chainId: number | null;
  name: string | null;
  notes: string | null;
  source: string | null;
  abiJson: string | null;
  createdAt: string;
};

const STORAGE_KEY = 'cipherscope.inspector.prefill.v1';

function hasWindow(): boolean {
  return typeof window !== 'undefined';
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

function remove(key: string): void {
  if (!hasWindow()) return;
  window.localStorage.removeItem(key);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function isHexAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

function parsePrefill(raw: unknown): ContractInspectorPrefill | null {
  const rec = asRecord(raw);
  if (!rec) return null;

  const address = asString(rec.address);
  if (!address || !isHexAddress(address)) return null;

  const chainId = asNumber(rec.chainId);
  const name = asString(rec.name);
  const notes = asString(rec.notes);
  const source = asString(rec.source);
  const abiJson = asString(rec.abiJson);
  const createdAt = asString(rec.createdAt) ?? new Date().toISOString();

  return {
    address,
    chainId: chainId != null ? Math.trunc(chainId) : null,
    name,
    notes,
    source,
    abiJson: abiJson ?? null,
    createdAt,
  };
}

export function saveContractInspectorPrefill(
  input: ContractInspectorPrefill,
): ContractInspectorPrefill {
  const parsed = parsePrefill(input);
  if (!parsed) {
    throw new Error('Invalid inspector prefill payload.');
  }
  writeJson(STORAGE_KEY, parsed);
  return parsed;
}

export function consumeContractInspectorPrefill(): ContractInspectorPrefill | null {
  const parsed = parsePrefill(readJson<unknown>(STORAGE_KEY));
  remove(STORAGE_KEY);
  return parsed;
}

