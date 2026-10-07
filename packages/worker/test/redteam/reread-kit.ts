// RED TEAM A: a trimmed copy of facts-reread.test.ts's `run` helper (real mainnet migration and completing buy from
// test/fixtures/completion-read.json), so the red-team probes drive the same live worker path.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';
import { recordFromRpc, type RpcTransactionBase64 } from '../../../core/src/chain/index.ts';
import type { MarketEvent, StrategyContext } from '../../../core/src/engine/index.ts';
import { candlesKey, evaluateHardRejects, migrationKey, type GateContext, type GateRequest, type HardResult } from '../../../core/src/gates/index.ts';
import type { MicroUsd, Lamports } from '../../../core/src/units/index.ts';
import { RESEARCH_CONFIG } from '../../../core/src/config/index.ts';
import { COMPLETION_CREDITS, type WorkerDeps } from '../../src/run/worker.ts';
import { fetchCapsFile } from '../../src/run/state.ts';
import { type Harness, Market, makeWorker, tempState, virtualTimers } from '../worker-harness.ts';
import { PUMP_MIGRATION_AUTHORITY as MIGRATION_AUTHORITY } from '../../src/run/sources.ts';

interface Fixture {
  readonly meta: { readonly mint: string; readonly bondingCurve: string };
  readonly migration: { readonly signature: string; readonly rpc: RpcTransactionBase64 };
  readonly curveSignaturesBeforeMigration: readonly { readonly signature: string; readonly slot: number; readonly err: unknown; readonly blockTime: number | null }[];
  readonly complete: { readonly signature: string; readonly rpc: RpcTransactionBase64 };
}
export const FIX = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'fixtures', 'completion-read.json'), 'utf8')) as Fixture;
export const migrate = recordFromRpc(FIX.migration.signature, FIX.migration.rpc);
export const complete = recordFromRpc(FIX.complete.signature, FIX.complete.rpc);
export const MINT = FIX.meta.mint;
export const CURVE = FIX.meta.bondingCurve;
export const AT = (migrate.blockTime ?? 0) * 1000;
export const DAY_MS = 86_400_000;
export const slotFor = (ms: number): bigint => migrate.slot + BigInt(Math.floor((ms - AT) / 400));

let port = 23_700 + Math.floor(Math.random() * 2_000) * 2;

export type Rpc = { getSignaturesForAddress: (a: string, o: { before?: string; limit?: number }) => Promise<unknown[]>; getTransaction: (s: string) => Promise<unknown> };

let session: Parameters<typeof evaluateHardRejects>[1]['session'] | null = null;
const judge = (ctx: StrategyContext): HardResult => {
  const req = { mint: MINT, universe: 'U2', notional: 1_000_000n as MicroUsd, spend: 1_000_000n as Lamports, roundTrip: { ok: false, reason: 'not read' } } as unknown as GateRequest;
  return evaluateHardRejects(ctx as unknown as GateContext, { session: session!, mode: 'live' }, req, { only: ['H7', 'H10'], stopAtFirst: false });
};
export const missingMigration = (r: HardResult) => r.reasons.some((x) => x.gate === 'H16' && x.code === 'missing' && (x.input === 'curve' || x.input === 'migration'));

export const run = async (rpc: Rpc, o: { readonly reread?: number | null; readonly stateDir?: string; readonly window?: boolean; readonly logsOnly?: boolean; readonly timers?: ReturnType<typeof virtualTimers>; readonly noMigration?: boolean; readonly runMs?: number; readonly findCreate?: WorkerDeps['findCreate']; readonly fill?: number; readonly found?: (sig: string, why: string, h: Harness) => boolean; readonly after?: (h: Harness, m: Market, tick: () => void) => Promise<void>; readonly beforeLand?: (h: Harness, m: Market, tick: () => void) => Promise<void>; readonly budget?: { remaining(nowMs: number): number; spend(credits: number, nowMs: number): void; refund(credits: number, nowMs: number): void } } = {}) => {
  let left = o.fill ?? COMPLETION_CREDITS - 1;
  const budget = o.budget ?? { remaining: () => left, spend: (c: number) => { left -= c; }, refund: (c: number) => { left += c; } };
  const timers = o.timers ?? virtualTimers(AT - 30_000);
  const stateDir = o.stateDir ?? tempState();
  if (o.reread !== undefined && o.reread !== null) fetchCapsFile(stateDir).write({ day: Math.floor(timers.now() / DAY_MS), cutCreate: 0, cutTrade: 0, reread: o.reread });
  let ref: Harness | null = null;
  const h = makeWorker({ ...(o.found === undefined ? {} : { found: (sig: string, why: string) => o.found!(sig, why, ref!) }), stateDir, timers, config: { ZEROED_HEALTH_ADDR: `127.0.0.1:${port++}`, ZEROED_API_ADDR: `127.0.0.1:${port++}` }, restartReads: { rpc: rpc as never, budget }, ...(o.findCreate === undefined ? {} : { findCreate: o.findCreate }) });
  ref = h;
  session = h.session;
  const judged: { readonly at: number; readonly migration: boolean; readonly r: HardResult; readonly candles: unknown }[] = [];
  const s = h.worker.strategy as unknown as { onMarket: (e: MarketEvent, ctx: StrategyContext) => unknown };
  const onMarket = s.onMarket.bind(s);
  s.onMarket = (e, ctx) => {
    const c = ctx.lookup(candlesKey(MINT));
    judged.push({ at: ctx.now.receivedAt, migration: ctx.lookup(migrationKey(MINT)).ok, r: judge(ctx), candles: c.ok ? c.value : null });
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
  if (o.noMigration === true) {
    // restored process
  } else if (o.logsOnly === true) {
    h.worker.feed.ingest('helius', { type: 'logs', signature: migrate.signature, slot: migrate.slot, err: null, via: `logs:${MIGRATION_AUTHORITY}`, logs: [...migrate.logMessages!] }, { receivedAt: m.now });
    await m.run(2_000, 400, tick);
    h.worker.feed.ingest('worker', { type: 'offchain', key: 'feed:status:helius', value: { state: 'fetch_failed', signature: migrate.signature } }, { receivedAt: m.now });
    if (o.beforeLand !== undefined) await o.beforeLand(h, m, tick);
  } else {
    h.worker.feed.ingest('helius', { type: 'tx', record: migrate }, { receivedAt: m.now, lookup: true });
    if (o.beforeLand !== undefined) await o.beforeLand(h, m, tick);
  }
  await m.run(20_000, 400, tick);
  if (o.runMs !== undefined) await m.run(o.runMs, 5_000, tick);
  else if (o.window !== false) await m.run(RESEARCH_CONFIG.s0.u2WindowFromMs + 40 * 60_000, 5_000, tick);
  if (o.after !== undefined) await o.after(h, m, tick);
  const last = judged.at(-1)!;
  await h.worker.stop();
  let caps: { readonly reread?: number; readonly day?: number; readonly cutCreate?: number; readonly cutTrade?: number } = {};
  try {
    caps = fetchCapsFile(stateDir).read({ day: -1, cutCreate: 0, cutTrade: 0, reread: 0 });
  } catch {
    // unreadable
  }
  const rereads = readFileSync(join(stateDir, 'journal.jsonl'), 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l['kind'] === 'facts_reread');
  return { h, judged, last, fillLeft: () => left, caps, rereads };
};
