// A sparse synthetic market for the survival study (RES-5): a block every 10 s, several graduates with a known fate
// (survive, die, rug), each with its creation, curve buys, migration and pool swaps, for long enough to read 24 h labels.
import { createHash } from 'node:crypto';
import { encodeBase58, NATIVE_MINT, poolAddress, pumpPoolAuthority, toAddress } from '../../core/src/chain/index.ts';
import { replaySwap } from '../../core/src/fills/index.ts';
import type { PoolState } from '../../core/src/amm/index.ts';
import { bps } from '../../core/src/units/index.ts';
import type { OffchainSeries } from '../src/dataset/offchain.ts';
import type { AmmSwapRow, DatasetRow } from '../src/dataset/rows.ts';

export const key = (label: string): string => encodeBase58(createHash('sha256').update(label).digest());
const sig = (label: string): string => encodeBase58(new Uint8Array([...createHash('sha256').update(`a${label}`).digest(), ...createHash('sha256').update(`b${label}`).digest()]));

export const S_T0 = Date.parse('2026-09-10T00:00:00Z');
export const STEP_S = 10;
const SLOT0 = 440_000_000n;
const HOUR_STEPS = 3600 / STEP_S;

export type Fate = 'survive' | 'die' | 'rug';
export interface Graduate {
  readonly name: string;
  readonly creator: string;
  readonly fate: Fate;
  /** Hours after S_T0 when the mint is created; migration follows 10 minutes later. */
  readonly createdAtH: number;
}

export interface SurvivalFixture {
  readonly rows: DatasetRow[];
  readonly mints: Readonly<Record<string, { mint: string; pool: string; migratedAtMs: number }>>;
}

const FEES = { split: { lp: bps(20), protocol: bps(5), creator: bps(95) }, buybackFeeBps: bps(5000), instruction: 'v1' as const };

