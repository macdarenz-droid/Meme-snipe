// TEST-2: dry-run simulation of paper entries and exits on a stub RPC. Covers success on every venue and side, a
// program error, an insufficient stand-in, no usable holder, malformed responses, RPC and scheduler failures, the
// structural equality of the stand-in build, and the report's thresholds at their boundaries.
import { describe, expect, it } from 'vitest';
import { type Address, NATIVE_MINT, TOKEN_PROGRAM, decodeTransaction } from '../../core/src/chain/index.ts';
import { POLICY, RATES, common, goldenOf, request } from '../../core/test/tx/fixtures-policy.ts';
import type { Kind } from '../../core/test/tx/helpers.ts';
import { associatedTokenAddress, buildTrade, type SignerPolicyContext, type TradeRequest } from '../../core/src/tx/index.ts';
import {
  type DryRunRecord, type DryRunTrade, DryRunRpc, DRYRUN_GATE, amountErrorE4, dryRunReport, dryRunTrade, isBaseClose, sameStructure, substitution,
} from '../src/dryrun/index.ts';
import { HELIUS_FREE, ManualTimers, P2, Scheduler } from '../src/scheduler/index.ts';
import { blockNetwork, KEYS } from './helpers.ts';
import { type StubAccount, type StubChain, SYSTEM, feePayerOf, stubChain, testAddress, tokenAccount, wallet } from './dryrun-chain.ts';

blockNetwork();

const KINDS: readonly Kind[] = ['curve-buy', 'curve-sell', 'pool-buy', 'pool-sell'];
const BOT = testAddress(1);
const BUYER = testAddress(2);
const HOLDER = testAddress(3);
const URL = `https://mainnet.helius-rpc.com/?api-key=${KEYS.HELIUS_API_KEY}`;
const HEAD = 1_000n;

