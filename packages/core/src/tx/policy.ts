// Signer policy checks (docs/ARCHITECTURE.md §12.1) as one pure function over a transaction decoded by the shared
// DEC-1 decoder. Default deny: a program, instruction or account use not listed here is a violation. SIGN-1 calls
// this before every signature; the worker calls it on every build too. It never trusts the builder's own accounting:
// the worst-case SOL out is recomputed from the decoded bytes.
import {
  type Address,
  type DecodedTransaction,
  type LoadedAddresses,
  NATIVE_MINT,
  PUMP_AMM_PROGRAM,
  PUMP_PROGRAM,
  SYSTEM_PROGRAM,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  Reader,
  accountKeys,
  isWritable,
  toHex,
} from '../chain/index.ts';
import {
  ATA_CREATE_IDEMPOTENT,
  CB_SET_COMPUTE_UNIT_LIMIT,
  CB_SET_COMPUTE_UNIT_PRICE,
  SYSTEM_TRANSFER,
  TOKEN_CLOSE_ACCOUNT,
  TOKEN_SYNC_NATIVE,
} from './native.ts';
import { ASSOCIATED_TOKEN_PROGRAM, COMPUTE_BUDGET_PROGRAM, JITO_DONT_FRONT, associatedTokenAddress, userVolumeAccumulator } from './programs.ts';
import { MAX_CREATED_ACCOUNT_BYTES, type RentRate, rentExempt } from './rent.ts';
import { MICRO_LAMPORTS_PER_LAMPORT } from './trade.ts';
import { DISC } from './venues.ts';

export interface SignerPolicyContext {
  /** The bot wallet: the only allowed signer and fee payer. */
  readonly wallet: Address;
  /** 'withdraw' allows a transfer to the saved owner address and nothing that trades. */
  readonly kind: 'trade' | 'withdraw';
  /** SOL out must not exceed this: the intent's reserved exposure plus its fee cap (entries), or the exit fee cap. */
  readonly maxSolOut: bigint;
  readonly maxPriorityFeeLamports: bigint;
  readonly maxTipLamports: bigint;
  readonly tipAccounts: readonly Address[];
  /** The one saved owner address. Null: no withdrawal is possible. */
  readonly withdrawalAddress: Address | null;
  readonly lamportsPerSignature: bigint;
  /** The live rent rate. Each account a swap may create or top up is charged at the largest size any of them has. */
  readonly rent: RentRate;
}

export interface PolicyVerdict {
  readonly ok: boolean;
  readonly violations: readonly string[];
  /** Worst-case lamports leaving the wallet, from the decoded bytes. */
  readonly solOut: bigint;
}

const TRADE_PROGRAMS = new Set<Address>([SYSTEM_PROGRAM, COMPUTE_BUDGET_PROGRAM, TOKEN_PROGRAM, TOKEN_2022_PROGRAM, ASSOCIATED_TOKEN_PROGRAM, PUMP_PROGRAM, PUMP_AMM_PROGRAM]);
const WITHDRAW_PROGRAMS = new Set<Address>([SYSTEM_PROGRAM, COMPUTE_BUDGET_PROGRAM]);
const TOKEN_PROGRAMS = new Set<Address>([TOKEN_PROGRAM, TOKEN_2022_PROGRAM]);

/**
 * Per swap instruction: the account positions that belong to the wallet (each must be a static key and match its
 * derivation), and how many accounts the swap may create or top up at the wallet's expense (venue docs; each is
 * charged as the largest account any of them can be, `MAX_CREATED_ACCOUNT_BYTES`).
 */
interface SwapRule {
  readonly program: Address;
  readonly name: string;
  readonly user: number;
  readonly baseMint: number;
  readonly quoteMint: number;
  readonly baseTokenProgram: number;
  readonly quoteTokenProgram: number;
  readonly userBase: number;
  readonly userQuote: number;
  readonly userVolumeAccumulator: number | null;
  /** Further wallet-owned positions that must be static keys (e.g. the accumulator's quote ATA). */
  readonly alsoStatic: readonly number[];
  /** Minimum account count (the named accounts); remaining accounts may follow. */
  readonly accounts: number;
  readonly inits: number;
  /**
   * Lamports the swap may spend: native SOL from the wallet (curve buys), or wrapped SOL from the wallet's ATA (PumpSwap
   * buys). Wrapped SOL already sitting in that ATA (anyone can send some) would be spent too, so a PumpSwap spend is
   * charged even when no wrap transfer in this transaction funds it.
   */
  readonly solIn: (data: Uint8Array) => bigint;
  /** True when `solIn` is paid from the wrapped-SOL ATA rather than native SOL. */
  readonly fromWrap: boolean;
}

