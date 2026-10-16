// Ruling Z10-15 (amends Z07 M04, card Z10): verification reads go at P1 (a metered peer can answer; M14 refuses P2+
// there), at most `pool_tracker.verify_daily_cap` a UTC day; past it, none until the next day (the Z07 fail-closed
// behaviour: past-ceiling reads unstored, entries refused) and ONE critical `m04.verify_cap_reached` that day.
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import { checkM04Settings, M04_DEFAULTS, type M04Settings } from '../../src/m04/settings.ts';
import { createPoolTracker } from '../../src/m04/tracker.ts';
import { FakeTime } from '../m14/helpers.ts';
import { FakeChain, fakeModel, Logs, Metrics, Outputs, poolAccounts, ScriptedReader } from './fake.ts';

const DAY = 86_400_000;

async function setup(settings: Partial<M04Settings>, verifyCount?: { load(): { day: number; count: number } | null; save(v: { day: number; count: number }): void }) {
  const time = new FakeTime();
  time.now = 20_000 * DAY - 120_000;                                        // two minutes before a UTC midnight
  const reader = new ScriptedReader();
  const chain = new FakeChain();
  const outputs = new Outputs();
  const log = new Logs();
  const tracker = createPoolTracker({
    model: fakeModel, reader, scheduler: time, chain, clock: time, outputs, log, metrics: new Metrics(), settings: { ...M04_DEFAULTS, ...settings }, providerOrder: () => ['primary', 'backup'],
    ...(verifyCount === undefined ? {} : { verifyCount }),
  });
  for (const [k, v] of poolAccounts('a', 1_000n, 2_000n)) reader.accounts.set(k, v);
  chain.highest = 2_000n;
  reader.slot = () => chain.highest;
  tracker.watch('a', 'candidate');
  await tracker.settled();
  // From here the primary's polls answer 50 slots past the clock (a lone provider); the backup answers at the clock.
  reader.slot = (c) => (c.provider === 'backup' ? chain.highest : chain.highest + 60n);
  reader.provider = (c) => c.provider ?? 'primary';
  reader.calls = [];
  tracker.start();
  const verifies = (): number => reader.calls.filter((c) => c.priority === 1 && c.provider === 'backup').length;
  const capLines = (): number => log.lines.filter(([l, c]) => l === 'critical' && c === 'm04.verify_cap_reached').length;
  return { time, reader, chain, outputs, log, tracker, verifies, capLines };
}

describe('Z10-15 verification reads: P1, capped a UTC day', () => {
  it('the cap holds: 3 a day, then none, ONE critical line; the next UTC day starts again', async () => {
    const s = await setup({ verifyDailyCap: 3 });
    await s.time.advance(60_000);                                           // 30 primary polls past the clock, spacing 2 s
    assert.equal(s.verifies(), 3);
    assert.equal(s.capLines(), 1);
    await s.time.advance(55_000);                                           // still the same UTC day
    assert.equal(s.verifies(), 3);
    assert.equal(s.capLines(), 1);
    await s.time.advance(130_000);                                          // past midnight: a new day's cap (30 s spacing now)
    assert.equal(s.verifies(), 6);
    assert.equal(s.capLines(), 2);
    const dayOf = (d: number): string => new Date(d * DAY).toISOString().slice(0, 10);
    assert.deepEqual(s.log.lines.filter(([, c]) => c === 'm04.verify_cap_reached').map(([, , f]) => f.day), [dayOf(19_999), dayOf(20_000)]);
    s.tracker.stop();
  });

  it('past the cap the fallback is fail closed: nothing past the ceiling is stored and an entry read is refused', async () => {
    const s = await setup({ verifyDailyCap: 0 });
    await s.time.advance(10_000);
    assert.equal(s.verifies(), 0);
    assert.equal(s.capLines(), 1);
    const ceiling = s.chain.highest + BigInt(M04_DEFAULTS.maxProviderLagSlots);
    const latest = s.tracker.latest('a');
    assert.ok(latest === null || latest.providerSlot <= ceiling, 'nothing past the ceiling stored');
    const e = await s.tracker.freshRead('a', 8);
    assert.equal(e.ok, false);
    s.tracker.stop();
  });

  it('the cap is a setting from 0 to 3,000 (default 3,000); a higher value is refused', () => {
    assert.equal(M04_DEFAULTS.verifyDailyCap, 3_000);
    assert.ok(checkM04Settings({ ...M04_DEFAULTS, verifyDailyCap: 0 }).ok);
    for (const bad of [3_001, -1, 1.5]) {
      const r = checkM04Settings({ ...M04_DEFAULTS, verifyDailyCap: bad });
      assert.ok(!r.ok && r.error.key === 'pool_tracker.verify_daily_cap');
    }
  });

  it('Z10-41: the day\'s count survives a restart: the cap stays reached (its code holds) and no more verification reads are made that day; the next day starts again (fails before: a restart reset it)', async () => {
    let saved: { day: number; count: number } | null = null;
    const store = { load: () => saved, save: (v: { day: number; count: number }) => { saved = v; } };
    const a = await setup({ verifyDailyCap: 3 }, store);
    await a.time.advance(20_000);
    assert.equal(a.verifies(), 3);
    assert.equal(a.tracker.verifyCapReached(), true);
    a.tracker.stop();
    // A restart the same UTC day: the cap is still reached, no verification read, no second critical line.
    const b = await setup({ verifyDailyCap: 3 }, store);
    b.time.now = a.time.now;
    assert.equal(b.tracker.verifyCapReached(), true);
    await b.time.advance(20_000);
    assert.equal(b.verifies(), 0);
    assert.equal(b.capLines(), 0);
    // The next UTC day: reads again, and the code clears.
    await b.time.advance(130_000);
    assert.ok(b.verifies() > 0);
    b.tracker.stop();
  });

  it('Z10-50: a save that throws logs one warning, keeps the in-memory count (the cap still holds) and loses no poll (fails before: the throw ended the batch)', async () => {
    const store = { load: () => null, save: () => { throw Object.assign(new Error('disk'), { code: 'SQLITE_FULL' }); } };
    const s = await setup({ verifyDailyCap: 3 }, store);
    await s.time.advance(60_000);
    assert.equal(s.verifies(), 3, 'the cap still bounds the reads');
    assert.equal(s.capLines(), 1);
    assert.equal(s.log.lines.filter(([l, c]) => l === 'warn' && c === 'm04.verify_count_save_failed').length, 1);
    assert.ok(s.reader.calls.filter((c) => c.priority === 2).length >= 50, 'the polls kept running');
    assert.ok(!s.log.lines.some(([, c]) => c === 'm04.internal_error'));
    s.tracker.stop();
  });
});
