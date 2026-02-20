import fs from 'node:fs';
import path from 'node:path';
import { buildApp } from './app.js';

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function workspaceRootFrom(startDir: string): string {
  let current = path.resolve(startDir);
  while (true) {
    if (fs.existsSync(path.join(current, 'pnpm-workspace.yaml'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return startDir;
    current = parent;
  }
}

function parseEnvLine(line: string): { key: string; value: string } | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const idx = trimmed.indexOf('=');
  if (idx <= 0) return null;

  const key = trimmed.slice(0, idx).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;

  let value = trimmed.slice(idx + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return { key, value };
}

function loadEnvFile(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (!parsed) continue;
    if (process.env[parsed.key] == null) {
      process.env[parsed.key] = parsed.value;
    }
  }
}

function loadWorkspaceEnv(): void {
  const root = workspaceRootFrom(process.cwd());
  loadEnvFile(path.join(root, '.env.local'));
  loadEnvFile(path.join(root, '.env'));
}

loadWorkspaceEnv();

const host = process.env.AGENT_HOST ?? '127.0.0.1';
const port = envInt('AGENT_PORT', 17400);
const proxyHost = process.env.AGENT_PROXY_HOST ?? '127.0.0.1';
const proxyPort = envInt('AGENT_PROXY_PORT', 18080);
const dbPath = process.env.AGENT_DB_PATH ?? path.join(process.cwd(), '.data', 'cipherscope.db');
const agentName = 'cipherscope-agent';
const agentVersion = process.env.npm_package_version ?? '0.0.0';

const { app, close } = await buildApp({ dbPath, agentName, agentVersion, proxyHost, proxyPort });

function isTransientSocketError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (!code) return false;
  return (
    code === 'ECONNRESET' ||
    code === 'EPIPE' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNABORTED' ||
    code === 'EHOSTUNREACH'
  );
}

let shuttingDown = false;
const shutdown = async (signal: string, exitCode = 0) => {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
  try {
    await close();
  } finally {
    process.exit(exitCode);
  }
};

process.on('SIGINT', () => void shutdown('SIGINT', 0));
process.on('SIGTERM', () => void shutdown('SIGTERM', 0));
process.on('uncaughtException', (err) => {
  if (isTransientSocketError(err)) {
    app.log.warn({ err }, 'ignoring transient uncaught socket error');
    return;
  }
  app.log.error({ err }, 'uncaught exception');
  void shutdown('uncaughtException', 1);
});
process.on('unhandledRejection', (reason) => {
  app.log.error({ reason }, 'unhandled rejection');
});

await app.listen({ host, port });
app.log.info({ host, port, dbPath, proxyHost, proxyPort }, 'agent listening');