const u64At = (data: Uint8Array, offset: number): bigint => new Reader(data, offset).u64();
const noSol = () => 0n;

const SWAPS = new Map<string, SwapRule>([
  // pump buy_exact_quote_in_v2: user volume accumulator, creator-vault top-up and bonding-curve growth may be charged.
  [`${PUMP_PROGRAM}:${DISC.curveBuyExactQuoteInV2}`, {
    program: PUMP_PROGRAM, name: 'pump buy_exact_quote_in_v2', user: 13, baseMint: 1, quoteMint: 2, baseTokenProgram: 3, quoteTokenProgram: 4,
    userBase: 14, userQuote: 15, userVolumeAccumulator: 20, alsoStatic: [21], accounts: 27, inits: 3, solIn: (d) => u64At(d, 8), fromWrap: false,
  }],
  [`${PUMP_PROGRAM}:${DISC.curveSellV2}`, {
    program: PUMP_PROGRAM, name: 'pump sell_v2', user: 13, baseMint: 1, quoteMint: 2, baseTokenProgram: 3, quoteTokenProgram: 4,
    userBase: 14, userQuote: 15, userVolumeAccumulator: 19, alsoStatic: [20], accounts: 26, inits: 3, solIn: noSol, fromWrap: false,
  }],
  // PumpSwap v1: the protocol-fee, coin-creator and buyback-recipient quote ATAs (and, on buys, the user volume
  // accumulator) if missing. The buyback ATAs all exist on chain (checked 2026-10-03, slot 452960110) and the IDL
  // does not list them as created; the program is not open source, so they are charged anyway. The buy's spend is
  // spendable_quote_in, charged against the larger of itself and the wrap transfers.
  [`${PUMP_AMM_PROGRAM}:${DISC.poolBuyExactQuoteIn}`, {
    program: PUMP_AMM_PROGRAM, name: 'PumpSwap buy_exact_quote_in', user: 1, baseMint: 3, quoteMint: 4, baseTokenProgram: 11, quoteTokenProgram: 12,
    userBase: 5, userQuote: 6, userVolumeAccumulator: 20, alsoStatic: [], accounts: 23, inits: 4, solIn: (d) => u64At(d, 8), fromWrap: true,
  }],
  [`${PUMP_AMM_PROGRAM}:${DISC.poolSell}`, {
    program: PUMP_AMM_PROGRAM, name: 'PumpSwap sell', user: 1, baseMint: 3, quoteMint: 4, baseTokenProgram: 11, quoteTokenProgram: 12,
    userBase: 5, userQuote: 6, userVolumeAccumulator: null, alsoStatic: [], accounts: 21, inits: 3, solIn: noSol, fromWrap: false,
  }],
]);

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

