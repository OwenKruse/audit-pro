import { once } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';

type FoundryConfig = {
  enabled: boolean;
  autoStart: boolean;
  binary: string;
  host: string;
  port: number;
  chainId: number;
  startupTimeoutMs: number;
  forkUrl: string | null;
  forkFallbackUrls: string[];
  forkBlockNumber: number | null;
  blockTime: number | null;
  extraArgs: string[];
};

export type FoundryConfigOverrides = {
  forkUrl?: string | null;
  forkBlockNumber?: number | null;
  chainId?: number | null;
};

export type FoundryManagerCreateOptions = {
  overrides?: FoundryConfigOverrides | null;
};

type RpcEnvelope<T> = {
  jsonrpc?: unknown;
  id?: unknown;
  result?: T;
  error?: { code?: unknown; message?: unknown; data?: unknown };
};

export class FoundryRpcError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data: unknown) {
    super(message);
    this.name = 'FoundryRpcError';
    this.code = code;
    this.data = data;
  }
}

export type FoundryStatus = {
  enabled: boolean;
  autoStart: boolean;
  rpcUrl: string;
  managed: boolean;
  running: boolean;
  pid: number | null;
  binary: string;
  resolvedBinary: string | null;
  host: string;
  port: number;
  chainId: number;
  forkUrl: string | null;
  forkBlockNumber: number | null;
  blockTime: number | null;
  startupError: string | null;
};

const DEFAULT_FORK_URL = 'https://ethereum-rpc.publicnode.com';
const DEFAULT_FORK_FALLBACK_URLS = [
  'https://eth.llamarpc.com',
  'https://eth.merkle.io',
  'https://rpc.flashbots.net',
];

export type FoundryManager = {
  status: () => FoundryStatus;
  rpcCall: <T = unknown>(method: string, params?: unknown[]) => Promise<T>;
  stop: () => Promise<void>;
};

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  if (raw === '1' || raw.toLowerCase() === 'true') return true;
  if (raw === '0' || raw.toLowerCase() === 'false') return false;
  return fallback;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.trunc(parsed);
}

function envOptionalInt(name: string): number | null {
  const raw = process.env[name];
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return null;
  return Math.trunc(parsed);
}

function envOptionalString(name: string, fallback: string | null = null): string | null {
  const raw = process.env[name];
  if (raw == null) return fallback;
  const out = raw.trim();
  return out ? out : null;
}

function envString(name: string, fallback: string): string {
  const raw = process.env[name];
  if (!raw) return fallback;
  const out = raw.trim();
  return out ? out : fallback;
}

