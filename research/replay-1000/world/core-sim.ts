// REPLAY-1000: H15's round-trip simulation without `simulateTransaction` against today's state. The bot's own
// simulator (packages/worker/src/sim/roundtrip.ts) is followed step by step up to the RPC: the same shape check,
// builders and compile refuse what it refuses. The node's simulation is replaced by CORE-2's exact pool math on the
// pool's reserves as of the simulation's slot (accounts.ts), which TAIL-PROOF (#257) proved exact on 1,188/1,188 mainnet
// trades: `paid` is the buy's charge and `proceeds` the sell of the same tokens on the reserves the buy left
// (`immediateProceeds`). Not modelled: the stand-in's funding (taken as funded) and program refusals other than those
// the builders and CORE-2 already refuse (README "H15").
import { type Address, NATIVE_MINT, TOKEN_PROGRAM, decodePool, fromBase64 } from '../../../packages/core/src/chain/index.ts';
import type { PoolFeeContext } from '../../../packages/core/src/amm/index.ts';
import { pumpSwapRoundTrip } from '../../../packages/core/src/costs/index.ts';
import type { SimRead } from '../../../packages/core/src/facts/raw.ts';
import { compileV0 } from '../../../packages/core/src/tx/compile.ts';
import { associatedTokenAddress } from '../../../packages/core/src/tx/programs.ts';
import { checkShape } from '../../../packages/core/src/tx/shape.ts';
import { buildTrade, requestShape, type BuildCommon, type TradeRequest } from '../../../packages/core/src/tx/trade.ts';
import { walletDerived } from '../../../packages/worker/src/dryrun/standin.ts';
import { roundTripInstructions, type RoundTripRequest, type SimRecord, type SimResult } from '../../../packages/worker/src/sim/roundtrip.ts';
import type { AccountWorld } from './accounts.ts';
import type { ChainView } from './chain.ts';

export interface CoreSimDeps {
  readonly standIn: Address;
  readonly accounts: AccountWorld;
  readonly chain: ChainView;
  readonly now: () => number;
  /** The fee context the bot prices the pool with (its own facts). */
  readonly ctxOf: (mint: string) => PoolFeeContext | null;
}

export class CoreSimulator {
  readonly #d: CoreSimDeps;
  constructor(d: CoreSimDeps) {
    this.#d = d;
  }

  async simulate(req: RoundTripRequest): Promise<SimResult> {
    const d = this.#d;
    const t0 = d.now();
    const mint = req.venue.venue === 'curve' ? req.venue.market.mint : req.venue.market.state.baseMint;
    const rec: SimRecord = {
      mint, spend: req.spend, outcome: 'malformed', reason: null, credits: 0, latencyMs: 0, slot: null, standIn: d.standIn,
      paid: null, proceeds: null, loss: null, modelLoss: req.quote.paid - req.quote.immediateProceeds, networkFee: null, rentPaid: null, unitsConsumed: null,
    };
    const done = (outcome: SimRecord['outcome'], reason: string | null, read: SimRead | null, more: Partial<SimRecord> = {}): SimResult => ({ read, record: { ...rec, ...more, outcome, reason, latencyMs: d.now() - t0 } });
    // 1. As roundtrip.ts: the trade inside TX-1b's supported shape, built and compiled.
    if (req.quote.spend !== req.spend) return done('build-refused', `the local round trip is for ${req.quote.spend}, not ${req.spend}`, null);
    if (req.venue.venue !== 'pool') return done('build-refused', 'replay: curve round trips are not rebuilt', null);
    const S = d.standIn;
    const c: BuildCommon = { ...req.common, wallet: S };
    const base = { mint: req.mint, ...req.venue } as const;
    const buyReq = { ...base, side: 'buy', spend: req.spend, quote: { spend: req.spend, base: req.quote.tokens, userQuote: req.quote.paid } } as TradeRequest;
    const sellReq = { ...base, side: 'sell', quote: { base: req.quote.tokens, userQuote: req.quote.proceeds }, closeTokenAccount: false } as TradeRequest;
    const shape = checkShape(requestShape(buyReq));
    if (!shape.ok) return done('unsupported-shape', `${shape.reason}: ${shape.detail}`, null);
    const buy = buildTrade(buyReq, c, req.policy);
    if (!buy.ok) return done('build-refused', `buy: ${buy.reason} (${buy.detail})`, null);
    const sell = buildTrade(sellReq, c, req.policy);
    if (!sell.ok) return done('build-refused', `sell: ${sell.reason} (${sell.detail})`, null);
    try {
      const rt = roundTripInstructions(buy.tx, sell.tx);
      const fixed = new Set<string>(walletDerived(S, mint, req.venue.market.baseTokenProgram));
      compileV0(S, rt.instructions, c.recentBlockhash, c.lookupTables, (k) => !fixed.has(k));
    } catch (e) {
      return done('build-refused', `round trip does not compile: ${(e as Error).message}`, null);
    }
    void associatedTokenAddress;
    void NATIVE_MINT;
    void TOKEN_PROGRAM;
    // 2. The pool's reserves as of the simulation (the node simulates on its bank at or after minContextSlot).
    const slot = Math.max(Number(req.minContextSlot), d.chain.confirmedSlot(d.now()));
    const ctx = d.ctxOf(mint);
    if (ctx === null) return done('rpc-error', 'replay: no fee context for the pool', null);
    const poolAddr = req.venue.market.pool;
    const p = await d.accounts.account(poolAddr, slot);
    if (p === null) return done('rpc-error', 'replay: pool missing at the simulation slot', null);
    const pool = decodePool(fromBase64(p.data[0])).value;
    const [bv, qv] = await Promise.all([d.accounts.account(pool.poolBaseTokenAccount, slot), d.accounts.account(pool.poolQuoteTokenAccount, slot)]);
    if (bv === null || qv === null) return done('rpc-error', 'replay: vault missing at the simulation slot', null);
    const amount = (a: { data: [string, string] }) => new DataView(fromBase64(a.data[0]).buffer).getBigUint64(64, true);
    const state = { baseReserve: amount(bv), quoteVault: amount(qv), virtualQuoteReserves: pool.virtualQuoteReserves ?? 0n };
    const q = pumpSwapRoundTrip(state, ctx)(req.spend);
    if (!q.ok) {
      const error = `replay: CORE-2 refuses the round trip on the reserves at slot ${slot}: ${q.reason}`;
      return done('sim-failed', error, { mint, slot: BigInt(slot), spend: req.spend, ok: false, paid: 0n, proceeds: 0n, error });
    }
    const paid = q.trade.paid;
    const proceeds = q.trade.immediateProceeds;
    const read: SimRead = { mint, slot: BigInt(slot), spend: req.spend, ok: true, paid, proceeds, error: null };
    return done('simulated', null, read, { slot: BigInt(slot), paid, proceeds, loss: paid - proceeds, credits: 2 });
  }
}
