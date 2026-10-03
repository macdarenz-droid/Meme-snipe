// RUG-1: the as-of rug labeller. Boundaries of every threshold, what counts as the deployer's sale, liquidity on the
// curve and on the canonical pool, duplicates from logs and transactions, and a leak test with a planted future rug.
import { describe, expect, it } from 'vitest';
import { OFF_CHAIN, leakTest, replayOnce, type FeedEvent, type MarketEvent, type Moment, type ProofRun, type Strategy } from '../../src/engine/index.ts';
import { DAY_MS, RUG_CONFIG, rugConfigIssues, type RugConfig } from '../../src/config/index.ts';
import { NATIVE_MINT, SYSTEM_PROGRAM } from '../../src/chain/programs.ts';
import { DeployerIndex, RugLabeller, type RugLabel } from '../../src/gates/index.ts';
import { CONFIG } from '../fixtures.ts';

const DEV = 'Dev1111111111111111111111111111111111111111';
const SIGNER = 'Signer111111111111111111111111111111111111';
const OTHER = 'Other11111111111111111111111111111111111111';
const MINT = 'Mint111111111111111111111111111111111111111';
const POOL = 'Pool111111111111111111111111111111111111111';
const T0 = 1_790_000_000n; // launch, chain seconds

/** Small numbers so each boundary is one unit wide: 2% of 1,000,000 is 20,000; 1% of a 10,000 peak is 100. */
const CFG: RugConfig = { version: 'rugs-test', creatorDump: { supplyBps: 200, windowMs: 10_000 }, collapse: { dropBps: 9_900, windowMs: 10_000 } };
const SUPPLY = 1_000_000n;

let n = 0;
const moment = (ts: bigint): Moment => ({ slot: 1_000n + BigInt(++n), txIndex: 0, ixIndex: 0, receivedAt: Number(ts) * 1_000 + 300 });
const ev = (program: string, name: string, data: Record<string, unknown>, key = `${program}:${name}:x`): MarketEvent =>
  ({ kind: 'market', id: `e${++n}`, moment: moment(data['timestamp'] as bigint), key, value: { event: { program, name, data }, source: 'test', backfilled: false, seq: n } });

const create = (o: { mint?: string | undefined; creator?: string; user?: string; ts?: bigint | undefined; supply?: bigint | null } = {}) => {
  const data: Record<string, unknown> = { mint: o.mint ?? MINT, creator: o.creator ?? DEV, user: o.user ?? SIGNER, timestamp: o.ts ?? T0 };
  if (o.supply !== null) data['tokenTotalSupply'] = o.supply ?? SUPPLY;
  return ev('pump', 'CreateEvent', data);
};
const trade = (o: { user?: string; isBuy?: boolean; tokens?: bigint; sol?: bigint; ts?: bigint | undefined; quoteMint?: string; realQuote?: bigint; mint?: string | undefined; vt?: bigint }) => {
  const data: Record<string, unknown> = {
    mint: o.mint ?? MINT, user: o.user ?? OTHER, isBuy: o.isBuy ?? true, tokenAmount: o.tokens ?? 1n, solAmount: 1n,
    realSolReserves: o.sol ?? 0n, virtualSolReserves: 30n + (o.sol ?? 0n), virtualTokenReserves: o.vt ?? 900n, timestamp: o.ts ?? T0,
  };
  if (o.quoteMint !== undefined) data['quoteMint'] = o.quoteMint;
  if (o.realQuote !== undefined) data['realQuoteReserves'] = o.realQuote;
  return ev('pump', 'TradeEvent', data);
};
const migration = (mint = MINT, pool = POOL, ts = T0 + 1n) => ev('pump', 'CompletePumpAmmMigrationEvent', { mint, pool, timestamp: ts });
const sell = (o: { pool?: string; user?: string; base?: bigint; vault: bigint; virtual?: bigint; out?: bigint; lp?: bigint; ts?: bigint }) =>
  ev('pump_amm', 'SellEvent', {
    pool: o.pool ?? POOL, user: o.user ?? OTHER, baseAmountIn: o.base ?? 1n, poolQuoteTokenReserves: o.vault, virtualQuoteReserves: o.virtual ?? 0n,
    quoteAmountOut: o.out ?? 0n, lpFee: o.lp ?? 0n, poolBaseTokenReserves: 5n, timestamp: o.ts ?? T0 + 2n,
  });
