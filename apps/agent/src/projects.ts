import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { MetricsHandle } from './metrics.js';
import { openAgentDb, type AgentDb } from './db.js';

export type ProjectMeta = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  dbPath: string;
};

type ProjectIndexV1 = {
  version: 1;
  currentId: string;
  projects: ProjectMeta[];
};

function nowIso(): string {
  return new Date().toISOString();
}

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

function atomicWriteFile(filePath: string, contents: string) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, contents, 'utf8');
  fs.renameSync(tmp, filePath);
}

function loadIndex(filePath: string): ProjectIndexV1 | null {
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object') return null;
  const p = parsed as Record<string, unknown>;
  if (p.version !== 1) return null;
  if (typeof p.currentId !== 'string') return null;
  if (!Array.isArray(p.projects)) return null;

  const projects: ProjectMeta[] = [];
  for (const item of p.projects) {
    if (!item || typeof item !== 'object') return null;
    const it = item as Record<string, unknown>;
    if (typeof it.id !== 'string' || !it.id) return null;
    if (typeof it.name !== 'string' || !it.name) return null;
    if (typeof it.createdAt !== 'string' || !it.createdAt) return null;
    if (typeof it.updatedAt !== 'string' || !it.updatedAt) return null;
    if (typeof it.dbPath !== 'string' || !it.dbPath) return null;
    projects.push({
      id: it.id,
      name: it.name,
      createdAt: it.createdAt,
      updatedAt: it.updatedAt,
      dbPath: it.dbPath,
    });
  }

  return {
    version: 1,
    currentId: p.currentId,
    projects,
  };
}

function saveIndex(filePath: string, idx: ProjectIndexV1) {
  atomicWriteFile(filePath, `${JSON.stringify(idx, null, 2)}\n`);
}

export class ProjectManager {
  #metrics: MetricsHandle;
  #projectsDir: string;
  #indexPath: string;
  #index: ProjectIndexV1;
  #open = new Map<string, AgentDb>();

  constructor(opts: { projectsDir: string; metrics: MetricsHandle }) {
    this.#projectsDir = path.resolve(opts.projectsDir);
    this.#indexPath = path.join(this.#projectsDir, 'index.json');
    this.#metrics = opts.metrics;
    this.#index = { version: 1, currentId: 'default', projects: [] };
  }

  init(opts: { legacyDbPath: string }) {
    ensureDir(this.#projectsDir);

    const loaded = loadIndex(this.#indexPath);
    if (loaded && loaded.projects.length) {
      // Normalize currentId if it points to a missing project.
      const hasCurrent = loaded.projects.some((p) => p.id === loaded.currentId);
      const first = loaded.projects[0];
      if (!first) throw new Error('projects index is missing projects.');
      this.#index = {
        ...loaded,
        currentId: hasCurrent ? loaded.currentId : first.id,
      };
      return;
    }

    // First run: create a "default" project pointing at the provided dbPath to preserve
    // existing behavior/config (AGENT_DB_PATH).
    const createdAt = nowIso();
    const dbPath = path.resolve(opts.legacyDbPath);
    const meta: ProjectMeta = {
      id: 'default',
      name: 'Default',
      createdAt,
      updatedAt: createdAt,
      dbPath,
    };
    this.#index = { version: 1, currentId: meta.id, projects: [meta] };
    saveIndex(this.#indexPath, this.#index);

    // Ensure the legacy DB exists and has schema.
    this.openDb(meta.id);
  }

  list(): ProjectMeta[] {
    // Most-recent first.
    return [...this.#index.projects].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  current(): ProjectMeta {
    const p = this.#index.projects.find((x) => x.id === this.#index.currentId) ?? null;
    if (!p) throw new Error('No current project.');
    return p;
  }

  setCurrent(id: string): ProjectMeta {
    const p = this.#index.projects.find((x) => x.id === id) ?? null;
    if (!p) throw new Error('No such project.');
    this.#index.currentId = id;
    this.touch(id);
    saveIndex(this.#indexPath, this.#index);
    // Ensure it is opened for immediate use.
    this.openDb(id);
    return this.current();
  }

  touch(id: string) {
    const i = this.#index.projects.findIndex((p) => p.id === id);
    if (i === -1) return;
    const prev = this.#index.projects[i];
    if (!prev) return;
    this.#index.projects[i] = { ...prev, updatedAt: nowIso() };
  }

  create(opts?: { name?: string }): ProjectMeta {
    const createdAt = nowIso();
    const id = randomUUID();
    const safeName = typeof opts?.name === 'string' && opts.name.trim() ? opts.name.trim() : 'New Project';
    const dir = path.join(this.#projectsDir, id);
    ensureDir(dir);
    const dbPath = path.join(dir, 'cipherscope.db');

    const meta: ProjectMeta = {
      id,
      name: safeName,
      createdAt,
      updatedAt: createdAt,
      dbPath,
    };
    this.#index.projects.push(meta);
    this.#index.currentId = id;
    saveIndex(this.#indexPath, this.#index);

    this.openDb(id);
    return meta;
  }

  openDb(id: string): AgentDb {
    const existing = this.#open.get(id);
    if (existing) return existing;

    const meta = this.#index.projects.find((p) => p.id === id) ?? null;
    if (!meta) throw new Error('No such project.');

    const handle = openAgentDb({ dbPath: meta.dbPath, metrics: this.#metrics });
    this.#open.set(id, handle);
    return handle;
  }

  db(): DatabaseSync {
    const meta = this.current();
    return this.openDb(meta.id).db;
  }

  dbPath(): string {
    const meta = this.current();
    return this.openDb(meta.id).path;
  }

  closeAll() {
    for (const [, h] of this.#open) {
      try {
        h.close();
      } catch {
        // ignore
      }
    }
    this.#open.clear();
  }
}