export const survivalRows = (graduates: readonly Graduate[], hours: number): SurvivalFixture => {
  const rows: DatasetRow[] = [];
  const steps = Math.ceil(hours * HOUR_STEPS);
  const g = graduates.map((x, k) => {
    const mint = key(`surv:${x.name}`);
    const auth = pumpPoolAuthority(toAddress(mint));
    const pool = poolAddress(0, auth, toAddress(mint), NATIVE_MINT);
    const create = Math.round(x.createdAtH * HOUR_STEPS);
    return { ...x, k, mint, auth, pool, create, migrate: create + 60, state: { baseReserve: 206_900_000_000_000n, quoteVault: 85_000_000_000n, virtualQuoteReserves: 0n } as PoolState };
  });
  const out: SurvivalFixture['mints'] = Object.fromEntries(g.map((x) => [x.name, { mint: x.mint, pool: x.pool, migratedAtMs: S_T0 + x.migrate * STEP_S * 1000 }]));
  for (let s = 0; s < steps; s++) {
    const slot = SLOT0 + BigInt(s);
    const blockTime = Math.floor(S_T0 / 1000) + s * STEP_S;
    let tx = 0;
    for (const x of g) {
      if (s === x.create) {
        rows.push({ kind: 'event', slot, blockTime, txIdx: tx, evIdx: 0, signature: sig(`c:${x.name}`), program: 'pump', event: 'CreateEvent',
          fields: { mint: x.mint, creator: x.creator, user: x.creator, token_total_supply: '1000000000000000' } });
        rows.push({ kind: 'curve', slot, blockTime, txIdx: tx, evIdx: 1, signature: sig(`c:${x.name}`), mint: x.mint, isBuy: true, solAmount: 1_000_000_000n, tokenAmount: 30_000_000_000_000n,
          virtualSolReserves: 31_000_000_000n, virtualTokenReserves: 1_000_000_000_000_000n, realSolReserves: 1_000_000_000n, realTokenReserves: 763_000_000_000_000n, mayhem: false, quoteMint: NATIVE_MINT, user: x.creator, userTokenAccount: key(`ata:${x.creator}:${x.mint}`), userTokenOwner: x.creator });
        tx++;
      }
      if (s === x.create + 5) {
        for (let b = 0; b < 3; b++) {
          rows.push({ kind: 'curve', slot, blockTime, txIdx: tx, evIdx: 0, signature: sig(`cb:${x.name}:${b}`), mint: x.mint, isBuy: true, solAmount: 2_000_000_000n, tokenAmount: 50_000_000_000_000n,
            virtualSolReserves: 40_000_000_000n, virtualTokenReserves: 900_000_000_000_000n, realSolReserves: 10_000_000_000n, realTokenReserves: 600_000_000_000_000n, mayhem: false, quoteMint: NATIVE_MINT, user: key(`early:${x.name}:${b}`), userTokenAccount: key(`ata:early:${x.name}:${b}`), userTokenOwner: key(`early:${x.name}:${b}`) });
          tx++;
        }
      }
      if (s === x.migrate) {
        const signature = sig(`m:${x.name}`);
        rows.push({ kind: 'event', slot, blockTime, txIdx: tx, evIdx: 0, signature, program: 'amm', event: 'CreatePoolEvent',
          fields: { index: '0', creator: x.auth, base_mint: x.mint, quote_mint: NATIVE_MINT, pool: x.pool, is_mayhem_mode: 'false' } });
        rows.push({ kind: 'event', slot, blockTime, txIdx: tx, evIdx: 1, signature, program: 'pump', event: 'CompletePumpAmmMigrationEvent', fields: { mint: x.mint, pool: x.pool } });
        tx++;
      }
      const age = s - x.migrate;
      if (age <= 0 || age % 12 !== 0) continue;
      const ageH = age / HOUR_STEPS;
      // Survivors trade both ways around a flat price; the dying sell down after 2 h and go quiet after 20 h; rugs dump at 1 h.
      let buy: boolean;
      let amount: bigint;
      if (x.fate === 'survive') {
        buy = (age / 12) % 2 === 0;
        amount = buy ? 500_000_000n : 0n;
      } else if (x.fate === 'die') {
        if (ageH > 20) continue;
        buy = ageH < 2 && (age / 12) % 2 === 0;
        amount = buy ? 500_000_000n : 0n;
      } else {
        buy = ageH < 1 && (age / 12) % 2 === 0;
        amount = buy ? 500_000_000n : 0n;
      }
      if (!buy) {
        // Normal two-way trade: 0.25% of the base reserve; a dump: 2.5% (die) or 6% (rug) of it per sell.
        const normal = x.fate === 'survive' || (x.fate === 'die' && ageH < 2) || (x.fate === 'rug' && ageH < 1);
        amount = normal ? x.state.baseReserve / 400n : (x.state.baseReserve * (x.fate === 'rug' ? 60n : 25n)) / 1000n;
        if (amount <= 0n) continue;
      }
      const swap: AmmSwapRow = {
        kind: 'amm', slot, blockTime, txIdx: tx, evIdx: 0, signature: sig(`sw:${x.name}:${s}`), pool: x.pool, baseMint: x.mint, quoteMint: NATIVE_MINT,
        side: buy ? 'buy' : 'sell', mode: buy ? 'exact-quote-in' : 'exact-base', amount, baseAmount: 0n, quoteAmount: 0n, userQuote: 0n, pre: x.state,
        fees: FEES, baseSupply: 1_000_000_000_000_000n, ixName: buy ? 'buy_exact_quote_in' : 'sell', user: key(`u:${x.name}:${s % 97}`),
        userTokenAccount: key(`ata:u:${x.name}:${s % 97}`), userTokenOwner: key(`u:${x.name}:${s % 97}`),
      };
      const q = replaySwap(x.state, swap);
      if (!q.ok) continue;
      rows.push(swap);
      x.state = q.trade.after;
      tx++;
    }
    rows.push({ kind: 'block', slot, blockTime, parentSlot: slot - 1n });
  }
  return { rows, mints: out };
};

export const SURV_SOL_USD: OffchainSeries = {
  name: 'SOL/USD', source: 'synthetic', tag: 'fixed', barMs: 3_600_000, fetchedAt: S_T0,
  bars: Array.from({ length: 80 }, (_, k) => ({ start: S_T0 - 6 * 3_600_000 + k * 3_600_000, close: '120.00' })),
};
