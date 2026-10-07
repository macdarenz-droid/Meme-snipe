// RED TEAM C round 2: planted-future-marker probes for the fact producer (FACTS-1) inside the real engine, on the
// facts the existing leak test (test/gates/leak.test.ts) does not plant: pool, LP, mint read, candles, insiders,
// graduates, curve volume, SOL/USD, and the POOL-FIRST-READ buffers (#preReads before a pool's first read, and
// #bookPending for a candle book opened late, as after a FACTS-REREAD). Each probe runs the same stream twice, with
// and without planted events dated at or after the marker moment M, through createReplay -> FactFeed -> Engine,
// and fails if, before M:
//   - any engine log record (the strategy's per-event lookups and gate reasons) differs between the two runs;
//   - any lookup or history read, event or log line carries the marker token;
// and, over the whole run:
//   - any released fact's value changes after its release (an in-place mutation would rewrite as-of history);
//   - an as-of lookup at a released fact's own moment, made after the run, differs from what was released then.
// Each probe also asserts the plant is real (a fact at or after M differs), so a pass is not vacuous.
import { describe, expect, it } from 'vitest';
import { transactionEvents } from '../../src/chain/index.ts';
import { startSession, TRIAL_POLICY } from '../../src/config/index.ts';
import { Engine, OFF_CHAIN, compareMoments, createReplay, reaches, canonical, type LogRecord, type MarketEvent, type Moment, type Strategy, type StrategyContext } from '../../src/engine/index.ts';
import { FactFeed, FactProducer, RAW, STREAMS } from '../../src/facts/index.ts';
import {
  CURVE_VOLUME_KEY, GRADUATES_KEY, SOL_USD_KEY, candlesKey, carryKey, createKey, curveKey, evaluateHardRejects, evaluateRegime, insidersKey, lpKey, migrationKey,
  mintKey, poolKey, streamKey, type GateContext, type GateRequest,
} from '../../src/gates/index.ts';
import { lamports, microUsd } from '../../src/units/index.ts';
import { pumpSwapRoundTrip } from '../../src/costs/index.ts';
import { FEE_CONTEXT } from '../gates/world.ts';
import { CONFIG } from '../fixtures.ts';
import { FIX, MINT, OPTIONS, POOL, RECORDS, atOf, chainTx, coverage, offchain, slotNotice, txEvents } from '../facts/helpers.ts';
import { swapLog } from '../facts/swaps.ts';

const TOKEN = 'FutureOnlyMarkerRedTeamC1111111111111111111';
const session = startSession(TRIAL_POLICY);

// ---------- the fixture coin ----------
const create = RECORDS.find((r) => transactionEvents(r.rec).some((e) => e.name === 'CreateEvent' && e.data.mint === MINT))!.rec;
const fromRecords = (sig: string) => RECORDS.find((r) => r.rec.signature === sig)!.rec;
const complete = fromRecords(chainTx('pump CompleteEvent (curve filled)').signature);
const migrate = fromRecords(chainTx('migration CreatePoolEvent').signature);
const swaps = RECORDS.filter((r) => r.label === 'pool swap after migration' && r.rec.signature !== migrate.signature && r.rec.signature !== complete.signature).map((r) => r.rec);
const READ_SLOT = BigInt(FIX.accountsRead.slot);
const READ_AT = 1_791_100_000_000;

const request = (): GateRequest => {
  const rt = pumpSwapRoundTrip({ baseReserve: 206_900_000_000_000n, quoteVault: 67_405_853_773n, virtualQuoteReserves: 17_584_505_289n }, FEE_CONTEXT)(lamports(50_000_000n));
  return { mint: MINT, universe: 'U1', notional: microUsd(10_000_000n), spend: lamports(50_000_000n), roundTrip: rt };
};

/** A stable text for any fact value (bigint, Map, Set, typed arrays), to compare a value with itself later. */
const text = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) => {
    if (typeof x === 'bigint') return `${x}n`;
    if (x instanceof Map) return { $map: [...x.entries()] };
    if (x instanceof Set) return { $set: [...x.values()] };
    if (ArrayBuffer.isView(x)) return { $bytes: Buffer.from(x.buffer, x.byteOffset, x.byteLength).toString('hex') };
    return x;
  }) ?? 'undefined';

const KEYS = [poolKey(MINT), lpKey(MINT), mintKey(MINT), candlesKey(MINT), carryKey(MINT), migrationKey(MINT), curveKey(MINT), createKey(MINT), insidersKey(MINT), `gates/soft:${MINT}`, GRADUATES_KEY, CURVE_VOLUME_KEY, SOL_USD_KEY, streamKey(STREAMS.trades(POOL))];

