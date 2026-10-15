// A-M14-05 (card Z08): credit accounting, the account ledger, burn-rate projection, health and degraded mode.
// Acceptance bullets of SPEC-A A-M14-05 and the Zeroed bugs of MIGRATION's A-M14-05 row (B4, RT-A9, round 4 items 7
// and 9) each have a named case; the fail-before runs on the old Zeroed code are recorded in the Z08 pull request.
import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import type { Result, Slot, UnixMs } from '@bot/types';
import type { RequestOptions, RpcClient } from '../../src/m14/client.ts';
import { createRpcGateway, DEFAULT_TIMEOUT_MS, type GatewayDeps } from '../../src/m14/gateway.ts';
import {
  ALL_DOWN_AFTER_MS, createHealthTracker, createModeMachine, createProviderMonitor, percentile, type ModeChange,
} from '../../src/m14/health.ts';
import { openUsageLedger, type UsageLedgerPort } from '../../src/m24/usage-ledger.ts';
import { createUsageMeter, PROJECTION_CACHE_MS, type MeterDeps } from '../../src/m14/meter.ts';
import type { ProviderRegistry } from '../../src/m14/providers.ts';
import type { CallOptions, CallValue, ProviderConfig, ResolvedProvider, RpcError } from '../../src/m14/types.ts';
import {
  checkAccountCap, consumerCaps, DAY_MS, HOUR_MS, monthKeyUtc, monthStartUtc, nextMonthStartUtc, projectedOver, projectMonthEnd,
  ROLLING_WINDOW_MS, unitsFor, type Metering,
} from '../../src/m14/usage.ts';
import { tempDir } from '../helpers.ts';
import { FakeTime, MemoryStopStore, provider, RecordingLog, RecordingMetrics } from './helpers.ts';

const CHAINSTACK: Metering = { unit: 'requests', monthlyAllowance: 3_000_000, methodCost: { getSignaturesForAddress: 2 } };
const HELIUS: Metering = { unit: 'credits', monthlyAllowance: 10_000_000, methodCost: { getProgramAccounts: 10 } };
const T0 = Date.UTC(2026, 9, 15, 12, 0, 0) as UnixMs;

/** A meter on a real SQLite ledger in a temp dir; `now` is settable. */
function meterOn(path: string, over: Partial<MeterDeps> = {}) {
  let now: number = T0;
  const log = new RecordingLog();
  const meter = createUsageMeter({
    consumer: 'engine', providers: [{ label: 'chainstack', metering: CHAINSTACK }, { label: 'helius', metering: HELIUS }],
    caps: [{ provider: 'chainstack', accountCap: 1_500_000, consumerCap: 1_450_000 }, { provider: 'helius', accountCap: 5_000_000, consumerCap: 4_950_000 }],
    blockUnits: 1_000, alertBps: 8_000, openLedger: () => openUsageLedger(path), nowMs: () => now as UnixMs, log, ...over,
  });
  return { meter, log, set: (t: number) => { now = t; }, now: () => now };
}

