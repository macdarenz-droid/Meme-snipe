// A-M03-02 migration backfill (card Z09). The three migration transactions and the two migrated pools are real
// (fixtures/mainnet, recorded 2026-10-06); the 150-signature list of the spec (`fx/pump/withdraw_authority_signatures_150.json`)
// does not exist and this container makes no live reads, so the list is SYNTHETIC: 71 failed signatures (the share
// measured in EX-04), the 3 real migrations, and 76 successful non-migration transactions (a real PumpSwap swap
// served under each synthetic signature).
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { createDecoders, decodeEventsWithGaps, readRpcTransaction, verifyPinnedIdls, VENDORED_IDL_DIR } from '@bot/decoders';
import type { Result, Slot, UnixMs } from '@bot/types';
import { ACCOUNTS, MINTS, PROGRAMS } from '@bot/venue/constants';
import { createPumpSwapPoolModel, createVenueConfigCache, type CpPoolState, type FeeInputs } from '@bot/venue';
import { checkBackfillConfig, createMigrationBackfill, BACKFILL_DEFAULTS, DEFERRED_RUNS, memoryBackfillStore, NULL_TX_MAX_ATTEMPTS, PAGE_LIMIT, type BackfillDeps, type BackfillStore, type MigrationObserved, type PoolDiscovered } from '../../src/m03/backfill.ts';
import { migrationDecoder } from '../../src/m03/decode-migrations.ts';
import type { PumpPortalDeps } from '../../src/m03/pumpportal-client.ts';
import type { RawAccount } from '../../src/m04/types.ts';
import type { CallOptions, RpcError } from '../../src/m14/types.ts';
import { ScriptedReader } from '../m04/fake.ts';
import { FakeTime } from '../m14/helpers.ts';
import { sig } from '../m10/sig.ts';
import { fakeClock, tempDir, waitFor } from '../helpers.ts';
import { join } from 'node:path';
import { m24BackfillStore } from '../../src/m03/backfill-store.ts';
import { openDb } from '../../src/m24/db.ts';
import { prepareDatabase } from '../../src/m24/migrate.ts';

const idls = verifyPinnedIdls(VENDORED_IDL_DIR);
assert.ok(idls.ok);
const decoders = createDecoders(idls.value, { tokenPrograms: { splToken: PROGRAMS.splToken, token2022: PROGRAMS.token2022 } });
const DIR = new URL('../../../../fixtures/mainnet/', import.meta.url);
const read = <T>(p: string): T => JSON.parse(readFileSync(new URL(p, DIR), 'utf8')) as T;
type FxTx = { signature: string; slot: number; blockTime: number; json: unknown; mint: string; pool: string };
type FxAccount = { role: string; pubkey: string; owner: string; data_base64: string };
const MIG = ['tx_32tjvqFP', 'tx_3ho5U23D', 'tx_3xcn7YbY'].map((f) => read<FxTx>(`tx/migration/${f}.json`));
const SWAP = read<FxTx>('tx/pumpswap/tx_2JncvkXg.json');
const POOL_SETS = ['pool_3Asuat6N', 'pool_Dh39kXkx'].map((f) => read<{ accounts: FxAccount[] }>(`pumpswap/pools/${f}.json`));
const raw = (a: FxAccount): RawAccount => ({ owner: a.owner, data: new Uint8Array(Buffer.from(a.data_base64, 'base64')) });

async function feeInputs(): Promise<FeeInputs> {
  const cfg = (n: string) => (read<{ accounts: FxAccount[] }>(`config/${n}.json`)).accounts[0] as FxAccount;
  const accounts = ['fee_config_curve', 'fee_config_pumpswap', 'pumpswap_global_config', 'pump_global'].map((n) => raw(cfg(n)));
  const cache = createVenueConfigCache({ reader: { read: async () => ({ ok: true, value: { contextSlot: 1n as Slot, accounts } }) }, decoder: decoders, clock: new FakeTime(), log: { event: () => {} } });
  await cache.refresh();
  const i = cache.inputs('pumpswap');
  assert.ok(i.ok);
  return i.value;
}