interface Run {
  readonly records: readonly LogRecord[];
  readonly violations: string[];
  /** Fact events released at or after M, as text, for the "the plant is real" check. */
  readonly after: string[];
}

/**
 * One run of `events` through the FactFeed in the engine. The strategy reads every watched key and, when asked, the
 * hard rejects and the regime at each event; reads before M are watched for the token.
 */
const runOnce = (events: readonly MarketEvent[], M: Moment, gates: boolean, producer: () => FactProducer = () => new FactProducer(OPTIONS)): Run => {
  const violations: string[] = [];
  const early = (m: Moment) => compareMoments(m, M) < 0;
  const replay = createReplay(events);
  const feed = new FactFeed(replay.feed, producer());
  const released: { key: string; moment: Moment; value: unknown; snap: string; id: string }[] = [];
  let last: StrategyContext | null = null;
  const after: string[] = [];
  const strategy: Strategy = {
    onMarket: (e, ctx) => {
      last = ctx;
      released.push({ key: e.key, moment: e.moment, value: e.value, snap: text(e.value), id: e.id });
      if (!early(ctx.now)) {
        if (e.id.includes('~')) after.push(`${e.key}=${text(e.value)}`);
        return [];
      }
      if (reaches(e, TOKEN)) violations.push(`event ${e.id} carries the marker at ${ctx.now.slot}`);
      const reasons: string[] = [];
      for (const k of KEYS) {
        const r = ctx.lookup(k);
        if (reaches(r, TOKEN)) violations.push(`lookup ${k} carries the marker at ${ctx.now.slot}`);
        reasons.push(`${k}=${r.ok ? text(r.value) : `!${r.reason}`}`);
      }
      if (gates) {
        const g: GateContext = { now: ctx.now, observedTip: ctx.now.slot, lookup: (k, a) => ctx.lookup(k, a), history: (k, f, t) => ctx.history(k, f, t) };
        const h = evaluateHardRejects(g, { session, mode: 'backtest' }, request(), { stopAtFirst: false });
        const rg = evaluateRegime(g, { session, mode: 'backtest' } as never);
        reasons.push(...h.reasons.map((x) => `${x.gate}:${x.code}:${x.input ?? ''}:${x.neededBy ?? ''}:${x.detail}`), `pass=${h.pass}`, ...rg.reasons.map((x) => `regime:${x.code}:${x.detail}`), `regime=${rg.on}`);
      }
      return [{ action: null, reasons }];
    },
  };
  const engine = new Engine({ clock: replay.clock, feed, strategy, runner: { run: () => {} }, seed: 'redteam-c', book: CONFIG });
  while (replay.advance()) engine.drain();
  for (const r of engine.records) if (r.type === 'fault') violations.push(`engine fault ${r.fault} on ${r.eventId}`);
  // Retroactive mutation: each released value is unchanged at the end of the run, and the as-of store answers the
  // same value at its moment.
  const latest = new Map<string, string>();
  for (const r of released) {
    if (text(r.value) !== r.snap) violations.push(`${r.id} changed after its release (as-of history rewritten)`);
    latest.set(r.key, r.snap);
  }
  const ctx = last as StrategyContext | null;
  if (ctx !== null) {
    const seen = new Map<string, string>();
    for (let i = 0; i < released.length; i++) {
      const r = released[i]!;
      seen.set(r.key, r.snap);
      const next = released[i + 1];
      // Compare once all events at this moment are in.
      if (next !== undefined && compareMoments(next.moment, r.moment) === 0) continue;
      for (const k of KEYS) {
        const want = seen.get(k);
        const got = ctx.lookup(k, r.moment);
        if (want === undefined) {
          if (got.ok) violations.push(`${k} answers at ${r.moment.slot} before any release`);
        } else if (!got.ok || text(got.value) !== want) violations.push(`${k} as of ${r.moment.slot}/${r.moment.receivedAt} differs from what was released then`);
      }
    }
  }
  return { records: engine.records, violations, after };
};

