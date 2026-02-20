import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { insertHttpMessage, updateHttpMessageResponse } from './store.js';

const DEFAULT_SUBFINDER_BINARY = process.env.SUBFINDER_BINARY ?? 'subfinder';
const DEFAULT_MAX_CAPTURED_OUTPUT = 200_000;
const DEFAULT_TIMEOUT_MS = Number.parseInt(process.env.SUBFINDER_TIMEOUT_MS ?? '240000', 10) || 240_000;
const DEFAULT_HISTORY_MAX_HOSTS = Number.parseInt(process.env.SUBFINDER_HISTORY_MAX_HOSTS ?? '250', 10) || 250;
const BUILTIN_DEFAULT_SUBFINDER_SOURCES = [
  'anubis',
  'crtsh',
  'hackertarget',
  'rapiddns',
  'threatcrowd',
  'waybackarchive',
] as const;

export const RunSubfinderInputSchema = z.object({
  domain: z.string().trim().min(1).max(2048),
  recursive: z.boolean().optional(),
  allSources: z.boolean().optional(),
  activeOnly: z.boolean().optional(),
  timeoutSeconds: z.number().int().min(5).max(180).optional(),
  maxTimeMinutes: z.number().int().min(1).max(60).optional(),
  rateLimit: z.number().int().min(1).max(5000).optional(),
  sources: z.array(z.string().trim().min(1).max(120)).max(50).optional(),
  excludeSources: z.array(z.string().trim().min(1).max(120)).max(50).optional(),
});

export type RunSubfinderInput = z.infer<typeof RunSubfinderInputSchema>;

export type SubfinderRunResult = {
  command: string;
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  truncated: boolean;
  stdout: string;
  stderr: string;
  error: string | null;
};

export type SubfinderResult = {
  domain: string;
  options: {
    recursive: boolean;
    allSources: boolean;
    activeOnly: boolean;
    timeoutSeconds: number;
    maxTimeMinutes: number;
    rateLimit: number | null;
    sources: string[];
    excludeSources: string[];
  };
  run: SubfinderRunResult;
  count: number;
  subdomains: string[];
};

function sanitizeSourceTokens(tokens: string[], maxItems = 50): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of tokens) {
    const cleaned = item.trim().toLowerCase();
    if (!cleaned) continue;
    if (!/^[a-z0-9_-]+$/.test(cleaned)) continue;
    if (seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
    if (out.length >= maxItems) break;
  }
  return out;
}

function parseEnvSourceList(raw: string | undefined): string[] {
  const value = raw?.trim() ?? '';
  if (!value) return [];
  return sanitizeSourceTokens(value.split(/[,\n]+/));
}

const DEFAULT_SUBFINDER_SOURCES = (() => {
  const fromEnv = parseEnvSourceList(process.env.SUBFINDER_DEFAULT_SOURCES);
  if (fromEnv.length > 0) return fromEnv;
  return sanitizeSourceTokens([...BUILTIN_DEFAULT_SUBFINDER_SOURCES]);
})();

function appendOutput(current: string, nextChunk: string, maxCapturedOutput: number): { value: string; truncated: boolean } {
  if (current.length >= maxCapturedOutput) return { value: current, truncated: true };
  const next = current + nextChunk;
  if (next.length <= maxCapturedOutput) return { value: next, truncated: false };
  return { value: next.slice(0, maxCapturedOutput), truncated: true };
}

function quoteArg(arg: string): string {
  if (/^[a-zA-Z0-9_./:=-]+$/.test(arg)) return arg;
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

function normalizeHost(input: string): string | null {
  const host = input.trim().toLowerCase().replace(/\.+$/g, '');
  if (!host || host.length > 253) return null;
  if (!/^[a-z0-9.-]+$/.test(host)) return null;
  if (host.startsWith('-') || host.endsWith('-') || host.includes('..')) return null;

  const parts = host.split('.');
  if (parts.length < 2) return null;
  for (const part of parts) {
    if (!part || part.length > 63) return null;
    if (part.startsWith('-') || part.endsWith('-')) return null;
  }
  return host;
}

function sanitizeDomain(raw: string): string {
  const value = raw.trim();
  if (!value) throw new Error('Domain is required.');

  if (value.includes('://')) {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error('Domain must be a valid domain or URL.');
    }
    const host = normalizeHost(parsed.hostname);
    if (!host) throw new Error('Domain must be a valid host name.');
    return host;
  }

  const noWildcard = value.replace(/^\*\./, '');
  const noPath = noWildcard.split('/')[0] ?? noWildcard;
  const host = normalizeHost(noPath);
  if (!host) throw new Error('Domain must be a valid host name.');
  return host;
}

function parseSubdomains(stdout: string, rootDomain: string): string[] {
  const root = rootDomain.toLowerCase();
  const suffix = `.${root}`;
  const out = new Set<string>();

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim().toLowerCase();
    if (!line) continue;
    const firstToken = line.split(/\s+/)[0] ?? '';
    const host = normalizeHost(firstToken);
    if (!host) continue;
    if (host === root || host.endsWith(suffix)) out.add(host);
  }

  return [...out].sort((a, b) => a.localeCompare(b));
}

