// TAIL-PROOF analyzer: reads the transactions cached by collect.ts and checks, trade by trade, whether a PumpSwap trade
// whose event carries a non-zero B5 tail moves money exactly as our decoders (DEC-1) and quote math (CORE-2) say.
//
//   node research/tail-proof/analyze.ts            prints the report and writes data/report.json
//   node research/tail-proof/analyze.ts fixture    also writes packages/core/test/chain/fixtures/tail-proof.json
//
// Per trade, on canonical, SOL-quoted, non-mayhem pools only (what H5 would ever pass):
//   quote  - the CORE-2 quote from the pre-trade reserves in the event (effective quote = vault + virtual) and the
//            instruction's own arguments reproduces amounts, fee rates and every fee component of the event;
//   vaults - the pool vaults' real token balances (transaction meta) before and after equal the event's pre-trade
//            reserves and the quote's post-trade state (only when this is the pool's one trade in the transaction);
//   flows  - the SPL token transfers the swap instruction itself made (its inner instructions): what the trader paid in
//            or received in SOL and tokens equals the quote's userQuote and base; the LP side lands in the vault;
//   user   - the trader's own base and wrapped-SOL token balances (meta) moved by exactly base and userQuote, when
//            nothing else in the transaction touched those accounts.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type Address, NATIVE_MINT, PUMP_AMM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, accountKeys, decodeEventInstruction, decodeFeeConfig, decodePool, decodeTransaction,
  feeSchedules, fromBase64, fromHex, isCanonicalPool, recordFromRpc, toHex, transactionEvents,
} from '../../packages/core/src/chain/index.ts';
import { type PoolFeeContext, type PoolState, poolBuyExactBase, poolBuyExactQuoteIn, poolSell } from '../../packages/core/src/amm/index.ts';
import { bps } from '../../packages/core/src/units/index.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, 'data');
const TX_DIR = join(DATA, 'tx');
const FIXTURE = join(HERE, '..', '..', 'packages', 'core', 'test', 'chain', 'fixtures', 'tail-proof.json');
const DEFAULT_KEY = '11111111111111111111111111111111';
const EVENT_TAG = 'e445a52e51cb9a1d';
/** PumpSwap v2 swap discriminators (pump IDLs): sell_v2, buy_exact_quote_in_v2, buy_v2. */
const V2_DISCS = ['5df6823ce7e940b2', 'c2ab1c46684d5b2f', 'b817ee6167c5d33d'];
/** The upgrade transaction's slot; the 8-byte tail exists from the next slot (venues.md 2.7). */
const B5_SLOT = 452_654_882;
const NORMAL_COIN = { mayhemMode: false, transferFee: false, transferHook: false } as const;

const readJson = <T>(name: string): T => JSON.parse(readFileSync(join(DATA, name), 'utf8')) as T;
const fc = readJson<{ slot: number; data: string }>('fee-config.json');
const FEE_CONFIG = feeSchedules(decodeFeeConfig(fromBase64(fc.data)).value);
const poolAccounts = readJson<Record<string, { slot: number; owner: string; data: string } | null>>('pool-accounts.json');

type Flow = { src: string; dst: string; amount: string; program: string };
export interface Vector {
  signature: string; slot: number; blockTime: number | null; eventIndex: number;
  kind: 'buy' | 'sell'; ixName: string; ixDisc: string; args: [string, string];
  /** The event instruction's data (tag + discriminator + body + tail), decoded by the test with DEC-1. */
  eventData: string;
  tail: string;
  pool: { address: string; baseMint: string; canonical: boolean; creatorFeeBps: string; isCashbackCoin: boolean; isHolderReward: boolean; accountSlot: number };
  /** Token balances from the transaction meta: pool vaults (only when this is the pool's one trade in the transaction). */
  vaults: { quotePre: string; quotePost: string; basePre: string; basePost: string } | null;
  /** Transfers made inside the swap instruction, labelled by role. */
  flows: (Flow & { role: string })[];
  /** The trader's own token accounts (meta), only when no other instruction in the transaction touched them. */
  user: { basePre: string; basePost: string; quotePre: string | null; quotePost: string | null } | null;
}

