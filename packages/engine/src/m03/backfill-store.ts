// A-M03-02 durable state over M24 (card Z09, ruling Z09-20): the cursor in `discovery_cursor` (source
// `chain_backfill`), and verified migrations, PumpPortal sightings and deferred pools in `kv_state` under the prefixes
// `m03.verified:`, `m03.pp_seen:` and `m03.deferred:`. Only public chain data is stored. Verified and seen entries
// are pruned after 8 days (the 7-day coverage window plus a day); the cursor guards against re-reading older ones.
import type { Pubkey, Slot, UnixMs } from '@bot/types';
import type { Db } from '../m24/db.ts';
import { createRepos } from '../m24/repos.ts';
import { DEFERRED_MAX, timeOf, type BackfillStore, type MigrationObserved, type VerifiedMigration } from './backfill.ts';

const repos = createRepos();
const V = 'm03.verified:', PP = 'm03.pp_seen:', DF = 'm03.deferred:';
const SOURCE = 'chain_backfill';

const enc = (v: unknown): string => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? { $big: x.toString() } : x));
const dec = <T>(s: unknown): T => JSON.parse(typeof s === 'string' ? s : JSON.stringify(s), (_k, x) => (x !== null && typeof x === 'object' && typeof (x as { $big?: unknown }).$big === 'string' ? BigInt((x as { $big: string }).$big) : x)) as T;

export function m24BackfillStore(db: Db, nowMs: () => UnixMs): BackfillStore {
  const put = (key: string, value: unknown): void => {
    db.withTx((tx) => { const t = nowMs(); repos.kv_state.upsert(tx, { key, valueJson: enc(value), createdAt: t, updatedAt: t }); });
  };
  const getKey = <T>(key: string): T | null => {
    const r = repos.kv_state.get(db.reader(), { key });
    return r === null ? null : dec<T>(r.valueJson);
  };
  const byPrefix = <T>(prefix: string): Array<{ key: string; value: T }> =>
    db.reader().all('SELECT "key", "value_json" FROM "kv_state" WHERE "key" >= ? AND "key" < ? ORDER BY "key"', prefix, `${prefix}￿`)
      .map((r) => ({ key: String(r.key), value: dec<T>(r.value_json) }));
  const del = (key: string): void => { db.withTx((tx) => { tx.run('DELETE FROM "kv_state" WHERE "key" = ?', key); }); };
  return {
    cursor: {
      load: () => repos.discovery_cursor.get(db.reader(), { source: SOURCE })?.cursor ?? null,
      save: (cursor) => { db.withTx((tx) => { const t = nowMs(); repos.discovery_cursor.upsert(tx, { source: SOURCE, cursor, createdAt: t, updatedAt: t }); }); },
    },
    getVerified: (mint, pool) => getKey<VerifiedMigration>(`${V}${mint}|${pool}`),
    putVerified: (v) => put(`${V}${v.mint}|${v.pool}`, v),
    verifiedSince: (fromMs) => byPrefix<VerifiedMigration>(V).map((x) => x.value).filter((v) => timeOf(v) >= fromMs),
    newestVerifiedSlot: () => byPrefix<VerifiedMigration>(V).reduce<Slot | null>((a, x) => (a === null || x.value.slot > a ? x.value.slot : a), null),
    markPumpPortal: (mint: Pubkey, pool: Pubkey, atMs) => put(`${PP}${mint}|${pool}`, atMs),
    seenByPumpPortal: (mint, pool) => getKey<number>(`${PP}${mint}|${pool}`) !== null,
    deferred: {
      list: () => byPrefix<{ m: MigrationObserved; runsLeft: number }>(DF).map((x) => x.value),
      put: (m, runsLeft) => {
        put(`${DF}${m.signature}|${m.mint}`, { m, runsLeft });
        const all = byPrefix<unknown>(DF);
        for (const x of all.slice(0, Math.max(0, all.length - DEFERRED_MAX))) del(x.key);
      },
      remove: (m) => del(`${DF}${m.signature}|${m.mint}`),
    },
    prune: (beforeMs) => {
      for (const x of byPrefix<VerifiedMigration>(V)) if (timeOf(x.value) < beforeMs) del(x.key);
      for (const x of byPrefix<number>(PP)) if (x.value < beforeMs) del(x.key);
    },
  };
}