/** The probe: clean vs planted, compared before M. */
const probe = (base: readonly MarketEvent[], plant: readonly MarketEvent[], M: Moment, o: { gates?: boolean; tokenPlanted?: boolean; control?: boolean; producer?: () => FactProducer } = {}) => {
  if (o.control !== true) for (const p of plant) if (compareMoments(p.moment, M) < 0) throw new Error(`planted ${p.id} is dated before M`);
  if (o.tokenPlanted === true && !plant.some((p) => reaches(p, TOKEN))) throw new Error('no planted event carries the token');
  const clean = runOnce(base, M, o.gates ?? true, o.producer);
  const planted = runOnce([...base, ...plant], M, o.gates ?? true, o.producer);
  const violations = [...clean.violations.map((v) => `clean: ${v}`), ...planted.violations.map((v) => `planted: ${v}`)];
  const before = (rs: readonly LogRecord[]) => rs.filter((r) => r.type === 'start' || compareMoments(r.at, M) < 0).map(canonical);
  const a = before(clean.records);
  const b = before(planted.records);
  for (const line of b) if (line.includes(TOKEN)) violations.push(`the log records the marker before M: ${line.slice(0, 160)}`);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      violations.push(`record ${i} before M differs: ${(a[i] ?? 'missing').slice(0, 300)} VS ${(b[i] ?? 'missing').slice(0, 300)}`);
      break;
    }
  }
  const real = text(clean.after) !== text(planted.after);
  return { violations, real, decisionsBefore: a.length };
};

const at = (slot: bigint, receivedAt: number, ix = OFF_CHAIN): Moment => ({ slot, txIndex: OFF_CHAIN, ixIndex: ix, receivedAt });
/** A fetched transaction released late, off-chain at `slot` in arrival order (canonical.ts `arrival`), as a FACTS-REREAD lands it. */
const lateTx = (events: readonly MarketEvent[], slot: bigint, receivedAt: number, from = 1): MarketEvent[] =>
  events.map((e, i) => ({ ...e, id: `${e.id}:late`, moment: { slot, txIndex: OFF_CHAIN, ixIndex: from + i, receivedAt }, value: { ...(e.value as object), backfilled: true } }));