const u64At = (b: Uint8Array, o: number) => new DataView(b.buffer, b.byteOffset, b.byteLength).getBigUint64(o, true);
const tokenFlow = (program: string, keys: Address[], accounts: readonly number[], data: Uint8Array): Flow | null => {
  if (program !== TOKEN_PROGRAM && program !== TOKEN_2022_PROGRAM) return null;
  if (data[0] === 3 && data.length >= 9) return { src: keys[accounts[0]!]!, dst: keys[accounts[1]!]!, amount: u64At(data, 1).toString(), program };
  if (data[0] === 12 && data.length >= 10) return { src: keys[accounts[0]!]!, dst: keys[accounts[2]!]!, amount: u64At(data, 1).toString(), program };
  return null;
};

const build = (sig: string, raw: any): Vector[] => {
  if (!raw?.meta || raw.meta.err !== null) return [];
  const rec = recordFromRpc(sig, raw);
  if (Number(rec.slot) <= B5_SLOT) return [];
  const tx = decodeTransaction(rec.transaction);
  const keys = accountKeys(tx, rec.loadedAddresses);
  const events = transactionEvents(rec, tx).filter((e) => e.name === 'BuyEvent' || e.name === 'SellEvent');
  const out: Vector[] = [];
  // Flat instruction list per outer instruction: [outer, ...inner], with stack heights.
  const flat = (outer: number) => {
    const o = tx.instructions[outer]!;
    const inner = rec.innerInstructions!.find((g) => g.index === outer)?.instructions ?? [];
    return [{ programIdIndex: o.programIdIndex, accounts: o.accounts, data: o.data, stackHeight: 1 }, ...inner.map((x) => ({ ...x, stackHeight: x.stackHeight ?? 2 }))];
  };
  // Every token transfer in the transaction, with the swap instruction (outer, position) it ran under, if any.
  const allFlows: { outer: number; pos: number; flow: Flow }[] = [];
  tx.instructions.forEach((_, outer) => flat(outer).forEach((ix, pos) => {
    const f = tokenFlow(keys[ix.programIdIndex]!, keys, ix.accounts, ix.data);
    if (f) allFlows.push({ outer, pos, flow: f });
  }));
  const touches = (account: string, skip: Set<string>) => {
    // Any instruction (other than the swap and its own CPIs) that lists the account.
    let n = 0;
    tx.instructions.forEach((_, outer) => flat(outer).forEach((ix, pos) => {
      if (skip.has(`${outer}:${pos}`)) return;
      if (ix.accounts.some((a) => keys[a] === account)) n++;
    }));
    return n;
  };
  events.forEach((e, eventIndex) => {
    if (e.name !== 'BuyEvent' && e.name !== 'SellEvent') return;
    const list = flat(e.outerIx);
    const evPos = e.innerIx + 1;
    // The swap: the nearest earlier PumpSwap instruction in this list that is not an event.
    let swapPos = -1;
    for (let i = evPos - 1; i >= 0; i--) {
      const ix = list[i]!;
      if (keys[ix.programIdIndex] === PUMP_AMM_PROGRAM && !toHex(ix.data).startsWith(EVENT_TAG)) { swapPos = i; break; }
    }
    if (swapPos < 0) return;
    const swap = list[swapPos]!;
    // The swap's own CPIs: the instructions after it that run deeper, up to the event.
    const own = new Set<string>([`${e.outerIx}:${swapPos}`]);
    for (let i = swapPos + 1; i < list.length && list[i]!.stackHeight > swap.stackHeight; i++) own.add(`${e.outerIx}:${i}`);
    const d = e.data as Record<string, any>;
    const pool = d['pool'] as string;
    const acct = poolAccounts[pool];
    if (!acct || acct.owner !== PUMP_AMM_PROGRAM) return;
    const p = decodePool(fromBase64(acct.data)).value;
    if (p.quoteMint !== NATIVE_MINT || p.isMayhemMode) return;
    const canonical = isCanonicalPool(p, pool as Address);
    const kind = e.name === 'BuyEvent' ? 'buy' : 'sell';
    const ixDisc = toHex(swap.data).slice(0, 16);
    const args: [string, string] = [u64At(swap.data, 8).toString(), u64At(swap.data, 16).toString()];
    // The event instruction's raw data, as the chain carries it.
    const eventData = toHex(list[evPos]!.data);
    const swapAccounts = swap.accounts.map((a) => keys[a]!);
    const role = (a: string) => a === d['userBaseTokenAccount'] ? 'user-base' : a === d['userQuoteTokenAccount'] ? 'user-quote'
      : a === p.poolBaseTokenAccount ? 'pool-base' : a === p.poolQuoteTokenAccount ? 'pool-quote'
        : a === d['protocolFeeRecipientTokenAccount'] ? 'protocol' : a === swapAccounts[17] ? 'creator-vault' : 'other';
    const flows = allFlows.filter((f) => own.has(`${f.outer}:${f.pos}`)).map((f) => ({ ...f.flow, role: `${role(f.flow.src)}>${role(f.flow.dst)}` }));
    const bal = (list: any[], account: string) => list.find((b: any) => keys[b.accountIndex] === account)?.uiTokenAmount.amount as string | undefined;
    const samePool = events.filter((x) => (x.data as Record<string, any>)['pool'] === pool).length;
    const vq = [bal(raw.meta.preTokenBalances, p.poolQuoteTokenAccount), bal(raw.meta.postTokenBalances, p.poolQuoteTokenAccount), bal(raw.meta.preTokenBalances, p.poolBaseTokenAccount), bal(raw.meta.postTokenBalances, p.poolBaseTokenAccount)];
    const vaults = samePool === 1 && vq.every((x) => x !== undefined) ? { quotePre: vq[0]!, quotePost: vq[1]!, basePre: vq[2]!, basePost: vq[3]! } : null;
    const ub = d['userBaseTokenAccount'] as string;
    const uq = d['userQuoteTokenAccount'] as string;
    const ubPre = bal(raw.meta.preTokenBalances, ub) ?? '0';
    const ubPost = bal(raw.meta.postTokenBalances, ub);
    const uqPre = bal(raw.meta.preTokenBalances, uq);
    const uqPost = bal(raw.meta.postTokenBalances, uq);
    const user = events.length === 1 && ubPost !== undefined && touches(ub, own) === 0
      ? { basePre: ubPre, basePost: ubPost, ...(touches(uq, own) === 0 && uqPre !== undefined && uqPost !== undefined ? { quotePre: uqPre, quotePost: uqPost } : { quotePre: null, quotePost: null }) }
      : null;
    out.push({
      signature: sig, slot: Number(rec.slot), blockTime: rec.blockTime, eventIndex, kind, ixName: kind === 'sell' ? 'sell' : String(d['ixName']), ixDisc, args, eventData, tail: e.extra,
      pool: { address: pool, baseMint: p.baseMint, canonical, creatorFeeBps: String(p.creatorFeeBps ?? 0n), isCashbackCoin: p.isCashbackCoin ?? false, isHolderReward: p.isHolderReward ?? false, accountSlot: acct.slot },
      vaults, flows, user,
    });
  });
  return out;
};