const buy = (o: { pool?: string; vault: bigint; virtual?: bigint; ts?: bigint }) =>
  ev('pump_amm', 'BuyEvent', { pool: o.pool ?? POOL, user: OTHER, poolQuoteTokenReserves: o.vault, virtualQuoteReserves: o.virtual ?? 0n, timestamp: o.ts ?? T0 + 2n });

const run = (events: readonly MarketEvent[], cfg: RugConfig = CFG) => {
  const l = new RugLabeller(cfg);
  const out = events.map((e) => l.observe(e));
  return { l, out, labels: out.flat(), firstAt: out.findIndex((x) => x.length > 0) };
};
const label = (e: MarketEvent) => e.value as RugLabel;

describe('creator dump', () => {
  it('labels at the sale that reaches 2% of supply, not one token before', () => {
    const r = run([create(), trade({ user: DEV, isBuy: false, tokens: 19_999n, sol: 5n }), trade({ user: DEV, isBuy: false, tokens: 1n, sol: 5n, vt: 901n })]);
    expect(r.firstAt).toBe(2);
    expect(r.labels).toHaveLength(1);
    expect(label(r.labels[0]!)).toMatchObject({ mint: MINT, creator: DEV, rule: 'creator-dump', atMs: Number(T0) * 1_000, version: 'rugs-test' });
  });

  it('the label carries the moment of the event that met the rule', () => {
    const events = [create(), trade({ user: DEV, isBuy: false, tokens: 20_000n, sol: 5n })];
    const [f] = run(events).labels;
    expect(f).toMatchObject({ kind: 'market', id: `rug:${MINT}`, key: `rug:${MINT}`, moment: events[1]!.moment });
    expect(label(f!).slot).toBe(events[1]!.moment.slot);
  });

  it('counts the create signer, not other wallets, and never buys', () => {
    expect(run([create(), trade({ user: SIGNER, isBuy: false, tokens: 20_000n, sol: 5n })]).labels).toHaveLength(1);
    expect(run([create(), trade({ user: OTHER, isBuy: false, tokens: 900_000n, sol: 5n })]).labels).toHaveLength(0);
    expect(run([create(), trade({ user: DEV, isBuy: true, tokens: 900_000n, sol: 5n })]).labels).toHaveLength(0);
  });

  it('adds sales by the creator and the signer together', () => {
    expect(run([create(), trade({ user: DEV, isBuy: false, tokens: 10_000n, sol: 5n }), trade({ user: SIGNER, isBuy: false, tokens: 10_000n, sol: 5n, vt: 901n })]).firstAt).toBe(2);
  });

  it('counts a sale seen in logs and in its fetched transaction once', () => {
    const s = trade({ user: DEV, isBuy: false, tokens: 10_000n, sol: 5n });
    const again = { ...s, id: 'tx-copy', key: `logs:${s.key}` };
    expect(run([create(), s, again]).labels).toHaveLength(0);
    expect(run([create(), s, again, trade({ user: DEV, isBuy: false, tokens: 10_000n, sol: 5n, vt: 901n })]).labels).toHaveLength(1);
  });

  it('labels a sale exactly at the end of the window, not one second after', () => {
    expect(run([create(), trade({ user: DEV, isBuy: false, tokens: 20_000n, sol: 5n, ts: T0 + 10n })]).labels).toHaveLength(1);
    expect(run([create(), trade({ user: DEV, isBuy: false, tokens: 20_000n, sol: 5n, ts: T0 + 11n })]).labels).toHaveLength(0);
  });

  it('reads the threshold from the config', () => {
    const cfg = { ...CFG, creatorDump: { ...CFG.creatorDump, supplyBps: 201 } };
    expect(run([create(), trade({ user: DEV, isBuy: false, tokens: 20_099n, sol: 5n })], cfg).labels).toHaveLength(0);
    expect(run([create(), trade({ user: DEV, isBuy: false, tokens: 20_100n, sol: 5n })], cfg).labels).toHaveLength(1);
  });

  it('counts the deployer\'s sales on the canonical pool', () => {
    const r = run([create(), migration(), sell({ user: DEV, base: 20_000n, vault: 10_000n, out: 10n })]);
    expect(r.labels.map((x) => label(x).rule)).toEqual(['creator-dump']);
  });

  it('cannot judge a dump without the total supply, and says so', () => {
    const c = create({ supply: null });
    const r = run([c, trade({ user: DEV, isBuy: false, tokens: 900_000n, sol: 5n })]);
    expect(r.labels).toEqual([{ kind: 'market', id: `rug-unjudged:${MINT}`, key: `rug-unjudged:${MINT}`, moment: c.moment, value: { mint: MINT, creator: DEV, reason: 'the create carries no total supply', version: 'rugs-test' } }]);
    expect(r.l.unjudged.get(MINT)).toBe('the create carries no total supply');
    expect(run([create({ supply: 0n })]).l.unjudged.has(MINT)).toBe(true);
  });
});

