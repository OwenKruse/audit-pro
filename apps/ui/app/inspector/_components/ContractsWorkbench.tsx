'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ContractDecodedItem, ContractDetail, ContractSummary } from '@cipherscope/proto';
import { encodeFunctionData, type Abi } from 'viem';
import { Badge } from '@/components/ui/badge';
import { saveContractSandboxPrefill, type ContractSandboxPrefill } from '@/lib/foundry-store';
import { consumeContractInspectorPrefill } from '@/lib/inspector-prefill';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { HorizontalResizable } from '../../_components/HorizontalResizable';

type FormState = {
  id: string | null;
  name: string;
  chainId: string;
  address: string;
  source: string;
  notes: string;
  abiJson: string;
};

type DecodedKindFilter = 'all' | ContractDecodedItem['kind'];
type DecodedRiskFilter = 'all' | 'with_risks';

type AbiInput = {
  name: string;
  type: string;
  components: AbiInput[];
  indexed: boolean;
};

type AbiFunction = {
  type: 'function';
  name: string;
  stateMutability: string;
  inputs: AbiInput[];
  outputs: AbiInput[];
};

type AbiEvent = {
  type: 'event';
  name: string;
  inputs: AbiInput[];
  anonymous: boolean;
};

type ContractMethodKind = 'read' | 'write';

const EMPTY_FORM: FormState = {
  id: null,
  name: '',
  chainId: '',
  address: '',
  source: 'manual',
  notes: '',
  abiJson: '',
};

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

function short(value: string | null | undefined, max = 18): string {
  if (!value) return '-';
  if (value.length <= max) return value;
  return `${value.slice(0, max - 3)}...`;
}

function kindLabel(kind: ContractDecodedItem['kind']): string {
  if (kind === 'typed_data') return 'typed data';
  return kind;
}

function fmtTime(v: string): string {
  return new Date(v).toLocaleString();
}

function stringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asOptionalString(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  return null;
}

function asOptionalRpcString(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return asOptionalString(value);
}

function asOptionalBool(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  return null;
}

function parseAbiInput(value: unknown): AbiInput | null {
  const obj = asRecord(value);
  if (!obj) return null;
  const type = asOptionalString(obj.type);
  if (!type) return null;
  const name = asOptionalString(obj.name) ?? '';
  const componentsRaw = Array.isArray(obj.components) ? obj.components : [];
  const components = componentsRaw
    .map((entry) => parseAbiInput(entry))
    .filter((entry): entry is AbiInput => entry !== null);
  return {
    name,
    type,
    components,
    indexed: asOptionalBool(obj.indexed) ?? false,
  };
}

function parseAbiFunction(value: unknown): AbiFunction | null {
  const obj = asRecord(value);
  if (!obj || obj.type !== 'function') return null;
  const name = asOptionalString(obj.name);
  if (!name) return null;
  const stateMutability = asOptionalString(obj.stateMutability) ?? 'nonpayable';
  const inputsRaw = Array.isArray(obj.inputs) ? obj.inputs : [];
  const outputsRaw = Array.isArray(obj.outputs) ? obj.outputs : [];
  const inputs = inputsRaw
    .map((entry) => parseAbiInput(entry))
    .filter((entry): entry is AbiInput => entry !== null);
  const outputs = outputsRaw
    .map((entry) => parseAbiInput(entry))
    .filter((entry): entry is AbiInput => entry !== null);
  return {
    type: 'function',
    name,
    stateMutability,
    inputs,
    outputs,
  };
}

function parseAbiEvent(value: unknown): AbiEvent | null {
  const obj = asRecord(value);
  if (!obj || obj.type !== 'event') return null;
  const name = asOptionalString(obj.name);
  if (!name) return null;
  const inputsRaw = Array.isArray(obj.inputs) ? obj.inputs : [];
  const inputs = inputsRaw
    .map((entry) => parseAbiInput(entry))
    .filter((entry): entry is AbiInput => entry !== null);
  return {
    type: 'event',
    name,
    inputs,
    anonymous: asOptionalBool(obj.anonymous) ?? false,
  };
}

function parseContractAbi(abi: unknown[]): {
  readMethods: AbiFunction[];
  writeMethods: AbiFunction[];
  events: AbiEvent[];
} {
  const readMethods: AbiFunction[] = [];
  const writeMethods: AbiFunction[] = [];
  const events: AbiEvent[] = [];

  for (const entry of abi) {
    const fn = parseAbiFunction(entry);
    if (fn) {
      if (fn.stateMutability === 'view' || fn.stateMutability === 'pure') {
        readMethods.push(fn);
      } else {
        writeMethods.push(fn);
      }
      continue;
    }
    const event = parseAbiEvent(entry);
    if (event) events.push(event);
  }

  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  readMethods.sort(byName);
  writeMethods.sort(byName);
  events.sort(byName);
  return { readMethods, writeMethods, events };
}

function paramLabel(input: AbiInput, index: number): string {
  const name = input.name || `arg${index}`;
  return `${name}: ${input.type}`;
}

function methodSignature(method: AbiFunction): string {
  const args = method.inputs.map((input) => input.type).join(', ');
  return `${method.name}(${args})`;
}

function methodRowKey(method: AbiFunction): string {
  return methodSignature(method);
}

function eventSignature(event: AbiEvent): string {
  const args = event.inputs
    .map((input, idx) => `${input.indexed ? 'indexed ' : ''}${paramLabel(input, idx)}`)
    .join(', ');
  return `${event.name}(${args})`;
}

function parsePrimitiveForAbi(value: unknown, type: string, path: string): unknown {
  if (type === 'bool') {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (normalized === 'true' || normalized === '1') return true;
      if (normalized === 'false' || normalized === '0') return false;
    }
    throw new Error(`${path} must be a boolean (true/false).`);
  }

  if (type.startsWith('uint') || type.startsWith('int')) {
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)) {
      return BigInt(value);
    }
    if (typeof value === 'string' && value.trim()) {
      try {
        return BigInt(value.trim());
      } catch {
        throw new Error(`${path} must be an integer or hex quantity.`);
      }
    }
    throw new Error(`${path} must be an integer.`);
  }

  if (type === 'string') {
    if (typeof value !== 'string') {
      throw new Error(`${path} must be a string.`);
    }
    return value;
  }

  if (type === 'address' || type === 'function' || type === 'bytes' || /^bytes\d+$/.test(type)) {
    if (typeof value !== 'string') {
      throw new Error(`${path} must be a string.`);
    }
    return value.trim();
  }

  return value;
}