interface SigRow { signature: string; slot: number; err: unknown }
class FakeGateway {
  sigs: SigRow[] = [];                 // newest first
  txs = new Map<string, unknown>();
  calls: Array<{ method: string; params: unknown[] }> = [];
  failPageAt: number | null = null;    // the n-th getSignaturesForAddress call answers 429
  failTx: { signature: string; error: RpcError } | null = null;
  pages = 0;
  async call<T>(method: string, params: unknown[], _o: CallOptions): Promise<Result<{ value: T; providerLabel: string; latencyMs: number; contextSlot: Slot | null }, RpcError>> {
    this.calls.push({ method, params });
    const ok = (value: unknown) => ({ ok: true as const, value: { value: value as T, providerLabel: 'p', latencyMs: 1, contextSlot: null } });
    if (method === 'getSignaturesForAddress') {
      this.pages += 1;
      if (this.failPageAt === this.pages) return { ok: false, error: { code: 'E_RATE_LIMITED', message: '429', httpStatus: 429 } };
      const o = params[1] as { before?: string; until?: string; limit: number };
      let i = o.before === undefined ? 0 : this.sigs.findIndex((s) => s.signature === o.before) + 1;
      const out: SigRow[] = [];
      for (; i < this.sigs.length && out.length < o.limit; i++) {
        const s = this.sigs[i] as SigRow;
        if (s.signature === o.until) break;
        out.push(s);
      }
      return ok(out);
    }
    if (method === 'getTransaction') {
      const s = params[0] as string;
      if (this.failTx?.signature === s) return { ok: false, error: this.failTx.error };
      return ok(this.txs.get(s) ?? null);
    }
    throw new Error(method);
  }
}

interface Rig {
  b: ReturnType<typeof createMigrationBackfill<CpPoolState>>; gw: FakeGateway; reader: ScriptedReader; time: FakeTime;
  recorded: MigrationObserved[]; migrations: MigrationObserved[]; pools: PoolDiscovered[]; logs: Array<[string, string, Record<string, unknown>]>; store: ReturnType<typeof memoryBackfillStore>;
}
async function rig(o: { sigs?: SigRow[]; poolsVisible?: boolean; config?: Partial<BackfillDeps<CpPoolState>['config']>; store?: BackfillStore } = {}): Promise<Rig> {
  const fees = await feeInputs();
  const model = createPumpSwapPoolModel({ decoder: decoders, fees: () => fees });
  const reader = new ScriptedReader();
  if (o.poolsVisible !== false) for (const s of POOL_SETS) for (const a of s.accounts) reader.accounts.set(a.pubkey, raw(a));
  const gw = new FakeGateway();
  gw.sigs = o.sigs ?? sample150();
  for (const m of MIG) gw.txs.set(m.signature, m.json);
  for (const s of gw.sigs) if (!gw.txs.has(s.signature)) gw.txs.set(s.signature, SWAP.json);
  const time = new FakeTime();
  const store = (o.store ?? memoryBackfillStore()) as ReturnType<typeof memoryBackfillStore>;
  const recorded: MigrationObserved[] = [], migrations: MigrationObserved[] = [], pools: PoolDiscovered[] = [];
  const logs: Rig['logs'] = [];
  let id = 0;
  const b = createMigrationBackfill<CpPoolState>({
    config: { ...BACKFILL_DEFAULTS, ...o.config }, gateway: gw, reader, model: model as never,
    decode: migrationDecoder({ readRpcTransaction, decodeEventsWithGaps: decodeEventsWithGaps as never }, idls.ok ? idls.value : [], MINTS.wsol),
    withdrawAuthority: ACCOUNTS.migrationWithdrawAuthority, wsolMint: MINTS.wsol,
    store,
    record: (m) => recorded.push(m), publishMigration: (m) => migrations.push(m), publishPool: (p) => pools.push(p),
    newId: () => `d${id++}`, nowMs: () => (MIG[2] as FxTx).blockTime * 1_000 + time.nowMs() as UnixMs, scheduler: time,
    log: { event: (l, c, f) => logs.push([l, c, (f ?? {}) as Record<string, unknown>]) },
  });
  return { b, gw, reader, time, recorded, migrations, pools, logs, store };
}
/** The cursor never reached `signature`: none yet, or `until` strictly older than it (Z09-35 moves it up to just below). */
function heldBelow(r: Rig, signature: string): void {
  if (r.store.cursorValue === null) return;
  const until = (JSON.parse(r.store.cursorValue) as { until: string | null }).until;
  const idx = (x: string | null): number => r.gw.sigs.findIndex((g) => g.signature === x);
  assert.ok(until === null || idx(until) > idx(signature), `cursor at ${until} is not below the stalled ${signature}`);
}
/** 150 signatures, newest first: 71 failed, the 3 migrations, 76 successful swaps. */
function sample150(): SigRow[] {
  const rows: SigRow[] = [];
  for (let i = 0; i < 147; i++) rows.push({ signature: sig('W', i), slot: 453_968_000 - i, err: i < 71 ? { InstructionError: [0, { Custom: 6001 }] } : null });
  for (const [k, m] of MIG.entries()) rows.splice(10 + k * 40, 0, { signature: m.signature, slot: m.slot, err: null });
  return rows;
}
const VERIFIABLE = new Set(POOL_SETS.map((s) => (s.accounts.find((a) => a.role === 'pool') as FxAccount).pubkey));

