import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  ScannerFindingSchema,
  type AgentEvent,
  type FindingSeverity,
  type HttpMessageDetail,
  type ScannerFinding,
} from '@cipherscope/proto';
import { replayOnce } from './replay.js';
import { decodeUtf8OrNull, getHttpMessage, listHttpMessages } from './store.js';

const MAX_UINT256 = (1n << 256n) - 1n;
const LARGE_APPROVAL_THRESHOLD = 1n << 255n;
const ACTIVE_PROBE_LIMIT = 20;

type JsonRpcCall = {
  method: string;
  params: unknown[];
  path: string;
};

type ReplayProbe = {
  kind: 'missing_nonce' | 'boundary_value' | 'type_mismatch';
  field: string;
  beforePreview: string;
  bodyJson: unknown;
};

type RunScannerInput = {
  db: DatabaseSync;
  includeActive: boolean;
  limit: number;
  messageIds?: string[];
  publishEvent?: (evt: AgentEvent) => void;
};

function severityRank(v: FindingSeverity): number {
  switch (v) {
    case 'critical':
      return 5;
    case 'high':
      return 4;
    case 'medium':
      return 3;
    case 'low':
      return 2;
    default:
      return 1;
  }
}

function stableSortJson(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(stableSortJson);
  if (input && typeof input === 'object') {
    const out: Record<string, unknown> = {};
    const obj = input as Record<string, unknown>;
    for (const key of Object.keys(obj).sort()) {
      out[key] = stableSortJson(obj[key]);
    }
    return out;
  }
  return input;
}

function stableStringify(input: unknown): string {
  try {
    return JSON.stringify(stableSortJson(input));
  } catch {
    return String(input);
  }
}

function toValuePreview(input: unknown, maxLen = 220): string {
  const raw =
    typeof input === 'string'
      ? input
      : typeof input === 'number' || typeof input === 'boolean' || input == null
        ? String(input)
        : stableStringify(input);
  return raw.length <= maxLen ? raw : `${raw.slice(0, maxLen)}...`;
}

function parseBigIntLike(input: unknown): bigint | null {
  if (typeof input === 'bigint') return input;
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || !Number.isInteger(input) || input < 0) return null;
    return BigInt(input);
  }
  if (typeof input !== 'string') return null;
  const v = input.trim();
  if (!v) return null;
  if (/^0x[0-9a-fA-F]+$/.test(v)) {
    try {
      return BigInt(v);
    } catch {
      return null;
    }
  }
  if (/^[0-9]+$/.test(v)) {
    try {
      return BigInt(v);
    } catch {
      return null;
    }
  }
  return null;
}

function toIsoIfValid(input: string | null): string | null {
  if (!input) return null;
  const n = Date.parse(input);
  if (!Number.isFinite(n)) return null;
  return new Date(n).toISOString();
}

function normalizeMessageIds(input: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of input) {
    const v = id.trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function isAddressLike(input: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(input);
}

function decodeHexUtf8(input: string): string | null {
  if (!/^0x[0-9a-fA-F]+$/.test(input)) return null;
  const hex = input.slice(2);
  if (!hex || hex.length % 2 !== 0) return null;
  const buf = Buffer.from(hex, 'hex');
  return decodeUtf8OrNull(buf);
}

function extractJsonRpcCalls(bodyJson: unknown): JsonRpcCall[] {
  const pushFromRecord = (value: unknown, path: string, out: JsonRpcCall[]) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const obj = value as Record<string, unknown>;
    const method = typeof obj.method === 'string' ? obj.method : null;
    if (!method) return;
    const params = Array.isArray(obj.params) ? obj.params : [];
    out.push({ method, params, path });
  };

  const out: JsonRpcCall[] = [];
  if (Array.isArray(bodyJson)) {
    for (let i = 0; i < bodyJson.length; i += 1) {
      pushFromRecord(bodyJson[i], `request.bodyJson[${i}]`, out);
    }
    return out;
  }
  pushFromRecord(bodyJson, 'request.bodyJson', out);
  return out;
}

function extractSignMessage(params: unknown[], callPath: string): { message: string; field: string } | null {
  let best: { message: string; field: string } | null = null;

  for (let i = 0; i < params.length; i += 1) {
    const param = params[i];
    if (typeof param !== 'string') continue;
    if (isAddressLike(param)) continue;

    const decoded = decodeHexUtf8(param);
    const asText = decoded ?? param;
    if (!asText.trim()) continue;

    const candidate = { message: asText, field: `${callPath}.params[${i}]` };
    if (asText.includes('wants you to sign in with your Ethereum account:')) return candidate;

    if (!best || asText.length > best.message.length) best = candidate;
  }

  return best;
}