function parseTypedAbiValue(raw: unknown, input: AbiInput, path: string): unknown {
  const arrayMatch = input.type.match(/^(.*)\[(\d*)\]$/);
  if (arrayMatch) {
    const innerType = arrayMatch[1] ?? '';
    const expectedSize = arrayMatch[2] ? Number.parseInt(arrayMatch[2], 10) : null;
    let values: unknown[];
    if (Array.isArray(raw)) {
      values = raw;
    } else if (typeof raw === 'string') {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error(`${path} must be a JSON array.`);
      }
      if (!Array.isArray(parsed)) throw new Error(`${path} must be a JSON array.`);
      values = parsed;
    } else {
      throw new Error(`${path} must be a JSON array.`);
    }
    if (expectedSize != null && values.length !== expectedSize) {
      throw new Error(`${path} must contain exactly ${expectedSize} value(s).`);
    }
    const innerInput: AbiInput = { ...input, type: innerType };
    return values.map((entry, idx) => parseTypedAbiValue(entry, innerInput, `${path}[${idx}]`));
  }

  if (input.type === 'tuple') {
    const components = input.components;
    let tupleValue: unknown = raw;
    if (typeof raw === 'string') {
      try {
        tupleValue = JSON.parse(raw);
      } catch {
        throw new Error(`${path} must be JSON for tuple arguments.`);
      }
    }

    if (Array.isArray(tupleValue)) {
      if (tupleValue.length !== components.length) {
        throw new Error(`${path} tuple requires ${components.length} value(s).`);
      }
      return tupleValue.map((entry, idx) =>
        parseTypedAbiValue(
          entry,
          components[idx] as AbiInput,
          `${path}.${components[idx]?.name || idx}`,
        ),
      );
    }

    if (!tupleValue || typeof tupleValue !== 'object') {
      throw new Error(`${path} must be a JSON object or array for tuple arguments.`);
    }

    const obj = tupleValue as Record<string, unknown>;
    return components.map((component, idx) => {
      const namedValue = component.name ? obj[component.name] : undefined;
      const indexedValue = obj[String(idx)];
      const nextValue = namedValue !== undefined ? namedValue : indexedValue;
      if (nextValue === undefined) {
        throw new Error(`${path} is missing tuple field "${component.name || idx}".`);
      }
      return parseTypedAbiValue(nextValue, component, `${path}.${component.name || idx}`);
    });
  }

  return parsePrimitiveForAbi(raw, input.type, path);
}

function parseMethodArgs(method: AbiFunction, rawValues: string[]): unknown[] {
  return method.inputs.map((input, index) => {
    const raw = rawValues[index] ?? '';
    const value = input.type === 'string' ? raw : raw.trim();
    const label = `${input.name || `arg${index}`}: ${input.type}`;
    if (value === '' && input.type !== 'string') {
      throw new Error(`Missing value for ${label}.`);
    }
    return parseTypedAbiValue(value, input, label);
  });
}

function txMethodToSimulateOnly(method: string): boolean {
  const normalized = method.toLowerCase();
  return normalized === 'eth_call' || normalized === 'eth_estimategas';
}

function errorMessageFromResponse(payload: unknown, fallback: string): string {
  const obj = asRecord(payload);
  const error = asRecord(obj?.error);
  const message = asOptionalString(error?.message);
  return message ?? fallback;
}

function buildSandboxPrefill(item: ContractDecodedItem): ContractSandboxPrefill | null {
  if (item.kind !== 'transaction') return null;
  const decoded = asRecord(item.decoded);
  const tx = decoded ? asRecord(decoded.transaction) : null;
  const to = asOptionalString(tx?.to) ?? item.to;
  if (!to) return null;

  return {
    sourceInteractionId: item.id,
    method: item.rpcMethod,
    from: asOptionalString(tx?.from),
    to,
    data: asOptionalString(tx?.data) ?? '0x',
    value: asOptionalRpcString(tx?.value),
    gas: asOptionalRpcString(tx?.gas),
    simulateOnly: txMethodToSimulateOnly(item.rpcMethod),
    abiJson: null,
    label: null,
    createdAt: new Date().toISOString(),
  };
}

function extractTypedData(decoded: unknown): {
  signer: string | null;
  primaryType: string | null;
  domain: Record<string, unknown> | null;
  message: unknown;
  types: Record<string, unknown> | null;
} | null {
  const root = asRecord(decoded);
  if (!root) return null;
  const typedData = asRecord(root.typedData);
  if (!typedData) return null;
  return {
    signer: asOptionalString(root.signer),
    primaryType: asOptionalString(typedData.primaryType),
    domain: asRecord(typedData.domain),
    message: typedData.message ?? null,
    types: asRecord(typedData.types),
  };
}

function extractLogEvents(decoded: unknown): unknown[] {
  const root = asRecord(decoded);
  if (!root || !Array.isArray(root.events)) return [];
  return root.events;
}

