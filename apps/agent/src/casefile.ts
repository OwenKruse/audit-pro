import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { strToU8, unzipSync, zipSync } from 'fflate';

export type CaseManifestV1 = {
  format: 'cipherscope-case';
  version: 1;
  createdAt: string;
  agent: { name: string; version: string };
  dbFile: string;
  stats: {
    httpMessages: number;
    wsConnections: number;
    wsFrames: number;
    flows: number;
    findings: number;
  };
};

function parseManifestV1(raw: Uint8Array): CaseManifestV1 | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw).toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const p = parsed as Record<string, unknown>;
    if (p.format !== 'cipherscope-case' || p.version !== 1) return null;
    if (typeof p.createdAt !== 'string') return null;
    if (typeof p.dbFile !== 'string') return null;

    const agent = p.agent as unknown;
    if (!agent || typeof agent !== 'object') return null;
    const a = agent as Record<string, unknown>;
    if (typeof a.name !== 'string' || typeof a.version !== 'string') return null;

    const stats = p.stats as unknown;
    if (!stats || typeof stats !== 'object') return null;
    const s = stats as Record<string, unknown>;
    const required = ['httpMessages', 'wsConnections', 'wsFrames', 'flows', 'findings'] as const;
    for (const k of required) {
      if (typeof s[k] !== 'number' || !Number.isFinite(s[k])) return null;
    }

    return parsed as CaseManifestV1;
  } catch {
    return null;
  }
}

function sqlStringLiteral(value: string): string {
  // SQLite string literal escaping: single-quote doubled.
  return `'${value.replaceAll("'", "''")}'`;
}

function getCount(db: DatabaseSync, sql: string): number {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const row = db.prepare(sql).get() as any;
  const v = row?.c;
  return typeof v === 'number' ? v : 0;
}

function exportDbSnapshot(db: DatabaseSync): Buffer {
  const tmpPath = path.join(os.tmpdir(), `cipherscope-case-${Date.now()}-${randomUUID()}.db`);
  try {
    // Produce a consistent SQLite snapshot regardless of WAL state.
    db.exec(`VACUUM INTO ${sqlStringLiteral(tmpPath)};`);
    return fs.readFileSync(tmpPath);
  } finally {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // ignore
    }
  }
}

export function buildCaseZip(input: {
  db: DatabaseSync;
  agentName: string;
  agentVersion: string;
}): { zip: Buffer; manifest: CaseManifestV1 } {
  const createdAt = new Date().toISOString();
  const dbFile = 'cipherscope.db';

  const manifest: CaseManifestV1 = {
    format: 'cipherscope-case',
    version: 1,
    createdAt,
    agent: { name: input.agentName, version: input.agentVersion },
    dbFile,
    stats: {
      httpMessages: getCount(input.db, 'SELECT COUNT(*) AS c FROM http_messages;'),
      wsConnections: getCount(input.db, 'SELECT COUNT(*) AS c FROM ws_connections;'),
      wsFrames: getCount(input.db, 'SELECT COUNT(*) AS c FROM ws_frames;'),
      flows: getCount(input.db, 'SELECT COUNT(*) AS c FROM flows;'),
      findings: getCount(input.db, 'SELECT COUNT(*) AS c FROM findings;'),
    },
  };

  const dbSnapshot = exportDbSnapshot(input.db);
  const zipBytes = zipSync(
    {
      'manifest.json': strToU8(JSON.stringify(manifest, null, 2)),
      [dbFile]: dbSnapshot,
    },
    { level: 6 },
  );

  return { zip: Buffer.from(zipBytes), manifest };
}

function quoteIdent(ident: string): string {
  return `"${ident.replaceAll('"', '""')}"`;
}

function tableExists(db: DatabaseSync, schema: string, table: string): boolean {
  const sql =
    `SELECT name FROM ${quoteIdent(schema)}.sqlite_master ` +
    `WHERE type='table' AND name=? LIMIT 1;`;
  const row = db.prepare(sql).get(table) as unknown;
  return Boolean(row);
}

function listColumns(db: DatabaseSync, schema: string, table: string): string[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = db.prepare(`PRAGMA ${quoteIdent(schema)}.table_info(${quoteIdent(table)});`).all() as any[];
  return rows.map((r) => String(r?.name)).filter(Boolean);
}

