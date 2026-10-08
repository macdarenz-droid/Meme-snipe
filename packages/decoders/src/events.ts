// Transaction reader and self-CPI event decoder (A-M02-03). Events come from inner instructions that start with the
// Anchor event-CPI prefix [DA-16], only from successful transactions, and only when the emitting pump program is the
// event instruction's direct invoker (self-CPI), so a third program cannot inject fills.
// Ported from Snipe-solana card C03 (#6 @ 6ae4d62): supervisor ruling d0f97ba (direct invoker by stackHeight),
// review fixes C03-R1-1, R2 (lazy base58, `oversized`) and R9 (`bad_trace`) included.
import type { BaseUnits, Bps, DecodedEvent, Lamports, Pubkey, RawTransaction, Result, Signature, Slot } from '@bot/types';
import { base58, DecodeError, Reader, toHex } from './codec.ts';
import type { IdlTypeDef, PinnedIdl } from './idl.ts';

/** Anchor event-CPI prefix (the `emit_cpi!` instruction tag) [DA-16]. */
export const EVENT_CPI_PREFIX = 'e445a52e51cb9a1d';

/**
 * `decode_gap_total` reasons: `bad_trace` (an event-CPI instruction of a pump program whose invoker cannot be told: an
 * inconsistent stackHeight trace, or a group whose top-level instruction or program is missing; review C03 R9) and
 * `oversized` (pump or PumpSwap instruction data longer than any event, never decoded; review C03 R2) join the three
 * reasons of A-M02-03. Card IDL-REPIN adds `unpinned_invoker`: a PumpSwap trade invoked by an instruction whose quote
 * mint the pin does not let the decoder read (one the pinned IDL does not list, or `multi_hop_swap`, see
 * `invokerQuoteMint`); it is never labelled `non_sol_quote`, which means a quote mint read and found not SOL.
 */
export type GapReason = 'no_inner' | 'truncated' | 'unknown_disc' | 'bad_trace' | 'oversized' | 'non_sol_quote' | 'unpinned_invoker';
/**
 * The pool part of a pump curve buy that completes the curve (card IDL-REPIN): `base_out` tokens for `quote_in` SOL,
 * with the fees on that part (pump-public-docs 8cda1fa, docs/SYNTHETIC_MIGRATION.md "Events and state"). Only from a
 * SOL curve (ruling 3). It is not a `DecodedEvent` variant: `@bot/types` is frozen at 1.0.0 and a new variant needs a
 * version with both sign-offs (packages/types/CHANGELOG.md), so it stays in this package until then; `decodeEvents`
 * leaves it out, the located decoders return it, and `pumpBuyTotals` counts it into the buyer's total.
 */
export interface PumpPostCompleteBuy {
  kind: 'pump_post_complete_buy'; mint: Pubkey; solAmount: Lamports; tokenAmount: BaseUnits; feeBps: Bps; fee: Lamports;
  creatorFeeBps: Bps; creatorFee: Lamports; quoteMint: null; slot: Slot; signature: Signature;
}
/** Every event M02 decodes: the `DecodedEvent` variants and `PumpPostCompleteBuy`. */
export type M02Event = DecodedEvent | PumpPostCompleteBuy;

/**
 * A gap with its place (card IDL-REPIN, ruling 37): the instruction it sat at and, when its discriminator was read, the
 * IDL event name, so `pumpBuyTotals` can tell a buy whose parts did not all decode. `no_inner` has no place and is not
 * reported here.
 */
export interface LocatedGap { signature: Signature; outerIx: number; innerIx: number; reason: GapReason; event: string | null }

export interface EventHooks {
  /** `decode_events_total{kind}` and `decode_gap_total{reason}` (M27). */
  onEvent?(kind: M02Event['kind']): void;
  onGap?(reason: GapReason): void;
  /** Every gap but `no_inner`, with its place (ruling 37); called after `onGap`. */
  onGapAt?(gap: LocatedGap): void;
  /**
   * `decode_layout_extended_total{kind}` (M27; Z03 ruling 2): the event's data holds `bytes` more than the pinned layout
   * describes, as TradeEvent, BuyEvent and SellEvent did under the earlier pin cb188ce (pump appended
   * `creator_fee_unclaimed: u64` on 2026-10-02; the 8cda1fa pin describes it). A newer layout is pinned only in its own
   * reviewed change, so until then such events carry `layoutExtended` and are counted.
   */
  onLayoutExtended?(kind: M02Event['kind'], bytes: number): void;
  /** `m02.unknown_event` (the registry logs it once per discriminator per hour). */
  onUnknown?(programId: Pubkey, discriminatorHex: string, signature: Signature): void;
}

