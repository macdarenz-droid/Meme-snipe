// Dry-run simulation of one paper entry or exit (pre-funding item 4, docs/ARCHITECTURE.md §15, §16, TEST-2). The
// trade is built with the TX-1 builders for the bot wallet and checked against the signer policy, then built again for
// a stand-in that can pay (see standin.ts), proved structurally identical, and passed to `simulateTransaction`. It is
// never sent: nothing reachable from this module can send (test/dryrun-nosend.test.ts).
import { type Address, type LoadedAddresses, NATIVE_MINT, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, decodeTokenAccount, decodeTransaction } from '../../../core/src/chain/index.ts';
import { compileV0 } from '../../../core/src/tx/compile.ts';
import { type PolicyVerdict, type SignerPolicyContext, checkSignerPolicy } from '../../../core/src/tx/policy.ts';
import { associatedTokenAddress, pumpCreatorVault } from '../../../core/src/tx/programs.ts';
import { type RentRate, rentExempt } from '../../../core/src/tx/rent.ts';
import { type BuildCommon, type BuiltTransaction, type ExecutionPolicy, type TradeRequest, buildTrade } from '../../../core/src/tx/trade.ts';
import { ProviderError } from '../providers/http.ts';
import { P2, type Priority, ScheduleRefused } from '../scheduler/scheduler.ts';
import type { DryRunRpc, RawAccount, SimulationValue, TokenBalance } from './rpc.ts';
import { type HolderCandidate, holderOf, isBaseClose, isPlainWallet, sameStructure, substitution, walletDerived } from './standin.ts';

export interface DryRunTrade {
  /** The paper intent's id. */
  readonly id: string;
  readonly request: TradeRequest;
  /** The build inputs for the bot wallet, exactly as a live trade would use them. */
  readonly common: BuildCommon;
  readonly policy: ExecutionPolicy;
  readonly signerPolicy: SignerPolicyContext;
  /** The feed's head slot when the paper trade was decided: no read or simulation may use older state. */
  readonly minContextSlot: bigint;
}

export interface DryRunDeps {
  readonly rpc: DryRunRpc;
  /**
   * Scheduler class for every dry-run call. The worker uses P2: below live exits (P0) and open-position monitoring
   * (P1), above discovery (P3). A refusal is recorded as a failed trade, never retried silently. P0 and P1 are
   * refused (RangeError) before any request: the dry run never takes capacity reserved for exits or open positions.
   */
  readonly priority: Priority;
  /** Funded plain wallets (public addresses) that may stand in for the bot wallet on buys, tried in order. */
  readonly buyStandIns: readonly Address[];
}

export type DryRunOutcome =
  | 'simulated'
  | 'sim-error'
  | 'not-simulable'
  | 'build-refused'
  | 'policy-violation'
  | 'structure-mismatch'
  | 'amount-check'
  | 'scheduler-refused'
  | 'rpc-error'
  | 'malformed'
  | 'internal-error';

export interface StandInUse {
  readonly address: Address;
  readonly role: 'funded-wallet' | 'holder';
  /** The holder's token account (sells). */
  readonly tokenAccount: Address | null;
  /** True when the real build's base-account close was left out (the holder has more tokens than the position). */
  readonly closeOmitted: boolean;
}

export interface DryRunRecord {
  readonly id: string;
  readonly side: 'buy' | 'sell';
  readonly venue: 'curve' | 'pool';
  readonly mint: Address;
  readonly outcome: DryRunOutcome;
  /** True only for 'simulated'. Every other outcome, 'not-simulable' included, is a failure. */
  readonly success: boolean;
  readonly error: string | null;
  readonly standIn: StandInUse | null;
  /** The signer-policy check of the bot-wallet build. */
  readonly policy: { readonly ok: boolean; readonly violations: readonly string[]; readonly solOut: bigint } | null;
  /** What the local quote promised: tokens out (buys) or SOL to the wallet after venue fees (sells). */
  readonly quotedOut: bigint | null;
  /** The same amount measured from the simulated balances. */
  readonly simulatedOut: bigint | null;
  /** |simulated − quoted| / quoted in units of 0.0001 percentage points, rounded up (conservative). */
  readonly amountErrorE4: number | null;
  readonly readSlot: bigint | null;
  /** Slots between the quote and the pre-read (`readSlot − quotedAtSlot`): how old the quote was when checked. */
  readonly quoteAgeSlots: bigint | null;
  /** Rent the build declares (its worst case for what existed at the read) and the rent the simulation shows paid. */
  readonly rentDeclared: bigint | null;
  readonly rentPaid: bigint | null;
  /** Where the stand-in's own before and after balances came from: the simulation itself (atomic) or our read. */
  readonly balancesFrom: 'simulation' | 'read' | null;
  readonly simulatedSlot: bigint | null;
  readonly unitsConsumed: bigint | null;
  /** The last log lines of a failed simulation (public chain output). */
  readonly logsTail: readonly string[];
}