describe('A-M03-02 acceptance (SYNTHETIC signature list, real migrations and pools)', () => {
  it('71 failed of 150: only the successful transactions are fetched; each migration is published once, verified on chain', async () => {
    const r = await rig();
    const res = await r.b.backfillSince(null);
    assert.ok(res.ok);
    const fetched = r.gw.calls.filter((c) => c.method === 'getTransaction').map((c) => c.params[0]);
    assert.equal(fetched.length, 79);
    assert.ok(!fetched.some((s) => r.gw.sigs.find((x) => x.signature === s)?.err !== null));
    assert.deepEqual(r.recorded.map((m) => [m.signature, m.verifiedOnChain]).sort(), MIG.map((m) => [m.signature, false]).sort());
    // The two pools on file verify; the third is not visible (deferred), so it is not published.
    assert.equal(r.migrations.length, 2);
    for (const m of r.migrations) {
      assert.equal(m.verifiedOnChain, true);
      assert.ok(VERIFIABLE.has(m.pool));
      const fx = MIG.find((x) => x.signature === m.signature) as FxTx;
      assert.deepEqual([m.mint, m.pool, m.slot, m.migratedAtMs], [fx.mint, fx.pool, BigInt(fx.slot), fx.blockTime * 1_000]);
    }
    assert.deepEqual(r.pools.map((p) => [p.source, p.verifiedOnChain, p.quoteMint, p.venue]), [['chain_backfill', true, MINTS.wsol, 'pumpswap'], ['chain_backfill', true, MINTS.wsol, 'pumpswap']]);
    // A second run publishes nothing again; the cursor is the newest signature.
    await r.b.backfillSince(null);
    assert.equal(r.migrations.length, 2);
    assert.equal(JSON.parse(r.store.cursorValue as string).until, r.gw.sigs[0]?.signature);
    // The third migration's pool is not on file, so it waits (deferred; see the deferred test).
    assert.ok(!VERIFIABLE.has((MIG[2] as FxTx).pool));
  });

  it('a PumpPortal outage of 1 h: backfill finds every migration of that hour and the 7-day gapBps shows the outage', async () => {
    const r = await rig();
    // PumpPortal saw the first migration; it was down for the hour of the second (no notice).
    const [a] = MIG as [FxTx];
    r.b.onNotice({ mint: a.mint, pool: a.pool, signature: null, slot: null });
    await r.b.backfillSince(null);
    assert.equal(r.migrations.length, 2);
    assert.deepEqual(r.b.coverage(7 * 86_400_000), { chainMigrations: 2, seenByPumpPortal: 1, gapBps: 5_000 });
    assert.ok(r.logs.some(([l, c, f]) => l === 'warn' && c === 'm03.d12_switch_condition' && f.gap_bps === 5_000));
    // Outside the window nothing counts.
    assert.deepEqual(r.b.coverage(1), { chainMigrations: 0, seenByPumpPortal: 0, gapBps: 0 });
  });
});