const n = (x: unknown) => BigInt(x as string);
export const quote = (v: Vector, d: Record<string, any>) => {
  const pre: PoolState = { baseReserve: n(d['poolBaseTokenReserves']), quoteVault: n(d['poolQuoteTokenReserves']), virtualQuoteReserves: n(d['virtualQuoteReserves']) };
  const override = Number(v.pool.creatorFeeBps);
  const ctx: PoolFeeContext = {
    feeConfig: FEE_CONFIG, canonical: v.pool.canonical, quote: 'sol', baseSupply: n(d['baseSupply']), creatorFeeCharged: d['coinCreator'] !== DEFAULT_KEY,
    coin: NORMAL_COIN, instruction: V2_DISCS.includes(v.ixDisc) ? 'v2' : 'v1', buybackFeeBps: bps(Number(d['buybackFeeBasisPoints'])),
    ...(override > 0 ? { creatorFeeOverride: bps(override) } : {}),
  };
  const a0 = BigInt(v.args[0]);
  const q = v.kind === 'sell' ? poolSell(pre, a0, ctx) : v.ixName === 'buy' ? poolBuyExactBase(pre, a0, ctx) : poolBuyExactQuoteIn(pre, a0, ctx);
  return { pre, q };
};

/** Every comparison for one vector: name -> [ours, chain]. */
export const compare = (v: Vector, d: Record<string, any>): Record<string, [string, string]> => {
  const c: Record<string, [string, string]> = {};
  const { pre, q } = quote(v, d);
  if (!q.ok) return { quote: [q.reason, 'ok'] };
  const t = q.trade;
  const eq = (k: string, ours: bigint | number, chain: unknown) => { c[k] = [String(ours), String(chain)]; };
  eq('fees.lp', t.fees.lp, d['lpFeeBasisPoints']); eq('fees.protocol', t.fees.protocol, d['protocolFeeBasisPoints']); eq('fees.creator', t.fees.creator, d['coinCreatorFeeBasisPoints']);
  eq('lpFee', t.lpFee, d['lpFee']); eq('protocolFee', t.protocolFee, d['protocolFee']); eq('creatorFee', t.creatorFee, d['coinCreatorFee']); eq('buybackFee', t.buybackFee, d['buybackFee']);
  if (v.kind === 'sell') {
    eq('base', t.base, d['baseAmountIn']); eq('quote', t.quote, d['quoteAmountOut']); eq('userQuote', t.userQuote, d['userQuoteAmountOut']);
  } else {
    eq('base', t.base, d['baseAmountOut']); eq('quoteWithLp', t.quote + t.lpFee, d['quoteAmountInWithLpFee']);
    if (v.ixName === 'buy') { eq('quote', t.quote, d['quoteAmountIn']); eq('userQuote', t.userQuote, d['userQuoteAmountIn']); } else eq('quote', t.quote, d['userQuoteAmountIn']);
  }
  if (v.vaults) {
    eq('vault.quotePre', pre.quoteVault, v.vaults.quotePre); eq('vault.quotePost', t.after.quoteVault, v.vaults.quotePost);
    eq('vault.basePre', pre.baseReserve, v.vaults.basePre); eq('vault.basePost', t.after.baseReserve, v.vaults.basePost);
  }
  const sum = (pred: (f: Vector['flows'][number]) => boolean) => v.flows.filter(pred).reduce((s, f) => s + BigInt(f.amount), 0n);
  if (v.kind === 'buy') {
    eq('flow.userPaid', t.userQuote, sum((f) => f.role.startsWith('user-quote>')));
    eq('flow.userGot', t.base, sum((f) => f.role === 'pool-base>user-base'));
    eq('flow.vaultIn', t.after.quoteVault - pre.quoteVault, sum((f) => f.role.endsWith('>pool-quote')) - sum((f) => f.role.startsWith('pool-quote>')));
  } else {
    eq('flow.userGot', t.userQuote, sum((f) => f.role.endsWith('>user-quote')));
    eq('flow.userPaid', t.base, sum((f) => f.role === 'user-base>pool-base'));
    eq('flow.vaultOut', pre.quoteVault - t.after.quoteVault, sum((f) => f.role.startsWith('pool-quote>')) - sum((f) => f.role.endsWith('>pool-quote')));
  }
  if (v.user) {
    eq('user.base', v.kind === 'buy' ? t.base : -t.base, n(v.user.basePost) - n(v.user.basePre));
    if (v.user.quotePre !== null && v.user.quotePost !== null) eq('user.quote', v.kind === 'buy' ? -t.userQuote : t.userQuote, n(v.user.quotePost) - n(v.user.quotePre));
  }
  return c;
};

