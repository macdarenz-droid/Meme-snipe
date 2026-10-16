// A-M05-01 persistence over M24 (card Z09): the `candidate` row by compare-and-set on its version (ARCH 7.1), the
// `candidate_event` row and the outbox event `universe.candidate_state` in one SQLite transaction (M24 rule). A
// write failure or a stale version leaves nothing changed (edge case 3). The blacklist is the `blacklist` table.
//
// The `candidate` table has no columns for the Z09 fields (migration time, depth, state start, retry time); they are
// kept with the reasons in the `reasons` JSON column as `{ r, m, d, s, t, f }` (`f`: failed retries, Z09-39), so no schema migration is needed
// (DECISIONS Z09-U4). The `cooldown_until` column holds the candidate's next timer: the cooldown end in `cooldown`, else
// its retry time (round 2, Z09-20/23), so `due` reads due retries from the database instead of holding every inactive
// candidate in memory. Only public market data and the bot's own state are stored.
import type { CandidateState, Lamports, Pubkey, UnixMs } from '@bot/types';
import type { Db } from '../m24/db.ts';
import { createRepos, type RowOf } from '../m24/repos.ts';
import { ACTIVE, type BlacklistEntry, type CandidateRecord, type CandidateStore, type Transition } from './universe.ts';

export const CANDIDATE_TOPIC = 'universe.candidate_state';
const repos = createRepos();
const INACTIVE_WITH_TIMER = ['prefiltered_out', 'rejected', 'blacklisted', 'evicted'] as const;
/** kv_state key of the fresh-read window (Z09-45): `[[minuteStartMs, pools], ...]` over the last hour. */
const FACTS_WINDOW_KEY = 'm05.facts_window';

interface Extra { r: string[]; m: number | null; d: string; s: number; t: number | null; f?: number }
const extraOf = (rec: CandidateRecord): Extra => ({ r: rec.reasons, m: rec.migratedAtMs, d: rec.depthLamports.toString(), s: rec.sinceMs, t: rec.retryAtMs, ...(rec.failedRetries ? { f: rec.failedRetries } : {}) });
const timerOf = (rec: CandidateRecord): number | null => (rec.state === 'cooldown' ? rec.cooldownUntilMs : rec.retryAtMs);

function parseExtra(v: unknown): Extra {
  const o = (typeof v === 'string' ? JSON.parse(v) : v) as Partial<Extra> | string[];
  if (Array.isArray(o)) return { r: o, m: null, d: '0', s: 0, t: null };
  return { r: Array.isArray(o.r) ? o.r.map(String) : [], m: typeof o.m === 'number' ? o.m : null, d: typeof o.d === 'string' && /^\d+$/.test(o.d) ? o.d : '0',
    s: typeof o.s === 'number' ? o.s : 0, t: typeof o.t === 'number' ? o.t : null, f: typeof o.f === 'number' && Number.isInteger(o.f) && o.f > 0 ? o.f : 0 };
}
function recordOf(row: RowOf<'candidate'>): CandidateRecord {
  const x = parseExtra(row.reasons);
  return {
    candidateId: row.candidateId, mint: row.mint, poolId: row.poolId, venue: row.venue, state: row.state as CandidateState,
    firstSeenAtMs: row.firstSeenAt as UnixMs, cooldownUntilMs: (row.state === 'cooldown' ? row.cooldownUntil ?? null : null) as UnixMs | null,
    reasons: x.r, version: row.version, migratedAtMs: x.m as UnixMs | null, depthLamports: BigInt(x.d) as Lamports, sinceMs: x.s as UnixMs, retryAtMs: x.t as UnixMs | null,
    failedRetries: x.f ?? 0,
  };
}

