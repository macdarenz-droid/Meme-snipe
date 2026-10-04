#!/usr/bin/env node
// CI-SHARD: proves the sharded test jobs ran every test file exactly once. Reads the full file list
// (`vitest list --filesOnly --json`: [{ file, projectName }]) and each shard's JSON report (vitest's json reporter:
// { success, testResults: [{ name }] }); fails when a shard did not pass, when a file ran in no shard or in two,
// or when a shard ran a file the list does not hold. Paths are compared relative to the working directory.
// Usage: node .github/scripts/shard-cover.mjs <list.json> <shard-1.json> [<shard-2.json> ...]
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const [listPath, ...shardPaths] = process.argv.slice(2);
const problems = [];
const rel = (f) => relative(process.cwd(), resolve(f));
const read = (p) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    problems.push(`${p}: unreadable (${e instanceof Error ? e.message : 'error'})`);
    return null;
  }
};

if (listPath === undefined || shardPaths.length === 0) {
  console.error('usage: shard-cover.mjs <list.json> <shard.json>...');
  process.exit(2);
}

const list = read(listPath);
const all = new Set();
if (list !== null) {
  if (!Array.isArray(list) || list.length === 0) problems.push(`${listPath}: no test files listed`);
  else for (const x of list) {
    const f = rel(x.file);
    if (all.has(f)) problems.push(`${f}: listed twice (in two projects?)`);
    all.add(f);
  }
}

const ranIn = new Map();
for (const p of shardPaths) {
  const r = read(p);
  if (r === null) continue;
  if (r.success !== true) problems.push(`${p}: the shard did not pass`);
  for (const t of Array.isArray(r.testResults) ? r.testResults : []) {
    const f = rel(t.name);
    ranIn.set(f, [...(ranIn.get(f) ?? []), p]);
  }
}

for (const [f, shards] of ranIn) {
  if (shards.length > 1) problems.push(`${f}: ran in ${shards.length} shards (${shards.join(', ')})`);
  if (!all.has(f)) problems.push(`${f}: ran but is not in the file list`);
}
for (const f of all) if (!ranIn.has(f)) problems.push(`${f}: ran in no shard`);

if (problems.length > 0) {
  for (const x of problems) console.error(`::error::${x}`);
  process.exit(1);
}
console.log(`Every one of the ${all.size} test files ran exactly once across ${shardPaths.length} shards.`);
