// The watchlist's eviction records (A-M05-02 `onEviction`), kept in M24 `kv_state` so a restart restores running tails
// (Z09-41, Z09-50, Z09-56) and the daily manifest can join tail cuts (A-M05-03 `watchlistEvictions`). The bot's own
// decisions only: pool id, time, reason and tail end. Each record has a persisted `seq` (a counter in `kv_state`), so
// records of the same ms keep their order. Records older than KEEP_MS are pruned on append, so the table stays bounded
// (a tail runs at most `universe.tail_extra_ms` plus the longest hold, far under 8 days).
import type { Pubkey, UnixMs } from '@bot/types';
import type { Db } from '../m24/db.ts';
import { createRepos } from '../m24/repos.ts';

export const KEEP_MS = 8 * 86_400_000;
const PREFIX = 'm05.wl_evict.';
const SEQ_KEY = 'm05.wl_evict_seq';
const PRUNE_EVERY = 100;

export interface EvictionRecord { poolId: Pubkey; atMs: UnixMs; seq: bigint; reason: string; tailUntilMs: UnixMs | null }
export interface EvictionLog {
  append(e: { poolId: Pubkey; atMs: UnixMs; reason: string; tailUntilMs: UnixMs | null }): void;
  /** Every record kept, in (atMs, seq) order. */
  restore(): EvictionRecord[];
  /** The records of [fromMs, toMs) (the day's manifest). */
  between(fromMs: number, toMs: number): EvictionRecord[];
}

const pad = (n: bigint | number, w: number): string => n.toString().padStart(w, '0');

export function kvEvictionLog(db: Db, nowMs: () => UnixMs, onError: (e: unknown) => void = () => undefined): EvictionLog {
  const repos = createRepos();
  let appended = 0;
  const all = (): EvictionRecord[] => (db.reader().all('SELECT "value_json" FROM "kv_state" WHERE "key" >= ? AND "key" < ? ORDER BY "key"', PREFIX, `${PREFIX}~`) as Array<{ value_json: string }>)
    .flatMap((r) => {
      try {
        const v = JSON.parse(r.value_json) as { poolId: string; atMs: number; seq: string; reason: string; tailUntilMs: number | null };
        return [{ poolId: v.poolId as Pubkey, atMs: v.atMs as UnixMs, seq: BigInt(v.seq), reason: v.reason, tailUntilMs: v.tailUntilMs as UnixMs | null }];
      } catch {
        return [];
      }
    });
  return {
    append(e): void {
      try {
        db.withTx((tx) => {
          const cur = repos.kv_state.get(tx, { key: SEQ_KEY });
          const seq = cur === null ? 0n : BigInt(JSON.parse(String(cur.valueJson)) as string) + 1n;
          const t = nowMs();
          repos.kv_state.upsert(tx, { key: SEQ_KEY, valueJson: JSON.stringify(seq.toString()), createdAt: t, updatedAt: t });
          const value = { poolId: e.poolId, atMs: e.atMs, seq: seq.toString(), reason: e.reason, tailUntilMs: e.tailUntilMs };
          repos.kv_state.upsert(tx, { key: `${PREFIX}${pad(e.atMs, 15)}.${pad(seq, 12)}`, valueJson: JSON.stringify(value), createdAt: t, updatedAt: t });
          if (++appended % PRUNE_EVERY === 1) tx.run('DELETE FROM "kv_state" WHERE "key" >= ? AND "key" < ?', PREFIX, `${PREFIX}${pad(Math.max(0, t - KEEP_MS), 15)}`);
        });
      } catch (err) {
        onError(err);
      }
    },
    restore: all,
    between: (fromMs, toMs) => all().filter((r) => r.atMs >= fromMs && r.atMs < toMs),
  };
}