export function ContractsWorkbench(props: { initialSelectedContractId?: string | null } = {}) {
  const router = useRouter();
  const initialContractId = (props.initialSelectedContractId ?? '').trim() || null;
  const initialContractApplied = useRef(false);
  const [autoSelectContract, setAutoSelectContract] = useState(true);
  const [contracts, setContracts] = useState<ContractSummary[]>([]);
  const [decodedItems, setDecodedItems] = useState<ContractDecodedItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [submitState, setSubmitState] = useState<{ ok: boolean; message: string } | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [selectedContractId, setSelectedContractId] = useState<string | null>(initialContractId);
  const [selectedContract, setSelectedContract] = useState<ContractDetail | null>(null);
  const [contractLoading, setContractLoading] = useState(false);
  const [contractError, setContractError] = useState<string | null>(null);
  const [contractMethodInputs, setContractMethodInputs] = useState<Record<string, string[]>>({});
  const [contractActionState, setContractActionState] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);
  const [decodedSearch, setDecodedSearch] = useState('');
  const [kindFilter, setKindFilter] = useState<DecodedKindFilter>('all');
  const [riskFilter, setRiskFilter] = useState<DecodedRiskFilter>('all');
  const [selectedDecodedId, setSelectedDecodedId] = useState<string | null>(null);
  const [actionState, setActionState] = useState<{ ok: boolean; message: string } | null>(null);
  const [sourcifyFetching, setSourcifyFetching] = useState(false);
  const [sourcifyError, setSourcifyError] = useState<string | null>(null);

  const loadFormFromContract = useCallback((contract: ContractDetail) => {
    setForm({
      id: contract.id,
      name: contract.name,
      chainId: String(contract.chainId ?? 1),
      address: contract.address ?? '',
      source: contract.source || 'manual',
      notes: contract.notes ?? '',
      abiJson: stringify(contract.abi),
    });
  }, []);

  const onSelectContractRow = useCallback(
    (id: string) => {
      if (id === selectedContractId) {
        // Allow re-clicking the selected row to re-sync the form (e.g. after Reset).
        if (selectedContract && selectedContract.id === id) {
          loadFormFromContract(selectedContract);
        }
        return;
      }
      setAutoSelectContract(true);
      setSelectedContractId(id);
    },
    [loadFormFromContract, selectedContract, selectedContractId],
  );

  const filteredDecoded = useMemo(() => {
    let out = decodedItems;

    if (kindFilter !== 'all') {
      out = out.filter((item) => item.kind === kindFilter);
    }
    if (riskFilter === 'with_risks') {
      out = out.filter((item) => item.risks.length > 0);
    }
    if (decodedSearch.trim()) {
      const query = decodedSearch.trim().toLowerCase();
      out = out.filter((item) =>
        [
          item.rpcMethod,
          item.summary,
          item.contractName ?? '',
          item.functionName ?? '',
          item.selector ?? '',
          item.to ?? '',
          item.host,
          item.path,
          item.messageId,
          ...item.risks,
        ]
          .join(' ')
          .toLowerCase()
          .includes(query),
      );
    }

    return out;
  }, [decodedItems, decodedSearch, kindFilter, riskFilter]);

  const selectedContractAbi = useMemo(
    () =>
      selectedContract
        ? parseContractAbi(Array.isArray(selectedContract.abi) ? selectedContract.abi : [])
        : { readMethods: [], writeMethods: [], events: [] },
    [selectedContract],
  );

  useEffect(() => {
    if (initialContractId) return;
    const prefill = consumeContractInspectorPrefill();
    if (!prefill) return;

    setAutoSelectContract(false);
    setSelectedContractId(null);
    setSelectedContract(null);
    setContractError(null);
    setContractActionState(null);
    setActionState(null);

    setForm({
      ...EMPTY_FORM,
      name: prefill.name ?? '',
      chainId: prefill.chainId != null ? String(prefill.chainId) : '',
      address: prefill.address,
      source: (prefill.source ?? '').trim() || 'manual',
      notes: prefill.notes ?? '',
      abiJson: prefill.abiJson ?? '',
    });
    setSubmitState({
      ok: true,
      message: prefill.abiJson
        ? 'Prefilled from DEX Explorer. Click Save ABI Entry.'
        : 'Prefilled from Explorer. Paste ABI JSON then click Save ABI Entry.',
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (initialContractApplied.current) return;
    if (!initialContractId) {
      initialContractApplied.current = true;
      return;
    }
    if (contracts.length === 0) return;
    if (contracts.some((c) => c.id === initialContractId)) {
      setSelectedContractId(initialContractId);
    }
    initialContractApplied.current = true;
  }, [contracts, initialContractId]);

  useEffect(() => {
    if (!autoSelectContract) return;
    if (initialContractId && !initialContractApplied.current) return;
    if (contracts.length === 0) {
      setSelectedContractId(null);
      setSelectedContract(null);
      return;
    }
    if (!selectedContractId || !contracts.some((item) => item.id === selectedContractId)) {
      setSelectedContractId(contracts[0]?.id ?? null);
    }
  }, [autoSelectContract, contracts, selectedContractId, initialContractId]);

  useEffect(() => {
    setContractActionState(null);
    setContractError(null);
    setContractMethodInputs({});
  }, [selectedContractId]);

  useEffect(() => {
    if (!selectedContractId) {
      setSelectedContract(null);
      return;
    }

    let active = true;
    const run = async () => {
      setContractLoading(true);
      try {
        const res = await fetch(`/api/contracts/${encodeURIComponent(selectedContractId)}`, {
          cache: 'no-store',
        });
        const json = await res.json().catch(() => null);
        if (!res.ok || !json?.ok) {
          throw new Error(errorMessageFromResponse(json, 'Failed to load contract detail.'));
        }
        if (!active) return;
        setSelectedContract((json.item as ContractDetail) ?? null);
      } catch (err) {
        if (!active) return;
        setSelectedContract(null);
        setContractError(
          err instanceof Error ? err.message : 'Failed to load selected contract details.',
        );
      } finally {
        if (active) setContractLoading(false);
      }
    };

    void run();
    return () => {
      active = false;
    };
  }, [selectedContractId]);

  useEffect(() => {
    if (!selectedContract) return;
    loadFormFromContract(selectedContract);
  }, [loadFormFromContract, selectedContract]);

  useEffect(() => {
    if (filteredDecoded.length === 0) {
      setSelectedDecodedId(null);
      return;
    }
    if (!selectedDecodedId || !filteredDecoded.some((item) => item.id === selectedDecodedId)) {
      setSelectedDecodedId(filteredDecoded[0].id);
    }
  }, [filteredDecoded, selectedDecodedId]);

  const selectedDecoded = useMemo(
    () => filteredDecoded.find((d) => d.id === selectedDecodedId) ?? null,
    [filteredDecoded, selectedDecodedId],
  );

  const selectedPrefill = useMemo(
    () => (selectedDecoded ? buildSandboxPrefill(selectedDecoded) : null),
    [selectedDecoded],
  );

  const selectedTypedData = useMemo(
    () => (selectedDecoded ? extractTypedData(selectedDecoded.decoded) : null),
    [selectedDecoded],
  );

  const selectedLogEvents = useMemo(
    () => (selectedDecoded ? extractLogEvents(selectedDecoded.decoded) : []),
    [selectedDecoded],
  );

  useEffect(() => {
    setActionState(null);
  }, [selectedDecodedId]);

  async function loadData(showSpinner: boolean) {
    if (showSpinner) setLoading(true);
    else setRefreshing(true);
    setError(null);
    try {
      const [contractsRes, decodedRes] = await Promise.all([
        fetch('/api/contracts', { cache: 'no-store' }),
        fetch('/api/contracts/decoded?limit=400&offset=0', { cache: 'no-store' }),
      ]);

      const [contractsJson, decodedJson] = await Promise.all([
        contractsRes.json().catch(() => null),
        decodedRes.json().catch(() => null),
      ]);

      if (!contractsRes.ok || !contractsJson?.ok) {
        throw new Error(errorMessageFromResponse(contractsJson, 'Failed to load contracts.'));
      }
      if (!decodedRes.ok || !decodedJson?.ok) {
        throw new Error(errorMessageFromResponse(decodedJson, 'Failed to load decoded messages.'));
      }

      setContracts(contractsJson.items as ContractSummary[]);
      setDecodedItems(decodedJson.items as ContractDecodedItem[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load contracts.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    void loadData(true);
  }, []);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSubmitState(null);

    const name = form.name.trim();
    if (!name) {
      setSubmitState({ ok: false, message: 'Name is required.' });
      return;
    }

    let abi: unknown;
    try {
      abi = JSON.parse(form.abiJson);
    } catch {
      setSubmitState({ ok: false, message: 'ABI JSON is not valid JSON.' });
      return;
    }

    if (!Array.isArray(abi) || abi.length === 0) {
      setSubmitState({ ok: false, message: 'ABI JSON must be a non-empty array.' });
      return;
    }

    // Default to Ethereum mainnet when chain id is omitted.
    let chainId = 1;
    if (form.chainId.trim()) {
      const raw = Number(form.chainId.trim());
      if (!Number.isInteger(raw) || raw < 0) {
        setSubmitState({ ok: false, message: 'Chain ID must be a non-negative integer.' });
        return;
      }
      chainId = raw;
    }

    const address = form.address.trim();
    if (address && !ADDRESS_RE.test(address)) {
      setSubmitState({
        ok: false,
        message: 'Address must be a 0x-prefixed 20-byte hex string.',
      });
      return;
    }

    const payload = {
      ...(form.id ? { id: form.id } : {}),
      name,
      chainId,
      address: address || null,
      source: form.source.trim() || 'manual',
      notes: form.notes.trim() ? form.notes.trim() : null,
      abi,
    };

    try {
      const res = await fetch('/api/contracts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.ok) {
        throw new Error(errorMessageFromResponse(json, 'Failed to save ABI.'));
      }
      setSubmitState({ ok: true, message: 'Contract ABI saved.' });
      const saved = (json.item as ContractDetail | undefined) ?? undefined;
      if (saved) {
        setSelectedContractId(saved.id);
        setSelectedContract(saved);
        loadFormFromContract(saved);
      } else {
        setForm(EMPTY_FORM);
      }
      await loadData(false);
    } catch (err) {
      setSubmitState({
        ok: false,
        message: err instanceof Error ? err.message : 'Failed to save ABI.',
      });
    }
  }

  async function onDeleteContract(id: string) {
    if (!window.confirm('Delete this contract ABI from the local vault?')) return;
    setDeletingId(id);
    try {
      const res = await fetch(`/api/contracts/${encodeURIComponent(id)}`, { method: 'DELETE' });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.ok) {
        throw new Error(errorMessageFromResponse(json, 'Failed to delete contract.'));
      }
      await loadData(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete contract.');
    } finally {
      setDeletingId(null);
    }
  }

  async function onLoadAbiFile(file: File | null) {
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed) || parsed.length === 0) {
        setSubmitState({
          ok: false,
          message: `${file.name} must contain a non-empty ABI array.`,
        });
        return;
      }
      setForm((prev) => ({ ...prev, abiJson: JSON.stringify(parsed, null, 2) }));
      setSubmitState({ ok: true, message: `Loaded ABI from ${file.name}.` });
    } catch {
      setSubmitState({ ok: false, message: `${file.name} is not valid JSON.` });
    }
  }

  async function onFetchFromSourcify() {
    const chainId = form.chainId.trim();
    const address = form.address.trim();
    if (!chainId || !address || !ADDRESS_RE.test(address)) return;
    setSourcifyFetching(true);
    setSourcifyError(null);
    try {
      const res = await fetch(
        `/api/sourcify/fetch?chainId=${encodeURIComponent(chainId)}&address=${encodeURIComponent(address)}`,
        { cache: 'no-store' },
      );
      const json = (await res.json().catch(() => null)) as
        | { ok: true; abi: unknown[] }
        | { ok: false; error: { code: string; message: string } }
        | null;
      if (!json || !json.ok || !Array.isArray(json.abi) || json.abi.length === 0) {
        const msg =
          json && !json.ok && json.error?.message
            ? json.error.message
            : 'Failed to fetch from Sourcify.';
        setSourcifyError(msg);
        return;
      }
      setForm((prev) => ({ ...prev, abiJson: JSON.stringify(json.abi, null, 2) }));
      setSubmitState({ ok: true, message: 'ABI fetched from Sourcify.' });
    } catch {
      setSourcifyError('Failed to fetch from Sourcify.');
    } finally {
      setSourcifyFetching(false);
    }
  }

  function onContractMethodInputChange(methodKey: string, index: number, value: string) {
    setContractMethodInputs((prev) => {
      const next = [...(prev[methodKey] ?? [])];
      next[index] = value;
      return { ...prev, [methodKey]: next };
    });
  }

  function onSendMethodToSandbox(method: AbiFunction, kind: ContractMethodKind) {
    if (!selectedContract) {
      setContractActionState({ ok: false, message: 'No contract is selected.' });
      return;
    }
    if (!selectedContract.address) {
      setContractActionState({
        ok: false,
        message: 'Selected contract has no address. Add an address to send sandbox interactions.',
      });
      return;
    }

    try {
      const key = methodRowKey(method);
      const rawValues = contractMethodInputs[key] ?? [];
      const args = parseMethodArgs(method, rawValues);
      const methodAbi = method as unknown as Abi[number];
      const data = encodeFunctionData({
        abi: [methodAbi] as Abi,
        functionName: method.name,
        args,
      });

      const prefill: ContractSandboxPrefill = {
        sourceInteractionId: `contract:${selectedContract.id}:${key}`,
        method: kind === 'read' ? 'eth_call' : 'eth_sendTransaction',
        from: null,
        to: selectedContract.address,
        data,
        value: null,
        gas: null,
        simulateOnly: kind === 'read',
        abiJson: stringify(selectedContract.abi),
        label: `${selectedContract.name}.${key}`,
        createdAt: new Date().toISOString(),
      };
      saveContractSandboxPrefill(prefill);
      router.push('/');
    } catch (err) {
      setContractActionState({
        ok: false,
        message: err instanceof Error ? err.message : 'Failed to encode method call.',
      });
    }
  }

  function onSendToSandbox() {
    if (!selectedDecoded || !selectedPrefill) {
      setActionState({
        ok: false,
        message: 'Selected interaction does not include transaction calldata.',
      });
      return;
    }
    try {
      saveContractSandboxPrefill(selectedPrefill);
      router.push('/');
    } catch (err) {
      setActionState({
        ok: false,
        message: err instanceof Error ? err.message : 'Failed to send interaction to sandbox.',
      });
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-[color:var(--cs-panel)]">
      {error ? (
        <div className="border-b border-[color:var(--cs-border)] bg-rose-50 px-3 py-2 text-[12px] text-rose-700">
          {error}
        </div>
      ) : null}

      <section className="grid grid-cols-1 border-b border-[color:var(--cs-border)] xl:grid-cols-[1fr_1fr]">
        <div className="flex flex-col border-r border-[color:var(--cs-border)]">
          <div className="border-b border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-3 py-1.5">
            <h3 className="text-[11px] font-bold uppercase tracking-wider text-[color:var(--cs-fg)]">
              ABI Vault
            </h3>
          </div>
          <div className="p-3">
            <form className="flex flex-col gap-3" onSubmit={onSubmit}>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Name">
                  <input
                    type="text"
                    placeholder="ERC20 Token"
                    value={form.name}
                    onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
                    className="h-8 w-full rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 text-[13px] outline-none focus:border-[color:var(--cs-accent)]"
                  />
                </Field>
                <Field label="Chain ID">
                  <input
                    type="text"
                    inputMode="numeric"
                    placeholder="1"
                    value={form.chainId}
                    onChange={(e) => setForm((prev) => ({ ...prev, chainId: e.target.value }))}
                    className="h-8 w-full rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 text-[13px] outline-none focus:border-[color:var(--cs-accent)]"
                  />
                </Field>
                <Field label="Address">
                  <input
                    type="text"
                    placeholder="0x..."
                    value={form.address}
                    onChange={(e) => setForm((prev) => ({ ...prev, address: e.target.value }))}
                    className="h-8 w-full rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 text-[13px] outline-none focus:border-[color:var(--cs-accent)]"
                  />
                </Field>
                <Field label="Source">
                  <input
                    type="text"
                    placeholder="manual"
                    value={form.source}
                    onChange={(e) => setForm((prev) => ({ ...prev, source: e.target.value }))}
                    className="h-8 w-full rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 text-[13px] outline-none focus:border-[color:var(--cs-accent)]"
                  />
                </Field>
              </div>

              <Field label="Notes">
                <input
                  type="text"
                  placeholder="Optional context about this ABI entry"
                  value={form.notes}
                  onChange={(e) => setForm((prev) => ({ ...prev, notes: e.target.value }))}
                  className="h-8 w-full rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 text-[13px] outline-none focus:border-[color:var(--cs-accent)]"
                />
              </Field>

              <Field label="ABI JSON">
                <textarea
                  className="min-h-[100px] w-full rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 py-1.5 font-mono text-[11px] outline-none focus:border-[color:var(--cs-accent)]"
                  placeholder='[{"type":"function","name":"approve","inputs":[...]}]'
                  value={form.abiJson}
                  onChange={(e) => setForm((prev) => ({ ...prev, abiJson: e.target.value }))}
                />
              </Field>

              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="file"
                  accept=".json,application/json"
                  className="max-w-[180px] text-[11px]"
                  onChange={(e) => void onLoadAbiFile(e.currentTarget.files?.[0] ?? null)}
                />
                <button
                  type="button"
                  disabled={
                    sourcifyFetching ||
                    !form.chainId.trim() ||
                    !form.address.trim() ||
                    !ADDRESS_RE.test(form.address.trim())
                  }
                  onClick={() => void onFetchFromSourcify()}
                  className="h-7 rounded-md border border-[color:var(--cs-border)] px-3 text-[11px] font-medium text-[color:var(--cs-fg)] hover:bg-[color:var(--cs-hover)] disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {sourcifyFetching ? 'Fetching...' : 'Fetch from Sourcify'}
                </button>
                <button
                  type="submit"
                  className="h-7 rounded-md bg-[color:var(--cs-accent)] px-3 text-[11px] font-medium text-white hover:bg-blue-600 transition-colors"
                >
                  Save ABI Entry
                </button>
                <button
                  type="button"
                  className="h-7 rounded-md border border-[color:var(--cs-border)] px-3 text-[11px] font-medium text-[color:var(--cs-fg)] hover:bg-[color:var(--cs-hover)]"
                  onClick={() => setForm(EMPTY_FORM)}
                >
                  Reset
                </button>
              </div>
              {sourcifyError ? (
                <div className="text-[11px] text-rose-500">{sourcifyError}</div>
              ) : null}
              {submitState && (
                <div
                  className={`text-[11px] ${submitState.ok ? 'text-emerald-600' : 'text-rose-500'}`}
                >
                  {submitState.message}
                </div>
              )}
            </form>
          </div>
        </div>

        <div className="flex flex-col">
          <div className="flex items-center justify-between border-b border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-3 py-1.5">
            <h3 className="text-[11px] font-bold uppercase tracking-wider text-[color:var(--cs-fg)]">
              Stored Contracts
            </h3>
            <span className="text-[11px] text-[color:var(--cs-muted)]">
              {contracts.length} entries
            </span>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            <Table>
              <TableHeader className="bg-[color:var(--cs-panel-soft)] sticky top-0 z-10">
                <TableRow>
                  <TableHead className="h-8 text-[10px]">Name</TableHead>
                  <TableHead className="h-8 text-[10px]">Chain / Address</TableHead>
                  <TableHead className="h-8 text-[10px]">Source</TableHead>
                  <TableHead className="h-8 text-[10px]">ABI</TableHead>
                  <TableHead className="h-8 text-[10px]">Updated</TableHead>
                  <TableHead className="h-8 text-[10px]">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow>
                    <TableCell
                      colSpan={6}
                      className="px-3 py-3 text-[12px] text-[color:var(--cs-muted)]"
                    >
                      Loading contracts...
                    </TableCell>
                  </TableRow>
                ) : null}

                {!loading && contracts.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={6}
                      className="px-3 py-3 text-[12px] text-[color:var(--cs-muted)]"
                    >
                      No ABI entries saved yet.
                    </TableCell>
                  </TableRow>
                ) : null}

                {contracts.map((c) => (
                  <TableRow
                    key={c.id}
                    onClick={() => onSelectContractRow(c.id)}
                    className={[
                      'cursor-pointer',
                      selectedContractId === c.id
                        ? 'bg-[color:var(--cs-accent-soft)]'
                        : 'hover:bg-[color:var(--cs-hover)]',
                    ].join(' ')}
                  >
                    <TableCell className="py-1 px-3 text-[12px] font-medium">{c.name}</TableCell>
                    <TableCell className="py-1 px-3 font-mono text-[11px]">
                      <div>{c.chainId ?? '-'}</div>
                      <div className="text-[color:var(--cs-muted)]" title={c.address ?? undefined}>
                        {short(c.address, 22)}
                      </div>
                    </TableCell>
                    <TableCell className="py-1 px-3 text-[11px]">{c.source || '-'}</TableCell>
                    <TableCell className="py-1 px-3 font-mono text-[11px]">
                      {c.abiItemCount}
                    </TableCell>
                    <TableCell className="py-1 px-3 text-[11px] text-[color:var(--cs-muted)]">
                      {fmtTime(c.updatedAt)}
                    </TableCell>
                    <TableCell className="py-1 px-3">
                      <button
                        type="button"
                        disabled={deletingId === c.id}
                        onClick={(e) => {
                          e.stopPropagation();
                          void onDeleteContract(c.id);
                        }}
                        className="text-[11px] font-medium text-rose-500 hover:text-rose-600 disabled:opacity-50"
                      >
                        Delete
                      </button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      </section>

      <section className="border-b border-[color:var(--cs-border)] bg-[color:var(--cs-panel)]">
        <div className="flex items-center justify-between border-b border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-3 py-1.5">
          <h3 className="text-[11px] font-bold uppercase tracking-wider text-[color:var(--cs-fg)]">
            Selected Contract
          </h3>
          <span className="text-[11px] text-[color:var(--cs-muted)]">
            {selectedContract?.name ?? (selectedContractId ? 'Loading...' : 'None')}
          </span>
        </div>

        <div className="max-h-[360px] overflow-auto p-3">
          {contractLoading ? (
            <div className="text-[12px] text-[color:var(--cs-muted)]">
              Loading selected contract...
            </div>
          ) : null}

          {!contractLoading && !selectedContractId ? (
            <div className="text-[12px] text-[color:var(--cs-muted)]">
              Select a saved contract to inspect metadata, methods, and events.
            </div>
          ) : null}

          {!contractLoading && selectedContractId && contractError ? (
            <div className="rounded-md border border-rose-300 bg-rose-50 px-2 py-1 text-[11px] text-rose-700">
              {contractError}
            </div>
          ) : null}

          {!contractLoading && selectedContract && !contractError ? (
            <div>
              {contractActionState ? (
                <div
                  className={[
                    'mb-3 rounded-md border px-2 py-1 text-[11px]',
                    contractActionState.ok
                      ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
                      : 'border-rose-300 bg-rose-50 text-rose-700',
                  ].join(' ')}
                >
                  {contractActionState.message}
                </div>
              ) : null}

              <div className="grid min-w-0 gap-2 text-[11px] md:grid-cols-3">
                <DetailItem label="Name" value={selectedContract.name} />
                <DetailItem label="Chain ID" value={selectedContract.chainId} />
                <DetailItem label="Address" value={selectedContract.address} />
                <DetailItem label="Source" value={selectedContract.source} />
                <DetailItem label="ABI Items" value={selectedContract.abiItemCount} />
                <DetailItem label="Updated" value={fmtTime(selectedContract.updatedAt)} />
              </div>

              {selectedContract.notes ? (
                <div className="mt-2 rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] p-2 text-[11px] text-[color:var(--cs-fg)]">
                  {selectedContract.notes}
                </div>
              ) : null}

              <div className="mt-3 grid gap-3 xl:grid-cols-2">
                <div className="space-y-2">
                  <div className="text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">
                    Read Methods ({selectedContractAbi.readMethods.length})
                  </div>
                  {selectedContractAbi.readMethods.length === 0 ? (
                    <div className="rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-2 py-1 text-[11px] text-[color:var(--cs-muted)]">
                      No read methods.
                    </div>
                  ) : (
                    selectedContractAbi.readMethods.map((method) => {
                      const key = methodRowKey(method);
                      return (
                        <div
                          key={`read-${key}`}
                          className="rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] p-2"
                        >
                          <div className="mb-1 flex items-center justify-between gap-2">
                            <div
                              className="truncate font-mono text-[11px] text-[color:var(--cs-fg)]"
                              title={key}
                            >
                              {key}
                            </div>
                            <button
                              type="button"
                              disabled={!selectedContract.address}
                              onClick={() => onSendMethodToSandbox(method, 'read')}
                              className="rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 py-1 text-[10px] font-semibold text-[color:var(--cs-fg)] hover:bg-[color:var(--cs-hover)] disabled:opacity-50"
                            >
                              Send to Sandbox
                            </button>
                          </div>

                          {method.inputs.length > 0 ? (
                            <div className="space-y-1">
                              {method.inputs.map((input, idx) => (
                                <input
                                  key={`${key}-input-${idx}`}
                                  type="text"
                                  placeholder={
                                    input.type.includes('[') || input.type === 'tuple'
                                      ? `${paramLabel(input, idx)} (JSON)`
                                      : paramLabel(input, idx)
                                  }
                                  value={contractMethodInputs[key]?.[idx] ?? ''}
                                  onChange={(e) =>
                                    onContractMethodInputChange(key, idx, e.currentTarget.value)
                                  }
                                  className="h-7 w-full rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 font-mono text-[10px] outline-none focus:border-[color:var(--cs-accent)]"
                                />
                              ))}
                            </div>
                          ) : (
                            <div className="text-[10px] text-[color:var(--cs-muted)]">
                              No inputs.
                            </div>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>

                <div className="space-y-2">
                  <div className="text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">
                    Write Methods ({selectedContractAbi.writeMethods.length})
                  </div>
                  {selectedContractAbi.writeMethods.length === 0 ? (
                    <div className="rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-2 py-1 text-[11px] text-[color:var(--cs-muted)]">
                      No write methods.
                    </div>
                  ) : (
                    selectedContractAbi.writeMethods.map((method) => {
                      const key = methodRowKey(method);
                      return (
                        <div
                          key={`write-${key}`}
                          className="rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] p-2"
                        >
                          <div className="mb-1 flex items-center justify-between gap-2">
                            <div
                              className="truncate font-mono text-[11px] text-[color:var(--cs-fg)]"
                              title={key}
                            >
                              {key}
                            </div>
                            <button
                              type="button"
                              disabled={!selectedContract.address}
                              onClick={() => onSendMethodToSandbox(method, 'write')}
                              className="rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 py-1 text-[10px] font-semibold text-[color:var(--cs-fg)] hover:bg-[color:var(--cs-hover)] disabled:opacity-50"
                            >
                              Send to Sandbox
                            </button>
                          </div>

                          <div className="mb-1 text-[10px] text-[color:var(--cs-muted)]">
                            {method.stateMutability}
                          </div>

                          {method.inputs.length > 0 ? (
                            <div className="space-y-1">
                              {method.inputs.map((input, idx) => (
                                <input
                                  key={`${key}-input-${idx}`}
                                  type="text"
                                  placeholder={
                                    input.type.includes('[') || input.type === 'tuple'
                                      ? `${paramLabel(input, idx)} (JSON)`
                                      : paramLabel(input, idx)
                                  }
                                  value={contractMethodInputs[key]?.[idx] ?? ''}
                                  onChange={(e) =>
                                    onContractMethodInputChange(key, idx, e.currentTarget.value)
                                  }
                                  className="h-7 w-full rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 font-mono text-[10px] outline-none focus:border-[color:var(--cs-accent)]"
                                />
                              ))}
                            </div>
                          ) : (
                            <div className="text-[10px] text-[color:var(--cs-muted)]">
                              No inputs.
                            </div>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              </div>

              <div className="mt-3">
                <div className="mb-1 text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">
                  Events ({selectedContractAbi.events.length})
                </div>
                {selectedContractAbi.events.length === 0 ? (
                  <div className="rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-2 py-1 text-[11px] text-[color:var(--cs-muted)]">
                    No events in ABI.
                  </div>
                ) : (
                  <div className="space-y-1">
                    {selectedContractAbi.events.map((event) => (
                      <div
                        key={`event-${eventSignature(event)}`}
                        className="rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-2 py-1 font-mono text-[10px] text-[color:var(--cs-fg)]"
                      >
                        {eventSignature(event)}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="mt-3">
                <div className="mb-1 text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">
                  ABI JSON
                </div>
                <pre className="max-h-[180px] overflow-auto rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] p-2 font-mono text-[10px] leading-relaxed">
                  {stringify(selectedContract.abi)}
                </pre>
              </div>
            </div>
          ) : null}
        </div>
      </section>

      <section className="flex flex-1 flex-col min-h-0">
        <div className="flex items-center justify-between border-b border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-3 py-1.5">
          <h3 className="text-[11px] font-bold uppercase tracking-wider text-[color:var(--cs-fg)]">
            Decoded Requests
          </h3>
          <button
            type="button"
            onClick={() => void loadData(false)}
            disabled={refreshing}
            className="h-6 rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 text-[10px] font-medium text-[color:var(--cs-fg)] hover:bg-[color:var(--cs-hover)]"
          >
            {refreshing ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-3 border-b border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-3 py-2">
          <div className="flex items-center gap-2">
            <label className="text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">
              Search
            </label>
            <input
              type="text"
              placeholder="method, summary, risk..."
              value={decodedSearch}
              onChange={(e) => setDecodedSearch(e.target.value)}
              className="h-7 w-52 rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-2 text-[12px] outline-none focus:border-[color:var(--cs-accent)]"
            />
          </div>
          <div className="flex items-center gap-2">
            <label className="text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">
              Kind
            </label>
            <select
              value={kindFilter}
              onChange={(e) => setKindFilter(e.target.value as DecodedKindFilter)}
              className="h-7 rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-2 text-[12px] outline-none focus:border-[color:var(--cs-accent)]"
            >
              <option value="all">All</option>
              <option value="transaction">Transaction</option>
              <option value="typed_data">Typed Data</option>
              <option value="logs">Logs</option>
            </select>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">
              Risk
            </label>
            <select
              value={riskFilter}
              onChange={(e) => setRiskFilter(e.target.value as DecodedRiskFilter)}
              className="h-7 rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-2 text-[12px] outline-none focus:border-[color:var(--cs-accent)]"
            >
              <option value="all">All</option>
              <option value="with_risks">With Risk Signals</option>
            </select>
          </div>
          <div className="ml-auto text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">
            {filteredDecoded.length} results
          </div>
        </div>

        <HorizontalResizable storageKey="contract-inspector-detail-width" defaultRatio={0.45}>
          <div className="flex min-h-0 flex-col overflow-hidden border-r border-[color:var(--cs-border)]">
            <div className="grid grid-cols-[86px_96px_130px_1fr_62px] border-b border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] px-2 py-1 text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">
              <div>Time</div>
              <div>Kind</div>
              <div>Method</div>
              <div>Summary</div>
              <div className="text-right">Risk</div>
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              {loading ? (
                <div className="p-6 text-[12px] text-[color:var(--cs-muted)]">
                  Loading decoded requests...
                </div>
              ) : filteredDecoded.length === 0 ? (
                <div className="p-6 text-[12px] text-[color:var(--cs-muted)]">
                  No decoded requests match your filters.
                </div>
              ) : (
                filteredDecoded.map((item) => {
                  const selected = item.id === selectedDecodedId;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setSelectedDecodedId(item.id)}
                      className={[
                        'grid w-full grid-cols-[86px_96px_130px_1fr_62px] items-center border-b border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 py-2 text-left text-[11px] transition-colors',
                        selected
                          ? 'bg-[color:var(--cs-accent-soft)]'
                          : 'hover:bg-[color:var(--cs-hover)]',
                      ].join(' ')}
                    >
                      <div className="font-mono text-[color:var(--cs-muted)]">
                        {new Date(item.createdAt).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                          second: '2-digit',
                        })}
                      </div>
                      <div>
                        <Badge variant="outline" className="text-[9px] uppercase">
                          {kindLabel(item.kind)}
                        </Badge>
                      </div>
                      <div className="truncate font-mono">{item.rpcMethod}</div>
                      <div className="truncate pr-2 text-[color:var(--cs-fg)]">{item.summary}</div>
                      <div
                        className={[
                          'text-right font-mono text-[10px] font-bold',
                          item.risks.length > 0 ? 'text-rose-600' : 'text-[color:var(--cs-muted)]',
                        ].join(' ')}
                      >
                        {item.risks.length}
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </div>

          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[color:var(--cs-panel-soft)]">
            {!selectedDecoded ? (
              <div className="flex h-full items-center justify-center p-4 text-[12px] text-[color:var(--cs-muted)]">
                Select an interaction to inspect decoded details.
              </div>
            ) : (
              <div className="min-h-0 flex-1 overflow-auto p-3">
                <div className="flex items-center justify-between">
                  <div>
                    <h4 className="text-[12px] font-bold text-[color:var(--cs-fg)]">
                      Interaction Details
                    </h4>
                    <div className="font-mono text-[10px] text-[color:var(--cs-muted)]">
                      {selectedDecoded.id}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={onSendToSandbox}
                      disabled={!selectedPrefill}
                      className="rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 py-1 text-[11px] font-semibold text-[color:var(--cs-fg)] hover:bg-[color:var(--cs-hover)] disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Send to Contract Sandbox
                    </button>
                    <Link
                      href={`/history/${selectedDecoded.messageId}`}
                      className="text-[11px] text-[color:var(--cs-accent)] hover:underline"
                    >
                      View in History
                    </Link>
                  </div>
                </div>

                {actionState ? (
                  <div
                    className={[
                      'mt-3 rounded-md border px-2 py-1 text-[11px]',
                      actionState.ok
                        ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
                        : 'border-rose-300 bg-rose-50 text-rose-700',
                    ].join(' ')}
                  >
                    {actionState.message}
                  </div>
                ) : null}

                <div className="mt-3 rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] p-2">
                  <div className="mb-1 text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">
                    Summary
                  </div>
                  <div className="text-[12px] text-[color:var(--cs-fg)]">
                    {selectedDecoded.summary}
                  </div>
                </div>

                <div className="mt-3 space-y-1">
                  <label className="text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">
                    Risk Signals
                  </label>
                  {selectedDecoded.risks.length === 0 ? (
                    <div className="rounded-md border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] px-2 py-1 text-[11px] text-[color:var(--cs-muted)]">
                      No obvious risk flags detected.
                    </div>
                  ) : (
                    <div className="space-y-1">
                      {selectedDecoded.risks.map((risk, idx) => (
                        <div
                          key={`${selectedDecoded.id}-risk-${idx}`}
                          className="rounded-md border border-rose-300 bg-rose-50 px-2 py-1 text-[11px] text-rose-700"
                        >
                          {risk}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="mt-3 grid min-w-0 gap-2 text-[11px] md:grid-cols-2">
                  <DetailItem label="Kind" value={kindLabel(selectedDecoded.kind)} />
                  <DetailItem label="RPC Method" value={selectedDecoded.rpcMethod} />
                  <DetailItem label="Contract" value={selectedDecoded.contractName} />
                  <DetailItem label="Function" value={selectedDecoded.functionName} />
                  <DetailItem label="To" value={selectedDecoded.to} />
                  <DetailItem label="Selector" value={selectedDecoded.selector} />
                  <DetailItem label="Chain ID" value={selectedDecoded.chainId} />
                  <DetailItem label="Request Index" value={selectedDecoded.requestIndex} />
                  <DetailItem label="Host" value={selectedDecoded.host} />
                  <DetailItem label="Path" value={selectedDecoded.path} />
                  <DetailItem label="Message ID" value={selectedDecoded.messageId} />
                  <DetailItem label="Captured At" value={fmtTime(selectedDecoded.createdAt)} />
                </div>

                {selectedTypedData ? (
                  <div className="mt-3 min-w-0 rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] p-2">
                    <div className="mb-1 text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">
                      Typed Data
                    </div>
                    <div className="mb-2 grid min-w-0 gap-2 text-[11px] md:grid-cols-2">
                      <DetailItem label="Signer" value={selectedTypedData.signer} />
                      <DetailItem label="Primary Type" value={selectedTypedData.primaryType} />
                    </div>

                    <div className="space-y-2">
                      <div>
                        <label className="text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">
                          Domain
                        </label>
                        <pre className="mt-1 max-h-[140px] overflow-auto rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] p-2 font-mono text-[11px] leading-relaxed">
                          {stringify(selectedTypedData.domain)}
                        </pre>
                      </div>
                      <div>
                        <label className="text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">
                          Message
                        </label>
                        <pre className="mt-1 max-h-[180px] overflow-auto rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] p-2 font-mono text-[11px] leading-relaxed">
                          {stringify(selectedTypedData.message)}
                        </pre>
                      </div>
                      <div>
                        <label className="text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">
                          Types
                        </label>
                        <pre className="mt-1 max-h-[140px] overflow-auto rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] p-2 font-mono text-[11px] leading-relaxed">
                          {stringify(selectedTypedData.types)}
                        </pre>
                      </div>
                    </div>
                  </div>
                ) : null}

                {selectedLogEvents.length > 0 ? (
                  <div className="mt-3 min-w-0 rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] p-2">
                    <div className="mb-1 text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">
                      Decoded Events ({selectedLogEvents.length})
                    </div>
                    <pre className="max-h-[180px] overflow-auto rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] p-2 font-mono text-[11px] leading-relaxed">
                      {stringify(selectedLogEvents)}
                    </pre>
                  </div>
                ) : null}

                {selectedDecoded.decodedArgs.length > 0 ? (
                  <div className="mt-3 min-w-0 rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] p-2">
                    <div className="mb-1 text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">
                      Arguments
                    </div>
                    <pre className="max-h-[180px] overflow-auto rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] p-2 font-mono text-[11px] leading-relaxed">
                      {stringify(selectedDecoded.decodedArgs)}
                    </pre>
                  </div>
                ) : null}

                <div className="mt-3 min-w-0 rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] p-2">
                  <div className="mb-1 text-[10px] font-bold uppercase text-[color:var(--cs-muted)]">
                    Decoded Payload
                  </div>
                  <pre className="max-h-[320px] overflow-auto rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel-soft)] p-2 font-mono text-[11px] leading-relaxed">
                    {stringify(selectedDecoded.decoded)}
                  </pre>
                </div>
              </div>
            )}
          </div>
        </HorizontalResizable>
      </section>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[11px] font-medium text-[color:var(--cs-muted)]">{label}</label>
      {children}
    </div>
  );
}

function DetailItem({
  label,
  value,
}: {
  label: string;
  value: string | number | null | undefined;
}) {
  return (
    <div className="min-w-0 rounded border border-[color:var(--cs-border)] bg-[color:var(--cs-panel)] p-2">
      <div className="text-[10px] text-[color:var(--cs-muted)]">{label}</div>
      <div className="truncate font-mono text-[11px] text-[color:var(--cs-fg)]">
        {value == null ? '-' : String(value)}
      </div>
    </div>
  );
}