describe('collapse', () => {
  it('labels when curve liquidity falls to 1% of its peak, not one lamport above', () => {
    const up = trade({ sol: 10_000n });
    expect(run([create(), up, trade({ isBuy: false, sol: 101n })]).labels).toHaveLength(0);
    const r = run([create(), up, trade({ isBuy: false, sol: 100n })]);
    expect(r.firstAt).toBe(2);
    expect(label(r.labels[0]!)).toMatchObject({ rule: 'collapse', creator: DEV });
  });

  it('keeps the highest peak', () => {
    expect(run([create(), trade({ sol: 10_000n }), trade({ sol: 5_000n }), trade({ sol: 101n })]).labels).toHaveLength(0);
    expect(run([create(), trade({ sol: 5_000n }), trade({ sol: 10_000n }), trade({ sol: 100n })]).labels).toHaveLength(1);
  });

  it('needs a peak above zero', () => {
    expect(run([create(), trade({ sol: 0n }), trade({ sol: 0n })]).labels).toHaveLength(0);
  });

  it('labels a collapse exactly at the end of the window, not one second after', () => {
    expect(run([create(), trade({ sol: 10_000n }), trade({ sol: 0n, ts: T0 + 10n })]).labels).toHaveLength(1);
    expect(run([create(), trade({ sol: 10_000n }), trade({ sol: 0n, ts: T0 + 11n })]).labels).toHaveLength(0);
  });

  it('reads the drop from the config', () => {
    const cfg = { ...CFG, collapse: { ...CFG.collapse, dropBps: 5_000 } };
    expect(run([create(), trade({ sol: 10_000n }), trade({ sol: 5_001n })], cfg).labels).toHaveLength(0);
    expect(run([create(), trade({ sol: 10_000n }), trade({ sol: 5_000n })], cfg).labels).toHaveLength(1);
  });

  it('uses the SOL reserves for SOL curves and the quote reserves for any other quote', () => {
    for (const q of [SYSTEM_PROGRAM, NATIVE_MINT]) {
      expect(run([create(), trade({ sol: 10_000n, quoteMint: q, realQuote: 10_000n }), trade({ sol: 100n, quoteMint: q, realQuote: 10_000n })]).labels).toHaveLength(1);
    }
    const usd = 'Usd1111111111111111111111111111111111111111';
    expect(run([create(), trade({ sol: 0n, quoteMint: usd, realQuote: 10_000n }), trade({ sol: 0n, quoteMint: usd, realQuote: 100n })]).labels).toHaveLength(1);
    expect(run([create(), trade({ sol: 10_000n, quoteMint: usd, realQuote: 10_000n }), trade({ sol: 100n, quoteMint: usd, realQuote: 10_000n })]).labels).toHaveLength(0);
  });

  it('follows the canonical pool after migration, using vault plus virtual reserve', () => {
    const peak = [create(), trade({ sol: 10_000n }), migration(), buy({ vault: 12_000n, virtual: -2_000n })];
    expect(run([...peak, buy({ vault: 101n })]).labels).toHaveLength(0);
    expect(run([...peak, buy({ vault: 300n, virtual: -200n })]).labels).toHaveLength(1);
  });

  it('labels at the sale that empties the pool, from its own amounts', () => {
    const base = [create(), migration()];
    // Pre-trade 10,000; the sale pays out 9,950 of which 50 is the LP fee that stays: 100 left.
    const r = run([...base, sell({ vault: 10_000n, out: 9_950n, lp: 50n })]);
    expect(r.labels.map((x) => label(x).rule)).toEqual(['collapse']);
    expect(run([...base, sell({ vault: 10_000n, out: 9_950n, lp: 51n })]).labels).toHaveLength(0);
  });

  it('ignores pools that are not the canonical pool of a tracked mint', () => {
    const other = 'Pool211111111111111111111111111111111111111';
    expect(run([create(), migration(), buy({ pool: other, vault: 10_000n }), buy({ pool: other, vault: 1n })]).labels).toHaveLength(0);
    expect(run([migration(), buy({ vault: 10_000n }), buy({ vault: 1n })]).labels).toHaveLength(0);
    // The first migration names the canonical pool; a later one for the same mint does not move it.
    expect(run([create(), migration(), migration(MINT, other), buy({ pool: other, vault: 10_000n }), buy({ pool: other, vault: 1n })]).labels).toHaveLength(0);
  });
});