type Ix = RawTransaction['message']['instructions'][number];
/**
 * An inner instruction as `readRpcTransaction` reads it: with the RPC's `stackHeight` when the node reported one. A
 * top-level instruction has height 1 and each CPI level adds one (solana.com/docs/rpc/json-structures, read
 * 2026-10-07: "Transaction-level instruction stack height. This is currently 1 for top-level instructions"; every
 * recorded fixture agrees). The shared `RawTransaction` type does not name the field, so a transaction built without
 * it takes the top-level parent rule of logic 3. `dataLength58` is the length of the base58 data the RPC sent; it
 * lets the decoder refuse data too long for an event without decoding it (dropped when `dataB64` is assigned).
 */
export type InnerIx = Ix & { stackHeight?: number; dataLength58?: number };
const MAX_BPS = 10_000n;

/**
 * POLICY (review C03 R2): the longest instruction data the event decoder reads. The largest fixed-size event of the
 * pinned IDLs is PumpSwap's BuyEvent (466 bytes after the 16 bytes of prefix and discriminator); pump's TradeEvent is
 * 355 bytes plus a short `ix_name` and 34 bytes per fee shareholder, so 2 KiB leaves room for more than 40 of them.
 * CPI data may be 10 KiB per instruction, and Anchor ignores trailing data, so longer data from a pump program is a
 * crafted instruction: it is never decoded and counts an `oversized` gap.
 */
export const MAX_EVENT_DATA_BYTES = 2_048;
/** Base58 text longer than this decodes to more than MAX_EVENT_DATA_BYTES: L characters give more than (L − 1) × 0.732 bytes. */
const MAX_EVENT_DATA_B58 = Math.ceil(MAX_EVENT_DATA_BYTES / 0.732) + 1;

/** `Pubkey::default()`: a pump `quote_mint` with this value means native SOL [DA-V01]; it never leaves the decoder (Z03 m6). */
const DEFAULT_PUBKEY = base58.encode(new Uint8Array(32));

/**
 * What the decoder needs to tell a SOL quote (Z03 ruling 3): the wrapped SOL mint (A-M01-01 `MINTS.wsol`, passed in so
 * this package keeps no address literal and no dependency). Without it no PumpSwap trade is SOL-quoted (fail closed).
 */
export interface QuoteMints { wsolMint?: Pubkey }

/**
 * An event with where it sat in its transaction (Z03 ruling m11): `outerIx` is the top-level instruction, `innerIx`
 * its position in that instruction's inner list, so with the signature a second delivery of the same event is told
 * from a second fill. `layoutExtended`: the event's data held bytes the pinned layout does not describe (ruling 2).
 * `shortLegacy`: the event was emitted before fields the pin appends existed, and reads them as 0 (card IDL-REPIN); a
 * consumer that reads an appended field checks it (IDL-REPIN-2). `multiHop`: a PumpSwap `multi_hop_swap` instruction
 * or pump `multi_hop_curve_swap` is among the event's invokers, or the invoker chain cannot be followed (rulings 38,
 * 44), so it is one hop of a route, not a trade of its own.
 */
export interface LocatedEvent { event: M02Event; outerIx: number; innerIx: number; layoutExtended: boolean; shortLegacy: boolean; multiHop: boolean }

/**
 * POLICY (card IDL-REPIN): the last field each event had at the previous pin cb188ce, for the events pump-public-docs
 * 8cda1fa lengthens by appending (`creator_fee_unclaimed` on TradeEvent, BuyEvent and SellEvent; `depth` on CreateEvent;
 * every other field unchanged, checked against both IDLs). Events emitted before those fields existed are shorter;
 * "Logs emitted before the new fields existed are shorter; read the missing fields as `0` / `false`"
 * (docs/HOLDER_REWARDS_README.md, 8cda1fa). An event whose data ends on a field boundary at or after that field reads
 * the rest as zero, so every event the previous pin decoded still decodes; data ending inside a field is `truncated`.
 */
const EVENT_PADDED_FROM: Readonly<Record<string, string>> = {
  'pump.TradeEvent': 'holder_rewards', 'pump.CreateEvent': 'is_holder_reward',
  'pump_amm.BuyEvent': 'holder_rewards', 'pump_amm.SellEvent': 'holder_rewards',
};
/** Zero bytes the missing trailing fields of a short legacy event are read from (the appended fields are a few bytes). */
const ZERO_TAIL = new Uint8Array(64);

