import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  GetRpcInteractionResponseSchema,
  ListRpcInteractionsResponseSchema,
  RpcInteractionRecordRequestSchema,
  RpcInteractionRecordResponseSchema,
  RpcInteractionSchema,
  type GetRpcInteractionResponse,
  type ListRpcInteractionsResponse,
  type RpcInteraction,
  type RpcInteractionRecordRequest,
  type RpcInteractionRecordResponse,
} from '@cipherscope/proto';

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  } catch {
    return 'null';
  }
}

function safeJsonParse(raw: string | null): unknown | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function normalizeInteraction(input: {
  id: string;
  createdAt: string;
  source: string;
  rpcUrl: string | null;
  chainId: number | null;
  method: string;
  params: unknown[];
  status: string;
  error: string | null;
  durationMs: number | null;
  tx: unknown | null;
  txHash: string | null;
  result: unknown | null;
}): RpcInteraction {
  return RpcInteractionSchema.parse({
    id: input.id,
    createdAt: input.createdAt,
    source: input.source,
    rpcUrl: input.rpcUrl,
    chainId: input.chainId,
    method: input.method,
    params: input.params,
    status: input.status,
    error: input.error,
    durationMs: input.durationMs,
    tx: input.tx,
    txHash: input.txHash,
    result: input.result,
  });
}

export function recordRpcInteraction(
  db: DatabaseSync,
  input: RpcInteractionRecordRequest,
): RpcInteractionRecordResponse {
  const parsed = RpcInteractionRecordRequestSchema.parse(input);
  const id = `rpc_${randomUUID()}`;
  const createdAt = new Date().toISOString();
  const params = parsed.params ?? [];
  const txJson = parsed.tx == null ? null : safeJsonStringify(parsed.tx);
  const resultJson = parsed.result === undefined ? null : safeJsonStringify(parsed.result);

  const stmt = db.prepare(`
    INSERT INTO rpc_interactions (
      id, created_at, source, rpc_url, chain_id, method, params_json, status, error, duration_ms, tx_json, tx_hash, result_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    id,
    createdAt,
    parsed.source,
    parsed.rpcUrl ?? null,
    parsed.chainId ?? null,
    parsed.method,
    safeJsonStringify(params),
    parsed.status,
    parsed.error ?? null,
    parsed.durationMs ?? null,
    txJson,
    parsed.txHash ?? null,
    resultJson,
  );

  const item = normalizeInteraction({
    id,
    createdAt,
    source: parsed.source,
    rpcUrl: parsed.rpcUrl ?? null,
    chainId: parsed.chainId ?? null,
    method: parsed.method,
    params,
    status: parsed.status,
    error: parsed.error ?? null,
    durationMs: parsed.durationMs ?? null,
    tx: parsed.tx ?? null,
    txHash: parsed.txHash ?? null,
    result: parsed.result ?? null,
  });

  const payload = { ok: true as const, item };
  RpcInteractionRecordResponseSchema.parse(payload);
  return payload;
}

export function listRpcInteractions(
  db: DatabaseSync,
  input: { limit: number; offset: number; source?: 'wallet' | 'foundry' | null },
): ListRpcInteractionsResponse {
  const limit = Math.min(Math.max(1, input.limit), 2000);
  const offset = Math.max(0, input.offset);

  const rows = (() => {
    if (input.source) {
      const stmt = db.prepare(`
        SELECT *
        FROM rpc_interactions
        WHERE source = ?
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
      `);
      return stmt.all(input.source, limit, offset) as Array<Record<string, unknown>>;
    }
    const stmt = db.prepare(`
      SELECT *
      FROM rpc_interactions
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `);
    return stmt.all(limit, offset) as Array<Record<string, unknown>>;
  })();

  const items = rows.map((r) =>
    normalizeInteraction({
      id: String(r.id ?? ''),
      createdAt: String(r.created_at ?? ''),
      source: String(r.source ?? ''),
      rpcUrl: (r.rpc_url == null ? null : String(r.rpc_url)) as string | null,
      chainId: (typeof r.chain_id === 'number' ? r.chain_id : r.chain_id == null ? null : Number(r.chain_id)) as
        | number
        | null,
      method: String(r.method ?? ''),
      params: (safeJsonParse((r.params_json as string | null) ?? null) as unknown[]) ?? [],
      status: String(r.status ?? ''),
      error: (r.error == null ? null : String(r.error)) as string | null,
      durationMs:
        typeof r.duration_ms === 'number'
          ? r.duration_ms
          : r.duration_ms == null
            ? null
            : Number(r.duration_ms),
      tx: safeJsonParse((r.tx_json as string | null) ?? null),
      txHash: (r.tx_hash == null ? null : String(r.tx_hash)) as string | null,
      result: safeJsonParse((r.result_json as string | null) ?? null),
    }),
  );

  const payload = { ok: true as const, items };
  ListRpcInteractionsResponseSchema.parse(payload);
  return payload;
}

export function getRpcInteraction(db: DatabaseSync, id: string): GetRpcInteractionResponse | null {
  const row = db.prepare(`SELECT * FROM rpc_interactions WHERE id = ?`).get(id) as
    | undefined
    | Record<string, unknown>;
  if (!row) return null;

  const item = normalizeInteraction({
    id: String(row.id ?? ''),
    createdAt: String(row.created_at ?? ''),
    source: String(row.source ?? ''),
    rpcUrl: (row.rpc_url == null ? null : String(row.rpc_url)) as string | null,
    chainId:
      typeof row.chain_id === 'number' ? row.chain_id : row.chain_id == null ? null : Number(row.chain_id),
    method: String(row.method ?? ''),
    params: (safeJsonParse((row.params_json as string | null) ?? null) as unknown[]) ?? [],
    status: String(row.status ?? ''),
    error: (row.error == null ? null : String(row.error)) as string | null,
    durationMs:
      typeof row.duration_ms === 'number'
        ? row.duration_ms
        : row.duration_ms == null
          ? null
          : Number(row.duration_ms),
    tx: safeJsonParse((row.tx_json as string | null) ?? null),
    txHash: (row.tx_hash == null ? null : String(row.tx_hash)) as string | null,
    result: safeJsonParse((row.result_json as string | null) ?? null),
  });

  const payload = { ok: true as const, item };
  GetRpcInteractionResponseSchema.parse(payload);
  return payload;
}

