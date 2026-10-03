// Engine test fixtures: a generated market stream, a stub strategy that walks the full CORE-1 lifecycle,
// and a stub world that answers effects. Outputs carry no absolute slots, so the +1-slot shift test can
// compare a delayed run to the original record for record.
import { attemptId, entryKey, intentId, positionId, reservationId } from '../src/domain/index.ts';
import { lamports, raw } from '../src/units/index.ts';
import { canOpenNewEntry, type BookEvent, type Effect } from '../src/lifecycle/index.ts';
import {
  createRng, OFF_CHAIN, type Decision, type EffectRunner, type FeedEvent, type MarketEvent, type Moment, type ProofRun,
  type Replay, type Strategy, type StrategyContext,
} from '../src/engine/index.ts';
import { blockhashOf, CONFIG, MINT, quote, sig, SPEND } from './fixtures.ts';

export const MS_PER_SLOT = 400;

export const at = (slot: bigint | number, txIndex = OFF_CHAIN, ixIndex = OFF_CHAIN): Moment => ({
  slot: BigInt(slot), txIndex, ixIndex,
  receivedAt: Number(slot) * MS_PER_SLOT + (txIndex === OFF_CHAIN ? MS_PER_SLOT - 1 : Math.min(txIndex, MS_PER_SLOT - 2)),
});

/** Moves a moment `k` slots later, keeping its receipt offset (outputs stay relative to now). */
export const later = (m: Moment, k: number): Moment => ({ slot: m.slot + BigInt(k), txIndex: OFF_CHAIN, ixIndex: OFF_CHAIN, receivedAt: m.receivedAt + k * MS_PER_SLOT });

export const PRICE = `price:${MINT}`;
export const POOL = `pool:${MINT}`;
export const TRADE = `trade:${MINT}`;

/** A random walk of prices (a few per slot, at transaction positions) plus one tick per slot. */
export const generateStream = (seed: string, slots: number, from = 1): FeedEvent[] => {
  const rng = createRng(seed);
  const events: FeedEvent[] = [];
  let price = 1_000_000n;
  for (let s = from; s < from + slots; s++) {
    const n = rng.int(3);
    for (let k = 0; k < n; k++) {
      price += BigInt(rng.int(41) - 20) * 1_000n;
      if (price < 100_000n) price = 100_000n;
      events.push({ kind: 'market', id: `px-${s}-${k}`, moment: at(s, 10 * k + rng.int(10), rng.int(4)), key: PRICE, value: { price } });
    }
    if (s % 7 === 0) events.push({ kind: 'market', id: `pool-${s}`, moment: at(s, 50, 0), key: POOL, value: { reserves: price * 30n } });
    events.push({ kind: 'world', id: `tick-${s}`, moment: at(s), event: { type: 'tick', blockHeight: 1_000n } });
  }
  return events;
};

const back = (m: Moment, k: bigint): Moment => ({ ...m, slot: m.slot >= k ? m.slot - k : 0n });

/**
 * Enters on a rise over the last three slots (half the time, by the seeded draw), exits on a fall from
 * the entry price or after six price events. Reads the pool state on every decision so that a leak in
 * the as-of store would reach it. Every id is derived from event ids, never from slots.
 */
