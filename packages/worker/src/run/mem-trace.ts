// MEM-TRACE: the worker's memory, sampled every MEM_EVERY_MS into mem.json in the state dir, so the next boot can tell a
// death near a memory limit (V8's heap limit, the unit's MemoryMax) from another kill. Both leave no stop line; the
// restart loop of 5 Oct showed only "no clean stop". The next boot (the unit's `--reconcile` pre-step) reads the last
// sample and, when it was near a limit and taken just before the death, says so in `last_exit`.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getHeapSpaceStatistics, getHeapStatistics } from 'node:v8';
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

/**
 * MEM-PROBE: once a minute, the heap's old and large-object spaces and the size of every major collection, counts only
 * (the bot's own data: no key, address or text). The last PROBE_KEEP ride in mem.json beside the sample, so the next
 * boot's `death_mem` and the summary's `last_death` say what grew before a death. `saving` marks a sample written just
 * before the synchronous state save, cleared just after: a death during the save still shows it.
 */
export const PROBE_EVERY_MS = 60_000;
export const PROBE_KEEP = 10;
/** At most this many counts per probe sample. */
export const PROBE_MAX_COUNTS = 96;
/** The store's key kinds kept per sample, largest first. */
export const PROBE_STORE_KINDS = 12;
export interface ProbeCount {
  readonly code: string;
  readonly count: number;
}
export interface ProbeSample {
  readonly at: number;
  readonly heap_used_mb: number;
  readonly old_mb: number;
  readonly large_object_mb: number;
  readonly saving: boolean;
  readonly counts: readonly ProbeCount[];
}

const CODE = /^(?=[^a-z]*[a-z])[a-z0-9_-]{1,48}$/;
/** The longest key segment a published kind keeps: every base58 address (32 to 44 characters) is longer. */
const KIND_SEGMENT_MAX = 24;
/** A count's code: lower case, `[a-z0-9_-]` only, at most 48 characters. */
export const probeCode = (s: string): string => {
  const c = s.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').slice(0, 48);
  return CODE.test(c) ? c : 'other';
};

/** MB used in V8's old and large-object spaces now. */
export const heapSpacesMb = (): { readonly old_mb: number; readonly large_object_mb: number } => {
  let old = 0;
  let large = 0;
  for (const s of getHeapSpaceStatistics()) {
    if (s.space_name === 'old_space') old = s.space_used_size;
    else if (s.space_name === 'large_object_space') large = s.space_used_size;
  }
  return { old_mb: mb(old), large_object_mb: mb(large) };
};

/**
 * Groups of counts flattened to codes (`group_name`), whole and non-negative, in the order given; the store's key kinds
 * (`byPrefix`) as `store_k_<kind>`, the largest PROBE_STORE_KINDS. At most PROBE_MAX_COUNTS.
 */
export const probeCounts = (groups: Readonly<Record<string, Readonly<Record<string, number>>>>, byPrefix: ReadonlyMap<string, number> = new Map()): ProbeCount[] => {
  const out: ProbeCount[] = [];
  const put = (code: string, n: number) => {
    if (out.length < PROBE_MAX_COUNTS && Number.isFinite(n)) out.push({ code: probeCode(code), count: Math.max(0, Math.round(n)) });
  };
  for (const [g, counts] of Object.entries(groups)) for (const [k, n] of Object.entries(counts)) put(`${g}_${k}`, n);
  // A kind is published, so no address may reach it: a segment over 24 characters (any address, signature or hash)
  // counts as `x` (ops review), and kinds that become the same are summed.
  const masked = new Map<string, number>();
  for (const [k, n] of byPrefix) {
    const kind = k.split(':').map((seg) => (seg.length > KIND_SEGMENT_MAX ? 'x' : seg)).join(':');
    masked.set(kind, (masked.get(kind) ?? 0) + n);
  }
  const kinds = [...masked].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, PROBE_STORE_KINDS);
  for (const [k, n] of kinds) put(`store_k_${k}`, n);
  return out;
};

export const probeSample = (at: number, saving: boolean, counts: readonly ProbeCount[]): ProbeSample => ({
  at, heap_used_mb: mb(process.memoryUsage().heapUsed), ...heapSpacesMb(), saving, counts,
});

export const writeMem = (dir: string, s: MemSample): void => atomicWrite(join(dir, MEM_FILE), `${JSON.stringify(s)}\n`);

/** MEM-PROBE: the probe's recent samples, oldest first, in their own file: rewritten only when a sample is taken. */
export const PROBE_FILE = 'mem-recent.json';
export const writeProbe = (dir: string, recent: readonly ProbeSample[]): void => atomicWrite(join(dir, PROBE_FILE), `${JSON.stringify(recent)}\n`);

