// RED TEAM C round 2: planted-future-marker probe for FACTS-REREAD (worker.ts #rereads/#completionWaits, PR #263).
// The re-read chain fetches a candidate's migration and curve completion after the fact and puts them on the live feed.
// A leak would be any decision the engine makes before the fetched answer arrives depending on it: the transactions
// back-dated to their own (older) chain slot ahead of decisions already made, or a decision before the answer seeing
// the migration or curve fact. The probe runs the worker twice on the same market: once with the RPC answering
// (the plant: the fetched completion and migration), once with every RPC read failing (no plant). Before the moment the
// RPC answered, every decision's H7/H10 verdict and every migration/curve/candles read must be the same in both runs;
// the fetched transactions' events must never reach the engine before that moment; and in the answering run the
// facts must form only after it (the plant is real). Real public mainnet transactions (test/fixtures/completion-read.json).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { recordFromRpc, type RpcTransactionBase64 } from '../../../core/src/chain/index.ts';
import type { MarketEvent, StrategyContext } from '../../../core/src/engine/index.ts';
import { candlesKey, curveKey, evaluateHardRejects, migrationKey, type GateContext, type GateRequest, type HardResult } from '../../../core/src/gates/index.ts';
import type { MicroUsd, Lamports } from '../../../core/src/units/index.ts';
import { COMPLETION_CREDITS } from '../../src/run/worker.ts';
import { PUMP_MIGRATION_AUTHORITY as MIGRATION_AUTHORITY } from '../../src/run/sources.ts';
import { Market, makeWorker, tempState, virtualTimers } from '../worker-harness.ts';
import { blockNetwork } from '../helpers.ts';

blockNetwork();

interface Fixture {
  readonly meta: { readonly mint: string; readonly bondingCurve: string };
  readonly migration: { readonly signature: string; readonly rpc: RpcTransactionBase64 };
  readonly curveSignaturesBeforeMigration: readonly { readonly signature: string; readonly slot: number; readonly err: unknown; readonly blockTime: number | null }[];
  readonly complete: { readonly signature: string; readonly rpc: RpcTransactionBase64 };
}
const FIX = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'fixtures', 'completion-read.json'), 'utf8')) as Fixture;
const migrate = recordFromRpc(FIX.migration.signature, FIX.migration.rpc);
const complete = recordFromRpc(FIX.complete.signature, FIX.complete.rpc);
const MINT = FIX.meta.mint;
const CURVE = FIX.meta.bondingCurve;
const AT = (migrate.blockTime ?? 0) * 1000;
const slotFor = (ms: number): bigint => migrate.slot + BigInt(Math.floor((ms - AT) / 400));
let port = 19_900;

type Rpc = { getSignaturesForAddress: (a: string, o: { before?: string; limit?: number }) => Promise<unknown[]>; getTransaction: (s: string) => Promise<unknown> };

/** The curve as mainnet answers after the migration; `answers` false: every read throws (the re-read never lands). */
const curveRpc = (answers: boolean, now: () => number) => {
  let answeredAt: number | null = null;
  const rpc: Rpc = {
    getSignaturesForAddress: async (address, o) => {
      if (!answers) throw new Error('timeout');
      if (address === CURVE && o.before === undefined) {
        return [{ signature: migrate.signature, slot: migrate.slot, err: null, blockTime: migrate.blockTime }, ...FIX.curveSignaturesBeforeMigration.map((x) => ({ ...x, slot: BigInt(x.slot) }))];
      }
      return address === CURVE && o.before === migrate.signature ? FIX.curveSignaturesBeforeMigration.map((x) => ({ ...x, slot: BigInt(x.slot) })) : [];
    },
    getTransaction: async (sig) => {
      if (!answers) throw new Error('timeout');
      answeredAt ??= now();
      return sig === complete.signature ? complete : sig === migrate.signature ? migrate : null;
    },
  };
  return { rpc, answeredAt: () => answeredAt };
};

interface Judged {
  readonly at: number;
  readonly slot: bigint;
  readonly eventId: string;
  readonly view: string;
  readonly migration: boolean;
}

let session: Parameters<typeof evaluateHardRejects>[1]['session'] | null = null;
const judge = (ctx: StrategyContext): HardResult => {
  const req = { mint: MINT, universe: 'U2', notional: 1_000_000n as MicroUsd, spend: 1_000_000n as Lamports, roundTrip: { ok: false, reason: 'not read' } } as unknown as GateRequest;
  return evaluateHardRejects(ctx as unknown as GateContext, { session: session!, mode: 'live' }, req, { only: ['H7', 'H10'], stopAtFirst: false });
};
const show = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? `${x}n` : x));

