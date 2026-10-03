// UPG-1: the undocumented 2026-10-02 upgrade of pump, PumpSwap and pump_fees (fixtures/upgrade-2026-10-02.json, real
// mainnet events from the blocks around each upgrade slot; docs/research/venues.md 2.7). Pins what DEC-1 does with the
// 8 bytes appended to TradeEvent, BuyEvent and SellEvent, and that every golden set the quotes and builders are
// checked against was recorded after the upgrade.
import { describe, expect, test } from 'vitest';
import { NATIVE_MINT, decodeEventBytes, decodeEventInstruction, fromHex } from '../../src/chain/index.ts';
import { readFixture } from './helpers.ts';

type Program = 'pump' | 'pump_amm';
interface Upgrade { program: string; slot: number; signature: string; elfSha256: string }
interface RawEvent { slot: number; signature: string; program: Program; event: string; data: string; instruction?: string }
interface Fixture { upgrades: Upgrade[]; boundary: RawEvent[]; nonzeroTail: RawEvent[] }

const fx = readFixture<Fixture>('upgrade-2026-10-02.json');
const PROGRAM_ID: Record<Program, string> = { pump: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', pump_amm: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA' };
/** The upgrade transaction's slot: the new code runs from the next slot on. */
const upgradeSlot = (p: Program): number => fx.upgrades.find((u) => u.program === PROGRAM_ID[p])!.slot;
const decode = (e: RawEvent) => {
  const d = decodeEventInstruction(e.program, fromHex(e.data));
  if (d === null || d.name === 'other') throw new Error(`${e.signature}: not a known event`);
  return d;
};
const u64le = (hex: string): bigint => BigInt(`0x${(hex.match(/../g) ?? []).reverse().join('') || '0'}`);

describe('2026-10-02 program upgrade', () => {
  test('the fixture spans both upgrade slots for every trade event', () => {
    for (const p of ['pump', 'pump_amm'] as const) {
      const events = fx.boundary.filter((e) => e.program === p);
      expect(events.some((e) => e.slot <= upgradeSlot(p))).toBe(true);
      expect(events.some((e) => e.slot > upgradeSlot(p))).toBe(true);
    }
    expect(new Set(fx.boundary.map((e) => e.event))).toEqual(new Set(['TradeEvent', 'BuyEvent', 'SellEvent']));
  });

  test.each(fx.boundary.map((e) => [`${e.event} slot ${e.slot} ${e.signature.slice(0, 8)}`, e] as const))('%s: 0 trailing bytes before, 8 after', (_, e) => {
    const d = decode(e);
    expect(d.name).toBe(e.event);
    expect(d.trailing).toBe(e.slot > upgradeSlot(e.program) ? 8 : 0);
    // SOL-quoted markets: the new bytes are zero.
    if (d.trailing > 0) expect(d.extra).toBe('00'.repeat(8));
  });

  test('the new bytes change no documented field: the same event without them decodes to the same value', () => {
    for (const e of [...fx.boundary, ...fx.nonzeroTail].filter((x) => x.slot > upgradeSlot(x.program))) {
      const d = decode(e);
      const bytes = fromHex(e.data).subarray(8);
      const cut = decodeEventBytes(e.program, bytes.subarray(0, bytes.length - 8));
      expect(cut.name).toBe(d.name);
      if (cut.name === 'other') throw new Error('unreachable');
      expect(cut.trailing).toBe(0);
      expect(cut.data).toEqual(d.data);
    }
  });

  test('non-zero tails occur on markets quoted in other tokens and are kept as raw hex', () => {
    expect(fx.nonzeroTail.length).toBeGreaterThan(0);
    for (const e of fx.nonzeroTail) {
      const d = decode(e);
      expect(d.trailing).toBe(8);
      expect(d.extra).not.toBe('00'.repeat(8));
      if (d.name === 'TradeEvent') expect(d.data.quoteMint).not.toBe(NATIVE_MINT);
    }
  });

  test('on a token-quoted curve, the tail read as a u64 grows by exactly each trade\'s creator fee (observation, not decoded)', () => {
    // Five sells of one curve in slot 452705218 and two of another in slot 452962220, in execution order.
    let pairs = 0;
    for (const slot of [452705218, 452962220]) {
      const trades = fx.nonzeroTail.filter((e) => e.slot === slot && e.event === 'TradeEvent').map(decode);
      for (let i = 1; i < trades.length; i++) {
        const [a, b] = [trades[i - 1]!, trades[i]!];
        if (a.name !== 'TradeEvent' || b.name !== 'TradeEvent') throw new Error('unreachable');
        if (b.data.mint !== a.data.mint) continue;
        expect(u64le(b.extra) - u64le(a.extra)).toBe(b.data.creatorFee);
        pairs++;
      }
    }
    expect(pairs).toBe(5);
  });

  test('on a token-quoted PumpSwap pool the tail does not follow the creator fee (meaning unknown)', () => {
    const pool = fx.nonzeroTail.filter((e) => e.slot === 452671696).map(decode);
    expect(pool.length).toBeGreaterThanOrEqual(2);
    expect(new Set(pool.map((d) => d.extra)).size).toBe(1);
    for (const d of pool) if (d.name === 'BuyEvent' || d.name === 'SellEvent') expect(d.data.coinCreatorFee).toBeGreaterThan(0n);
  });

  test('the three new discriminators seen since the upgrade are kept raw, never decoded', () => {
    for (const [program, disc] of [['pump', '742b4dbd117a482b'], ['pump_amm', '82a42461e48287a5'], ['pump', 'a943276d6686b6e8']] as const) {
      expect(decodeEventBytes(program, fromHex(disc + '00'.repeat(40)))).toEqual({ program, name: 'other', discriminator: disc });
    }
  });
});

describe('golden sets were recorded after the upgrade', () => {
  const after = (p: Program) => upgradeSlot(p) + 1;
  test('CORE-2 quote vectors (curve and PumpSwap)', () => {
    const g = readFixture<{ curve: { slot: number }[]; pumpswap: { slot: number }[] }>('../../amm/fixtures/golden.json');
    expect(g.curve.length + g.pumpswap.length).toBeGreaterThanOrEqual(50);
    for (const v of g.curve) expect(v.slot).toBeGreaterThanOrEqual(after('pump'));
    for (const v of g.pumpswap) expect(v.slot).toBeGreaterThanOrEqual(after('pump_amm'));
  });
  test('TX-1 compiled-message vectors', () => {
    const text = JSON.stringify(readFixture<unknown>('../../tx/fixtures/golden.json'));
    const slots = [...text.matchAll(/"slot":"?(\d+)/g)].map((m) => Number(m[1]));
    expect(slots.length).toBeGreaterThan(0);
    for (const s of slots) expect(s).toBeGreaterThanOrEqual(Math.max(after('pump'), after('pump_amm')));
  });
  test('DEC-1 transaction vectors', () => {
    const f = readFixture<{ transactions: { slot: number }[] }>('transactions.json');
    for (const t of f.transactions) expect(t.slot).toBeGreaterThanOrEqual(Math.max(after('pump'), after('pump_amm')));
  });
});