describe('scope', () => {
  it('labels nothing for a mint whose create it never saw', () => {
    expect(run([trade({ user: DEV, isBuy: false, tokens: 900_000n, sol: 10_000n }), trade({ sol: 0n })]).labels).toHaveLength(0);
  });

  it('labels a mint once', () => {
    const r = run([create(), trade({ sol: 10_000n }), trade({ sol: 0n }), trade({ user: DEV, isBuy: false, tokens: 900_000n, sol: 0n })]);
    expect(r.labels).toHaveLength(1);
  });

  it('drops a launch two windows after it, and no sooner', () => {
    // Windows of 10 s: a launch at T0 is kept while later launches are within 20 s of it.
    const r = run([create(), create({ mint: 'M2', ts: T0 + 20n }), create({ mint: 'M3', ts: T0 + 20n })]);
    expect(r.l.tracked.launches).toBe(3);
    const later = run([create(), create({ mint: 'M2', ts: T0 + 21n }), trade({ sol: 10_000n, ts: T0 + 5n }), trade({ sol: 0n, ts: T0 + 5n })]);
    expect(later.l.tracked.launches).toBe(1);
    expect(later.labels).toHaveLength(0);
    const wide = { ...CFG, collapse: { ...CFG.collapse, windowMs: 20_000 } };
    expect(run([create(), create({ mint: 'M2', ts: T0 + 40n })], wide).l.tracked.launches).toBe(2);
    expect(run([create(), create({ mint: 'M2', ts: T0 + 41n })], wide).l.tracked.launches).toBe(1);
  });

  it('drops a pruned launch from every table: pool, label and unjudged entry', () => {
    const before = [create(), migration(), buy({ vault: 10_000n }), buy({ vault: 1n }), create({ mint: 'U', supply: null, ts: T0 + 1n })];
    expect(run(before).l.tracked).toEqual({ launches: 2, pools: 1, labelled: 1, unjudged: 1 });
    expect(run([...before, create({ mint: 'M2', ts: T0 + 22n })]).l.tracked).toEqual({ launches: 1, pools: 0, labelled: 0, unjudged: 0 });
  });

  it('two equal sales in different transactions count twice; one sale from its log and its transaction once', () => {
    const sale = (id: string, value: Record<string, unknown> = {}) => {
      const t = trade({ user: DEV, isBuy: false, tokens: 10_000n, sol: 5n });
      return { ...t, id, value: { ...(t.value as object), ...value } };
    };
    expect(run([create(), sale('ev:SigA:00000:00001'), sale('log:SigB:00001', { signature: 'SigB' })]).labels).toHaveLength(1);
    expect(run([create(), sale('ev:SigA:00000:00001'), sale('log:SigA:00001', { signature: 'SigA' })]).labels).toHaveLength(0);
    const poolSale = (id: string) => ({ ...sell({ user: DEV, base: 10_000n, vault: 10_000n, out: 10n }), id });
    expect(run([create(), migration(), poolSale('ev:SigA:00000:00001'), poolSale('ev:SigB:00000:00001')]).labels).toHaveLength(1);
    expect(run([create(), migration(), poolSale('ev:SigA:00000:00001'), poolSale('ev:SigA:00000:00001')]).labels).toHaveLength(0);
  });

  it('keeps the first create of a mint', () => {
    const r = run([create(), create({ creator: OTHER }), trade({ sol: 10_000n }), trade({ sol: 0n })]);
    expect(label(r.labels[0]!).creator).toBe(DEV);
  });

  it('ignores events that are not decoded pump events', () => {
    const l = new RugLabeller(CFG);
    for (const value of [null, 1, { event: null }, { event: { program: 'pump', name: 'TradeEvent', data: null } }, { event: { program: 'x', name: 'SellEvent', data: {} } }]) {
      expect(l.observe({ kind: 'market', id: 'x', moment: moment(T0), key: 'k', value })).toEqual([]);
    }
  });

  it('feeds the deployer index: the rug is known from its moment, not before', () => {
    const events = [create(), trade({ sol: 10_000n }), trade({ sol: 0n, ts: T0 + 3n })];
    const l = new RugLabeller(CFG);
    const idx = new DeployerIndex();
    for (const e of events) {
      for (const f of l.observe(e)) idx.observe(f);
      idx.observe(e);
    }
    const at = events[2]!.moment;
    expect(idx.factFor(DEV, at, 0).rugs).toEqual([{ mint: MINT, knownAtMs: at.receivedAt }]);
    expect(idx.factFor(DEV, { ...at, receivedAt: at.receivedAt - 1 }, 0).rugs).toEqual([]);
  });
});

