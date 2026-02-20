import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  ScannerFindingSchema,
  type ContractAuditRunRequest,
  type ContractAuditRunResponse,
  type ContractAuditTooling,
  type FindingSeverity,
  type ScannerFinding,
} from '@cipherscope/proto';

const ONE_ETH_WEI = 10n ** 18n;
const LARGE_VALUE_WEI = 5n * ONE_ETH_WEI;
const LARGE_GAS_THRESHOLD = 5_000_000n;
const MAX_CAPTURED_TOOL_OUTPUT = 24_000;

type RpcInvoker = <T = unknown>(method: string, params?: unknown[]) => Promise<T>;

type RunContractAuditInput = {
  db: DatabaseSync;
  request: ContractAuditRunRequest;
  rpcCall?: RpcInvoker;
};

type AddFindingInput = {
  checkId: string;
  fingerprint: string;
  severity: FindingSeverity;
  confidence: number;
  title: string;
  summary: string;
  remediation: string;
  reproducibility: string[];
  tags: string[];
  evidence: ScannerFinding['evidence'];
};

type OpcodeCounts = Record<number, number>;

function isAddressLike(input: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(input);
}

function toLowerAddress(input: string): string {
  return input.toLowerCase();
}

function toQuantityIfValid(input: string | null | undefined): string | null {
  if (typeof input !== 'string') return null;
  const raw = input.trim();
  if (!raw) return null;
  if (/^0x[0-9a-fA-F]+$/.test(raw)) return raw.toLowerCase();
  if (/^[0-9]+$/.test(raw)) return raw;
  return null;
}

function parseBigIntLike(input: string | null | undefined): bigint | null {
  const raw = toQuantityIfValid(input);
  if (!raw) return null;
  try {
    return raw.startsWith('0x') ? BigInt(raw) : BigInt(raw);
  } catch {
    return null;
  }
}

function selectorFromData(data: string): string | null {
  const raw = data.trim();
  if (!/^0x[0-9a-fA-F]*$/.test(raw)) return null;
  if (raw.length < 10) return null;
  return `0x${raw.slice(2, 10).toLowerCase()}`;
}

function parseApproveCalldata(data: string): { spender: string; amount: bigint } | null {
  const raw = data.trim();
  if (!/^0x[0-9a-fA-F]+$/.test(raw)) return null;
  const hex = raw.slice(2);
  if (hex.length < 8 + 64 + 64) return null;
  const selector = hex.slice(0, 8).toLowerCase();
  if (selector !== '095ea7b3' && selector !== '39509351') return null;

  const spenderWord = hex.slice(8, 72);
  const amountWord = hex.slice(72, 136);
  const spender = `0x${spenderWord.slice(24)}`.toLowerCase();
  if (!isAddressLike(spender)) return null;

  try {
    return { spender, amount: BigInt(`0x${amountWord}`) };
  } catch {
    return null;
  }
}

function parseSetApprovalForAllCalldata(data: string): { operator: string; approved: boolean } | null {
  const raw = data.trim();
  if (!/^0x[0-9a-fA-F]+$/.test(raw)) return null;
  const hex = raw.slice(2);
  if (hex.length < 8 + 64 + 64) return null;
  if (hex.slice(0, 8).toLowerCase() !== 'a22cb465') return null;

  const operatorWord = hex.slice(8, 72);
  const approvedWord = hex.slice(72, 136);
  const operator = `0x${operatorWord.slice(24)}`.toLowerCase();
  if (!isAddressLike(operator)) return null;
  try {
    const approved = BigInt(`0x${approvedWord}`) === 1n;
    return { operator, approved };
  } catch {
    return null;
  }
}

