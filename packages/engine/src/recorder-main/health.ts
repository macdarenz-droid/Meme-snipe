// The recorder's host contract (card Z10; ops/README.md "Worker contract", "Code updates"):
// - `/health` on ZEROED_HEALTH_ADDR (the update gate and worker-smoke ask it for `mode: "paper"` and `git_sha`) and on
//   ZEROED_API_ADDR (published to the owner's tailnet), loopback only. Public state only: no URL, key or path.
// - `--reconcile`: `open_intents` and `open_positions` are 0 (the recorder never trades). A count another worker left
//   that is not 0 is never overwritten: the reconcile refuses (exit 1), so the host keeps its hold.
// - The HMAC-signed heartbeat to the watchdog, as the stand-in sends it (packages/ops/src/watchdog/logic.ts). Ruling
//   Z10-24: `critical` carries codes only (no coin, amount or address, D27(c)), deduplicated: every M27 critical code
//   raised in the last 15 minutes, the state codes for exactly as long as their condition holds (Z10-41: a stopped
//   provider, the day's verification cap, an open clock episode, unpulled segments, a missing manifest, and
//   `recorder.unanchored` after 10 minutes with no two-provider agreement), plus `recorder.recording_halted`,
//   `recorder.memory_high` and `recorder.loop_stale` (no 1 s loop tick for 30 s on the monotonic clock, Z10-44);
//   `last_processed_slot` is the newest slot M04 stored, so the watchdog's slot_lag works.
// - The 75% memory alert: the unit's anonymous memory (cgroup `memory.stat` anon, not page cache) against its
//   `memory.max`, read every 10 s; one critical line per episode, cleared below 70%.
import { createHmac } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';

export const LOOPBACK_ADDR = /^(127\.0\.0\.1|\[::1\]):(\d{1,5})$/;

export function parseLoopback(addr: string): { host: string; port: number } | null {
  const m = LOOPBACK_ADDR.exec(addr);
  if (m === null) return null;
  const port = Number(m[2]);
  return port >= 1 && port <= 65_535 ? { host: (m[1] as string).replace(/[[\]]/g, ''), port } : null;
}

export type ReconcileResult = { ok: true; intents: '0'; positions: '0' } | { ok: false; reason: string };

/** Writes `open_intents` and `open_positions` as 0, unless a file already holds anything but 0 (kept, refused). */
export function reconcile(stateDir: string): ReconcileResult {
  const kept: string[] = [];
  for (const f of ['open_intents', 'open_positions']) {
    const p = join(stateDir, f);
    if (existsSync(p)) {
      const v = readFileSync(p, 'utf8').trim();
      if (v !== '0') kept.push(`${f}=${v.replace(/[^A-Za-z0-9]/g, '?').slice(0, 20)}`);
    }
  }
  if (kept.length > 0) return { ok: false, reason: `another worker's count is not 0 (${kept.join(', ')}); the recorder never settles intents` };
  for (const f of ['open_intents', 'open_positions']) writeFileSync(join(stateDir, f), '0\n', { mode: 0o600 });
  return { ok: true, intents: '0', positions: '0' };
}

export interface HealthBody { [k: string]: unknown; mode: 'paper'; git_sha: string; signing_key: false }