const decodeVector = (v: Vector): Record<string, any> => {
  const e = decodeEventInstruction('pump_amm', fromHex(v.eventData));
  if (!e || e.name === 'other') throw new Error(`${v.signature}: not a pool event`);
  return { ...(e.data as Record<string, any>), __trailing: e.trailing, __extra: e.extra };
};

/** Unpublished PumpSwap instructions seen since B5 (log names `SweepCreatorFee`, `SweepProtocolFee`). */
const SWEEP_CREATOR = '20f6bf3408c949ba';
const SWEEP_PROTOCOL = '0830be07b644b7e5';
export type TapeEntry =
  | { slot: number; signature: string; type: 'trade'; ixDisc: string; eventData: string }
  | { slot: number; signature: string; type: 'sweep-creator' | 'sweep-protocol'; amount: string; eventData: string | null };

/**
 * One pool's tape in the RPC's order (getSignaturesForAddress, reversed to oldest first): its trades and the sweeps
 * that name it. Read from a dense, consecutive history (collect.ts history <pool> 1 1 <n>).
 */
const tape = (pool: string, sigs: string[]): TapeEntry[] => {
  const out: TapeEntry[] = [];
  for (const sig of [...sigs].reverse()) {
    const f = join(TX_DIR, `${sig}.json`);
    if (!existsSync(f)) continue;
    const raw = JSON.parse(readFileSync(f, 'utf8'));
    if (!raw?.meta || raw.meta.err !== null) continue;
    const rec = recordFromRpc(sig, raw);
    const tx = decodeTransaction(rec.transaction);
    const keys = accountKeys(tx, rec.loadedAddresses);
    tx.instructions.forEach((o, outer) => {
      const list = [{ ...o, stackHeight: 1 }, ...(rec.innerInstructions!.find((g) => g.index === outer)?.instructions ?? []).map((x) => ({ ...x, stackHeight: x.stackHeight ?? 2 }))];
      let swapDisc = '';
      list.forEach((ix, i) => {
        if (keys[ix.programIdIndex] !== PUMP_AMM_PROGRAM) return;
        const hex = toHex(ix.data);
        if (!hex.startsWith(EVENT_TAG)) {
          const disc = hex.slice(0, 16);
          swapDisc = disc;
          if ((disc === SWEEP_CREATOR || disc === SWEEP_PROTOCOL) && keys[ix.accounts[2]!] === pool) {
            // The sweep's own transfer (the next token instruction, one level deeper) and its event, if any.
            let amount = 0n;
            let eventData: string | null = null;
            for (let j = i + 1; j < list.length && list[j]!.stackHeight > ix.stackHeight; j++) {
              const x = list[j]!;
              const fl = tokenFlow(keys[x.programIdIndex]!, keys, x.accounts, x.data);
              if (fl) amount += BigInt(fl.amount);
              if (keys[x.programIdIndex] === PUMP_AMM_PROGRAM && toHex(x.data).startsWith(EVENT_TAG)) eventData = toHex(x.data);
            }
            out.push({ slot: Number(rec.slot), signature: sig, type: disc === SWEEP_CREATOR ? 'sweep-creator' : 'sweep-protocol', amount: amount.toString(), eventData });
          }
          return;
        }
        const e = decodeEventInstruction('pump_amm', ix.data);
        if (e && (e.name === 'BuyEvent' || e.name === 'SellEvent') && e.data.pool === pool) out.push({ slot: Number(rec.slot), signature: sig, type: 'trade', ixDisc: swapDisc, eventData: hex });
      });
    });
  }
  return out;
};