function scanOpcodes(bytecodeHex: string): OpcodeCounts {
  const raw = bytecodeHex.trim().replace(/^0x/i, '');
  if (!raw || raw.length % 2 !== 0) return {};
  const buf = Buffer.from(raw, 'hex');
  const counts: OpcodeCounts = {};

  for (let i = 0; i < buf.length; i += 1) {
    const op = buf[i] ?? 0;
    counts[op] = (counts[op] ?? 0) + 1;

    // Skip PUSH payload bytes so immediates do not look like opcodes.
    if (op >= 0x60 && op <= 0x7f) {
      const pushBytes = op - 0x5f;
      i += pushBytes;
    }
  }
  return counts;
}

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

function buildAuditId(checkId: string, fingerprint: string): string {
  const digest = createHash('sha256')
    .update(`${checkId}|${fingerprint}`)
    .digest('hex')
    .slice(0, 24);
  return `audit_contract_${digest}`;
}

function addFinding(
  bag: Map<string, ScannerFinding>,
  input: AddFindingInput,
) {
  const finding = ScannerFindingSchema.parse({
    id: buildAuditId(input.checkId, input.fingerprint),
    createdAt: new Date().toISOString(),
    checkId: input.checkId,
    mode: 'passive',
    severity: input.severity,
    confidence: input.confidence,
    status: 'open',
    title: input.title,
    summary: input.summary,
    remediation: input.remediation,
    reproducibility: input.reproducibility,
    tags: input.tags,
    evidence: input.evidence,
  });
  bag.set(finding.id, finding);
}

function findingDescription(finding: ScannerFinding): string {
  return [
    finding.summary,
    '',
    `Remediation: ${finding.remediation}`,
    '',
    'Reproducibility:',
    ...finding.reproducibility.map((step) => `- ${step}`),
    '',
    `Check: ${finding.checkId} (${finding.mode})`,
  ].join('\n');
}

function upsertAuditFindings(db: DatabaseSync, findings: ScannerFinding[]) {
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
    stmt.run(
      finding.id,
      finding.createdAt,
      finding.severity,
      finding.confidence,
      finding.title,
      findingDescription(finding),
      JSON.stringify(finding),
      finding.status,
    );
  }
}

type CommandResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  error: string | null;
};

function appendOutput(base: string, chunk: string): string {
  const next = base + chunk;
  if (next.length <= MAX_CAPTURED_TOOL_OUTPUT) return next;
  return next.slice(0, MAX_CAPTURED_TOOL_OUTPUT);
}