export async function runSubfinder(input: {
  request: unknown;
  db?: DatabaseSync;
  binary?: string;
  timeoutMs?: number;
  maxCapturedOutput?: number;
}): Promise<SubfinderResult> {
  const parsed = RunSubfinderInputSchema.parse(input.request);
  const domain = sanitizeDomain(parsed.domain);

  const recursive = parsed.recursive !== false;
  const allSources = parsed.allSources === true;
  const activeOnly = parsed.activeOnly === true;
  const timeoutSeconds = parsed.timeoutSeconds ?? 30;
  const maxTimeMinutes = parsed.maxTimeMinutes ?? 10;
  const rateLimit = parsed.rateLimit ?? null;
  const providedSources = sanitizeSourceTokens(parsed.sources ?? []);
  const sources = providedSources.length > 0 ? providedSources : DEFAULT_SUBFINDER_SOURCES;
  const excludeSources = sanitizeSourceTokens(parsed.excludeSources ?? []);

  const args = ['-d', domain, '-silent', '-nc', '-timeout', String(timeoutSeconds), '-max-time', String(maxTimeMinutes)];
  if (recursive) args.push('-recursive');
  if (allSources) args.push('-all');
  if (activeOnly) args.push('-nW');
  if (rateLimit != null) args.push('-rl', String(rateLimit));
  if (!allSources && sources.length) args.push('-s', sources.join(','));
  if (excludeSources.length) args.push('-es', excludeSources.join(','));

  const binary = input.binary?.trim() || DEFAULT_SUBFINDER_BINARY;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxCapturedOutput = input.maxCapturedOutput ?? DEFAULT_MAX_CAPTURED_OUTPUT;
  const command = [binary, ...args].map(quoteArg).join(' ');

  const startedAt = Date.now();
  const run = await new Promise<SubfinderRunResult>((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let truncated = false;

    const finish = (result: Omit<SubfinderRunResult, 'command' | 'durationMs' | 'truncated'>) => {
      if (settled) return;
      settled = true;
      resolve({
        command,
        durationMs: Date.now() - startedAt,
        truncated,
        ...result,
      });
    };

    let child;
    try {
      child = spawn(binary, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      finish({
        ok: false,
        exitCode: null,
        timedOut: false,
        stdout: '',
        stderr: '',
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 250).unref();
    }, timeoutMs);
    timer.unref();

    child.stdout?.on('data', (chunk: Buffer | string) => {
      const next = appendOutput(stdout, chunk.toString(), maxCapturedOutput);
      stdout = next.value;
      truncated = truncated || next.truncated;
    });

    child.stderr?.on('data', (chunk: Buffer | string) => {
      const next = appendOutput(stderr, chunk.toString(), maxCapturedOutput);
      stderr = next.value;
      truncated = truncated || next.truncated;
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      finish({
        ok: false,
        exitCode: null,
        timedOut,
        stdout,
        stderr,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const ok = !timedOut && code === 0;
      const error =
        timedOut
          ? `Timed out after ${Math.round(timeoutMs / 1000)}s.`
          : ok
            ? null
            : `subfinder exited with code ${code ?? 'unknown'}.`;
      finish({
        ok,
        exitCode: code,
        timedOut,
        stdout,
        stderr,
        error,
      });
    });
  });

  const subdomains = parseSubdomains(run.stdout, domain);

  if (input.db) {
    const maxHosts = Math.max(1, DEFAULT_HISTORY_MAX_HOSTS);
    const limited = subdomains.slice(0, maxHosts);
    const headers = {
      'x-cipherscope-source': ['subfinder'],
      'x-cipherscope-subfinder-root': [domain],
      'user-agent': ['cipherscope-subfinder'],
    };
    for (const host of limited) {
      const id = randomUUID();
      const createdAt = new Date().toISOString();
      const url = `https://${host}/`;

      insertHttpMessage(input.db, {
        id,
        parentId: null,
        createdAt,
        scheme: 'https',
        host,
        port: 443,
        method: 'GET',
        path: '/',
        url,
        state: 'captured',
        requestHeaders: headers,
        requestCookies: {},
        requestQuery: {},
        requestBody: null,
        requestBodyText: null,
        requestBodyJson: null,
        timingJson: JSON.stringify({
          dnsMs: null,
          connectMs: null,
          tlsMs: null,
          ttfbMs: null,
          totalMs: 0,
        }),
        error: null,
      });

      updateHttpMessageResponse(input.db, {
        id,
        state: 'captured',
        responseStatus: 200,
        responseHeaders: {
          'x-cipherscope-source': ['subfinder'],
          'content-type': ['text/plain'],
        },
        responseBody: null,
        responseBodyText: `Discovered by Subfinder (${domain}).`,
        responseBodyJson: null,
        timingJson: JSON.stringify({
          dnsMs: null,
          connectMs: null,
          tlsMs: null,
          ttfbMs: null,
          totalMs: 0,
        }),
        error: null,
      });
    }
  }

  return {
    domain,
    options: {
      recursive,
      allSources,
      activeOnly,
      timeoutSeconds,
      maxTimeMinutes,
      rateLimit,
      sources,
      excludeSources,
    },
    run,
    count: subdomains.length,
    subdomains,
  };
}