describe('A-M14-05 pure credit maths (usage.ts)', () => {
  it('a method costs its listed units, else 1 (Chainstack getSignaturesForAddress 2 RU [VF-10])', () => {
    assert.equal(unitsFor(CHAINSTACK, 'getSignaturesForAddress'), 2);
    assert.equal(unitsFor(CHAINSTACK, 'getMultipleAccounts'), 1);
    assert.equal(unitsFor(CHAINSTACK, 'toString'), 1);                   // own keys only
  });

  it('UTC months: start, next start and key; the projection runs to the month end', () => {
    const t = Date.UTC(2026, 11, 31, 23, 0, 0);
    assert.equal(monthStartUtc(t), Date.UTC(2026, 11, 1));
    assert.equal(nextMonthStartUtc(t), Date.UTC(2027, 0, 1));
    assert.equal(monthKeyUtc(t), '2026-12');
    assert.equal(projectMonthEnd(100, 24, t), 101);                       // 1 unit an hour, 1 hour left
    assert.equal(projectedOver(8_000, 10_000, 8_000), true);
    assert.equal(projectedOver(7_999, 10_000, 8_000), false);
  });

  it('an account cap is at most 50% of the documented plan', () => {
    assert.equal(checkAccountCap(1_500_000, 3_000_000), null);
    assert.match(checkAccountCap(1_500_001, 3_000_000) as string, /50%/);
    assert.match(checkAccountCap(0, 3_000_000) as string, /whole/);
    assert.match(checkAccountCap(1.5, 3_000_000) as string, /whole/);
  });

  it('acceptance: a signer block of 50,000 RU leaves the engine a Chainstack cap of 1,450,000 ("rest")', () => {
    const caps = new Map([['chainstack', 1_500_000], ['helius', 5_000_000]]);
    const r = consumerCaps({ credits: { chainstack: { signer: 50_000, engine: 'rest' } } }, caps, 'engine');
    assert.ok(r.ok);
    assert.deepEqual(r.value, [
      { provider: 'chainstack', accountCap: 1_500_000, consumerCap: 1_450_000 },
      { provider: 'helius', accountCap: 5_000_000, consumerCap: 0 },       // no line: never sent to
    ]);
    const signer = consumerCaps({ credits: { chainstack: { signer: 50_000, engine: 'rest' } } }, caps, 'signer');
    assert.ok(signer.ok && signer.value[0]?.consumerCap === 50_000);
    const absent = consumerCaps({ credits: { chainstack: { signer: 50_000 } } }, caps, 'engine');
    assert.ok(absent.ok && absent.value[0]?.consumerCap === 0);
  });

  it('shares above the cap are E_ALLOCATION_EXCEEDS_CAP; malformed files are E_CONFIG', () => {
    const caps = new Map([['helius', 5_000_000]]);
    const over = consumerCaps({ credits: { helius: { engine: 4_900_000, signer: 50_000, b10: 100_000 } } }, caps, 'engine');
    assert.ok(!over.ok && over.error.problems[0]?.code === 'E_ALLOCATION_EXCEEDS_CAP');
    const cases: unknown[] = [
      null, {}, { credits: [] }, { credits: { helius: 5 } }, { credits: { helius: { a: 'rest', b: 'rest' } } },
      { credits: { helius: { a: -1 } } }, { credits: { helius: { a: 1.5 } } }, { credits: { unknown: { a: 1 } } },
    ];
    for (const raw of cases) {
      const r = consumerCaps(raw, caps, 'engine');
      assert.ok(!r.ok && r.error.problems.every((p) => p.code === 'E_CONFIG'), JSON.stringify(raw));
    }
  });
});