describe('A-M03-02 failures, cursor and the reconnect port', () => {
  it('a 429 mid-page ends the run without moving the cursor; the next run resumes with no duplicates', async () => {
    const sigs: SigRow[] = Array.from({ length: 2_500 }, (_, i) => ({ signature: sig('P', i), slot: 454_000_000 - i, err: { Custom: 1 } }));
    sigs.splice(1_200, 0, { signature: (MIG[0] as FxTx).signature, slot: 453_967_868, err: null });
    const r = await rig({ sigs });
    r.store.cursorValue = JSON.stringify({ until: sig('P', 2_499), pendingTop: null, before: null });
    r.gw.failPageAt = 2;
    const a = await r.b.backfillSince(null);
    assert.ok(!a.ok);
    assert.equal(JSON.parse(r.store.cursorValue as string).until, sig('P', 2_499));
    assert.equal(r.migrations.length, 0);
    const b = await r.b.backfillSince(null);
    assert.ok(b.ok);
    assert.equal(r.migrations.length, 1);
    await r.b.backfillSince(null);
    assert.equal(r.migrations.length, 1);
    assert.equal(JSON.parse(r.store.cursorValue as string).until, sig('P', 0));
  });

  it('the page cap stops a long catch-up and the next run continues from where it got to, skipping nothing', async () => {
    const sigs: SigRow[] = Array.from({ length: 3 * PAGE_LIMIT + 10 }, (_, i) => ({ signature: sig('C', i), slot: 454_000_000 - i, err: { Custom: 1 } }));
    sigs.splice(2_500, 0, { signature: (MIG[1] as FxTx).signature, slot: 453_967_481, err: null });
    const r = await rig({ sigs, config: { maxPagesPerRun: 1 } });
    r.store.cursorValue = JSON.stringify({ until: sig('C', 3 * PAGE_LIMIT + 9), pendingTop: null, before: null });
    await r.b.backfillSince(null);
    let c = JSON.parse(r.store.cursorValue as string);
    assert.deepEqual([c.until, c.pendingTop, c.before], [sig('C', 3 * PAGE_LIMIT + 9), sig('C', 0), sig('C', PAGE_LIMIT - 1)]);
    await r.b.backfillSince(null);
    await r.b.backfillSince(null);
    assert.equal(r.migrations.length, 1);
    await r.b.backfillSince(null);
    c = JSON.parse(r.store.cursorValue as string);
    assert.deepEqual([c.until, c.pendingTop, c.before], [sig('C', 0), null, null]);
  });

  it('-32015 (version not supported) is a critical alert; other tx errors and a null tx end the run; decode errors are skipped', async () => {
    const r = await rig();
    r.gw.failTx = { signature: (MIG[0] as FxTx).signature, error: { code: 'E_RPC', message: 'v', rpcCode: -32_015 } };
    assert.ok(!(await r.b.backfillSince(null)).ok);
    assert.ok(r.logs.some(([l, c]) => l === 'critical' && c === 'm03.tx_version_unsupported'));
    heldBelow(r, (MIG[0] as FxTx).signature);
    r.gw.failTx = { signature: (MIG[0] as FxTx).signature, error: { code: 'E_TIMEOUT', message: 't' } };
    assert.ok(!(await r.b.backfillSince(null)).ok);
    r.gw.failTx = null;
    r.gw.txs.set((MIG[0] as FxTx).signature, null);
    assert.ok(!(await r.b.backfillSince(null)).ok);
    r.gw.txs.set((MIG[0] as FxTx).signature, { not: 'a transaction' });
    assert.ok((await r.b.backfillSince(null)).ok);
    assert.ok(r.logs.some(([, c, f]) => c === 'm03.migration_rejected' && f.reason === 'E_TX_SHAPE'));
  });

  it('a pool not visible yet is deferred, retried on later runs, then dropped as not_found; once visible it is published', async () => {
    const r = await rig({ poolsVisible: false });
    await r.b.backfillSince(null);
    assert.equal(r.migrations.length, 0);
    for (const s of POOL_SETS) for (const a of s.accounts) r.reader.accounts.set(a.pubkey, raw(a));
    await r.b.backfillSince(null);
    assert.equal(r.migrations.length, 2);
    for (let i = 0; i < DEFERRED_RUNS; i++) await r.b.backfillSince(null);
    assert.ok(r.logs.some(([, c, f]) => c === 'm03.migration_rejected' && f.reason === 'not_found'));
    const runs = r.reader.calls.length;
    await r.b.backfillSince(null);
    assert.equal(r.reader.calls.length, runs);                                      // the dropped pool is not read again
  });

  it('verifyPool refuses a pool whose base mint is not the migrated mint, an unknown account, and an RPC failure', async () => {
    const r = await rig();
    const [a, b] = MIG as [FxTx, FxTx];
    const okA = await r.b.verifyPool(a.pool, a.mint);
    assert.ok(okA.ok && okA.value.isCanonical === true);
    assert.deepEqual(await r.b.verifyPool(a.pool, b.mint), { ok: false, error: { code: 'E_NOT_CANONICAL' } });
    assert.deepEqual(await r.b.verifyPool((MIG[2] as FxTx).pool, (MIG[2] as FxTx).mint), { ok: false, error: { code: 'E_NOT_FOUND' } });
    r.reader.fail = true;
    assert.deepEqual(await r.b.verifyPool(a.pool, a.mint), { ok: false, error: { code: 'E_RPC' } });
  });

  it('a PumpPortal notice verifies at once, retries 3 times at 2 s, publishes once with the chain; the reconnect port', async () => {
    const r = await rig({ sigs: [], poolsVisible: false });
    const m = MIG[0] as FxTx;
    r.b.onNotice({ mint: m.mint, pool: m.pool, signature: m.signature, slot: BigInt(m.slot) as Slot });
    await waitFor(() => r.time.pending() === 1);                                     // the first try failed: one retry set
    for (const s of POOL_SETS) for (const a of s.accounts) r.reader.accounts.set(a.pubkey, raw(a));
    await r.time.advance(2_000);
    await waitFor(() => r.migrations.length === 1);
    assert.deepEqual(r.migrations.map((x) => [x.source, x.verifiedOnChain]), [['pumpportal', true]]);
    assert.equal(r.pools[0]?.source, 'pumpportal');
    assert.equal(r.b.verifiedSlot(), BigInt(m.slot));
    r.gw.sigs = sample150();
    for (const s of r.gw.sigs) if (!r.gw.txs.has(s.signature)) r.gw.txs.set(s.signature, SWAP.json);
    for (const x of MIG) r.gw.txs.set(x.signature, x.json);
    await r.b.backfillSince(null);
    assert.equal(r.migrations.filter((x) => x.pool === m.pool).length, 1);           // the chain finds it again: nothing more
    assert.equal(r.b.migrationsSeenSince(0 as UnixMs), 2);
    assert.deepEqual(r.b.recentMigrations(86_400_000_000).map((x) => x.pool).sort(), POOL_SETS.map((s) => (s.accounts.find((a) => a.role === 'pool') as FxAccount).pubkey).sort());
    // A notice with no pool or no signature only marks coverage.
    r.b.onNotice({ mint: m.mint, pool: null, signature: null, slot: null });
    // Retries stop after 3 attempts.
    const r2 = await rig({ sigs: [], poolsVisible: false });
    r2.b.onNotice({ mint: m.mint, pool: m.pool, signature: m.signature, slot: BigInt(m.slot) as Slot });
    for (let i = 0; i < 3; i++) {
      await waitFor(() => r2.reader.calls.length === i + 1);
      await r2.time.advance(2_000);
    }
    await r2.time.advance(10_000);
    assert.equal(r2.reader.calls.length, 3);
    assert.equal(r2.time.pending(), 0);
  });

  it('one run at a time; start runs at once and every interval; stop cancels; config checks', async () => {
    const r = await rig();
    const [a, b] = [r.b.backfillSince(null), r.b.backfillSince(null)];
    assert.equal(a, b);
    await a;
    const r2 = await rig({ sigs: [] });
    r2.b.start();
    r2.b.start();
    await r2.time.advance(0);
    assert.equal(r2.gw.pages, 1);
    await r2.time.advance(60_000);
    assert.equal(r2.gw.pages, 2);
    r2.b.stop();
    await r2.time.advance(120_000);
    assert.equal(r2.gw.pages, 2);
    assert.equal(checkBackfillConfig(BACKFILL_DEFAULTS), null);
    assert.notEqual(checkBackfillConfig({ intervalMs: 14_999, maxPagesPerRun: 20 }), null);
    assert.notEqual(checkBackfillConfig({ intervalMs: 60_000, maxPagesPerRun: 101 }), null);
    await assert.rejects(async () => rig({ config: { maxPagesPerRun: 0 } }));
  });
});

