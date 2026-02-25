#!/usr/bin/env node
/**
 * Filter live_blocklist.ndjson to liveLikely === true, then output only URLs
 * sorted by most techTags first.
 * Usage: node scripts/filter-live-blocklist.mjs [input.ndjson] [output.txt]
 * Defaults: apps/ui/live_blocklist.ndjson -> stdout (or apps/ui/live_blocklist_filtered_urls.txt if output given)
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const cwd = process.cwd();
const defaultInput = path.join(cwd, 'apps/ui/live_blocklist.ndjson');
const defaultOutput = path.join(cwd, 'apps/ui/live_blocklist_filtered_urls.txt');

const inputPath = path.resolve(cwd, process.argv[2] || defaultInput);
const outputPath = process.argv[3] ? path.resolve(cwd, process.argv[3]) : defaultOutput;
const writeToFile = process.argv[3] !== undefined;

const entries = [];

const rl = readline.createInterface({
  input: fs.createReadStream(inputPath, { encoding: 'utf8' }),
  crlfDelay: Infinity,
});

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const obj = JSON.parse(trimmed);
    if (obj.liveLikely !== true) return;
    const url = obj.finalUrl || obj.normalizedUrl || obj.inputUrl || '';
    const tagCount = Array.isArray(obj.techTags) ? obj.techTags.length : 0;
    entries.push({ url, tagCount });
  } catch (_) {}
});

rl.on('close', () => {
  entries.sort((a, b) => b.tagCount - a.tagCount);
  const lines = entries.map((e) => e.url).join('\n');
  if (writeToFile) {
    fs.writeFileSync(outputPath, lines + '\n', 'utf8');
    console.log(`Wrote ${entries.length} URLs (most tags first) -> ${outputPath}`);
  } else {
    process.stdout.write(lines + (lines ? '\n' : ''));
  }
});

rl.on('error', (err) => {
  console.error('Read error:', err);
  process.exit(1);
});