describe('A-M14-05 account ledger and meter', () => {
  it('acceptance: 724,999 getSignaturesForAddress + 1 getMultipleAccounts read 1,449,999 RU; the next gSFA is refused before it is sent, for every engine-side process, and after a restart', () => {
    const path = join(tempDir('z08-ledger'), 'rpc-usage.db');
    const l = openUsageLedger(path);
    // The signer's standing block (the root-owned allocator's entry); the engine never writes it.
    assert.equal(l.reserve({ provider: 'chainstack', consumer: 'signer', units: 50_000, atMs: T0 - HOUR_MS, accountCap: 1_500_000, consumerCap: 50_000 }), 'ok');
    // 724,999 × 2 RU and 1 × 1 RU, written as the meter writes them (blocks); the sum is what matters.
    assert.equal(l.reserve({ provider: 'chainstack', consumer: 'engine', units: 724_999 * 2, atMs: T0 - DAY_MS, accountCap: 1_500_000, consumerCap: 1_450_000 }), 'ok');
    assert.equal(l.reserve({ provider: 'chainstack', consumer: 'engine', units: 1, atMs: T0 - DAY_MS, accountCap: 1_500_000, consumerCap: 1_450_000 }), 'ok');
    assert.equal(l.totals('chainstack', 'engine', T0).consumerRolling, 1_449_999);
    assert.equal(l.totals('chainstack', 'engine', T0).accountRolling, 1_499_999);
    l.close();
    const worker = meterOn(path);
    const sentinel = meterOn(path);                                       // the sentinel shares the engine's allocation
    assert.equal(worker.meter.take('chainstack', 'getSignaturesForAddress'), false);
    assert.equal(sentinel.meter.take('chainstack', 'getSignaturesForAddress'), false);
    assert.ok(worker.log.events.some((e) => e.code === 'm14.credit_cap_reached' && e.fields.units === 2));
    const restarted = meterOn(path);
    assert.equal(restarted.meter.take('chainstack', 'getSignaturesForAddress'), false);
    const check = openUsageLedger(path);
    assert.equal(check.totals('chainstack', 'engine', T0).consumerRolling, 1_449_999);   // nothing written by the refusals
    assert.equal(check.totals('chainstack', 'signer', T0).consumerRolling, 50_000);       // the signer's block untouched
    check.close();
    // When the rolling sum falls (the big entry leaves the 31-day window), sends resume.
    restarted.set(T0 - DAY_MS + ROLLING_WINDOW_MS + 1);
    assert.equal(restarted.meter.take('chainstack', 'getSignaturesForAddress'), true);
  });

  it('acceptance: two keys of one Chainstack account count in the one account ledger', () => {
    const path = join(tempDir('z08-keys'), 'rpc-usage.db');
    const a = meterOn(path);
    const b = meterOn(path);                                              // a second process, another key, same account label
    assert.ok(a.meter.take('chainstack', 'getMultipleAccounts'));
    assert.ok(b.meter.take('chainstack', 'getMultipleAccounts'));
    const l = openUsageLedger(path);
    assert.equal(l.totals('chainstack', 'engine', T0).accountRolling, 2_000);   // two blocks, one account
    l.close();
  });

  it('one block pays for 1,000 units; near the cap a reservation of exactly the cost is tried', () => {
    const path = join(tempDir('z08-block'), 'rpc-usage.db');
    const m = meterOn(path, { caps: [{ provider: 'chainstack', accountCap: 1_500_000, consumerCap: 1_001 }] });
    for (let i = 0; i < 1_000; i += 1) assert.ok(m.meter.take('chainstack', 'getMultipleAccounts'));
    assert.ok(m.meter.take('chainstack', 'getMultipleAccounts'));          // block refused (1,000 > 1 left), exact 1 granted
    assert.equal(m.meter.take('chainstack', 'getMultipleAccounts'), false);
    const l = openUsageLedger(path);
    assert.equal(l.totals('chainstack', 'engine', T0).consumerRolling, 1_001);
    assert.deepEqual(l.counts('chainstack', 'engine', monthKeyUtc(T0)), { attempts: 1_001, ok: 0, errors: 0, timeouts: 0 });
    l.close();
    m.meter.record('chainstack', 'ok');
    m.meter.record('chainstack', 'error');
    m.meter.record('chainstack', 'timeout');
    m.meter.record('shyft', 'ok');                                        // unmetered: nothing
    assert.deepEqual(m.meter.counts('chainstack'), { attempts: 1_001, ok: 1, errors: 1, timeouts: 1 });
    assert.equal(m.meter.counts('shyft'), null);
  });

  it('an unmetered provider is never refused; a metered one without a share always is', () => {
    const m = meterOn(join(tempDir('z08-share'), 'rpc-usage.db'), { caps: [{ provider: 'chainstack', accountCap: 1_500_000, consumerCap: 0 }] });
    assert.ok(m.meter.take('shyft', 'getMultipleAccounts'));
    assert.equal(m.meter.take('chainstack', 'getMultipleAccounts'), false);
    assert.equal(m.meter.take('helius', 'getMultipleAccounts'), false);   // no cap line at all
  });

  it('Zeroed round 4 item 9: an unreadable ledger refuses sends (critical, once) and recovers when readable again; the month does not halt', () => {
    const path = join(tempDir('z08-unreadable'), 'rpc-usage.db');
    let broken = true;
    const m = meterOn(path, { openLedger: () => { if (broken) throw new Error('unreadable'); return openUsageLedger(path); } });
    assert.equal(m.meter.take('chainstack', 'getMultipleAccounts'), false);
    assert.equal(m.meter.take('chainstack', 'getMultipleAccounts'), false);
    assert.equal(m.log.events.filter((e) => e.code === 'm14.ledger_unavailable').length, 1);
    assert.equal(m.meter.projectedOver80('chainstack'), true);             // fail closed
    assert.ok(Number.isNaN(m.meter.creditUsage()[0]?.projectedMonthEnd));
    assert.equal(m.meter.counts('chainstack'), null);
    broken = false;
    assert.ok(m.meter.take('chainstack', 'getMultipleAccounts'));
    assert.ok(m.log.events.some((e) => e.code === 'm14.ledger_recovered'));
  });

  it('Zeroed round 4 item 7: a failed ledger write refuses that one send and spends nothing; the next send goes', () => {
    const path = join(tempDir('z08-write'), 'rpc-usage.db');
    let failNext = true;
    const m = meterOn(path, {
      openLedger: () => {
        const real = openUsageLedger(path);
        return { ...real, reserve: (r) => { if (failNext) { failNext = false; throw new Error('disk I/O error'); } return real.reserve(r); } } satisfies UsageLedgerPort;
      },
    });
    assert.equal(m.meter.take('chainstack', 'getMultipleAccounts'), false);
    assert.ok(m.meter.take('chainstack', 'getMultipleAccounts'));
    const l = openUsageLedger(path);
    assert.equal(l.totals('chainstack', 'engine', T0).consumerRolling, 1_000);   // only the second block
    l.close();
  });

  it('Zeroed RT-A9: a request sent at the last moment of a month that fails after midnight is never refunded; it stays in the month it was sent', () => {
    const path = join(tempDir('z08-midnight'), 'rpc-usage.db');
    const m = meterOn(path, { blockUnits: 1 });
    const lastMs = Date.UTC(2026, 9, 31, 23, 59, 59, 999);
    m.set(lastMs);
    assert.ok(m.meter.take('chainstack', 'getSignaturesForAddress'));
    m.set(lastMs + 2);
    m.meter.record('chainstack', 'error');
    const l = openUsageLedger(path);
    assert.equal(l.totals('chainstack', 'engine', lastMs).monthToDate, 2);
    assert.equal(l.totals('chainstack', 'engine', lastMs + 2).monthToDate, 0);       // November starts empty
    assert.equal(l.totals('chainstack', 'engine', lastMs + 2).consumerRolling, 2);   // and the rolling sum keeps it
    l.close();
  });

  it('B4: an 87k-credits-an-hour pattern with zero trades projects over 80% of Helius Developer, alerts once and moves P1-P4 off it', () => {
    const path = join(tempDir('z08-b4'), 'rpc-usage.db');
    const l = openUsageLedger(path);
    const start = Date.UTC(2026, 9, 1);
    for (let h = 0; h < 14 * 24; h += 1) {                                // 14 days at 87,000 credits an hour
      assert.equal(l.reserve({ provider: 'helius', consumer: 'engine', units: 87_000, atMs: start + h * HOUR_MS, accountCap: 50_000_000, consumerCap: 50_000_000 }), 'ok');
    }
    l.close();
    const m = meterOn(path);
    m.set(start + 14 * DAY_MS);
    assert.equal(m.meter.projectedOver80('helius'), true);
    assert.equal(m.meter.projectedOver80('helius'), true);                 // cached
    m.set(start + 14 * DAY_MS + PROJECTION_CACHE_MS);
    assert.equal(m.meter.projectedOver80('helius'), true);                 // re-read, still over: alerted once per episode
    assert.equal(m.log.events.filter((e) => e.code === 'm14.burn_projection').length, 1);
    const u = m.meter.creditUsage().find((x) => x.provider === 'helius');
    assert.ok(u !== undefined && u.usedThisMonth === 87_000 * 14 * 24 && u.projectedMonthEnd >= 8_000_000);
    assert.equal(m.meter.projectedOver80('chainstack'), false);
    assert.equal(m.meter.projectedOver80('shyft'), false);
  });

  it('the projection is cached for a minute, re-read after it, and an alert clears when the projection falls back', () => {
    const path = join(tempDir('z08-cache'), 'rpc-usage.db');
    const m = meterOn(path, { caps: [{ provider: 'chainstack', accountCap: 1_500_000, consumerCap: 1_450_000 }] });
    assert.equal(m.meter.projectedOver80('chainstack'), false);
    const l = openUsageLedger(path);
    l.reserve({ provider: 'chainstack', consumer: 'engine', units: 1_400_000, atMs: T0, accountCap: 1_500_000, consumerCap: 1_450_000 });
    l.close();
    assert.equal(m.meter.projectedOver80('chainstack'), false);            // still the cached value
    m.set(T0 + PROJECTION_CACHE_MS);
    assert.equal(m.meter.projectedOver80('chainstack'), true);             // 1.4M in 24 h runs far past 2.4M
    m.set(T0 + 3 * DAY_MS);
    // The 1.4M left the last 24 h: 1.4M + 0 × hours left < 2.4M.
    assert.equal(m.meter.projectedOver80('chainstack'), false);
    m.set(T0 + 2 * DAY_MS);                                                 // a clock step back re-reads
    assert.equal(m.meter.projectedOver80('chainstack'), false);
  });

  it('a block size and an alert level outside their ranges are refused', () => {
    const path = join(tempDir('z08-range'), 'rpc-usage.db');
    assert.throws(() => meterOn(path, { blockUnits: 1_001 }), RangeError);
    assert.throws(() => meterOn(path, { blockUnits: 0 }), RangeError);
    assert.throws(() => meterOn(path, { alertBps: 9_501 }), RangeError);
    assert.throws(() => meterOn(path, { alertBps: 4_999 }), RangeError);
  });

  it('the ledger rolls back a failed transaction and stays usable; entries past 62 days are pruned', () => {
    const path = join(tempDir('z08-rollback'), 'rpc-usage.db');
    const l = openUsageLedger(path);
    assert.throws(() => l.reserve({ provider: 'chainstack', consumer: 'engine', units: 0, atMs: T0, accountCap: 10, consumerCap: 10 }));
    assert.equal(l.reserve({ provider: 'chainstack', consumer: 'engine', units: 5, atMs: T0 - 70 * DAY_MS, accountCap: 10, consumerCap: 10 }), 'ok');
    assert.equal(l.reserve({ provider: 'chainstack', consumer: 'engine', units: 10, atMs: T0, accountCap: 10, consumerCap: 100 }), 'ok');
    assert.equal(l.reserve({ provider: 'chainstack', consumer: 'engine', units: 1, atMs: T0, accountCap: 10, consumerCap: 100 }), 'over_account');
    assert.equal(l.reserve({ provider: 'chainstack', consumer: 'other', units: 1, atMs: T0, accountCap: 100, consumerCap: 0 }), 'over_consumer');
    // Read 69 days back: the old 5 was pruned, only the later 10 is left (entries after the read time count: a clock step
    // back never hides use).
    assert.equal(l.totals('chainstack', 'engine', T0 - 69 * DAY_MS).consumerRolling, 10);
    l.close();
  });
});