const probeOk = (x: unknown): x is ProbeSample => {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return false;
  const o = x as Record<string, unknown>;
  const whole = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
  return whole(o['at']) && whole(o['heap_used_mb']) && whole(o['old_mb']) && whole(o['large_object_mb']) && typeof o['saving'] === 'boolean' &&
    Array.isArray(o['counts']) && o['counts'].length <= PROBE_MAX_COUNTS &&
    o['counts'].every((c) => typeof c === 'object' && c !== null && typeof (c as ProbeCount).code === 'string' && CODE.test((c as ProbeCount).code) && whole((c as ProbeCount).count));
};

/** The probe's recent samples, oldest first: only a well-formed list of at most PROBE_KEEP; none when absent. */
export const readProbe = (dir: string): ProbeSample[] => {
  try {
    const r = JSON.parse(readFileSync(join(dir, PROBE_FILE), 'utf8')) as unknown;
    if (!Array.isArray(r) || r.length > PROBE_KEEP || !r.every(probeOk)) return [];
    return r.map((p) => ({ at: p.at, heap_used_mb: p.heap_used_mb, old_mb: p.old_mb, large_object_mb: p.large_object_mb, saving: p.saving, counts: p.counts.map((c) => ({ code: c.code, count: c.count })) }));
  } catch {
    return [];
  }
};

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
/** Node's newest report in `reports/` written at or after `lastLineMs - REPORT_FRESH_MS`, parsed; null without one. */
const freshReport = (dir: string, lastLineMs: number | null): Record<string, unknown> | null => {
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
  try {
    const r = JSON.parse(readFileSync(newest.path, 'utf8')) as unknown;
    return typeof r === 'object' && r !== null && !Array.isArray(r) ? (r as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

export const fatalReport = (dir: string, lastLineMs: number | null): string | null => {
  const r = freshReport(dir, lastLineMs) as { header?: { event?: unknown }; javascriptStack?: { stack?: unknown } } | null;
  if (r === null) return null;
  const event = typeof r.header?.event === 'string' ? r.header.event : '';
  const name = /heap out of memory|heap limit/i.test(event) ? 'HeapOutOfMemory' : 'FatalError';
  const stack = Array.isArray(r.javascriptStack?.stack) ? r.javascriptStack.stack.filter((l): l is string => typeof l === 'string') : [];
  const frame = stack.filter((l) => /^\s*at /.test(l)).map((l) => FRAME.exec(l)?.[0]).find((x) => x !== undefined) ?? 'no frame in packages/';
  return `${name} at ${frame}`;
};

/** One V8 heap space at a death: its name without `_space`, `_` as `-` (`old`, `new`, `large-object`, `code`), and MB used. */
export interface DeathSpace {
  readonly space: string;
  readonly used_mb: number;
}

/**
 * MEM-SUMMARY: the memory of a process that died with no stop line, for the daily summary: numbers only. From node's fresh
 * fatal report (dump time, heap used and limit, MB used per V8 space) and from the last mem.json sample when it was taken
 * just before the death (two periods, as `nearLimit`). Uptime from the dead process's own boot (`bootMs`, its entry in
 * restarts.json). Nothing else is read from the report: no text, no path, no environment. Null when neither is there.
 */
export interface DeathMem {
  readonly at: number;
  readonly uptime_s: number | null;
  readonly heap_used_mb: number | null;
  readonly heap_limit_mb: number | null;
  readonly spaces: readonly DeathSpace[];
  readonly sample: { readonly at: number; readonly heap_used_mb: number; readonly heap_limit_mb: number; readonly rss_mb: number; readonly external_mb: number; readonly array_buffers_mb: number } | null;
  /** MEM-PROBE: the probe's last samples before the death, oldest first; absent when there are none (older state). */
  readonly recent?: readonly ProbeSample[];
}

/** At most this many heap spaces are kept (V8 has about ten). */
export const DEATH_SPACES_MAX = 16;

const SPACE = /^[a-z][a-z_]{0,39}$/;

export const deathMem = (dir: string, lastLineMs: number | null, bootMs: number | null): DeathMem | null => {
  if (lastLineMs === null) return null;
  const r = freshReport(dir, lastLineMs);
  const header = r !== null && typeof r['header'] === 'object' && r['header'] !== null ? (r['header'] as Record<string, unknown>) : null;
  const heap = r !== null && typeof r['javascriptHeap'] === 'object' && r['javascriptHeap'] !== null ? (r['javascriptHeap'] as Record<string, unknown>) : null;
  const stamp = typeof header?.['dumpEventTimeStamp'] === 'string' ? Number(header['dumpEventTimeStamp']) : Number.NaN;
  const reportAt = Number.isSafeInteger(stamp) && stamp > 0 ? stamp : null;
  const spaces: DeathSpace[] = [];
  const hs = heap !== null && typeof heap['heapSpaces'] === 'object' && heap['heapSpaces'] !== null ? (heap['heapSpaces'] as Record<string, unknown>) : {};
  for (const [name, v] of Object.entries(hs)) {
    const used = typeof v === 'object' && v !== null ? (v as Record<string, unknown>)['used'] : undefined;
    if (!SPACE.test(name) || !num(used) || spaces.length >= DEATH_SPACES_MAX) continue;
    spaces.push({ space: name.replace(/_space$/, '').replace(/_/g, '-'), used_mb: mb(used) });
  }
  spaces.sort((a, b) => b.used_mb - a.used_mb || (a.space < b.space ? -1 : 1));
  const m = readMem(dir);
  const fresh = m !== null && m.at >= lastLineMs - 2 * MEM_EVERY_MS ? m : null;
  const recent = fresh === null ? [] : readProbe(dir);
  const at = reportAt ?? fresh?.at ?? null;
  if (at === null) return null;
  return {
    at,
    uptime_s: bootMs !== null && bootMs <= at ? Math.floor((at - bootMs) / 1000) : null,
    heap_used_mb: num(heap?.['usedMemory']) ? mb(heap['usedMemory'] as number) : fresh === null ? null : mb(fresh.heap_used),
    heap_limit_mb: num(heap?.['memoryLimit']) ? mb(heap['memoryLimit'] as number) : fresh === null ? null : mb(fresh.heap_limit),
    spaces,
    sample: fresh === null ? null : { at: fresh.at, heap_used_mb: mb(fresh.heap_used), heap_limit_mb: mb(fresh.heap_limit), rss_mb: mb(fresh.rss), external_mb: mb(fresh.external), array_buffers_mb: mb(fresh.array_buffers) },
    ...(recent.length === 0 ? {} : { recent }),
  };
};

/** A `DeathMem` read back from a journal line or a handoff: exactly its shape with whole non-negative numbers, else null. */
export const parseDeathMem = (v: unknown): DeathMem | null => {
  const o = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
  const whole = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;
  const wholeOrNull = (x: unknown): boolean => x === null || whole(x);
  if (!o(v) || !whole(v['at']) || !wholeOrNull(v['uptime_s']) || !wholeOrNull(v['heap_used_mb']) || !wholeOrNull(v['heap_limit_mb'])) return null;
  const sp = v['spaces'];
  if (!Array.isArray(sp) || sp.length > DEATH_SPACES_MAX || !sp.every((x) => o(x) && typeof x['space'] === 'string' && /^[a-z][a-z-]{0,39}$/.test(x['space']) && whole(x['used_mb']))) return null;
  const s = v['sample'];
  if (s !== null && !(o(s) && ['at', 'heap_used_mb', 'heap_limit_mb', 'rss_mb', 'external_mb', 'array_buffers_mb'].every((k) => whole(s[k])))) return null;
  // A malformed `recent` drops only itself: the rest of the death record stands (ops review).
  const raw = v['recent'] ?? [];
  const r = Array.isArray(raw) && raw.length <= PROBE_KEEP && raw.every(probeOk) ? raw : [];
  return {
    at: v['at'], uptime_s: v['uptime_s'] as number | null, heap_used_mb: v['heap_used_mb'] as number | null, heap_limit_mb: v['heap_limit_mb'] as number | null,
    spaces: (sp as Record<string, unknown>[]).map((x) => ({ space: x['space'] as string, used_mb: x['used_mb'] as number })),
    sample: s === null ? null : { at: s['at'] as number, heap_used_mb: s['heap_used_mb'] as number, heap_limit_mb: s['heap_limit_mb'] as number, rss_mb: s['rss_mb'] as number, external_mb: s['external_mb'] as number, array_buffers_mb: s['array_buffers_mb'] as number },
    ...(r.length === 0 ? {} : { recent: r.map((p) => ({ at: p.at, heap_used_mb: p.heap_used_mb, old_mb: p.old_mb, large_object_mb: p.large_object_mb, saving: p.saving, counts: p.counts.map((c) => ({ code: c.code, count: c.count })) })) }),
  };
};
