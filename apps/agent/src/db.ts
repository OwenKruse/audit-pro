import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { MetricsHandle } from './metrics.js';

export type AgentDb = {
  path: string;
  db: DatabaseSync;
  close: () => void;
};

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as any[];
  return rows.some((r) => r?.name === column);
}

function ensureColumn(db: DatabaseSync, table: string, column: string, typeSql: string) {
  if (hasColumn(db, table, column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${typeSql};`);
}

function timedWrite<T>(metrics: MetricsHandle, fn: () => T): T {
  const start = performance.now();
  const out = fn();
  const elapsed = performance.now() - start;
  metrics.recordDbWrite(elapsed);
  return out;
}

export function openAgentDb(opts: { dbPath: string; metrics: MetricsHandle }): AgentDb {
  const resolved = path.resolve(opts.dbPath);
  ensureDir(path.dirname(resolved));

  const db = new DatabaseSync(resolved);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');

  // Minimal durable capture schema. The capture pipeline will populate these.
  timedWrite(opts.metrics, () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        protocol TEXT NOT NULL,
        method TEXT,
        url TEXT,
        request_headers TEXT,
        request_body BLOB,
        response_status INTEGER,
        response_headers TEXT,
        response_body BLOB,
        timing_json TEXT
      );

      -- HTTP proxy captures (Milestone A). This table backs the History + Repeater UIs.
      CREATE TABLE IF NOT EXISTS http_messages (
        id TEXT PRIMARY KEY,
        parent_id TEXT,
        created_at TEXT NOT NULL,
        scheme TEXT NOT NULL,
        host TEXT NOT NULL,
        port INTEGER NOT NULL,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        url TEXT NOT NULL,
        state TEXT NOT NULL,

        request_headers_json TEXT NOT NULL,
        request_cookies_json TEXT NOT NULL,
        request_query_json TEXT NOT NULL,
        request_body BLOB,
        request_body_text TEXT,
        request_body_json TEXT,

        response_status INTEGER,
        response_headers_json TEXT,
        response_body BLOB,
        response_body_text TEXT,
        response_body_json TEXT,

        replay_diff_json TEXT,
        timing_json TEXT NOT NULL,
        error TEXT
      );

      CREATE INDEX IF NOT EXISTS http_messages_created_at ON http_messages(created_at);
      CREATE INDEX IF NOT EXISTS http_messages_host ON http_messages(host);
      CREATE INDEX IF NOT EXISTS http_messages_state ON http_messages(state);

      -- WebSocket frames captured for ws:// and wss:// (wss requires TLS MITM + trusted CA).
      CREATE TABLE IF NOT EXISTS ws_connections (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        scheme TEXT NOT NULL,
        host TEXT NOT NULL,
        port INTEGER NOT NULL,
        path TEXT NOT NULL,
        url TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ws_frames (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        direction TEXT NOT NULL,
        opcode INTEGER NOT NULL,
        payload BLOB NOT NULL,
        payload_text TEXT,
        payload_json TEXT
      );

      CREATE INDEX IF NOT EXISTS ws_frames_connection_id ON ws_frames(connection_id);
      CREATE INDEX IF NOT EXISTS ws_frames_created_at ON ws_frames(created_at);

      -- RPC interactions captured from the UI (wallet/foundry calls). Used by RpcHistoryPanel and AI tools.
      CREATE TABLE IF NOT EXISTS rpc_interactions (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        source TEXT NOT NULL,
        rpc_url TEXT,
        chain_id INTEGER,
        method TEXT NOT NULL,
        params_json TEXT NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        duration_ms REAL,
        tx_json TEXT,
        tx_hash TEXT,
        result_json TEXT
      );

      CREATE INDEX IF NOT EXISTS rpc_interactions_created_at ON rpc_interactions(created_at);
      CREATE INDEX IF NOT EXISTS rpc_interactions_source ON rpc_interactions(source);
      CREATE INDEX IF NOT EXISTS rpc_interactions_method ON rpc_interactions(method);

      CREATE TABLE IF NOT EXISTS flows (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        tag_json TEXT,
        step_ids_json TEXT
      );

      CREATE TABLE IF NOT EXISTS findings (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        severity TEXT,
        confidence REAL,
        title TEXT,
        description_md TEXT,
        evidence_json TEXT,
        status TEXT
      );

      CREATE TABLE IF NOT EXISTS contract_abis (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        chain_id INTEGER,
        address TEXT,
        name TEXT NOT NULL,
        source TEXT NOT NULL,
        notes TEXT,
        abi_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS contract_abis_updated_at ON contract_abis(updated_at);
      CREATE INDEX IF NOT EXISTS contract_abis_chain_address ON contract_abis(chain_id, address);

      -- Agent-controlled EVM defaults (fork config, etc.). Single-row table.
      CREATE TABLE IF NOT EXISTS evm_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        updated_at TEXT NOT NULL,
        fork_url TEXT,
        fork_block_number INTEGER,
        chain_id INTEGER
      );

      -- Proxy capture settings (ignored hosts, etc.). Single-row table.
      CREATE TABLE IF NOT EXISTS proxy_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        updated_at TEXT NOT NULL,
        ignored_hosts_json TEXT NOT NULL DEFAULT '[]'
      );

      -- Durable OWASP ZAP scan tracking (left-nav scanner + AI tools).
      CREATE TABLE IF NOT EXISTS zap_scans (
        id TEXT PRIMARY KEY,
        target TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        status TEXT NOT NULL,
        config_json TEXT NOT NULL,
        state_json TEXT NOT NULL,
        summary_json TEXT NOT NULL,
        error TEXT
      );

      CREATE INDEX IF NOT EXISTS zap_scans_created_at ON zap_scans(created_at);
      CREATE INDEX IF NOT EXISTS zap_scans_status ON zap_scans(status);

      -- Successful AI search_shodan_hosts tool runs for host-search history UI.
      CREATE TABLE IF NOT EXISTS ai_shodan_searches (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        query TEXT NOT NULL,
        page INTEGER NOT NULL,
        page_size INTEGER NOT NULL,
        facets TEXT,
        minify INTEGER NOT NULL DEFAULT 0,
        total INTEGER,
        count INTEGER NOT NULL,
        summary TEXT NOT NULL,
        args_json TEXT NOT NULL,
        meta_json TEXT,
        items_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS ai_shodan_searches_created_at ON ai_shodan_searches(created_at DESC);
    `);

    // Lightweight migrations for existing SQLite files.
    ensureColumn(db, 'http_messages', 'parent_id', 'TEXT');
    ensureColumn(db, 'http_messages', 'replay_diff_json', 'TEXT');
    ensureColumn(db, 'evm_settings', 'chain_id', 'INTEGER');
    ensureColumn(db, 'proxy_settings', 'ignored_hosts_json', `TEXT NOT NULL DEFAULT '[]'`);
    db.exec('CREATE INDEX IF NOT EXISTS http_messages_parent_id ON http_messages(parent_id);');
  });

  return {
    path: resolved,
    db,
    close() {
      db.close();
    },
  };
}
