// Shared TEST-2 fixture: the stub chain, a stand-in funded for each trade and a simulation that moves exactly the
// quoted amount. Used by the dry-run tests and by the supported-shape test (TX-1b).
import { type Address, NATIVE_MINT, TOKEN_PROGRAM, decodeTransaction } from '../../core/src/chain/index.ts';
import { POLICY, RATES, common, goldenOf, request } from '../../core/test/tx/fixtures-policy.ts';
import type { Kind } from '../../core/test/tx/helpers.ts';
import { associatedTokenAddress, buildTrade, type SignerPolicyContext, type TradeRequest } from '../../core/src/tx/index.ts';
import { type DryRunTrade, DryRunRpc } from '../src/dryrun/index.ts';
import { HELIUS_FREE, ManualTimers, P2, Scheduler } from '../src/scheduler/index.ts';
import { KEYS } from './helpers.ts';
import { type StubAccount, type StubChain, stubChain, testAddress, tokenAccount, wallet } from './dryrun-chain.ts';

export const KINDS: readonly Kind[] = ['curve-buy', 'curve-sell', 'pool-buy', 'pool-sell'];
export const BOT = testAddress(1);
export const BUYER = testAddress(2);
export const HOLDER = testAddress(3);
export const URL = `https://mainnet.helius-rpc.com/?api-key=${KEYS.HELIUS_API_KEY}`;
export const HEAD = 1_000n;

export const signerPolicy = (over: Partial<SignerPolicyContext> = {}): SignerPolicyContext => ({
  wallet: BOT,
  kind: 'trade',
  maxSolOut: 10n ** 12n,
  maxPriorityFeeLamports: POLICY.maxPriorityFeeLamports,
  maxTipLamports: POLICY.maxTipLamports,
  tipAccounts: POLICY.tipAccounts,
  withdrawalAddress: null,
  lamportsPerSignature: RATES.lamportsPerSignature,
  rent: RATES.rent,
  ...over,
});

export const tradeOf = (kind: Kind, over: Partial<DryRunTrade> = {}, closeTokenAccount = true): DryRunTrade => ({
  id: `intent-${kind}`,
  request: request(kind, closeTokenAccount),
  common: common(goldenOf(kind), { wallet: BOT }),
  policy: POLICY,
  signerPolicy: signerPolicy(),
  minContextSlot: HEAD,
  ...over,
});

export const mintOf = (req: TradeRequest): Address => (req.venue === 'curve' ? req.market.mint : req.market.state.baseMint);
export const need = (req: TradeRequest): bigint => (req.side === 'sell' ? (req.venue === 'curve' ? req.quote.tokens : req.quote.base) : 0n);
export const quoted = (req: TradeRequest): bigint =>
  req.side === 'buy' ? (req.venue === 'curve' ? req.quote.tokens : req.quote.base) : req.quote.userQuote;

export const setup = (opts: { scheduler?: Scheduler } = {}) => {
  const { chain, http } = stubChain();
  const timers = new ManualTimers(1_000_000);
  const scheduler = opts.scheduler ?? new Scheduler({ ...HELIUS_FREE, window: { limit: 1_000, windowMs: 1_000 } }, { timers });
  const rpc = new DryRunRpc({ url: () => URL, http, scheduler, timeoutMs: 2_000 });
  return { chain, rpc, deps: { rpc, priority: P2, buyStandIns: [BUYER] } };
};

export interface FundOptions {
  /** The holder's token balance (default: exactly the position). */
  readonly holderTokens?: bigint;
  /** Added to the quoted amount the simulation delivers (tokens for buys, lamports for sells). */
  readonly delta?: bigint;
  /** Rent the simulated transaction takes from the wallet (default: what the stand-in build declares). */
  readonly rent?: bigint;
  /** Accounts the build writes that are left absent before the trade. */
  readonly absent?: readonly Address[];
  /** Post-state of accounts other than the stand-in's own three. */
  readonly extra?: ReadonlyMap<string, StubAccount | null>;
}

/**
 * Puts a funded buyer and a holder on the stub chain, plus every other account the stand-in builds write (so the
 * build declares no rent unless a test removes one), and scripts a simulation that moves exactly the quoted amount
 * plus `delta`, charging the fees, tip and `rent`.
 */
export const fund = (chain: StubChain, t: DryRunTrade, o: FundOptions = {}) => {
  const req = t.request;
  const mint = mintOf(req);
  const prog = req.market.baseTokenProgram;
  chain.accounts.set(BUYER, wallet(10n ** 12n));
  chain.accounts.set(HOLDER, wallet(1_000_000_000n));
  const holderAta = associatedTokenAddress(HOLDER, mint, prog);
  const held = o.holderTokens ?? need(req);
  chain.accounts.set(holderAta, tokenAccount(mint, HOLDER, held, undefined, prog));
  chain.largest = [{ address: holderAta, amount: held.toString() }];
  for (const s of [BUYER, HOLDER]) {
    const b = buildTrade(req, { ...t.common, wallet: s, existing: new Set() }, t.policy);
    if (!b.ok) throw new Error('stub build failed');
    const own = new Set<string>([s, associatedTokenAddress(s, NATIVE_MINT, TOKEN_PROGRAM), associatedTokenAddress(s, mint, prog)]);
    for (const ix of b.tx.instructions) for (const m of ix.accounts) if (m.writable && !m.signer && !own.has(m.address) && !chain.accounts.has(m.address)) chain.accounts.set(m.address, wallet(10n ** 9n));
  }
  for (const a of o.absent ?? []) chain.accounts.delete(a);
  chain.simulate = (sim, accounts) => {
    const [s, wsol, base] = sim.addresses as [Address, Address, Address];
    // The stand-in's build with the accounts the stub holds, as the dry run builds it.
    const existing = new Set([...accounts.keys()] as Address[]);
    const b = buildTrade(req, { ...t.common, wallet: s, existing }, t.policy);
    if (!b.ok) throw new Error('stub build failed');
    const out = b.tx.solOut;
    const rent = o.rent ?? out.rent;
    const pre = (a: Address) => accounts.get(a) ?? null;
    const preTokens = pre(base) === null ? 0n : new DataView(pre(base)!.data.buffer).getBigUint64(64, true);
    const delta = o.delta ?? 0n;
    if (req.side === 'buy') {
      const got = quoted(req) + delta;
      return { post: [wallet(pre(s)!.lamports - (out.total - out.rent) - rent), pre(wsol), tokenAccount(mint, s, preTokens + got, undefined, prog)], extra: o.extra };
    }
    const left = preTokens - need(req);
    const closes = sim.wire.length > 0 && decodeTransaction(sim.wire).instructions.length === b.tx.instructions.length && req.closeTokenAccount;
    const baseLamports = pre(base)!.lamports;
    const proceeds = quoted(req) + delta;
    const walletAfter = pre(s)!.lamports + proceeds - out.baseFee - out.priorityFee - out.tip - rent + (closes ? baseLamports : 0n);
    return { post: [wallet(walletAfter), pre(wsol), closes ? null : tokenAccount(mint, s, left, baseLamports, prog)], extra: o.extra };
  };
};