// ---- gateway wiring ----
type Reply = Result<CallValue<unknown>, RpcError>;
class Client implements RpcClient {
  sent: string[] = [];
  answer: (label: string) => Reply = (label) => ({ ok: true, value: { value: 1, providerLabel: label, latencyMs: 0, contextSlot: 100n as Slot } });
  async request<T>(p: ResolvedProvider, _m: string, _params: readonly unknown[], _o: RequestOptions): Promise<Result<CallValue<T>, RpcError>> {
    this.sent.push(p.config.label);
    return this.answer(p.config.label) as Result<CallValue<T>, RpcError>;
  }
}
const PRIMARY = provider({ label: 'shyft', unmeteredPrimary: true, failoverOrder: 0 });
const BACKUP = provider({ label: 'chainstack', failoverOrder: 1, limits: { rps: 2.5 }, metering: CHAINSTACK });
const reg = (configs: ProviderConfig[]): ProviderRegistry =>
  ({ providers: configs.map((config) => ({ config, url: `https://${config.label}.example.test/` })), disabled: [], warnings: [], liveModesAllowed: true });
const P1: CallOptions = { priority: 1, role: 'read', commitment: 'confirmed', timeoutMs: DEFAULT_TIMEOUT_MS[1] };

function gateway(over: Partial<GatewayDeps>) {
  const time = new FakeTime();
  const client = new Client();
  const log = new RecordingLog();
  const metrics = new RecordingMetrics();
  const gw = createRpcGateway({
    registry: reg([PRIMARY, BACKUP]), context: 'engine', client, clock: time, scheduler: time, log, metrics, stopStore: new MemoryStopStore(),
    overshootBytes: 0, usage: { projectedOver80: () => false }, ...over,
  });
  return { time, client, log, metrics, gw };
}

