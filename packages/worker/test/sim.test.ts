// SIM-1: the H15 round-trip simulation on a stub RPC. A clean simulation gives the exact raw read FACTS-1 ingests;
// every failure mode gives no fact or a failed one, never a pass; a malformed answer is refused; no key leaks.
import { describe, expect, it } from 'vitest';
import {
  type Address, NATIVE_MINT, PUMP_AMM_PROGRAM, PUMP_PROGRAM, TOKEN_PROGRAM, bondingCurveAddress, decodeTransaction, toBase64,
} from '../../core/src/chain/index.ts';
import type { RoundTrip } from '../../core/src/costs/index.ts';
import { parseSimRead } from '../../core/src/facts/raw.ts';
import { POLICY, RATES, SPEND, common, goldenOf, request } from '../../core/test/tx/fixtures-policy.ts';
import { Writer, associatedTokenAddress, pumpCreatorVault, rentExempt, userVolumeAccumulator } from '../../core/src/tx/index.ts';
import { DryRunRpc, type RawAccount } from '../src/dryrun/index.ts';
import { HELIUS_FREE, ManualTimers, P0, P1, P2, P3, Scheduler } from '../src/scheduler/index.ts';
import { type RoundTripRequest, RoundTripSimulator, rentInto } from '../src/sim/index.ts';
import { blockNetwork, KEYS } from './helpers.ts';
import { type StubAccount, type StubChain, SYSTEM, stubChain, testAddress, tokenAccount, wallet } from './dryrun-chain.ts';

blockNetwork();

const S = testAddress(2);
const URL = `https://mainnet.helius-rpc.com/?api-key=${KEYS.HELIUS_API_KEY}`;
const FEE = 10_000n;
const TRADE_EVENT = [189, 219, 127, 211, 78, 230, 97, 238];
const BUY_EVENT = [103, 244, 82, 31, 44, 245, 119, 119];
const ATA_RENT = 2_039_280n;

type Venue = 'curve' | 'pool';

const roundTripRequest = (venue: Venue, over: Partial<RoundTripRequest> = {}): RoundTripRequest => {
  const r = request(venue === 'curve' ? 'curve-buy' : 'pool-buy');
  if (r.side !== 'buy') throw new Error('buy');
  const tokens = r.venue === 'curve' ? r.quote.tokens : r.quote.base;
  const quote: RoundTrip = { spend: SPEND, paid: r.quote.userQuote, tokens, proceeds: 38_000_000n, immediateProceeds: 38_000_000n, entryFees: 0n, exitFees: 0n, entryImpact: 0n, exitImpact: 0n };
  return {
    mint: r.mint,
    venue: r.venue === 'curve' ? { venue: 'curve', market: r.market } : { venue: 'pool', market: r.market },
    spend: SPEND,
    quote,
    common: common(goldenOf(venue === 'curve' ? 'curve-buy' : 'pool-buy')),
    policy: POLICY,
    minContextSlot: 1_000n,
    ...over,
  };
};

const mintOf = (q: RoundTripRequest) => (q.venue.venue === 'curve' ? q.venue.market.mint : q.venue.market.state.baseMint);

/** Borsh bytes of the buy event the venue emits, as an Anchor `Program data:` log line inside its invoke. */
const buyLog = (venue: Venue, mint: string, user: Address, paid: bigint, creatorFee = 100_000n): string[] => {
  const w = new Writer();
  if (venue === 'curve') {
    const fee = 400_000n;
    w.bytes(Uint8Array.from(TRADE_EVENT)).pubkey(mint as Address).u64(paid - fee - creatorFee).u64(1_000n).bool(true).pubkey(user).u64(0n)
      .u64(1n).u64(1n).u64(1n).u64(1n).pubkey(user).u64(95n).u64(fee).pubkey(user).u64(5n).u64(creatorFee);
  } else {
    w.bytes(Uint8Array.from(BUY_EVENT)).u64(0n);
    for (let i = 0; i < 12; i++) w.u64(1n);
    w.u64(paid);
    for (let i = 0; i < 6; i++) w.pubkey(user);
  }
  const program = venue === 'curve' ? PUMP_PROGRAM : PUMP_AMM_PROGRAM;
  return [`Program ${program} invoke [1]`, `Program data: ${toBase64(w.done())}`, `Program ${program} success`];
};

const accountJson = (a: StubAccount | null) =>
  a === null ? null : { owner: a.owner, lamports: Number(a.lamports), data: [toBase64(a.data), 'base64'], executable: false, rentEpoch: 0 };