/** Reads an event's fields; a short legacy event (see EVENT_PADDED_FROM) reads its missing trailing fields from zeros. */
function readEvent(idl: PinnedIdl['name'], def: IdlTypeDef, body: Uint8Array): { value: Record<string, unknown>; extra: number; shortLegacy: boolean } {
  const r = new Reader(body);
  const from = EVENT_PADDED_FROM[`${idl}.${def.name}`];
  const at = from === undefined ? -1 : def.fields.findIndex((f) => f.name === from);
  if (at < 0) {
    const value = def.read(r) as Record<string, unknown>;
    return { value, extra: r.remaining(), shortLegacy: false };
  }
  const value: Record<string, unknown> = {};
  let zeros: Reader | null = null;
  for (const [i, f] of def.fields.entries()) {
    if (zeros === null && i > at && r.remaining() === 0) zeros = new Reader(ZERO_TAIL);
    value[f.name] = f.read(zeros ?? r);
  }
  return { value, extra: r.remaining(), shortLegacy: zeros !== null };
}

function bps(v: unknown): Bps {
  if (typeof v !== 'bigint' || v > MAX_BPS) throw new DecodeError('E_BAD_VALUE', 'a fee is at most 10,000 bps');
  return Number(v);
}

/** Z03 ruling m10: the fees of one trade add up to at most 10,000 bps, or the event is refused. */
function fitsTotal(...fees: Bps[]): void {
  if (fees.reduce((a, b) => a + b, 0) > Number(MAX_BPS)) throw new DecodeError('E_BAD_VALUE', 'fees add up to more than 10,000 bps');
}

/** The default pubkey as null (native SOL); any other mint as itself (Z03 m6). */
const quoteMintOf = (v: unknown): Pubkey | null => (v === DEFAULT_PUBKEY ? null : v as Pubkey);

/** Thrown for a trade whose quote is not SOL, so it never yields Lamports (Z03 ruling 3); counted as `non_sol_quote`. */
class NonSolQuote extends Error {}
/** Thrown for a PumpSwap trade whose invoker's quote mint the pin does not let the decoder read (card IDL-REPIN). */
class UnpinnedInvoker extends Error {}

const gapOf = (e: unknown): GapReason => (e instanceof NonSolQuote ? 'non_sol_quote' : e instanceof UnpinnedInvoker ? 'unpinned_invoker' : 'truncated');

/**
 * Maps a decoded IDL event to its `DecodedEvent` variant; null for an event the system does not use. `poolQuoteMint`
 * gives the PumpSwap pool's quote mint, or null when its invoker binds none (ruling 3); it throws `UnpinnedInvoker` when
 * the quote mint cannot be read (card IDL-REPIN).
 */