/** Units of `amountErrorE4` per percentage point. */
export const E4_PER_POINT = 10_000;

/** ceil(|measured − quoted| × 100 × 10^4 / quoted). */
export const amountErrorE4 = (measured: bigint, quoted: bigint): number => {
  if (quoted <= 0n) throw new RangeError('the quoted amount must be positive');
  const d = measured > quoted ? measured - quoted : quoted - measured;
  const scaled = d * 100n * BigInt(E4_PER_POINT);
  return Number((scaled + quoted - 1n) / quoted);
};

const LOG_TAIL = 5;

const baseMintOf = (req: TradeRequest): Address => (req.venue === 'curve' ? req.market.mint : req.market.state.baseMint);
const sellAmount = (req: TradeRequest): bigint => (req.venue === 'curve' ? (req.side === 'sell' ? req.quote.tokens : 0n) : req.side === 'sell' ? req.quote.base : 0n);

/** Addresses a lookup table supplies to this build, as the decoder needs them. */
const loadedOf = (tx: BuiltTransaction, common: BuildCommon): LoadedAddresses => {
  const pick = (table: Address, indexes: readonly number[]) => {
    const t = common.lookupTables.find((x) => x.address === table);
    if (!t) throw new Error(`lookup table ${table} is missing`);
    return indexes.map((i) => t.addresses[i]!);
  };
  return {
    writable: tx.compiled.lookups.flatMap((l) => pick(l.table, l.writable)),
    readonly: tx.compiled.lookups.flatMap((l) => pick(l.table, l.readonly)),
  } as unknown as LoadedAddresses;
};

/**
 * Rent the transaction paid out of the wallet into one account other than the wallet's own, from its state before and
 * after: a new account's rent (a wrapped-SOL account's rent reserve, not its balance), a grown account's added bytes,
 * or the pump creator vault's top-up to rent-exempt (its balance also receives creator fees, so only the top-up
 * counts).
 */
export const rentPaidInto = (pre: RawAccount | null, post: RawAccount | null, rent: RentRate, isCreatorVault: boolean): bigint => {
  if (isCreatorVault) {
    const need = rentExempt(0, rent);
    const have = pre?.lamports ?? 0n;
    return post !== null && have < need ? need - have : 0n;
  }
  if (post === null) return 0n;
  if (pre === null) {
    if (post.owner === TOKEN_PROGRAM || post.owner === TOKEN_2022_PROGRAM) {
      const native = decodeTokenAccount(post.data, post.owner as Address).isNative;
      if (native !== null) return native;
    }
    return post.lamports;
  }
  return post.data.length > pre.data.length ? BigInt(post.data.length - pre.data.length) * rent.lamportsPerByte : 0n;
};

interface Atomic {
  readonly lamPre: readonly bigint[];
  readonly lamPost: readonly bigint[];
  readonly tokensPre: bigint;
  readonly tokensPost: bigint;
}

/**
 * The stand-in's wallet, wrapped-SOL and base-token balances (`own`, in that order) from the simulation's own
 * pre/post fields, or null when the provider does not return them all. All three are static keys of the message, so
 * their index is their position there. 'disagree' when the post lamports or the post token balance differ from the
 * accounts read back.
 */
export const atomicBalances = (v: SimulationValue, staticKeys: readonly Address[], own: readonly Address[], mint: Address): Atomic | 'disagree' | null => {
  const { preBalances: pre, postBalances: post, preTokenBalances: preT, postTokenBalances: postT } = v;
  if (pre === null || post === null || preT === null || postT === null) return null;
  const idx = own.map((a) => staticKeys.indexOf(a));
  if (idx.some((i) => i < 0 || i >= pre.length || i >= post.length)) return null;
  if (idx.some((i, k) => post[i] !== lamportsOf(v.accounts[k] ?? null))) return 'disagree';
  const tokens = (list: readonly TokenBalance[]): bigint | 'disagree' => {
    const e = list.find((b) => b.accountIndex === idx[2]);
    if (e === undefined) return 0n;
    return e.mint === mint ? e.amount : 'disagree';
  };
  const tokensPre = tokens(preT);
  const tokensPost = tokens(postT);
  if (tokensPre === 'disagree' || tokensPost === 'disagree') return 'disagree';
  // The token balance after must also match the base account read back (review of PR #28).
  if (tokensPost !== tokenAmount(v.accounts[2] ?? null)) return 'disagree';
  return { lamPre: idx.map((i) => pre[i]!), lamPost: idx.map((i) => post[i]!), tokensPre, tokensPost };
};

