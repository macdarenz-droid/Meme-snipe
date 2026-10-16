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
import { checkBackfillConfig, createMigrationBackfill, BACKFILL_DEFAULTS, DEFERRED_RUNS, PAGE_LIMIT, type BackfillDeps, type MigrationObserved, type PoolDiscovered } from '../../src/m03/backfill.ts';
import { migrationDecoder } from '../../src/m03/decode-migrations.ts';
import type { PumpPortalDeps } from '../../src/m03/pumpportal-client.ts';
import type { RawAccount } from '../../src/m04/types.ts';
import type { CallOptions, RpcError } from '../../src/m14/types.ts';
import { ScriptedReader } from '../m04/fake.ts';
import { FakeTime } from '../m14/helpers.ts';
import { sig } from '../m10/sig.ts';
import { waitFor } from '../helpers.ts';

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
  recorded: MigrationObserved[]; migrations: MigrationObserved[]; pools: PoolDiscovered[]; logs: Array<[string, string, Record<string, unknown>]>; cursor: { v: string | null };
}
async function rig(o: { sigs?: SigRow[]; poolsVisible?: boolean; config?: Partial<BackfillDeps<CpPoolState>['config']> } = {}): Promise<Rig> {
  const fees = await feeInputs();
  const model = createPumpSwapPoolModel({ decoder: decoders, fees: () => fees });
  const reader = new ScriptedReader();
  if (o.poolsVisible !== false) for (const s of POOL_SETS) for (const a of s.accounts) reader.accounts.set(a.pubkey, raw(a));
  const gw = new FakeGateway();
  gw.sigs = o.sigs ?? sample150();
  for (const m of MIG) gw.txs.set(m.signature, m.json);
  for (const s of gw.sigs) if (!gw.txs.has(s.signature)) gw.txs.set(s.signature, SWAP.json);
  const time = new FakeTime();
  const cursor = { v: null as string | null };
  const recorded: MigrationObserved[] = [], migrations: MigrationObserved[] = [], pools: PoolDiscovered[] = [];
  const logs: Rig['logs'] = [];
  let id = 0;
  const b = createMigrationBackfill<CpPoolState>({
    config: { ...BACKFILL_DEFAULTS, ...o.config }, gateway: gw, reader, model: model as never,
    decode: migrationDecoder({ readRpcTransaction, decodeEventsWithGaps: decodeEventsWithGaps as never }, idls.ok ? idls.value : [], MINTS.wsol),
    withdrawAuthority: ACCOUNTS.migrationWithdrawAuthority, wsolMint: MINTS.wsol,
    cursor: { load: () => cursor.v, save: (c) => { cursor.v = c; } },
    record: (m) => recorded.push(m), publishMigration: (m) => migrations.push(m), publishPool: (p) => pools.push(p),
    newId: () => `d${id++}`, nowMs: () => (MIG[2] as FxTx).blockTime * 1_000 + time.nowMs() as UnixMs, scheduler: time,
    log: { event: (l, c, f) => logs.push([l, c, (f ?? {}) as Record<string, unknown>]) },
  });
  return { b, gw, reader, time, recorded, migrations, pools, logs, cursor };
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
    assert.equal(JSON.parse(r.cursor.v as string).until, r.gw.sigs[0]?.signature);
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
    r.cursor.v = JSON.stringify({ until: sig('P', 2_499), pendingTop: null, before: null });
    r.gw.failPageAt = 2;
    const a = await r.b.backfillSince(null);
    assert.ok(!a.ok);
    assert.equal(JSON.parse(r.cursor.v).until, sig('P', 2_499));
    assert.equal(r.migrations.length, 0);
    const b = await r.b.backfillSince(null);
    assert.ok(b.ok);
    assert.equal(r.migrations.length, 1);
    await r.b.backfillSince(null);
    assert.equal(r.migrations.length, 1);
    assert.equal(JSON.parse(r.cursor.v).until, sig('P', 0));
  });

  it('the page cap stops a long catch-up and the next run continues from where it got to, skipping nothing', async () => {
    const sigs: SigRow[] = Array.from({ length: 3 * PAGE_LIMIT + 10 }, (_, i) => ({ signature: sig('C', i), slot: 454_000_000 - i, err: { Custom: 1 } }));
    sigs.splice(2_500, 0, { signature: (MIG[1] as FxTx).signature, slot: 453_967_481, err: null });
    const r = await rig({ sigs, config: { maxPagesPerRun: 1 } });
    r.cursor.v = JSON.stringify({ until: sig('C', 3 * PAGE_LIMIT + 9), pendingTop: null, before: null });
    await r.b.backfillSince(null);
    let c = JSON.parse(r.cursor.v);
    assert.deepEqual([c.until, c.pendingTop, c.before], [sig('C', 3 * PAGE_LIMIT + 9), sig('C', 0), sig('C', PAGE_LIMIT - 1)]);
    await r.b.backfillSince(null);
    await r.b.backfillSince(null);
    assert.equal(r.migrations.length, 1);
    await r.b.backfillSince(null);
    c = JSON.parse(r.cursor.v);
    assert.deepEqual([c.until, c.pendingTop, c.before], [sig('C', 0), null, null]);
  });

  it('-32015 (version not supported) is a critical alert; other tx errors and a null tx end the run; decode errors are skipped', async () => {
    const r = await rig();
    r.gw.failTx = { signature: (MIG[0] as FxTx).signature, error: { code: 'E_RPC', message: 'v', rpcCode: -32_015 } };
    assert.ok(!(await r.b.backfillSince(null)).ok);
    assert.ok(r.logs.some(([l, c]) => l === 'critical' && c === 'm03.tx_version_unsupported'));
    assert.equal(r.cursor.v, null);
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