describe('Z08-2: the backfill is A-M03-01 reconnect port', () => {
  it('a MigrationBackfill fills PumpPortalDeps.backfill (compile-time) and answers it', async () => {
    const r = await rig({ sigs: [] });
    const port: PumpPortalDeps['backfill'] = r.b;
    assert.equal(port.verifiedSlot(), null);
    assert.equal(port.migrationsSeenSince(0 as UnixMs), 0);
    assert.ok(((await port.backfillSince(null)) as { ok: boolean }).ok);
  });
});

describe('Z09 round 2 (red team RT-1, RT-2; rulings Z09-12, Z09-13, Z09-20, Z09-21, Z09-23)', () => {
  const backlog = (): SigRow[] => {
    const sigs: SigRow[] = Array.from({ length: 3 * PAGE_LIMIT + 10 }, (_, i) => ({ signature: sig('C', i), slot: 454_000_000 - i, err: { Custom: 1 } }));
    sigs.splice(2_500, 0, { signature: (MIG[1] as FxTx).signature, slot: 453_997_499, err: null });
    return sigs;
  };
  it('RT-1 control: the same backlog with no reconnect call finds the migration', async () => {
    const r = await rig({ sigs: backlog(), config: { maxPagesPerRun: 1 } });
    r.store.cursorValue = JSON.stringify({ until: sig('C', 3 * PAGE_LIMIT + 9), pendingTop: null, before: null });
    for (let i = 0; i < 6; i++) await r.b.backfillSince(null);
    assert.equal(r.migrations.length, 1);
  });

  it('RT-1 / Z09-12: a reconnect backfillSince(fromSlot) during a page-cap catch-up is a hint only; nothing is skipped', async () => {
    const r = await rig({ sigs: backlog(), config: { maxPagesPerRun: 1 } });
    r.store.cursorValue = JSON.stringify({ until: sig('C', 3 * PAGE_LIMIT + 9), pendingTop: null, before: null });
    await r.b.backfillSince(null);
    await r.b.backfillSince(453_999_999n as Slot);
    for (let i = 0; i < 5; i++) await r.b.backfillSince(null);
    assert.equal(r.migrations.length, 1, `backlog migration lost; cursor=${r.store.cursorValue}`);
  });

  it('RT-2 / Z09-13: a notice-first pool takes its slot and block time from the chain; the notice slot never sets verifiedSlot', async () => {
    const r = await rig({ sigs: [] });
    const m = MIG[0] as FxTx;
    r.b.onNotice({ mint: m.mint, pool: m.pool, signature: m.signature, slot: 1n as Slot });         // a wrong slot in the notice
    await waitFor(() => r.pools.length === 1);
    assert.deepEqual([r.pools[0]?.slot, r.pools[0]?.migratedAtMs, r.pools[0]?.source], [BigInt(m.slot), m.blockTime * 1_000, 'pumpportal']);
    assert.equal(r.b.verifiedSlot(), BigInt(m.slot));
    r.gw.sigs = [{ signature: m.signature, slot: m.slot, err: null }];
    await r.b.backfillSince(null);
    assert.notEqual(r.pools.at(-1)?.migratedAtMs ?? null, null);
    assert.equal(r.pools.length, 1);                                                 // the chain sighting adds nothing more
    // A notice naming a transaction that holds no such migration is dropped.
    const r2 = await rig({ sigs: [] });
    r2.b.onNotice({ mint: m.mint, pool: (MIG[1] as FxTx).pool, signature: m.signature, slot: null });
    await waitFor(() => r2.logs.some(([, c, f]) => c === 'm03.migration_rejected' && f.reason === 'notice_not_on_chain'));
    assert.equal(r2.pools.length, 0);
  });

  it('Z09-13: a chain sighting fills a migration time the first publication lacked, and re-publishes it once', async () => {
    const r = await rig({ sigs: [] });
    const m = MIG[0] as FxTx;
    r.store.putVerified({ mint: m.mint, pool: m.pool, slot: BigInt(m.slot) as Slot, atMs: 1 as UnixMs, migratedAtMs: null });
    r.gw.sigs = [{ signature: m.signature, slot: m.slot, err: null }];
    await r.b.backfillSince(null);
    assert.deepEqual(r.pools.map((p) => p.migratedAtMs), [m.blockTime * 1_000]);
    assert.ok(r.logs.some(([, c]) => c === 'm03.migration_time_filled'));
    r.store.cursorValue = null;
    await r.b.backfillSince(null);
    assert.equal(r.pools.length, 1);
  });

  it('Z09-20: after a restart on the same M24 database publication is idempotent and deferred pools survive the cursor moving past them', async () => {
    const db = openDb({ create: true, path: join(tempDir('backfill'), 'b.db'), clock: fakeClock() });
    assert.equal((await prepareDatabase(db, { clock: fakeClock(), backupPath: `${join(tempDir('backfill'), 'b.db')}.bak` })).ok, true);
    const store = m24BackfillStore(db, () => (MIG[2] as FxTx).blockTime * 1_000 as UnixMs);
    const a = await rig({ store, poolsVisible: false });
    await a.b.backfillSince(null);                                                   // all 3 deferred; the cursor moves to the newest
    assert.equal(a.migrations.length, 0);
    assert.equal(store.deferred.list().length, 3);
    const b = await rig({ store });                                                  // restart: a new instance, pools now visible
    await b.b.backfillSince(null);
    assert.equal(b.migrations.length, 2);                                            // the deferred pools were retried from the store
    const c = await rig({ store });                                                  // restart again, the cursor reset: nothing twice
    store.cursor.save(JSON.stringify({ until: null, pendingTop: null, before: null }));
    await c.b.backfillSince(null);
    assert.equal(c.migrations.length, 0);
    assert.equal(c.b.coverage(7 * 86_400_000).chainMigrations, 2);
    assert.equal(c.b.verifiedSlot(), BigInt((MIG[0] as FxTx).slot) > BigInt((MIG[1] as FxTx).slot) ? BigInt((MIG[0] as FxTx).slot) : BigInt((MIG[1] as FxTx).slot));
    c.b.onNotice({ mint: (MIG[0] as FxTx).mint, pool: (MIG[0] as FxTx).pool, signature: null, slot: null });
    assert.equal(store.seenByPumpPortal((MIG[0] as FxTx).mint, (MIG[0] as FxTx).pool), true);
    store.prune(Number.MAX_SAFE_INTEGER);
    assert.equal(store.verifiedSince(0).length, 0);
    db.close();
  });

  it('Z09-21: a missing transaction or -32015 that stops the cursor logs m03.backfill_stalled', async () => {
    const r = await rig();
    r.gw.txs.set((MIG[0] as FxTx).signature, null);
    await r.b.backfillSince(null);
    assert.ok(r.logs.some(([, c, f]) => c === 'm03.backfill_stalled' && f.reason === 'tx_not_visible'));
    r.gw.txs.set((MIG[0] as FxTx).signature, (MIG[0] as FxTx).json);
    r.gw.failTx = { signature: (MIG[0] as FxTx).signature, error: { code: 'E_RPC', message: 'v', rpcCode: -32_015 } };
    await r.b.backfillSince(null);
    assert.ok(r.logs.some(([, c, f]) => c === 'm03.backfill_stalled' && f.reason === 'version_unsupported'));
    heldBelow(r, (MIG[0] as FxTx).signature);
  });
});

