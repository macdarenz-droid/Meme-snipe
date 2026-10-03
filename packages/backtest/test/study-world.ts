// A synthetic market with everything the BT-2 gates read, in the DATA-1 row shapes: for each mint a create with its
// raw record (authorities, extensions, supply), curve trades, the graduation and migration with the pool's creation
// (LP minted and burned), then PumpSwap swaps, every one with token balances, and a block every slot. Mints, deployers,
// price paths and the moments of everything are parameters, so tests can make one gate fail at a time.
import { createHash } from 'node:crypto';
import { bondingCurveAddress, encodeBase58, NATIVE_MINT, poolAddress, pumpPoolAuthority, TOKEN_2022_PROGRAM, toAddress } from '../../core/src/chain/index.ts';
import { replaySwap } from '../../core/src/fills/index.ts';
import { bps } from '../../core/src/units/index.ts';
import type { RawBalance, RawRow, TokenOp } from '../src/dataset/raw.ts';
import { RAW_EV_IDX } from '../src/dataset/raw.ts';
import type { AmmSwapRow, DatasetRow } from '../src/dataset/rows.ts';
import { compareRows } from '../src/dataset/rows.ts';
import { associatedTokenAddress } from '../src/sim/facts.ts';

export const key = (label: string): string => encodeBase58(createHash('sha256').update(label).digest());
export const sig = (label: string): string => encodeBase58(new Uint8Array([...createHash('sha256').update(`a${label}`).digest(), ...createHash('sha256').update(`b${label}`).digest()]));

export const W0 = Date.parse('2026-09-20T00:00:00Z');
export const WSLOT0 = 410_000_000n;
/** Slots per second in the world (0.4 s slots). */
export const SLOT_MS = 400;
export const SUPPLY = 1_000_000_000_000_000n;
export const CURVE_SOLD = 793_100_000_000_000n;

export interface MintPlan {
  readonly label: string;
  /** Creator wallet label (a deployer; reuse it for several mints to make a serial deployer). */
  readonly creator?: string;
  readonly createSlot: number;
  /** Slots from create to graduation (H9 needs >= 5 minutes = 750 slots). */
  readonly graduateAfter: number;
  /** Swap every this many slots after migration. */
  readonly swapEvery?: number;
  /** Probability a swap is a buy, by slots since migration (a price path). */
  readonly buyBias?: (since: number) => number;
  /** Skip the create's raw record (mint facts unknown). */
  readonly noCreateRaw?: boolean;
  /** The mint authority is left set at creation (H2). */
  readonly keepMintAuthority?: boolean;
  /** An extra Token-2022 extension set up on the mint (H4). */
  readonly extraExtension?: { readonly kind: string; readonly type: number };
  /** Quote reserve put in the pool at migration, lamports (H8 dust check). */
  readonly migrationQuote?: bigint;
  /** The dev keeps this share of supply (bps) from a buy in the create transaction (H12). */
  readonly devBuyBps?: number;
  /** The dev approves a delegate for this many tokens of its account in the create transaction (GATE-1e). */
  readonly devDelegate?: bigint;
  /** Omit the balances of one swap's raw record past this many slots after migration (a missed flow). */
  readonly dropBalancesAfter?: number;
  /** Largest random buy, lamports (default 2 SOL), and the share of a holder's tokens a sell takes (1/n, default 2). */
  readonly buySize?: number;
  readonly sellDivisor?: number;
  /** From this many slots after migration the pool charges these fees (a fee-config change such as B3). */
  readonly feesFrom?: { readonly since: number; readonly lp: number; readonly protocol: number; readonly creator: number };
  /** The first swap at or after this many slots since migration carries this tail (hex) in its event (H5). */
  readonly tail?: { readonly after: number; readonly hex: string };
  /** Stop the mint's swaps this many slots after migration (dead pool). */
  readonly swapsFor?: number;
}

export interface WorldOptions {
  readonly mints: readonly MintPlan[];
  /** Slots of data. */
  readonly slots: number;
  /** A block row every this many slots (default 1); slots holding a transaction always get theirs. */
  readonly blockEvery?: number;
  /** Days of sparse lead-in blocks (one an hour) before slot 0, so coverage starts that long before the market. */
  readonly leadInDays?: number;
  readonly seed?: string;
}

