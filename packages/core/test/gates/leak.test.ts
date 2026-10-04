// The gates inside the real engine (ENG-1): a strategy that evaluates every hard reject and the regime gate on each
// tick. The leak test plants future-only facts (a mint authority, a whale, a rug label, a SOL crash) and checks with
// ENG-1's leakTest that no gate sees them, and no decision changes, before their time. Ten replays give one log hash.
import { describe, expect, it } from 'vitest';
import { OFF_CHAIN, leakTest, replayHashes, replayOnce, type FeedEvent, type Moment, type ProofRun, type Strategy } from '../../src/engine/index.ts';
import { DAY_MS, HOUR_MS, SOL_USD_KEY, deployerKey, evaluateHardRejects, evaluateRegime, holdersKey, mintKey } from '../../src/gates/index.ts';
import { CONFIG } from '../fixtures.ts';
import { ACC, DEV, MINT, NOW, SLOT, T, deps, session, holderAccounts, obs, passingFacts, request, solPoints, streamObs, type Facts } from './world.ts';

const TOKEN = 'FutureOnlyMarker1111111111111111111111111111';
const tickAt = (k: number): Moment => ({ slot: SLOT + BigInt(k), txIndex: OFF_CHAIN, ixIndex: OFF_CHAIN, receivedAt: T + k * 400 });
const MARKER_AT: Moment = { slot: SLOT + 3n, txIndex: 0, ixIndex: 0, receivedAt: T + 1_200 };

const eventsOf = (facts: Facts): FeedEvent[] => [...facts].map(([key, { value, moment }], i) => ({ kind: 'market', id: `f${i}:${key}`, moment, key, value }));

/** The passing world, ticks at slots +0..+5, and facts dated at the marker that would change every gate if seen. */
const run = (planted: boolean): ProofRun => {
  const facts = passingFacts();
  const events = eventsOf(facts);
  for (let k = 0; k <= 5; k++) {
    // Keep the chain stream head and pool reads current, so the decisions stay meaningful at every tick.
    const m = tickAt(k);
    events.push({ kind: 'market', id: `head${k}`, moment: { ...m, txIndex: 0, ixIndex: 1 }, key: 'gates/stream:chain', value: { obs: obs({ slot: m.slot, receivedAt: m.receivedAt }), gapFreeSince: SLOT - 10_000n } });
    events.push({ kind: 'market', id: `tick${k}`, moment: m, key: 'tick', value: k });
  }
  if (planted) {
    const later = (key: string, value: unknown, n: number): FeedEvent => ({ kind: 'market', id: `planted${n}`, moment: { ...MARKER_AT, ixIndex: n }, key, value });
    const mint = facts.get(mintKey(MINT))!.value as { account: object };
    events.push(
      later(mintKey(MINT), { ...mint, obs: streamObs({ slot: MARKER_AT.slot, receivedAt: MARKER_AT.receivedAt }), account: { ...mint.account, mintAuthority: TOKEN } }, 0),
      later(holdersKey(MINT), { obs: obs({ slot: MARKER_AT.slot, receivedAt: MARKER_AT.receivedAt }), supply: 1_000_000_000_000_000n, coverage: 'all', accounts: [...holderAccounts(), { mint: MINT, delegate: null, delegatedAmount: 0n, address: ACC('w'), owner: TOKEN, ownerProgram: null, amount: 250_000_000_000_000n }] }, 1),
      later(deployerKey(DEV), { obs: streamObs({ slot: MARKER_AT.slot, receivedAt: MARKER_AT.receivedAt }), coverageFromMs: T - 30 * DAY_MS, mints: [], rugs: [{ mint: TOKEN, knownAtMs: T }] }, 2),
      later(SOL_USD_KEY, { obs: obs({ slot: MARKER_AT.slot, receivedAt: MARKER_AT.receivedAt }), points: [...solPoints(T, 72, (k) => (k === 0 ? 1n : 150_000_000n)), { tMs: T + HOUR_MS, price: 1n, note: TOKEN }] }, 3),
    );
  }
  const strategy = (): Strategy => ({
    onMarket: (e, ctx) => {
      if (e.key !== 'tick') return [];
      const gctx = { now: ctx.now, observedTip: ctx.now.slot, lookup: (k: string, a?: Parameters<typeof ctx.lookup>[1]) => ctx.lookup(k, a), history: (k: string, f: Parameters<typeof ctx.history>[1], t?: Parameters<typeof ctx.history>[2]) => ctx.history(k, f, t) };
      const hard = evaluateHardRejects(gctx, deps('backtest', session(), 'RUG-1'), request(), { stopAtFirst: false });
      const regime = evaluateRegime(gctx, deps('backtest'));
      const reasons = [
        ...hard.reasons.map((r) => `${r.gate}:${r.code}:${r.input ?? ''}:${r.neededBy ?? ''}:${r.detail}`),
        ...regime.reasons.map((r) => `regime:${r.code}:${r.detail}`),
        `pass=${hard.pass} regime=${regime.on}`,
      ];
      return [{ action: null, reasons }];
    },
  });
  return { events, strategy, seed: 'gates', book: CONFIG, start: { slot: 0n, txIndex: 0, ixIndex: 0, receivedAt: 0 } };
};

describe('gates in the engine', () => {
  it('pass at the decision moment and keep reasons in the journal', () => {
    const decisions = replayOnce(run(false)).records.filter((r) => r.type === 'decision');
    expect(decisions).toHaveLength(6);
    const first = decisions[0]!;
    if (first.type !== 'decision') throw new Error('unreachable');
    expect(first.at).toEqual(NOW);
    expect(first.reasons.at(-1)).toBe('pass=true regime=true');
  });

  it('cannot see a future-dated fact before its time, and no decision before it changes (leak test)', () => {
    const report = leakTest(run(true), { at: MARKER_AT, token: TOKEN }, { rugs: [TOKEN] });
    expect(report.violations).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('does see the planted facts after their time (the marker is real)', () => {
    const after = replayOnce(run(true)).records.filter((r) => r.type === 'decision' && r.at.slot > MARKER_AT.slot);
    const reasons = after.flatMap((r) => (r.type === 'decision' ? r.reasons : []));
    expect(reasons.some((x) => x.startsWith('H2:mint-authority'))).toBe(true);
    expect(reasons.some((x) => x.startsWith('H14:prior-rug'))).toBe(true);
  });

  it('gives the same log hash on 10 replays', () => {
    const hashes = replayHashes(run(true), 10);
    expect(new Set(hashes).size).toBe(1);
  });
});