interface Script {
  /** The venue loss the round trip really takes (paid − proceeds). */
  readonly loss: bigint;
  readonly paid?: bigint;
  /** Accounts missing before that the round trip creates at the wallet's expense (address → lamports after). */
  readonly creates?: ReadonlyMap<string, bigint>;
  /** Lamports the wallet pays into existing accounts besides the loss (address → lamports added). */
  readonly pays?: ReadonlyMap<string, bigint>;
  /** Data the round trip leaves in an account (e.g. a grown curve). */
  readonly dataAfter?: ReadonlyMap<string, Uint8Array>;
  readonly logs?: (paid: bigint) => string[];
  /** Edits the JSON value before it is returned. */
  readonly tamper?: (value: Record<string, unknown>, keys: string[]) => void;
}

/**
 * A simulation that charges the stand-in the network fee, the venue loss and the rent of what it creates,
 * and reports the node's own balances for every account key.
 */
const script = (chain: StubChain, q: RoundTripRequest, sc: Script) => {
  chain.simulate = (sim, accounts) => {
    const keys: string[] = [...decodeTransaction(sim.wire).staticAccountKeys];
    const mint = mintOf(q);
    const baseAta = associatedTokenAddress(S, mint, q.venue.market.baseTokenProgram);
    const creates = sc.creates ?? new Map();
    const pre = new Map(keys.map((k) => [k, accounts.get(k)?.lamports ?? 0n] as const));
    const post = new Map(pre);
    const pays = sc.pays ?? new Map();
    const rentCreated = [...creates.values(), ...pays.values()].reduce((a, b) => a + b, 0n);
    post.set(S, pre.get(S)! - FEE - sc.loss - ATA_RENT - rentCreated);
    for (const [a, l] of pays) post.set(a, pre.get(a)! + l);
    post.set(baseAta, ATA_RENT);
    for (const [a, l] of creates) post.set(a, l);
    const after = (a: string): StubAccount | null => {
      const l = post.get(a) ?? 0n;
      if (l === 0n) return null;
      if (a === baseAta) return tokenAccount(mint as Address, S, 0n, ATA_RENT);
      const data = sc.dataAfter?.get(a);
      return { ...(accounts.get(a) ?? wallet(l)), lamports: l, ...(data === undefined ? {} : { data }) };
    };
    const paid = sc.paid ?? q.quote.paid;
    const value: Record<string, unknown> = {
      err: null,
      logs: (sc.logs ?? ((p) => buyLog(q.venue.venue, mint, S, p)))(paid),
      accounts: sim.addresses.map((a) => accountJson(after(a))),
      unitsConsumed: 120_000,
      fee: Number(FEE),
      preBalances: keys.map((k) => Number(pre.get(k))),
      postBalances: keys.map((k) => Number(post.get(k))),
      preTokenBalances: [],
      postTokenBalances: [],
    };
    sc.tamper?.(value, keys);
    return { raw: { context: { slot: 2_000 }, value } };
  };
};

const setup = (venue: Venue, o: { scheduler?: Scheduler; priority?: typeof P2 } = {}) => {
  const { chain, http } = stubChain();
  const timers = new ManualTimers(1_000);
  const scheduler = o.scheduler ?? new Scheduler({ ...HELIUS_FREE, window: { limit: 1_000, windowMs: 1_000 } }, { timers });
  const rpc = new DryRunRpc({ url: () => URL, http, scheduler, timeoutMs: 2_000 });
  chain.accounts.set(S, wallet(10n ** 12n));
  const q = roundTripRequest(venue);
  // Every account the round trip writes exists, except the stand-in's own token accounts and volume accumulator.
  const program = venue === 'curve' ? PUMP_PROGRAM : PUMP_AMM_PROGRAM;
  for (const a of [bondingCurveAddress(mintOf(q)), ...POLICY.tipAccounts, ...(q.venue.venue === 'curve' ? [pumpCreatorVault(q.venue.market.curve.creator!)] : [])]) {
    chain.accounts.set(a, wallet(10n ** 9n));
  }
  chain.accounts.set(userVolumeAccumulator(program, S), wallet(rentExempt(137, RATES.rent)));
  const sim = new RoundTripSimulator({ rpc, priority: o.priority ?? P2, standIn: S, standInCheckMs: 60_000, now: () => timers.now() });
  return { chain, sim, q, timers };
};