export interface WorldMint {
  readonly mint: string;
  readonly creator: string;
  readonly pool: string;
  readonly lpMint: string;
  readonly createSlot: number;
  readonly migrateSlot: number;
}

const FEES = { split: { lp: bps(20), protocol: bps(5), creator: bps(95) }, buybackFeeBps: bps(0), instruction: 'v1' as const };

export const slotTime = (s: number): number => Math.floor((W0 + s * SLOT_MS) / 1000);

/** Deterministic rows in chain order, and the addresses of each mint. */
export const studyWorld = (o: WorldOptions): { rows: DatasetRow[]; mints: WorldMint[] } => {
  const rows: DatasetRow[] = [];
  const seed = o.seed ?? 'w';
  let h = 7;
  const rnd = () => {
    h = (Math.imul(h ^ 0x5bd1e995, 1540483477) + 0x6b43a9b5) >>> 0;
    return h / 4294967296;
  };
  const txAt = new Map<number, number>();
  const nextTx = (s: number) => {
    const t = txAt.get(s) ?? 0;
    txAt.set(s, t + 1);
    return t;
  };
  const out: WorldMint[] = [];
  const plans = o.mints.map((p) => {
    const mint = key(`${seed}:mint:${p.label}`);
    const creator = key(`${seed}:creator:${p.creator ?? p.label}`);
    const auth = pumpPoolAuthority(toAddress(mint));
    const pool = poolAddress(0, auth, toAddress(mint), NATIVE_MINT);
    const lpMint = key(`${seed}:lp:${p.label}`);
    const curve = bondingCurveAddress(toAddress(mint));
    const curveAta = associatedTokenAddress(curve, mint, TOKEN_2022_PROGRAM);
    const vault = associatedTokenAddress(pool, mint, TOKEN_2022_PROGRAM);
    const migrateSlot = p.createSlot + p.graduateAfter;
    out.push({ mint, creator, pool, lpMint, createSlot: p.createSlot, migrateSlot });
    return { p, mint, creator, auth, pool, lpMint, curve, curveAta, vault, migrateSlot, holders: new Map<string, { owner: string; amount: bigint }>(), state: null as null | { baseReserve: bigint; quoteVault: bigint; virtualQuoteReserves: bigint }, dropped: false, tailed: false };
  });
  const raw = (s: number, tx: number, signature: string, mints: string[], balances: RawBalance[], ops: TokenOp[]): RawRow =>
    ({ kind: 'raw', slot: WSLOT0 + BigInt(s), blockTime: slotTime(s), txIdx: tx, evIdx: RAW_EV_IDX, signature, mints, balances, ops, undecodable: null });
  /** Moves `amount` between two token accounts of a plan, returning the balance rows. */
  const move = (pl: (typeof plans)[number], changes: { account: string; owner: string; delta: bigint }[]): RawBalance[] =>
    changes.map((c) => {
      const prev = pl.holders.get(c.account);
      const pre = prev?.amount ?? null;
      const post = (prev?.amount ?? 0n) + c.delta;
      if (post === 0n) pl.holders.delete(c.account);
      else pl.holders.set(c.account, { owner: c.owner, amount: post });
      return { account: c.account, mint: pl.mint, owner: c.owner, pre, post };
    });

  const lead = Math.floor((o.leadInDays ?? 0) * 24);
  for (let k = lead; k > 0; k--) {
    const s = -k * 9000;
    rows.push({ kind: 'block', slot: WSLOT0 + BigInt(s), blockTime: slotTime(s), parentSlot: WSLOT0 + BigInt(s) - 1n });
  }
  for (let s = 0; s < o.slots; s++) {
    const slot = WSLOT0 + BigInt(s);
    const blockTime = slotTime(s);
    for (const pl of plans) {
      const { p } = pl;
      if (s === p.createSlot) {
        const tx = nextTx(s);
        const signature = sig(`${seed}:create:${p.label}`);
        rows.push({
          kind: 'event', slot, blockTime, txIdx: tx, evIdx: 0, signature, program: 'pump', event: 'CreateEvent',
          fields: {
            name: p.label, symbol: p.label.slice(0, 4).toUpperCase(), uri: '', mint: pl.mint, bonding_curve: pl.curve, user: pl.creator, creator: pl.creator,
            timestamp: String(blockTime), token_total_supply: String(SUPPLY), token_program: TOKEN_2022_PROGRAM, quote_mint: '11111111111111111111111111111111', is_mayhem_mode: 'false',
          },
        });
        const dev = (SUPPLY * BigInt(p.devBuyBps ?? 0)) / 10_000n;
        const devAta = key(`${seed}:ata:${p.label}:dev`);
        // The chain state exists either way; only the record of it may be missing from the dataset.
        const balances = move(pl, [{ account: pl.curveAta, owner: pl.curve, delta: SUPPLY - dev }, ...(dev > 0n ? [{ account: devAta, owner: pl.creator, delta: dev }] : [])]);
        if (!p.noCreateRaw) {
          const ops: TokenOp[] = [
            { op: 'extension', program: TOKEN_2022_PROGRAM, mint: pl.mint, ext: { kind: 'MetadataPointer', type: 18 } },
            ...(p.extraExtension ? [{ op: 'extension' as const, program: TOKEN_2022_PROGRAM, mint: pl.mint, ext: p.extraExtension }] : []),
            { op: 'init-mint', program: TOKEN_2022_PROGRAM, mint: pl.mint, mintAuthority: key('pump-mint-authority'), freezeAuthority: null },
            { op: 'extension', program: TOKEN_2022_PROGRAM, mint: pl.mint, ext: { kind: 'TokenMetadata', type: 19 } },
            { op: 'mint-to', program: TOKEN_2022_PROGRAM, mint: pl.mint, amount: SUPPLY },
            ...(p.keepMintAuthority ? [] : [{ op: 'set-authority' as const, program: TOKEN_2022_PROGRAM, account: pl.mint, authorityType: 0, newAuthority: null }]),
            ...(p.devDelegate === undefined ? [] : [{ op: 'approve' as const, program: TOKEN_2022_PROGRAM, account: devAta, delegate: key(`${seed}:delegate:${p.label}`), amount: p.devDelegate }]),
          ];
          rows.push(raw(s, tx, signature, [pl.mint], balances, ops));
        }
      }
      // Curve buys between creation and graduation by 80 wallets, which sell most of the curve (the curve phase is not
      // traded); the same wallets trade the pool later.
      const step = Math.max(1, Math.floor(p.graduateAfter / 100));
      if (s > p.createSlot && s < pl.migrateSlot && (s - p.createSlot) % step === 1 && (s - p.createSlot - 1) / step < 100) {
        const tx = nextTx(s);
        const signature = sig(`${seed}:cb:${p.label}:${s}`);
        const k = (s - p.createSlot - 1) / step;
        const user = key(`${seed}:t:${p.label}:${k % 80}`);
        const amount = CURVE_SOLD / 100n;
        rows.push({
          kind: 'curve', slot, blockTime, txIdx: tx, evIdx: 0, signature, mint: pl.mint, isBuy: true, solAmount: 30_000_000n, tokenAmount: amount,
          virtualSolReserves: 31_000_000_000n, virtualTokenReserves: 1_000_000_000_000_000n, realSolReserves: 1_000_000_000n, realTokenReserves: 700_000_000_000_000n,
          mayhem: false, quoteMint: '11111111111111111111111111111111', user, extraHex: '',
        });
        rows.push(raw(s, tx, signature, [pl.mint], move(pl, [{ account: pl.curveAta, owner: pl.curve, delta: -amount }, { account: key(`${seed}:ata:${user}:${p.label}`), owner: user, delta: amount }]), []));
      }
      if (s === pl.migrateSlot) {
        const tx = nextTx(s);
        const signature = sig(`${seed}:mig:${p.label}`);
        const left = pl.holders.get(pl.curveAta)?.amount ?? 0n;
        const quote = p.migrationQuote ?? 85_000_000_000n;
        rows.push({ kind: 'event', slot, blockTime, txIdx: tx, evIdx: 0, signature, program: 'pump', event: 'CompleteEvent', fields: { mint: pl.mint, bonding_curve: pl.curve, user: pl.creator, timestamp: String(blockTime) } });
        rows.push({
          kind: 'event', slot, blockTime, txIdx: tx, evIdx: 1, signature, program: 'amm', event: 'CreatePoolEvent',
          fields: { index: '0', creator: pl.auth, base_mint: pl.mint, quote_mint: NATIVE_MINT, pool: pl.pool, lp_mint: pl.lpMint, lp_token_amount_out: '1000', is_mayhem_mode: 'false', pool_base_amount: String(left), pool_quote_amount: String(quote), timestamp: String(blockTime) },
        });
        rows.push({
          kind: 'event', slot, blockTime, txIdx: tx, evIdx: 2, signature, program: 'pump', event: 'CompletePumpAmmMigrationEvent',
          fields: { mint: pl.mint, pool: pl.pool, bonding_curve: pl.curve, sol_amount: String(quote), mint_amount: String(left), timestamp: String(blockTime) },
        });
        rows.push(raw(s, tx, signature, [pl.mint], move(pl, [{ account: pl.curveAta, owner: pl.curve, delta: -left }, { account: pl.vault, owner: pl.pool, delta: left }]), [
          { op: 'mint-to', program: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', mint: pl.lpMint, amount: 1000n },
          { op: 'burn', program: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', mint: pl.lpMint, amount: 1000n },
        ]));
        pl.state = { baseReserve: left, quoteVault: quote, virtualQuoteReserves: 0n };
      }
      const since = s - pl.migrateSlot;
      const every = p.swapEvery ?? 25;
      if (pl.state !== null && since > 0 && since % every === 0 && (p.swapsFor === undefined || since <= p.swapsFor)) {
        const buy = rnd() < (p.buyBias?.(since) ?? 0.5);
        const user = key(`${seed}:t:${p.label}:${Math.floor(rnd() * 80)}`);
        const ata = key(`${seed}:ata:${user}:${p.label}`);
        const heldBy = pl.holders.get(ata)?.amount ?? 0n;
        if (!buy && heldBy === 0n) continue;
        const tx = nextTx(s);
        const signature = sig(`${seed}:sw:${p.label}:${s}`);
        const swap: AmmSwapRow = {
          kind: 'amm', slot, blockTime, txIdx: tx, evIdx: 0, signature, pool: pl.pool, baseMint: pl.mint, quoteMint: NATIVE_MINT,
          side: buy ? 'buy' : 'sell', mode: buy ? 'exact-quote-in' : 'exact-base',
          amount: buy ? BigInt(Math.floor(rnd() * (p.buySize ?? 2e9))) + 50_000_000n : heldBy / BigInt(p.sellDivisor ?? 2) + 1n,
          baseAmount: 0n, quoteAmount: 0n, userQuote: 0n, pre: pl.state, baseSupply: SUPPLY,
          fees: p.feesFrom !== undefined && since >= p.feesFrom.since
            ? { ...FEES, split: { lp: bps(p.feesFrom.lp), protocol: bps(p.feesFrom.protocol), creator: bps(p.feesFrom.creator) } } : FEES,
          ixName: buy ? 'buy_exact_quote_in' : 'sell', user, lpFee: 0n, quoteLpAdjusted: 0n, extraHex: '',
        };
        const q = replaySwap(pl.state, swap);
        if (!q.ok) continue;
        const base = q.trade.base;
        const tailHere = p.tail !== undefined && since >= p.tail.after && !pl.tailed;
        if (tailHere) pl.tailed = true;
        rows.push({ ...swap, baseAmount: base, quoteAmount: buy ? swap.amount : q.trade.userQuote, extraHex: tailHere ? p.tail!.hex : '' });
        pl.state = q.trade.after;
        const balances = move(pl, [{ account: pl.vault, owner: pl.pool, delta: buy ? -base : base }, { account: ata, owner: user, delta: buy ? base : -base }]);
        const drop = p.dropBalancesAfter !== undefined && since > p.dropBalancesAfter && !pl.dropped;
        if (drop) pl.dropped = true;
        rows.push(raw(s, tx, signature, [pl.mint], drop ? [] : balances, []));
      }
    }
    if (s % (o.blockEvery ?? 1) === 0 || txAt.has(s)) rows.push({ kind: 'block', slot, blockTime, parentSlot: slot - 1n });
  }
  return { rows: rows.sort(compareRows), mints: out };
};

/** H17's pool-account record for the synthetic pools: a current layout, no cashback, the creator as coin creator. */
export const POOL_ACCOUNTS = () => ({ knownAtMs: 0, accountBytes: 300, isCashbackCoin: false, coinCreator: key('coin-creator') });