/** Scenario (b) of facts-reread.test.ts: the migration watch saw the log at processed and its fetch failed. */
const run = async (answers: boolean, mode: 'fetch-failed' | 'fill-budget' = 'fetch-failed') => {
  let left = COMPLETION_CREDITS - 1;
  const budget = { remaining: () => left, spend: (c: number) => { left -= c; }, refund: (c: number) => { left += c; } };
  const timers = virtualTimers(AT - 30_000);
  const r = curveRpc(answers, () => timers.now());
  const h = makeWorker({ stateDir: tempState(), timers, config: { ZEROED_HEALTH_ADDR: `127.0.0.1:${port++}`, ZEROED_API_ADDR: `127.0.0.1:${port++}` }, restartReads: { rpc: r.rpc as never, budget } });
  session = h.session;
  const judged: Judged[] = [];
  const fetched: { at: number; id: string }[] = [];
  const s = h.worker.strategy as unknown as { onMarket: (e: MarketEvent, ctx: StrategyContext) => unknown };
  const onMarket = s.onMarket.bind(s);
  s.onMarket = (e, ctx) => {
    if (e.id.includes(complete.signature) || (mode === 'fetch-failed' && e.id.includes(migrate.signature) && e.id.startsWith('ev:'))) fetched.push({ at: ctx.now.receivedAt, id: e.id });
    const reads = [migrationKey(MINT), curveKey(MINT), candlesKey(MINT)].map((k) => {
      const x = ctx.lookup(k);
      return x.ok ? show(x.value) : `!${x.reason}`;
    });
    const j = judge(ctx);
    judged.push({ at: ctx.now.receivedAt, slot: ctx.now.slot, eventId: e.id, view: `${show(j.reasons)} ${show(j.passed)} ${reads.join(' | ')}`, migration: ctx.lookup(migrationKey(MINT)).ok });
    return onMarket(e, ctx);
  };
  const m = new Market(h);
  const tick = () => {
    m.slot(slotFor(m.now));
    m.solPrice();
  };
  const started = h.worker.start();
  while (!h.order.includes('start helius-ws')) await new Promise<void>((res) => setImmediate(res));
  tick();
  m.offchain('coverage:creates:start', { fromSlot: slotFor(m.now), via: 'logs:TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM' });
  expect(await started).toEqual({ ok: true });
  m.offchain('feed:status:helius', { state: 'up' });
  m.offchain('feed:status:coinbase', { state: 'up' });
  await m.run(20_000, 400, tick);
  if (mode === 'fill-budget') {
    // The migration fetched live; COMPLETION-READ finds the fills' budget spent and hands the curve to the re-read
    // chain (#completionWaits / #rereadFacts 'fill-budget').
    h.worker.feed.ingest('helius', { type: 'tx', record: migrate }, { receivedAt: m.now, lookup: true });
  } else {
    h.worker.feed.ingest('helius', { type: 'logs', signature: migrate.signature, slot: migrate.slot, err: null, via: `logs:${MIGRATION_AUTHORITY}`, logs: [...migrate.logMessages!] }, { receivedAt: m.now });
    await m.run(2_000, 400, tick);
    h.worker.feed.ingest('worker', { type: 'offchain', key: 'feed:status:helius', value: { state: 'fetch_failed', signature: migrate.signature } }, { receivedAt: m.now });
  }
  await m.run(30_000, 400, tick);
  await h.worker.stop();
  return { judged, fetched, answeredAt: r.answeredAt() };
};

describe('RED TEAM C: FACTS-REREAD re-read chains never reach a decision before their answer arrives', () => {
  for (const mode of ['fetch-failed', 'fill-budget'] as const) it(`(${mode}) decisions before the RPC answered are the same with and without the answer; the fetched facts form only after it`, async () => {
    const landed = await run(true, mode);
    const never = await run(false, mode);
    const T = landed.answeredAt;
    expect(T).not.toBeNull();
    // The plant is real: the fetched transactions reached the engine and the migration fact formed.
    expect(landed.fetched.length).toBeGreaterThan(0);
    expect(landed.judged.some((j) => j.migration)).toBe(true);
    expect(never.judged.some((j) => j.migration)).toBe(false);
    // The migration fact forms only from the answer on.
    for (const j of landed.judged) if (j.migration) expect(j.at).toBeGreaterThanOrEqual(T!);
    expect(landed.judged.at(-1)!.view).not.toBe(never.judged.at(-1)!.view);
    // No fetched transaction's event reached the engine before the answer (never back-dated ahead of decisions made).
    for (const f of landed.fetched) expect(f.at).toBeGreaterThanOrEqual(T!);
    // Every decision made before the answer is identical to the run where it never came.
    const before = (js: readonly Judged[]) => js.filter((j) => j.at < T!).map((j) => `${j.at} ${j.slot} ${j.eventId} ${j.view}`);
    const a = before(landed.judged);
    const b = before(never.judged);
    expect(a.length).toBeGreaterThan(10);
    expect(a).toEqual(b);
    // And the engine's clock never moved back: each decision's slot is at or after the previous one's.
    for (let i = 1; i < landed.judged.length; i++) expect(landed.judged[i]!.slot >= landed.judged[i - 1]!.slot).toBe(true);
    // The fetched migration and completion carry chain slots older than the decisions they reach: their events are
    // placed at the open slot (off-chain arrival), not at their own slots.
    const firstFetched = landed.judged.find((j) => j.eventId.includes(complete.signature))!;
    expect(firstFetched.slot).toBeGreaterThan(complete.slot);
  }, 120_000);
});
