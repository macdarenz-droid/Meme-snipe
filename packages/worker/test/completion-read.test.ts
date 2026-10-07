// COMPLETION-READ: on today's mainnet the migration transaction carries no CompleteEvent; it is in the completing buy,
// a separate transaction on the bonding curve just before. A fetched migration whose completion was not seen reads the
// curve's signatures before it once (P2, fill budget) and puts the completion on the feed at confirmed, so the
// migration fact forms and H7 passes. No budget or a failed read leaves the fact missing (H16), never invented.
// Real public mainnet transactions (test/fixtures/completion-read.json).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { recordFromRpc, transactionEvents, type RpcTransactionBase64 } from '../../core/src/chain/index.ts';
import type { MarketEvent, StrategyContext } from '../../core/src/engine/index.ts';
import { evaluateHardRejects, migrationKey, type GateContext, type GateRequest, type HardResult } from '../../core/src/gates/index.ts';
import type { MicroUsd, Lamports } from '../../core/src/units/index.ts';
import { RESEARCH_CONFIG } from '../../core/src/config/index.ts';
import { STUDY_CONFIG } from '../../backtest/src/strategy/config.ts';
import { COMPLETION_CREDITS, REREAD_CREDITS_PER_DAY } from '../src/run/worker.ts';
import { fetchCapsFile } from '../src/run/state.ts';
import { Market, makeWorker, tempState, virtualTimers } from './worker-harness.ts';

interface Fixture {
  readonly meta: { readonly mint: string; readonly bondingCurve: string };
  readonly migration: { readonly signature: string; readonly rpc: RpcTransactionBase64 };
  readonly curveSignaturesBeforeMigration: readonly { readonly signature: string; readonly slot: number; readonly err: unknown; readonly blockTime: number | null }[];
  readonly complete: { readonly signature: string; readonly rpc: RpcTransactionBase64 };
}
const FIX = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'completion-read.json'), 'utf8')) as Fixture;
const migrate = recordFromRpc(FIX.migration.signature, FIX.migration.rpc);
const complete = recordFromRpc(FIX.complete.signature, FIX.complete.rpc);
const MINT = FIX.meta.mint;
const CURVE = FIX.meta.bondingCurve;
const AT = (migrate.blockTime ?? 0) * 1000;
/** One slot every 400 ms, the migration's slot at its block time. */
const slotFor = (ms: number): bigint => migrate.slot + BigInt(Math.floor((ms - AT) / 400));

let port = 19_400;

type Rpc = { getSignaturesForAddress: (a: string, o: { before?: string; limit?: number }) => Promise<unknown[]>; getTransaction: (s: string) => Promise<unknown> };

/** H7 alone, as of an event's moment, from the facts the worker's engine sees. */
const h7 = (ctx: StrategyContext): HardResult => {
  const req = { mint: MINT, universe: 'U2', notional: 1_000_000n as MicroUsd, spend: 1_000_000n as Lamports, roundTrip: { ok: false, reason: 'not read' } } as unknown as GateRequest;
  return evaluateHardRejects(ctx as unknown as GateContext, { session: h7Session!, mode: 'live' }, req, { only: ['H7'], stopAtFirst: false });
};
let h7Session: Parameters<typeof evaluateHardRejects>[1]['session'] | null = null;