export function m24CandidateStore(db: Db, o: { newId(): string; nowMs(): UnixMs }): CandidateStore {
  const write = (fn: () => { ok: true; value: undefined } | { ok: false; error: { code: 'E_STATE_CHANGED' } }) => {
    try { return fn(); } catch { return { ok: false as const, error: { code: 'E_WRITE' as const } }; }
  };
  return {
    active() {
      return repos.candidate.find(db.reader()).filter((r) => ACTIVE.has(r.state as CandidateState)).map(recordOf);
    },
    get(poolId: Pubkey) {
      const [row] = repos.candidate.find(db.reader(), { poolId }, { limit: 1 });
      return row === undefined ? null : recordOf(row);
    },
    byMint(mint: Pubkey) {
      return repos.candidate.find(db.reader(), { mint }).map(recordOf);
    },
    due(nowMs: UnixMs, limit: number) {
      const ids = db.reader().all(`SELECT "candidate_id" FROM "candidate" WHERE "state" IN (${INACTIVE_WITH_TIMER.map(() => '?').join(', ')})
        AND "cooldown_until" IS NOT NULL AND "cooldown_until" <= ? ORDER BY "cooldown_until", "candidate_id" LIMIT ?`, ...INACTIVE_WITH_TIMER, nowMs, Math.max(0, Math.floor(limit)));
      return ids.map((r) => repos.candidate.get(db.reader(), { candidateId: String(r.candidate_id) })).filter((x) => x !== null).map((x) => recordOf(x as RowOf<'candidate'>));
    },
    apply(prev, next, t: Transition) {
      return write(() => db.withTx((tx) => {
        const now = o.nowMs();
        const reasons = JSON.stringify(extraOf(next));
        if (prev === null) {
          repos.candidate.insert(tx, {
            candidateId: next.candidateId, mint: next.mint, poolId: next.poolId, venue: next.venue as never, state: next.state, reasons,
            cooldownUntil: timerOf(next), firstSeenAt: next.firstSeenAtMs, lastScreenId: null, version: 1, createdAt: now, updatedAt: now,
          });
        } else {
          const u = repos.candidate.updateVersioned(tx, { candidateId: prev.candidateId }, prev.version, { state: next.state, reasons, cooldownUntil: timerOf(next), updatedAt: now });
          if (!u.ok) return u;
        }
        repos.candidate_event.insert(tx, {
          eventId: o.newId(), candidateId: t.candidateId, poolId: t.poolId, mint: t.mint, fromState: t.from, toState: t.to, reason: t.reason.slice(0, 500), at: t.atMs, createdAt: now,
        });
        db.outbox.append(tx, CANDIDATE_TOPIC, { candidateId: t.candidateId, poolId: t.poolId, mint: t.mint, from: t.from, to: t.to, reason: t.reason, atMs: t.atMs });
        return { ok: true as const, value: undefined };
      }));
    },
    patch(prev, next) {
      return write(() => db.withTx((tx) => {
        const u = repos.candidate.updateVersioned(tx, { candidateId: prev.candidateId }, prev.version,
          { reasons: JSON.stringify(extraOf(next)), cooldownUntil: timerOf(next), updatedAt: o.nowMs() });
        return u.ok ? { ok: true as const, value: undefined } : u;
      }));
    },
    factsWindow: {
      // Z09-54: a row that is not a list of [safe integer minute, safe integer count >= 0] is corrupt (fails closed).
      load() {
        const row = repos.kv_state.get(db.reader(), { key: FACTS_WINDOW_KEY });
        if (row === null) return { ok: true as const, value: [] };
        let v: unknown;
        try { v = typeof row.valueJson === 'string' ? JSON.parse(row.valueJson) : row.valueJson; } catch { return { ok: false as const, error: { code: 'E_CORRUPT' as const } }; }
        const good = Array.isArray(v) && v.every((x) => Array.isArray(x) && x.length === 2 && Number.isSafeInteger(x[0]) && Number.isSafeInteger(x[1]) && (x[1] as number) >= 0);
        return good ? { ok: true as const, value: v as Array<[number, number]> } : { ok: false as const, error: { code: 'E_CORRUPT' as const } };
      },
      save(w: Array<[number, number]>) {
        const r = write(() => db.withTx((tx) => {
          const now = o.nowMs();
          repos.kv_state.upsert(tx, { key: FACTS_WINDOW_KEY, valueJson: JSON.stringify(w), createdAt: now, updatedAt: now });
          return { ok: true as const, value: undefined };
        }));
        return r.ok ? r : { ok: false as const, error: { code: 'E_WRITE' as const } };
      },
    },
    blacklist: {
      get(mint: Pubkey): BlacklistEntry | null {
        const row = repos.blacklist.get(db.reader(), { mint });
        return row === null ? null : { mint, untilMs: (row.until ?? null) as UnixMs | null, reason: row.reason };
      },
      put(e: BlacklistEntry) {
        const w = write(() => db.withTx((tx) => {
          const now = o.nowMs();
          repos.blacklist.upsert(tx, { mint: e.mint, reason: e.reason.slice(0, 200), until: e.untilMs, setBy: 'm05', createdAt: now, updatedAt: now });
          return { ok: true as const, value: undefined };
        }));
        return w.ok ? w : { ok: false as const, error: { code: 'E_WRITE' as const } };
      },
    },
  };
}