describe('Z09-21 (amended): a transaction that stays null', () => {
  it('gets a capped number of runs, then a critical log and a health flag; never skipped, the cursor held; cleared when it appears', async () => {
    const r = await rig();
    const m = MIG[0] as FxTx;
    r.gw.txs.set(m.signature, null);
    for (let i = 1; i < NULL_TX_MAX_ATTEMPTS; i++) {
      await r.b.backfillSince(null);
      assert.deepEqual(r.b.health(), { stalledSignature: m.signature, attempts: i, critical: false });
    }
    assert.ok(!r.logs.some(([l, c]) => l === 'critical' && c === 'm03.backfill_tx_missing'));
    await r.b.backfillSince(null);
    assert.deepEqual(r.b.health(), { stalledSignature: m.signature, attempts: NULL_TX_MAX_ATTEMPTS, critical: true });
    assert.equal(r.logs.filter(([l, c]) => l === 'critical' && c === 'm03.backfill_tx_missing').length, 1);
    await r.b.backfillSince(null);
    assert.equal(r.b.health().critical, true);
    heldBelow(r, m.signature);                                                        // never moved past it
    assert.ok(!r.migrations.some((x) => x.signature === m.signature));               // older ones may publish; it never is
    r.gw.txs.set(m.signature, m.json);
    await r.b.backfillSince(null);
    assert.deepEqual(r.b.health(), { stalledSignature: null, attempts: 0, critical: false });
    assert.equal(r.migrations.length, 2);
  });

  it('the attempts survive a restart on M24', async () => {
    const path = join(tempDir('stall'), 's.db');
    const db = openDb({ create: true, path, clock: fakeClock() });
    assert.equal((await prepareDatabase(db, { clock: fakeClock(), backupPath: `${path}.bak` })).ok, true);
    const store = m24BackfillStore(db, () => (MIG[2] as FxTx).blockTime * 1_000 as UnixMs);
    const a = await rig({ store });
    a.gw.txs.set((MIG[0] as FxTx).signature, null);
    await a.b.backfillSince(null);
    const b = await rig({ store });
    b.gw.txs.set((MIG[0] as FxTx).signature, null);
    await b.b.backfillSince(null);
    assert.equal(b.b.health().attempts, 2);
    db.close();
  });
});