const VENUES: readonly Venue[] = ['curve', 'pool'];

describe('SIM-1: a clean round trip gives the fact FACTS-1 ingests', () => {
  it.each(VENUES)('%s: paid from the buy event, proceeds = paid − measured loss, in the exact raw shape', async (venue) => {
    const { chain, sim, q } = setup(venue);
    script(chain, q, { loss: 600_000n });
    const r = await sim.simulate(q);
    expect(r.record).toMatchObject({ outcome: 'simulated', reason: null, credits: 2, loss: 600_000n, networkFee: FEE, rentPaid: 0n, slot: 2_000n });
    expect(r.read).toEqual({ mint: mintOf(q), slot: 2_000n, spend: SPEND, ok: true, paid: q.quote.paid, proceeds: q.quote.paid - 600_000n, error: null });
    expect(parseSimRead(r.read)).not.toBeNull();
    // Simulated as TEST-2 does: unsigned, signature checks off, fresh blockhash, stand-in as fee payer.
    const req = chain.requests.find((x) => x.method === 'simulateTransaction')!;
    expect(req.params[1]).toMatchObject({ sigVerify: false, replaceRecentBlockhash: true, innerInstructions: true, minContextSlot: 1_000 });
    const tx = decodeTransaction(Uint8Array.from(Buffer.from(req.params[0] as string, 'base64')));
    expect(tx.staticAccountKeys[0]).toBe(S);
    // One transaction: both swaps and one compute budget; no tip (it cannot change the venue loss).
    const programs = tx.instructions.map((ix) => tx.staticAccountKeys[ix.programIdIndex]);
    expect(programs.filter((p) => p === (venue === 'curve' ? PUMP_PROGRAM : PUMP_AMM_PROGRAM))).toHaveLength(2);
    expect(tx.staticAccountKeys.some((k) => POLICY.tipAccounts.includes(k))).toBe(false);
  });

  it('the stand-in funding check is cached: the next simulation costs one credit', async () => {
    const { chain, sim, q, timers } = setup('curve');
    script(chain, q, { loss: 1n });
    expect((await sim.simulate(q)).record.credits).toBe(2);
    expect((await sim.simulate(q)).record.credits).toBe(1);
    timers.advance(60_000);
    expect((await sim.simulate(q)).record.credits).toBe(2);
  });

  it('rent paid into new accounts is not counted as venue loss', async () => {
    const { chain, sim, q } = setup('curve');
    const uva = userVolumeAccumulator(PUMP_PROGRAM, S);
    chain.accounts.delete(uva);
    const uvaRent = rentExempt(137, RATES.rent);
    script(chain, q, { loss: 500_000n, creates: new Map([[uva, uvaRent]]), dataAfter: new Map([[uva, new Uint8Array(137)]]) });
    const r = await sim.simulate(q);
    expect(r.record).toMatchObject({ outcome: 'simulated', rentPaid: uvaRent, loss: 500_000n });
    expect(r.read?.proceeds).toBe(q.quote.paid - 500_000n);
  });

  it('a charge the model misses lowers proceeds (the loss is measured, not modelled)', async () => {
    const { chain, sim, q } = setup('pool');
    script(chain, q, { loss: q.quote.paid - q.quote.proceeds + 1_000_000n });
    const r = await sim.simulate(q);
    expect(r.read?.ok).toBe(true);
    expect(r.read!.paid - r.read!.proceeds).toBe(q.quote.paid - q.quote.proceeds + 1_000_000n);
  });
});

