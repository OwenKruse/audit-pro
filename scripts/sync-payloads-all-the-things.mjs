#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO_URL = 'https://github.com/swisskyrepo/PayloadsAllTheThings.git';
const OUTPUT_PATH = path.resolve(
  process.cwd(),
  'apps/agent/src/payloads-all-the-things.catalog.json',
);

const NON_PAYLOAD_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.svg',
  '.webp',
  '.ico',
  '.pdf',
  '.zip',
  '.gz',
  '.7z',
  '.rar',
  '.mp4',
  '.mov',
  '.avi',
  '.swf',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.mp3',
  '.wav',
  '.jar',
  '.class',
  '.pyc',
  '.db',
  '.sqlite',
]);

const SKIP_PATH_PARTS = new Set(['.git', '.github', 'Images', '_LEARNING_AND_SOCIALS']);
const MAX_PAYLOAD_CHARS = 1_200;

function run(cmd, args, options = {}) {
  execFileSync(cmd, args, { stdio: 'pipe', ...options });
}

function runOut(cmd, args, options = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: 'pipe', ...options }).trim();
}

function walkFiles(rootDir) {
  const out = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_PATH_PARTS.has(entry.name)) continue;
        stack.push(absolute);
      } else if (entry.isFile()) {
        out.push(absolute);
      }
    }
  }
  return out;
}

function normalizeSegments(relativePath) {
  return relativePath
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function toTag(value) {
  return value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '');
}

function includeFile(relativePath) {
  const ext = path.extname(relativePath).toLowerCase();
  if (NON_PAYLOAD_EXTENSIONS.has(ext)) return false;

  const segments = normalizeSegments(relativePath);
  if (segments.length === 0) return false;
  if (segments.length < 2) return false;
  if (segments.some((segment) => SKIP_PATH_PARTS.has(segment))) return false;
  if (segments[0].startsWith('.') || segments[0].startsWith('_')) return false;
  if (segments[0] === 'Methodology and Resources') return false;

  const basename = path.basename(relativePath).toLowerCase();
  if (basename === 'license' || basename === 'mkdocs.yml' || basename === 'custom.css') return false;
  if (basename.endsWith('.ipynb')) return false;

  return true;
}

function cleanPayloadLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_PAYLOAD_CHARS) return null;
  if (/^\s*#{1,6}\s+/.test(trimmed)) return null;
  if (/^\s*[-*]{3,}\s*$/.test(trimmed)) return null;
  if (/^\s*\/\/\s*/.test(trimmed)) return null;
  if (/^\s*#\s+/.test(trimmed)) return null;
  if (/^\s*;\s*/.test(trimmed)) return null;
  if (/^\s*--\s+/.test(trimmed)) return null;
  if (/^\s*\|?[-:|\s]+\|?\s*$/.test(trimmed)) return null;
  return trimmed;
}

function extractFromText(content) {
  const out = [];
  for (const rawLine of content.split(/\r?\n/g)) {
    const line = cleanPayloadLine(rawLine);
    if (!line) continue;
    out.push(line);
  }
  return out;
}

function extractFromMarkdown(content) {
  const out = [];

  const fencedBlockRegex = /```([^\n`]*)\n([\s\S]*?)```/g;
  for (const match of content.matchAll(fencedBlockRegex)) {
    const blockBody = match[2] ?? '';
    for (const rawLine of blockBody.split(/\r?\n/g)) {
      const line = cleanPayloadLine(rawLine);
      if (!line) continue;
      out.push(line);
    }
  }

  const inlineRegex = /`([^`\r\n]{1,1200})`/g;
  for (const rawLine of content.split(/\r?\n/g)) {
    const line = rawLine.trim();
    if (!line) continue;
    const isLikelyPayloadLine =
      line.startsWith('-') || line.startsWith('*') || line.includes('|') || line.includes('payload');
    if (!isLikelyPayloadLine) continue;
    for (const match of line.matchAll(inlineRegex)) {
      const candidate = cleanPayloadLine(match[1] ?? '');
      if (!candidate) continue;
      out.push(candidate);
    }
  }

  return out;
}

function extractPayloads(relativePath, content) {
  if (relativePath.toLowerCase().endsWith('.md')) return extractFromMarkdown(content);
  return extractFromText(content);
}

function buildSourceType(relativePath) {
  const pathLower = relativePath.toLowerCase();
  if (pathLower.includes('/intruder/') || pathLower.includes('/intruders/')) return 'intruder';
  if (pathLower.endsWith('.md')) return 'markdown';
  return 'file';
}

function buildCategoryParts(relativePath) {
  const segments = normalizeSegments(relativePath);
  const category = segments[0] ?? 'misc';
  const subcategory = segments.length > 2 ? segments[1] : null;
  return { category, subcategory };
}

function buildTags(relativePath, sourceType) {
  const segments = normalizeSegments(relativePath);
  const tags = new Set();

  for (const segment of segments.slice(0, Math.max(0, segments.length - 1))) {
    const tag = toTag(segment);
    if (tag) tags.add(tag);
  }
  tags.add(sourceType);
  return [...tags];
}

function tryReadUtf8(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'payloads-all-the-things-'));
  const cloneDir = path.join(tmpRoot, 'repo');

  run('git', ['clone', '--depth', '1', REPO_URL, cloneDir]);
  const commit = runOut('git', ['-C', cloneDir, 'rev-parse', 'HEAD']);

  const allFiles = walkFiles(cloneDir);
  const included = allFiles.filter((absolutePath) => {
    const relativePath = path.relative(cloneDir, absolutePath).replaceAll(path.sep, '/');
    return includeFile(relativePath);
  });

  let idCounter = 0;
  const seen = new Set();
  const items = [];

  for (const absolutePath of included) {
    const relativePath = path.relative(cloneDir, absolutePath).replaceAll(path.sep, '/');
    const content = tryReadUtf8(absolutePath);
    if (!content) continue;

    const extracted = extractPayloads(relativePath, content);
    if (extracted.length === 0) continue;

    const sourceType = buildSourceType(relativePath);
    const { category, subcategory } = buildCategoryParts(relativePath);
    const tags = buildTags(relativePath, sourceType);

    for (const payload of extracted) {
      const dedupeKey = `${relativePath}\u0000${payload}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      idCounter += 1;
      items.push({
        id: `pattt_${idCounter}`,
        value: payload,
        category,
        subcategory,
        sourcePath: relativePath,
        sourceType,
        tags,
      });
    }
  }

  const payload = {
    source: {
      repo: 'swisskyrepo/PayloadsAllTheThings',
      url: 'https://github.com/swisskyrepo/PayloadsAllTheThings',
      commit,
      generatedAt: new Date().toISOString(),
      fileCount: included.length,
      payloadCount: items.length,
    },
    items,
  };

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(payload, null, 2), 'utf8');

  process.stdout.write(
    `Wrote ${items.length} payload entries from ${included.length} files to ${OUTPUT_PATH}\n`,
  );
}

main();
