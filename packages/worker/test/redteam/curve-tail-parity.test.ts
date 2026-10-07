// RED TEAM A, probe RT-A2: H5's curve-tail check judges a different tape live and in the backtest.
//
// H5 (hard.ts:29) runs `checkCurveTails` over every `pump:TradeEvent:<mint>` (and `logs:` copy) in the store: any
// curve trade event with a non-zero 8-byte tail rejects the coin (`event-tail`), and no curve event at all passes
// ("a curve tape that is not there is not a failure", DECISIONS GATE-1c).
// - Backtest: the dataset feed releases EVERY curve trade that carries a tail (backtest/src/sim/facts.ts:527).
// - Live: production runs with `tradeStreams: false` (worker/src/main.ts:50), so the pump program is not watched
//   (run/sources.ts:316). The only curve trades that reach the store are the completing buy (COMPLETION-READ) and up
//   to 6 newest curve transactions a FACTS-REREAD try puts on the feed.
// So a coin whose curve tape has an offending tail anywhere but its last few trades is refused by H5 in the backtest
// and passes H5 live: a live-only PASS (the permissive direction), never listed in ARCHITECTURE §16.3's live-only rows.
// Prevalence is unknown: the one real completing buy checked here (completion-read.json, slot 453,857,383) has a
// zero curve tail; no sample of curve tails since 2026-10-06 is in the repo.
import { describe, expect, it } from 'vitest';
import { OFF_CHAIN, type MarketEvent } from '../../../core/src/engine/index.ts';
import { checkCurveTails } from '../../../core/src/gates/tails.ts';
import { FactWorld, MINT } from '../../../core/test/facts/helpers.ts';

const B = 453_000_000n; // after pump's tail boundary (452,654,932)
let n = 0;
const curveTrade = (slot: bigint, extra: string): MarketEvent => ({
  kind: 'market', id: `ev:ct${n}:00000:00000`, moment: { slot, txIndex: 2 ** 32 + n, ixIndex: 1, receivedAt: 1_791_000_000_000 + Number(slot - B) * 400 },
  key: `pump:TradeEvent:${MINT}`,
  value: { event: { program: 'pump', name: 'TradeEvent', data: { mint: MINT, isBuy: true }, signature: `ct${n++}`, trailing: 8, extra }, txSlot: slot, blockTime: null, source: 'helius', backfilled: false },
});
const now = (w: FactWorld) => w.ctx({ slot: B + 1_000n, txIndex: OFF_CHAIN, ixIndex: OFF_CHAIN, receivedAt: 1_791_000_500_000 });

describe('RT-A2: the curve-tail half of H5 sees the whole curve in the backtest, the last buy live', () => {
  // The curve's life: 40 trades, one early trade with a non-zero tail, the completing buy last (zero tail).
  const tape = () => Array.from({ length: 40 }, (_, i) => curveTrade(B + BigInt(i), i === 5 ? '0100000000000000' : '0000000000000000'));

  it('backtest store (every curve trade): H5 refuses event-tail (control)', () => {
    const w = new FactWorld().push(...tape());
    const r = checkCurveTails(now(w), MINT);
    expect(r.ok ? 'pass' : r.code).toBe('event-tail');
  });

  it('live store (tradeStreams false: only the completing buy) must give the same verdict (fails on 959d801: passes)', () => {
    const t = tape();
    const w = new FactWorld().push(t.at(-1)!);
    const r = checkCurveTails(now(w), MINT);
    expect(r.ok ? 'pass' : r.code).toBe('event-tail');
  });
});