describe('SIM-1: every failure gives no fact or a failed one, never a pass', () => {
  const noFact = async (venue: Venue, f: (c: StubChain, q: RoundTripRequest) => RoundTripRequest | void, outcome: string) => {
    const { chain, sim, q } = setup(venue);
    script(chain, q, { loss: 1n });
    const q2 = f(chain, q) ?? q;
    const r = await sim.simulate(q2);
    expect(r.record.outcome).toBe(outcome);
    expect(r.read).toBeNull();
    return { r, chain };
  };
  const failedFact = async (venue: Venue, sc: Partial<Script> | ((c: StubChain) => void), outcome: string) => {
    const { chain, sim, q } = setup(venue);
    if (typeof sc === 'function') sc(chain);
    else script(chain, q, { loss: 1n, ...sc });
    const r = await sim.simulate(q);
    expect(r.record.outcome).toBe(outcome);
    expect(r.read).not.toBeNull();
    expect(r.read!.ok).toBe(false);
    expect(r.read!.error).toBeTruthy();
    expect(parseSimRead(r.read)).not.toBeNull();
    return r;
  };

  it('a program error, and a stale blockhash, are failed facts with the error', async () => {
    let r = await failedFact('curve', (c) => { c.simulate = () => ({ err: { InstructionError: [4, { Custom: 6002 }] }, logs: ['Program log: Error: TooMuchSolRequired'] }); }, 'sim-failed');
    expect(r.read!.error).toContain('6002');
    r = await failedFact('pool', (c) => { c.simulate = () => ({ err: 'BlockhashNotFound', logs: [] }); }, 'sim-failed');
    expect(r.read!.error).toContain('BlockhashNotFound');
  });

  it('missing fee data, missing balances, balances that disagree with the read-back: failed facts', async () => {
    await failedFact('curve', { tamper: (v) => { delete v.fee; } }, 'flagged');
    await failedFact('curve', { tamper: (v) => { v.preBalances = null; } }, 'flagged');
    await failedFact('pool', { tamper: (v) => { (v.postBalances as number[]).pop(); } }, 'flagged');
    await failedFact('pool', { tamper: (v) => { (v.postBalances as number[])[0]! += 1; } }, 'flagged');
  });

  it('no buy event, a truncated log, a paid above the spend, a loss above paid: failed facts', async () => {
    await failedFact('curve', { logs: () => ['Program log: nothing'] }, 'flagged');
    await failedFact('pool', { logs: (p) => [...buyLog('pool', 'x', testAddress(9), p)] }, 'flagged');
    await failedFact('curve', { logs: () => ['Log truncated'] }, 'flagged');
    await failedFact('pool', { paid: SPEND + 1n }, 'flagged');
    await failedFact('curve', { loss: SPEND * 2n }, 'flagged');
  });

  it('a timeout, an HTTP error and a rate limit: no fact', async () => {
    const { chain: c1 } = await noFact('curve', (c) => { c.override.simulateTransaction = () => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); }; }, 'rpc-error');
    expect(c1.requests.some((x) => x.method === 'simulateTransaction')).toBe(true);
    await noFact('curve', (c) => { c.override.simulateTransaction = () => ({ status: 500, text: '' }); }, 'rpc-error');
    await noFact('pool', (c) => { c.override.simulateTransaction = () => ({ status: 429, text: '' }); }, 'rpc-error');
    await noFact('pool', (c) => { c.override.simulateTransaction = () => ({ status: 200, text: '{"jsonrpc":"2.0","id":1,"error":{"code":-32002}}' }); }, 'rpc-error');
  });

  it('an unsupported shape and a refused build: no fact, no request', async () => {
    const { r, chain } = await noFact('curve', (_, q) => (q.venue.venue === 'curve' ? { ...q, venue: { venue: 'curve', market: { ...q.venue.market, curve: { ...q.venue.market.curve, isMayhemMode: true } } } } : q), 'unsupported-shape');
    expect(r.record.reason).toContain('mayhem');
    expect(chain.requests).toHaveLength(0);
    const b = await noFact('pool', (_, q) => ({ ...q, spend: q.spend + 1n }), 'build-refused');
    expect(b.chain.requests).toHaveLength(0);
  });

  it('an unfunded stand-in: no fact, no simulation', async () => {
    const { chain } = await noFact('curve', (c) => { c.accounts.set(S, wallet(1_000n)); }, 'stand-in-unfunded');
    expect(chain.requests.map((x) => x.method)).toEqual(['getMultipleAccounts']);
    await noFact('pool', (c) => { c.accounts.set(S, { owner: TOKEN_PROGRAM, lamports: 10n ** 12n, data: new Uint8Array(1) }); }, 'stand-in-unfunded');
  });

  it('the budget spent (scheduler halted): not evaluated, no fact, no credit', async () => {
    const halted = new Scheduler(HELIUS_FREE, { timers: new ManualTimers(0), creditsUsed: 1_000_000 });
    const { chain, sim, q } = setup('curve', { scheduler: halted });
    script(chain, q, { loss: 1n });
    const r = await sim.simulate(q);
    expect(r).toMatchObject({ read: null, record: { outcome: 'not-evaluated', credits: 0 } });
    expect(chain.requests).toHaveLength(0);
  });

  it('a malformed simulate response is refused: no fact', async () => {
    const bad: ((v: Record<string, unknown>) => void)[] = [
      (v) => { v.accounts = []; },
      (v) => { (v.preBalances as unknown[])[0] = -1; },
      (v) => { v.fee = 'ten'; },
      (v) => { v.logs = [1]; },
      (v) => { delete v.err; },
    ];
    for (const tamper of bad) {
      const { chain, sim, q } = setup('curve');
      script(chain, q, { loss: 1n, tamper });
      const r = await sim.simulate(q);
      expect(r.record.outcome).toBe('malformed');
      expect(r.read).toBeNull();
    }
  });

  it('P0 and P1 are refused before any request; P3 is allowed', () => {
    expect(() => setup('curve', { priority: P0 })).toThrow(RangeError);
    expect(() => setup('curve', { priority: P1 })).toThrow(RangeError);
    expect(() => setup('curve', { priority: P3 })).not.toThrow();
  });

  it('no key reaches a record, a read or a request body', async () => {
    const out: unknown[] = [];
    for (const venue of VENUES) {
      const { chain, sim, q } = setup(venue);
      script(chain, q, { loss: 1n });
      out.push(await sim.simulate(q));
      chain.override.simulateTransaction = () => { throw new Error(`connect ECONNREFUSED ${URL}`); };
      out.push(await sim.simulate(q));
      for (const x of chain.requests) expect(JSON.stringify(x.params)).not.toContain(KEYS.HELIUS_API_KEY);
    }
    expect(JSON.stringify(out, (_, v) => (typeof v === 'bigint' ? v.toString() : v))).not.toContain(KEYS.HELIUS_API_KEY);
  });
});

