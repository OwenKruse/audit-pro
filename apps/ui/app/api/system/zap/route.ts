import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';
import os from 'node:os';

const defaultZapApiUrl = process.env.ZAP_API_URL ?? 'http://127.0.0.1:8080';
const defaultZapBinary = process.env.ZAP_MACOS_BINARY ?? '/Applications/ZAP.app/Contents/Java/zap.sh';
const startupTimeoutMs = Number.parseInt(process.env.ZAP_STARTUP_TIMEOUT_MS ?? '8000', 10) || 8000;

type RouteOk = {
  ok: true;
  supported: boolean;
  apiUrl: string;
  command: string;
  running: boolean;
  version: string | null;
  notice?: string;
};

type RouteErr = {
  ok: false;
  error: {
    code: string;
    message: string;
  };
};

type LaunchConfig = {
  apiUrl: string;
  probeUrl: string;
  binary: string;
  args: string[];
  commandPreview: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function quoteArg(arg: string): string {
  if (/^[a-zA-Z0-9_./:=-]+$/.test(arg)) return arg;
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

function normalizeApiUrl(raw: string): URL {
  const trimmed = raw.trim();
  const fallback = new URL('http://127.0.0.1:8080');
  if (!trimmed) return fallback;

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return fallback;
    }
    return parsed;
  } catch {
    return fallback;
  }
}

function buildLaunchConfig(): LaunchConfig {
  const apiUrl = normalizeApiUrl(defaultZapApiUrl);
  const host = apiUrl.hostname || '127.0.0.1';
  const port = apiUrl.port || (apiUrl.protocol === 'https:' ? '443' : '80');
  const apikey = process.env.ZAP_API_KEY?.trim() || null;
  const probe = new URL('/JSON/core/view/version/', apiUrl);
  if (apikey) {
    probe.searchParams.set('apikey', apikey);
  }

  const args = ['-daemon', '-host', host, '-port', port];
  if (apikey) {
    args.push('-config', `api.key=${apikey}`);
  } else {
    args.push('-config', 'api.disablekey=true');
  }

  const previewArgs = [...args];
  if (apikey) {
    const idx = previewArgs.findIndex((item) => item.startsWith('api.key='));
    if (idx >= 0) previewArgs[idx] = 'api.key=***';
  }

  return {
    apiUrl: apiUrl.toString(),
    probeUrl: probe.toString(),
    binary: defaultZapBinary,
    args,
    commandPreview: [defaultZapBinary, ...previewArgs].map(quoteArg).join(' '),
  };
}

async function probeZap(config: LaunchConfig): Promise<{ running: boolean; version: string | null }> {
  let res: Response;
  try {
    res = await fetch(config.probeUrl, { cache: 'no-store' });
  } catch {
    return { running: false, version: null };
  }

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    return { running: res.ok, version: null };
  }

  const rec = asRecord(body);
  if (!rec) return { running: res.ok, version: null };
  const version = typeof rec.version === 'string' && rec.version.trim() ? rec.version : null;
  return { running: res.ok, version };
}

async function launchZap(config: LaunchConfig): Promise<void> {
  await access(config.binary, fsConstants.X_OK);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(config.binary, config.args, {
      detached: true,
      stdio: 'ignore',
    });

    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    child.once('error', (err) => done(() => reject(err)));
    child.once('spawn', () => done(resolve));

    setTimeout(() => done(resolve), 300);
    child.unref();
  });
}

async function buildStatusPayload(supported: boolean): Promise<RouteOk> {
  const config = buildLaunchConfig();
  const probe = supported ? await probeZap(config) : { running: false, version: null };
  return {
    ok: true,
    supported,
    apiUrl: config.apiUrl,
    command: config.commandPreview,
    running: probe.running,
    version: probe.version,
  };
}

function formatErr(err: unknown): string {
  if (err instanceof Error && err.message.trim()) return err.message;
  return String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function GET(): Promise<Response> {
  const supported = os.platform() === 'darwin';
  const payload = await buildStatusPayload(supported);
  return Response.json(payload, { headers: { 'cache-control': 'no-store' } });
}

export async function POST(): Promise<Response> {
  if (os.platform() !== 'darwin') {
    return Response.json(
      {
        ok: false,
        error: { code: 'not_supported', message: 'Starting ZAP is only supported on macOS.' },
      } satisfies RouteErr,
      { status: 400, headers: { 'cache-control': 'no-store' } },
    );
  }

  try {
    const config = buildLaunchConfig();
    const before = await probeZap(config);
    if (!before.running) {
      await launchZap(config);
      const deadline = Date.now() + startupTimeoutMs;
      while (Date.now() < deadline) {
        const next = await probeZap(config);
        if (next.running) {
          return Response.json(
            {
              ok: true,
              supported: true,
              apiUrl: config.apiUrl,
              command: config.commandPreview,
              running: true,
              version: next.version,
              notice: 'ZAP started.',
            } satisfies RouteOk,
            { headers: { 'cache-control': 'no-store' } },
          );
        }
        await sleep(400);
      }
    }

    const after = await probeZap(config);
    return Response.json(
      {
        ok: true,
        supported: true,
        apiUrl: config.apiUrl,
        command: config.commandPreview,
        running: after.running,
        version: after.version,
        notice: after.running ? 'ZAP is already running.' : 'Launch command sent. ZAP API is still starting.',
      } satisfies RouteOk,
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (err) {
    return Response.json(
      {
        ok: false,
        error: {
          code: 'zap_launch_failed',
          message: formatErr(err),
        },
      } satisfies RouteErr,
      { status: 500, headers: { 'cache-control': 'no-store' } },
    );
  }
}
