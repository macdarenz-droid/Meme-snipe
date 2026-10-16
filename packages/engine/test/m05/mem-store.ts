// An in-memory CandidateStore for the M05 tests (the M24 one is tested over a real database in z09-universe.test.ts).
import type { Pubkey, Result, UnixMs } from '@bot/types';
import type { BlacklistEntry, CandidateRecord, CandidateStore, Transition } from '../../src/m05/universe.ts';
import { ACTIVE } from '../../src/m05/universe.ts';

export class MemStore implements CandidateStore {
  rows = new Map<string, CandidateRecord>();
  log: Transition[] = [];
  bl = new Map<Pubkey, BlacklistEntry>();
  refuse = false;
  failBlacklist = false;
  patches = 0;
  active(): CandidateRecord[] { return [...this.rows.values()].filter((r) => ACTIVE.has(r.state)); }
  get(poolId: Pubkey): CandidateRecord | null { return [...this.rows.values()].find((r) => r.poolId === poolId) ?? null; }
  byMint(mint: Pubkey): CandidateRecord[] { return [...this.rows.values()].filter((r) => r.mint === mint); }
  due(nowMs: UnixMs, limit: number): CandidateRecord[] {
    return [...this.rows.values()].filter((r) => !ACTIVE.has(r.state) && r.retryAtMs !== null && r.retryAtMs <= nowMs)
      .sort((a, b) => (a.retryAtMs as number) - (b.retryAtMs as number) || (a.candidateId < b.candidateId ? -1 : 1)).slice(0, limit);
  }
  private cas(prev: CandidateRecord | null, next: CandidateRecord) {
    if (this.refuse) return { ok: false as const, error: { code: 'E_WRITE' as const } };
    const cur = this.rows.get(next.candidateId);
    if ((prev === null) !== (cur === undefined) || (prev !== null && cur?.version !== prev.version)) return { ok: false as const, error: { code: 'E_STATE_CHANGED' as const } };
    this.rows.set(next.candidateId, next);
    return { ok: true as const, value: undefined };
  }
  apply(prev: CandidateRecord | null, next: CandidateRecord, t: Transition) {
    const r = this.cas(prev, next);
    if (r.ok) this.log.push(t);
    return r;
  }
  patch(prev: CandidateRecord, next: CandidateRecord) {
    const r = this.cas(prev, next);
    if (r.ok) this.patches += 1;
    return r;
  }
  blacklist = {
    get: (mint: Pubkey): BlacklistEntry | null => this.bl.get(mint) ?? null,
    put: (e: BlacklistEntry): Result<void, { code: 'E_WRITE' }> => {
      if (this.failBlacklist) return { ok: false, error: { code: 'E_WRITE' } };
      this.bl.set(e.mint, e);
      return { ok: true, value: undefined };
    },
  };
}