export function startHealthServers(addrs: ReadonlyArray<{ host: string; port: number }>, body: () => HealthBody): Promise<Server[]> {
  return Promise.all(addrs.map((a) => new Promise<Server>((resolve, reject) => {
    const s = createServer((req, res) => {
      if (req.method !== 'GET' || req.url !== '/health') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"error":"not found"}');
        return;
      }
      // SW-3: a status that throws answers 500; it never becomes an uncaught exception in the server's callback.
      let text: string;
      try {
        text = JSON.stringify(body());
      } catch {
        res.writeHead(500, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end('{"error":"internal"}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(text);
    });
    s.once('error', reject);
    s.listen(a.port, a.host, () => resolve(s));
  })));
}

export interface HeartbeatState {
  seq: number; boot: string; gitSha: string; lastSlot: bigint | null; critical: string[]; ownerChat: string | null; uptimeS: number;
}

/** The watchdog's signed text: timestamp, method, path, body (as the stand-in signs it). */
export function signHeartbeat(key: string, tSec: number, body: string): string {
  return createHmac('sha256', key).update(`${tSec}\nPOST\n/heartbeat\n${body}`).digest('hex');
}

export function heartbeatBody(s: HeartbeatState, nowMs: number, paused: boolean): string {
  // Ruling Z10-52: every active code, never the first few: a cut list drops the codes after it, and the watchdog's
  // one-alert-per-code keys would clear and re-raise as the set shifts. The codes are the recorder's own names (CODE).
  // The slot is a u64: written into the JSON text as a number, never through a JS number.
  return JSON.stringify({
    seq: s.seq, ts: nowMs, boot: s.boot, git_sha: s.gitSha, policy_version: 'recorder', stub: false,
    last_processed_slot: s.lastSlot === null ? null : `__slot:${s.lastSlot}__`, feed_ages_ms: {}, open_position: null,
    unresolved_intents: { count: 0, oldest_age_s: null }, signer: 'not-used', lease_epoch: null, sol_reserve: null,
    paused, owner_chat_id: s.ownerChat, critical: s.critical, uptime_s: s.uptimeS,
  }).replace(/"__slot:(\d+)__"/, '$1');
}

/** SW-3: what a fatal handler needs; the process's own in run.ts, fakes in tests. */
export interface FatalDeps {
  log: (where: string, errorCode: string) => void;
  /** The recorder's stop and the log sink's close (best effort, bounded by `graceMs`). */
  stop: () => Promise<void>;
  exit: (code: number) => void;
  say: (line: string) => void;
  setTimer: (fn: () => void, ms: number) => void;
  graceMs?: number;
}
/** SW-3: the exit code of a deliberate stop after an error nothing caught (EX_SOFTWARE; systemd starts it again). */
export const FATAL_EXIT = 70;

/**
 * SW-3: the handler for `uncaughtException` and `unhandledRejection`. One `recorder.internal_error` line (codes only),
 * a best-effort stop (the writer's last flush, the log's), then a deliberate exit, at most `graceMs` (5 s) later. The
 * process never runs on in a state nothing checked; the restart count and the probation see the exit.
 */
export function fatalHandler(d: FatalDeps): (where: string, e: unknown) => void {
  let dying = false;
  return (where, e) => {
    if (dying) return;
    dying = true;
    const raw = (e as { code?: unknown } | null)?.code;
    const code = (typeof raw === 'string' || typeof raw === 'number' ? String(raw) : 'E_THROWN').replace(/[^A-Za-z0-9_]/g, '_').slice(0, 40);
    try { d.log(where, code); } catch { /* the line is best effort */ }
    d.say(`Recorder stopping: ${where} (${code}).`);
    d.setTimer(() => d.exit(FATAL_EXIT), d.graceMs ?? 5_000);
    void d.stop().catch(() => undefined).finally(() => d.exit(FATAL_EXIT));
  };
}

/**
 * SW-8: the heartbeat's `last_processed_slot`. Null while no pool is watched: the newest stored slot then only ages,
 * and the watchdog would read it as the worker falling behind the chain (a false `slot_lag`).
 */
export function heartbeatSlot(s: { watched: number; newestStoredSlot: string | null } | null): bigint | null {
  if (s === null || s.watched === 0 || s.newestStoredSlot === null) return null;
  return BigInt(s.newestStoredSlot);
}

/** One heartbeat; returns the watchdog's `paused` flag when it sent one (applied by echoing it, as the stand-in does). */
export async function sendHeartbeat(o: { url: string; key: string; body: string; nowMs: number; fetch: typeof fetch }): Promise<{ ok: boolean; paused?: boolean; status?: number }> {
  const t = Math.floor(o.nowMs / 1000);
  try {
    const res = await o.fetch(`${o.url.replace(/\/$/, '')}/heartbeat`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-zeroed-signature': `t=${t},v1=${signHeartbeat(o.key, t, o.body)}` },
      body: o.body, signal: AbortSignal.timeout(10_000),
    });
    const reply = await res.json().catch(() => ({})) as { paused?: unknown };
    return { ok: res.ok, status: res.status, ...(typeof reply.paused === 'boolean' ? { paused: reply.paused } : {}) };
  } catch {
    return { ok: false };
  }
}

/** Ruling Z10-24 (new values; no SPEC or ARCH threshold exists): the loop's 1 s tick older than this is critical. */
export const LOOP_STALE_MS = 30_000;
/**
 * Rulings Z10-24 and Z10-41: no two-provider anchor for this long is `recorder.unanchored` (compose.ts UNANCHORED_MS
 * for a running recorder; here only when no recorder status exists at all).
 */
