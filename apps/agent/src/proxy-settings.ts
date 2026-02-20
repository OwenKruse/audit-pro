import type { DatabaseSync } from 'node:sqlite';

export type ProxyCaptureSettings = {
  hasSavedConfig: boolean;
  ignoredHosts: string[];
  updatedAt: string | null;
};

type ProxySettingsRow = {
  updated_at: string;
  ignored_hosts_json: string | null;
};

export function normalizeIgnoredHost(input: string): string | null {
  let out = input.trim().toLowerCase();
  if (!out) return null;

  // Accept bracketed IPv6 input and normalize to bare host form.
  if (out.startsWith('[') && out.endsWith(']')) {
    out = out.slice(1, -1).trim();
  }

  // Trim trailing DNS dot.
  out = out.replace(/\.+$/, '');
  if (!out) return null;

  // Accept "host:port" entries and keep host only. Skip IPv6-like values.
  const colonCount = (out.match(/:/g) ?? []).length;
  if (colonCount === 1) {
    const idx = out.lastIndexOf(':');
    const maybePort = out.slice(idx + 1);
    if (/^\d+$/.test(maybePort)) {
      out = out.slice(0, idx).trim();
    }
  }

  return out || null;
}

export function sanitizeIgnoredHosts(input: string[]): string[] {
  const out = new Set<string>();
  for (const value of input) {
    const normalized = normalizeIgnoredHost(value);
    if (!normalized) continue;
    out.add(normalized);
  }
  return [...out].sort();
}

function parseIgnoredHostsJson(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const hosts = parsed.filter((item): item is string => typeof item === 'string');
    return sanitizeIgnoredHosts(hosts);
  } catch {
    return [];
  }
}

export function getProxyCaptureSettings(db: DatabaseSync): ProxyCaptureSettings {
  const row = db
    .prepare(
      `
      SELECT updated_at, ignored_hosts_json
      FROM proxy_settings
      WHERE id = 1
    `,
    )
    .get() as ProxySettingsRow | undefined;

  if (!row) {
    return {
      hasSavedConfig: false,
      ignoredHosts: [],
      updatedAt: null,
    };
  }

  return {
    hasSavedConfig: true,
    ignoredHosts: parseIgnoredHostsJson(row.ignored_hosts_json ?? null),
    updatedAt: row.updated_at,
  };
}

export function upsertProxyCaptureSettings(
  db: DatabaseSync,
  input: { ignoredHosts: string[] },
): ProxyCaptureSettings {
  const now = new Date().toISOString();
  const ignoredHosts = sanitizeIgnoredHosts(input.ignoredHosts);
  db.prepare(
    `
    INSERT INTO proxy_settings (id, updated_at, ignored_hosts_json)
    VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      updated_at = excluded.updated_at,
      ignored_hosts_json = excluded.ignored_hosts_json
  `,
  ).run(now, JSON.stringify(ignoredHosts));

  return {
    hasSavedConfig: true,
    ignoredHosts,
    updatedAt: now,
  };
}