function mapEvent(idl: PinnedIdl['name'], name: string, v: Record<string, unknown>, slot: Slot, signature: Signature,
  poolQuoteMint: () => Pubkey | null, wsolMint: Pubkey | undefined): M02Event | null {
  const key = `${idl}.${name}`;
  if (key === 'pump.TradeEvent') {
    // Ruling 3: `sol_amount` is Lamports only on a SOL curve; pump coins may also trade against other mints (pump-public-
    // docs 8cda1fa: "pump coins as quote mints"), where `sol_amount` is 0 and the amount is `quote_amount`.
    const quoteMint = quoteMintOf(v.quote_mint);
    if (quoteMint !== null) throw new NonSolQuote();
    const feeBps = bps(v.fee_basis_points);
    const creatorFeeBps = bps(v.creator_fee_basis_points);
    fitsTotal(feeBps, creatorFeeBps);
    return {
      kind: 'pump_trade', mint: v.mint as Pubkey, isBuy: v.is_buy as boolean, solAmount: v.sol_amount as Lamports,
      tokenAmount: v.token_amount as BaseUnits, feeBps, fee: v.fee as Lamports,
      creatorFeeBps, creatorFee: v.creator_fee as Lamports, quoteMint, slot, signature,
    };
  }
  if (key === 'pump.CompleteEvent') return { kind: 'pump_complete', mint: v.mint as Pubkey, slot, signature };
  if (key === 'pump.PostCompleteBuyEvent') {
    // The pool part of a buy that completes a curve (pump-public-docs 8cda1fa, docs/SYNTHETIC_MIGRATION.md "Events and
    // state": "the buyer's total is the TradeEvent amounts plus the PostCompleteBuyEvent amounts"); see `pumpBuyTotals`.
    if (quoteMintOf(v.quote_mint) !== null) throw new NonSolQuote();          // ruling 3: `quote_in` is Lamports only on a SOL curve
    const feeBps = bps(v.fee_basis_points);
    const creatorFeeBps = bps(v.creator_fee_basis_points);
    fitsTotal(feeBps, creatorFeeBps);
    return {
      kind: 'pump_post_complete_buy', mint: v.mint as Pubkey, solAmount: v.quote_in as Lamports, tokenAmount: v.base_out as BaseUnits,
      feeBps, fee: v.fee as Lamports, creatorFeeBps, creatorFee: v.creator_fee as Lamports, quoteMint: null, slot, signature,
    };
  }
  if (key === 'pump.CompletePumpAmmMigrationEvent') {
    if (quoteMintOf(v.quote_mint) !== null) throw new NonSolQuote();          // ruling 3: `sol_amount` is Lamports only on a SOL curve
    return {
      kind: 'pump_migration', mint: v.mint as Pubkey, pool: v.pool as Pubkey, baseAmount: v.mint_amount as BaseUnits,
      solAmount: v.sol_amount as Lamports, poolMigrationFee: v.pool_migration_fee as Lamports, slot, signature,
    };
  }
  // PumpSwap: quoteAmount is the pool-side amount (`quote_amount_in` / `quote_amount_out`), fees excluded. On every
  // recorded event user_quote_amount_in = quote_amount_in + lp_fee + protocol_fee + coin_creator_fee, and the sell
  // mirror of it (U-A05, U-A10: field names from the pinned pump_amm.json).
  if (key === 'pump_amm.BuyEvent' || key === 'pump_amm.SellEvent') {
    // Ruling 3: `quoteAmount` is Lamports only when the pool's quote mint is wSOL.
    if (wsolMint === undefined || poolQuoteMint() !== wsolMint) throw new NonSolQuote();
    const buy = name === 'BuyEvent';
    const lpFeeBps = bps(v.lp_fee_basis_points);
    const protocolFeeBps = bps(v.protocol_fee_basis_points);
    const coinCreatorFeeBps = bps(v.coin_creator_fee_basis_points);
    fitsTotal(lpFeeBps, protocolFeeBps, coinCreatorFeeBps);
    return {
      kind: buy ? 'pumpswap_buy' : 'pumpswap_sell', pool: v.pool as Pubkey,
      baseAmount: (buy ? v.base_amount_out : v.base_amount_in) as BaseUnits, quoteAmount: (buy ? v.quote_amount_in : v.quote_amount_out) as Lamports,
      lpFeeBps, protocolFeeBps, coinCreatorFeeBps, virtualQuoteReserves: v.virtual_quote_reserves as bigint, slot, signature,
    };
  }
  if (key === 'pump_amm.InitBoostEvent') return { kind: 'pumpswap_init_boost', pool: v.pool as Pubkey, virtualQuoteReserves: v.virtual_quote_reserves as bigint, slot, signature };
  return null;
}

const validHeight = (h: unknown): h is number => typeof h === 'number' && Number.isSafeInteger(h) && h >= 2;

/**
 * The stack heights of a group's inner instructions: `null` when none carries one (logic 3 then falls back to the
 * top-level parent rule), `'bad'` when only some do or one is not an integer of at least 2 (no event is trusted).
 */
function heightsOf(ixs: readonly InnerIx[]): number[] | null | 'bad' {
  const hs = ixs.map((ix) => ix.stackHeight);
  if (hs.every((h) => h === undefined || h === null)) return null;
  return hs.every(validHeight) ? hs : 'bad';
}

/**
 * The index of the direct invoker of instruction `k` (logic 3, supervisor ruling 2026-10-07): -1 for the top-level
 * instruction when its height is 2, otherwise the nearest earlier instruction of the group one level up. The first
 * earlier instruction below height h must be at h - 1 (a valid call trace); any other trace gives undefined.
 */
function invokerIndex(k: number, hs: readonly number[]): number | undefined {
  const h = hs[k] as number;
  if (h === 2) return -1;
  for (let j = k - 1; j >= 0; j--) {
    const hj = hs[j] as number;
    if (hj < h) return hj === h - 1 ? j : undefined;
  }
  return undefined;
}

/**
 * Decodes pump and PumpSwap events from a transaction's inner instructions (logic 1-6). Failed transactions give no
 * events. An event-CPI instruction is accepted only when its direct invoker is the same program (logic 3, supervisor
 * ruling 2026-10-07): found by `stackHeight`, so trades and completions routed through an aggregator decode, and
 * PumpSwap's events inside pump's `migrate` decode because PumpSwap invoked them. Without stack heights the parent
 * top-level instruction must be the same program.
 */