describe('A-M14-05 gateway wiring', () => {
  it('a ledger refusal is decided before the request: nothing is sent, no stop is counted, a P1 call fails over', async () => {
    const g = gateway({ meter: { take: (p) => p !== 'chainstack' } });
    g.client.answer = (label) => label === 'shyft' ? { ok: false, error: { code: 'E_TIMEOUT', message: 'timeout' } } : { ok: true, value: { value: 1, providerLabel: label, latencyMs: 0, contextSlot: null } };
    const r = await g.gw.call('getSlot', [], { ...P1, provider: 'chainstack' });
    assert.ok(!r.ok && r.error.code === 'E_RATE_LIMITED' && r.error.message === 'credit_cap');
    assert.deepEqual(g.client.sent, []);
    assert.equal(g.metrics.count('rpc_credit_refused_total', { provider: 'chainstack' }), 1);
    assert.equal(g.gw.status().find((s) => s.label === 'chainstack')?.recentLimited, 0);
    g.client.answer = (label) => ({ ok: true, value: { value: 1, providerLabel: label, latencyMs: 0, contextSlot: null } });
    const ok = await g.gw.call('getSlot', [], P1);
    assert.ok(ok.ok && ok.value.providerLabel === 'shyft');
  });

  it('a meter that throws refuses (fail closed); observers that throw never break a call', async () => {
    const g = gateway({
      meter: { take: () => { throw new Error('bug'); } },
      observe: { answer: () => { throw new Error('bug'); }, callEnded: () => { throw new Error('bug'); } },
    });
    const r = await g.gw.call('getSlot', [], { ...P1, provider: 'shyft' });
    assert.ok(!r.ok && r.error.message === 'credit_cap');
    const h = gateway({ observe: { answer: () => { throw new Error('bug'); }, callEnded: () => { throw new Error('bug'); } } });
    assert.ok((await h.gw.call('getSlot', [], P1)).ok);
  });

  it('observe sees every answer and every call end (ok, all_down, other)', async () => {
    const answers: Array<{ provider: string; ok: boolean; rateLimited: boolean; timeout: boolean; contextSlot: Slot | null }> = [];
    const ends: string[] = [];
    const g = gateway({ observe: { answer: (a) => answers.push(a), callEnded: (r) => ends.push(r) } });
    assert.ok((await g.gw.call('getSlot', [], P1)).ok);
    g.client.answer = () => ({ ok: false, error: { code: 'E_TIMEOUT', message: 'timeout' } });
    const down = g.gw.call('getSlot', [], P1);
    await g.time.advance(10_000);
    assert.equal((await down).ok, false);
    assert.equal((await g.gw.call('nope', [], P1)).ok, false);
    assert.deepEqual(ends, ['ok', 'all_down', 'other']);
    assert.deepEqual(answers.map((a) => [a.provider, a.ok, a.timeout, a.contextSlot]), [
      ['shyft', true, false, 100n], ['shyft', false, true, null], ['chainstack', false, true, null],
    ]);
  });

  it('acceptance: the primary down for 61 s → degraded_reads (rpc.mode published, warn); P2 refused; normal again after 60 s of success', async () => {
    const changes: ModeChange[] = [];
    let wall: number = T0;
    const log = new RecordingLog();
    const mon = createProviderMonitor({
      providers: [{ label: 'shyft', role: 'read', unmeteredPrimary: true }, { label: 'chainstack', role: 'read', unmeteredPrimary: false }],
      downAfterMs: 10_000, enterAfterMs: 60_000, exitAfterMs: 60_000, nowMs: () => wall as UnixMs, log, publish: (c) => changes.push(c),
    });
    const g = gateway({ observe: mon.observe, mode: mon.mode });
    g.client.answer = (label) => label === 'shyft' ? { ok: false, error: { code: 'E_HTTP', message: 'http_500', httpStatus: 500 } }
      : { ok: true, value: { value: 1, providerLabel: label, latencyMs: 0, contextSlot: null } };
    for (let s = 0; s <= 61; s += 1) {
      wall = T0 + s * 1_000;
      await g.gw.call('getSlot', [], P1);
      await g.time.advance(1_000);
      mon.tick();
    }
    assert.equal(g.gw.mode(), 'degraded_reads');
    assert.equal(changes[0]?.mode, 'degraded_reads');
    assert.ok(log.events.some((e) => e.level === 'warn' && e.code === 'm14.mode_changed'));
    const p2 = await g.gw.call('getSlot', [], { ...P1, priority: 2 });
    assert.ok(!p2.ok && p2.error.message === 'degraded');
    assert.equal(mon.health(null).find((h) => h.label === 'shyft')?.status, 'down');
    g.client.answer = (label) => ({ ok: true, value: { value: 1, providerLabel: label, latencyMs: 0, contextSlot: null } });
    for (let s = 62; s <= 123; s += 1) {
      wall = T0 + s * 1_000;
      await g.gw.call('getSlot', [], { ...P1, provider: 'shyft' });
      await g.time.advance(1_000);
      mon.tick();
    }
    assert.equal(g.gw.mode(), 'normal');
    assert.equal(changes[1]?.mode, 'normal');
    assert.equal(mon.overall(), 'ok');
  });

  it('acceptance: in the degraded-load model (≈ 1.2 req/s to the metered backup) a 1 h outage keeps the projection under 80%', () => {
    const path = join(tempDir('z08-degraded-load'), 'rpc-usage.db');
    const m = meterOn(path);
    for (let i = 0; i < 1.2 * 3_600; i += 1) {
      m.set(T0 + Math.floor(i / 1.2) * 1_000);
      // the worst case: every degraded read a 2 RU call
      assert.ok(m.meter.take('chainstack', 'getSignaturesForAddress'));
    }
    m.set(T0 + HOUR_MS + PROJECTION_CACHE_MS);
    assert.equal(m.meter.projectedOver80('chainstack'), false);
    const u = m.meter.creditUsage().find((x) => x.provider === 'chainstack');
    assert.ok(u !== undefined && u.projectedMonthEnd < 0.8 * 3_000_000);
    assert.equal(m.log.events.filter((e) => e.code === 'm14.burn_projection').length, 0);
  });
});

