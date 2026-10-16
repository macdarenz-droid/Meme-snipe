// A-M05-01 persistence over M24 (card Z09): the `candidate` row by compare-and-set on its version (ARCH 7.1), the
// `candidate_event` row and the outbox event `universe.candidate_state` in one SQLite transaction (M24 rule). A
// write failure or a stale version leaves nothing changed (edge case 3).
//
// The `candidate` table has no columns for the Z09 fields (migration time, depth, state start, retry time); they are
// kept with the reasons in the `reasons` JSON column as `{ r, m, d, s, t }`, so no schema migration is needed
// (DECISIONS Z09-U4). Only public market data and the bot's own state are stored.
import type { CandidateState, Lamports, UnixMs } from '@bot/types';
import type { Db } from '../m24/db.ts';
import { createRepos } from '../m24/repos.ts';
import type { CandidateRecord, CandidateStore, Transition } from './universe.ts';

export const CANDIDATE_TOPIC = 'universe.candidate_state';
const repos = createRepos();

interface Extra { r: string[]; m: number | null; d: string; s: number; t: number | null }
const extraOf = (rec: CandidateRecord): Extra => ({ r: rec.reasons, m: rec.migratedAtMs, d: rec.depthLamports.toString(), s: rec.sinceMs, t: rec.retryAtMs });

function parseExtra(v: unknown): Extra {
  const o = (typeof v === 'string' ? JSON.parse(v) : v) as Partial<Extra> | string[];
  if (Array.isArray(o)) return { r: o, m: null, d: '0', s: 0, t: null };
  return { r: Array.isArray(o.r) ? o.r.map(String) : [], m: typeof o.m === 'number' ? o.m : null, d: typeof o.d === 'string' && /^\d+$/.test(o.d) ? o.d : '0',
    s: typeof o.s === 'number' ? o.s : 0, t: typeof o.t === 'number' ? o.t : null };
}

export function m24CandidateStore(db: Db, o: { newId(): string; nowMs(): UnixMs }): CandidateStore {
  return {
    load() {
      return repos.candidate.find(db.reader()).map((row) => {
        const x = parseExtra(row.reasons);
        return {
          candidateId: row.candidateId, mint: row.mint, poolId: row.poolId, venue: row.venue, state: row.state as CandidateState,
          firstSeenAtMs: row.firstSeenAt as UnixMs, cooldownUntilMs: (row.cooldownUntil ?? null) as UnixMs | null, reasons: x.r, version: row.version,
          migratedAtMs: x.m as UnixMs | null, depthLamports: BigInt(x.d) as Lamports, sinceMs: x.s as UnixMs, retryAtMs: x.t as UnixMs | null,
        };
      });
    },
    apply(prev, next, t: Transition) {
      try {
        return db.withTx((tx) => {
          const now = o.nowMs();
          const reasons = JSON.stringify(extraOf(next));
          if (prev === null) {
            repos.candidate.insert(tx, {
              candidateId: next.candidateId, mint: next.mint, poolId: next.poolId, venue: next.venue as never, state: next.state, reasons,
              cooldownUntil: next.cooldownUntilMs, firstSeenAt: next.firstSeenAtMs, lastScreenId: null, version: 1, createdAt: now, updatedAt: now,
            });
          } else {
            const u = repos.candidate.updateVersioned(tx, { candidateId: prev.candidateId }, prev.version,
              { state: next.state, reasons, cooldownUntil: next.cooldownUntilMs, updatedAt: now });
            if (!u.ok) return u;
          }
          repos.candidate_event.insert(tx, {
            eventId: o.newId(), candidateId: t.candidateId, poolId: t.poolId, mint: t.mint, fromState: t.from, toState: t.to, reason: t.reason.slice(0, 500), at: t.atMs, createdAt: now,
          });
          db.outbox.append(tx, CANDIDATE_TOPIC, { candidateId: t.candidateId, poolId: t.poolId, mint: t.mint, from: t.from, to: t.to, reason: t.reason, atMs: t.atMs });
          return { ok: true as const, value: undefined };
        });
      } catch {
        return { ok: false, error: { code: 'E_WRITE' } };
      }
    },
  };
}
