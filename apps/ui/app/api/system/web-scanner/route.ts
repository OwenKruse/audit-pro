import { homedir } from 'node:os';
import { spawn } from 'node:child_process';

export const runtime = 'nodejs';

const FEROXBUSTER_DEFAULT_WORDLIST = `${homedir()}/tools/SecLists/Discovery/Web-Content/raft-medium-directories.txt`;

const MAX_CAPTURED_OUTPUT = 160_000;
const TOOL_TIMEOUT_MS = 180_000;

type ToolName = 'feroxbuster' | 'nuclei';

type ToolRunResult = {
  tool: ToolName;
  command: string;
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  error: string | null;
  durationMs: number;
  truncated: boolean;
};

type RouteOk = {
  ok: true;
  target: string;
  runs: ToolRunResult[];
};

type RouteErr = {
  ok: false;
  error: { code: string; message: string };
};

function appendOutput(current: string, nextChunk: string): { value: string; truncated: boolean } {
  if (current.length >= MAX_CAPTURED_OUTPUT) return { value: current, truncated: true };
  const next = current + nextChunk;
  if (next.length <= MAX_CAPTURED_OUTPUT) return { value: next, truncated: false };
  return { value: next.slice(0, MAX_CAPTURED_OUTPUT), truncated: true };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function sanitizeTarget(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const input = raw.trim();
  if (!input || input.length > 2048) return null;
  try {
    const url = new URL(input);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

function toIntInRange(raw: unknown, fallback: number, min: number, max: number): number {
  if (typeof raw !== 'string' && typeof raw !== 'number') return fallback;
  const parsed = typeof raw === 'number' ? raw : Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function sanitizeOptionalText(raw: unknown, maxLen: number): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value) return null;
  if (value.length > maxLen) return value.slice(0, maxLen);
  return value;
}

async function runCommand(tool: ToolName, args: string[]): Promise<ToolRunResult> {
  const startedAt = Date.now();

  return await new Promise<ToolRunResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let truncated = false;

    const command = [tool, ...args].join(' ');

    const finish = (result: Omit<ToolRunResult, 'command' | 'durationMs' | 'truncated'>) => {
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
      child = spawn(tool, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      finish({
        tool,
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
      setTimeout(() => child.kill('SIGKILL'), 200).unref();
    }, TOOL_TIMEOUT_MS);
    timer.unref();

    child.stdout?.on('data', (chunk: Buffer | string) => {
      const next = appendOutput(stdout, chunk.toString());
      stdout = next.value;
      truncated = truncated || next.truncated;
    });

    child.stderr?.on('data', (chunk: Buffer | string) => {
      const next = appendOutput(stderr, chunk.toString());
      stderr = next.value;
      truncated = truncated || next.truncated;
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      finish({
        tool,
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
      finish({
        tool,
        ok,
        exitCode: code,
        timedOut,
        stdout,
        stderr,
        error: timedOut ? `Timed out after ${TOOL_TIMEOUT_MS / 1000}s.` : null,
      });
    });
  });
}

export async function POST(req: Request): Promise<Response> {
  const body = asRecord(await req.json().catch(() => null));
  if (!body) {
    return Response.json(
      { ok: false, error: { code: 'bad_request', message: 'Request body must be JSON.' } } satisfies RouteErr,
      { status: 400, headers: { 'cache-control': 'no-store' } },
    );
  }

  const target = sanitizeTarget(body.target);
  if (!target) {
    return Response.json(
      { ok: false, error: { code: 'bad_request', message: 'Provide a valid http(s) target URL.' } } satisfies RouteErr,
      { status: 400, headers: { 'cache-control': 'no-store' } },
    );
  }

  const runFeroxbuster = body.runFeroxbuster !== false;
  const runNuclei = body.runNuclei !== false;
  if (!runFeroxbuster && !runNuclei) {
    return Response.json(
      { ok: false, error: { code: 'bad_request', message: 'Select at least one tool to run.' } } satisfies RouteErr,
      { status: 400, headers: { 'cache-control': 'no-store' } },
    );
  }

  const feroxDepth = toIntInRange(body.feroxDepth, 2, 1, 8);
  const feroxThreads = toIntInRange(body.feroxThreads, 20, 1, 80);
  const feroxWordlist = sanitizeOptionalText(body.feroxWordlist, 400);

  const nucleiSeverity = sanitizeOptionalText(body.nucleiSeverity, 120);
  const nucleiTags = sanitizeOptionalText(body.nucleiTags, 200);
  const nucleiTemplates = sanitizeOptionalText(body.nucleiTemplates, 300);

  const runs: ToolRunResult[] = [];

  if (runFeroxbuster) {
    const wordlist = feroxWordlist ?? FEROXBUSTER_DEFAULT_WORDLIST;
    const args = ['--url', target, '-w', wordlist, '--depth', String(feroxDepth), '--threads', String(feroxThreads)];
    runs.push(await runCommand('feroxbuster', args));
  }

  if (runNuclei) {
    const args = ['-u', target, '-silent'];
    if (nucleiSeverity) args.push('-severity', nucleiSeverity);
    if (nucleiTags) args.push('-tags', nucleiTags);
    if (nucleiTemplates) args.push('-t', nucleiTemplates);
    runs.push(await runCommand('nuclei', args));
  }

  return Response.json(
    { ok: true, target, runs } satisfies RouteOk,
    { headers: { 'cache-control': 'no-store' } },
  );
}