/** A worker on the live path: the migration transaction arrives as the migration watch's fetch puts it on the feed. */
const run = async (rpc: Rpc, left0: number, o: { readonly reads?: boolean; readonly window?: boolean } = {}) => {
  let left = left0;
  const budget = { remaining: () => left, spend: (c: number) => { left -= c; }, refund: (c: number) => { left += c; } };
  const timers = virtualTimers(AT - 30_000);
  // COMPLETION-READ alone: FACTS-REREAD's own budget is spent for the day, so no re-read adds to these reads (its tests
  // are in facts-reread.test.ts).
  const stateDir = tempState();
  fetchCapsFile(stateDir).write({ day: Math.floor(timers.now() / 86_400_000), cutCreate: 0, cutTrade: 0, reread: REREAD_CREDITS_PER_DAY });
  const h = makeWorker({ stateDir, timers, config: { ZEROED_HEALTH_ADDR: `127.0.0.1:${port++}`, ZEROED_API_ADDR: `127.0.0.1:${port++}` }, ...(o.reads === false ? {} : { restartReads: { rpc: rpc as never, budget } }) });
  h7Session = h.session;
  // Every event the engine hands the strategy: H7 judged as of it, and whether the migration fact was there.
  const judged: { readonly key: string; readonly migration: boolean; readonly h7: HardResult }[] = [];
  const s = h.worker.strategy as unknown as { onMarket: (e: MarketEvent, ctx: StrategyContext) => unknown };
  const onMarket = s.onMarket.bind(s);
  s.onMarket = (e, ctx) => {
    judged.push({ key: e.key, migration: ctx.lookup(migrationKey(MINT)).ok, h7: h7(ctx) });
    return onMarket(e, ctx);
  };
  const m = new Market(h);
  const tick = () => {
    m.slot(slotFor(m.now));
    m.solPrice();
  };
  const started = h.worker.start();
  while (!h.order.includes('start helius-ws')) await new Promise<void>((r) => setImmediate(r));
  tick();
  m.offchain('coverage:creates:start', { fromSlot: slotFor(m.now), via: 'logs:TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM' });
  expect(await started).toEqual({ ok: true });
  m.offchain('feed:status:helius', { state: 'up' });
  m.offchain('feed:status:coinbase', { state: 'up' });
  await m.run(20_000, 400, tick);
  // The migration authority's logs watch fetches the migration at confirmed (sources.ts: fetch P2), as a lookup.
  h.worker.feed.ingest('helius', { type: 'tx', record: migrate }, { receivedAt: m.now, lookup: true });
  await m.run(20_000, 400, tick);
  // Into the candidate's window (an hour after its migration), where the strategy evaluates it again and again.
  if (o.window === true) await m.run(RESEARCH_CONFIG.s0.u2WindowFromMs + 5 * 60_000, 5_000, tick);
  const last = judged.at(-1)!;
  await h.worker.stop();
  return { h, judged, last, left: () => left };
};

const asking = () => {
  const asked: string[] = [];
  const rpc: Rpc = {
    getSignaturesForAddress: async (address, o) => {
      asked.push(`sigs ${address} before ${o.before ?? ''}`);
      return address === CURVE && o.before === migrate.signature ? FIX.curveSignaturesBeforeMigration.map((x) => ({ ...x, slot: BigInt(x.slot) })) : [];
    },
    getTransaction: async (sig) => {
      asked.push(`tx ${sig}`);
      return sig === complete.signature ? complete : null;
    },
  };
  return { asked, rpc };
};

/** The strategy's evaluations of the coin (its reject decisions), from the journal. */
const evaluations = (dir: string): number => readFileSync(join(dir, 'journal.jsonl'), 'utf8').split('\n').filter((l) => l !== '')
  .map((l) => JSON.parse(l) as { kind: string; reasons?: string[] }).filter((l) => l.kind === 'decision' && l.reasons?.[0] === 'reject' && l.reasons[2] === MINT).length;

const missingCurve = (r: HardResult) => r.reasons.some((x) => x.gate === 'H16' && x.code === 'missing' && x.input === 'curve' && x.neededBy === 'H7');

