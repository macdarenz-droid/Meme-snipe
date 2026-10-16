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
  window: Array<[number, number]> = [];
  failWindow = false;
  factsWindow = {
    load: (): Array<[number, number]> => this.window.map((x) => [...x] as [number, number]),
    save: (w: Array<[number, number]>): Result<void, { code: 'E_WRITE' }> => {
      if (this.failWindow) return { ok: false, error: { code: 'E_WRITE' } };
      this.window = w.map((x) => [...x] as [number, number]);
      return { ok: true, value: undefined };
    },
  };
  blacklist = {
    get: (mint: Pubkey): BlacklistEntry | null => this.bl.get(mint) ?? null,
    put: (e: BlacklistEntry): Result<void, { code: 'E_WRITE' }> => {
      if (this.failBlacklist) return { ok: false, error: { code: 'E_WRITE' } };
      this.bl.set(e.mint, e);
      return { ok: true, value: undefined };
    },
  };
}

/** A MemStore whose `due` reads a min-heap of retry times instead of scanning every row (the 10,000-pool budget test). */
export class HeapStore extends MemStore {
  private heap: Array<[number, string, number]> = [];
  private pushTimer(r: CandidateRecord): void {
    if (!ACTIVE.has(r.state) && r.retryAtMs !== null) this.reinsert([r.retryAtMs, r.candidateId, r.version]);
  }
  private less(a: number, b: number): boolean {
    const x = this.heap[a] as [number, string, number], y = this.heap[b] as [number, string, number];
    return x[0] < y[0] || (x[0] === y[0] && x[1] < y[1]);
  }
  private pop(): [number, string, number] | undefined {
    const top = this.heap[0];
    const last = this.heap.pop();
    if (this.heap.length > 0 && last !== undefined) {
      this.heap[0] = last;
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < this.heap.length && this.less(l, m)) m = l;
        if (r < this.heap.length && this.less(r, m)) m = r;
        if (m === i) break;
        [this.heap[i], this.heap[m]] = [this.heap[m] as [number, string, number], this.heap[i] as [number, string, number]];
        i = m;
      }
    }
    return top;
  }
  override apply(prev: CandidateRecord | null, next: CandidateRecord, t: Transition) {
    const r = super.apply(prev, next, t);
    if (r.ok) this.pushTimer(next);
    return r;
  }
  override patch(prev: CandidateRecord, next: CandidateRecord) {
    const r = super.patch(prev, next);
    if (r.ok) this.pushTimer(next);
    return r;
  }
  dueCalls = 0;
  override due(nowMs: UnixMs, limit: number): CandidateRecord[] {
    this.dueCalls += 1;
    const out: CandidateRecord[] = [];
    const keep: Array<[number, string, number]> = [];
    while (out.length < limit && this.heap.length > 0 && (this.heap[0] as [number, string, number])[0] <= nowMs) {
      const e = this.pop() as [number, string, number];
      const cur = this.rows.get(e[1]);
      if (cur === undefined || cur.version !== e[2] || cur.retryAtMs !== e[0] || ACTIVE.has(cur.state)) continue;   // superseded
      out.push(cur);
      keep.push(e);
    }
    for (const e of keep) this.reinsert(e);
    return out;
  }
  private reinsert(e: [number, string, number]): void {
    this.heap.push(e);
    for (let i = this.heap.length - 1; i > 0;) {
      const p = (i - 1) >> 1;
      if (!this.less(i, p)) break;
      [this.heap[i], this.heap[p]] = [this.heap[p] as [number, string, number], this.heap[i] as [number, string, number]];
      i = p;
    }
  }
}
