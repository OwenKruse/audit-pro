declare module 'node:sqlite' {
  // Minimal typings for Node's experimental built-in SQLite module.
  // This avoids taking a native dependency (better-sqlite3/sqlite3) for the skeleton.
  export class DatabaseSync {
    constructor(filename: string);
    prepare(sql: string): StatementSync;
    exec(sql: string): void;
    close(): void;
  }

  export class StatementSync {
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    iterate(...params: unknown[]): Iterable<unknown>;
    columns(): Array<{ name: string }>;
  }
  export class Session {}
  export const constants: Record<string, unknown>;
  export function backup(...args: unknown[]): unknown;
}
