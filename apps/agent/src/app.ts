import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import type WebSocket from 'ws';
import path from 'node:path';
import { fetch as undiciFetch, Agent as UndiciAgent } from 'undici';

const aiDispatcher = new UndiciAgent({
  bodyTimeout: 0,
  headersTimeout: 0,
});

async function aiFetchImpl(url: string | URL, init?: RequestInit): Promise<Response> {
  return undiciFetch(url, { ...(init as any), dispatcher: aiDispatcher }) as unknown as Promise<Response>;
}

import {
  AiChatRequestSchema,
  AiChatResponseSchema,
  ContractAuditRunRequestSchema,
  ContractAuditRunResponseSchema,
  CreateFindingRequestSchema,
  CreateFindingResponseSchema,
  DeleteContractResponseSchema,
  FuzzCampaignRequestSchema,
  FuzzCampaignResponseSchema,
  GetMessageResponseSchema,
  HealthResponseSchema,
  ListContractsResponseSchema,
  ListDecodedContractsResponseSchema,
  ListFindingsResponseSchema,
  ListInterceptQueueResponseSchema,
  ListMessagesResponseSchema,
  ListScannerFindingsResponseSchema,
  ListWsConnectionsResponseSchema,
  ListWsFramesResponseSchema,
  ProxyStatusSchema,
  ProxySmokeTestResponseSchema,
  ProxyIgnoreHostsRequestSchema,
  ProxyIgnoreHostsResponseSchema,
  RpcInteractionRecordRequestSchema,
  RpcInteractionRecordResponseSchema,
  ReplayBatchRequestSchema,
  ReplayBatchResponseSchema,
  ReplayRequestSchema,
  ReplayResponseSchema,
  ScannerRunRequestSchema,
  ScannerRunResponseSchema,
  SitemapResponseSchema,
  GetRpcInteractionResponseSchema,
  ListRpcInteractionsResponseSchema,
  UpdateFindingRequestSchema,
  UpdateFindingResponseSchema,
  UpsertContractRequestSchema,
  UpsertContractResponseSchema,
  type AgentEvent,
  type AiProvider,
} from '@cipherscope/proto';
import { createMetrics } from './metrics.js';
import { deleteAllHttpMessages, deleteHttpMessage, getHttpMessage, getSitemap, listHttpMessages, listWsFrames } from './store.js';
import { listWsConnections } from './store.js';
import { ProxyController } from './proxy.js';
import { ReplayError, replayBatch, replayOnce } from './replay.js';
import { buildCaseZip, importCaseZip } from './casefile.js';
import { runFuzzCampaign } from './fuzzer.js';
import { createFoundryManager, FoundryRpcError } from './foundry.js';
import { deleteEvmForkSettings, getEvmForkSettings, upsertEvmForkSettings } from './evm-settings.js';
import { getProxyCaptureSettings, upsertProxyCaptureSettings } from './proxy-settings.js';
import {
  deleteContract,
  getContract,
  listContracts,
  listDecodedContracts,
  upsertContract,
} from './contracts.js';
import { createFinding, listFindings, updateFinding } from './findings.js';
import { runContractAudit } from './contract-audit.js';
import { listScannerFindings, runScanner } from './scanner.js';
import { closeAiAgentResources, runAiAgentChat } from './ai-agent.js';
import { getRpcInteraction, listRpcInteractions, recordRpcInteraction } from './rpc-history.js';
import { ProjectManager } from './projects.js';
import { runDexExplorerQuery } from './explorer.js';
import { runZoomeyeHostSearch, ZoomeyeQueryError } from './zoomeye.js';
import { runShodanHostSearch, ShodanQueryError } from './shodan.js';
import { getPassedShodanSearch, listPassedShodanSearches } from './shodan-searches.js';
import { searchPayloadCatalog } from './payload-catalog.js';
import {
  IntruderAttackRequestSchema,
  isIntruderInputError,
  runIntruderAttack,
} from './intruder.js';
import {
  StartZapScanInputSchema,
  ZapScanStatusSchema,
  getZapScan,
  listZapScans,
  startZapScan,
  stopZapScan,
} from './zap-scans.js';
import { RunSubfinderInputSchema, runSubfinder } from './subfinder.js';

export type BuildAppOpts = {
  dbPath: string;
  agentName: string;
  agentVersion: string;
  proxyHost: string;
  proxyPort: number;
};