describe('SIM-1: rent paid into other accounts (review of PR #59)', () => {
  const rate = RATES.rent.lamportsPerByte;
  const raw = (a: StubAccount): RawAccount => ({ executable: false, ...a });
  const ctx = (o: { creatorFees?: bigint; curveBytesBefore?: number | null } = {}) => ({ lamportsPerByte: rate, creatorFees: o.creatorFees ?? 0n, curveBytesBefore: o.curveBytesBefore ?? null });
  const need = rentExempt(0, RATES.rent);

  it('a new account counts at most the rent-exempt minimum for its size; the rest stays in the loss', () => {
    expect(rentInto(0n, need, raw(wallet(need)), 'other', ctx())).toBe(need);
    expect(rentInto(0n, need + 777n, raw(wallet(need + 777n)), 'other', ctx())).toBe(need);
    expect(rentInto(5n, 5n, raw(wallet(5n)), 'other', ctx())).toBe(0n);
    const reserve = rentExempt(165, RATES.rent);
    const wsol = tokenAccount(NATIVE_MINT, S, 7n, 7n + reserve);
    const native = { ...wsol, owner: TOKEN_PROGRAM, data: wsol.data.slice(0, 165) };
    const dv = new DataView(native.data.buffer, native.data.byteOffset);
    dv.setUint32(109, 1, true);
    dv.setBigUint64(113, reserve, true);
    // The wrapped balance (7) is not rent.
    expect(rentInto(0n, 7n + reserve, raw(native), 'other', ctx())).toBe(reserve);
    dv.setBigUint64(113, reserve * 5n, true); // a reserve above the minimum is capped too
    expect(rentInto(0n, 7n + reserve, raw(native), 'other', ctx())).toBe(reserve);
  });

  it('the creator vault: only what it gained beyond the creator fees, at most its shortfall', () => {
    // An empty vault that receives fees >= the minimum needs no top-up.
    expect(rentInto(0n, need + 5n, raw(wallet(need + 5n)), 'vault', ctx({ creatorFees: need + 5n }))).toBe(0n);
    // Fees below the minimum: the wallet tops up the rest.
    expect(rentInto(0n, need, raw(wallet(need)), 'vault', ctx({ creatorFees: 100_000n }))).toBe(need - 100_000n);
    // A vault already rent-exempt gets no top-up whatever it gains.
    expect(rentInto(need, need + 900_000n, raw(wallet(need + 900_000n)), 'vault', ctx({ creatorFees: 0n }))).toBe(0n);
  });

  it('curve growth counts only against a measured length, never without one', () => {
    const curve = (n: number) => raw({ owner: PUMP_PROGRAM, lamports: 1n, data: new Uint8Array(n) });
    expect(rentInto(1n, 1n, curve(151), 'curve', ctx({ curveBytesBefore: 120 }))).toBe(31n * rate);
    expect(rentInto(1n, 1n, curve(151), 'curve', ctx({ curveBytesBefore: 151 }))).toBe(0n);
    expect(rentInto(1n, 1n, curve(151), 'curve', ctx({ curveBytesBefore: null }))).toBe(0n);
  });
});