export function decodeEvents(tx: RawTransaction, idls: readonly PinnedIdl[], hooks: EventHooks = {}, quote: QuoteMints = {}): DecodedEvent[] {
  return decodedOnly(decodeEventsLocated(tx, idls, hooks, quote));
}

/** The `DecodedEvent`s of located events: `pump_post_complete_buy` is left out (see `PumpPostCompleteBuy`). */
export function decodedOnly(events: readonly LocatedEvent[]): DecodedEvent[] {
  return events.flatMap((e) => (e.event.kind === 'pump_post_complete_buy' ? [] : [e.event]));
}

/**
 * The PumpSwap pool's quote mint for an event its program emitted (ruling 3): the `quote_mint` account of the PumpSwap
 * instruction that invoked the event-CPI, only when the pinned IDL marks that account `relations: ["pool"]` (Anchor
 * `has_one`: the program refuses an instruction whose `quote_mint` is not the pool's; ruling 14, the set built at IDL
 * load: at 8cda1fa `buy`, `buy_v2`, `buy_exact_quote_in`, `buy_exact_quote_in_v2`, `sell`, `sell_v2`, `deposit`,
 * `withdraw`, `init_boost`, `boost_buy_and_burn`, `sweep_creator_fee`, `sweep_protocol_fee`). Null for any other
 * pinned invoker (`create_pool` among them), so its event gets no quote and is refused (`non_sol_quote`). Card
 * IDL-REPIN: an invoker the pin does not list throws `UnpinnedInvoker`, and so does `multi_hop_swap`. Its hops are
 * remaining accounts the IDL does not describe; pump-public-docs 8cda1fa (docs/instructions/MULTI_HOP_SWAP.md,
 * "Remaining accounts (5 per hop)") names slot 2 of each hop as its quote mint, but that the program checks the slot
 * against the pool is UNVERIFIED, so its trades stay dropped until a golden fixture from a real multi-hop transaction
 * proves it (supervisor ruling, docs/reviews/Z03.md "IDL-REPIN").
 */
function invokerQuoteMint(invoker: Ix | undefined, idl: PinnedIdl, keys: readonly Pubkey[]): Pubkey | null {
  if (invoker === undefined) return null;
  const length58 = (invoker as InnerIx).dataLength58;
  if (length58 !== undefined && length58 > MAX_EVENT_DATA_B58) throw new UnpinnedInvoker();
  const data = Buffer.from(invoker.dataB64, 'base64');
  if (data.length < 8 || data.length > MAX_EVENT_DATA_BYTES) throw new UnpinnedInvoker();
  const disc = data.subarray(0, 8).toString('hex');
  // Ruling 14: only an instruction the IDL binds to the pool (built at load) attributes a quote mint.
  const at = idl.poolQuoteMint.get(disc);
  if (at !== undefined) {
    const index = invoker.accounts[at];
    return index === undefined ? null : keys[index] ?? null;
  }
  if (!idl.instructions.has(disc) || disc === idl.multiHopSwap?.disc) throw new UnpinnedInvoker();
  return null;
}

/** The located events of a transaction and its gaps with their places, from one decode (ruling 43). */
export interface DecodedTransactionEvents { events: LocatedEvent[]; gaps: LocatedGap[] }

/**
 * `decodeEventsLocated` that also returns every gap with its place (`onGapAt`), so `pumpBuyTotals` gets both from one
 * decode (ruling 43). The caller's hooks are still called.
 */
export function decodeEventsWithGaps(tx: RawTransaction, idls: readonly PinnedIdl[], hooks: EventHooks = {}, quote: QuoteMints = {}): DecodedTransactionEvents {
  const gaps: LocatedGap[] = [];
  const events = decodeEventsLocated(tx, idls, { ...hooks, onGapAt: (g) => { gaps.push(g); hooks.onGapAt?.(g); } }, quote);
  return { events, gaps };
}