export function importCaseZip(input: {
  db: DatabaseSync;
  zip: Buffer;
}): { manifest: CaseManifestV1 | null; imported: CaseManifestV1['stats'] } {
  const extracted = unzipSync(input.zip);

  const manifest = (() => {
    const raw = extracted['manifest.json'];
    if (!raw) return null;
    return parseManifestV1(raw);
  })();

  const dbFileName =
    (manifest && typeof manifest.dbFile === 'string' ? manifest.dbFile : null) ??
    Object.keys(extracted).find((k) => /\.(db|sqlite|sqlite3)$/i.test(k)) ??
    null;

  if (!dbFileName) throw new Error('Case zip is missing a SQLite database file.');
  const dbBytes = extracted[dbFileName];
  if (!dbBytes) throw new Error(`Case zip is missing expected db file: ${dbFileName}`);

  const tmpPath = path.join(os.tmpdir(), `cipherscope-import-${Date.now()}-${randomUUID()}.db`);
  fs.writeFileSync(tmpPath, Buffer.from(dbBytes));

  const importedCounts = {
    httpMessages: 0,
    wsConnections: 0,
    wsFrames: 0,
    flows: 0,
    findings: 0,
  };

  try {
    input.db.exec(`ATTACH DATABASE ${sqlStringLiteral(tmpPath)} AS imported;`);
    let began = false;
    try {
      input.db.exec('BEGIN IMMEDIATE;');
      began = true;

      const tables: Array<{ name: keyof typeof importedCounts; table: string }> = [
        { name: 'httpMessages', table: 'http_messages' },
        { name: 'wsConnections', table: 'ws_connections' },
        { name: 'wsFrames', table: 'ws_frames' },
        { name: 'flows', table: 'flows' },
        { name: 'findings', table: 'findings' },
      ];

      // Only delete/replace tables that exist in the imported database.
      for (const t of tables) {
        if (!tableExists(input.db, 'imported', t.table)) continue;

        // Clear destination.
        input.db.exec(`DELETE FROM ${quoteIdent('main')}.${quoteIdent(t.table)};`);

        const mainCols = listColumns(input.db, 'main', t.table);
        const impCols = listColumns(input.db, 'imported', t.table);
        const cols = mainCols.filter((c) => impCols.includes(c));
        if (!cols.length) continue;

        const colSql = cols.map(quoteIdent).join(', ');
        input.db.exec(
          `INSERT INTO ${quoteIdent('main')}.${quoteIdent(t.table)} (${colSql}) ` +
            `SELECT ${colSql} FROM ${quoteIdent('imported')}.${quoteIdent(t.table)};`,
        );

        importedCounts[t.name] = getCount(
          input.db,
          `SELECT COUNT(*) AS c FROM ${quoteIdent('main')}.${quoteIdent(t.table)};`,
        );
      }

      // Additional tables should be migrated as part of a "session"/project.
      // These are copied when present, but are not included in the v1 manifest stats.
      const extraTables = ['rpc_interactions', 'contract_abis', 'evm_settings'] as const;
      for (const table of extraTables) {
        if (!tableExists(input.db, 'imported', table)) continue;
        if (!tableExists(input.db, 'main', table)) continue;

        input.db.exec(`DELETE FROM ${quoteIdent('main')}.${quoteIdent(table)};`);

        const mainCols = listColumns(input.db, 'main', table);
        const impCols = listColumns(input.db, 'imported', table);
        const cols = mainCols.filter((c) => impCols.includes(c));
        if (!cols.length) continue;

        const colSql = cols.map(quoteIdent).join(', ');
        input.db.exec(
          `INSERT INTO ${quoteIdent('main')}.${quoteIdent(table)} (${colSql}) ` +
            `SELECT ${colSql} FROM ${quoteIdent('imported')}.${quoteIdent(table)};`,
        );
      }

      // Legacy table: keep if present so old UI or tools can still inspect.
      if (
        tableExists(input.db, 'imported', 'messages') &&
        tableExists(input.db, 'main', 'messages')
      ) {
        input.db.exec(`DELETE FROM ${quoteIdent('main')}.${quoteIdent('messages')};`);
        const mainCols = listColumns(input.db, 'main', 'messages');
        const impCols = listColumns(input.db, 'imported', 'messages');
        const cols = mainCols.filter((c) => impCols.includes(c));
        if (cols.length) {
          const colSql = cols.map(quoteIdent).join(', ');
          input.db.exec(
            `INSERT INTO ${quoteIdent('main')}.${quoteIdent('messages')} (${colSql}) ` +
              `SELECT ${colSql} FROM ${quoteIdent('imported')}.${quoteIdent('messages')};`,
          );
        }
      }

      input.db.exec('COMMIT;');
      began = false;
    } catch (err) {
      if (began) {
        try {
          input.db.exec('ROLLBACK;');
        } catch {
          // ignore
        }
      }
      throw err;
    } finally {
      try {
        input.db.exec('DETACH DATABASE imported;');
      } catch {
        // ignore
      }
    }
  } finally {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // ignore
    }
  }

  return { manifest, imported: importedCounts };
}