const u64le = (hex: string): bigint => BigInt(`0x${(hex.match(/../g) ?? []).reverse().join('') || '0'}`);
/** Replays a tape: the tail after each trade must equal the running sum of v2 creator fees since the last creator sweep. */
export const replayTape = (entries: TapeEntry[]) => {
  let tail: bigint | null = null;
  const res = { trades: 0, v2: 0, sweeps: 0, sweepsMatching: 0, exact: 0, mismatches: [] as { signature: string; expected: string; got: string }[] };
  for (const en of entries) {
    if (en.type === 'sweep-creator') {
      res.sweeps++;
      if (tail !== null && BigInt(en.amount) === tail) res.sweepsMatching++;
      if (tail !== null) tail = 0n;
      continue;
    }
    if (en.type !== 'trade') continue;
    const e = decodeEventInstruction('pump_amm', fromHex(en.eventData));
    if (!e || (e.name !== 'BuyEvent' && e.name !== 'SellEvent')) continue;
    const got = u64le(e.extra);
    res.trades++;
    const v2 = V2_DISCS.includes(en.ixDisc);
    if (v2) res.v2++;
    if (tail === null) { tail = got; continue; } // the first trade sets the starting value
    const expected = tail + (v2 ? (e.data.coinCreatorFee ?? 0n) : 0n);
    if (expected === got) res.exact++; else res.mismatches.push({ signature: en.signature, expected: String(expected), got: String(got) });
    tail = got;
  }
  return res;
};