export const checkSignerPolicy = (tx: DecodedTransaction, loaded: LoadedAddresses, ctx: SignerPolicyContext): PolicyVerdict => {
  const v: string[] = [];
  let keys: Address[];
  try {
    keys = accountKeys(tx, loaded);
  } catch (e) {
    return { ok: false, violations: [(e as Error).message], solOut: 0n };
  }
  // The runtime refuses a key loaded twice (AccountLoadedTwice); accountKeys refuses it too. Checked here again so the
  // policy never depends on the decoder for it.
  if (new Set(keys).size !== keys.length) return { ok: false, violations: ['an account key appears more than once'], solOut: 0n };
  const nStatic = tx.staticAccountKeys.length;
  const isStatic = (index: number) => index < nStatic;
  const wsolAta = associatedTokenAddress(ctx.wallet, NATIVE_MINT, TOKEN_PROGRAM);

  if (tx.version !== 0 && tx.version !== 'legacy') v.push(`transaction version ${tx.version} is not allowed`);
  if (tx.header.numRequiredSignatures !== 1) v.push(`exactly one signer is allowed, got ${tx.header.numRequiredSignatures}`);
  if (tx.staticAccountKeys[0] !== ctx.wallet) v.push('fee payer is not the bot wallet');
  if (loaded.writable.includes(ctx.wallet) || loaded.readonly.includes(ctx.wallet)) v.push('the bot wallet is loaded from a lookup table');

  const programs = ctx.kind === 'withdraw' ? WITHDRAW_PROGRAMS : TRADE_PROGRAMS;
  let cuLimit: number | null = null;
  let cuPrice: bigint | null = null;
  let tips = 0;
  let tipTotal = 0n;
  let transfersOut = 0n;
  let wrapIn = 0n;
  let swapSol = 0n;
  let wrapSpend = 0n;
  let inits = 0;
  let swaps = 0;
  const created: Address[] = [];
  const closed = new Set<Address>();
  const wrapped: number[] = [];

  tx.instructions.forEach((ix, n) => {
    const program = keys[ix.programIdIndex]!;
    const at = (i: number): Address | undefined => (ix.accounts[i] === undefined ? undefined : keys[ix.accounts[i]!]);
    const where = `instruction ${n}`;
    if (!programs.has(program)) {
      v.push(`${where}: program ${program} is not allowed`);
      return;
    }
    const d = ix.data;

    if (program === COMPUTE_BUDGET_PROGRAM) {
      if (ix.accounts.length !== 0) v.push(`${where}: compute budget takes no accounts`);
      if (d[0] === CB_SET_COMPUTE_UNIT_LIMIT && d.length === 5) {
        if (cuLimit !== null) v.push(`${where}: second compute-unit limit`);
        cuLimit = new Reader(d, 1).u32();
      } else if (d[0] === CB_SET_COMPUTE_UNIT_PRICE && d.length === 9) {
        if (cuPrice !== null) v.push(`${where}: second compute-unit price`);
        cuPrice = u64At(d, 1);
      } else {
        v.push(`${where}: compute budget instruction ${d[0]} is not allowed`);
      }
      return;
    }

    if (program === SYSTEM_PROGRAM) {
      if (d.length !== 12 || new Reader(d).u32() !== SYSTEM_TRANSFER) {
        v.push(`${where}: only System transfer is allowed`);
        return;
      }
      const lamports = u64At(d, 4);
      const [fromIx, toIx] = ix.accounts;
      if (fromIx !== 0) v.push(`${where}: transfer must come from the bot wallet`);
      if (toIx === undefined || !isStatic(toIx)) {
        v.push(`${where}: transfer destination must be a static key`);
        return;
      }
      for (let i = 2; i < ix.accounts.length; i++) {
        const k = ix.accounts[i]!;
        if (keys[k] !== JITO_DONT_FRONT || isWritable(tx, k, loaded) || k < tx.header.numRequiredSignatures) v.push(`${where}: extra transfer account ${keys[k]} is not allowed`);
      }
      const to = keys[toIx]!;
      transfersOut += lamports;
      if (ctx.tipAccounts.includes(to)) {
        tips++;
        tipTotal += lamports;
      } else if (to === wsolAta && ctx.kind === 'trade') {
        wrapped.push(n);
        transfersOut -= lamports;
        wrapIn += lamports;
      } else if (ctx.kind === 'withdraw' && ctx.withdrawalAddress !== null && to === ctx.withdrawalAddress) {
        // The saved owner address: the only withdrawal destination.
      } else {
        v.push(`${where}: transfer to ${to} is not allowed`);
      }
      return;
    }

    if (program === ASSOCIATED_TOKEN_PROGRAM) {
      if (d.length !== 1 || d[0] !== ATA_CREATE_IDEMPOTENT) {
        v.push(`${where}: only CreateIdempotent is allowed on the associated token program`);
        return;
      }
      const [payer, ata, owner, mint, system, tokenProgram] = [0, 1, 2, 3, 4, 5].map(at);
      if (ix.accounts[0] !== 0 || payer !== ctx.wallet) v.push(`${where}: ATA payer must be the bot wallet`);
      if (owner !== ctx.wallet) v.push(`${where}: ATA owner must be the bot wallet`);
      if (system !== SYSTEM_PROGRAM || tokenProgram === undefined || !TOKEN_PROGRAMS.has(tokenProgram)) v.push(`${where}: ATA programs are wrong`);
      if (ix.accounts[1] === undefined || !isStatic(ix.accounts[1])) v.push(`${where}: the new ATA must be a static key`);
      else if (mint === undefined || tokenProgram === undefined || ata !== associatedTokenAddress(ctx.wallet, mint, tokenProgram)) v.push(`${where}: account is not the wallet's ATA for that mint`);
      else created.push(ata);
      return;
    }

    if (TOKEN_PROGRAMS.has(program)) {
      if (d.length === 1 && d[0] === TOKEN_SYNC_NATIVE) {
        if (at(0) !== wsolAta || program !== TOKEN_PROGRAM) v.push(`${where}: SyncNative only on the wallet's wrapped-SOL account`);
        return;
      }
      if (d.length === 1 && d[0] === TOKEN_CLOSE_ACCOUNT) {
        const [account, dest, authority] = [0, 1, 2].map(at);
        if (ix.accounts[0] === undefined || !isStatic(ix.accounts[0])) v.push(`${where}: closed account must be a static key`);
        if (dest !== ctx.wallet) v.push(`${where}: close must return lamports to the bot wallet`);
        if (authority !== ctx.wallet || ix.accounts[2] !== 0) v.push(`${where}: close authority must be the bot wallet`);
        if (account !== undefined) closed.add(account);
        return;
      }
      v.push(`${where}: token instruction ${d[0]} is not allowed`);
      return;
    }

    // pump and PumpSwap swaps.
    const rule = SWAPS.get(`${program}:${toHex(d.subarray(0, 8))}`);
    if (!rule) {
      v.push(`${where}: ${program} instruction ${toHex(d.subarray(0, 8))} is not allowed`);
      return;
    }
    swaps++;
    if (d.length < 24 || ix.accounts.length < rule.accounts) {
      v.push(`${where}: ${rule.name} is malformed`);
      return;
    }
    const staticOnly = [rule.user, rule.userBase, rule.userQuote, ...(rule.userVolumeAccumulator === null ? [] : [rule.userVolumeAccumulator]), ...rule.alsoStatic];
    for (const p of staticOnly) if (!isStatic(ix.accounts[p]!)) v.push(`${where}: ${rule.name} account ${p} must be a static key`);
    if (ix.accounts[rule.user] !== 0) v.push(`${where}: ${rule.name} user must be the bot wallet`);
    if (at(rule.quoteMint) !== NATIVE_MINT || at(rule.quoteTokenProgram) !== TOKEN_PROGRAM) v.push(`${where}: ${rule.name} must be quoted in wrapped SOL`);
    const baseProgram = at(rule.baseTokenProgram)!;
    if (!TOKEN_PROGRAMS.has(baseProgram)) v.push(`${where}: ${rule.name} base token program is not a token program`);
    else if (at(rule.userBase) !== associatedTokenAddress(ctx.wallet, at(rule.baseMint)!, baseProgram)) v.push(`${where}: ${rule.name} base account is not the wallet's ATA`);
    if (at(rule.userQuote) !== wsolAta) v.push(`${where}: ${rule.name} quote account is not the wallet's wrapped-SOL ATA`);
    if (rule.userVolumeAccumulator !== null && at(rule.userVolumeAccumulator) !== userVolumeAccumulator(rule.program, ctx.wallet)) {
      v.push(`${where}: ${rule.name} volume accumulator is not the wallet's`);
    }
    if (rule.fromWrap) wrapSpend += rule.solIn(d);
    else swapSol += rule.solIn(d);
    inits += rule.inits;
  });

  if (ctx.kind === 'trade' && swaps !== 1) v.push(`a trade carries exactly one swap, got ${swaps}`);
  if (cuLimit === null || cuPrice === null) v.push('compute-unit limit and price are both required');
  const priorityFee = cuLimit !== null && cuPrice !== null ? ceilDiv(cuPrice * BigInt(cuLimit), MICRO_LAMPORTS_PER_LAMPORT) : 0n;
  if (priorityFee > ctx.maxPriorityFeeLamports) v.push(`priority fee ${priorityFee} is above the ${ctx.maxPriorityFeeLamports} cap`);
  if (tips > 1) v.push(`at most one tip, got ${tips}`);
  if (tipTotal > ctx.maxTipLamports) v.push(`tip ${tipTotal} is above the ${ctx.maxTipLamports} ceiling`);
  // Wrapping is allowed only into an account this transaction closes back to the wallet afterwards.
  if (wrapped.length > 0 && !closed.has(wsolAta)) v.push('wrapped SOL is never closed back to the wallet');

  // An account created and closed in this transaction returns its rent; any other creation is charged.
  const rent = BigInt(created.filter((a) => !closed.has(a)).length + inits) * rentExempt(MAX_CREATED_ACCOUNT_BYTES, ctx.rent);
  // Wrapped SOL leaves the wallet either through the wrap transfers or as the PumpSwap spend; the larger is charged.
  const wrapOut = wrapIn > wrapSpend ? wrapIn : wrapSpend;
  const solOut = ctx.lamportsPerSignature * BigInt(tx.header.numRequiredSignatures) + priorityFee + transfersOut + wrapOut + swapSol + rent;
  if (solOut > ctx.maxSolOut) v.push(`worst-case SOL out ${solOut} is above the allowed ${ctx.maxSolOut}`);
  return { ok: v.length === 0, violations: v, solOut };
};