describe('Z09 round 3 minors (rulings Z09-35, Z09-36, Z09-37)', () => {
  const txCalls = (r: Rig, from: number): string[] => r.gw.calls.slice(from).filter((c) => c.method === 'getTransaction').map((c) => c.params[0] as string);

  it('Z09-35: a stall after paging to `until` keeps what was processed below it, so the next run fetches only from the stall up', async () => {
    const r = await rig();
    const m = MIG[0] as FxTx;
    r.gw.txs.set(m.signature, null);
    await r.b.backfillSince(null);
    const at = r.gw.sigs.findIndex((s) => s.signature === m.signature);
    assert.equal(JSON.parse(r.store.cursorValue as string).until, (r.gw.sigs[at + 1] as SigRow).signature);
    const mark = r.gw.calls.length;
    await r.b.backfillSince(null);
    assert.deepEqual(txCalls(r, mark), [m.signature], 'only the stalled transaction (the newer ones failed) is fetched again');
    r.gw.txs.set(m.signature, m.json);
    await r.b.backfillSince(null);
    assert.equal(r.migrations.length, 2);                                             // as with no stall (Z09-21 test)
    assert.equal(JSON.parse(r.store.cursorValue as string).until, (r.gw.sigs[0] as SigRow).signature);
  });

  it('Z09-36: a deferred migration is recorded once, however many runs see it', async () => {
    const r = await rig({ poolsVisible: false });
    r.gw.txs.set((MIG[0] as FxTx).signature, null);                                   // each run stalls on the newest
    for (let i = 0; i < 3; i++) await r.b.backfillSince(null);
    for (const m of [MIG[1], MIG[2]] as FxTx[]) assert.equal(r.recorded.filter((x) => x.signature === m.signature).length, 1, m.signature);
  });

  it('Z09-37: a notice whose transaction is not visible yet logs its own code, not m03.backfill_stalled', async () => {
    const r = await rig({ sigs: [] });
    const m = MIG[0] as FxTx;
    r.gw.txs.set(m.signature, null);
    r.b.onNotice({ mint: m.mint, pool: m.pool, signature: m.signature, slot: BigInt(m.slot) as Slot });
    await waitFor(() => r.logs.some(([, c]) => c === 'm03.notice_tx_not_visible'));
    assert.ok(!r.logs.some(([, c]) => c === 'm03.backfill_stalled'));
    assert.deepEqual(r.b.health(), { stalledSignature: null, attempts: 0, critical: false });
  });
});