describe('RED TEAM C: planted future markers on facts the gate leak test does not plant', () => {
  it('pool, LP and mint (account read): a later read changes nothing before its moment', () => {
    const read = (slot: bigint, quoteDelta: bigint, lpDelta: bigint) => {
      const accounts = FIX.accountsRead.accounts.map((a, i) => {
        if (a.data === null) return a;
        const b = Buffer.from(a.data, 'base64');
        if (i === 3) b.writeBigUInt64LE(b.readBigUInt64LE(64) + quoteDelta, 64); // the quote vault's amount
        if (i === 4) b.writeBigUInt64LE(b.readBigUInt64LE(36) + lpDelta, 36); // the LP mint's supply
        return { ...a, data: b.toString('base64') };
      });
      return { ...FIX.accountsRead, accounts, slot };
    };
    const base: MarketEvent[] = [...txEvents(create), ...txEvents(complete), ...txEvents(migrate), offchain(RAW.accounts(MINT), read(READ_SLOT, 0n, 0n), READ_SLOT, READ_AT, 'helius')];
    for (let k = 1n; k <= 12n; k++) base.push(slotNotice(READ_SLOT + k, READ_AT + Number(k) * 400));
    const M = at(READ_SLOT + 6n, READ_AT + 2_400 + 50);
    const plant = [offchain(RAW.accounts(MINT), read(READ_SLOT + 6n, 1_000_000_000n, 77n), READ_SLOT + 6n, READ_AT + 2_400 + 50, 'helius')];
    const r = probe(base, plant, M);
    expect(r.violations).toEqual([]);
    expect(r.decisionsBefore).toBeGreaterThan(10);
    expect(r.real).toBe(true);
  });

  it('candles and the trade stream: swaps after M change no candle read before M', () => {
    const cut = 452_941_624n;
    const pre = swaps.filter((s) => s.slot < cut);
    const post = swaps.filter((s) => s.slot >= cut);
    expect(pre.length).toBeGreaterThan(3);
    expect(post.length).toBeGreaterThan(2);
    const base: MarketEvent[] = [
      coverage(STREAMS.trades(POOL), 'start', { fromSlot: migrate.slot, via: `logs:${POOL}` }, migrate.slot - 1n, atOf(migrate) - 500),
      ...txEvents(create), ...txEvents(complete), ...txEvents(migrate), ...pre.flatMap((s) => txEvents(s)),
    ];
    for (let s = migrate.slot + 1n; s <= 452_941_640n; s++) base.push(slotNotice(s, atOf(migrate) + Number(s - migrate.slot) * 400 + 300));
    const first = post[0]!;
    const M: Moment = txEvents(first)[0]!.moment;
    const r = probe(base, post.flatMap((s) => txEvents(s)), M);
    expect(r.violations).toEqual([]);
    expect(r.real).toBe(true);
  });

  it('POOL-FIRST-READ #preReads: swaps kept before the first read, swaps after M not seen by the read before M', () => {
    const STREAM = STREAMS.trades(POOL);
    const supply = 1_000_000_000_000_000n;
    // The read's real reserves: decode as the producer would, by running the read alone once.
    const one = runFactsOnce([coverage(STREAM, 'start', { fromSlot: READ_SLOT - 10n, via: `logs:${POOL}` }, READ_SLOT - 11n, READ_AT - 5_000), offchain(RAW.accounts(MINT), { ...FIX.accountsRead, slot: READ_SLOT }, READ_SLOT, READ_AT, 'helius')]);
    const p = one.get(poolKey(MINT)) as { baseVault: bigint; quoteVault: bigint; pool: { virtualQuoteReserves?: bigint; coinCreator: string } };
    let state = { baseReserve: p.baseVault, quoteVault: p.quoteVault, virtualQuoteReserves: p.pool.virtualQuoteReserves ?? 0n };
    const ms = (s: bigint) => READ_AT + Number(s - READ_SLOT) * 400;
    let n = 0;
    const logSwap = (slot: bigint, user?: string): MarketEvent => {
      const s = swapLog({ pool: POOL, coinCreator: p.pool.coinCreator, supply, pre: state, side: n % 2 === 0 ? 'buy' : 'sell', base: state.baseReserve / 5_000n, atMs: ms(slot) });
      state = s.after;
      const k = n++;
      const ev = { program: 'pump_amm', name: k % 2 === 0 ? 'BuyEvent' : 'SellEvent', data: { ...s.data, ...(user === undefined ? {} : { user }) }, logIndex: 0 };
      return {
        kind: 'market', id: `log:rtc${k}:confirmed:00000`, moment: { slot, txIndex: 2 ** 32 + k, ixIndex: 2 ** 36, receivedAt: ms(slot) },
        key: `logs:pump_amm:${ev.name}:${POOL}`,
        value: { event: ev, signature: `rtc${k}`, txSlot: slot, truncated: false, via: `logs:${POOL}`, commitment: 'confirmed', source: 'helius', backfilled: false, seq: k },
      };
    };
    // Kept: three swaps newer than the read, released before it (the read answered for READ_SLOT arrives at +4).
    const kept = [logSwap(READ_SLOT + 1n), logSwap(READ_SLOT + 2n), logSwap(READ_SLOT + 3n)];
    const base: MarketEvent[] = [
      coverage(STREAM, 'start', { fromSlot: READ_SLOT - 10n, via: `logs:${POOL}` }, READ_SLOT - 11n, READ_AT - 5_000),
      ...kept, offchain(RAW.accounts(MINT), { ...FIX.accountsRead, slot: READ_SLOT }, READ_SLOT + 4n, ms(READ_SLOT + 4n) + 10, 'helius'),
    ];
    for (let s = READ_SLOT + 1n; s <= READ_SLOT + 12n; s++) base.push(slotNotice(s, ms(s) + 300));
    // Planted: swaps after M carrying the marker as their trader.
    const plant = [logSwap(READ_SLOT + 7n, TOKEN), logSwap(READ_SLOT + 8n, TOKEN)];
    const M = plant[0]!.moment;
    const r = probe(base, plant, M, { tokenPlanted: true });
    expect(r.violations).toEqual([]);
    expect(r.real).toBe(true);

    // And the first read itself planted after M: the kept swaps make no pool fact before it.
    const noRead = base.filter((e) => !e.key.startsWith('read:accounts:'));
    const M2 = at(READ_SLOT + 6n, ms(READ_SLOT + 6n) + 10);
    const r2 = probe(noRead, [offchain(RAW.accounts(MINT), { ...FIX.accountsRead, slot: READ_SLOT }, READ_SLOT + 6n, ms(READ_SLOT + 6n) + 10, 'helius')], M2);
    expect(r2.violations).toEqual([]);
    expect(r2.real).toBe(true);
  });

  it('POOL-FIRST-READ #bookPending: a migration re-read lands after M; its candle book takes no swap before M', () => {
    const STREAM = STREAMS.trades(POOL);
    const base: MarketEvent[] = [
      coverage(STREAM, 'start', { fromSlot: migrate.slot, via: `logs:${POOL}` }, migrate.slot - 1n, atOf(migrate) - 500),
      ...txEvents(create), ...txEvents(complete),
      // The pool's swaps are released live; the migration's own transaction was missed (a FACTS-REREAD case).
      ...swaps.flatMap((s) => txEvents(s)),
    ];
    const lastSwap = swaps.at(-1)!;
    for (let s = migrate.slot + 1n; s <= lastSwap.slot + 8n; s++) base.push(slotNotice(s, atOf(migrate) + Number(s - migrate.slot) * 400 + 300));
    const lateSlot = lastSwap.slot + 4n;
    const lateAt = atOf(migrate) + Number(lateSlot - migrate.slot) * 400 + 100;
    const M = at(lateSlot, lateAt, 1);
    const r = probe(base, lateTx(txEvents(migrate), lateSlot, lateAt), M);
    expect(r.violations).toEqual([]);
    expect(r.real).toBe(true);
  });

  it('insiders: a funder read landing after M changes no insider or soft read before M', () => {
    const s0 = create.slot;
    const stream = STREAMS.mintTxs(MINT);
    const window = RECORDS.filter((r) => r.label === 'creation window' || r.label === 'first buyers').map((r) => r.rec);
    const funders = FIX.funders.map((f) => ({ ...f, asOfSlot: BigInt(f.asOfSlot), slot: f.slot === null ? null : BigInt(f.slot) }));
    const last = window.at(-1)!;
    const base: MarketEvent[] = [coverage(stream, 'start', { fromSlot: s0, via: `sigs:${MINT}` }, s0 - 1n, atOf(create) - 1000), ...window.flatMap((r) => txEvents(r))];
    // All funders but the creator's, read at the window's end.
    const creator = funders.find((f) => f.wallet === FIX.meta.creator)!;
    for (const f of funders) if (f !== creator) base.push(offchain(RAW.funder(f.wallet), f, last.slot, atOf(last) + 100));
    for (let k = 1n; k <= 10n; k++) base.push(slotNotice(last.slot + k, atOf(last) + Number(k) * 400 + 300));
    const M = at(last.slot + 5n, atOf(last) + 2_000 + 350);
    const plant = [offchain(RAW.funder(creator.wallet), { ...creator, funder: creator.funder ?? TOKEN }, last.slot + 5n, M.receivedAt)];
    const r = probe(base, plant, M, { gates: false });
    expect(r.violations).toEqual([]);
    expect(r.real).toBe(true);
  });

  it('graduates: a survival read after M, and a seed released after M, change no graduates read before M', () => {
    const mark = 1_791_032_673_000 + 30 * 60_000;
    const base: MarketEvent[] = [...txEvents(create), ...txEvents(complete), ...txEvents(migrate)];
    for (let k = 1n; k <= 6n; k++) base.push(slotNotice(migrate.slot + 4_490n + k, mark + 14_000 + Number(k) * 400));
    const M = at(migrate.slot + 4_500n, mark + 20_000);
    const plant = [
      offchain(RAW.accounts(MINT), { ...FIX.accountsRead, slot: BigInt(FIX.accountsRead.slot) }, migrate.slot + 4_500n, mark + 20_000),
      offchain(RAW.graduatesSeed, { source: 'persist', asOfMs: mark + 20_000, items: [{ mint: TOKEN, migratedAtMs: mark - 40 * 60_000, reserveAfter: 5n }] }, migrate.slot + 4_500n, mark + 20_000),
    ];
    const r = probe(base, plant, M, { gates: false, tokenPlanted: true });
    expect(r.violations).toEqual([]);
    expect(r.real).toBe(true);
  });

  it('curve volume: hours released after M change no volume read before M; an hour row released before its end is not used early', () => {
    const day = 20_729;
    const hour = (d: number, h: number, l: bigint) => ({ hourStartMs: d * 86_400_000 + h * 3_600_000, lamports: l, covered: true });
    const base: MarketEvent[] = [];
    let s = 1_000n;
    for (let h = 0; h < 24; h++) {
      const r = hour(day - 1, h, BigInt(h + 1) * 1_000_000_000n);
      base.push(offchain(RAW.volumeHour, r, s++, r.hourStartMs + 3_600_000 + 1));
    }
    for (let h = 0; h < 23; h++) {
      const r = hour(day, h, 2_000_000_000n);
      base.push(offchain(RAW.volumeHour, r, s++, r.hourStartMs + 3_600_000 + 1));
    }
    const lastHour = hour(day, 23, 9_000_000_000n);
    const endMs = lastHour.hourStartMs + 3_600_000;
    for (let k = 0; k < 6; k++) base.push(slotNotice(s + BigInt(k), endMs - 2_000 + k * 1_000));
    const M = at(s + 3n, endMs + 1);
    const r = probe(base, [offchain(RAW.volumeHour, lastHour, s + 3n, endMs + 1)], M, { gates: false });
    expect(r.violations).toEqual([]);
    expect(r.real).toBe(true);
    // Released one ms before its hour ends (content dated after its release): no volume fact may form from it at all.
    const early = runFactsOnce([...base.slice(0, 47), offchain(RAW.volumeHour, lastHour, s, endMs - 1)]);
    const days = (early.get(CURVE_VOLUME_KEY) as { days: { day: number }[] } | undefined)?.days ?? [];
    expect(days.map((d) => d.day)).not.toContain(day);
  });

  it('SOL/USD through the producer: a bar released after M changes no SOL/USD or regime read before M', () => {
    const bar0 = 1_791_000_000_000 - (1_791_000_000_000 % 3_600_000);
    const base: MarketEvent[] = [];
    for (let i = 0; i < 30; i++) base.push(offchain(RAW.solUsd, { start: bar0 + i * 3_600_000, close: `${150 + i}.5` }, BigInt(1_000 + i), bar0 + (i + 1) * 3_600_000 + 5, 'coinbase'));
    const M = at(1_030n, bar0 + 31 * 3_600_000 + 5);
    const r = probe(base, [offchain(RAW.solUsd, { start: bar0 + 30 * 3_600_000, close: '1.25' }, 1_030n, M.receivedAt, 'coinbase')], M, { gates: false });
    expect(r.violations).toEqual([]);
    expect(r.real).toBe(true);
  });
});