describe('malformed and look-alike events', () => {
  it('ignores a create with an empty mint, a negative time or a time past the safe range', () => {
    const dump = (o: { mint?: string; ts?: bigint }) => [create(o), trade({ mint: o.mint, user: DEV, isBuy: false, tokens: 900_000n, sol: 5n, ts: o.ts })];
    expect(run(dump({ mint: '' })).labels).toHaveLength(0);
    expect(run(dump({ ts: -1n })).labels).toHaveLength(0);
    expect(run(dump({ ts: 2n ** 60n })).labels).toHaveLength(0);
  });

  it('a trade without a side is not a sale', () => {
    const t = trade({ user: DEV, tokens: 900_000n, sol: 5n });
    const data = { ...((t.value as { event: { data: Record<string, unknown> } }).event.data) };
    delete data['isBuy'];
    expect(run([create(), ev('pump', 'TradeEvent', data)]).labels).toHaveLength(0);
  });

  it('a pool buy is never a sale, whatever fields it carries', () => {
    const b = ev('pump_amm', 'BuyEvent', { pool: POOL, user: DEV, baseAmountIn: 900_000n, poolQuoteTokenReserves: 10_000n, quoteAmountOut: 9_950n, lpFee: 50n, timestamp: T0 + 2n });
    expect(run([create(), migration(), b]).labels).toHaveLength(0);
  });

  it('another program\'s SellEvent on the same pool is ignored', () => {
    const fake = ev('other', 'SellEvent', { pool: POOL, user: DEV, baseAmountIn: 900_000n, poolQuoteTokenReserves: 10_000n, quoteAmountOut: 9_950n, lpFee: 50n, timestamp: T0 + 2n });
    expect(run([create(), migration(), fake]).labels).toHaveLength(0);
  });

  it('the level after a sale includes the virtual reserve', () => {
    // Pre-trade 10,500 − 500 = 10,000 effective; after the sale 100.
    expect(run([create(), migration(), sell({ vault: 10_500n, virtual: -500n, out: 9_950n, lp: 50n })]).labels).toHaveLength(1);
    expect(run([create(), migration(), sell({ vault: 10_500n, virtual: -499n, out: 9_950n, lp: 50n })]).labels).toHaveLength(0);
  });

  it('two pool sales of the same size from different reserves are two sales', () => {
    const r = run([create(), migration(), sell({ user: DEV, base: 10_000n, vault: 10_000n, out: 10n }), sell({ user: DEV, base: 10_000n, vault: 9_990n, out: 10n })]);
    expect(r.firstAt).toBe(3);
  });
});

describe('config', () => {
  it('the shipped config is valid and versioned', () => {
    expect(rugConfigIssues(RUG_CONFIG)).toEqual([]);
    // Changing a value needs a new version and a DECISIONS entry (docs/DECISIONS.md "Rug labels").
    expect(RUG_CONFIG).toEqual({ version: 'rugs-1', creatorDump: { supplyBps: 200, windowMs: DAY_MS }, collapse: { dropBps: 9_900, windowMs: DAY_MS } });
    expect(Object.isFrozen(RUG_CONFIG.collapse)).toBe(true);
  });

  it('refuses thresholds outside 1..10000 bps and windows that are not positive integers', () => {
    expect(rugConfigIssues({ ...CFG, version: '' })).toEqual(['version must be a non-empty string']);
    expect(rugConfigIssues({ ...CFG, creatorDump: { supplyBps: 0, windowMs: 0 } })).toHaveLength(2);
    expect(rugConfigIssues({ ...CFG, collapse: { dropBps: 10_001, windowMs: 1.5 } })).toHaveLength(2);
    expect(rugConfigIssues({ ...CFG, creatorDump: { supplyBps: 1.5, windowMs: 2 ** 53 } })).toHaveLength(2);
    expect(rugConfigIssues({ ...CFG, collapse: { dropBps: 10_000, windowMs: 1 }, creatorDump: { supplyBps: 1, windowMs: 1 } })).toEqual([]);
  });
});