export const UNANCHORED_ALERT_MS = 600_000;
const CODE = /^[a-z0-9_]+(\.[a-z0-9_]+)+$/;

/** What the heartbeat reads from the recorder's status (compose.ts RecorderStatus). */
export interface HealthStatus {
  lastTickMonoMs: number | null; halted: string | null; criticalCodes: readonly string[]; activeCodes: readonly string[];
}

/**
 * The heartbeat's `critical` codes (rulings Z10-24, Z10-41, Z10-44), on each beat. Codes only, deduplicated and
 * sorted; anything that is not a lowercase dotted code is dropped (no free text can reach the watchdog). The state
 * codes come from the recorder's conditions (`activeCodes`), the other critical lines from the last 15 minutes
 * (`criticalCodes`); the loop's age is on the monotonic clock, so a wall-clock step never makes it look stale.
 */
export function heartbeatHealth(startedMonoMs: number): {
  codes(o: { monoMs: number; status: HealthStatus | null; memoryHigh: boolean }): string[];
} {
  return {
    codes({ monoMs, status, memoryHigh }): string[] {
      const out = new Set<string>([...(status?.criticalCodes ?? []), ...(status?.activeCodes ?? [])]);
      if (status === null && monoMs - startedMonoMs >= UNANCHORED_ALERT_MS) out.add('recorder.unanchored');
      if (monoMs - (status?.lastTickMonoMs ?? startedMonoMs) >= LOOP_STALE_MS) out.add('recorder.loop_stale');
      if (status?.halted != null) out.add('recorder.recording_halted');
      if (memoryHigh) out.add('recorder.memory_high');
      return [...out].filter((c) => CODE.test(c)).sort();
    },
  };
}

export const MEMORY_ALERT_BPS = 7_500;
export const MEMORY_CLEAR_BPS = 7_000;

/**
 * `source` (ruling Z10-12): `anon` is memory.stat's `anon` (verified on the e2e host); `current_minus_file`, the
 * fallback when that field is missing, is memory.current minus memory.stat's `file` (page cache is never counted).
 */
export interface MemoryReading { anonBytes: number; limitBytes: number | null; source: 'anon' | 'current_minus_file' }

/** The unit's cgroup (v2) from /proc/self/cgroup: anonymous memory and memory.max (null when unlimited or unreadable). */
export function cgroupMemory(root = '/sys/fs/cgroup', self = '/proc/self/cgroup'): MemoryReading | null {
  try {
    const line = readFileSync(self, 'utf8').split('\n').find((l) => l.startsWith('0::'));
    if (line === undefined) return null;
    const dir = join(root, line.slice(3).trim());
    const max = readFileSync(join(dir, 'memory.max'), 'utf8').trim();
    const limitBytes = max === 'max' ? null : Number(max);
    const stat = readFileSync(join(dir, 'memory.stat'), 'utf8');
    const anon = /^anon (\d+)$/m.exec(stat);
    if (anon !== null) return { anonBytes: Number(anon[1]), limitBytes, source: 'anon' };
    const file = /^file (\d+)$/m.exec(stat);
    const current = Number(readFileSync(join(dir, 'memory.current'), 'utf8').trim());
    if (file === null || !Number.isSafeInteger(current)) return null;
    return { anonBytes: Math.max(0, current - Number(file[1])), limitBytes, source: 'current_minus_file' };
  } catch {
    return null;
  }
}

/** One alert per episode: raised at ≥ 75% of the limit, cleared below 70%. */
export function memoryWatch(o: { read: () => MemoryReading | null; alert: (r: { anonBytes: number; limitBytes: number; pct: number; source: MemoryReading['source'] }) => void; cleared: () => void }): { check(): boolean } {
  let high = false;
  return {
    check(): boolean {
      const r = o.read();
      if (r === null || r.limitBytes === null || !(r.limitBytes > 0)) return high;
      const bps = Math.floor((r.anonBytes * 10_000) / r.limitBytes);
      if (!high && bps >= MEMORY_ALERT_BPS) { high = true; o.alert({ anonBytes: r.anonBytes, limitBytes: r.limitBytes, pct: Math.floor(bps / 100), source: r.source }); }
      else if (high && bps < MEMORY_CLEAR_BPS) { high = false; o.cleared(); }
      return high;
    },
  };
}