describe('COMPLETION-READ: a live graduate reads its completing buy, so the migration fact forms', () => {
  it('the fixture is today\'s mainnet shape: the migration carries no CompleteEvent; the newest curve signature before it does', () => {
    const evs = transactionEvents(migrate);
    expect(evs.some((e) => e.name === 'CompletePumpAmmMigrationEvent' && 'mint' in e.data && e.data.mint === MINT)).toBe(true);
    expect(evs.some((e) => e.name === 'CompleteEvent')).toBe(false);
    expect(FIX.curveSignaturesBeforeMigration[0]!.signature).toBe(complete.signature);
    expect(transactionEvents(complete).some((e) => e.name === 'CompleteEvent' && 'mint' in e.data && e.data.mint === MINT)).toBe(true);
    expect(COMPLETION_CREDITS).toBe(6);
  });

  it('(i) a live migration triggers one curve-signatures read, the migration fact appears, then H7 passes', async () => {
    const { asked, rpc } = asking();
    const r = await run(rpc, 1_000);
    expect(asked).toEqual([`sigs ${CURVE} before ${migrate.signature}`, `tx ${complete.signature}`]);
    // Charged 2 of the 6 reserved; the rest refunded.
    expect(r.left()).toBe(998);
    const first = r.judged.findIndex((j) => j.migration);
    expect(first).toBeGreaterThan(-1);
    // Before the completion landed, H7 waited on a missing curve (H16); after it, H7 passes and stays passed.
    expect(r.judged.slice(0, first).some((j) => missingCurve(j.h7))).toBe(true);
    for (const j of r.judged.slice(first)) expect(j.h7).toEqual(expect.objectContaining({ passed: ['H7'], failed: [], reasons: [] }));
  }, 60_000);

  it('(iii) the fill budget spent: nothing is read, and H7 stays H16 missing curve (no completion invented)', async () => {
    const { asked, rpc } = asking();
    const r = await run(rpc, COMPLETION_CREDITS - 1);
    expect(asked).toEqual([]);
    expect(r.left()).toBe(COMPLETION_CREDITS - 1);
    expect(r.h.logs).toContain(`Curve completion of ${MINT} not read: the fill budget is spent; H7 waits for it.`);
    expect(r.judged.some((j) => j.migration)).toBe(false);
    expect(missingCurve(r.last.h7)).toBe(true);
  }, 60_000);

  it.each([
    ['the signatures read fails', (rpc: Rpc): Rpc => ({ ...rpc, getSignaturesForAddress: async () => { throw new Error('timeout'); } })],
    ['the transaction is not found', (rpc: Rpc): Rpc => ({ ...rpc, getTransaction: async () => null })],
  ])('(iii) %s: the fact stays missing (H16), and the read is not repeated on later evaluations', async (_, change) => {
    const { asked, rpc } = asking();
    const calls: string[] = [];
    const base = change(rpc);
    const counted: Rpc = {
      getSignaturesForAddress: async (a, o) => (calls.push('sigs'), base.getSignaturesForAddress(a, o)),
      getTransaction: async (s) => (calls.push('tx'), base.getTransaction(s)),
    };
    const r = await run(counted, 1_000, { window: true });
    void asked;
    expect(calls.filter((c) => c === 'sigs')).toEqual(['sigs']);
    // An hour and more of steps and released events, the coin evaluated in its window: still the one read.
    expect(r.judged.length).toBeGreaterThan(500);
    expect(evaluations(r.h.stateDir)).toBeGreaterThan(0);
    expect(r.judged.some((j) => j.migration)).toBe(false);
    expect(missingCurve(r.last.h7)).toBe(true);
  }, 60_000);

  it('(iii) without reads configured nothing is read and the fact stays missing', async () => {
    const { asked, rpc } = asking();
    const r = await run(rpc, 1_000, { reads: false });
    expect(asked).toEqual([]);
    expect(missingCurve(r.last.h7)).toBe(true);
  }, 60_000);

  it('backtest parity: no decision falls between the completion and the moment the live read lands', () => {
    // The backtest (sim/facts.ts snapshot) and the study see the completion in chain order, before the migration; live
    // sees it a read after the migration's fetch (seconds). Both form the migration fact before any decision only
    // because every decision window opens long after the migration: live U2 and every study universe, an hour or more.
    const HOUR = 3_600_000;
    expect(RESEARCH_CONFIG.s0.u2WindowFromMs).toBeGreaterThanOrEqual(HOUR);
    for (const u of STUDY_CONFIG.universes) expect(u.window.fromMs, u.universe).toBeGreaterThanOrEqual(HOUR);
  });
});