const tokenAmount = (a: RawAccount | null): bigint => (a === null ? 0n : decodeTokenAccount(a.data, a.owner as Address).amount);
const lamportsOf = (a: RawAccount | null): bigint => (a === null ? 0n : a.lamports);

interface StandInBuild {
  readonly tx: BuiltTransaction;
  /** The instructions actually simulated, and their wire bytes (the close may be left out). */
  readonly instructions: BuiltTransaction['instructions'];
  readonly wire: Uint8Array;
}

/**
 * Builds the trade for `standIn` with the same request, inputs and policy. When the close is omitted, the build keeps
 * the real shape (same compute limit and price) and only the base-account close is removed before compiling.
 */
const buildFor = (t: DryRunTrade, standIn: Address, existing: ReadonlySet<Address>, closeOmitted: boolean): StandInBuild | string => {
  const r = buildTrade(t.request, { ...t.common, wallet: standIn, existing }, t.policy);
  if (!r.ok) return `stand-in build refused: ${r.reason} (${r.detail})`;
  if (!closeOmitted) return { tx: r.tx, instructions: r.tx.instructions, wire: r.tx.compiled.wire };
  const req = t.request;
  const baseAta = associatedTokenAddress(standIn, baseMintOf(req), req.market.baseTokenProgram);
  const ixs = r.tx.instructions.filter((ix) => !isBaseClose(ix, baseAta, req.market.baseTokenProgram));
  const fixed = new Set<Address>([...walletDerived(standIn, baseMintOf(req), req.market.baseTokenProgram), ...t.policy.tipAccounts]);
  try {
    return { tx: r.tx, instructions: ixs, wire: compileV0(standIn, ixs, t.common.recentBlockhash, t.common.lookupTables, (k) => !fixed.has(k)).wire };
  } catch (e) {
    return `stand-in build does not compile: ${(e as Error).message}`;
  }
};

type Chosen = { readonly standIn: StandInUse } | { readonly none: string };

/** The first funded plain wallet that can pay for the worst case of this buy and stay rent-exempt. */
const chooseBuyer = async (t: DryRunTrade, d: DryRunDeps): Promise<Chosen> => {
  const list = d.buyStandIns.filter((a) => a !== t.common.wallet).slice(0, 100);
  if (list.length === 0) return { none: 'no buy stand-in is configured' };
  const { accounts } = await d.rpc.getMultipleAccounts(list, t.minContextSlot, d.priority);
  const keep = rentExempt(0, t.common.rates.rent);
  for (let i = 0; i < list.length; i++) {
    const a = accounts[i]!;
    if (!isPlainWallet(a)) continue;
    const b = buildFor(t, list[i]!, new Set(), false);
    if (typeof b === 'string') continue;
    if (a.lamports >= b.tx.solOut.total + keep) return { standIn: { address: list[i]!, role: 'funded-wallet', tokenAccount: null, closeOmitted: false } };
  }
  return { none: 'no buy stand-in has enough SOL for the spend, fees and rent' };
};

