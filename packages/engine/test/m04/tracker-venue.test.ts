// M04 with the real PumpSwap pool model of `@bot/venue` (card Z07): the 13 recorded pools (fixtures/mainnet/pumpswap)
// served by a scripted reader. First reads find the vaults and mint, the canonical PDA is derived, snapshots carry the
// vault reserves and the fee from the 2026-10-06 configs, the ring keeps them, and the M07 records are accepted.
import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { createDecoders, verifyPinnedIdls, VENDORED_IDL_DIR } from '@bot/decoders';
import type { Pubkey, Slot, UnixMs } from '@bot/types';
import { createPumpSwapPoolModel, createVenueConfigCache, PROGRAMS, type CpPoolState, type FeeInputs } from '@bot/venue';
import { snapshotRecord } from '../../src/m04/record.ts';
import { M04_DEFAULTS } from '../../src/m04/settings.ts';
import { createPoolTracker } from '../../src/m04/tracker.ts';
import type { RawAccount } from '../../src/m04/types.ts';
import { RecorderQueue } from '../../src/recorder/queue.ts';
import { FakeTime } from '../m14/helpers.ts';
import { FakeChain, Logs, Outputs, ScriptedReader } from './fake.ts';

const idls = verifyPinnedIdls(VENDORED_IDL_DIR);
assert.ok(idls.ok);
const decoders = createDecoders(idls.value, { tokenPrograms: { splToken: PROGRAMS.splToken, token2022: PROGRAMS.token2022 } });
const DIR = new URL('../../../../fixtures/mainnet/', import.meta.url);
type FxAccount = { role: string; pubkey: string; owner: string; data_base64: string };
const raw = (a: FxAccount): RawAccount => ({ owner: a.owner, data: new Uint8Array(Buffer.from(a.data_base64, 'base64')) });
const files = readdirSync(new URL('pumpswap/pools/', DIR)).filter((f) => f.endsWith('.json'));
const sets = files.map((f) => JSON.parse(readFileSync(new URL(`pumpswap/pools/${f}`, DIR), 'utf8')) as { accounts: FxAccount[] });

async function feeInputs(): Promise<FeeInputs> {
  const cfg = (n: string) => (JSON.parse(readFileSync(new URL(`config/${n}.json`, DIR), 'utf8')) as { accounts: FxAccount[] }).accounts[0] as FxAccount;
  const accounts = ['fee_config_curve', 'fee_config_pumpswap', 'pumpswap_global_config', 'pump_global'].map((n) => raw(cfg(n)));
  const time = new FakeTime();
  const cache = createVenueConfigCache({ reader: { read: async () => ({ ok: true, value: { contextSlot: 1n as Slot, accounts } }) }, decoder: decoders, clock: time, log: { event: () => {} } });
  await cache.refresh();
  const i = cache.inputs('pumpswap');
  assert.ok(i.ok);
  return i.value;
}

describe('M04 on recorded PumpSwap pools with the venue model', () => {
  it('13 pools: one poll gives 13 snapshots with the vault reserves, canonical, the tier fee, a spot price; M07 accepts the records', async () => {
    const fees = await feeInputs();
    const venue = createPumpSwapPoolModel({ decoder: decoders, fees: () => fees });
    const time = new FakeTime();
    const reader = new ScriptedReader();
    for (const s of sets) for (const a of s.accounts) reader.accounts.set(a.pubkey, raw(a));
    const chain = new FakeChain();
    reader.slot = () => chain.highest;
    const outputs = new Outputs();
    const tracker = createPoolTracker<CpPoolState>({ model: venue, reader, scheduler: time, chain, clock: time, outputs: outputs as unknown as Outputs<never>, log: new Logs(), settings: M04_DEFAULTS, providerOrder: () => ['primary'] });
    const poolIds = sets.map((s) => (s.accounts.find((a) => a.role === 'pool') as FxAccount).pubkey);
    for (const id of poolIds) tracker.watch(id, 'candidate');
    await tracker.settled();
    assert.equal(tracker.ready().length, 13);
    await time.advance(1_000);
    const snaps = outputs.snapshots.map((x) => x.s as unknown as { pool: CpPoolState; feeTotalBps: number; spotSolPerToken: string | null; effectiveQuoteLamports: bigint });
    assert.equal(snaps.length, 13);
    assert.equal(reader.calls.at(-1)?.keys.length, 39);
    for (const s of sets) {
      const id = (s.accounts.find((a) => a.role === 'pool') as FxAccount).pubkey;
      const snap = snaps.find((x) => x.pool.poolId === id);
      assert.ok(snap !== undefined);
      const vault = (role: string) => decoders.decodeAccount((s.accounts.find((a) => a.role === role) as FxAccount).owner, raw(s.accounts.find((a) => a.role === role) as FxAccount).data);
      const base = vault('base_vault'), quote = vault('quote_vault');
      assert.ok(base.kind === 'spl_token_account' && quote.kind === 'spl_token_account');
      assert.deepEqual([snap.pool.baseReserve, snap.pool.quoteReserveReal, snap.pool.isCanonical, snap.pool.asOfSlot], [base.amount, quote.amount, true, 1_000n]);
      assert.ok(snap.feeTotalBps >= 30 && snap.feeTotalBps <= 125);
      assert.ok(snap.spotSolPerToken !== null);
      assert.equal(snap.effectiveQuoteLamports, snap.pool.quoteReserveReal + snap.pool.quoteReserveVirtual);
    }
    const q = new RecorderQueue();
    for (const { s, cls } of outputs.snapshots) assert.equal(q.append(snapshotRecord(s as never, cls, venue as never)), 'queued');
    assert.equal(q.take(100, 'seg').length, 13);
    assert.equal(tracker.history(poolIds[0] as Pubkey, 0 as UnixMs, Number.MAX_SAFE_INTEGER as UnixMs).length, 1);
    tracker.stop();
  });
});