describe('SIM-1: review fixes end to end (PR #59)', () => {
  it('a new account that receives rent + X: X stays in the loss', async () => {
    const { chain, sim, q } = setup('curve');
    const uva = userVolumeAccumulator(PUMP_PROGRAM, S);
    chain.accounts.delete(uva);
    const need = rentExempt(0, RATES.rent);
    script(chain, q, { loss: 500_000n, creates: new Map([[uva, need + 12_345n]]) });
    const r = await sim.simulate(q);
    expect(r.record).toMatchObject({ outcome: 'simulated', rentPaid: need, loss: 500_000n + 12_345n });
  });

  it('the creator vault: fees from the trade events are not rent; a real top-up is', async () => {
    const need = rentExempt(0, RATES.rent);
    for (const [creatorFee, topUp] of [[700_000n, 0n], [100_000n, need - 100_000n]] as const) {
      const { chain, sim, q } = setup('curve');
      if (q.venue.venue !== 'curve') throw new Error('curve');
      const vault = pumpCreatorVault(q.venue.market.curve.creator!);
      chain.accounts.delete(vault);
      // The vault gets the creator fee (inside the venue loss) plus any top-up (rent, paid by the wallet).
      script(chain, q, { loss: 500_000n, creates: new Map([[vault, creatorFee + topUp]]), logs: (p) => buyLog('curve', mintOf(q), S, p, creatorFee) });
      const r = await sim.simulate(q);
      // The script charges the wallet creatorFee + topUp as "created": creatorFee is venue loss, topUp is rent.
      expect(r.record).toMatchObject({ outcome: 'simulated', rentPaid: topUp, loss: 500_000n + creatorFee });
    }
  });

  it('curve growth: read and counted when the curve grew; a grown-in-between curve leaves the charge in the loss', async () => {
    const grown = new Uint8Array(151);
    // Grew in this transaction: the curve is 120 bytes now, 151 after.
    let { chain, sim, q } = setup('curve');
    if (q.venue.venue !== 'curve') throw new Error('curve');
    q = { ...q, venue: { venue: 'curve', market: { ...q.venue.market, accountBytes: 120 } } };
    const curve = bondingCurveAddress(mintOf(q));
    chain.accounts.set(curve, { ...chain.accounts.get(curve)!, data: new Uint8Array(120) });
    const growth = 31n * RATES.rent.lamportsPerByte;
    script(chain, q, { loss: 500_000n, pays: new Map([[curve, growth]]), dataAfter: new Map([[curve, grown]]) });
    let r = await sim.simulate(q);
    expect(r.record).toMatchObject({ outcome: 'simulated', rentPaid: growth, loss: 500_000n, credits: 3 });
    // Already 151 bytes before (the decision saw 120): no growth to count, so the same payment stays in the loss.
    ({ chain, sim } = setup('curve'));
    chain.accounts.set(curve, { ...chain.accounts.get(curve)!, data: grown });
    script(chain, q, { loss: 500_000n, pays: new Map([[curve, growth]]), dataAfter: new Map([[curve, grown]]) });
    r = await sim.simulate(q);
    expect(r.record).toMatchObject({ outcome: 'simulated', rentPaid: 0n, loss: 500_000n + growth });
  });

  it.each(['InsufficientFundsForFee', 'AccountNotFound', { InsufficientFundsForRent: { account_index: 0 } }])('payer error %j: stand-in unfunded, no fact, funding checked again', async (err) => {
    const { chain, sim, q } = setup('pool');
    chain.simulate = () => ({ err, logs: [] });
    const r = await sim.simulate(q);
    expect(r).toMatchObject({ read: null, record: { outcome: 'stand-in-unfunded' } });
    script(chain, q, { loss: 1n });
    expect((await sim.simulate(q)).record).toMatchObject({ outcome: 'simulated', credits: 2 });
  });

  it('a rent shortfall on another account is the coin\'s problem: a failed fact', async () => {
    const { chain, sim, q } = setup('pool');
    chain.simulate = () => ({ err: { InsufficientFundsForRent: { account_index: 7 } }, logs: [] });
    expect((await sim.simulate(q)).record.outcome).toBe('sim-failed');
  });
});