function envArgs(name: string): string[] {
  const raw = process.env[name];
  if (!raw) return [];
  return raw
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function envUrlList(name: string): string[] {
  const raw = process.env[name];
  if (!raw) return [];
  return uniqueStrings(
    raw
      .split(/[,\s]+/g)
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function isTestRuntime(): boolean {
  return (
    process.env.NODE_ENV === 'test' ||
    !!process.env.VITEST ||
    !!process.env.VITEST_POOL_ID ||
    !!process.env.JEST_WORKER_ID
  );
}

function loadConfig(): FoundryConfig {
  const testRuntime = isTestRuntime();
  const defaultEnabled = !testRuntime;
  const fallbackUrls = uniqueStrings([
    ...envUrlList('AGENT_FOUNDRY_FORK_FALLBACK_URLS'),
    ...DEFAULT_FORK_FALLBACK_URLS,
  ]);
  return {
    enabled: envBool('AGENT_FOUNDRY_ENABLED', defaultEnabled),
    autoStart: envBool('AGENT_FOUNDRY_AUTOSTART', true),
    binary: envString('AGENT_FOUNDRY_BINARY', 'anvil'),
    host: envString('AGENT_FOUNDRY_RPC_HOST', '127.0.0.1'),
    port: envInt('AGENT_FOUNDRY_RPC_PORT', 8545),
    chainId: envInt('AGENT_FOUNDRY_CHAIN_ID', 1),
    startupTimeoutMs: envInt('AGENT_FOUNDRY_STARTUP_TIMEOUT_MS', 15_000),
    forkUrl: envOptionalString('AGENT_FOUNDRY_FORK_URL', DEFAULT_FORK_URL),
    forkFallbackUrls: fallbackUrls,
    forkBlockNumber: envOptionalInt('AGENT_FOUNDRY_FORK_BLOCK_NUMBER'),
    blockTime: envOptionalInt('AGENT_FOUNDRY_BLOCK_TIME'),
    extraArgs: envArgs('AGENT_FOUNDRY_ARGS'),
  };
}

function applyOverrides(
  config: FoundryConfig,
  overrides: FoundryConfigOverrides | null | undefined,
): FoundryConfig {
  if (!overrides) return config;
  const out: FoundryConfig = { ...config };
  if (Object.prototype.hasOwnProperty.call(overrides, 'forkUrl')) {
    out.forkUrl = overrides.forkUrl ?? null;
  }
  if (Object.prototype.hasOwnProperty.call(overrides, 'forkBlockNumber')) {
    out.forkBlockNumber = overrides.forkBlockNumber ?? null;
  }
  if (Object.prototype.hasOwnProperty.call(overrides, 'chainId')) {
    const chainId = overrides.chainId;
    if (typeof chainId === 'number' && Number.isInteger(chainId) && chainId > 0) {
      out.chainId = chainId;
    }
  }
  if (!out.forkUrl) {
    out.forkUrl = null;
    out.forkBlockNumber = null;
  }
  return out;
}

function toRpcUrl(config: FoundryConfig): string {
  return `http://${config.host}:${config.port}`;
}

function expandHomePath(input: string): string {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/')) return path.join(os.homedir(), input.slice(2));
  return input;
}

function hasPathSeparator(input: string): boolean {
  return input.includes('/') || input.includes('\\');
}

function uniqueStrings(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function buildBinaryCandidates(binary: string): string[] {
  const expanded = expandHomePath(binary);
  const values = [expanded];
  if (!hasPathSeparator(expanded)) {
    const binName = path.basename(expanded);
    values.push(path.join(os.homedir(), '.foundry', 'bin', binName));
    values.push(path.join('/opt/homebrew/bin', binName));
    values.push(path.join('/usr/local/bin', binName));
  }
  return uniqueStrings(values);
}

async function isExecutable(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

type BinaryResolution = {
  spawnBinary: string;
  resolvedBinary: string | null;
  candidates: string[];
};

async function resolveBinary(binary: string): Promise<BinaryResolution> {
  const candidates = buildBinaryCandidates(binary);
  for (const candidate of candidates) {
    if (!hasPathSeparator(candidate)) continue;
    if (await isExecutable(candidate)) {
      return { spawnBinary: candidate, resolvedBinary: candidate, candidates };
    }
  }
  return { spawnBinary: expandHomePath(binary), resolvedBinary: null, candidates };
}

function withBinaryHint(message: string, candidates: string[]): string {
  if (!message.includes('ENOENT')) return message;
  const checked = candidates.filter((item) => hasPathSeparator(item));
  const checkedText = checked.length ? ` Checked: ${checked.join(', ')}.` : '';
  return `${message}. Foundry binary not found. Install Foundry via "foundryup" or set AGENT_FOUNDRY_BINARY.${checkedText}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pushOutputLines(buffer: string[], chunk: string, maxLines = 80) {
  const lines = chunk
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    buffer.push(line);
    if (buffer.length > maxLines) buffer.shift();
  }
}

function outputSnippet(buffer: string[], maxLines = 6): string | null {
  if (!buffer.length) return null;
  const lines = buffer.slice(Math.max(0, buffer.length - maxLines));
  const text = lines.join(' | ');
  return text.length > 600 ? `${text.slice(0, 600)}...` : text;
}

function outputLooksLikeHtml(buffer: string[]): boolean {
  if (!buffer.length) return false;
  const joined = buffer.join('\n').toLowerCase();
  return (
    joined.includes('<html') ||
    joined.includes('</html>') ||
    joined.includes('cf-wrapper') ||
    joined.includes('_cf_translation')
  );
}

function textLooksLikeHtml(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return false;
  return (
    normalized.includes('<html') ||
    normalized.includes('</html>') ||
    normalized.includes('cf-wrapper') ||
    normalized.includes('_cf_translation') ||
    normalized.includes('<!doctype html')
  );
}

function parseRpcErrorCode(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  return -32000;
}

function parseRpcErrorMessage(value: unknown): string {
  if (typeof value === 'string' && value.trim()) return value;
  return 'JSON-RPC error';
}

async function rpcCall<T>(
  rpcUrl: string,
  method: string,
  params: unknown[],
  timeoutMs = 8_000,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method,
        params,
      }),
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`Foundry RPC HTTP ${res.status}: ${res.statusText}`);
    }
    const payload = (await res.json()) as RpcEnvelope<T>;
    if (payload?.error) {
      throw new FoundryRpcError(
        parseRpcErrorCode(payload.error.code),
        parseRpcErrorMessage(payload.error.message),
        payload.error.data ?? null,
      );
    }
    return (payload?.result ?? null) as T;
  } finally {
    clearTimeout(timeout);
  }
}

async function rpcReachable(rpcUrl: string): Promise<boolean> {
  try {
    await rpcCall<string>(rpcUrl, 'web3_clientVersion', [], 1_200);
    return true;
  } catch {
    return false;
  }
}

async function probeForkRpcEndpoint(
  forkUrl: string,
  timeoutMs = 3_500,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(forkUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'eth_chainId',
        params: [],
      }),
      cache: 'no-store',
      signal: controller.signal,
    });

    const rawText = await res.text().catch(() => '');
    if (!res.ok) {
      if (textLooksLikeHtml(rawText)) {
        return { ok: false, reason: `HTTP ${res.status} returned HTML (likely bot protection)` };
      }
      return { ok: false, reason: `HTTP ${res.status} ${res.statusText}` };
    }

    if (textLooksLikeHtml(rawText)) {
      return { ok: false, reason: 'response is HTML, not JSON-RPC' };
    }

    let parsed: unknown;
    try {
      parsed = rawText ? (JSON.parse(rawText) as unknown) : null;
    } catch {
      return { ok: false, reason: 'response is not valid JSON' };
    }

    if (!parsed || typeof parsed !== 'object') {
      return { ok: false, reason: 'response is not a JSON-RPC object' };
    }

    const envelope = parsed as RpcEnvelope<unknown>;
    if (typeof envelope.result === 'string') return { ok: true };
    if (envelope.error && typeof envelope.error === 'object') return { ok: true };
    return { ok: false, reason: 'response is missing JSON-RPC result/error fields' };
  } catch (err) {
    return {
      ok: false,
      reason:
        err instanceof Error
          ? err.name === 'AbortError'
            ? `timeout after ${timeoutMs}ms`
            : err.message
          : String(err),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function buildAnvilArgs(config: FoundryConfig): string[] {
  const args = [
    '--host',
    config.host,
    '--port',
    String(config.port),
    '--chain-id',
    String(config.chainId),
  ];
  if (config.forkUrl) {
    args.push('--fork-url', config.forkUrl);
  }
  if (config.forkBlockNumber != null && config.forkBlockNumber > 0) {
    args.push('--fork-block-number', String(config.forkBlockNumber));
  }
  if (config.blockTime != null && config.blockTime > 0) {
    args.push('--block-time', String(config.blockTime));
  }
  args.push(...config.extraArgs);
  return args;
}

async function stopChildProcess(
  child: ChildProcess,
  log: FastifyBaseLogger,
): Promise<void> {
  if (child.pid == null) return;
  if (child.exitCode != null || child.signalCode) return;

  const exitPromise = once(child, 'exit').catch(() => []);
  child.kill('SIGTERM');

  await Promise.race([exitPromise, sleep(3_000)]);

  if (child.exitCode == null && child.signalCode == null) {
    child.kill('SIGKILL');
    await Promise.race([exitPromise, sleep(1_000)]);
  }

  log.info('foundry process stopped');
}

type StartAttemptResult = {
  child: ChildProcess | null;
  managed: boolean;
  running: boolean;
  startupError: string | null;
  outputBuffer: string[];
};

async function startManagedFoundryAttempt(
  log: FastifyBaseLogger,
  binaryResolution: BinaryResolution,
  config: FoundryConfig,
  rpcUrl: string,
): Promise<StartAttemptResult> {
  const outputBuffer: string[] = [];
  let child: ChildProcess | null = null;
  let managed = false;
  let running = false;
  let startupError: string | null = null;

  const args = buildAnvilArgs(config);
  try {
    child = spawn(binaryResolution.spawnBinary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    managed = true;
  } catch (err) {
    const rawError = err instanceof Error ? err.message : String(err);
    startupError = withBinaryHint(rawError, binaryResolution.candidates);
    return { child, managed, running, startupError, outputBuffer };
  }

  let childSpawnError: Error | null = null;
  child.once('error', (err) => {
    childSpawnError = err instanceof Error ? err : new Error(String(err));
    startupError = withBinaryHint(childSpawnError.message, binaryResolution.candidates);
    const snippet = outputSnippet(outputBuffer);
    if (snippet) startupError = `${startupError}. Output: ${snippet}`;
    log.warn(
      {
        err: startupError,
        binary: config.binary,
        resolvedBinary: binaryResolution.resolvedBinary,
        spawnBinary: binaryResolution.spawnBinary,
        candidates: binaryResolution.candidates,
      },
      'foundry process error',
    );
  });
  child.stdout?.on('data', (buf: Buffer) => {
    const raw = buf.toString('utf8');
    pushOutputLines(outputBuffer, raw);
    const text = raw.trim();
    if (text) log.debug({ foundry: text }, 'foundry stdout');
  });
  child.stderr?.on('data', (buf: Buffer) => {
    const raw = buf.toString('utf8');
    pushOutputLines(outputBuffer, raw);
    const text = raw.trim();
    if (text) log.debug({ foundry: text }, 'foundry stderr');
  });
  child.once('exit', (code, signal) => {
    running = false;
    if (!startupError && code !== 0) {
      startupError = `Foundry exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`;
      const snippet = outputSnippet(outputBuffer);
      if (snippet) startupError = `${startupError}. Output: ${snippet}`;
    }
    log.info({ code, signal }, 'foundry process exited');
  });

  const deadline = Date.now() + Math.max(1_000, config.startupTimeoutMs);
  while (Date.now() < deadline) {
    if (childSpawnError) break;
    if (await rpcReachable(rpcUrl)) {
      running = true;
      startupError = null;
      break;
    }
    if (child.exitCode != null || child.signalCode != null) break;
    await sleep(250);
  }

  if (!running) {
    if (!startupError) {
      startupError = `Foundry RPC did not become ready within ${config.startupTimeoutMs}ms`;
      const snippet = outputSnippet(outputBuffer);
      if (snippet) startupError = `${startupError}. Output: ${snippet}`;
    }
    if (outputLooksLikeHtml(outputBuffer)) {
      startupError = `${startupError}. Upstream fork RPC appears to be returning HTML (likely bot protection) instead of JSON-RPC.`;
    }
    await stopChildProcess(child, log);
    child = null;
    managed = false;
  }

  return { child, managed, running, startupError, outputBuffer };
}

export async function createFoundryManager(
  log: FastifyBaseLogger,
  opts: FoundryManagerCreateOptions = {},
): Promise<FoundryManager> {
  const config = applyOverrides(loadConfig(), opts.overrides);
  const rpcUrl = toRpcUrl(config);

  let child: ChildProcess | null = null;
  let managed = false;
  let running = false;
  let startupError: string | null = null;
  let resolvedBinary: string | null = null;
  let effectiveForkUrl: string | null = config.forkUrl;

  if (!config.enabled) {
    log.info({ rpcUrl }, 'foundry manager disabled');
  } else {
    running = await rpcReachable(rpcUrl);
    if (running) {
      log.info({ rpcUrl }, 'foundry rpc already reachable; using existing process');
    } else if (!config.autoStart) {
      log.info({ rpcUrl }, 'foundry autostart disabled and rpc is not reachable');
    } else {
      const binaryResolution = await resolveBinary(config.binary);
      resolvedBinary = binaryResolution.resolvedBinary;
      const forkCandidates =
        config.forkUrl ?
          uniqueStrings([config.forkUrl, ...config.forkFallbackUrls])
        : [null];

      for (let i = 0; i < forkCandidates.length; i += 1) {
        const forkUrlCandidate = forkCandidates[i] ?? null;
        const isRetry = i > 0;
        if (forkUrlCandidate) {
          const probe = await probeForkRpcEndpoint(forkUrlCandidate);
          if (!probe.ok) {
            startupError = `Fork RPC preflight failed for ${forkUrlCandidate}: ${probe.reason}`;
            log.warn(
              { forkUrl: forkUrlCandidate, reason: probe.reason },
              'skipping fork rpc candidate after failed preflight',
            );
            continue;
          }
        }
        const attemptConfig: FoundryConfig = {
          ...config,
          forkUrl: forkUrlCandidate,
          forkBlockNumber: forkUrlCandidate ? config.forkBlockNumber : null,
        };

        if (isRetry) {
          log.warn(
            {
              previousError: startupError,
              retryForkUrl: forkUrlCandidate,
            },
            'retrying foundry startup with fallback fork rpc',
          );
        }

        const attempt = await startManagedFoundryAttempt(log, binaryResolution, attemptConfig, rpcUrl);
        child = attempt.child;
        managed = attempt.managed;
        running = attempt.running;
        startupError = attempt.startupError;

        if (running && child) {
          effectiveForkUrl = forkUrlCandidate;
          if (forkUrlCandidate && forkUrlCandidate !== config.forkUrl) {
            log.warn(
              { forkUrl: forkUrlCandidate, originalForkUrl: config.forkUrl },
              'foundry started using fallback fork rpc',
            );
          }
          break;
        }

        if (i === forkCandidates.length - 1) {
          log.warn(
            { rpcUrl, startupError, binary: config.binary, resolvedBinary },
            'foundry start unsuccessful',
          );
        }
      }

      if (running && child) {
        log.info(
          { rpcUrl, pid: child.pid, chainId: config.chainId, binary: config.binary, resolvedBinary, forkUrl: effectiveForkUrl },
          'foundry rpc started',
        );
      }
    }
  }

  return {
    status() {
      const pid = child?.pid ?? null;
      const processAlive =
        child != null ? child.exitCode == null && child.signalCode == null : false;
      return {
        enabled: config.enabled,
        autoStart: config.autoStart,
        rpcUrl,
        managed,
        running: running || processAlive,
        pid,
        binary: config.binary,
        resolvedBinary,
        host: config.host,
        port: config.port,
        chainId: config.chainId,
        forkUrl: effectiveForkUrl,
        forkBlockNumber: config.forkBlockNumber,
        blockTime: config.blockTime,
        startupError,
      };
    },
    async rpcCall<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
      if (!config.enabled) {
        throw new Error('Foundry manager is disabled.');
      }
      return rpcCall<T>(rpcUrl, method, params);
    },
    async stop() {
      if (child) {
        await stopChildProcess(child, log);
        child = null;
      }
      running = false;
      managed = false;
    },
  };
}