function parseTypedData(params: unknown[], callPath: string): { typedData: Record<string, unknown>; field: string } | null {
  for (let i = params.length - 1; i >= 0; i -= 1) {
    const param = params[i];
    if (param && typeof param === 'object' && !Array.isArray(param)) {
      return { typedData: param as Record<string, unknown>, field: `${callPath}.params[${i}]` };
    }
    if (typeof param === 'string') {
      const raw = param.trim();
      if (!raw.startsWith('{') && !raw.startsWith('[')) continue;
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return { typedData: parsed as Record<string, unknown>, field: `${callPath}.params[${i}]` };
        }
      } catch {
        // ignore parse errors
      }
    }
  }
  return null;
}

type ParsedSiwe = {
  domain: string | null;
  uri: string | null;
  version: string | null;
  chainId: string | null;
  nonce: string | null;
  issuedAt: string | null;
  expirationTime: string | null;
};

function parseSiweMessage(message: string): ParsedSiwe {
  const normalized = message.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const firstLine = lines[0]?.trim() ?? '';
  const domainMatch = firstLine.match(/^(.+?) wants you to sign in with your Ethereum account:$/);
  const domain = domainMatch?.[1]?.trim() ?? null;

  const kv: Record<string, string> = {};
  for (const line of lines) {
    const m = line.match(/^([A-Za-z ]+):\s*(.+)$/);
    if (!m) continue;
    const key = (m[1] ?? '').toLowerCase().replaceAll(' ', '');
    const val = (m[2] ?? '').trim();
    if (!key) continue;
    kv[key] = val;
  }

  return {
    domain,
    uri: kv.uri ?? null,
    version: kv.version ?? null,
    chainId: kv.chainid ?? null,
    nonce: kv.nonce ?? null,
    issuedAt: kv.issuedat ?? null,
    expirationTime: kv.expirationtime ?? null,
  };
}

function parseApproveCallData(input: string): { spender: string; amount: bigint } | null {
  if (!/^0x[0-9a-fA-F]+$/.test(input)) return null;
  const hex = input.slice(2);
  if (hex.length < 8 + 64 + 64) return null;
  const selector = hex.slice(0, 8).toLowerCase();
  if (selector !== '095ea7b3' && selector !== '39509351') return null;

  const word1 = hex.slice(8, 72);
  const word2 = hex.slice(72, 136);
  const spender = `0x${word1.slice(24)}`.toLowerCase();
  if (!isAddressLike(spender)) return null;

  try {
    const amount = BigInt(`0x${word2}`);
    return { spender, amount };
  } catch {
    return null;
  }
}

function sanitizeForActiveProbe(input: unknown): unknown {
  return JSON.parse(JSON.stringify(input));
}

function stringifyPath(path: Array<string | number>): string {
  if (path.length === 0) return 'request.bodyJson';
  let out = 'request.bodyJson';
  for (const part of path) {
    if (typeof part === 'number') out += `[${part}]`;
    else out += out.endsWith(']') ? `.${part}` : `.${part}`;
  }
  return out;
}

