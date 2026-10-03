// A small synthetic market in the DATA-1 row shapes: one graduated mint with a canonical PumpSwap pool, a block every
// slot and swaps through the pool for several hours. Used where real data is not needed (unit and property tests).
import { createHash } from 'node:crypto';
import { encodeBase58, NATIVE_MINT, poolAddress, pumpPoolAuthority, toAddress } from '../../core/src/chain/index.ts';
import { replaySwap } from '../../core/src/fills/index.ts';
import { bps } from '../../core/src/units/index.ts';
import type { OffchainSeries } from '../src/dataset/offchain.ts';
import type { AmmSwapRow, DatasetRow } from '../src/dataset/rows.ts';

export const key = (label: string): string => encodeBase58(createHash('sha256').update(label).digest());
const sig = (label: string): string => encodeBase58(new Uint8Array([...createHash('sha256').update(`a${label}`).digest(), ...createHash('sha256').update(`b${label}`).digest()]));

export const T0 = Date.parse('2026-09-20T00:00:00Z');
const SLOT0 = 400_000_000n;

export interface SyntheticOptions {
  readonly mints?: number;
  /** Slots of data (2.5 slots a second). */
  readonly slots?: number;
  /** A swap every this many slots per mint. */
  readonly swapEvery?: number;
  readonly seed?: string;
}

/** Deterministic rows, in chain order. */
export const syntheticRows = (o: SyntheticOptions = {}): DatasetRow[] => {
  const mints = o.mints ?? 1;
  const slots = o.slots ?? 2.5 * 3600 * 5;
  const every = o.swapEvery ?? 20;
  const seed = o.seed ?? 'syn';
  const rows: DatasetRow[] = [];
  const pools = Array.from({ length: mints }, (_, k) => {
    const mint = key(`${seed}:mint:${k}`);
    const auth = pumpPoolAuthority(toAddress(mint));
    const pool = poolAddress(0, auth, toAddress(mint), NATIVE_MINT);
    return { k, mint, auth, pool, state: { baseReserve: 206_900_000_000_000n, quoteVault: 84_990_000_000n, virtualQuoteReserves: 0n } };
  });
  let h = 0;
  const rnd = () => {
    h = (Math.imul(h ^ 0x5bd1e995, 1540483477) + 0x6b43a9b5) >>> 0;
    return h / 4294967296;
  };
  for (let s = 0; s < slots; s++) {
    const slot = SLOT0 + BigInt(s);
    const blockTime = Math.floor((T0 + s * 400) / 1000);
    let tx = 0;
    for (const p of pools) {
      if (s === 10 + p.k) {
        const signature = sig(`${seed}:mig:${p.k}`);
        rows.push({ kind: 'event', slot, blockTime, txIdx: tx, evIdx: 0, signature, program: 'amm', event: 'CreatePoolEvent',
          fields: { index: '0', creator: p.auth, base_mint: p.mint, quote_mint: NATIVE_MINT, pool: p.pool, is_mayhem_mode: 'false' } });
        rows.push({ kind: 'event', slot, blockTime, txIdx: tx, evIdx: 1, signature, program: 'pump', event: 'CompletePumpAmmMigrationEvent',
          fields: { mint: p.mint, pool: p.pool, bonding_curve: key(`bc${p.k}`) } });
        tx++;
      }
      if (s > 20 + p.k && (s + p.k) % every === 0) {
        const buy = rnd() < 0.5;
        const swap: AmmSwapRow = {
          kind: 'amm', slot, blockTime, txIdx: tx, evIdx: 0, signature: sig(`${seed}:sw:${p.k}:${s}`), pool: p.pool, baseMint: p.mint, quoteMint: NATIVE_MINT,
          side: buy ? 'buy' : 'sell', mode: buy ? 'exact-quote-in' : 'exact-base',
          amount: buy ? BigInt(Math.floor(rnd() * 2e9)) + 10_000_000n : BigInt(Math.floor(rnd() * 3e12)) + 1_000_000n,
          baseAmount: 0n, quoteAmount: 0n, userQuote: 0n, pre: p.state,
          fees: { split: { lp: bps(20), protocol: bps(5), creator: bps(95) }, buybackFeeBps: bps(5000), instruction: 'v1' },
          baseSupply: 1_000_000_000_000_000n, ixName: buy ? 'buy_exact_quote_in' : 'sell', user: key(`u${s}`),
        };
        const q = replaySwap(p.state, swap);
        if (q.ok) {
          rows.push(swap);
          p.state = q.trade.after;
          tx++;
        }
      }
    }
    rows.push({ kind: 'block', slot, blockTime, parentSlot: slot - 1n });
  }
  return rows;
};

export const SOL_USD: OffchainSeries = {
  name: 'SOL/USD', source: 'synthetic', tag: 'fixed', barMs: 3_600_000, fetchedAt: T0,
  bars: Array.from({ length: 48 }, (_, k) => ({ start: T0 - 6 * 3_600_000 + k * 3_600_000, close: (120 + (k % 5)).toFixed(2) })),
};