/** `decodeEvents` with each event's place in the transaction and its layout flag (rulings m11 and 2). */
export function decodeEventsLocated(tx: RawTransaction, idls: readonly PinnedIdl[], hooks: EventHooks = {}, quote: QuoteMints = {}): LocatedEvent[] {
  if (tx.version !== 'legacy' && tx.version !== 0 && tx.version !== 1) throw new DecodeError('E_BAD_VALUE', 'transaction version must be legacy, 0 or 1 [LD-05]');
  if (tx.meta.err !== null && tx.meta.err !== undefined) return [];
  const byProgram = new Map(idls.filter((i) => i.name !== 'pump_fees').map((i) => [i.program, i]));
  const keys = [...tx.message.accountKeys, ...tx.message.loadedAddresses.writable, ...tx.message.loadedAddresses.readonly];
  const programOf = (ix: Ix): Pubkey | undefined => keys[ix.programIdIndex];
  if (tx.meta.innerInstructions.length === 0) {
    if (keys.some((k) => byProgram.has(k))) hooks.onGap?.('no_inner');   // a pump program appears in the account keys (it may have been invoked at any depth)
    return [];
  }
  const out: LocatedEvent[] = [];
  /** True when `ix` runs a multi-hop route: PumpSwap `multi_hop_swap` or pump `multi_hop_curve_swap` (rulings 38, 44). */
  const isMultiHop = (ix: Ix | undefined): boolean => {
    const routes = ix === undefined ? undefined : byProgram.get(programOf(ix) ?? '')?.routeInstructions;
    if (ix === undefined || routes === undefined || routes.size === 0) return false;
    const length58 = (ix as InnerIx).dataLength58;
    if (length58 !== undefined && length58 > MAX_EVENT_DATA_B58) return false;
    const d = Buffer.from(ix.dataB64, 'base64');
    return d.length >= 8 && d.length <= MAX_EVENT_DATA_BYTES && routes.has(d.subarray(0, 8).toString('hex'));
  };
  for (const group of tx.meta.innerInstructions) {
    const parent = tx.message.instructions[group.index];
    const top = parent === undefined ? undefined : programOf(parent);   // undefined: a bad trace for any event below
    const ixs: readonly InnerIx[] = group.instructions;
    const hs = heightsOf(ixs);
    /**
     * Whether a route instruction invoked instruction `k`, walking its invokers up to the top-level instruction. A
     * trace that cannot be followed counts as a route (ruling 44), so the event stays out of the buyer totals.
     */
    const underMultiHop = (k: number): boolean => {
      let j = k;
      for (;;) {
        const a = hs === 'bad' ? undefined : hs === null ? -1 : invokerIndex(j, hs);
        if (a === undefined) return true;
        if (a === -1) return isMultiHop(parent);
        if (isMultiHop(ixs[a])) return true;
        j = a;
      }
    };
    for (const [k, ix] of ixs.entries()) {
      const gap = (reason: GapReason, event: string | null): void => {
        hooks.onGap?.(reason);
        hooks.onGapAt?.({ signature: tx.signature, outerIx: group.index, innerIx: k, reason, event });
      };
      const program = programOf(ix);
      const idl = program === undefined ? undefined : byProgram.get(program);
      if (program === undefined || idl === undefined) continue;   // other programs' data is never decoded
      if (ix.dataLength58 !== undefined && ix.dataLength58 > MAX_EVENT_DATA_B58) { gap('oversized', null); continue; }
      const data = Buffer.from(ix.dataB64, 'base64');
      if (data.length > MAX_EVENT_DATA_BYTES) { gap('oversized', null); continue; }
      if (data.length < 8 || data.subarray(0, 8).toString('hex') !== EVENT_CPI_PREFIX) continue;   // a normal CPI
      // An inconsistent call trace or a missing invoker: the event cannot be trusted, and the gap is counted.
      const at = hs === 'bad' ? undefined : hs === null ? -1 : invokerIndex(k, hs);
      const invoker = at === undefined ? undefined : at === -1 ? top : programOf(ixs[at] as Ix);
      if (invoker === undefined) { gap('bad_trace', null); continue; }
      const invokerIx = at === -1 ? parent : ixs[at as number];
      if (invoker !== program) continue;                      // not a self-CPI: ignored
      const disc = data.length >= 16 ? toHex(data.subarray(8, 16)) : '';
      const def = idl.events.get(disc);
      if (def === undefined) {
        gap('unknown_disc', null);
        hooks.onUnknown?.(program, disc, tx.signature);
        out.push({ event: { kind: 'unknown_event', programId: program, discriminatorHex: disc, signature: tx.signature }, outerIx: group.index, innerIx: k, layoutExtended: false, shortLegacy: false, multiHop: underMultiHop(k) });
        continue;
      }
      let ev: M02Event | null;
      let extra = 0;
      let shortLegacy = false;
      try {
        const read = readEvent(idl.name, def, data.subarray(16));
        const value = read.value;
        extra = read.extra;
        shortLegacy = read.shortLegacy;
        ev = mapEvent(idl.name, def.name, value, tx.slot, tx.signature, () => invokerQuoteMint(invokerIx, idl, keys), quote.wsolMint);
      } catch (e) {
        gap(gapOf(e), def.name);                              // never a guessed event
        continue;
      }
      if (ev === null) continue;
      hooks.onEvent?.(ev.kind);
      if (extra > 0) hooks.onLayoutExtended?.(ev.kind, extra);
      out.push({ event: ev, outerIx: group.index, innerIx: k, layoutExtended: extra > 0, shortLegacy, multiHop: underMultiHop(k) });
    }
  }
  return out;
}