const main = () => {
  const vectors: Vector[] = [];
  for (const f of readdirSync(TX_DIR)) {
    const sig = f.replace(/\.json$/, '');
    try { vectors.push(...build(sig, JSON.parse(readFileSync(join(TX_DIR, f), 'utf8')))); } catch (e) { console.error(`skip ${sig}: ${(e as Error).message}`); }
  }
  vectors.sort((a, b) => a.slot - b.slot || a.signature.localeCompare(b.signature) || a.eventIndex - b.eventIndex);
  const canonical = vectors.filter((v) => v.pool.canonical);
  const rows = canonical.map((v) => {
    const d = decodeVector(v);
    const c = compare(v, d);
    const bad = Object.entries(c).filter(([, [a, b]]) => a !== b);
    return { v, d, c, bad, nonzero: /[^0]/.test(v.tail) };
  });
  const group = (nz: boolean) => {
    const g = rows.filter((r) => r.nonzero === nz);
    const by = (prefix: string) => {
      const has = g.filter((r) => Object.keys(r.c).some((k) => k.startsWith(prefix)));
      return { n: has.length, exact: has.filter((r) => !r.bad.some(([k]) => k.startsWith(prefix))).length };
    };
    return {
      trades: g.length, buys: g.filter((r) => r.v.kind === 'buy').length, sells: g.filter((r) => r.v.kind === 'sell').length,
      pools: new Set(g.map((r) => r.v.pool.address)).size, exactAll: g.filter((r) => r.bad.length === 0).length,
      quote: by('fees.'), amounts: { n: g.length, exact: g.filter((r) => !r.bad.some(([k]) => !k.includes('.') || k.startsWith('fees.'))).length },
      vaults: by('vault.'), flows: by('flow.'), userBase: by('user.base'), userQuote: by('user.quote'),
      v2: g.filter((r) => V2_DISCS.includes(r.v.ixDisc)).length,
      slots: g.length ? [g[0]!.v.slot, g[g.length - 1]!.v.slot] : null,
    };
  };
  const mismatches = rows.filter((r) => r.bad.length > 0).slice(0, 10).map((r) => ({ signature: r.v.signature, slot: r.v.slot, kind: r.v.kind, ixName: r.v.ixName, ixDisc: r.v.ixDisc, tail: r.v.tail, pool: r.v.pool, bad: r.bad }));
  const histories = existsSync(join(DATA, 'histories.json')) ? readJson<Record<string, string[]>>('histories.json') : {};
  const tapes = Object.fromEntries(Object.entries(histories).map(([p, sigs]) => [p, tape(p, sigs)]));
  const report = {
    generatedAt: new Date().toISOString(), feeConfigSlot: fc.slot,
    decoded: vectors.length, nonCanonicalSkipped: vectors.length - canonical.length,
    tailLengths: [...new Set(rows.map((r) => r.d['__trailing']))],
    nonzero: group(true), zero: group(false), mismatches,
    tapes: Object.fromEntries(Object.entries(tapes).map(([p, t]) => [p, { span: [t[0]?.slot, t.at(-1)?.slot], ...replayTape(t) }])),
  };
  writeFileSync(join(DATA, 'report.json'), JSON.stringify(report, null, 1));
  writeFileSync(join(DATA, 'rows.json'), JSON.stringify(rows.map((r) => ({ ...r.v, bad: r.bad, nonzero: r.nonzero })), null, 1));
  console.log(JSON.stringify(report, null, 1));
  if (process.argv[2] === 'fixture') {
    // Every non-zero-tail trade that passed, and as many zero-tail controls as needed (spread over pools).
    // Spread over pools: at most 20 non-zero and 8 zero-tail trades per pool. A trade that did not reproduce is never
    // dropped silently: the report lists it, and the fixture is not written while any exists.
    if (rows.some((r) => r.bad.length > 0)) throw new Error('mismatches exist; see data/report.json');
    const spread = (list: Vector[], cap: number) => {
      const perPool = new Map<string, number>();
      return list.filter((v) => { const k = perPool.get(v.pool.address) ?? 0; perPool.set(v.pool.address, k + 1); return k < cap; });
    };
    const nz = spread(rows.filter((r) => r.nonzero).map((r) => r.v), 20);
    const zPicked = spread(rows.filter((r) => !r.nonzero).map((r) => r.v), 8);
    // Flows keep role and amount only (the test needs no addresses), to keep the fixture small.
    const slim = (v: Vector) => ({ ...v, flows: v.flows.map((f) => ({ role: f.role, amount: f.amount })) });
    const fixture = {
      source: 'public mainnet RPC (keyless), research/tail-proof/collect.ts', fetchedAt: report.generatedAt,
      feeConfig: { address: '5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx', slot: fc.slot, data: fc.data },
      selection: 'successful PumpSwap buys and sells on canonical, SOL-quoted, non-mayhem pools after B5; nonzero: sampled trades whose 8-byte tail is non-zero, at most 20 per pool; zero: controls, at most 8 per pool; tapes: consecutive trades and sweeps of single pools',
      nonzero: nz.map(slim), zero: zPicked.map(slim),
      tapes: Object.fromEntries(Object.entries(tapes).filter(([, t]) => t.length > 0)),
    };
    writeFileSync(FIXTURE, JSON.stringify(fixture));
    console.error(`fixture: ${nz.length} non-zero, ${fixture.zero.length} zero`);
  }
};

main();
