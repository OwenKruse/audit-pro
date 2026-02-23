import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type PayloadSourceType = 'intruder' | 'markdown' | 'file';

export type PayloadCatalogItem = {
  id: string;
  value: string;
  category: string;
  subcategory: string | null;
  sourcePath: string;
  sourceType: PayloadSourceType;
  tags: string[];
};

export type PayloadCatalogDocument = {
  source: {
    repo: string;
    url: string;
    commit: string;
    generatedAt: string;
    fileCount: number;
    payloadCount: number;
  };
  items: PayloadCatalogItem[];
};

export type PayloadSearchInput = {
  q?: string;
  category?: string;
  subcategory?: string;
  sourceType?: PayloadSourceType;
  sourcePath?: string;
  tag?: string;
  limit?: number;
  offset?: number;
};

export type PayloadSearchResult = {
  source: PayloadCatalogDocument['source'];
  total: number;
  count: number;
  limit: number;
  offset: number;
  categories: string[];
  subcategories: string[];
  sourceTypes: PayloadSourceType[];
  tags: string[];
  items: PayloadCatalogItem[];
};

const CATALOG_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'payloads-all-the-things.catalog.json',
);

let cachedCatalog: PayloadCatalogDocument | null = null;

function loadPayloadCatalogFromDisk(): PayloadCatalogDocument {
  const text = fs.readFileSync(CATALOG_PATH, 'utf8');
  const parsed = JSON.parse(text) as PayloadCatalogDocument;

  if (!parsed || typeof parsed !== 'object') throw new Error('Invalid payload catalog format.');
  if (!parsed.source || typeof parsed.source !== 'object') throw new Error('Missing payload source metadata.');
  if (!Array.isArray(parsed.items)) throw new Error('Invalid payload items list.');

  return parsed;
}

export function getPayloadCatalog(): PayloadCatalogDocument {
  if (cachedCatalog) return cachedCatalog;
  cachedCatalog = loadPayloadCatalogFromDisk();
  return cachedCatalog;
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function matchesQuery(item: PayloadCatalogItem, q: string): boolean {
  if (!q) return true;
  const needle = normalize(q);
  if (!needle) return true;
  if (normalize(item.value).includes(needle)) return true;
  if (normalize(item.category).includes(needle)) return true;
  if (normalize(item.subcategory ?? '').includes(needle)) return true;
  if (normalize(item.sourcePath).includes(needle)) return true;
  return item.tags.some((tag) => normalize(tag).includes(needle));
}

export function searchPayloadCatalog(input: PayloadSearchInput): PayloadSearchResult {
  const catalog = getPayloadCatalog();
  const limitRaw = input.limit ?? 200;
  const offsetRaw = input.offset ?? 0;
  const limit = Math.min(1000, Math.max(1, Math.trunc(limitRaw)));
  const offset = Math.max(0, Math.trunc(offsetRaw));

  const category = input.category ? normalize(input.category) : '';
  const subcategory = input.subcategory ? normalize(input.subcategory) : '';
  const sourcePath = input.sourcePath ? normalize(input.sourcePath) : '';
  const tag = input.tag ? normalize(input.tag) : '';

  const filtered = catalog.items.filter((item) => {
    if (category && normalize(item.category) !== category) return false;
    if (subcategory && normalize(item.subcategory ?? '') !== subcategory) return false;
    if (input.sourceType && item.sourceType !== input.sourceType) return false;
    if (sourcePath && !normalize(item.sourcePath).includes(sourcePath)) return false;
    if (tag && !item.tags.some((entry) => normalize(entry) === tag)) return false;
    if (!matchesQuery(item, input.q ?? '')) return false;
    return true;
  });

  const sorted = [...filtered].sort((a, b) => {
    const cat = a.category.localeCompare(b.category);
    if (cat !== 0) return cat;
    const src = a.sourcePath.localeCompare(b.sourcePath);
    if (src !== 0) return src;
    return a.value.localeCompare(b.value);
  });

  const items = sorted.slice(offset, offset + limit);

  const categories = [...new Set(filtered.map((item) => item.category))].sort((a, b) =>
    a.localeCompare(b),
  );
  const subcategories = [
    ...new Set(filtered.map((item) => item.subcategory).filter((value): value is string => Boolean(value))),
  ].sort((a, b) => a.localeCompare(b));
  const sourceTypes = [...new Set(filtered.map((item) => item.sourceType))].sort() as PayloadSourceType[];
  const tags = [...new Set(filtered.flatMap((item) => item.tags))].sort((a, b) => a.localeCompare(b));

  return {
    source: catalog.source,
    total: filtered.length,
    count: items.length,
    limit,
    offset,
    categories,
    subcategories,
    sourceTypes,
    tags,
    items,
  };
}

export function resolvePayloadSetFromCatalog(input: {
  q?: string;
  category?: string;
  subcategory?: string;
  sourceType?: PayloadSourceType;
  sourcePath?: string;
  tag?: string;
  limit?: number;
}): string[] {
  const result = searchPayloadCatalog({
    q: input.q,
    category: input.category,
    subcategory: input.subcategory,
    sourceType: input.sourceType,
    sourcePath: input.sourcePath,
    tag: input.tag,
    limit: input.limit ?? 500,
    offset: 0,
  });
  return [...new Set(result.items.map((item) => item.value))];
}