describe('RED TEAM C: the probes bite (controls)', () => {
  const candleStream = (): { base: MarketEvent[]; post: MarketEvent[]; M: Moment } => {
    const cut = 452_941_624n;
    const base: MarketEvent[] = [
      coverage(STREAMS.trades(POOL), 'start', { fromSlot: migrate.slot, via: `logs:${POOL}` }, migrate.slot - 1n, atOf(migrate) - 500),
      ...txEvents(create), ...txEvents(complete), ...txEvents(migrate), ...swaps.filter((s) => s.slot < cut).flatMap((s) => txEvents(s)),
    ];
    for (let s = migrate.slot + 1n; s <= 452_941_640n; s++) base.push(slotNotice(s, atOf(migrate) + Number(s - migrate.slot) * 400 + 300));
    const post = swaps.filter((s) => s.slot >= cut).flatMap((s) => txEvents(s));
    return { base, post, M: post[0]!.moment };
  };

  it('a plant moved before M (a leak by construction) is caught by the prefix comparison', () => {
    const { base, post, M } = candleStream();
    const early = post.map((e) => ({ ...e, id: `${e.id}:early`, moment: { ...e.moment, slot: M.slot - 2n, receivedAt: M.receivedAt - 800 } }));
    const r = probe(base, early, M, { control: true });
    expect(r.violations.some((v) => v.includes('before M differs'))).toBe(true);
  });

  it('a producer that rewrites a released candles value in place is caught by the as-of check', () => {
    const { base, M } = candleStream();
    class Rewriting extends FactProducer {
      #held: { candles?: unknown[] } | null = null;
      override observe(e: MarketEvent) {
        const out = super.observe(e);
        // After release, alter the previously released candles fact (as a shared array mutated later would).
        if (this.#held !== null && Array.isArray(this.#held.candles)) (this.#held.candles as unknown[]).push({ planted: TOKEN });
        this.#held = null;
        for (const w of out) if (w.key === candlesKey(MINT)) this.#held = w.value as { candles?: unknown[] };
        return out;
      }
    }
    const r = probe(base, [], M, { producer: () => new Rewriting(OPTIONS) });
    expect(r.violations.some((v) => v.includes('changed after its release'))).toBe(true);
    expect(r.violations.some((v) => v.includes('differs from what was released then'))).toBe(true);
  });
});

/** The last value of each fact key after running `events` through a FactFeed (no engine, for setup only). */
function runFactsOnce(events: readonly MarketEvent[]): Map<string, unknown> {
  const replay = createReplay(events);
  const feed = new FactFeed(replay.feed, new FactProducer(OPTIONS));
  const out = new Map<string, unknown>();
  while (replay.advance()) for (let e = feed.next(); e !== null; e = feed.next()) if (e.kind === 'market') out.set(e.key, e.value);
  return out;
}
