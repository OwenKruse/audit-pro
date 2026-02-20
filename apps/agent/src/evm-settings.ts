import type { DatabaseSync } from 'node:sqlite';

export type EvmForkSettings = {
  hasSavedConfig: boolean;
  forkUrl: string | null;
  forkBlockNumber: number | null;
  chainId: number | null;
  updatedAt: string | null;
};

type EvmForkSettingsRow = {
  updated_at: string;
  fork_url: string | null;
  fork_block_number: number | null;
  chain_id: number | null;
};

export function getEvmForkSettings(db: DatabaseSync): EvmForkSettings {
  const row = db
    .prepare(
      `
      SELECT updated_at, fork_url, fork_block_number
      , chain_id
      FROM evm_settings
      WHERE id = 1
    `,
    )
    .get() as EvmForkSettingsRow | undefined;

  if (!row) {
    return {
      hasSavedConfig: false,
      forkUrl: null,
      forkBlockNumber: null,
      chainId: null,
      updatedAt: null,
    };
  }

  return {
    hasSavedConfig: true,
    forkUrl: row.fork_url ?? null,
    forkBlockNumber: row.fork_block_number ?? null,
    chainId: row.chain_id ?? null,
    updatedAt: row.updated_at,
  };
}

export function upsertEvmForkSettings(
  db: DatabaseSync,
  input: { forkUrl: string | null; forkBlockNumber: number | null; chainId: number | null },
): EvmForkSettings {
  const now = new Date().toISOString();
  db.prepare(
    `
    INSERT INTO evm_settings (id, updated_at, fork_url, fork_block_number, chain_id)
    VALUES (1, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      updated_at = excluded.updated_at,
      fork_url = excluded.fork_url,
      fork_block_number = excluded.fork_block_number,
      chain_id = excluded.chain_id
  `,
  ).run(now, input.forkUrl, input.forkBlockNumber, input.chainId);

  return {
    hasSavedConfig: true,
    forkUrl: input.forkUrl,
    forkBlockNumber: input.forkBlockNumber,
    chainId: input.chainId,
    updatedAt: now,
  };
}

export function deleteEvmForkSettings(db: DatabaseSync): EvmForkSettings {
  db.prepare(`DELETE FROM evm_settings WHERE id = 1`).run();
  return {
    hasSavedConfig: false,
    forkUrl: null,
    forkBlockNumber: null,
    chainId: null,
    updatedAt: null,
  };
}
