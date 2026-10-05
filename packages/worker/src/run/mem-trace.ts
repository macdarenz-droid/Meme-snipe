// MEM-TRACE: the worker's memory, sampled every MEM_EVERY_MS into mem.json in the state dir, so the next boot can tell a
// death near a memory limit (V8's heap limit, the unit's MemoryMax) from another kill. Both leave no stop line; the
// restart loop of 5 Oct showed only "no clean stop". The next boot (the unit's `--reconcile` pre-step) reads the last
// sample and, when it was near a limit and taken just before the death, says so in `last_exit`.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getHeapStatistics } from 'node:v8';
import { atomicWrite } from './state.ts';
import { FRAME } from './crash-site.ts';

export const MEM_FILE = 'mem.json';
export const MEM_EVERY_MS = 10_000;
/** A sample at or above this share of a limit is "near" it. */
export const NEAR_LIMIT = 0.9;

export interface MemSample {
  readonly at: number;
  readonly heap_used: number;
  readonly heap_limit: number;
  readonly rss: number;
  readonly external: number;
  readonly array_buffers: number;
  /** The cgroup's memory.max (the unit's MemoryMax) in bytes, or null when unlimited or unreadable. */
  readonly cgroup_max: number | null;
}

/** The cgroup v2 memory limit of this process, or null. */
export const cgroupMax = (path = '/sys/fs/cgroup/memory.max'): number | null => {
  try {
    const t = readFileSync(path, 'utf8').trim();
    const n = Number(t);
    return t !== 'max' && Number.isSafeInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
};

export const sampleMem = (at: number, cgroup: number | null): MemSample => {
  const u = process.memoryUsage();
  return {
    at, heap_used: u.heapUsed, heap_limit: getHeapStatistics().heap_size_limit, rss: u.rss, external: u.external, array_buffers: u.arrayBuffers,
    cgroup_max: cgroup,
  };
};

export const writeMem = (dir: string, s: MemSample): void => atomicWrite(join(dir, MEM_FILE), `${JSON.stringify(s)}\n`);

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** The last sample, or null when absent or not in the expected shape. */
export const readMem = (dir: string): MemSample | null => {
  const path = join(dir, MEM_FILE);
  if (!existsSync(path)) return null;
  try {
    const v = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const keys = ['at', 'heap_used', 'heap_limit', 'rss', 'external', 'array_buffers'];
    if (!keys.every((k) => num(v[k])) || !(v['cgroup_max'] === null || num(v['cgroup_max']))) return null;
    return v as unknown as MemSample;
  } catch {
    return null;
  }
};

const mb = (b: number): number => Math.round(b / 1_048_576);

/**
 * How a process that left no stop line died, from its last sample: near V8's heap limit or near the cgroup limit, when
 * the sample was taken at most two periods before its last journal line (`lastLineMs`); else null (nothing to add).
 */
export const nearLimit = (s: MemSample | null, lastLineMs: number | null): string | null => {
  if (s === null || lastLineMs === null || s.at < lastLineMs - 2 * MEM_EVERY_MS) return null;
  const heap = s.heap_limit > 0 && s.heap_used >= NEAR_LIMIT * s.heap_limit;
  const cg = s.cgroup_max !== null && s.rss >= NEAR_LIMIT * s.cgroup_max;
  if (!heap && !cg) return null;
  return `${heap ? 'near the heap limit' : 'near the memory limit'}: heap ${mb(s.heap_used)} of ${mb(s.heap_limit)} MB, rss ${mb(s.rss)}${s.cgroup_max === null ? '' : ` of ${mb(s.cgroup_max)}`} MB`;
};

/** HEAP-GUARD: where node writes its fatal-error reports (worker-start's `--report-directory`), in the state dir. */
export const REPORTS_DIR = 'reports';
/** A report written within this long before the dead process's last journal line (or after it) is that death's. */
export const REPORT_FRESH_MS = 60_000;

/**
 * The crash site of a process that died on a fatal error (V8's heap limit: "Reached heap limit", "JavaScript heap out of
 * memory"), from node's newest report in `reports/` written at or after `lastLineMs - REPORT_FRESH_MS`: the kind and the
 * first JS frame inside packages/, in the crash site's form (crash-site.ts). Never the report's message or anything else
 * from it: no text, URL or key leaves the report. Null without a fresh, readable report.
 */
export const fatalReport = (dir: string, lastLineMs: number | null): string | null => {
  if (lastLineMs === null) return null;
  const root = join(dir, REPORTS_DIR);
  let newest: { path: string; ms: number } | null = null;
  try {
    for (const f of readdirSync(root)) {
      if (!/^report\.[A-Za-z0-9.]+\.json$/.test(f)) continue;
      const ms = statSync(join(root, f)).mtimeMs;
      if (ms >= lastLineMs - REPORT_FRESH_MS && (newest === null || ms > newest.ms)) newest = { path: join(root, f), ms };
    }
  } catch {
    return null;
  }
  if (newest === null) return null;
  let r: { header?: { event?: unknown }; javascriptStack?: { stack?: unknown } };
  try {
    r = JSON.parse(readFileSync(newest.path, 'utf8')) as typeof r;
  } catch {
    return null;
  }
  const event = typeof r.header?.event === 'string' ? r.header.event : '';
  const name = /heap out of memory|heap limit/i.test(event) ? 'HeapOutOfMemory' : 'FatalError';
  const stack = Array.isArray(r.javascriptStack?.stack) ? r.javascriptStack.stack.filter((l): l is string => typeof l === 'string') : [];
  const frame = stack.filter((l) => /^\s*at /.test(l)).map((l) => FRAME.exec(l)?.[0]).find((x) => x !== undefined) ?? 'no frame in packages/';
  return `${name} at ${frame}`;
};