export async function buildApp(opts: BuildAppOpts): Promise<{
  app: FastifyInstance;
  close: () => Promise<void>;
}> {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
    },
  });

  // Used for case file import (zip upload). Keep this scoped to common zip types.
  app.addContentTypeParser(
    ['application/zip', 'application/x-zip-compressed', 'application/octet-stream'],
    { parseAs: 'buffer' },
    (_req, body, done) => {
      done(null, body);
    },
  );

  const metrics = createMetrics();
  const dataDir = path.dirname(path.resolve(opts.dbPath));
  const projects = new ProjectManager({ projectsDir: path.join(dataDir, 'projects'), metrics });
  projects.init({ legacyDbPath: opts.dbPath });

  const tlsDir = path.join(dataDir, 'tls');
  const mitmEnabled = (process.env.AGENT_MITM_ENABLED ?? '1') !== '0';
  const upstreamInsecure = process.env.AGENT_UPSTREAM_INSECURE === '1';

  app.addHook('onRequest', async () => {
    metrics.incHttpRequest();
  });

  await app.register(websocket);

  const wsClients = new Set<WebSocket>();
  const publishEvent = (evt: AgentEvent) => {
    const payload = JSON.stringify(evt);
    for (const client of wsClients) {
      try {
        client.send(payload);
        metrics.incWsMessage();
      } catch (err) {
        app.log.debug({ err }, 'ws broadcast failed');
      }
    }
  };

  const metricsInterval = setInterval(() => {
    publishEvent({
      type: 'metrics',
      time: new Date().toISOString(),
      metrics: metrics.snapshot(),
    } as AgentEvent);
  }, 1000);

  const loadForkOverrides = () => {
    const saved = getEvmForkSettings(projects.db());
    return saved.hasSavedConfig
      ? { forkUrl: saved.forkUrl, forkBlockNumber: saved.forkBlockNumber, chainId: saved.chainId }
      : null;
  };

  let foundry = await createFoundryManager(app.log, { overrides: loadForkOverrides() });

  const proxyRpcRewriteEnabled = (process.env.AGENT_PROXY_RPC_REWRITE_ENABLED ?? '1') !== '0';
  const proxyRpcRewriteUrl = (process.env.AGENT_PROXY_RPC_REWRITE_URL ?? '').trim() || null;
  const proxyCaptureSettings = getProxyCaptureSettings(projects.db());
  const proxy = new ProxyController({
    host: opts.proxyHost,
    port: opts.proxyPort,
    tlsDir,
    mitmEnabled,
    upstreamInsecure,
    rpcAutoRewriteEnabled: proxyRpcRewriteEnabled,
    rpcRewriteUrl: proxyRpcRewriteUrl,
    resolveRpcRewriteUrl: () => {
      const st = foundry.status();
      return st.running ? st.rpcUrl : null;
    },
    ignoredHosts: proxyCaptureSettings.ignoredHosts,
    getDb: () => projects.db(),
    metrics,
    log: app.log,
    publishEvent,
  });

  await proxy.start();

  const readNodeInfo = async (): Promise<unknown | null> => {
    try {
      return await foundry.rpcCall<unknown>('anvil_nodeInfo', []);
    } catch {
      return null;
    }
  };

  const restartFoundry = async () => {
    const st = foundry.status();
    if (st.running && !st.managed) {
      throw new Error(
        `Foundry RPC is already reachable at ${st.rpcUrl} but is not managed by the agent. Stop the external anvil process to apply fork settings.`,
      );
    }
    await foundry.stop();
    foundry = await createFoundryManager(app.log, { overrides: loadForkOverrides() });
    return foundry.status();
  };

  const normalizeForkUrl = (value: unknown): string | null => {
    if (typeof value !== 'string') return null;
    const out = value.trim();
    return out ? out : null;
  };

  const normalizeForkBlockNumber = (value: unknown): number | null => {
    if (typeof value === 'number' && Number.isFinite(value)) {
      const n = Math.trunc(value);
      return n > 0 ? n : null;
    }
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) return null;
      const n = Number(trimmed);
      if (!Number.isFinite(n)) return null;
      const out = Math.trunc(n);
      return out > 0 ? out : null;
    }
    return null;
  };

  const normalizeChainId = (value: unknown): number | null => {
    if (typeof value === 'number' && Number.isFinite(value)) {
      const n = Math.trunc(value);
      return n > 0 ? n : null;
    }
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) return null;
      const n = Number(trimmed);
      if (!Number.isFinite(n)) return null;
      const out = Math.trunc(n);
      return out > 0 ? out : null;
    }
    return null;
  };

  const safeFilenameFragment = (value: string): string => {
    const trimmed = value.trim();
    if (!trimmed) return 'project';
    const safe = trimmed
      .replaceAll(/[^a-zA-Z0-9._-]+/g, '-')
      .replaceAll(/-+/g, '-')
      .replaceAll(/^-|-$/g, '');
    return safe.slice(0, 64) || 'project';
  };

  app.get('/metrics', async () => {
    return metrics.snapshot();
  });

  app.get('/health', async () => {
    const payload = {
      ok: true,
      name: opts.agentName,
      version: opts.agentVersion,
      time: new Date().toISOString(),
      db: { path: projects.dbPath(), ok: true },
      metrics: metrics.snapshot(),
    };

    // Internal safety check: ensure agent emits stable contract for the UI/sdk.
    HealthResponseSchema.parse(payload);
    return payload;
  });

  // ---- Projects (local sessions) ----
  app.get('/projects', async () => {
    const current = projects.current();
    return {
      ok: true,
      currentId: current.id,
      projects: projects.list().map((p) => ({
        id: p.id,
        name: p.name,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
      })),
    };
  });

  app.post('/projects', async (req, reply) => {
    const body = req.body as unknown;
    if (body != null && (typeof body !== 'object' || Array.isArray(body))) {
      reply.code(400);
      return { ok: false, error: { code: 'bad_request', message: 'Body must be an object.' } };
    }
    const nameRaw = (body as { name?: unknown } | null)?.name;
    const name = typeof nameRaw === 'string' ? nameRaw.trim() : '';
    const created = projects.create({ name: name || undefined });
    return {
      ok: true,
      currentId: created.id,
      project: {
        id: created.id,
        name: created.name,
        createdAt: created.createdAt,
        updatedAt: created.updatedAt,
      },
    };
  });

  app.post('/projects/current', async (req, reply) => {
    const body = req.body as unknown;
    const id = (body as { id?: unknown } | null)?.id;
    if (typeof id !== 'string' || !id.trim()) {
      reply.code(400);
      return { ok: false, error: { code: 'bad_request', message: 'Body must be { id: string }.' } };
    }
    try {
      const current = projects.setCurrent(id.trim());
      return {
        ok: true,
        currentId: current.id,
        project: {
          id: current.id,
          name: current.name,
          createdAt: current.createdAt,
          updatedAt: current.updatedAt,
        },
      };
    } catch (err) {
      reply.code(404);
      return {
        ok: false,
        error: { code: 'not_found', message: err instanceof Error ? err.message : 'No such project.' },
      };
    }
  });

  app.get('/projects/export', async (_req, reply) => {
    const meta = projects.current();
    const { zip, manifest } = buildCaseZip({
      db: projects.db(),
      agentName: opts.agentName,
      agentVersion: opts.agentVersion,
    });

    const ts = manifest.createdAt.replaceAll(':', '-');
    const name = safeFilenameFragment(meta.name);
    reply.header('cache-control', 'no-store');
    reply.header('content-type', 'application/zip');
    reply.header('content-disposition', `attachment; filename="${name}-case-${ts}.zip"`);
    return zip;
  });

  app.post(
    '/projects/import',
    { bodyLimit: 200 * 1024 * 1024 },
    async (req, reply) => {
      const body = req.body as unknown;
      const zip =
        Buffer.isBuffer(body)
          ? body
          : body instanceof Uint8Array
            ? Buffer.from(body)
            : body instanceof ArrayBuffer
              ? Buffer.from(body)
              : null;

      if (!zip) {
        reply.code(400);
        return {
          ok: false,
          error: { code: 'bad_request', message: 'Body must be a .zip file (application/zip).' },
        };
      }

      // Create and switch to a new project, then import the case into it.
      const created = projects.create({ name: `Imported ${new Date().toISOString().slice(0, 10)}` });
      try {
        const out = importCaseZip({ db: projects.openDb(created.id).db, zip });
        return {
          ok: true,
          currentId: created.id,
          project: {
            id: created.id,
            name: created.name,
            createdAt: created.createdAt,
            updatedAt: created.updatedAt,
          },
          manifest: out.manifest,
          imported: out.imported,
        };
      } catch (err) {
        reply.code(400);
        return {
          ok: false,
          error: { code: 'bad_case_file', message: err instanceof Error ? err.message : String(err) },
        };
      }
    },
  );

  app.get('/evm/status', async () => {
    return { ok: true as const, foundry: foundry.status() };
  });

  app.get('/evm/config', async () => {
    const saved = getEvmForkSettings(projects.db());
    const foundryStatus = foundry.status();
    const nodeInfo = foundryStatus.running ? await readNodeInfo() : null;
    return { ok: true as const, saved, foundry: foundryStatus, nodeInfo };
  });

  app.post('/evm/config', async (req, reply) => {
    const body = req.body as unknown;
    if (!body || typeof body !== 'object') {
      reply.code(400);
      return {
        ok: false as const,
        error: { code: 'bad_request', message: 'Body must be a JSON object.' },
      };
    }

    const patch = body as Record<string, unknown>;
    const hasForkUrl = Object.prototype.hasOwnProperty.call(patch, 'forkUrl');
    const hasForkBlockNumber = Object.prototype.hasOwnProperty.call(patch, 'forkBlockNumber');
    const hasChainId = Object.prototype.hasOwnProperty.call(patch, 'chainId');
    if (!hasForkUrl && !hasForkBlockNumber && !hasChainId) {
      reply.code(400);
      return {
        ok: false as const,
        error: { code: 'bad_request', message: 'Body must include forkUrl and/or forkBlockNumber and/or chainId.' },
      };
    }

    const existing = getEvmForkSettings(projects.db());
    const nextForkUrl = hasForkUrl ? normalizeForkUrl(patch.forkUrl) : existing.forkUrl;
    const nextForkBlockNumber = hasForkBlockNumber
      ? normalizeForkBlockNumber(patch.forkBlockNumber)
      : existing.forkBlockNumber;
    const nextChainId = hasChainId ? normalizeChainId(patch.chainId) : existing.chainId;

    const normalized = {
      forkUrl: nextForkUrl,
      forkBlockNumber: nextForkUrl ? nextForkBlockNumber : null,
      chainId: nextChainId,
    };

    const saved = upsertEvmForkSettings(projects.db(), normalized);

    try {
      const st = await restartFoundry();
      const nodeInfo = st.running ? await readNodeInfo() : null;
      if (st.startupError) {
        reply.code(503);
        return {
          ok: false as const,
          error: { code: 'foundry_start_failed', message: st.startupError },
          saved,
          foundry: st,
          nodeInfo,
        };
      }
      return { ok: true as const, saved, foundry: st, nodeInfo };
    } catch (err) {
      reply.code(409);
      return {
        ok: false as const,
        error: { code: 'evm_restart_failed', message: err instanceof Error ? err.message : String(err) },
        saved,
        foundry: foundry.status(),
        nodeInfo: await readNodeInfo(),
      };
    }
  });

  app.delete('/evm/config', async (_req, reply) => {
    const saved = deleteEvmForkSettings(projects.db());
    try {
      const st = await restartFoundry();
      const nodeInfo = st.running ? await readNodeInfo() : null;
      if (st.startupError) {
        reply.code(503);
        return {
          ok: false as const,
          error: { code: 'foundry_start_failed', message: st.startupError },
          saved,
          foundry: st,
          nodeInfo,
        };
      }
      return { ok: true as const, saved, foundry: st, nodeInfo };
    } catch (err) {
      reply.code(409);
      return {
        ok: false as const,
        error: { code: 'evm_restart_failed', message: err instanceof Error ? err.message : String(err) },
        saved,
        foundry: foundry.status(),
        nodeInfo: await readNodeInfo(),
      };
    }
  });

  const walletStateQueryMethods = new Set([
    'eth_getBalance',
    'eth_getTransactionCount',
    'eth_getCode',
    'eth_getStorageAt',
    'eth_call',
  ]);

  const isGenesisBlockTag = (value: unknown): boolean => {
    if (typeof value === 'number') return Number.isFinite(value) && value === 0;
    if (typeof value === 'bigint') return value === BigInt(0);
    if (typeof value !== 'string') return false;
    const normalized = value.trim().toLowerCase();
    if (!normalized) return false;
    if (normalized === 'earliest') return true;
    if (/^0x[0-9a-f]+$/.test(normalized)) {
      try {
        return BigInt(normalized) === BigInt(0);
      } catch {
        return false;
      }
    }
    if (/^\d+$/.test(normalized)) {
      try {
        return BigInt(normalized) === BigInt(0);
      } catch {
        return false;
      }
    }
    return false;
  };

  const normalizeWalletStateQueryParams = (method: string, params: unknown[]): void => {
    if (!walletStateQueryMethods.has(method) || params.length < 2) return;
    const blockTagIndex = params.length - 1;
    if (isGenesisBlockTag(params[blockTagIndex])) {
      params[blockTagIndex] = 'latest';
    }
  };

  // Standard JSON-RPC 2.0 endpoint for wallet connections (MetaMask, Rabby, etc.).
  // Accepts the Ethereum JSON-RPC 2.0 wire format and proxies to the managed Anvil instance.
  // Exposes CORS headers so browser extensions can reach it over HTTP without cert issues.
  app.options('/evm/jsonrpc', async (_req, reply) => {
    reply.header('access-control-allow-origin', '*');
    reply.header('access-control-allow-methods', 'POST, OPTIONS');
    reply.header('access-control-allow-headers', 'content-type');
    reply.code(204);
    return '';
  });

  app.post('/evm/jsonrpc', async (req, reply) => {
    reply.header('access-control-allow-origin', '*');
    reply.header('access-control-allow-methods', 'POST, OPTIONS');
    reply.header('access-control-allow-headers', 'content-type');
    reply.header('cache-control', 'no-store');

    const body = req.body as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown } | null;
    const id = body?.id ?? null;
    const method = typeof body?.method === 'string' ? body.method.trim() : '';

    if (!method) {
      reply.code(400);
      return { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request: method is required' } };
    }

    const paramsRaw = body?.params;
    const params =
      paramsRaw == null ? [] : Array.isArray(paramsRaw) ? paramsRaw : [paramsRaw];

    // Wallets (Rabby, MetaMask) sometimes query state at genesis/earliest block tags.
    // On a forked Anvil, balance/code mutations are applied at the current head, so
    // normalize genesis-style tags to "latest" for state query methods.
    normalizeWalletStateQueryParams(method, params);

    app.log.info({ method, params: JSON.stringify(params).slice(0, 120) }, 'wallet jsonrpc call');
    // #region agent log
    fetch('http://127.0.0.1:7683/ingest/826eec37-4705-4e23-8b79-6677a4f37c3e',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'4aeaa9'},body:JSON.stringify({sessionId:'4aeaa9',location:'agent/app.ts:/evm/jsonrpc:request',message:'wallet jsonrpc request',data:{method,firstParam:params[0] ?? null,paramCount:params.length},timestamp:Date.now(),hypothesisId:'H-I,H-J'})}).catch(()=>{});
    // #endregion

    try {
      const result = await foundry.rpcCall<unknown>(method, params);
      if (method === 'eth_getBalance' || method === 'eth_accounts' || method === 'eth_chainId') {
        // #region agent log
        fetch('http://127.0.0.1:7683/ingest/826eec37-4705-4e23-8b79-6677a4f37c3e',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'4aeaa9'},body:JSON.stringify({sessionId:'4aeaa9',location:'agent/app.ts:/evm/jsonrpc:result',message:'wallet jsonrpc result',data:{method,result:String(result).slice(0,120),firstParam:params[0] ?? null},timestamp:Date.now(),hypothesisId:'H-I,H-J'})}).catch(()=>{});
        // #endregion
      }
      return { jsonrpc: '2.0', id, result: result ?? null };
    } catch (err) {
      if (err instanceof FoundryRpcError) {
        return { jsonrpc: '2.0', id, error: { code: err.code, message: err.message, data: err.data ?? undefined } };
      }
      reply.code(503);
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
      };
    }
  });

  app.post('/evm/rpc', async (req, reply) => {
    const body = req.body as { method?: unknown; params?: unknown } | null;
    const method = typeof body?.method === 'string' ? body.method.trim() : '';
    if (!method) {
      reply.code(400);
      return {
        ok: false,
        error: { code: 'bad_request', message: 'Body must include method (string).' },
      };
    }

    const paramsRaw = body?.params;
    const params =
      paramsRaw == null
        ? []
        : Array.isArray(paramsRaw)
          ? paramsRaw
          : [paramsRaw];

    // Keep /evm/rpc behavior aligned with /evm/jsonrpc so wallet RPC proxy routes
    // receive consistent state-query block-tag normalization.
    normalizeWalletStateQueryParams(method, params);

    try {
      const result = await foundry.rpcCall<unknown>(method, params);
      return { ok: true as const, result };
    } catch (err) {
      if (err instanceof FoundryRpcError) {
        return {
          ok: false,
          error: {
            code: 'rpc_error',
            message: err.message,
            rpcCode: err.code,
            data: err.data ?? null,
          },
        };
      }
      reply.code(503);
      return {
        ok: false,
        error: {
          code: 'evm_unavailable',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  });

  app.get('/proxy/status', async () => {
    const st = proxy.status();
    const payload = {
      ok: true,
      proxy: { host: st.host, port: st.port },
      interceptEnabled: st.interceptEnabled,
      interceptQueueSize: st.interceptQueueSize,
      ignoreHosts: st.ignoredHosts,
    };
    ProxyStatusSchema.parse(payload);
    return payload;
  });

  app.get('/tls/ca.pem', async (_req, reply) => {
    const pem = proxy.caCertPem();
    reply.header('content-type', 'application/x-pem-file; charset=utf-8');
    reply.header('content-disposition', 'attachment; filename="cipherscope-ca.pem"');
    return pem;
  });

  app.get('/tls/ca.der', async (_req, reply) => {
    const der = proxy.caCertDer();
    reply.header('content-type', 'application/octet-stream');
    reply.header('content-disposition', 'attachment; filename="cipherscope-ca.der"');
    return der;
  });

  // ---- Case files (export/import) ----
  app.get('/case/export', async (_req, reply) => {
    const { zip, manifest } = buildCaseZip({
      db: projects.db(),
      agentName: opts.agentName,
      agentVersion: opts.agentVersion,
    });

    const ts = manifest.createdAt.replaceAll(':', '-');
    reply.header('cache-control', 'no-store');
    reply.header('content-type', 'application/zip');
    reply.header('content-disposition', `attachment; filename="cipherscope-case-${ts}.zip"`);
    return zip;
  });

  app.post(
    '/case/import',
    { bodyLimit: 200 * 1024 * 1024 },
    async (req, reply) => {
      const body = req.body as unknown;
      const zip =
        Buffer.isBuffer(body)
          ? body
          : body instanceof Uint8Array
            ? Buffer.from(body)
            : body instanceof ArrayBuffer
              ? Buffer.from(body)
              : null;

      if (!zip) {
        reply.code(400);
        return {
          ok: false,
          error: { code: 'bad_request', message: 'Body must be a .zip file (application/zip).' },
        };
      }

      try {
        const out = importCaseZip({ db: projects.db(), zip });
        return { ok: true, manifest: out.manifest, imported: out.imported };
      } catch (err) {
        reply.code(400);
        return {
          ok: false,
          error: { code: 'bad_case_file', message: err instanceof Error ? err.message : String(err) },
        };
      }
    },
  );

  app.post('/proxy/intercept', async (req, reply) => {
    const body = req.body as unknown;
    const enabled = (body as { enabled?: unknown } | null)?.enabled;
    if (typeof enabled !== 'boolean') {
      reply.code(400);
      return {
        ok: false,
        error: { code: 'bad_request', message: 'Body must be { enabled: boolean }' },
      };
    }
    proxy.setIntercept(enabled);
    const st = proxy.status();
    const payload = {
      ok: true,
      proxy: { host: st.host, port: st.port },
      interceptEnabled: st.interceptEnabled,
      interceptQueueSize: st.interceptQueueSize,
      ignoreHosts: st.ignoredHosts,
    };
    ProxyStatusSchema.parse(payload);
    return payload;
  });

  app.get('/proxy/ignore-hosts', async () => {
    const payload = {
      ok: true as const,
      hosts: proxy.ignoredHosts(),
    };
    ProxyIgnoreHostsResponseSchema.parse(payload);
    return payload;
  });

  app.post('/proxy/ignore-hosts', async (req, reply) => {
    let parsed: ReturnType<typeof ProxyIgnoreHostsRequestSchema.parse>;
    try {
      parsed = ProxyIgnoreHostsRequestSchema.parse(req.body ?? {});
    } catch (err) {
      reply.code(400);
      return {
        ok: false,
        error: { code: 'bad_request', message: err instanceof Error ? err.message : 'Bad body' },
      };
    }

    const saved = upsertProxyCaptureSettings(projects.db(), { ignoredHosts: parsed.hosts });
    const hosts = proxy.setIgnoredHosts(saved.ignoredHosts);
    const payload = {
      ok: true as const,
      hosts,
    };
    ProxyIgnoreHostsResponseSchema.parse(payload);
    return payload;
  });

  app.post('/proxy/smoke', async (_req, reply) => {
    try {
      const out = await proxy.smokeTest();
      const payload = { ok: true as const, ...out };
      ProxySmokeTestResponseSchema.parse(payload);
      reply.header('cache-control', 'no-store');
      return payload;
    } catch (err) {
      reply.code(500);
      return {
        ok: false,
        error: { code: 'smoke_failed', message: err instanceof Error ? err.message : String(err) },
      };
    }
  });

  app.get('/proxy/queue', async () => {
    const payload = { ok: true, items: proxy.listQueue() };
    ListInterceptQueueResponseSchema.parse(payload);
    return payload;
  });

  app.post('/proxy/queue/:id/forward', async (req, reply) => {
    const id = (req.params as { id?: unknown } | null)?.id;
    if (typeof id !== 'string' || !id) {
      reply.code(400);
      return { ok: false, error: { code: 'bad_request', message: 'Missing id.' } };
    }
    const ok = await proxy.forward(id);
    if (!ok) {
      reply.code(404);
      return { ok: false, error: { code: 'not_found', message: 'No such intercepted request.' } };
    }
    return { ok: true };
  });

  app.post('/proxy/queue/:id/drop', async (req, reply) => {
    const id = (req.params as { id?: unknown } | null)?.id;
    if (typeof id !== 'string' || !id) {
      reply.code(400);
      return { ok: false, error: { code: 'bad_request', message: 'Missing id.' } };
    }
    const ok = await proxy.drop(id);
    if (!ok) {
      reply.code(404);
      return { ok: false, error: { code: 'not_found', message: 'No such intercepted request.' } };
    }
    return { ok: true };
  });

  app.get('/messages', async (req) => {
    const q = req.query as {
      limit?: unknown;
      offset?: unknown;
      search?: unknown;
      source?: unknown;
      method?: unknown;
      scheme?: unknown;
      status?: unknown;
    } | null;
    const limitRaw = q?.limit != null ? Number(q.limit) : 200;
    const offsetRaw = q?.offset != null ? Number(q.offset) : 0;
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(1, limitRaw), 1000) : 200;
    const offset = Number.isFinite(offsetRaw) ? Math.max(0, offsetRaw) : 0;

    const search = typeof q?.search === 'string' ? q.search : undefined;
    const sourceVal = q?.source;
    const source =
      sourceVal === 'proxy' || sourceVal === 'repeater' ? sourceVal : undefined;
    const method = typeof q?.method === 'string' && q.method ? q.method : undefined;
    const scheme = typeof q?.scheme === 'string' && q.scheme ? q.scheme : undefined;
    const statusVal = q?.status;
    const status =
      statusVal === '2xx' || statusVal === '3xx' || statusVal === '4xx' || statusVal === '5xx' || statusVal === 'error'
        ? statusVal
        : undefined;

    const items = listHttpMessages(projects.db(), {
      limit,
      offset,
      search,
      source,
      method,
      scheme,
      status,
    });
    const payload = { ok: true, items };
    ListMessagesResponseSchema.parse(payload);
    return payload;
  });

  app.get('/messages/:id', async (req, reply) => {
    const id = (req.params as { id?: unknown } | null)?.id;
    if (typeof id !== 'string' || !id) {
      reply.code(400);
      return { ok: false, error: { code: 'bad_request', message: 'Missing id.' } };
    }
    const item = getHttpMessage(projects.db(), id);
    if (!item) {
      reply.code(404);
      return { ok: false, error: { code: 'not_found', message: 'No such message.' } };
    }
    const payload = { ok: true, item };
    GetMessageResponseSchema.parse(payload);
    return payload;
  });

  app.delete('/messages/clear', async () => {
    const deleted = deleteAllHttpMessages(projects.db());
    return { ok: true as const, deleted };
  });

  app.delete('/messages/:id', async (req, reply) => {
    const id = (req.params as { id?: unknown } | null)?.id;
    if (typeof id !== 'string' || !id) {
      reply.code(400);
      return { ok: false, error: { code: 'bad_request', message: 'Missing id.' } };
    }

    const ok = deleteHttpMessage(projects.db(), id);
    if (!ok) {
      reply.code(404);
      return { ok: false, error: { code: 'not_found', message: 'No such message.' } };
    }
    return { ok: true };
  });

  app.get('/sitemap', async (req) => {
    const q = req.query as { hide404?: unknown } | null;
    const hide404 = q?.hide404 === '1' || q?.hide404 === 'true' || q?.hide404 === true;
    const hosts = getSitemap(projects.db(), { hide404 });
    const payload = { ok: true as const, hosts };
    SitemapResponseSchema.parse(payload);
    return payload;
  });

  app.get('/ws/:id/frames', async (req) => {
    const id = (req.params as { id?: unknown } | null)?.id;
    const q = req.query as { limit?: unknown; offset?: unknown } | null;
    const limitRaw = q?.limit != null ? Number(q.limit) : 200;
    const offsetRaw = q?.offset != null ? Number(q.offset) : 0;
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(1, limitRaw), 2000) : 200;
    const offset = Number.isFinite(offsetRaw) ? Math.max(0, offsetRaw) : 0;

    if (typeof id !== 'string' || !id) {
      return { ok: true, items: [] };
    }
    const items = listWsFrames(projects.db(), { connectionId: id, limit, offset });
    const payload = { ok: true, items };
    ListWsFramesResponseSchema.parse(payload);
    return payload;
  });

  app.get('/ws/connections', async (req) => {
    const q = req.query as { limit?: unknown; offset?: unknown } | null;
    const limitRaw = q?.limit != null ? Number(q.limit) : 200;
    const offsetRaw = q?.offset != null ? Number(q.offset) : 0;
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(1, limitRaw), 2000) : 200;
    const offset = Number.isFinite(offsetRaw) ? Math.max(0, offsetRaw) : 0;

    const items = listWsConnections(projects.db(), { limit, offset });
    const payload = { ok: true as const, items };
    ListWsConnectionsResponseSchema.parse(payload);
    return payload;
  });

  app.post('/rpc/interactions', async (req, reply) => {
    let parsed: ReturnType<typeof RpcInteractionRecordRequestSchema.parse>;
    try {
      parsed = RpcInteractionRecordRequestSchema.parse(req.body ?? {});
    } catch (err) {
      reply.code(400);
      return {
        ok: false,
        error: { code: 'bad_request', message: err instanceof Error ? err.message : 'Bad body' },
      };
    }

    try {
      const out = recordRpcInteraction(projects.db(), parsed);
      RpcInteractionRecordResponseSchema.parse(out);
      return out;
    } catch (err) {
      reply.code(500);
      return {
        ok: false,
        error: { code: 'internal_error', message: err instanceof Error ? err.message : String(err) },
      };
    }
  });

  app.get('/rpc/interactions', async (req) => {
    const q = req.query as { limit?: unknown; offset?: unknown; source?: unknown } | null;
    const limitRaw = q?.limit != null ? Number(q.limit) : 200;
    const offsetRaw = q?.offset != null ? Number(q.offset) : 0;
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(1, limitRaw), 2000) : 200;
    const offset = Number.isFinite(offsetRaw) ? Math.max(0, offsetRaw) : 0;
    const source = q?.source === 'wallet' || q?.source === 'foundry' ? (q.source as 'wallet' | 'foundry') : null;

    const payload = listRpcInteractions(projects.db(), { limit, offset, source });
    ListRpcInteractionsResponseSchema.parse(payload);
    return payload;
  });

  app.get('/rpc/interactions/:id', async (req, reply) => {
    const id = (req.params as { id?: unknown } | null)?.id;
    if (typeof id !== 'string' || !id) {
      reply.code(400);
      return { ok: false, error: { code: 'bad_request', message: 'Missing id.' } };
    }

    const out = getRpcInteraction(projects.db(), id);
    if (!out) {
      reply.code(404);
      return { ok: false, error: { code: 'not_found', message: 'No such rpc interaction.' } };
    }
    GetRpcInteractionResponseSchema.parse(out);
    return out;
  });

  app.get('/contracts', async () => {
    const items = listContracts(projects.db());
    const payload = { ok: true as const, items };
    ListContractsResponseSchema.parse(payload);
    return payload;
  });

  app.get('/contracts/:id', async (req, reply) => {
    const id = (req.params as { id?: unknown } | null)?.id;
    if (typeof id !== 'string' || !id) {
      reply.code(400);
      return { ok: false, error: { code: 'bad_request', message: 'Missing id.' } };
    }

    const item = getContract(projects.db(), id);
    if (!item) {
      reply.code(404);
      return { ok: false, error: { code: 'not_found', message: 'No such contract.' } };
    }

    const payload = { ok: true as const, item };
    UpsertContractResponseSchema.parse(payload);
    return payload;
  });

  app.post('/contracts', async (req, reply) => {
    let parsed: ReturnType<typeof UpsertContractRequestSchema.parse>;
    try {
      parsed = UpsertContractRequestSchema.parse(req.body);
    } catch (err) {
      reply.code(400);
      return {
        ok: false,
        error: { code: 'bad_request', message: err instanceof Error ? err.message : 'Bad body' },
      };
    }

    try {
      const item = upsertContract(projects.db(), parsed);
      const payload = { ok: true as const, item };
      UpsertContractResponseSchema.parse(payload);
      return payload;
    } catch (err) {
      reply.code(500);
      return {
        ok: false,
        error: { code: 'internal_error', message: err instanceof Error ? err.message : String(err) },
      };
    }
  });

  app.get('/contracts/decoded', async (req) => {
    const q = req.query as { limit?: unknown; offset?: unknown } | null;
    const limitRaw = q?.limit != null ? Number(q.limit) : 250;
    const offsetRaw = q?.offset != null ? Number(q.offset) : 0;
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(1, limitRaw), 1000) : 250;
    const offset = Number.isFinite(offsetRaw) ? Math.max(0, offsetRaw) : 0;

    const items = listDecodedContracts(projects.db(), { limit, offset });
    const payload = { ok: true as const, items };
    ListDecodedContractsResponseSchema.parse(payload);
    return payload;
  });

  app.delete('/contracts/:id', async (req, reply) => {
    const id = (req.params as { id?: unknown } | null)?.id;
    if (typeof id !== 'string' || !id) {
      reply.code(400);
      return { ok: false, error: { code: 'bad_request', message: 'Missing id.' } };
    }
    const deleted = deleteContract(projects.db(), id);
    const payload = { ok: true as const, deleted };
    DeleteContractResponseSchema.parse(payload);
    return payload;
  });

  const notImplemented = (
    code: string,
    todo: { title: string; requirements: string[]; completionSpecs: string[] },
  ) => ({
    ok: false as const,
    error: { code, message: 'Not implemented' },
    todo,
  });

  // ---- Replay (Repeater) ----
  app.post('/replay', async (req, reply) => {
    let body: unknown;
    try {
      body = ReplayRequestSchema.parse(req.body);
    } catch (err) {
      reply.code(400);
      return {
        ok: false,
        error: { code: 'bad_request', message: err instanceof Error ? err.message : 'Bad body' },
      };
    }

    const parsed = body as ReturnType<typeof ReplayRequestSchema.parse>;
    try {
      const out = await replayOnce({
        db: projects.db(),
        baselineId: parsed.messageId,
        overrides: parsed.overrides,
        publishEvent,
      });
      const payload = { ok: true as const, baseline: out.baseline, variant: out.variant, diff: out.diff };
      ReplayResponseSchema.parse(payload);
      return payload;
    } catch (err) {
      if (err instanceof ReplayError) {
        reply.code(err.statusCode);
        return { ok: false, error: { code: err.code, message: err.message } };
      }
      reply.code(500);
      return { ok: false, error: { code: 'internal_error', message: err instanceof Error ? err.message : String(err) } };
    }
  });

  app.post('/replay/batch', async (req, reply) => {
    let body: unknown;
    try {
      body = ReplayBatchRequestSchema.parse(req.body);
    } catch (err) {
      reply.code(400);
      return {
        ok: false,
        error: { code: 'bad_request', message: err instanceof Error ? err.message : 'Bad body' },
      };
    }

    const parsed = body as ReturnType<typeof ReplayBatchRequestSchema.parse>;
    const results = await replayBatch({
      db: projects.db(),
      items: parsed.items,
      publishEvent,
    });

    const payload = { ok: true as const, results };
    ReplayBatchResponseSchema.parse(payload);
    return payload;
  });

  app.post('/fuzzer/campaign', async (req, reply) => {
    let body: unknown;
    try {
      body = FuzzCampaignRequestSchema.parse(req.body);
    } catch (err) {
      reply.code(400);
      return {
        ok: false,
        error: { code: 'bad_request', message: err instanceof Error ? err.message : 'Bad body' },
      };
    }

    const parsed = body as ReturnType<typeof FuzzCampaignRequestSchema.parse>;
    try {
      const payload = await runFuzzCampaign({
        db: projects.db(),
        request: parsed,
        publishEvent,
        invokeLocal: async (i) => {
          const injectOpts: { method: 'POST' | 'GET'; url: string; payload?: unknown } = {
            method: i.method,
            url: i.url,
          };
          if (i.payload !== undefined) injectOpts.payload = i.payload;

          const res = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
            app.inject(injectOpts as never, (err, response) => {
              if (err) return reject(err);
              if (!response) return reject(new Error('No response from local injection.'));
              resolve({ statusCode: response.statusCode, body: response.body });
            });
          });
          let parsedBody: unknown;
          try {
            parsedBody = JSON.parse(res.body);
          } catch {
            parsedBody = res.body;
          }
          return { statusCode: res.statusCode, body: parsedBody };
        },
      });
      FuzzCampaignResponseSchema.parse(payload);
      return payload;
    } catch (err) {
      if (err instanceof ReplayError) {
        reply.code(err.statusCode);
        return { ok: false, error: { code: err.code, message: err.message } };
      }
      reply.code(500);
      return {
        ok: false,
        error: { code: 'internal_error', message: err instanceof Error ? err.message : String(err) },
      };
    }
  });

  app.post('/scanner/run', async (req, reply) => {
    let body: unknown;
    try {
      body = ScannerRunRequestSchema.parse(req.body ?? {});
    } catch (err) {
      reply.code(400);
      return {
        ok: false,
        error: { code: 'bad_request', message: err instanceof Error ? err.message : 'Bad body' },
      };
    }

    const parsed = body as ReturnType<typeof ScannerRunRequestSchema.parse>;
    try {
      const out = await runScanner({
        db: projects.db(),
        includeActive: parsed.includeActive,
        limit: parsed.limit,
        messageIds: parsed.messageIds,
        publishEvent,
      });
      const payload = { ok: true as const, ...out };
      ScannerRunResponseSchema.parse(payload);
      return payload;
    } catch (err) {
      reply.code(500);
      return {
        ok: false,
        error: { code: 'internal_error', message: err instanceof Error ? err.message : String(err) },
      };
    }
  });

  app.post('/audit/contracts/run', async (req, reply) => {
    let body: unknown;
    try {
      body = ContractAuditRunRequestSchema.parse(req.body ?? {});
    } catch (err) {
      reply.code(400);
      return {
        ok: false,
        error: { code: 'bad_request', message: err instanceof Error ? err.message : 'Bad body' },
      };
    }

    const parsed = body as ReturnType<typeof ContractAuditRunRequestSchema.parse>;
    try {
      const out = await runContractAudit({
        db: projects.db(),
        request: parsed,
        rpcCall: async (method, params = []) => await foundry.rpcCall(method, params),
      });
      const payload = { ok: true as const, ...out };
      ContractAuditRunResponseSchema.parse(payload);
      return payload;
    } catch (err) {
      reply.code(500);
      return {
        ok: false,
        error: { code: 'internal_error', message: err instanceof Error ? err.message : String(err) },
      };
    }
  });

  app.get('/scanner/findings', async (req) => {
    const q = req.query as { limit?: unknown; offset?: unknown } | null;
    const limitRaw = q?.limit != null ? Number(q.limit) : 200;
    const offsetRaw = q?.offset != null ? Number(q.offset) : 0;
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(1, limitRaw), 2000) : 200;
    const offset = Number.isFinite(offsetRaw) ? Math.max(0, offsetRaw) : 0;

    const items = listScannerFindings(projects.db(), { limit, offset });
    const payload = { ok: true as const, items };
    ListScannerFindingsResponseSchema.parse(payload);
    return payload;
  });

  app.post('/zap/scans/start', async (req, reply) => {
    let body: ReturnType<typeof StartZapScanInputSchema.parse>;
    try {
      body = StartZapScanInputSchema.parse(req.body ?? {});
    } catch (err) {
      reply.code(400);
      return {
        ok: false,
        error: { code: 'bad_request', message: err instanceof Error ? err.message : 'Bad body' },
      };
    }

    try {
      const scan = await startZapScan({
        db: projects.db(),
        request: body,
      });
      return { ok: true as const, scan };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = /target|scan stage|url/i.test(message) ? 400 : 500;
      reply.code(code);
      return {
        ok: false,
        error: {
          code: code === 400 ? 'bad_request' : 'internal_error',
          message,
        },
      };
    }
  });

  app.get('/zap/scans', async (req, reply) => {
    const q = req.query as { limit?: unknown; offset?: unknown; status?: unknown } | null;
    const limitRaw = q?.limit != null ? Number(q.limit) : 50;
    const offsetRaw = q?.offset != null ? Number(q.offset) : 0;
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(1, limitRaw), 200) : 50;
    const offset = Number.isFinite(offsetRaw) ? Math.max(0, offsetRaw) : 0;
    let status: ReturnType<typeof ZapScanStatusSchema.parse> | undefined;

    if (typeof q?.status === 'string') {
      const parsedStatus = ZapScanStatusSchema.safeParse(q.status);
      if (!parsedStatus.success) {
        reply.code(400);
        return {
          ok: false,
          error: { code: 'bad_request', message: 'Invalid status filter.' },
        };
      }
      status = parsedStatus.data;
    }

    const items = listZapScans({ db: projects.db(), limit, offset, status });
    return { ok: true as const, items };
  });

  app.get('/zap/scans/:id', async (req, reply) => {
    const id = (req.params as { id?: unknown } | null)?.id;
    if (typeof id !== 'string' || !id.trim()) {
      reply.code(400);
      return { ok: false, error: { code: 'bad_request', message: 'Missing scan id.' } };
    }

    const scan = getZapScan({ db: projects.db(), scanId: id });
    if (!scan) {
      reply.code(404);
      return { ok: false, error: { code: 'not_found', message: 'Scan not found.' } };
    }

    return { ok: true as const, scan };
  });

  app.post('/zap/scans/:id/stop', async (req, reply) => {
    const id = (req.params as { id?: unknown } | null)?.id;
    if (typeof id !== 'string' || !id.trim()) {
      reply.code(400);
      return { ok: false, error: { code: 'bad_request', message: 'Missing scan id.' } };
    }

    try {
      const scan = await stopZapScan({ db: projects.db(), scanId: id });
      if (!scan) {
        reply.code(404);
        return { ok: false, error: { code: 'not_found', message: 'Scan not found.' } };
      }
      return { ok: true as const, scan };
    } catch (err) {
      reply.code(500);
      return {
        ok: false,
        error: { code: 'internal_error', message: err instanceof Error ? err.message : String(err) },
      };
    }
  });

  app.post('/subfinder/run', async (req, reply) => {
    let body: ReturnType<typeof RunSubfinderInputSchema.parse>;
    try {
      body = RunSubfinderInputSchema.parse(req.body ?? {});
    } catch (err) {
      reply.code(400);
      return {
        ok: false,
        error: { code: 'bad_request', message: err instanceof Error ? err.message : 'Bad body' },
      };
    }

    try {
      const out = await runSubfinder({
        db: projects.db(),
        request: body,
      });
      return { ok: true as const, ...out };
    } catch (err) {
      reply.code(500);
      return {
        ok: false,
        error: { code: 'internal_error', message: err instanceof Error ? err.message : String(err) },
      };
    }
  });

  app.get('/findings', async (req) => {
    const q = req.query as { limit?: unknown; offset?: unknown } | null;
    const limitRaw = q?.limit != null ? Number(q.limit) : 200;
    const offsetRaw = q?.offset != null ? Number(q.offset) : 0;
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(1, limitRaw), 2000) : 200;
    const offset = Number.isFinite(offsetRaw) ? Math.max(0, offsetRaw) : 0;

    const items = listFindings(projects.db(), { limit, offset });
    const payload = { ok: true as const, items };
    ListFindingsResponseSchema.parse(payload);
    return payload;
  });

  app.post('/findings', async (req, reply) => {
    let body: ReturnType<typeof CreateFindingRequestSchema.parse>;
    try {
      body = CreateFindingRequestSchema.parse(req.body);
    } catch (err) {
      reply.code(400);
      return {
        ok: false,
        error: { code: 'bad_request', message: err instanceof Error ? err.message : 'Bad body' },
      };
    }

    try {
      const item = createFinding(projects.db(), body);
      const payload = { ok: true as const, item };
      CreateFindingResponseSchema.parse(payload);
      return payload;
    } catch (err) {
      reply.code(500);
      return {
        ok: false,
        error: { code: 'internal_error', message: err instanceof Error ? err.message : String(err) },
      };
    }
  });

  app.patch('/findings/:id', async (req, reply) => {
    const id = (req.params as { id?: unknown } | null)?.id;
    if (typeof id !== 'string' || !id) {
      reply.code(400);
      return { ok: false, error: { code: 'bad_request', message: 'Missing id.' } };
    }

    let body: ReturnType<typeof UpdateFindingRequestSchema.parse>;
    try {
      body = UpdateFindingRequestSchema.parse(req.body);
    } catch (err) {
      reply.code(400);
      return {
        ok: false,
        error: { code: 'bad_request', message: err instanceof Error ? err.message : 'Bad body' },
      };
    }

    try {
      const item = updateFinding(projects.db(), { id, patch: body });
      if (!item) {
        reply.code(404);
        return { ok: false, error: { code: 'not_found', message: 'No such finding.' } };
      }
      const payload = { ok: true as const, item };
      UpdateFindingResponseSchema.parse(payload);
      return payload;
    } catch (err) {
      reply.code(500);
      return {
        ok: false,
        error: { code: 'internal_error', message: err instanceof Error ? err.message : String(err) },
      };
    }
  });

  app.post('/evm/snapshot', async (_req, reply) => {
    try {
      const snapshotId = await foundry.rpcCall<string>('anvil_snapshot', []);
      if (typeof snapshotId !== 'string' || !snapshotId) {
        throw new Error('Invalid snapshot id returned by Foundry RPC.');
      }
      return { ok: true as const, snapshotId };
    } catch (err) {
      if (err instanceof FoundryRpcError) {
        reply.code(err.code === -32601 ? 501 : 502);
        return {
          ok: false,
          error: {
            code: err.code === -32601 ? 'evm_method_not_supported' : 'evm_rpc_error',
            message: err.message,
          },
        };
      }
      reply.code(503);
      return {
        ok: false,
        error: {
          code: 'evm_unavailable',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  });

  app.post('/evm/revert', async (req, reply) => {
    const body = req.body as { snapshotId?: unknown } | null;
    const snapshotId = body?.snapshotId;
    if (typeof snapshotId !== 'string' || !snapshotId) {
      reply.code(400);
      return {
        ok: false,
        error: { code: 'bad_request', message: 'Body must include snapshotId (string).' },
      };
    }

    try {
      const reverted = await foundry.rpcCall<boolean>('anvil_revert', [snapshotId]);
      return { ok: true as const, reverted: reverted === true };
    } catch (err) {
      if (err instanceof FoundryRpcError) {
        reply.code(err.code === -32601 ? 501 : 502);
        return {
          ok: false,
          error: {
            code: err.code === -32601 ? 'evm_method_not_supported' : 'evm_rpc_error',
            message: err.message,
          },
        };
      }
      reply.code(503);
      return {
        ok: false,
        error: {
          code: 'evm_unavailable',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  });

  const readEnv = (name: string): string | undefined => {
    const raw = process.env[name];
    if (typeof raw !== 'string') return undefined;
    const out = raw.trim();
    return out ? out : undefined;
  };

  const resolveAiProviderConfig = (provider: AiProvider) => {
    switch (provider) {
      case 'openrouter': {
        const extraHeaders: Record<string, string> = {};
        const referrer = readEnv('OPENROUTER_HTTP_REFERER');
        const title = readEnv('OPENROUTER_X_TITLE');
        if (referrer) extraHeaders['HTTP-Referer'] = referrer;
        if (title) extraHeaders['X-Title'] = title;
        return {
          provider,
          apiKey: readEnv('OPENROUTER_API_KEY'),
          baseUrl: readEnv('OPENROUTER_BASE_URL') ?? 'https://openrouter.ai/api/v1',
          defaultModel: readEnv('OPENROUTER_MODEL') ?? 'openai/gpt-4o-mini',
          requiredApiKeyEnv: 'OPENROUTER_API_KEY',
          extraHeaders: Object.keys(extraHeaders).length ? extraHeaders : undefined,
        };
      }
      case 'gemini':
        return {
          provider,
          apiKey: readEnv('GEMINI_API_KEY'),
          baseUrl: readEnv('GEMINI_BASE_URL') ?? 'https://generativelanguage.googleapis.com/v1beta/openai',
          defaultModel: readEnv('GEMINI_MODEL') ?? 'gemini-2.0-flash',
          requiredApiKeyEnv: 'GEMINI_API_KEY',
          extraHeaders: undefined,
        };
      case 'grok':
        return {
          provider,
          apiKey: readEnv('GROK_API_KEY') ?? readEnv('XAI_API_KEY'),
          baseUrl: readEnv('GROK_BASE_URL') ?? readEnv('XAI_BASE_URL') ?? 'https://api.x.ai/v1',
          defaultModel: readEnv('GROK_MODEL') ?? readEnv('XAI_MODEL') ?? 'grok-2-latest',
          requiredApiKeyEnv: 'GROK_API_KEY (or XAI_API_KEY)',
          extraHeaders: undefined,
        };
      case 'claude': {
        const version = readEnv('CLAUDE_API_VERSION') ?? readEnv('ANTHROPIC_VERSION') ?? '2023-06-01';
        return {
          provider,
          apiKey: readEnv('CLAUDE_API_KEY') ?? readEnv('ANTHROPIC_API_KEY'),
          baseUrl: readEnv('CLAUDE_BASE_URL') ?? readEnv('ANTHROPIC_BASE_URL') ?? 'https://api.anthropic.com',
          defaultModel: readEnv('CLAUDE_MODEL') ?? readEnv('ANTHROPIC_MODEL') ?? 'claude-3-5-sonnet-latest',
          requiredApiKeyEnv: 'CLAUDE_API_KEY (or ANTHROPIC_API_KEY)',
          extraHeaders: { 'anthropic-version': version },
        };
      }
      case 'deepseek':
        return {
          provider,
          apiKey: readEnv('DEEPSEEK_API_KEY'),
          baseUrl: readEnv('DEEPSEEK_BASE_URL') ?? 'https://api.deepseek.com/v1',
          defaultModel: readEnv('DEEPSEEK_MODEL') ?? 'deepseek-chat',
          requiredApiKeyEnv: 'DEEPSEEK_API_KEY',
          extraHeaders: undefined,
        };
      case 'openai':
      default:
        return {
          provider: 'openai' as const,
          apiKey: readEnv('OPENAI_API_KEY'),
          baseUrl: readEnv('OPENAI_BASE_URL') ?? 'https://api.openai.com/v1',
          defaultModel: readEnv('OPENAI_MODEL') ?? 'gpt-5-nano-2025-08-07',
          requiredApiKeyEnv: 'OPENAI_API_KEY',
          extraHeaders: undefined,
        };
    }
  };

  const runChatWithResolvedConfig = async (
    body: ReturnType<typeof AiChatRequestSchema.parse>,
    onProgress?: (event: unknown) => void,
  ) => {
    const providerConfig = resolveAiProviderConfig(body.provider);
    if (!providerConfig.apiKey) {
      return {
        ok: false as const,
        statusCode: 503,
        error: {
          code: 'ai_unconfigured',
          message: `${providerConfig.requiredApiKeyEnv} is not configured in the agent environment.`,
        },
      };
    }

    const selectedModel = body.model ?? providerConfig.defaultModel;
    const payload = await runAiAgentChat({
      db: projects.db(),
      request: body,
      aiProvider: providerConfig.provider,
      aiApiKey: providerConfig.apiKey,
      aiModel: selectedModel,
      aiBaseUrl: providerConfig.baseUrl,
      aiExtraHeaders: providerConfig.extraHeaders,
      fetchImpl: aiFetchImpl as unknown as typeof fetch,
      publishEvent,
      onProgress,
      rpcCall: async (method, params = []) => await foundry.rpcCall(method, params),
      invokeLocal: async (i) => {
        const injectOpts: { method: 'POST' | 'GET'; url: string; payload?: unknown } = {
          method: i.method,
          url: i.url,
        };
        if (i.payload !== undefined) injectOpts.payload = i.payload;

        const res = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
          app.inject(injectOpts as never, (err, response) => {
            if (err) return reject(err);
            if (!response) return reject(new Error('No response from local injection.'));
            resolve({ statusCode: response.statusCode, body: response.body });
          });
        });
        let parsedBody: unknown;
        try {
          parsedBody = JSON.parse(res.body);
        } catch {
          parsedBody = res.body;
        }
        return { statusCode: res.statusCode, body: parsedBody };
      },
    });
    AiChatResponseSchema.parse(payload);
    return { ok: true as const, payload };
  };

  app.post('/ai/chat', async (req, reply) => {
    let body: ReturnType<typeof AiChatRequestSchema.parse>;
    try {
      body = AiChatRequestSchema.parse(req.body ?? {});
    } catch (err) {
      reply.code(400);
      return {
        ok: false,
        error: { code: 'bad_request', message: err instanceof Error ? err.message : 'Bad body' },
      };
    }

    try {
      const result = await runChatWithResolvedConfig(body);
      if (!result.ok) {
        reply.code(result.statusCode);
        return { ok: false, error: result.error };
      }
      return result.payload;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      reply.code(502);
      return {
        ok: false,
        error: { code: 'ai_chat_failed', message },
      };
    }
  });

  app.post('/ai/chat/stream', async (req, reply) => {
    let body: ReturnType<typeof AiChatRequestSchema.parse>;
    try {
      body = AiChatRequestSchema.parse(req.body ?? {});
    } catch (err) {
      reply.code(400);
      return {
        ok: false,
        error: { code: 'bad_request', message: err instanceof Error ? err.message : 'Bad body' },
      };
    }

    reply.hijack();
    const raw = reply.raw;
    let closed = false;
    req.raw.on('close', () => {
      closed = true;
    });

    raw.statusCode = 200;
    raw.setHeader('content-type', 'text/event-stream; charset=utf-8');
    raw.setHeader('cache-control', 'no-store, no-transform');
    raw.setHeader('connection', 'keep-alive');
    if (typeof raw.flushHeaders === 'function') raw.flushHeaders();

    const writeEvent = (event: unknown): void => {
      if (closed) return;
      const kind =
        event &&
        typeof event === 'object' &&
        !Array.isArray(event) &&
        typeof (event as { type?: unknown }).type === 'string'
          ? (event as { type: string }).type
          : 'message';
      raw.write(`event: ${kind}\n`);
      raw.write(`data: ${JSON.stringify(event)}\n\n`);
      if (typeof (raw as NodeJS.WritableStream & { flush?: () => void }).flush === 'function') {
        (raw as NodeJS.WritableStream & { flush: () => void }).flush();
      }
    };

    const writeError = (code: string, message: string): void => {
      writeEvent({
        type: 'error',
        createdAt: new Date().toISOString(),
        error: { code, message },
      });
    };

    const heartbeat = setInterval(() => {
      if (!closed) raw.write(': \n\n'); // SSE comment for keep-alive
    }, 15000);

    try {
      const result = await runChatWithResolvedConfig(body, (event) => {
        writeEvent(event);
      });
      if (!result.ok) {
        writeError(result.error.code, result.error.message);
      } else {
        writeEvent({
          type: 'done',
          createdAt: new Date().toISOString(),
          response: result.payload,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      writeError('ai_chat_failed', message);
    } finally {
      clearInterval(heartbeat);
      if (!closed) raw.end();
    }
  });

  app.get('/explorer', async (req, reply) => {
    try {
      const payload = await runDexExplorerQuery({
        query: (req.query ?? {}) as Record<string, unknown>,
        baseUrl: process.env.LLAMA_BASE_URL?.trim() || undefined,
      });
      return payload;
    } catch (err) {
      reply.code(500);
      return {
        ok: false,
        error: { message: err instanceof Error ? err.message : String(err) },
      };
    }
  });

  app.get('/zoomeye/hosts', async (req, reply) => {
    try {
      const payload = await runZoomeyeHostSearch({
        query: (req.query ?? {}) as Record<string, unknown>,
      });
      return payload;
    } catch (err) {
      if (err instanceof ZoomeyeQueryError) {
        reply.code(err.status);
        return {
          ok: false,
          error: { code: err.code, message: err.message },
        };
      }
      reply.code(500);
      return {
        ok: false,
        error: { code: 'internal_error', message: err instanceof Error ? err.message : String(err) },
      };
    }
  });

  app.get('/shodan/hosts', async (req, reply) => {
    try {
      const payload = await runShodanHostSearch({
        query: (req.query ?? {}) as Record<string, unknown>,
      });
      return payload;
    } catch (err) {
      if (err instanceof ShodanQueryError) {
        reply.code(err.status);
        return {
          ok: false,
          error: { code: err.code, message: err.message },
        };
      }
      reply.code(500);
      return {
        ok: false,
        error: { code: 'internal_error', message: err instanceof Error ? err.message : String(err) },
      };
    }
  });

  app.get('/shodan/searches', async (req) => {
    const q = req.query as { limit?: unknown; offset?: unknown } | null;
    const limitRaw = q?.limit != null ? Number(q.limit) : 50;
    const offsetRaw = q?.offset != null ? Number(q.offset) : 0;
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(1, limitRaw), 250) : 50;
    const offset = Number.isFinite(offsetRaw) ? Math.max(0, offsetRaw) : 0;
    return listPassedShodanSearches(projects.db(), { limit, offset });
  });

  app.get('/shodan/searches/:id', async (req, reply) => {
    const id = (req.params as { id?: unknown } | null)?.id;
    if (typeof id !== 'string' || !id.trim()) {
      reply.code(400);
      return { ok: false, error: { code: 'bad_request', message: 'Missing id.' } };
    }

    const out = getPassedShodanSearch(projects.db(), id);
    if (!out) {
      reply.code(404);
      return { ok: false, error: { code: 'not_found', message: 'No such Shodan passed search.' } };
    }
    return out;
  });

  app.get('/payloads', async (req) => {
    const q = req.query as {
      q?: unknown;
      category?: unknown;
      subcategory?: unknown;
      sourceType?: unknown;
      sourcePath?: unknown;
      tag?: unknown;
      limit?: unknown;
      offset?: unknown;
    } | null;

    const sourceTypeRaw = q?.sourceType;
    const sourceType =
      sourceTypeRaw === 'intruder' || sourceTypeRaw === 'markdown' || sourceTypeRaw === 'file'
        ? sourceTypeRaw
        : undefined;

    const limitRaw = q?.limit != null ? Number(q.limit) : 250;
    const offsetRaw = q?.offset != null ? Number(q.offset) : 0;
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(1, Math.trunc(limitRaw)), 1000) : 250;
    const offset = Number.isFinite(offsetRaw) ? Math.max(0, Math.trunc(offsetRaw)) : 0;

    const payload = searchPayloadCatalog({
      q: typeof q?.q === 'string' ? q.q : undefined,
      category: typeof q?.category === 'string' ? q.category : undefined,
      subcategory: typeof q?.subcategory === 'string' ? q.subcategory : undefined,
      sourceType,
      sourcePath: typeof q?.sourcePath === 'string' ? q.sourcePath : undefined,
      tag: typeof q?.tag === 'string' ? q.tag : undefined,
      limit,
      offset,
    });
    return { ok: true as const, ...payload };
  });

  app.post('/intruder/attack', async (req, reply) => {
    let body: ReturnType<typeof IntruderAttackRequestSchema.parse>;
    try {
      body = IntruderAttackRequestSchema.parse(req.body ?? {});
    } catch (err) {
      reply.code(400);
      return {
        ok: false,
        error: { code: 'bad_request', message: err instanceof Error ? err.message : 'Bad body' },
      };
    }

    try {
      const payload = await runIntruderAttack(body);
      return { ok: true as const, ...payload };
    } catch (err) {
      if (isIntruderInputError(err)) {
        reply.code(400);
        return {
          ok: false,
          error: { code: 'bad_request', message: err instanceof Error ? err.message : 'Invalid intruder request.' },
        };
      }

      reply.code(500);
      return {
        ok: false,
        error: { code: 'internal_error', message: err instanceof Error ? err.message : String(err) },
      };
    }
  });

  app.post('/ai/retrieve', async (_req, reply) => {
    reply.code(501);
    return notImplemented('ai_retrieve_not_implemented', {
      title: 'POST /ai/retrieve',
      requirements: [
        'Create embeddings index over messages/flows/ABIs/findings.',
        'Support query + filters; return ranked evidence links and confidence.',
        'Implement redaction/offline-only modes before any cloud calls.',
      ],
      completionSpecs: [
        'AI panel answers flow questions with clickable evidence and clear confidence.',
      ],
    });
  });

  // Local event stream (WebSocket). In milestone A this will publish capture events.
  app.get('/events', { websocket: true }, (socket: WebSocket) => {
    wsClients.add(socket);
    socket.on('close', () => wsClients.delete(socket));
    socket.on('error', (err) => {
      wsClients.delete(socket);
      app.log.debug({ err }, 'events ws error');
    });
    try {
      socket.send(
        JSON.stringify({
          type: 'hello',
          time: new Date().toISOString(),
          agentVersion: opts.agentVersion,
        }),
      );
      metrics.incWsMessage();
    } catch (err) {
      app.log.debug({ err }, 'ws send failed');
    }
  });

  return {
    app,
    async close() {
      clearInterval(metricsInterval);
      await proxy.stop();
      await foundry.stop();
      await closeAiAgentResources();
      await app.close();
      projects.closeAll();
    },
  };
}