async function runCommand(
  bin: string,
  args: string[],
  timeoutMs: number,
): Promise<CommandResult> {
  return await new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';

    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let child;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      finish({
        ok: false,
        stdout: '',
        stderr: '',
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 150).unref();
      finish({
        ok: false,
        stdout,
        stderr,
        error: `timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);
    timer.unref();

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout = appendOutput(stdout, chunk.toString());
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr = appendOutput(stderr, chunk.toString());
    });
    child.once('error', (err) => {
      clearTimeout(timer);
      finish({
        ok: false,
        stdout,
        stderr,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        finish({ ok: true, stdout, stderr, error: null });
        return;
      }
      finish({
        ok: false,
        stdout,
        stderr,
        error: `exit_code=${code ?? 'null'} signal=${signal ?? 'null'}`,
      });
    });
  });
}

function parseCast4ByteSignatures(stdout: string): string[] {
  const lines = stdout
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return [];
  return lines.map((line) => line.replace(/^\d+\)\s*/, '')).filter((line) => line.includes('(') && line.includes(')'));
}

async function runCast4ByteLookup(selector: string | null): Promise<ContractAuditTooling> {
  const command = selector ? `cast 4byte ${selector}` : 'cast 4byte <selector>';
  const base: ContractAuditTooling = {
    tool: 'cast_4byte',
    attempted: selector != null,
    available: false,
    success: false,
    selector,
    signatures: [],
    command,
    output: null,
    error: null,
  };

  if (!selector) return base;

  const result = await runCommand('cast', ['4byte', selector], 4_500);
  const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n').trim();
  if (result.ok) {
    return {
      ...base,
      available: true,
      success: true,
      signatures: parseCast4ByteSignatures(result.stdout),
      output: output || null,
      error: null,
    };
  }

  const isMissing = result.error?.includes('ENOENT') ?? false;
  return {
    ...base,
    available: !isMissing,
    success: false,
    signatures: [],
    output: output || null,
    error: result.error,
  };
}

function safeErrorMessage(err: unknown, fallback: string): string {
  if (!err || typeof err !== 'object') return fallback;
  const msg = (err as { message?: unknown }).message;
  return typeof msg === 'string' && msg.trim() ? msg : fallback;
}

function sortFindings(items: ScannerFinding[]): ScannerFinding[] {
  return [...items].sort((a, b) => {
    if (severityRank(a.severity) !== severityRank(b.severity)) {
      return severityRank(b.severity) - severityRank(a.severity);
    }
    return b.createdAt.localeCompare(a.createdAt);
  });
}

function buildTxForRpc(req: ContractAuditRunRequest): Record<string, string> {
  const tx: Record<string, string> = {
    to: req.tx.to,
    data: req.tx.data,
  };
  const from = req.tx.from?.trim();
  if (from && isAddressLike(from)) tx.from = from;
  const value = toQuantityIfValid(req.tx.value ?? null);
  if (value) tx.value = value;
  const gas = toQuantityIfValid(req.tx.gas ?? null);
  if (gas) tx.gas = gas;
  return tx;
}

export async function runContractAudit(input: RunContractAuditInput): Promise<Omit<ContractAuditRunResponse, 'ok'>> {
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const checksRun = { count: 0 };
  const findings = new Map<string, ScannerFinding>();

  const req = input.request;
  const targetAddress = toLowerAddress(req.tx.to);
  const calldata = req.tx.data;
  const selector = selectorFromData(calldata);
  const sourceMessageId = req.sourceInteractionId ?? `sandbox:${targetAddress}`;

  const tool = await runCast4ByteLookup(selector);
  if (tool.attempted) checksRun.count += 1;

  if (selector && tool.available && tool.success && tool.signatures.length === 0) {
    addFinding(findings, {
      checkId: 'audit.contract.selector.unknown',
      fingerprint: `${targetAddress}|${selector}`,
      severity: 'medium',
      confidence: 0.74,
      title: 'Unknown function selector',
      summary:
        `Selector ${selector} did not resolve to known signatures via cast 4byte. Unknown selectors increase review burden and can hide privileged behavior.`,
      remediation:
        'Confirm the exact function signature from trusted ABI/source and require explicit user confirmation for opaque calldata.',
      reproducibility: [
        `Inspect selected interaction ${sourceMessageId} calldata.`,
        `Resolve selector ${selector} against trusted ABI metadata.`,
      ],
      tags: ['selector', 'abi', 'contract-audit'],
      evidence: [
        {
          messageId: sourceMessageId,
          field: 'tx.data',
          note: `Selector ${selector} unresolved by cast 4byte.`,
          replayVariantId: null,
        },
      ],
    });
  }

  const approve = parseApproveCalldata(calldata);
  checksRun.count += 1;
  if (approve && approve.amount >= (1n << 255n)) {
    const isMax = approve.amount === ((1n << 256n) - 1n);
    addFinding(findings, {
      checkId: 'audit.contract.approval.unlimited_erc20',
      fingerprint: `${targetAddress}|${approve.spender}|${approve.amount.toString()}`,
      severity: isMax ? 'high' : 'medium',
      confidence: 0.97,
      title: 'Potentially unlimited ERC-20 approval',
      summary:
        isMax
          ? `approve(spender=${approve.spender}, amount=max_uint256) grants unrestricted spending rights.`
          : `approve() amount is unusually large (${approve.amount.toString()}), approaching unrestricted spend.`,
      remediation:
        'Use exact-amount approvals where possible and enforce explicit confirmation when broad token allowances are requested.',
      reproducibility: [
        `Open interaction ${sourceMessageId}.`,
        'Decode tx.data as approve(address,uint256) and verify spender/amount.',
      ],
      tags: ['approval', 'erc20', 'contract-audit'],
      evidence: [
        {
          messageId: sourceMessageId,
          field: 'tx.data',
          note: `Decoded approve spender=${approve.spender} amount=${approve.amount.toString()}`,
          replayVariantId: null,
        },
      ],
    });
  }

  const approvalForAll = parseSetApprovalForAllCalldata(calldata);
  checksRun.count += 1;
  if (approvalForAll?.approved) {
    addFinding(findings, {
      checkId: 'audit.contract.approval.nft_approval_for_all',
      fingerprint: `${targetAddress}|${approvalForAll.operator}|setApprovalForAll:true`,
      severity: 'high',
      confidence: 0.95,
      title: 'setApprovalForAll enables full operator control',
      summary:
        `setApprovalForAll(operator=${approvalForAll.operator}, approved=true) allows operator-wide NFT transfer permissions.`,
      remediation:
        'Require high-friction user confirmation for operator approvals and include clear revoke guidance in UX.',
      reproducibility: [
        `Open interaction ${sourceMessageId}.`,
        'Decode tx.data as setApprovalForAll(address,bool) and verify approved=true.',
      ],
      tags: ['approval', 'nft', 'contract-audit'],
      evidence: [
        {
          messageId: sourceMessageId,
          field: 'tx.data',
          note: `Decoded setApprovalForAll operator=${approvalForAll.operator} approved=true`,
          replayVariantId: null,
        },
      ],
    });
  }

  const valueWei = parseBigIntLike(req.tx.value ?? null);
  checksRun.count += 1;
  if (valueWei != null && valueWei >= LARGE_VALUE_WEI) {
    addFinding(findings, {
      checkId: 'audit.contract.value.large_native_transfer',
      fingerprint: `${targetAddress}|${valueWei.toString()}`,
      severity: 'medium',
      confidence: 0.79,
      title: 'Large native value transfer',
      summary: `Transaction value is ${valueWei.toString()} wei (>= 5 ETH), which increases potential loss impact.`,
      remediation:
        'Require explicit value confirmation with human-readable ETH display and consider lower default transfer limits.',
      reproducibility: [
        `Inspect interaction ${sourceMessageId}.`,
        `Check tx.value (${valueWei.toString()} wei).`,
      ],
      tags: ['value', 'native-transfer', 'contract-audit'],
      evidence: [
        {
          messageId: sourceMessageId,
          field: 'tx.value',
          note: `${valueWei.toString()} wei`,
          replayVariantId: null,
        },
      ],
    });
  }

  if (selector) {
    checksRun.count += 1;
    const riskySelectorInfo: Record<string, { severity: FindingSeverity; label: string; note: string }> = {
      '0x3659cfe6': {
        severity: 'high',
        label: 'upgradeTo(address)',
        note: 'Proxy upgrade function selectors require strict governance and access control review.',
      },
      '0x4f1ef286': {
        severity: 'high',
        label: 'upgradeToAndCall(address,bytes)',
        note: 'Upgrade + delegatecall execution path can alter implementation and state in one step.',
      },
      '0xf2fde38b': {
        severity: 'medium',
        label: 'transferOwnership(address)',
        note: 'Ownership transfer functions can permanently change admin control.',
      },
      '0x715018a6': {
        severity: 'high',
        label: 'renounceOwnership()',
        note: 'Ownership renounce can disable recovery/admin controls permanently.',
      },
    };

    const risky = riskySelectorInfo[selector];
    if (risky) {
      addFinding(findings, {
        checkId: 'audit.contract.selector.privileged_action',
        fingerprint: `${targetAddress}|${selector}`,
        severity: risky.severity,
        confidence: 0.88,
        title: `Privileged selector detected (${risky.label})`,
        summary: risky.note,
        remediation:
          'Validate caller authorization, timelock/governance controls, and run this action only in controlled maintenance flows.',
        reproducibility: [
          `Inspect interaction ${sourceMessageId}.`,
          `Verify selector ${selector} (${risky.label}) and authorization path.`,
        ],
        tags: ['selector', 'admin-action', 'contract-audit'],
        evidence: [
          {
            messageId: sourceMessageId,
            field: 'tx.data',
            note: `Selector ${selector} (${risky.label})`,
            replayVariantId: null,
          },
        ],
      });
    }
  }

  const rpcCall = input.rpcCall;
  if (rpcCall) {
    const txForRpc = buildTxForRpc(req);

    checksRun.count += 1;
    try {
      const code = await rpcCall<string>('eth_getCode', [targetAddress, 'latest']);
      if (typeof code !== 'string' || code === '0x' || code.trim() === '0x') {
        addFinding(findings, {
          checkId: 'audit.contract.runtime.missing_code',
          fingerprint: `${targetAddress}|missing-code`,
          severity: 'critical',
          confidence: 0.98,
          title: 'Target address has no contract bytecode',
          summary:
            'The target resolved to an externally-owned account (or empty code). Contract-call calldata to non-contract targets is frequently an execution mismatch or phishing pattern.',
          remediation:
            'Verify target address against trusted allowlists and block contract calldata submissions when runtime code is empty.',
          reproducibility: [
            `Run eth_getCode(${targetAddress}, latest).`,
            'Confirm response is 0x.',
          ],
          tags: ['runtime', 'address-validation', 'contract-audit'],
          evidence: [
            {
              messageId: sourceMessageId,
              field: 'tx.to',
              note: `eth_getCode returned ${typeof code === 'string' ? code : String(code)}`,
              replayVariantId: null,
            },
          ],
        });
      } else {
        const opcodes = scanOpcodes(code);
        if ((opcodes[0xf4] ?? 0) > 0) {
          addFinding(findings, {
            checkId: 'audit.contract.bytecode.delegatecall_present',
            fingerprint: `${targetAddress}|delegatecall`,
            severity: 'high',
            confidence: 0.78,
            title: 'Runtime bytecode includes DELEGATECALL',
            summary:
              'DELEGATECALL usage can introduce upgradeability and storage-collision risks when implementation control is weak.',
            remediation:
              'Review delegatecall targets, upgrade authorization, and storage-layout compatibility for all delegate paths.',
            reproducibility: [
              `Run eth_getCode(${targetAddress}, latest).`,
              'Disassemble runtime bytecode and verify DELEGATECALL opcodes.',
            ],
            tags: ['bytecode', 'delegatecall', 'contract-audit'],
            evidence: [
              {
                messageId: sourceMessageId,
                field: 'tx.to',
                note: `Detected ${(opcodes[0xf4] ?? 0).toString()} DELEGATECALL opcode(s)`,
                replayVariantId: null,
              },
            ],
          });
        }
        if ((opcodes[0xff] ?? 0) > 0) {
          addFinding(findings, {
            checkId: 'audit.contract.bytecode.selfdestruct_present',
            fingerprint: `${targetAddress}|selfdestruct`,
            severity: 'high',
            confidence: 0.71,
            title: 'Runtime bytecode includes SELFDESTRUCT',
            summary:
              'SELFDESTRUCT-reachable logic can invalidate assumptions around code presence and interaction safety.',
            remediation:
              'Confirm whether selfdestruct is reachable in production paths and gate or remove it when unnecessary.',
            reproducibility: [
              `Run eth_getCode(${targetAddress}, latest).`,
              'Disassemble runtime bytecode and verify SELFDESTRUCT opcode presence.',
            ],
            tags: ['bytecode', 'selfdestruct', 'contract-audit'],
            evidence: [
              {
                messageId: sourceMessageId,
                field: 'tx.to',
                note: `Detected ${(opcodes[0xff] ?? 0).toString()} SELFDESTRUCT opcode(s)`,
                replayVariantId: null,
              },
            ],
          });
        }
      }
    } catch {
      // Skip RPC-driven bytecode checks when unavailable.
    }

    checksRun.count += 1;
    try {
      const estimate = await rpcCall<string>('eth_estimateGas', [txForRpc]);
      const estimateBigInt = parseBigIntLike(estimate);
      if (estimateBigInt != null && estimateBigInt >= LARGE_GAS_THRESHOLD) {
        addFinding(findings, {
          checkId: 'audit.contract.simulation.high_gas_estimate',
          fingerprint: `${targetAddress}|${estimateBigInt.toString()}`,
          severity: 'medium',
          confidence: 0.75,
          title: 'High gas estimate for target call',
          summary: `Estimated gas is ${estimateBigInt.toString()} (>= ${LARGE_GAS_THRESHOLD.toString()}).`,
          remediation:
            'Inspect the execution path for unbounded loops/heavy storage writes and confirm expected complexity.',
          reproducibility: [
            `Run eth_estimateGas for interaction ${sourceMessageId}.`,
            `Confirm returned gas estimate (${estimateBigInt.toString()}).`,
          ],
          tags: ['gas', 'simulation', 'contract-audit'],
          evidence: [
            {
              messageId: sourceMessageId,
              field: 'tx',
              note: `eth_estimateGas returned ${estimateBigInt.toString()}`,
              replayVariantId: null,
            },
          ],
        });
      }
    } catch (err) {
      const message = safeErrorMessage(err, 'eth_estimateGas failed.');
      if (/revert|invalid opcode|execution reverted/i.test(message)) {
        addFinding(findings, {
          checkId: 'audit.contract.simulation.estimate_reverted',
          fingerprint: `${targetAddress}|estimate-revert|${selector ?? 'none'}`,
          severity: 'medium',
          confidence: 0.82,
          title: 'Sandbox gas estimation reverted',
          summary: `eth_estimateGas failed with revert-like error: ${message}`,
          remediation:
            'Validate call preconditions and inputs before signing/sending, and require simulation success for high-risk actions.',
          reproducibility: [
            `Run eth_estimateGas on target ${targetAddress}.`,
            `Observe error: ${message}`,
          ],
          tags: ['simulation', 'revert', 'contract-audit'],
          evidence: [
            {
              messageId: sourceMessageId,
              field: 'tx',
              note: message,
              replayVariantId: null,
            },
          ],
        });
      }
    }

    checksRun.count += 1;
    try {
      await rpcCall<unknown>('eth_call', [txForRpc, 'latest']);
    } catch (err) {
      const message = safeErrorMessage(err, 'eth_call failed.');
      if (/revert|invalid opcode|execution reverted|panic/i.test(message)) {
        addFinding(findings, {
          checkId: 'audit.contract.simulation.call_reverted',
          fingerprint: `${targetAddress}|call-revert|${selector ?? 'none'}`,
          severity: 'high',
          confidence: 0.84,
          title: 'Sandbox call simulation reverted',
          summary: `eth_call indicates a revert path for this payload: ${message}`,
          remediation:
            'Inspect contract requirements and argument correctness before broadcast. Reject transactions that fail sandbox call simulation.',
          reproducibility: [
            `Run eth_call on target ${targetAddress}.`,
            `Observe error: ${message}`,
          ],
          tags: ['simulation', 'revert', 'contract-audit'],
          evidence: [
            {
              messageId: sourceMessageId,
              field: 'tx',
              note: message,
              replayVariantId: null,
            },
          ],
        });
      }
    }
  }

  const findingItems = sortFindings([...findings.values()]);
  upsertAuditFindings(input.db, findingItems);

  const bySeverity = {
    info: 0,
    low: 0,
    medium: 0,
    high: 0,
    critical: 0,
  };
  for (const item of findingItems) {
    bySeverity[item.severity] += 1;
  }

  const finishedAt = new Date().toISOString();
  return {
    runId,
    startedAt,
    finishedAt,
    method: req.method,
    target: {
      sourceInteractionId: req.sourceInteractionId ?? null,
      chainId: req.chainId ?? null,
      to: targetAddress,
      selector,
    },
    summary: {
      checksRun: checksRun.count,
      findingsTotal: findingItems.length,
      bySeverity,
    },
    tooling: tool,
    findings: findingItems,
  };
}
