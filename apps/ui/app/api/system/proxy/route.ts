import { AgentClient } from '@cipherscope/sdk';
import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const agentHttpUrl = process.env.AGENT_HTTP_URL ?? 'http://127.0.0.1:17400';
const defaultService = process.env.SYSTEM_PROXY_SERVICE ?? 'Wi-Fi';
const defaultProxyHost = '127.0.0.1';
const fallbackProxyPort = Number.parseInt(process.env.SYSTEM_PROXY_FALLBACK_PORT ?? '18080', 10) || 18080;

type RouteOk = {
  ok: true;
  supported: boolean;
  service: string;
  desired: { host: string; port: number; source: 'agent' | 'fallback' };
  systemProxyEnabled: boolean;
  web: { enabled: boolean; host: string | null; port: number | null };
  secureWeb: { enabled: boolean; host: string | null; port: number | null };
};

type RouteErr = {
  ok: false;
  error: { code: string; message: string };
};

function parseEnabled(output: string): boolean {
  return /Enabled:\s*Yes/i.test(output);
}

function parseHost(output: string): string | null {
  const match = output.match(/Server:\s*(.+)/i);
  if (!match) return null;
  const value = match[1]?.trim() ?? '';
  if (!value || value.toLowerCase() === 'n/a') return null;
  return value;
}

function parsePort(output: string): number | null {
  const match = output.match(/Port:\s*(\d+)/i);
  if (!match) return null;
  const parsed = Number.parseInt(match[1] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function formatCmdError(err: unknown): string {
  if (!err || typeof err !== 'object') return String(err);
  const message = (err as { message?: unknown }).message;
  const stderr = (err as { stderr?: unknown }).stderr;
  if (typeof stderr === 'string' && stderr.trim()) return stderr.trim();
  if (typeof message === 'string' && message.trim()) return message.trim();
  return String(err);
}

async function runNetworksetup(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('networksetup', args, { encoding: 'utf8' });
  return stdout ?? '';
}

async function readDesiredProxy(): Promise<{ host: string; port: number; source: 'agent' | 'fallback' }> {
  const client = new AgentClient({ httpBaseUrl: agentHttpUrl });
  try {
    const status = await client.proxyStatus();
    if (status.ok && status.proxy.port > 0) {
      return { host: defaultProxyHost, port: status.proxy.port, source: 'agent' };
    }
  } catch {
    // Use fallback port when agent is unreachable.
  }
  return { host: defaultProxyHost, port: fallbackProxyPort, source: 'fallback' };
}

async function readMacProxyStatus(service: string): Promise<RouteOk> {
  const [desired, webRaw, secureRaw] = await Promise.all([
    readDesiredProxy(),
    runNetworksetup(['-getwebproxy', service]),
    runNetworksetup(['-getsecurewebproxy', service]),
  ]);

  const web = {
    enabled: parseEnabled(webRaw),
    host: parseHost(webRaw),
    port: parsePort(webRaw),
  };
  const secureWeb = {
    enabled: parseEnabled(secureRaw),
    host: parseHost(secureRaw),
    port: parsePort(secureRaw),
  };

  return {
    ok: true,
    supported: true,
    service,
    desired,
    systemProxyEnabled: web.enabled && secureWeb.enabled,
    web,
    secureWeb,
  };
}

function sanitizeService(input: unknown): string {
  if (typeof input !== 'string') return defaultService;
  const out = input.trim();
  return out.length > 0 ? out.slice(0, 120) : defaultService;
}

async function setMacProxyEnabled(service: string, enabled: boolean): Promise<void> {
  const desired = await readDesiredProxy();
  const enableCmds = [
    ['-setwebproxy', service, desired.host, String(desired.port)],
    ['-setsecurewebproxy', service, desired.host, String(desired.port)],
    ['-setwebproxystate', service, 'on'],
    ['-setsecurewebproxystate', service, 'on'],
  ];
  const disableCmds = [
    ['-setwebproxystate', service, 'off'],
    ['-setsecurewebproxystate', service, 'off'],
  ];

  const cmds = enabled ? enableCmds : disableCmds;
  for (const args of cmds) {
    await runNetworksetup(args);
  }
}

export async function GET(req: Request): Promise<Response> {
  const service = sanitizeService(new URL(req.url).searchParams.get('service'));
  if (os.platform() !== 'darwin') {
    return Response.json(
      {
        ok: true,
        supported: false,
        service,
        desired: { host: defaultProxyHost, port: fallbackProxyPort, source: 'fallback' },
        systemProxyEnabled: false,
        web: { enabled: false, host: null, port: null },
        secureWeb: { enabled: false, host: null, port: null },
      } satisfies RouteOk,
      { headers: { 'cache-control': 'no-store' } },
    );
  }

  try {
    const payload = await readMacProxyStatus(service);
    return Response.json(payload, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    return Response.json(
      {
        ok: false,
        error: {
          code: 'networksetup_failed',
          message: formatCmdError(err),
        },
      } satisfies RouteErr,
      { status: 500, headers: { 'cache-control': 'no-store' } },
    );
  }
}

export async function POST(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => null)) as { enabled?: unknown; service?: unknown } | null;
  if (!body || typeof body.enabled !== 'boolean') {
    return Response.json(
      { ok: false, error: { code: 'bad_request', message: 'Body must include { enabled: boolean }.' } } satisfies RouteErr,
      { status: 400 },
    );
  }

  const service = sanitizeService(body.service);
  if (os.platform() !== 'darwin') {
    return Response.json(
      { ok: false, error: { code: 'not_supported', message: 'System proxy toggle is only supported on macOS.' } } satisfies RouteErr,
      { status: 400 },
    );
  }

  try {
    await setMacProxyEnabled(service, body.enabled);
    const payload = await readMacProxyStatus(service);
    return Response.json(payload, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    return Response.json(
      {
        ok: false,
        error: {
          code: 'networksetup_failed',
          message: formatCmdError(err),
        },
      } satisfies RouteErr,
      { status: 500, headers: { 'cache-control': 'no-store' } },
    );
  }
}
