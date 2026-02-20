import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';

const rootDir = process.cwd();
const pnpmBin = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const uiPort = normalizePort(process.env.PORT, 3000);
const uiUrl = `http://localhost:${uiPort}`;

const BUILD_ARTIFACTS = [
  {
    name: '@cipherscope/proto',
    files: ['packages/proto/dist/index.js', 'packages/proto/dist/schemas.js'],
  },
  {
    name: '@cipherscope/sdk',
    files: ['packages/sdk/dist/index.js', 'packages/sdk/dist/client.js'],
  },
  {
    name: '@cipherscope/ui',
    files: ['apps/ui/.next/BUILD_ID', 'apps/ui/.next/required-server-files.json'],
  },
];

function normalizePort(raw, fallback) {
  if (typeof raw !== 'string' || !raw.trim()) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) return fallback;
  return parsed;
}

async function exists(relPath) {
  try {
    await access(path.join(rootDir, relPath));
    return true;
  } catch {
    return false;
  }
}

async function findMissingBuildArtifacts() {
  const missing = [];
  for (const check of BUILD_ARTIFACTS) {
    for (const relPath of check.files) {
      if (!(await exists(relPath))) {
        missing.push({ packageName: check.name, relPath });
      }
    }
  }
  return missing;
}

function withSystemCaEnv() {
  const env = { ...process.env };
  const raw = typeof env.NODE_OPTIONS === 'string' ? env.NODE_OPTIONS.trim() : '';
  const items = raw ? raw.split(/\s+/).filter(Boolean) : [];
  if (!items.includes('--use-system-ca')) items.push('--use-system-ca');
  env.NODE_OPTIONS = items.join(' ');
  return env;
}

function runPnpm(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(pnpmBin, args, {
      cwd: rootDir,
      stdio: 'inherit',
      env,
    });

    child.on('error', (err) => reject(err));
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const detail = code == null ? `signal ${signal ?? 'unknown'}` : `exit code ${code}`;
      reject(new Error(`pnpm ${args.join(' ')} failed with ${detail}`));
    });
  });
}

async function waitForUi(url, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: 'GET', redirect: 'manual', cache: 'no-store' });
      if (res.status < 500) return true;
    } catch {
      // UI not reachable yet.
    }
    await sleep(500);
  }
  return false;
}

function spawnDetached(command, args) {
  return new Promise((resolve) => {
    try {
      const child = spawn(command, args, { stdio: 'ignore', detached: true });
      child.once('error', () => resolve(false));
      child.unref();
      resolve(true);
    } catch {
      resolve(false);
    }
  });
}

async function openInBrowser(url) {
  if (process.env.CI === 'true') return false;

  if (process.platform === 'darwin') {
    return spawnDetached('open', [url]);
  }
  if (process.platform === 'win32') {
    return spawnDetached('cmd', ['/c', 'start', '', url]);
  }
  return spawnDetached('xdg-open', [url]);
}

async function openUiWhenReady(url) {
  const ready = await waitForUi(url);
  if (!ready) {
    console.warn(`[start] UI did not become reachable at ${url}; skipped auto-open.`);
    return;
  }
  const opened = await openInBrowser(url);
  if (!opened) {
    console.warn(`[start] Could not auto-open browser. Open this URL manually: ${url}`);
    return;
  }
  console.log(`[start] Opened ${url}`);
}

async function main() {
  const env = withSystemCaEnv();
  const missing = await findMissingBuildArtifacts();

  if (missing.length > 0) {
    console.log('[start] Missing build artifacts detected:');
    for (const item of missing) {
      console.log(`  - ${item.packageName}: ${item.relPath}`);
    }
    console.log('[start] Running pnpm build...');
    await runPnpm(['build'], env);
  } else {
    console.log('[start] Build artifacts present. Skipping pnpm build.');
  }

  void openUiWhenReady(uiUrl);

  console.log('[start] Launching agent + UI (production mode)...');
  await runPnpm(
    [
      'exec',
      'concurrently',
      '-k',
      '-n',
      'agent,ui',
      '-c',
      'green,blue',
      'pnpm --filter @cipherscope/agent start',
      'pnpm --filter @cipherscope/ui start',
    ],
    env,
  );
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[start] ${message}`);
  process.exit(1);
});