/** The first current holder (largest first) with at least the position's tokens in its ATA and SOL for the fees. */
const chooseHolder = async (t: DryRunTrade, d: DryRunDeps): Promise<Chosen> => {
  const req = t.request;
  const mint = baseMintOf(req);
  const need = sellAmount(req);
  const largest = await d.rpc.getTokenLargestAccounts(mint, t.minContextSlot, d.priority);
  // Largest first, then by address, so the choice never depends on the provider's order of equal balances.
  const big = largest.accounts
    .filter((x) => x.amount >= need)
    .sort((a, b) => (a.amount !== b.amount ? (a.amount > b.amount ? -1 : 1) : a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
  if (big.length === 0) return { none: 'no holder has the position\'s token amount' };
  const tokenAccounts = await d.rpc.getMultipleAccounts(big.map((x) => x.address), t.minContextSlot, d.priority);
  const holders = big
    .map((x, i) => holderOf(x.address as Address, tokenAccounts.accounts[i]!, mint, req.market.baseTokenProgram))
    .filter((h): h is HolderCandidate => h !== null && h.amount >= need && h.owner !== t.common.wallet);
  if (holders.length === 0) return { none: 'no holder with enough tokens holds them in a usable associated account' };
  const owners = await d.rpc.getMultipleAccounts(holders.map((h) => h.owner), t.minContextSlot, d.priority);
  const keep = rentExempt(0, t.common.rates.rent);
  for (let i = 0; i < holders.length; i++) {
    const h = holders[i]!;
    const a = owners.accounts[i]!;
    if (!isPlainWallet(a)) continue;
    const closeOmitted = req.side === 'sell' && req.closeTokenAccount && h.amount !== need;
    const b = buildFor(t, h.owner, new Set(), closeOmitted);
    if (typeof b === 'string') continue;
    if (a.lamports >= b.tx.solOut.total + keep) return { standIn: { address: h.owner, role: 'holder', tokenAccount: h.tokenAccount, closeOmitted } };
  }
  return { none: 'no holder can pay the fees and stay rent-exempt' };
};

export const dryRunTrade = async (t: DryRunTrade, d: DryRunDeps): Promise<DryRunRecord> => {
  if (d.priority < P2) throw new RangeError(`dry run: priority P${d.priority} is reserved for exits and open positions; use P2 or P3`);
  const req = t.request;
  const mint = baseMintOf(req);
  let rec: DryRunRecord = {
    id: t.id, side: req.side, venue: req.venue, mint, outcome: 'internal-error', success: false, error: null, standIn: null, policy: null,
    quotedOut: null, simulatedOut: null, amountErrorE4: null, readSlot: null, quoteAgeSlots: null, rentDeclared: null, rentPaid: null, balancesFrom: null, simulatedSlot: null, unitsConsumed: null, logsTail: [],
  };
  const fail = (outcome: DryRunOutcome, error: string, more: Partial<DryRunRecord> = {}): DryRunRecord => ({ ...rec, ...more, outcome, success: false, error });

  // 1. The real build for the bot wallet, and the signer policy on its bytes.
  const real = buildTrade(req, t.common, t.policy);
  if (!real.ok) return fail('build-refused', `${real.reason}: ${real.detail}`);
  rec = { ...rec, quotedOut: real.tx.quote.quotedOut };
  let verdict: PolicyVerdict;
  try {
    verdict = checkSignerPolicy(decodeTransaction(real.tx.compiled.wire), loadedOf(real.tx, t.common), t.signerPolicy);
  } catch (e) {
    return fail('policy-violation', `policy check failed: ${(e as Error).message}`);
  }
  rec = { ...rec, policy: { ok: verdict.ok, violations: verdict.violations, solOut: verdict.solOut } };
  if (!verdict.ok) return fail('policy-violation', verdict.violations.join('; '));

  try {
    // 2. A stand-in that can pay today.
    const chosen = req.side === 'buy' ? await chooseBuyer(t, d) : await chooseHolder(t, d);
    if ('none' in chosen) return fail('not-simulable', chosen.none);
    const s = chosen.standIn;
    rec = { ...rec, standIn: s };
    const baseProgram = req.market.baseTokenProgram;
    const readBack = [s.address, associatedTokenAddress(s.address, NATIVE_MINT, TOKEN_PROGRAM), associatedTokenAddress(s.address, mint, baseProgram)];

    // 3. Read the stand-in's accounts and every account the build writes, then build with what exists.
    const provisional = buildFor(t, s.address, new Set(), s.closeOmitted);
    if (typeof provisional === 'string') return fail('not-simulable', provisional);
    const writes = provisional.instructions.flatMap((ix) => ix.accounts.filter((m) => m.writable && !m.signer).map((m) => m.address));
    // The stand-in's three accounts first, then every other account the build writes, read again after the simulation
    // to see the rent actually paid. getMultipleAccounts and the read-back both take at most 100.
    const addresses = [...new Set<string>([...readBack, ...writes])];
    if (addresses.length > 100) return fail('not-simulable', `the build writes ${addresses.length} accounts; at most 100 can be read back`);
    const pre = await d.rpc.getMultipleAccounts(addresses, t.minContextSlot, d.priority);
    const quotedAt = t.common.quotedAtSlot;
    rec = { ...rec, readSlot: pre.slot, quoteAgeSlots: quotedAt === null ? null : pre.slot - quotedAt };
    const existing = new Set(addresses.filter((_, i) => pre.accounts[i] !== null) as Address[]);
    const built = buildFor(t, s.address, existing, s.closeOmitted);
    if (typeof built === 'string') return fail('not-simulable', built);

    // 4. Identical to the real build apart from the wallet's own keys and accounts.
    const map = substitution(t.common.wallet, s.address, mint, baseProgram);
    const same = sameStructure(real.tx.instructions, built.instructions, map, s.closeOmitted ? { baseAta: associatedTokenAddress(t.common.wallet, mint, baseProgram), baseTokenProgram: baseProgram } : null);
    if (!same.ok) return fail('structure-mismatch', same.reason);

    // 5. Simulate at or after the read.
    const minSlot = pre.slot > t.minContextSlot ? pre.slot : t.minContextSlot;
    const sim = await d.rpc.simulate(built.wire, addresses, minSlot, d.priority);
    rec = { ...rec, simulatedSlot: sim.slot, unitsConsumed: sim.value.unitsConsumed };
    if (sim.value.err !== null) return fail('sim-error', JSON.stringify(sim.value.err), { logsTail: sim.value.logs.slice(-LOG_TAIL) });

    // 6. Measure the amount from the balances read back.
    const [preWallet, preWsol, preBase] = pre.accounts as [RawAccount | null, RawAccount | null, RawAccount | null];
    const [postWallet, postWsol, postBase] = sim.value.accounts as [RawAccount | null, RawAccount | null, RawAccount | null];
    const o = built.tx.solOut;
    let measured: bigint;
    try {
      // Rent the transaction actually paid into other accounts. More than the build declared means the builder
      // under-counts the trade's cost: a failure, never absorbed into the amount.
      const vault = req.venue === 'curve' && req.market.curve.creator !== undefined ? pumpCreatorVault(req.market.curve.creator) : null;
      let paid = 0n;
      for (let i = readBack.length; i < addresses.length; i++) {
        paid += rentPaidInto(pre.accounts[i] ?? null, sim.value.accounts[i] ?? null, t.common.rates.rent, addresses[i] === vault);
      }
      rec = { ...rec, rentDeclared: o.rent, rentPaid: paid };
      if (paid > o.rent) return fail('amount-check', `the transaction paid ${paid} lamports of rent; the build declared ${o.rent}`);
      // The stand-in's own balances: taken by the node inside the simulation when it returns them (atomic, so a
      // transfer landing between our read and the simulation cannot move them), otherwise from our read.
      const atomic = atomicBalances(sim.value, decodeTransaction(built.wire).staticAccountKeys, readBack as Address[], mint);
      if (atomic === 'disagree') return fail('malformed', 'the simulation\'s post balances disagree with the accounts it read back');
      rec = { ...rec, balancesFrom: atomic === null ? 'read' : 'simulation' };
      const lamPre = atomic?.lamPre ?? [lamportsOf(preWallet), lamportsOf(preWsol), lamportsOf(preBase)];
      const lamPost = atomic?.lamPost ?? [lamportsOf(postWallet), lamportsOf(postWsol), lamportsOf(postBase)];
      const tokensPre = atomic?.tokensPre ?? tokenAmount(preBase);
      const tokensPost = atomic?.tokensPost ?? tokenAmount(postBase);
      if (req.side === 'buy') {
        measured = tokensPost - tokensPre;
      } else {
        const need = sellAmount(req);
        if (tokensPre - tokensPost !== need) return fail('amount-check', `token balance fell by ${tokensPre - tokensPost}, expected ${need}`);
        // SOL to the wallet: the change in its lamports, wrapped SOL and base account, plus what the transaction
        // itself pays: base and priority fee and tip (from the build) and the rent it actually paid.
        const before = lamPre[0]! + lamPre[1]! + lamPre[2]!;
        const after = lamPost[0]! + lamPost[1]! + lamPost[2]!;
        measured = after - before + o.baseFee + o.priorityFee + o.tip + paid;
      }
    } catch (e) {
      return fail('malformed', `account state does not decode: ${(e as Error).message}`);
    }
    if (measured <= 0n) return fail('amount-check', `simulated amount ${measured} is not positive`, { simulatedOut: measured });
    return { ...rec, outcome: 'simulated', success: true, error: null, simulatedOut: measured, amountErrorE4: amountErrorE4(measured, real.tx.quote.quotedOut) };
  } catch (e) {
    if (e instanceof ScheduleRefused) return fail('scheduler-refused', e.message);
    if (e instanceof ProviderError) return fail(e.kind === 'shape' ? 'malformed' : 'rpc-error', e.message);
    return fail('internal-error', (e as Error).message);
  }
};