describe('A-M14-05 health and mode (health.ts)', () => {
  it('nearest-rank percentiles', () => {
    assert.equal(percentile([], 50), null);
    assert.equal(percentile([5], 99), 5);
    assert.equal(percentile([1, 2, 3, 4], 50), 2);
    assert.equal(percentile([1, 2, 3, 4], 0), 1);
  });

  it('latency, error rate, requests per minute, slot lag and status rules', () => {
    const t = createHealthTracker([{ label: 'a', role: 'read' }, { label: 'b', role: 'read' }], 10_000);
    t.record({ provider: 'zzz', atMs: T0, latencyMs: 1, ok: true, rateLimited: false, contextSlot: null });   // unknown: ignored
    for (let i = 0; i < 100; i += 1) t.record({ provider: 'a', atMs: T0 + i * 100, latencyMs: i + 1, ok: true, rateLimited: false, contextSlot: BigInt(1_000 + i) as Slot });
    let [a, b] = t.health((T0 + 10_000) as UnixMs, 1_105n as Slot, (p) => p === 'a' ? { used: 1, allowance: 2, projected: 3 } : null);
    assert.ok(a !== undefined && b !== undefined);
    assert.deepEqual([a.latencyMsP50, a.latencyMsP95, a.latencyMsP99, a.requestsPerMin, a.errorRateBps, a.slot, a.slotLag, a.status],
      [50, 95, 99, 100, 0, 1_099n, 6, 'ok']);
    assert.deepEqual([a.monthlyUsed, a.monthlyAllowance, a.projectedMonthEnd], [1, 2, 3]);
    assert.deepEqual([b.status, b.latencyMsP50, b.slot, b.slotLag, b.lastOkAtMs, b.monthlyUsed], ['ok', null, null, null, null, null]);
    [a] = t.health((T0 + 10_000) as UnixMs, 1_110n as Slot);
    assert.equal(a?.status, 'degraded');                                   // slot lag 11 > 10
    // 3 errors in 103 → 291 bps > 200: degraded
    for (let i = 0; i < 3; i += 1) t.record({ provider: 'a', atMs: T0 + 10_000 + i, latencyMs: 1, ok: false, rateLimited: false, contextSlot: null });
    [a] = t.health((T0 + 10_010) as UnixMs, null);
    assert.equal(a?.status, 'degraded');
    // 5 consecutive failures → down
    for (let i = 0; i < 2; i += 1) t.record({ provider: 'a', atMs: T0 + 10_020 + i, latencyMs: 1, ok: false, rateLimited: false, contextSlot: null });
    [a] = t.health((T0 + 10_030) as UnixMs, null);
    assert.equal(a?.status, 'down');
    // A 429 alone degrades for 60 s; 10 s of failing attempts with no success is down.
    t.record({ provider: 'b', atMs: T0, latencyMs: 1, ok: false, rateLimited: true, contextSlot: null });
    [, b] = t.health((T0 + 5_000) as UnixMs, null);
    assert.equal(b?.status, 'degraded');
    [, b] = t.health((T0 + 10_000) as UnixMs, null);
    assert.equal(b?.status, 'down');
    t.record({ provider: 'b', atMs: T0 + 10_001, latencyMs: 1, ok: true, rateLimited: false, contextSlot: 5n as Slot });
    t.record({ provider: 'b', atMs: T0 + 10_002, latencyMs: 1, ok: true, rateLimited: false, contextSlot: 4n as Slot });
    [, b] = t.health((T0 + 10_002 + 300_000) as UnixMs, 3n as Slot);       // window over; slot never below the highest seen
    assert.deepEqual([b?.status, b?.errorRateBps, b?.requestsPerMin, b?.slot, b?.slotLag, b?.lastOkAtMs], ['ok', 0, 0, 5n, 0, T0 + 10_002]);
    [, b] = t.health((T0 + 10_002) as UnixMs, 9_000_000n as Slot);
    assert.equal(b?.slotLag, 1_000_000);                                   // a huge gap is capped as a number
  });

  it('logic 5: E_ALL_PROVIDERS_DOWN for 10 s → overall down (critical, once); a success ends it', () => {
    const log = new RecordingLog();
    const m = createModeMachine({ enterAfterMs: 60_000, exitAfterMs: 60_000, log, publish: () => undefined });
    m.callEnded(T0, 'other');
    m.callEnded(T0, 'all_down');
    m.tick((T0 + ALL_DOWN_AFTER_MS - 1) as UnixMs);
    assert.equal(m.overall(), 'ok');
    m.tick((T0 + ALL_DOWN_AFTER_MS) as UnixMs);
    m.callEnded((T0 + ALL_DOWN_AFTER_MS + 1) as UnixMs, 'all_down');
    assert.equal(m.overall(), 'down');
    assert.equal(log.events.filter((e) => e.code === 'm14.all_providers_down' && e.level === 'critical').length, 1);
    m.callEnded((T0 + 20_000) as UnixMs, 'ok');
    assert.equal(m.overall(), 'ok');
    m.callEnded((T0 + 20_001) as UnixMs, 'ok');
    assert.equal(log.events.filter((e) => e.code === 'm14.providers_recovered').length, 1);
  });

  it('a failure during the recovery minute restarts it; a clock step back changes nothing', () => {
    const changes: ModeChange[] = [];
    const m = createModeMachine({ enterAfterMs: 60_000, exitAfterMs: 60_000, log: new RecordingLog(), publish: (c) => changes.push(c) });
    m.primaryAnswer(T0, false);
    m.tick((T0 - 5_000) as UnixMs);
    m.tick((T0 + 60_000) as UnixMs);
    assert.equal(m.mode(), 'degraded_reads');
    m.primaryAnswer((T0 + 61_000) as UnixMs, true);
    m.primaryAnswer((T0 + 100_000) as UnixMs, false);
    m.primaryAnswer((T0 + 101_000) as UnixMs, true);
    m.tick((T0 + 125_000) as UnixMs);
    assert.equal(m.mode(), 'degraded_reads');                              // 24 s of success since the failure
    m.tick((T0 + 161_000) as UnixMs);
    assert.equal(m.mode(), 'normal');
    assert.deepEqual(changes.map((c) => [c.mode, c.since - T0]), [['degraded_reads', 60_000], ['normal', 161_000]]);
  });
});