/**
 * One buyer's curve purchase of one coin in one top-level instruction, the pool part of a completing buy included.
 * `incomplete`: a TradeEvent, a PostCompleteBuyEvent or an event that could not be named gapped in the same top-level
 * instruction (ruling 37), so the amounts may lack a part; a reader treats it as unknown, never as the total.
 */
export interface PumpBuyTotal {
  signature: Signature; outerIx: number; mint: Pubkey; solAmount: Lamports; tokenAmount: BaseUnits; fee: Lamports; creatorFee: Lamports;
  incomplete: boolean;
}

/** The IDL events whose gap can take a part from a pump buyer's total; a gap with no event name counts too. */
const BUY_TOTAL_PARTS = new Set(['TradeEvent', 'PostCompleteBuyEvent']);

/**
 * The buyer's totals of pump curve buys (card IDL-REPIN): each `pump_trade` buy plus the `pump_post_complete_buy` of
 * the same coin in the same top-level instruction, summed per signature, top-level instruction and coin in the order
 * first seen. pump-public-docs 8cda1fa, docs/SYNTHETIC_MIGRATION.md: "the buyer's total is the `TradeEvent` amounts
 * plus the `PostCompleteBuyEvent` amounts". A coin bought twice in one instruction is summed; sells are not counted.
 * Events under a `multi_hop_swap` are left out (ruling 38): the middle coins of a route net to zero for the user, and
 * routes are not decoded until a real multi-hop fixture proves them. `gaps` mark totals `incomplete` (ruling 37); it is
 * required (ruling 43), so take both from one `decodeEventsWithGaps` call. Before any card reads these totals, a golden from a real mainnet completing v3 buy is required, because
 * the SOL rule for PostCompleteBuyEvent's quote mint (default key, not wSOL) is UNVERIFIED (ruling 37; Z08, PM01-KILL).
 */
export function pumpBuyTotals(events: readonly LocatedEvent[], gaps: readonly LocatedGap[]): PumpBuyTotal[] {
  const totals = new Map<string, PumpBuyTotal>();
  const gapped = new Set(gaps.filter((g) => g.event === null || BUY_TOTAL_PARTS.has(g.event)).map((g) => `${g.signature} ${g.outerIx}`));
  for (const { event: e, outerIx, multiHop } of events) {
    if (multiHop) continue;
    if (e.kind !== 'pump_trade' && e.kind !== 'pump_post_complete_buy') continue;
    if (e.kind === 'pump_trade' && !e.isBuy) continue;
    const key = `${e.signature} ${outerIx} ${e.mint}`;
    const t = totals.get(key) ?? {
      signature: e.signature, outerIx, mint: e.mint, solAmount: 0n, tokenAmount: 0n, fee: 0n, creatorFee: 0n,
      incomplete: gapped.has(`${e.signature} ${outerIx}`),
    };
    totals.set(key, { ...t, solAmount: t.solAmount + e.solAmount, tokenAmount: t.tokenAmount + e.tokenAmount, fee: t.fee + e.fee, creatorFee: t.creatorFee + e.creatorFee });
  }
  return [...totals.values()];
}