export const stubStrategy = (): Strategy => {
  let n = 0;
  let entryPrice = 0n;
  let held = 0;
  return {
    onMarket: (e: MarketEvent, ctx: StrategyContext): Decision[] => {
      if (e.key !== PRICE) return [];
      const price = (e.value as { price: bigint }).price;
      const pool = ctx.lookup(POOL);
      const trades = ctx.history(TRADE, back(ctx.now, 20n));
      const ago = ctx.lookup(PRICE, back(ctx.now, 3n));
      const book = ctx.book;
      const open = Object.values(book.positions).find((p) => p.status === 'open');
      const facts = [`pool ${pool.ok ? 'known' : pool.reason}`, `trades ${Array.isArray(trades) ? trades.length : 'refused'}`];
      if (open !== undefined) {
        held++;
        if (price >= entryPrice && held < 6) return [];
        const x = intentId(`x-${e.id}`);
        const a = n++;
        held = 0;
        return [
          { action: { type: 'trigger_exit', positionId: open.id, reasons: [price < entryPrice ? 'stop' : 'max_hold'], intentId: x }, reasons: [price < entryPrice ? 'below entry' : 'held six prices', ...facts] },
          { action: { type: 'intent', intentId: x, event: { type: 'prepare', quote } }, reasons: ['exit'] },
          { action: { type: 'intent', intentId: x, event: { type: 'sign', attempt: { id: attemptId(`a${a}`), intentId: x, signedBytesRef: `b${a}`, signature: sig(a), blockhash: blockhashOf(a), lastValidBlockHeight: 1_000_000_000n, quote } } }, reasons: ['exit'] },
          { action: { type: 'intent', intentId: x, event: { type: 'submit' } }, reasons: ['exit'] },
        ];
      }
      if (!ago.ok || price <= (ago.value as { price: bigint }).price) return [];
      const gate = canOpenNewEntry(book);
      if (!gate.ok) return [{ action: null, reasons: ['rise', ...gate.reasons, ...facts] }];
      if (ctx.rng.next() < 0.5) return [{ action: null, reasons: ['rise', 'draw skipped', ...facts] }];
      const id = intentId(`e-${e.id}`);
      const a = n++;
      entryPrice = price;
      held = 0;
      const step = (event: Extract<BookEvent, { type: 'intent' }>['event']): Decision => ({ action: { type: 'intent', intentId: id, event }, reasons: ['entry'] });
      return [
        {
          action: { type: 'propose_entry', intent: { id, key: entryKey(MINT, e.id), purpose: 'entry', side: 'buy', mint: MINT, venue: 'pump-curve', positionId: positionId(`p-${e.id}`), spend: SPEND } },
          reasons: ['rise over three slots', ...facts],
        },
        step({ type: 'mark_eligible' }),
        step({ type: 'approve_risk' }),
        step({ type: 'reserve_exposure', reservation: { id: reservationId(`r-${e.id}`), intentId: id, amount: SPEND, status: 'held' } }),
        step({ type: 'prepare', quote }),
        step({ type: 'sign', attempt: { id: attemptId(`a${a}`), intentId: id, signedBytesRef: `b${a}`, signature: sig(a), blockhash: blockhashOf(a), lastValidBlockHeight: 1_000_000_000n, quote } }),
        step({ type: 'submit' }),
      ];
    },
  };
};

export const TOKENS = 1_000_000n;

/** Answers effects: a broadcast is accepted one slot later and confirmed two slots later; a reconcile reads balances one slot later. */
export const stubWorld = (replay: Replay, seen: Effect[] = []): EffectRunner => {
  let n = 0;
  const sent = new Map<string, { signature: ReturnType<typeof sig>; purpose: 'entry' | 'exit' }>();
  const reply = (now: Moment, k: number, event: BookEvent) => replay.schedule({ kind: 'world', id: `w-${String(n++).padStart(6, '0')}`, moment: later(now, k), event });
  return {
    run: (fx, now) => {
      seen.push(fx);
      // A rebroadcast sends the same bytes again; the network answers once.
      if (fx.type === 'broadcast' && !sent.has(fx.intentId)) {
        sent.set(fx.intentId, { signature: fx.signature, purpose: fx.intentId.startsWith('e-') ? 'entry' : 'exit' });
        reply(now, 1, { type: 'intent', intentId: fx.intentId, event: { type: 'send_accepted' } });
        reply(now, 2, { type: 'intent', intentId: fx.intentId, event: { type: 'status', signature: fx.signature, result: 'succeeded', commitment: 'confirmed', blockHeight: 1_000n, searchedHistory: false } });
      }
      if (fx.type === 'reconcile_balances') {
        const s = sent.get(fx.intentId);
        if (s === undefined) return;
        const fill = { intentId: fx.intentId, signature: s.signature, slot: 100n, commitment: 'confirmed' as const, tokens: raw(TOKENS), sol: SPEND, fees: lamports(10_000) };
        reply(now, 1, { type: 'intent', intentId: fx.intentId, event: { type: 'reconcile', fills: [fill], blockHeight: 1_000n } });
      }
    },
  };
};

export const stubRun = (events: readonly FeedEvent[], seed = 'seed-1'): ProofRun => ({
  events, seed, book: CONFIG, strategy: stubStrategy, world: (replay) => stubWorld(replay),
});