function getAtPath(input: unknown, path: Array<string | number>): unknown {
  let cur: unknown = input;
  for (const part of path) {
    if (cur == null || typeof cur !== 'object') return undefined;
    if (Array.isArray(cur)) {
      if (typeof part !== 'number') return undefined;
      cur = cur[part];
      continue;
    }
    if (typeof part !== 'string') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function findFirstPath(
  input: unknown,
  predicate: (key: string, value: unknown) => boolean,
  path: Array<string | number> = [],
  depth = 0,
): Array<string | number> | null {
  if (depth > 8) return null;
  if (Array.isArray(input)) {
    for (let i = 0; i < input.length; i += 1) {
      const next = findFirstPath(input[i], predicate, [...path, i], depth + 1);
      if (next) return next;
    }
    return null;
  }
  if (!input || typeof input !== 'object') return null;

  const obj = input as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  for (const key of keys) {
    const value = obj[key];
    if (predicate(key, value)) return [...path, key];
    const next = findFirstPath(value, predicate, [...path, key], depth + 1);
    if (next) return next;
  }
  return null;
}

function removeAtPath(input: unknown, path: Array<string | number>): boolean {
  if (!path.length) return false;
  const parentPath = path.slice(0, -1);
  const leaf = path[path.length - 1];
  const parent = getAtPath(input, parentPath);
  if (!parent || typeof parent !== 'object' || Array.isArray(parent)) return false;
  if (typeof leaf !== 'string') return false;
  if (!hasOwn(parent as Record<string, unknown>, leaf)) return false;
  delete (parent as Record<string, unknown>)[leaf];
  return true;
}

function setAtPath(input: unknown, path: Array<string | number>, value: unknown): boolean {
  if (!path.length) return false;
  const parentPath = path.slice(0, -1);
  const leaf = path[path.length - 1];
  const parent = getAtPath(input, parentPath);
  if (!parent || typeof parent !== 'object') return false;
  if (Array.isArray(parent)) {
    if (typeof leaf !== 'number') return false;
    parent[leaf] = value;
    return true;
  }
  if (typeof leaf !== 'string') return false;
  (parent as Record<string, unknown>)[leaf] = value;
  return true;
}

function hasRiskyKeywords(input: string): boolean {
  return /(swap|bridge|withdraw|transfer|order|trade|sendtransaction|sendrawtransaction|mint|burn|approve|permit|flashloan|flash_loan|flash-loan)/i.test(
    input,
  );
}

function shouldSkipActiveProbe(message: HttpMessageDetail): boolean {
  const method = message.method.toUpperCase();
  if (method !== 'POST' && method !== 'PUT' && method !== 'PATCH') return true;
  if (!message.request.bodyJson || typeof message.request.bodyJson !== 'object') return true;
  if (Array.isArray(message.request.bodyJson)) return true;
  if (message.responseStatus == null || message.responseStatus < 200 || message.responseStatus >= 300) {
    return true;
  }

  const target = `${message.host}${message.path}`;
  if (!/(siwe|sign|signin|login|auth|session|verify|challenge|nonce)/i.test(target)) return true;
  if (hasRiskyKeywords(target)) return true;

  const bodyText = stableStringify(message.request.bodyJson);
  if (hasRiskyKeywords(bodyText)) return true;
  return false;
}

function buildReplayProbe(bodyJson: unknown): ReplayProbe | null {
  const clone = sanitizeForActiveProbe(bodyJson);
  if (!clone || typeof clone !== 'object' || Array.isArray(clone)) return null;

  const noncePath = findFirstPath(clone, (k, v) => {
    if (!/(nonce|challenge|requestid)/i.test(k)) return false;
    return typeof v === 'string' || typeof v === 'number';
  });
  if (noncePath) {
    const before = getAtPath(clone, noncePath);
    if (removeAtPath(clone, noncePath)) {
      return {
        kind: 'missing_nonce',
        field: stringifyPath(noncePath),
        beforePreview: toValuePreview(before),
        bodyJson: clone,
      };
    }
  }

  const boundaryPath = findFirstPath(clone, (k, v) => {
    if (!/(amount|value|deadline|expiry|expiration|timestamp|chainid)/i.test(k)) return false;
    return typeof v === 'number' || typeof v === 'string';
  });
  if (boundaryPath) {
    const before = getAtPath(clone, boundaryPath);
    const boundaryValue =
      typeof before === 'number'
        ? -1
        : typeof before === 'string' && before.trim().startsWith('0x')
          ? '0x0'
          : '0';
    if (setAtPath(clone, boundaryPath, boundaryValue)) {
      return {
        kind: 'boundary_value',
        field: stringifyPath(boundaryPath),
        beforePreview: toValuePreview(before),
        bodyJson: clone,
      };
    }
  }

  const mismatchPath = findFirstPath(clone, (k, v) => {
    if (!/(nonce|amount|value|deadline|chainid|timestamp|signature)/i.test(k)) return false;
    return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
  });
  if (mismatchPath) {
    const before = getAtPath(clone, mismatchPath);
    if (setAtPath(clone, mismatchPath, { invalid: true })) {
      return {
        kind: 'type_mismatch',
        field: stringifyPath(mismatchPath),
        beforePreview: toValuePreview(before),
        bodyJson: clone,
      };
    }
  }

  return null;
}

function responseLooksRejected(message: HttpMessageDetail): boolean {
  if (message.responseStatus != null && message.responseStatus >= 400) return true;
  const bodyText =
    message.response.bodyText ??
    (message.response.bodyJson != null ? stableStringify(message.response.bodyJson) : '');
  return /(error|invalid|missing|required|denied|reject|failed|unauthori[sz]ed)/i.test(bodyText);
}

function buildScannerId(checkId: string, fingerprint: string): string {
  const digest = createHash('sha256').update(`${checkId}|${fingerprint}`).digest('hex').slice(0, 24);
  return `scanner_${digest}`;
}

function maxSeverity(input: FindingSeverity[]): FindingSeverity {
  if (!input.length) return 'info';
  let best: FindingSeverity = input[0] ?? 'info';
  for (let i = 1; i < input.length; i += 1) {
    const candidate = input[i];
    if (!candidate) continue;
    if (severityRank(candidate) > severityRank(best)) best = candidate;
  }
  return best;
}

function upsertScannerFindings(db: DatabaseSync, findings: ScannerFinding[]) {
  db.exec(`DELETE FROM findings WHERE id LIKE 'scanner_%';`);
  if (!findings.length) return;

  const stmt = db.prepare(`
    INSERT INTO findings (
      id, created_at, severity, confidence, title, description_md, evidence_json, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      created_at = excluded.created_at,
      severity = excluded.severity,
      confidence = excluded.confidence,
      title = excluded.title,
      description_md = excluded.description_md,
      evidence_json = excluded.evidence_json,
      status = excluded.status
  `);

  for (const finding of findings) {
    const description = [
      finding.summary,
      '',
      `Remediation: ${finding.remediation}`,
      '',
      'Reproducibility:',
      ...finding.reproducibility.map((line) => `- ${line}`),
      '',
      `Check: ${finding.checkId} (${finding.mode})`,
    ].join('\n');

    stmt.run(
      finding.id,
      finding.createdAt,
      finding.severity,
      finding.confidence,
      finding.title,
      description,
      JSON.stringify(finding),
      finding.status,
    );
  }
}

function listMessageDetails(db: DatabaseSync, input: { limit: number; messageIds?: string[] }): HttpMessageDetail[] {
  const ids =
    input.messageIds && input.messageIds.length > 0
      ? normalizeMessageIds(input.messageIds).slice(0, 1000)
      : listHttpMessages(db, { limit: input.limit, offset: 0 }).map((m) => m.id);

  const out: HttpMessageDetail[] = [];
  for (const id of ids) {
    const item = getHttpMessage(db, id);
    if (item) out.push(item);
  }
  return out;
}

function addFinding(
  bag: Map<string, ScannerFinding>,
  input: Omit<ScannerFinding, 'id' | 'createdAt' | 'status'> & { fingerprint: string; status?: ScannerFinding['status'] },
) {
  const createdAt = new Date().toISOString();
  const id = buildScannerId(input.checkId, input.fingerprint);
  const normalized = ScannerFindingSchema.parse({
    id,
    createdAt,
    status: input.status ?? 'open',
    checkId: input.checkId,
    mode: input.mode,
    severity: input.severity,
    confidence: input.confidence,
    title: input.title,
    summary: input.summary,
    remediation: input.remediation,
    reproducibility: input.reproducibility,
    tags: input.tags,
    evidence: input.evidence,
  });
  bag.set(id, normalized);
}

function parseSiweIssues(message: HttpMessageDetail, siwe: ParsedSiwe): Array<{ severity: FindingSeverity; note: string; field: string }> {
  const issues: Array<{ severity: FindingSeverity; note: string; field: string }> = [];

  if (!siwe.nonce) {
    issues.push({ severity: 'high', note: 'Nonce is missing from SIWE payload.', field: 'request.bodyJson.params' });
  } else if (!/^[a-zA-Z0-9]{8,}$/.test(siwe.nonce)) {
    issues.push({
      severity: 'medium',
      note: 'SIWE nonce should be alphanumeric and at least 8 characters.',
      field: 'request.bodyJson.params',
    });
  }

  if (!siwe.issuedAt) {
    issues.push({ severity: 'medium', note: 'Issued At is missing, increasing replay risk.', field: 'request.bodyJson.params' });
  } else if (!toIsoIfValid(siwe.issuedAt)) {
    issues.push({ severity: 'low', note: 'Issued At is not a valid timestamp.', field: 'request.bodyJson.params' });
  }

  if (!siwe.expirationTime) {
    issues.push({ severity: 'medium', note: 'Expiration Time is missing from SIWE payload.', field: 'request.bodyJson.params' });
  } else if (!toIsoIfValid(siwe.expirationTime)) {
    issues.push({ severity: 'low', note: 'Expiration Time is not a valid timestamp.', field: 'request.bodyJson.params' });
  }

  if (!siwe.version) {
    issues.push({ severity: 'low', note: 'SIWE Version field is missing.', field: 'request.bodyJson.params' });
  } else if (siwe.version !== '1') {
    issues.push({
      severity: 'medium',
      note: `SIWE version should be "1" (got "${siwe.version}").`,
      field: 'request.bodyJson.params',
    });
  }

  if (!siwe.chainId) {
    issues.push({ severity: 'medium', note: 'SIWE Chain ID is missing.', field: 'request.bodyJson.params' });
  } else if (!/^[0-9]+$/.test(siwe.chainId)) {
    issues.push({ severity: 'low', note: 'SIWE Chain ID should be numeric.', field: 'request.bodyJson.params' });
  }

  if (!siwe.uri) {
    issues.push({ severity: 'low', note: 'SIWE URI field is missing.', field: 'request.bodyJson.params' });
  }

  if (siwe.uri && siwe.domain) {
    try {
      const u = new URL(siwe.uri);
      if (u.host.toLowerCase() !== siwe.domain.toLowerCase()) {
        issues.push({
          severity: 'high',
          note: `SIWE domain "${siwe.domain}" does not match URI host "${u.host}".`,
          field: 'request.bodyJson.params',
        });
      }
    } catch {
      issues.push({ severity: 'low', note: 'SIWE URI is not a valid URL.', field: 'request.bodyJson.params' });
    }
  }

  if (siwe.domain && siwe.domain.toLowerCase() !== message.host.toLowerCase()) {
    issues.push({
      severity: 'low',
      note: `SIWE domain "${siwe.domain}" differs from captured host "${message.host}".`,
      field: 'request.bodyJson.params',
    });
  }

  return issues;
}

function listTypedDataIssues(typedData: Record<string, unknown>): Array<{ severity: FindingSeverity; note: string; field: string }> {
  const issues: Array<{ severity: FindingSeverity; note: string; field: string }> = [];
  const domain =
    typedData.domain && typeof typedData.domain === 'object' && !Array.isArray(typedData.domain)
      ? (typedData.domain as Record<string, unknown>)
      : null;

  if (!domain) {
    issues.push({
      severity: 'high',
      note: 'EIP-712 payload is missing domain metadata.',
      field: 'request.bodyJson.params.domain',
    });
    return issues;
  }

  const chainId = domain.chainId;
  if (chainId == null) {
    issues.push({
      severity: 'high',
      note: 'EIP-712 domain is missing chainId, weakening domain separation.',
      field: 'request.bodyJson.params.domain.chainId',
    });
  } else if (parseBigIntLike(chainId) == null) {
    issues.push({
      severity: 'medium',
      note: `EIP-712 chainId is not numeric (${toValuePreview(chainId)}).`,
      field: 'request.bodyJson.params.domain.chainId',
    });
  }

  const verifyingContract = domain.verifyingContract;
  if (verifyingContract == null) {
    issues.push({
      severity: 'medium',
      note: 'EIP-712 domain is missing verifyingContract.',
      field: 'request.bodyJson.params.domain.verifyingContract',
    });
  } else if (typeof verifyingContract !== 'string' || !isAddressLike(verifyingContract)) {
    issues.push({
      severity: 'medium',
      note: `EIP-712 verifyingContract is malformed (${toValuePreview(verifyingContract)}).`,
      field: 'request.bodyJson.params.domain.verifyingContract',
    });
  }

  if (typeof domain.name !== 'string' || !domain.name.trim()) {
    issues.push({
      severity: 'low',
      note: 'EIP-712 domain name is empty or missing.',
      field: 'request.bodyJson.params.domain.name',
    });
  }

  const message =
    typedData.message && typeof typedData.message === 'object' && !Array.isArray(typedData.message)
      ? (typedData.message as Record<string, unknown>)
      : null;
  if (message) {
    const hasNonce = hasOwn(message, 'nonce') || hasOwn(message, 'salt');
    const hasExpiry =
      hasOwn(message, 'deadline') ||
      hasOwn(message, 'expiry') ||
      hasOwn(message, 'expiration') ||
      hasOwn(message, 'validUntil');
    if (!hasNonce && !hasExpiry) {
      issues.push({
        severity: 'medium',
        note: 'Typed data message lacks nonce/expiry-style anti-replay fields.',
        field: 'request.bodyJson.params.message',
      });
    }
  }

  return issues;
}

export async function runScanner(input: RunScannerInput): Promise<{
  runId: string;
  startedAt: string;
  finishedAt: string;
  includeActive: boolean;
  summary: {
    scannedMessages: number;
    passiveChecks: number;
    activeChecks: number;
    findingsTotal: number;
    bySeverity: {
      info: number;
      low: number;
      medium: number;
      high: number;
      critical: number;
    };
  };
  findings: ScannerFinding[];
}> {
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const findings = new Map<string, ScannerFinding>();
  const messages = listMessageDetails(input.db, { limit: input.limit, messageIds: input.messageIds });

  let passiveChecks = 0;
  let activeChecks = 0;

  const siweNonceMap = new Map<string, string[]>();
  const signaturePayloadMap = new Map<
    string,
    {
      ids: string[];
      preview: string;
    }
  >();

  for (const message of messages) {
    const rpcCalls = extractJsonRpcCalls(message.request.bodyJson);
    for (const call of rpcCalls) {
      const method = call.method.toLowerCase();

      if (method === 'personal_sign' || method === 'eth_sign') {
        passiveChecks += 1;

        const signMessage = extractSignMessage(call.params, call.path);
        if (!signMessage) continue;

        const payloadHash = createHash('sha256').update(signMessage.message).digest('hex');
        const tracked = signaturePayloadMap.get(payloadHash);
        if (tracked) tracked.ids.push(message.id);
        else signaturePayloadMap.set(payloadHash, { ids: [message.id], preview: toValuePreview(signMessage.message) });

        if (!signMessage.message.includes('wants you to sign in with your Ethereum account:')) continue;
        const siwe = parseSiweMessage(signMessage.message);
        if (siwe.nonce) {
          const arr = siweNonceMap.get(siwe.nonce) ?? [];
          arr.push(message.id);
          siweNonceMap.set(siwe.nonce, arr);
        }

        const issues = parseSiweIssues(message, siwe);
        if (issues.length) {
          addFinding(findings, {
            fingerprint: `${message.id}|siwe`,
            checkId: 'passive.siwe.correctness',
            mode: 'passive',
            severity: maxSeverity(issues.map((x) => x.severity)),
            confidence: 0.93,
            title: 'SIWE payload has correctness/replay gaps',
            summary: issues.map((x) => x.note).join(' '),
            remediation:
              'Enforce SIWE verification server-side: require nonce, issuedAt, expirationTime, version=1, valid chainId, and a strict domain/URI host match.',
            reproducibility: [
              `Open message ${message.id} in History and inspect the SIWE payload.`,
              'Compare SIWE fields against EIP-4361 requirements.',
              'Reject sign-ins missing anti-replay fields or with domain/URI mismatch.',
            ],
            tags: ['siwe', 'replay-risk', 'passive'],
            evidence: issues.map((issue) => ({
              messageId: message.id,
              field: issue.field,
              note: issue.note,
              replayVariantId: null,
            })),
          });
        }
      }

      if (method.startsWith('eth_signtypeddata')) {
        passiveChecks += 1;
        const typed = parseTypedData(call.params, call.path);
        if (!typed) continue;

        const payloadHash = createHash('sha256').update(stableStringify(typed.typedData)).digest('hex');
        const tracked = signaturePayloadMap.get(payloadHash);
        if (tracked) tracked.ids.push(message.id);
        else signaturePayloadMap.set(payloadHash, { ids: [message.id], preview: toValuePreview(typed.typedData) });

        const issues = listTypedDataIssues(typed.typedData);
        if (issues.length) {
          addFinding(findings, {
            fingerprint: `${message.id}|typed-domain`,
            checkId: 'passive.signature.domain_separation',
            mode: 'passive',
            severity: maxSeverity(issues.map((x) => x.severity)),
            confidence: 0.9,
            title: 'Weak EIP-712 domain separation indicators',
            summary: issues.map((x) => x.note).join(' '),
            remediation:
              'Bind signatures to the intended domain: include chainId and verifyingContract, and require nonce/deadline-style anti-replay fields in the typed message.',
            reproducibility: [
              `Open message ${message.id} and inspect typed-data domain fields.`,
              'Check whether chainId/verifyingContract are present and validated on the backend.',
              'Reject signatures that omit anti-replay constraints.',
            ],
            tags: ['typed-data', 'domain-separation', 'passive'],
            evidence: issues.map((issue) => ({
              messageId: message.id,
              field: issue.field,
              note: issue.note,
              replayVariantId: null,
            })),
          });
        }

        const primaryType = typeof typed.typedData.primaryType === 'string' ? typed.typedData.primaryType : '';
        if (/permit/i.test(primaryType)) {
          const msgObj =
            typed.typedData.message &&
            typeof typed.typedData.message === 'object' &&
            !Array.isArray(typed.typedData.message)
              ? (typed.typedData.message as Record<string, unknown>)
              : null;
          if (msgObj) {
            const numericPath = findFirstPath(msgObj, (k, v) => /(value|amount|allowed|permitamount)/i.test(k) && parseBigIntLike(v) != null);
            if (numericPath) {
              const amount = parseBigIntLike(getAtPath(msgObj, numericPath));
              if (amount != null && amount >= LARGE_APPROVAL_THRESHOLD) {
                const severity: FindingSeverity = amount === MAX_UINT256 ? 'high' : 'medium';
                addFinding(findings, {
                  fingerprint: `${message.id}|permit|max`,
                  checkId: 'passive.approval.unlimited_permit',
                  mode: 'passive',
                  severity,
                  confidence: 0.91,
                  title: 'Permit signature allows near-unlimited token spend',
                  summary: `Typed-data permit amount is ${amount === MAX_UINT256 ? 'max uint256' : 'extremely large'}, which can create long-lived spend risk.`,
                  remediation:
                    'Prefer exact-amount permits with short expiry, and require explicit user confirmation when very large approvals are requested.',
                  reproducibility: [
                    `Inspect typed-data message in ${message.id}.`,
                    'Locate permit amount/value and confirm whether it is max or near-max.',
                    'Update contract/app logic to use bounded approvals where possible.',
                  ],
                  tags: ['permit', 'approval', 'passive'],
                  evidence: [
                    {
                      messageId: message.id,
                      field: `${typed.field}.message.${numericPath.join('.')}`,
                      note: `Permit amount/value = ${toValuePreview(getAtPath(msgObj, numericPath))}`,
                      replayVariantId: null,
                    },
                  ],
                });
              }
            }
          }
        }
      }

      if (method === 'eth_sendtransaction' || method === 'eth_signtransaction') {
        passiveChecks += 1;
        const tx =
          call.params[0] && typeof call.params[0] === 'object' && !Array.isArray(call.params[0])
            ? (call.params[0] as Record<string, unknown>)
            : null;
        const data = tx && typeof tx.data === 'string' ? tx.data : null;
        if (!data) continue;

        const parsed = parseApproveCallData(data);
        if (!parsed) continue;
        if (parsed.amount < LARGE_APPROVAL_THRESHOLD) continue;

        const severity: FindingSeverity = parsed.amount === MAX_UINT256 ? 'high' : 'medium';
        addFinding(findings, {
          fingerprint: `${message.id}|approve|${parsed.spender}|${parsed.amount.toString()}`,
          checkId: 'passive.approval.unlimited_erc20',
          mode: 'passive',
          severity,
          confidence: 0.97,
          title: 'Unlimited ERC-20 approval detected',
          summary:
            parsed.amount === MAX_UINT256
              ? `approve(spender=${parsed.spender}, amount=max_uint256) grants unrestricted token spend.`
              : `approve() amount is very large (${parsed.amount.toString()}), close to unrestricted spend.`,
          remediation:
            'Use exact-amount approvals when possible, add approval reset workflows, and show clear UX warnings before broad allowances are signed.',
          reproducibility: [
            `Open message ${message.id} and decode transaction calldata selector 0x095ea7b3/0x39509351.`,
            `Confirm spender ${parsed.spender} and amount ${parsed.amount.toString()}.`,
            'Replay in a sandbox before approving in production wallets.',
          ],
          tags: ['approval', 'erc20', 'passive'],
          evidence: [
            {
              messageId: message.id,
              field: `${call.path}.params[0].data`,
              note: `Decoded approve spender=${parsed.spender}, amount=${parsed.amount.toString()}`,
              replayVariantId: null,
            },
          ],
        });
      }
    }
  }

  for (const [nonce, ids] of siweNonceMap.entries()) {
    const uniqueIds = normalizeMessageIds(ids);
    if (uniqueIds.length < 2) continue;
    addFinding(findings, {
      fingerprint: `nonce-reuse|${nonce}|${uniqueIds.join(',')}`,
      checkId: 'passive.replay.siwe_nonce_reuse',
      mode: 'passive',
      severity: 'high',
      confidence: 0.87,
      title: 'SIWE nonce reused across multiple sign-in requests',
      summary: `The same SIWE nonce (${nonce}) appears in ${uniqueIds.length} captured requests, indicating replay-prone challenge handling.`,
      remediation:
        'Generate nonce per sign-in attempt, bind it to a short TTL, and enforce single-use semantics on verification.',
      reproducibility: [
        ...uniqueIds.slice(0, 5).map((id) => `Inspect SIWE message in ${id}.`),
        'Confirm nonce lifecycle in backend storage and verification code.',
      ],
      tags: ['siwe', 'nonce', 'replay-risk', 'passive'],
      evidence: uniqueIds.slice(0, 8).map((id) => ({
        messageId: id,
        field: 'request.bodyJson.params',
        note: `Reused nonce ${nonce}`,
        replayVariantId: null,
      })),
    });
  }

  for (const [payloadHash, tracked] of signaturePayloadMap.entries()) {
    const uniqueIds = normalizeMessageIds(tracked.ids);
    if (uniqueIds.length < 2) continue;
    addFinding(findings, {
      fingerprint: `payload-reuse|${payloadHash}|${uniqueIds.join(',')}`,
      checkId: 'passive.replay.signature_payload_reuse',
      mode: 'passive',
      severity: 'medium',
      confidence: 0.76,
      title: 'Identical signature payload seen multiple times',
      summary: `A signature payload was reused across ${uniqueIds.length} requests. Reused payloads can indicate missing nonce/domain enforcement.`,
      remediation:
        'Ensure signed payloads include anti-replay claims (nonce, expiry, chain binding) and are invalidated after successful verification.',
      reproducibility: [
        ...uniqueIds.slice(0, 5).map((id) => `Inspect signed payload in ${id}.`),
        'Compare payload bytes and server-side validation behavior across captures.',
      ],
      tags: ['signature', 'replay-risk', 'passive'],
      evidence: uniqueIds.slice(0, 8).map((id) => ({
        messageId: id,
        field: 'request.bodyJson',
        note: `Matching payload hash ${payloadHash.slice(0, 12)}... (${tracked.preview})`,
        replayVariantId: null,
      })),
    });
  }

  if (input.includeActive) {
    let probesRun = 0;
    for (const message of messages) {
      if (probesRun >= ACTIVE_PROBE_LIMIT) break;
      if (shouldSkipActiveProbe(message)) continue;

      const probe = buildReplayProbe(message.request.bodyJson);
      if (!probe) continue;

      probesRun += 1;
      activeChecks += 1;

      try {
        const replay = await replayOnce({
          db: input.db,
          baselineId: message.id,
          overrides: {
            method: message.method,
            url: message.url,
            headers: {
              ...message.request.headers,
              'x-cipherscope-scanner': ['1'],
            },
            bodyText: JSON.stringify(probe.bodyJson),
          },
          publishEvent: input.publishEvent,
        });

        if (responseLooksRejected(replay.variant)) continue;
        if (
          replay.baseline.responseStatus == null ||
          replay.variant.responseStatus == null ||
          replay.baseline.responseStatus < 200 ||
          replay.baseline.responseStatus >= 300 ||
          replay.variant.responseStatus < 200 ||
          replay.variant.responseStatus >= 300
        ) {
          continue;
        }

        const severity: FindingSeverity =
          probe.kind === 'missing_nonce' ? 'high' : probe.kind === 'boundary_value' ? 'medium' : 'medium';
        const confidence =
          replay.diff.status.changed || replay.diff.body.changed || replay.diff.headers.changed.length > 0
            ? 0.8
            : 0.9;
        const probeLabel =
          probe.kind === 'missing_nonce'
            ? 'missing nonce/challenge'
            : probe.kind === 'boundary_value'
              ? 'boundary value'
              : 'type mismatch';

        addFinding(findings, {
          fingerprint: `${message.id}|${probe.kind}|${probe.field}|${replay.variant.id}`,
          checkId: `active.validation.${probe.kind}`,
          mode: 'active',
          severity,
          confidence,
          title: `Active validation probe accepted (${probeLabel})`,
          summary:
            `The scanner sent a safe invalid-input probe (${probeLabel}) and the endpoint still returned success ` +
            `(baseline=${replay.baseline.responseStatus}, variant=${replay.variant.responseStatus}).`,
          remediation:
            'Recompute and validate signed/auth fields server-side, reject missing or malformed inputs, and bind challenges/nonces to strict one-time validation rules.',
          reproducibility: [
            `Baseline request: ${replay.baseline.id}`,
            `Scanner variant: ${replay.variant.id}`,
            `Mutated field ${probe.field} (before=${probe.beforePreview})`,
          ],
          tags: ['active', 'validation', 'guardrailed-probe'],
          evidence: [
            {
              messageId: replay.baseline.id,
              field: probe.field,
              note: `Baseline value ${probe.beforePreview}`,
              replayVariantId: replay.variant.id,
            },
            {
              messageId: replay.variant.id,
              field: 'response.status',
              note: `Variant accepted with status ${replay.variant.responseStatus}`,
              replayVariantId: replay.variant.id,
            },
          ],
        });
      } catch {
        // Replay errors are expected for some endpoints; skip silently.
      }
    }
  }

  const findingItems = [...findings.values()].sort((a, b) => {
    if (severityRank(a.severity) !== severityRank(b.severity)) {
      return severityRank(b.severity) - severityRank(a.severity);
    }
    return b.createdAt.localeCompare(a.createdAt);
  });

  upsertScannerFindings(input.db, findingItems);

  const bySeverity = {
    info: 0,
    low: 0,
    medium: 0,
    high: 0,
    critical: 0,
  };
  for (const finding of findingItems) {
    bySeverity[finding.severity] += 1;
  }

  const finishedAt = new Date().toISOString();
  return {
    runId,
    startedAt,
    finishedAt,
    includeActive: input.includeActive,
    summary: {
      scannedMessages: messages.length,
      passiveChecks,
      activeChecks,
      findingsTotal: findingItems.length,
      bySeverity,
    },
    findings: findingItems,
  };
}

export function listScannerFindings(
  db: DatabaseSync,
  input: { limit: number; offset: number },
): ScannerFinding[] {
  const rows = db
    .prepare(
      `
      SELECT evidence_json
      FROM findings
      WHERE id LIKE 'scanner_%'
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `,
    )
    .all(input.limit, input.offset) as Array<{ evidence_json: string | null }>;

  const out: ScannerFinding[] = [];
  for (const row of rows) {
    if (!row.evidence_json) continue;
    try {
      const parsed = ScannerFindingSchema.parse(JSON.parse(row.evidence_json));
      out.push(parsed);
    } catch {
      // ignore non-scanner rows/malformed entries
    }
  }
  return out;
}