export type ReadTxError = { code: 'E_TX_SHAPE' | 'E_TX_VERSION'; message: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isKeys = (v: unknown): v is string[] => Array.isArray(v) && v.every((k) => typeof k === 'string');
const toBig = (v: unknown): bigint => {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  throw new DecodeError('E_BAD_VALUE', 'not an integer');
};

const BASE58_TEXT = /^[1-9A-HJ-NP-Za-km-z]*$/;

/**
 * An instruction whose data is decoded from base58 on first read of `dataB64` (review C03 R2): reading a transaction
 * costs O(length) per instruction, and the event decoder decodes only pump and PumpSwap data of short length from
 * successful transactions. The alphabet is checked here, so the later decode cannot fail.
 */
function readIx(v: unknown, inner: boolean): InnerIx {
  if (!isObject(v) || !Number.isSafeInteger(v.programIdIndex) || !Array.isArray(v.accounts) || typeof v.data !== 'string'
    || !v.accounts.every((a) => Number.isSafeInteger(a))) throw new DecodeError('E_BAD_VALUE', 'bad instruction');
  const data58 = v.data;
  if (!BASE58_TEXT.test(data58)) throw new DecodeError('E_BASE58', 'character outside the base58 alphabet');
  // An inner instruction keeps the RPC's `stackHeight` (null or absent on old transactions: left out).
  const h = inner ? v.stackHeight : undefined;
  if (h !== undefined && h !== null && !validHeight(h)) throw new DecodeError('E_BAD_VALUE', 'bad stackHeight');
  let b64: string | null = null;
  const ix: InnerIx = {
    programIdIndex: v.programIdIndex as number,
    accounts: [...(v.accounts as number[])],                     // copies: the result never aliases the caller's JSON
    get dataB64(): string {
      b64 ??= Buffer.from(base58.decode(data58)).toString('base64');
      return b64;
    },
    set dataB64(value: string) {
      b64 = value;
      delete ix.dataLength58;
    },
    ...(validHeight(h) ? { stackHeight: h } : {}),
    dataLength58: data58.length,
  };
  return ix;
}

/**
 * Reads a `getTransaction` result fetched with `encoding: 'json'` and `maxSupportedTransactionVersion: 1` [LD-05]
 * into a `RawTransaction` (instruction data re-encoded from base58 to base64 on first read, see `readIx`; inner
 * instructions keep `stackHeight` and `dataLength58`, see `InnerIx`). Integers above 2^53 may arrive as bigint (M14's
 * lossless JSON).
 */
export function readRpcTransaction(signature: Signature, result: unknown): Result<RawTransaction, ReadTxError> {
  const bad = (message: string): { ok: false; error: ReadTxError } => ({ ok: false, error: { code: 'E_TX_SHAPE', message } });
  if (!isObject(result) || !isObject(result.transaction) || !isObject(result.meta)) return bad('not a getTransaction result');
  // The version field is present only when the request named maxSupportedTransactionVersion (M14 always sends 1).
  const version = result.version;
  if (version !== 'legacy' && version !== 0 && version !== 1) return { ok: false, error: { code: 'E_TX_VERSION', message: 'version must be legacy, 0 or 1 (fetch with maxSupportedTransactionVersion: 1)' } };
  const message = result.transaction.message;
  const meta = result.meta;
  if (!('err' in meta)) return bad('meta.err missing');                     // Z03 ruling m5: success is never assumed
  if (!isObject(message) || !isKeys(message.accountKeys) || !Array.isArray(message.instructions)) return bad('message must be json-encoded');
  const loaded = meta.loadedAddresses ?? { writable: [], readonly: [] };
  if (!isObject(loaded) || !isKeys(loaded.writable) || !isKeys(loaded.readonly)) return bad('bad loadedAddresses');
  try {
    const inner = meta.innerInstructions ?? [];
    if (!Array.isArray(inner)) throw new DecodeError('E_BAD_VALUE', 'bad innerInstructions');
    const balances = (v: unknown): Lamports[] => (Array.isArray(v) ? v.map(toBig) : []);
    const logs = meta.logMessages;
    return {
      ok: true,
      value: {
        signature, slot: toBig(result.slot), version,
        blockTimeS: typeof result.blockTime === 'number' ? result.blockTime : null,
        message: { accountKeys: [...message.accountKeys], loadedAddresses: { writable: [...loaded.writable], readonly: [...loaded.readonly] }, instructions: message.instructions.map((ix) => readIx(ix, false)) },
        meta: {
          err: meta.err ?? null, feeLamports: toBig(meta.fee), preBalances: balances(meta.preBalances), postBalances: balances(meta.postBalances),
          preTokenBalances: Array.isArray(meta.preTokenBalances) ? meta.preTokenBalances : [],
          postTokenBalances: Array.isArray(meta.postTokenBalances) ? meta.postTokenBalances : [],
          innerInstructions: inner.map((g: unknown) => {
            if (!isObject(g) || !Number.isSafeInteger(g.index) || !Array.isArray(g.instructions)) throw new DecodeError('E_BAD_VALUE', 'bad inner group');
            return { index: g.index as number, instructions: g.instructions.map((ix) => readIx(ix, true)) };
          }),
          logMessages: Array.isArray(logs) && logs.every((l) => typeof l === 'string') ? logs : null,
          computeUnitsConsumed: typeof meta.computeUnitsConsumed === 'number' ? meta.computeUnitsConsumed : null,
        },
      },
    };
  } catch (e) {
    return bad((e as Error).message);                     // DecodeError from the readers above
  }
}