describe('leak test with a planted future rug', () => {
  const TOKEN = 'FutureRugMarker1111111111111111111111111111';
  const T = Number(T0) * 1_000;
  const MARKER: Moment = { slot: 2_000n, txIndex: 0, ixIndex: 0, receivedAt: T + 60_000 };
  const data = (program: string, name: string, d: Record<string, unknown>) => ({ event: { program, name, data: d } });
  const proof = (): ProofRun => {
    const events: FeedEvent[] = [
      // An honest launch by the same deployer before the marker.
      { kind: 'market', id: 'c0', moment: { slot: 1_000n, txIndex: 0, ixIndex: 0, receivedAt: T }, key: `pump:CreateEvent:${MINT}`, value: data('pump', 'CreateEvent', { mint: MINT, creator: DEV, user: DEV, timestamp: T0, tokenTotalSupply: SUPPLY }) },
    ];
    for (let k = 0; k < 6; k++) {
      events.push({ kind: 'market', id: `tick${k}`, moment: { slot: 1_990n + BigInt(k * 4), txIndex: OFF_CHAIN, ixIndex: OFF_CHAIN, receivedAt: T + 59_000 + k * 400 }, key: 'tick', value: k });
    }
    // Planted at the marker: the deployer launches the marker token and dumps it in the same slot.
    const ts = BigInt(MARKER.receivedAt / 1_000);
    events.push(
      { kind: 'market', id: 'p0', moment: MARKER, key: `pump:CreateEvent:${TOKEN}`, value: data('pump', 'CreateEvent', { mint: TOKEN, creator: DEV, user: DEV, timestamp: ts, tokenTotalSupply: SUPPLY }) },
      { kind: 'market', id: 'p1', moment: { ...MARKER, txIndex: 1 }, key: `pump:TradeEvent:${TOKEN}`, value: data('pump', 'TradeEvent', { mint: TOKEN, user: DEV, isBuy: false, tokenAmount: 900_000n, solAmount: 1n, realSolReserves: 0n, virtualSolReserves: 1n, virtualTokenReserves: 1n, timestamp: ts }) },
    );
    events.sort((a, b) => (a.moment.slot < b.moment.slot ? -1 : a.moment.slot > b.moment.slot ? 1 : a.moment.txIndex - b.moment.txIndex));
    const strategy = (): Strategy => {
      const labeller = new RugLabeller(CFG);
      const idx = new DeployerIndex();
      return {
        onMarket: (e, ctx) => {
          for (const f of labeller.observe(e)) idx.observe(f);
          idx.observe(e);
          if (e.key !== 'tick') return [];
          return [{ action: null, reasons: [`rugs=${idx.factFor(DEV, ctx.now, 0).rugs.map((r) => r.mint).join(',')}`] }];
        },
      };
    };
    return { events, strategy, seed: 'rug-1', book: CONFIG, start: { slot: 0n, txIndex: 0, ixIndex: 0, receivedAt: Number.MIN_SAFE_INTEGER } };
  };

  it('nothing before the marker sees the planted rug, and the label exists from the marker on', () => {
    const report = leakTest(proof(), { at: MARKER, token: TOKEN }, { rug: TOKEN });
    expect(report.violations).toEqual([]);
    const decisions = replayOnce(proof()).records.flatMap((r) => (r.type === 'decision' ? [r] : []));
    const before = decisions.filter((d) => d.at.slot < MARKER.slot);
    const after = decisions.filter((d) => d.at.slot > MARKER.slot);
    expect(before.length).toBeGreaterThan(0);
    expect(after.length).toBeGreaterThan(0);
    for (const d of before) expect(d.reasons).toEqual(['rugs=']);
    for (const d of after) expect(d.reasons).toEqual([`rugs=${TOKEN}`]);
  });
});
