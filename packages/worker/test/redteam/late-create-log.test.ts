// RED TEAM A, probe RT-A3: a creates-watch log that reaches the live feed after its slot was released is lost from the
// deployer index with no hole, so H14 counts the deployer's mints without it while its creates coverage reads whole.
//
// LiveStrategy feeds the deployer index from `onMarket` (strategy.ts:1017), which the engine calls only for events it
// accepts. A late log frame (live-feed.ts:255) is released out of the total order and refused (engine.ts:165): its
// CreateEvent never reaches the index, and since the log was not cut, nothing records a hole (`lostCreate` is null) and
// no coverage gap is written. H14's serial-deployer rule (`recent.size > serialMaxMints24h`) and its prior-rug rule
// then judge a creator with a mint missing. The backtest's index sees every create (dataset rows): live != backtest.
// The same holds for a late cut creates log: its `logs:truncated:` hole is refused too, so `lostCreate` never names it.
//
// LATE-LOG: a late frame is placed off-chain (`late: true`) and released in order; the index dates a create by its chain
// time, so the late run ends with the on-time run's index and coverage, and a late cut log's hole is kept.
import { describe, expect, it } from 'vitest';
import { CreateEventLayout, PUMP_PROGRAM, encodeBase58, toBase64 } from '../../../core/src/chain/index.ts';
import { startSession, TRIAL_POLICY } from '../../../core/src/config/index.ts';
import { Engine, type MarketEvent, type Moment, type Strategy, type StrategyContext } from '../../../core/src/engine/index.ts';
import { DeployerIndex, createsCoverage } from '../../../core/src/gates/index.ts';
import { CONFIG } from '../../../core/test/fixtures.ts';
import { encode } from '../../../core/test/chain/encode.ts';
import { DEFAULT_LIVE_FEED, LiveFeed } from '../../src/providers/index.ts';
import { engineFeed } from '../../src/run/engine-feed.ts';

const session = startSession(TRIAL_POLICY);
const addr = (n: number): string => encodeBase58(Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? n : 21 + i)));
const CREATOR = addr(9);
const VIA = 'logs:TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM';
const S0 = 400_000_000n;
const T0 = 1_791_100_000_000;
const at = (slot: bigint): number => T0 + Number(slot - S0) * 400;

const createLog = (mint: string, slot: bigint): string[] => {
  const data = {
    name: 'X', symbol: 'X', uri: 'u', mint, bondingCurve: addr(50), user: CREATOR, creator: CREATOR, timestamp: BigInt(Math.floor(at(slot) / 1000)),
    virtualTokenReserves: 1n, virtualSolReserves: 1n, realTokenReserves: 1n, tokenTotalSupply: 1n, tokenProgram: addr(51), isMayhemMode: false,
    isCashbackEnabled: false, quoteMint: addr(52), virtualQuoteReserves: 0n, creatorFeeBps: 0n, isHolderReward: false,
  };
  const l = CreateEventLayout;
  const bytes = Uint8Array.from([...l.discriminator, ...encode([...l.base, ...l.added] as unknown as readonly (readonly [string, { idl: unknown }])[], data)]);
  return [`Program ${PUMP_PROGRAM} invoke [1]`, `Program data: ${toBase64(bytes)}`, `Program ${PUMP_PROGRAM} success`];
};

const run = (late: boolean, cut = false) => {
  const feed = new LiveFeed({ ...DEFAULT_LIVE_FEED });
  const index = new DeployerIndex();
  let last: StrategyContext | null = null;
  // As LiveStrategy `#observe`: every event the engine hands the strategy feeds the index.
  const strategy: Strategy = { onMarket: (e: MarketEvent, ctx: StrategyContext) => { index.observe(e); last = ctx; return []; } };
  const engine = new Engine({ clock: feed.clock, feed: engineFeed(feed, session.policy).feed, strategy, runner: { run: () => {} }, seed: 's', book: CONFIG });
  const slot = (s: bigint, ms = at(s)): void => {
    feed.ingest('helius', { type: 'slot', slot: s, parent: s - 1n, root: null }, { receivedAt: ms });
    feed.advance(ms);
    engine.drain();
  };
  const log = (sig: string, s: bigint, mint: string, ms: number) =>
    feed.ingest('helius', { type: 'logs', signature: sig, slot: s, err: null, via: VIA, logs: cut ? [...createLog(mint, s).slice(0, 2), 'Log truncated'] : createLog(mint, s) }, { receivedAt: ms });
  let faults = 0;
  slot(S0 - 1n);
  feed.ingest('helius', { type: 'fact', key: 'coverage:creates:start', value: { fromSlot: S0, via: VIA } }, { receivedAt: at(S0 - 1n) + 1 });
  slot(S0);
  log('create1', S0 + 1n, addr(1), at(S0 + 1n) + 100);
  slot(S0 + 1n);
  slot(S0 + 2n);
  if (!late) log('create2', S0 + 3n, addr(2), at(S0 + 3n) + 100);
  for (let s = S0 + 3n; s <= S0 + 6n; s++) slot(s);
  if (late) {
    const f = log('create2', S0 + 3n, addr(2), at(S0 + 6n) + 100);
    expect(f.place).toEqual({ at: 'offchain', slot: S0 + 6n, arrival: true });
    expect(f.late).toBe(true);
  }
  for (let s = S0 + 7n; s <= S0 + 10n; s++) slot(s);
  const now = (last as StrategyContext | null)!.now as Moment;
  const fact = index.factFor(CREATOR, now, 0);
  const cov = createsCoverage((k, f, t) => last!.history(k, f, t), now, at(S0));
  faults = engine.records.filter((x) => x.type === 'fault').length;
  return { mints: fact.mints.map((m) => m.mint), lost: index.lostCreate(0, now), covered: cov.covered, faults };
};

describe('RT-A3: a late creates log is lost from the deployer index with no hole', () => {
  it('on time: the index holds both of the creator\'s mints (control)', () => {
    const r = run(false);
    expect(r.mints).toEqual([addr(1), addr(2)].sort());
    expect(r.covered).toBe(true);
  });

  it('late: the index must hold the mint or H14 must not read as covered (fails on 959d801)', () => {
    const r = run(true);
    // On 959d801 the index missed the second create, named no hole, and the creates stream read covered.
    const failClosed = r.mints.includes(addr(2)) || r.lost !== null || !r.covered;
    expect({ ...r, failClosed }).toMatchObject({ failClosed: true });
    // LATE-LOG: exactly the on-time run (the backtest's index): nothing refused, both mints, no hole, covered.
    expect(r).toEqual(run(false));
    expect(r.faults).toBe(0);
  });

  it('late and cut: the hole is kept, so H14 does not count the creator as whole (fails on 959d801)', () => {
    const r = run(true, true);
    expect(r.faults).toBe(0);
    expect(r.lost).not.toBeNull();
    expect(r).toEqual(run(false, true));
  });
});