const signerPolicy = (over: Partial<SignerPolicyContext> = {}): SignerPolicyContext => ({
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

const tradeOf = (kind: Kind, over: Partial<DryRunTrade> = {}, closeTokenAccount = true): DryRunTrade => ({
  id: `intent-${kind}`,
  request: request(kind, closeTokenAccount),
  common: common(goldenOf(kind), { wallet: BOT }),
  policy: POLICY,
  signerPolicy: signerPolicy(),
  minContextSlot: HEAD,
  ...over,
});

const mintOf = (req: TradeRequest): Address => (req.venue === 'curve' ? req.market.mint : req.market.state.baseMint);
const need = (req: TradeRequest): bigint => (req.side === 'sell' ? (req.venue === 'curve' ? req.quote.tokens : req.quote.base) : 0n);
const quoted = (req: TradeRequest): bigint =>
  req.side === 'buy' ? (req.venue === 'curve' ? req.quote.tokens : req.quote.base) : req.quote.userQuote;

const setup = (opts: { scheduler?: Scheduler } = {}) => {
  const { chain, http } = stubChain();
  const timers = new ManualTimers(1_000_000);
  const scheduler = opts.scheduler ?? new Scheduler({ ...HELIUS_FREE, window: { limit: 1_000, windowMs: 1_000 } }, { timers });
  const rpc = new DryRunRpc({ url: () => URL, http, scheduler, timeoutMs: 2_000 });
  return { chain, rpc, deps: { rpc, priority: P2, buyStandIns: [BUYER] } };
};

/**
 * Puts a funded buyer and a holder on the stub chain, and scripts a simulation that moves exactly the quoted amount
 * plus `delta` (tokens for buys, lamports for sells), charging the fees, tip and rent the stand-in build declares.
 */
const fund = (chain: StubChain, t: DryRunTrade, holderTokens: bigint | null = null, delta = 0n) => {
  const req = t.request;
  const mint = mintOf(req);
  const prog = req.market.baseTokenProgram;
  chain.accounts.set(BUYER, wallet(10n ** 12n));
  chain.accounts.set(HOLDER, wallet(1_000_000_000n));
  const holderAta = associatedTokenAddress(HOLDER, mint, prog);
  const held = holderTokens ?? need(req);
  chain.accounts.set(holderAta, tokenAccount(mint, HOLDER, held));
  chain.largest = [{ address: holderAta, amount: held.toString() }];
  chain.simulate = (sim, accounts) => {
    const [s, wsol, base] = sim.addresses as [Address, Address, Address];
    // The stand-in's build with the accounts the stub holds, as the dry run builds it.
    const existing = new Set([...accounts.keys()] as Address[]);
    const b = buildTrade(req, { ...t.common, wallet: s, existing }, t.policy);
    if (!b.ok) throw new Error('stub build failed');
    const o = b.tx.solOut;
    const pre = (a: Address) => accounts.get(a) ?? null;
    const preTokens = pre(base) === null ? 0n : new DataView(pre(base)!.data.buffer).getBigUint64(64, true);
    if (req.side === 'buy') {
      const got = quoted(req) + delta;
      return { post: [wallet(pre(s)!.lamports - o.total), pre(wsol), tokenAccount(mint, s, preTokens + got)] };
    }
    const left = preTokens - need(req);
    const closes = sim.wire.length > 0 && decodeTransaction(sim.wire).instructions.length === b.tx.instructions.length && req.closeTokenAccount;
    const baseLamports = pre(base)!.lamports;
    const proceeds = quoted(req) + delta;
    const walletAfter = pre(s)!.lamports + proceeds - o.baseFee - o.priorityFee - o.tip - o.rent + (closes ? baseLamports : 0n);
    return { post: [wallet(walletAfter), pre(wsol), closes ? null : tokenAccount(mint, s, left, baseLamports)] };
  };
};

describe('dry run: success on every venue and side', () => {
  it.each(KINDS)('%s simulates, records the stand-in and an exact amount', async (kind) => {
    const { chain, deps } = setup();
    const t = tradeOf(kind);
    fund(chain, t);
    const r = await dryRunTrade(t, deps);
    expect(r.error).toBeNull();
    expect(r).toMatchObject({ outcome: 'simulated', success: true, quotedOut: quoted(t.request), simulatedOut: quoted(t.request), amountErrorE4: 0 });
    expect(r.policy).toMatchObject({ ok: true, violations: [] });
    expect(r.standIn).toMatchObject(kind.endsWith('buy') ? { address: BUYER, role: 'funded-wallet', closeOmitted: false } : { address: HOLDER, role: 'holder', closeOmitted: false });
    const sim = chain.requests.find((q) => q.method === 'simulateTransaction')!;
    const cfg = sim.params[1] as Record<string, unknown>;
    expect(cfg).toMatchObject({ encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, innerInstructions: true, commitment: 'processed' });
    expect(cfg.minContextSlot).toBeGreaterThanOrEqual(Number(r.readSlot));
    const s = r.standIn!.address;
    expect((cfg.accounts as { addresses: string[] }).addresses).toEqual([s, associatedTokenAddress(s, NATIVE_MINT, TOKEN_PROGRAM), associatedTokenAddress(s, mintOf(t.request), t.request.market.baseTokenProgram)]);
    expect(feePayerOf(Uint8Array.from(Buffer.from(sim.params[0] as string, 'base64')))).toBe(s);
  });

  it('measures the amount error in percentage points', async () => {
    const { chain, deps } = setup();
    const t = tradeOf('pool-sell');
    const q = quoted(t.request);
    fund(chain, t, null, -(q / 100n)); // 1% short
    const r = await dryRunTrade(t, deps);
    expect(r.simulatedOut).toBe(q - q / 100n);
    expect(r.amountErrorE4).toBe(amountErrorE4(q - q / 100n, q));
    expect(r.amountErrorE4).toBe(10_000);
  });

  it('a holder with more tokens than the position: the close is left out and recorded', async () => {
    const { chain, deps } = setup();
    const t = tradeOf('curve-sell');
    fund(chain, t, need(t.request) * 3n);
    const r = await dryRunTrade(t, deps);
    expect(r).toMatchObject({ outcome: 'simulated', standIn: { closeOmitted: true } });
    const wire = Uint8Array.from(Buffer.from(chain.requests.find((q) => q.method === 'simulateTransaction')!.params[0] as string, 'base64'));
    const real = buildTrade(t.request, t.common, t.policy);
    if (!real.ok) throw new Error('build');
    expect(decodeTransaction(wire).instructions).toHaveLength(real.tx.instructions.length - 1);
  });

  it('the start slot is never older than the feed head', async () => {
    const { chain, deps } = setup();
    const t = tradeOf('curve-sell', { minContextSlot: 5_000n });
    fund(chain, t);
    await dryRunTrade(t, deps);
    for (const q of chain.requests) expect((q.params[1] as Record<string, unknown>).minContextSlot).toBeGreaterThanOrEqual(5_000);
  });
});

describe('dry run: failures are recorded and count against the share', () => {
  it('a program error is a failed simulation with its error and log tail', async () => {
    const { chain, deps } = setup();
    const t = tradeOf('curve-buy');
    fund(chain, t);
    chain.simulate = () => ({ err: { InstructionError: [3, { Custom: 6003 }] }, logs: ['a', 'b', 'c', 'd', 'e', 'Program log: Error: slippage'] });
    const r = await dryRunTrade(t, deps);
    expect(r).toMatchObject({ outcome: 'sim-error', success: false, error: '{"InstructionError":[3,{"Custom":6003}]}', simulatedOut: null });
    expect(r.logsTail).toEqual(['b', 'c', 'd', 'e', 'Program log: Error: slippage']);
  });

  it('a buy stand-in without enough SOL, or that is not a plain wallet, is not simulable', async () => {
    const { chain, deps } = setup();
    const t = tradeOf('pool-buy');
    fund(chain, t);
    chain.accounts.set(BUYER, wallet(t.request.side === 'buy' ? t.request.spend : 0n));
    let r = await dryRunTrade(t, deps);
    expect(r).toMatchObject({ outcome: 'not-simulable', success: false, standIn: null });
    expect(r.error).toContain('enough SOL');
    chain.accounts.set(BUYER, { owner: TOKEN_PROGRAM, lamports: 10n ** 12n, data: new Uint8Array() });
    r = await dryRunTrade(t, deps);
    expect(r.outcome).toBe('not-simulable');
    expect(chain.requests.some((q) => q.method === 'simulateTransaction')).toBe(false);
    r = await dryRunTrade(t, { ...deps, buyStandIns: [] });
    expect(r).toMatchObject({ outcome: 'not-simulable', error: 'no buy stand-in is configured' });
  });

  it('no holder with the amount, a non-ATA holder, a program-owned holder or a poor holder: not simulable', async () => {
    const t = tradeOf('pool-sell');
    const mint = mintOf(t.request);
    const prog = t.request.market.baseTokenProgram;
    const cases: [string, (c: StubChain) => void][] = [
      ['too few tokens', (c) => { c.largest = [{ address: associatedTokenAddress(HOLDER, mint, prog), amount: (need(t.request) - 1n).toString() }]; }],
      ['not the ATA', (c) => {
        const other = testAddress(9);
        c.accounts.set(other, tokenAccount(mint, HOLDER, need(t.request)));
        c.largest = [{ address: other, amount: need(t.request).toString() }];
      }],
      ['program-owned owner', (c) => c.accounts.set(HOLDER, { owner: t.request.market.baseTokenProgram, lamports: 10n ** 12n, data: new Uint8Array(8) })],
      ['frozen account', (c) => c.accounts.set(associatedTokenAddress(HOLDER, mint, prog), { ...tokenAccount(mint, HOLDER, need(t.request)), data: (() => { const d = tokenAccount(mint, HOLDER, need(t.request)).data; d[108] = 2; return d; })() })],
      ['no SOL for fees', (c) => c.accounts.set(HOLDER, wallet(1_000n))],
    ];
    for (const [name, tweak] of cases) {
      const { chain, deps } = setup();
      fund(chain, t);
      tweak(chain);
      const r = await dryRunTrade(t, deps);
      expect(r.outcome, name).toBe('not-simulable');
      expect(r.success, name).toBe(false);
    }
  });

  it('a sell whose token balance does not fall by the position is an amount-check failure', async () => {
    const { chain, deps } = setup();
    const t = tradeOf('curve-sell', {}, false);
    fund(chain, t);
    const ok = chain.simulate;
    chain.simulate = (sim, accounts) => {
      const r = ok(sim, accounts);
      if (!('post' in r)) return r;
      return { post: [r.post[0]!, r.post[1]!, tokenAccount(mintOf(t.request), HOLDER, 1n)] };
    };
    const r = await dryRunTrade(t, deps);
    expect(r).toMatchObject({ outcome: 'amount-check', success: false });
  });

  it('malformed responses are recorded as malformed, never as a success', async () => {
    const t = tradeOf('curve-buy');
    const bad: [string, (c: StubChain) => void][] = [
      ['wrong account count', (c) => { c.override.getMultipleAccounts = () => ({ status: 200, text: '{"jsonrpc":"2.0","id":1,"result":{"context":{"slot":1000},"value":[]}}' }); }],
      ['no context', (c) => { c.override.getMultipleAccounts = () => ({ status: 200, text: '{"jsonrpc":"2.0","id":1,"result":{"value":[null]}}' }); }],
      ['not JSON', (c) => { c.override.simulateTransaction = () => ({ status: 200, text: '<html>' }); }],
      ['no value', (c) => { c.simulate = () => ({ raw: { context: { slot: 1000 } } }); }],
      ['accounts missing', (c) => { c.simulate = () => ({ raw: { context: { slot: 1000 }, value: { err: null, logs: [], accounts: null } } }); }],
      ['bad base64', (c) => { c.simulate = () => ({ raw: { context: { slot: 1000 }, value: { err: null, logs: [], accounts: [null, null, { owner: SYSTEM, lamports: 1, data: ['@@@', 'base64'], executable: false }] } } }); }],
      ['unsafe lamports', (c) => { c.simulate = () => ({ raw: { context: { slot: 1000 }, value: { err: null, logs: [], accounts: [{ owner: SYSTEM, lamports: 2 ** 60, data: ['', 'base64'], executable: false }, null, null] } } }); }],
      ['token account that does not decode', (c) => { c.simulate = () => ({ post: [wallet(1n), null, { owner: TOKEN_PROGRAM, lamports: 1n, data: new Uint8Array(3) }] }); }],
    ];
    for (const [name, tweak] of bad) {
      const { chain, deps } = setup();
      fund(chain, t);
      tweak(chain);
      const r = await dryRunTrade(t, deps);
      expect(r.outcome, name).toBe('malformed');
      expect(r.success, name).toBe(false);
    }
    const t2 = tradeOf('curve-sell');
    const { chain, deps } = setup();
    fund(chain, t2);
    chain.largest = [{ address: 'x', amount: '-1' } as never];
    expect((await dryRunTrade(t2, deps)).outcome).toBe('malformed');
  });

  it('HTTP errors, RPC errors and rate limits are rpc errors; a halted scheduler is a scheduler refusal', async () => {
    const t = tradeOf('curve-buy');
    for (const [status, text] of [[500, ''], [429, ''], [200, '{"jsonrpc":"2.0","id":1,"error":{"code":-32004}}']] as const) {
      const { chain, deps } = setup();
      fund(chain, t);
      chain.override.simulateTransaction = () => ({ status, text });
      const r = await dryRunTrade(t, deps);
      expect(r.outcome).toBe('rpc-error');
      expect(r.error).not.toContain(KEYS.HELIUS_API_KEY);
    }
    const timers = new ManualTimers(0);
    const halted = new Scheduler(HELIUS_FREE, { timers, creditsUsed: 1_000_000 });
    const { chain, deps } = setup({ scheduler: halted });
    fund(chain, t);
    const r = await dryRunTrade(t, deps);
    expect(r).toMatchObject({ outcome: 'scheduler-refused', success: false });
    expect(chain.requests).toHaveLength(0);
  });

  it('a refused build and a signer-policy violation stop before any RPC call', async () => {
    const { chain, deps } = setup();
    let r = await dryRunTrade(tradeOf('curve-buy', { common: common(goldenOf('curve-buy'), { wallet: BOT, slippageBps: 9_000 }) }), deps);
    expect(r).toMatchObject({ outcome: 'build-refused', success: false });
    r = await dryRunTrade(tradeOf('curve-buy', { signerPolicy: signerPolicy({ maxSolOut: 1n }) }), deps);
    expect(r.outcome).toBe('policy-violation');
    expect(r.policy?.ok).toBe(false);
    expect(r.error).toContain('worst-case SOL out');
    // The policy is checked on the bot-wallet build: a context for another wallet fails it.
    r = await dryRunTrade(tradeOf('pool-sell', { signerPolicy: signerPolicy({ wallet: HOLDER }) }), deps);
    expect(r.outcome).toBe('policy-violation');
    expect(chain.requests).toHaveLength(0);
  });

  it('no key appears in any record or request body', async () => {
    const records: DryRunRecord[] = [];
    for (const kind of KINDS) {
      const { chain, deps } = setup();
      const t = tradeOf(kind);
      fund(chain, t);
      records.push(await dryRunTrade(t, deps));
      for (const q of chain.requests) expect(JSON.stringify(q.params)).not.toContain(KEYS.HELIUS_API_KEY);
    }
    const { chain, deps } = setup();
    chain.override.getMultipleAccounts = () => { throw new Error(`connect ECONNREFUSED ${URL}`); };
    records.push(await dryRunTrade(tradeOf('curve-buy'), deps));
    expect(records.at(-1)!.outcome).toBe('rpc-error');
    expect(JSON.stringify(records, (_, v) => (typeof v === 'bigint' ? v.toString() : v))).not.toContain(KEYS.HELIUS_API_KEY);
  });
});

describe('stand-in build is structurally identical to the bot-wallet build', () => {
  const builds = (kind: Kind, close = true) => {
    const req = request(kind, close);
    const real = buildTrade(req, common(goldenOf(kind), { wallet: BOT }), POLICY);
    const stand = buildTrade(req, common(goldenOf(kind), { wallet: HOLDER }), POLICY);
    if (!real.ok || !stand.ok) throw new Error('build');
    return { req, real: real.tx, stand: stand.tx, map: substitution(BOT, HOLDER, mintOf(req), req.market.baseTokenProgram) };
  };

  it.each(KINDS)('%s: same programs, data and metas after replacing the wallet-derived accounts', (kind) => {
    const { real, stand, map } = builds(kind);
    expect(sameStructure(real.instructions, stand.instructions, map, null)).toEqual({ ok: true });
    // The amounts, limits, fees and tip are byte-identical; only wallet-derived keys differ.
    expect(stand.solOut.swap).toBe(real.solOut.swap);
    expect(stand.quote).toEqual(real.quote);
    const changed = real.compiled.staticKeys.filter((k) => !stand.compiled.staticKeys.includes(k));
    for (const k of changed) expect(map.has(k), k).toBe(true);
  });

  it('any other difference is caught: amount, account, flag, or an extra instruction', () => {
    const { real, stand, map } = builds('pool-buy');
    const swap = stand.instructions.findIndex((ix) => ix.data.length >= 24);
    const tamper = (f: (ix: (typeof stand.instructions)[number]) => (typeof stand.instructions)[number]) => stand.instructions.map((ix, i) => (i === swap ? f(ix) : ix));
    const data = Uint8Array.from(stand.instructions[swap]!.data);
    data[8]! ^= 1;
    expect(sameStructure(real.instructions, tamper((ix) => ({ ...ix, data })), map, null)).toMatchObject({ ok: false });
    expect(sameStructure(real.instructions, tamper((ix) => ({ ...ix, accounts: ix.accounts.map((m, j) => (j === 0 ? { ...m, address: testAddress(77) } : m)) })), map, null)).toMatchObject({ ok: false });
    expect(sameStructure(real.instructions, tamper((ix) => ({ ...ix, accounts: ix.accounts.map((m, j) => (j === 0 ? { ...m, writable: !m.writable } : m)) })), map, null)).toMatchObject({ ok: false });
    expect(sameStructure(real.instructions, [...stand.instructions, stand.instructions[0]!], map, null)).toMatchObject({ ok: false });
    // A venue account replaced by a stand-in-derived key is caught too.
    const standInAta = map.get(associatedTokenAddress(BOT, NATIVE_MINT, TOKEN_PROGRAM))!;
    expect(sameStructure(real.instructions, tamper((ix) => ({ ...ix, accounts: ix.accounts.map((m, j) => (j === 0 ? { ...m, address: standInAta } : m)) })), map, null)).toMatchObject({ ok: false });
  });

  it('closeOmitted allows exactly the base-account close to be missing, nothing else', () => {
    for (const kind of ['curve-sell', 'pool-sell'] as const) {
      const { req, real, stand, map } = builds(kind);
      const baseAta = associatedTokenAddress(HOLDER, mintOf(req), req.market.baseTokenProgram);
      const without = stand.instructions.filter((ix) => !isBaseClose(ix, baseAta, req.market.baseTokenProgram));
      expect(without).toHaveLength(stand.instructions.length - 1);
      const omit = { baseAta: associatedTokenAddress(BOT, mintOf(req), req.market.baseTokenProgram), baseTokenProgram: req.market.baseTokenProgram };
      expect(sameStructure(real.instructions, without, map, omit)).toEqual({ ok: true });
      expect(sameStructure(real.instructions, stand.instructions, map, omit)).toMatchObject({ ok: false });
      expect(sameStructure(real.instructions, without.slice(1), map, omit)).toMatchObject({ ok: false });
      const noClose = builds(kind, false);
      expect(sameStructure(noClose.real.instructions, noClose.stand.instructions, map, omit)).toMatchObject({ ok: false, reason: 'the real build has no base-account close to omit' });
    }
  });
});

describe('dry-run report thresholds', () => {
  const rec = (i: number, success: boolean, e4: number | null = 0, closeOmitted = false): DryRunRecord => ({
    id: `t${i}`, side: 'buy', venue: 'curve', mint: BOT, outcome: success ? 'simulated' : 'not-simulable', success, error: success ? null : 'x',
    standIn: { address: BUYER, role: 'funded-wallet', tokenAccount: null, closeOmitted }, policy: null, quotedOut: 1n, simulatedOut: success ? 1n : null,
    amountErrorE4: success ? e4 : null, readSlot: null, simulatedSlot: null, unitsConsumed: null, logsTail: [],
  });
  const many = (ok: number, fail: number, e4 = 0) => [...Array.from({ length: ok }, (_, i) => rec(i, true, e4)), ...Array.from({ length: fail }, (_, i) => rec(ok + i, false))];

  it('the gate is the owner\'s: 95%, median 0.5 points, each 2 points', () => {
    expect(DRYRUN_GATE).toEqual({ minSuccessPercent: 95, maxMedianE4: 5_000, maxEachE4: 20_000 });
  });

  it('success share passes at exactly 95% and fails just below; not-simulable counts as a failure', () => {
    expect(dryRunReport(many(95, 5))).toMatchObject({ trades: 100, successes: 95, successPass: true, pass: true, outcomes: { simulated: 95, 'not-simulable': 5 } });
    expect(dryRunReport(many(94, 5))).toMatchObject({ successPass: false, pass: false });
    expect(dryRunReport(many(189, 11))).toMatchObject({ successPass: false });
    expect(dryRunReport([])).toMatchObject({ trades: 0, successPass: false, medianPass: false, eachPass: false, pass: false });
    expect(dryRunReport(many(0, 3))).toMatchObject({ medianErrorPoints: null, pass: false });
  });

  it('median passes at exactly 0.5 points and fails at 0.5001; even counts average the middle two', () => {
    expect(dryRunReport(many(9, 0, 5_000))).toMatchObject({ medianErrorPoints: 0.5, medianPass: true });
    expect(dryRunReport(many(9, 0, 5_001))).toMatchObject({ medianPass: false, pass: false });
    expect(dryRunReport([rec(1, true, 4_999), rec(2, true, 5_001)])).toMatchObject({ medianErrorPoints: 0.5, medianPass: true });
    expect(dryRunReport([rec(1, true, 5_000), rec(2, true, 5_001)])).toMatchObject({ medianPass: false });
    // Failed trades carry no amount: the median is over successful trades only.
    expect(dryRunReport([...many(19, 0, 0), rec(99, false)])).toMatchObject({ medianErrorPoints: 0 });
  });

  it('each trade passes at exactly 2 points and fails at 2.0001, whatever the median', () => {
    expect(dryRunReport([...many(10, 0, 0), rec(50, true, 20_000)])).toMatchObject({ maxErrorPoints: 2, eachPass: true, pass: true });
    expect(dryRunReport([...many(10, 0, 0), rec(50, true, 20_001)])).toMatchObject({ eachPass: false, pass: false, worst: { id: 't50', errorPoints: 2.0001 } });
    expect(dryRunReport([rec(1, true, null)])).toMatchObject({ eachPass: false, pass: false });
  });

  it('counts the trades whose close was left out', () => {
    expect(dryRunReport([rec(1, true, 0, true), rec(2, true, 0, false)]).closeOmitted).toBe(1);
  });

  it('amount error rounds up to the next 0.0001 point', () => {
    expect(amountErrorE4(100n, 100n)).toBe(0);
    expect(amountErrorE4(99n, 100n)).toBe(10_000);
    expect(amountErrorE4(1_000_001n, 1_000_000n)).toBe(1);
    expect(amountErrorE4(3_000_000_001n, 3_000_000_000n)).toBe(1);
    expect(() => amountErrorE4(1n, 0n)).toThrow(RangeError);
  });
});
