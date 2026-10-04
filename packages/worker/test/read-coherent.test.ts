// READ-COHERENT (AUDIT-RM4): live, the stage-2 inputs (mint, LP: account reads, fresh for maxStateSlotLag slots) and
// the stage-3 inputs (holders, simulation, cross-checks) must all be fresh at one decision. Through the real LiveFacts,
// FactReaders and LiveStrategy, against a fake RPC whose confirmed context slot is the processed tip minus 1 and that
// answers each call one slot later, every fact otherwise passing: a candidate whose facts all pass is entered.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RUG_CONFIG } from '../../core/src/config/index.ts';
import { type Address, TOKEN_PROGRAM, decodeBase58, isOnCurve, toBase64 } from '../../core/src/chain/index.ts';
import { RAW, completeHolders, parseAccountsRead, parseHoldersAllRead, parseHoldersRead } from '../../core/src/facts/index.ts';
import { Engine, type LogRecord, type MarketEvent, type Strategy } from '../../core/src/engine/index.ts';
import { holdersKey, lpKey, mintKey, simKey, xcheckKey, type FactObs } from '../../core/src/gates/index.ts';
import { TRIAL_POLICY } from '../../core/src/config/index.ts';
import { microUsdToLamports, type MicroUsd } from '../../core/src/units/index.ts';
import { ACC, BASE_VAULT, FEE_CONTEXT, QUOTE_VAULT, W, account, holderAccounts, passingFacts } from '../../core/test/gates/world.ts';
import { poolBuyExactQuoteIn, poolSell } from '../../core/src/amm/index.ts';
import { FACT_READS_KEY, FactReaders, FactRpc, HELIUS_CALLS_PER_EVALUATION, HOLDER_SCANS_PER_DAY, LiveFacts, type BatchRequest, type BatchResult, type LiveReaders, type SimFn } from '../src/facts/index.ts';
import { LiveStrategy, type CandidateReason } from '../src/engine/strategy.ts';
import { replayRecorded, type Frame, type Release } from '../src/providers/index.ts';
import type { HttpClient, HttpRequest, HttpResponse } from '../src/providers/http.ts';
import { engineFeed } from '../src/run/engine-feed.ts';
import { parseTyped } from '../src/run/json.ts';
import type { FactContext } from '../src/run/facts.ts';
import { GOPLUS_FREE, HELIUS_FREE, ManualTimers, RUGCHECK_FREE, Scheduler } from '../src/scheduler/index.ts';
import { tokenAccountData } from './dryrun-chain.ts';
import { blockNetwork, settle } from './helpers.ts';
import { MINT, POOL, POOL_ADDRESS, SOL_PRICE, T, dueTimers, makeWorker, passingMarket, type Harness } from './worker-harness.ts';

/** The spend the worker sizes at the passing SOL price (q_min, rounded up to whole lamports). */
const SPEND_AT_PRICE = microUsdToLamports(TRIAL_POLICY.capital.minNotional, SOL_PRICE as MicroUsd, 'ceil');
import { readdirSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';

blockNetwork();

const DAY = 86_400_000;
const SLOT_MS = 400;
/** The read-sourced facts: every one comes from LiveFacts' reads, none from the scripted market. */
const READ_FACTS = [mintKey(MINT), lpKey(MINT), holdersKey(MINT), simKey(MINT), xcheckKey(MINT)];
const PAMM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';

const resp = (status: number, text: string): HttpResponse => ({ status, text, header: () => null }) as unknown as HttpResponse;
const rpcResult = (slot: bigint, value: unknown) => resp(200, JSON.stringify({ jsonrpc: '2.0', id: 1, result: { context: { slot: Number(slot) }, value } }));
const b64 = (d: Uint8Array) => [toBase64(d), 'base64'];

/** A legacy SPL mint with no authorities: the LP mint, all of it burned (supply 0). */
const lpMintData = (): Uint8Array => {
  const d = new Uint8Array(82);
  d[44] = 6; // decimals
  d[45] = 1; // initialized
  return d;
};

/**
 * The passing world's complete holder set as token accounts of the mint's program (Token-2022), with the pool's base
 * vault at its real balance (the one its pool fact prices from) and the difference spread over small wallets, so the
 * scan and the bank describe one chain state and still add up to the supply.
 */
const HOLDERS = (() => {
  const base = holderAccounts();
  const vault = base.find((a) => a.address === POOL.poolBaseTokenAccount)!;
  let rest = vault.amount - BASE_VAULT;
  const extra: typeof base = [];
  for (let i = 0; rest > 0n; i++) {
    const amount = rest < 1_000_000_000_000n ? rest : 1_000_000_000_000n;
    const owner = W(`vault-rest${i}`);
    extra.push({ ...vault, address: ACC(owner), owner, ownerProgram: null, amount });
    rest -= amount;
  }
  return [...base.map((a) => (a === vault ? { ...a, amount: BASE_VAULT } : a)), ...extra];
})();
const MINT_ACCOUNT = account(MINT);
const holderData = new Map(HOLDERS.map((h) => [h.address, tokenAccountData(MINT as Address, h.owner as Address, h.amount)]));
/** Off-curve owners (PDAs) and their programs: the pool owns its base vault. */
const PROGRAM_OF = new Map<string, string>([[POOL_ADDRESS, PAMM]]);

export interface FakeChain {
  readonly http: HttpClient;
  readonly calls: { method: string; atSlot: bigint; contextSlot: bigint; atMs: number }[];
}

/**
 * The fake RPC: each call answers one slot later, at a confirmed context slot one behind the processed tip seen when
 * it was asked. RugCheck and GoPlus agree (no authorities), one slot later too.
 */
export const fakeChain = (h: Harness, slotsPerCall = 1): FakeChain => {
  const calls: FakeChain['calls'] = [];
  const later = (r: () => HttpResponse): Promise<HttpResponse> => new Promise((ok) => h.timers.setTimeout(() => ok(r()), SLOT_MS * slotsPerCall));
  const http: HttpClient = async (req: HttpRequest) => {
    const tip = h.worker.feed.tip ?? 0n;
    const slot = tip - 1n;
    if (req.url.includes('rugcheck')) return later(() => resp(200, JSON.stringify({ mint: MINT, mintAuthority: null, freezeAuthority: null })));
    if (req.url.includes('gopluslabs')) return later(() => resp(200, JSON.stringify({ code: 1, result: { [MINT]: { mintable: { status: '0' }, freezable: { status: '0' } } } })));
    const body = JSON.parse(req.body ?? '{}') as { method: string; params: unknown[] };
    calls.push({ method: body.method, atSlot: tip, contextSlot: slot, atMs: h.timers.now() });
    const one = (address: string): unknown => {
      if (address === MINT) return { owner: MINT_ACCOUNT.owner, data: [MINT_ACCOUNT.dataBase64, 'base64'], lamports: 1, executable: false };
      if (address === POOL.lpMint) return { owner: TOKEN_PROGRAM, data: b64(lpMintData()), lamports: 1, executable: false };
      if (address === POOL_ADDRESS || address === POOL.poolQuoteTokenAccount || address === POOL.poolBaseTokenAccount) {
        const a = account(address);
        return { owner: a.owner, data: [a.dataBase64, 'base64'], lamports: 1, executable: false };
      }
      const t = holderData.get(address);
      if (t !== undefined) return { owner: MINT_ACCOUNT.owner, data: b64(t), lamports: 1, executable: false };
      return null;
    };
    switch (body.method) {
      case 'getMultipleAccounts': {
        const [list, cfg] = body.params as [string[], { dataSlice?: { length: number } }];
        if (cfg.dataSlice !== undefined) {
          // Owner programs (no data): a PDA's program, a wallet System-owned or absent.
          return later(() => rpcResult(slot, list.map((o) => {
            const p = PROGRAM_OF.get(o);
            return p === undefined ? null : { owner: p, data: ['', 'base64'], lamports: 1, executable: false };
          })));
        }
        return later(() => rpcResult(slot, list.map(one)));
      }
      case 'getAccountInfo':
        return later(() => rpcResult(slot, one((body.params as [string])[0])));
      case 'getTokenLargestAccounts': {
        const top = [...HOLDERS].sort((a, b) => (a.amount > b.amount ? -1 : a.amount < b.amount ? 1 : 0)).slice(0, 20);
        return later(() => rpcResult(slot, top.map((a) => ({ address: a.address, amount: String(a.amount), decimals: 6, uiAmountString: '0' }))));
      }
      case 'getProgramAccounts': {
        const cfg = (body.params as [string, { minContextSlot?: number }])[1];
        if (cfg.minContextSlot !== undefined && BigInt(cfg.minContextSlot) > slot) {
          return later(() => resp(200, JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32016, message: 'Minimum context slot has not been reached' } })));
        }
        return later(() => rpcResult(slot, HOLDERS.map((a) => ({ pubkey: a.address, account: one(a.address) ?? { owner: MINT_ACCOUNT.owner, data: b64(holderData.get(a.address)!), lamports: 1, executable: false } }))));
      }
      default:
        throw new Error(`unexpected ${body.method}`);
    }
  };
  return { http, calls };
};

/**
 * What an honest simulation reports at `spend` on the passing pool: the buy, then the sale of its tokens at once on the
 * pool the buy left (the sequence the simulation runs), modelled exactly; null when the pool cannot be quoted.
 */
const simulated = (spend: bigint): { paid: bigint; proceeds: bigint } | null => {
  const state = { baseReserve: BASE_VAULT, quoteVault: QUOTE_VAULT, virtualQuoteReserves: POOL.virtualQuoteReserves ?? 0n };
  const b = poolBuyExactQuoteIn(state, spend, FEE_CONTEXT);
  if (!b.ok) return null;
  const x = poolSell(b.trade.after, b.trade.base, FEE_CONTEXT);
  return x.ok ? { paid: b.trade.userQuote, proceeds: x.trade.userQuote } : null;
};

/** H15's simulation (the worker's SimFn): one RPC call, answered one slot later, at the candidate's spend on the passing pool. */
const simOf = (ctx: FactContext, slotsPerCall = 1): SimFn => (mint, spend, ingest) =>
  new Promise((ok) => {
    const slot = (ctx.tip() ?? 1n) - 1n;
    ctx.timers.setTimeout(() => {
      const q = simulated(spend);
      if (q === null) return ok(false);
      ingest({ mint, slot, spend, ok: true, ...q, error: null });
      ok(true);
    }, SLOT_MS * slotsPerCall);
  });

/** The production LiveFacts settings (liveFacts), on FactReaders over the fake chain. */
const liveFactsOn = (chain: FakeChain, slotsPerCall = 1) => new LiveFacts({
  readers: (ctx) => {
    const timers = ctx.timers;
    const r = new FactReaders({
      feed: ctx.ingest, http: chain.http, timers, timeoutMs: 10_000,
      rpc: new FactRpc({ url: () => 'https://helius.test/?api-key=k', http: chain.http, scheduler: ctx.schedulers.helius, timeoutMs: 10_000 }),
      rugcheck: { scheduler: new Scheduler(RUGCHECK_FREE, { timers }) }, goplus: { scheduler: new Scheduler(GOPLUS_FREE, { timers }) },
    });
    // As the production wiring (`withSim`): the batch asks the simulation itself; a lone read ingests at once.
    const sim = simOf(ctx, slotsPerCall);
    r.simulate = sim;
    const live: LiveReaders = Object.assign(r, { readSim: (mint: string, spend: bigint) => sim(mint, spend, (read) => r.ingestSim(read)) });
    return live;
  },
  tickMs: 1_000, minReadGapMs: 60_000, survivalAfterMs: 30 * 60_000, survivalReadDelayMs: 5_000, solUsdStartHours: 27,
  mintHistory: { maxPages: 20, funderPages: 3, funderTransactions: 10, insiderSlots: 2, firstBuyers: 20 },
});

type JournalLine = { kind: string; action?: string; event?: string; reasons?: string[]; gate_reasons?: { gate: string; code: string; detail?: string }[] };
const journal = (h: Harness): JournalLine[] => readFileSync(join(h.stateDir, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as JournalLine);

/** Starts the worker with the read-backed fact source and runs `minutes` of market (a slot every 400 ms). */
const run = async (minutes: number, port: number, slotsPerCall = 1) => {
  const timers = dueTimers(T - 16 * DAY);
  let chain: FakeChain | null = null;
  const facts = { name: 'facts', start: (c: FactContext) => src.start(c), stop: () => src.stop() };
  // The source is built once the harness exists (the fake chain reads the worker's feed tip).
  let src: LiveFacts = null as unknown as LiveFacts;
  const h = makeWorker({ timers, facts: [facts], config: { ZEROED_HEALTH_ADDR: `127.0.0.1:${port}`, ZEROED_API_ADDR: `127.0.0.1:${port + 1}` } });
  chain = fakeChain(h, slotsPerCall);
  src = liveFactsOn(chain, slotsPerCall);
  let started: unknown = null;
  void h.worker.start().then((r) => void (started = r));
  for (let k = 0; k < 200 && started === null; k++) {
    h.timers.set(h.timers.now() + 100);
    for (let j = 0; j < 4; j++) await new Promise<void>((r) => setImmediate(r));
  }
  expect(started).toEqual({ ok: true });
  h.worker.feed.ingest('helius', { type: 'offchain', key: 'feed:status:helius', value: { state: 'up' } }, { receivedAt: h.timers.now() });
  const m = await passingMarket(h, { heldPoolFacts: true, omit: READ_FACTS });
  await m.run(minutes * 60_000, SLOT_MS, () => {
    m.slot();
    m.pool();
  });
  await h.worker.stop();
  return { h, chain };
};

describe('READ-COHERENT: stage-2 and stage-3 read inputs are fresh together', () => {
  it('a candidate whose facts all pass is entered within 5 minutes (today: H16 stale mint/lp ↔ holders cycle)', async () => {
    const { h } = await run(5, 18990);
    const lines = journal(h);
    const decisions = lines.filter((l) => l.kind === 'decision');
    const rejects = decisions.filter((l) => l.action === 'reject').map((l) => (l.gate_reasons ?? []).map((g) => `${g.gate} ${g.code} ${g.detail ?? ''}`).join(' | '));
    expect(decisions.some((l) => l.action === 'enter'), rejects.slice(-6).join('\n')).toBe(true);
    // The entry was decided at a batch's close, on the batch.
    expect(decisions.find((l) => l.action === 'enter')!.event).toMatch(new RegExp(`^${RAW.batchClose(MINT)}#`));
  }, 120_000);

  it('a stale batch still rejects: answers three slots late are past the state lag at the close', async () => {
    const { h } = await run(5, 18994, 3);
    const decisions = journal(h).filter((l) => l.kind === 'decision');
    expect(decisions.some((l) => l.action === 'enter')).toBe(false);
    // Batches landed (their closes are recorded) and the candidate was judged on them: still the state lag.
    const dir = join(h.stateDir, 'recorder', h.worker.boot);
    const closes = rows(dir, /^frames-/, (l) => parseTyped(l) as Frame).filter((f) => f.body.type === 'offchain' && f.body.key === RAW.batchClose(MINT));
    expect(closes.length).toBeGreaterThanOrEqual(4);
    const last = h.worker.strategy.candidates().get(MINT)!;
    expect(last.gates?.some((g) => g.code === 'stale' && (g.input === 'mint' || g.input === 'lp'))).toBe(true);
    expect(decisions.filter((l) => l.action === 'reject').every((l) => (l.gate_reasons ?? []).every((g) => g.code === 'stale' || g.code === 'missing' || g.gate === 'regime'))).toBe(true);
  }, 120_000);

  it('live and the replay of its recording make the same decisions, and neither judges the candidate inside a batch', async () => {
    const { h, chain } = await run(5, 18996);
    const lines = journal(h);
    const dir = join(h.stateDir, 'recorder', h.worker.boot);
    const frames = rows(dir, /^frames-/, (l) => parseTyped(l) as Frame);
    const releases = rows(dir, /^releases-/, (l) => JSON.parse(l) as Release);
    const start = lines.find((l) => l.kind === 'start') as unknown as { seed: string };
    const { clock, feed } = replayRecorded(frames, releases);
    const inner = new LiveStrategy({ session: h.session, rugs: RUG_CONFIG, config: h.worker.strategyConfig });
    // Every event, with whether it evaluated the candidate, and the batches open at that point.
    const open = new Set<string>();
    const inside: string[] = [];
    let batches = 0;
    const traced: Strategy = {
      onMarket: (e: MarketEvent, ctx) => {
        if (e.key === RAW.batchOpen(MINT)) {
          open.add(MINT);
          batches++;
        }
        const before = inner.candidates().get(MINT)?.lastEvalMs ?? null;
        const out = inner.onMarket(e, ctx);
        const after = inner.candidates().get(MINT)?.lastEvalMs ?? null;
        if (after !== before && open.has(MINT)) inside.push(e.id);
        if (e.key === RAW.batchClose(MINT)) open.delete(MINT);
        return out;
      },
    };
    const engine = new Engine({ clock, feed: engineFeed(feed, h.session.policy).feed, strategy: traced, runner: { run: () => undefined }, seed: start.seed, book: { maxOpenPositions: h.session.policy.positions.maxOpen } });
    engine.drain();
    expect(batches).toBeGreaterThanOrEqual(3);
    // Evaluations inside a batch happen only at its close (the close is still open when the strategy runs it).
    expect(inside.every((id) => id.startsWith(`${RAW.batchClose(MINT)}#`)), inside.join(', ')).toBe(true);
    expect(inside.length).toBeGreaterThan(0);
    const replayed = (engine.records as readonly LogRecord[]).flatMap((r) => (r.type === 'decision' && (r.reasons[0] === 'reject' || r.reasons[0] === 'enter') ? [{ event: r.eventId, first: r.reasons[0] }] : []));
    const live = lines.filter((l) => l.kind === 'decision' && (l.reasons?.[0] === 'reject' || l.reasons?.[0] === 'enter')).map((l) => ({ event: l.event, first: l.reasons![0] }));
    expect(replayed).toEqual(live);
    expect(live.some((l) => l.first === 'enter')).toBe(true);
    // Budget: per batch at most the planned Helius calls of one evaluation (accounts 1, holders 3), the scan aside.
    const helius = chain.calls.filter((c) => c.method !== 'getProgramAccounts' && c.atMs >= T);
    expect(helius.length).toBeLessThanOrEqual(batches * (HELIUS_CALLS_PER_EVALUATION.accounts + HELIUS_CALLS_PER_EVALUATION.holders) + 1);
    expect(chain.calls.filter((c) => c.method === 'getProgramAccounts').length).toBeLessThanOrEqual(batches);
  }, 120_000);
});

const rows = <T>(dir: string, re: RegExp, parse: (l: string) => T): T[] =>
  readdirSync(join(dir, 'days')).sort().flatMap((d) => readdirSync(join(dir, 'days', d)).filter((f) => re.test(f)).sort()
    .flatMap((f) => zstdDecompressSync(readFileSync(join(dir, 'days', d, f))).toString('utf8').split('\n').filter((l) => l !== '').map(parse)));

// ---------- FactReaders.readBatch on its own ----------

/** A chain answering at once, each method at its own context slot; `hold` keeps the scan's answer until released. */
const batchRig = (o: { readonly bankSlot?: bigint; readonly scanSlot?: bigint; readonly extraPda?: boolean; readonly hold?: boolean; readonly scansPerDay?: number; readonly movedOwner?: boolean } = {}) => {
  const timers = new ManualTimers(T);
  const frames: { key: string; value: unknown; receivedAt: number }[] = [];
  const seen: { method: string; params: unknown[] }[] = [];
  const bankSlot = o.bankSlot ?? 1_000n;
  const PDA = (() => {
    for (let j = 0; ; j++) {
      const a = ACC(`pda:${j}`);
      if (!isOnCurve(decodeBase58(a))) return a;
    }
  })();
  const pdaAccount = { address: ACC('pda-holder'), owner: PDA, amount: 1n };
  let release: (() => void) | null = null;
  const http: HttpClient = async (req) => {
    if (req.url.includes('rugcheck')) return resp(200, JSON.stringify({ mint: MINT, mintAuthority: null, freezeAuthority: null }));
    if (req.url.includes('gopluslabs')) return resp(200, JSON.stringify({ code: 1, result: { [MINT]: { mintable: { status: '0' }, freezable: { status: '0' } } } }));
    const body = JSON.parse(req.body ?? '{}') as { method: string; params: unknown[] };
    seen.push(body);
    const acc = (address: string): unknown => {
      if (address === MINT) return { owner: MINT_ACCOUNT.owner, data: [MINT_ACCOUNT.dataBase64, 'base64'], lamports: 1, executable: false };
      if (address === POOL.lpMint) return { owner: TOKEN_PROGRAM, data: b64(lpMintData()), lamports: 1, executable: false };
      if (address === POOL_ADDRESS || address === POOL.poolQuoteTokenAccount || address === POOL.poolBaseTokenAccount) {
        const a = account(address);
        return { owner: a.owner, data: [a.dataBase64, 'base64'], lamports: 1, executable: false };
      }
      if (address === PDA) return { owner: PAMM, data: ['', 'base64'], lamports: 1, executable: false };
      const t = holderData.get(address);
      return t === undefined ? null : { owner: MINT_ACCOUNT.owner, data: b64(t), lamports: 1, executable: false };
    };
    // The final bank (it starts with the mint): with `movedOwner`, the top wallet's account has a new owner since discovery.
    const moved = (address: string): unknown => {
      const top = HOLDERS.find((a) => a.owner === W(0))!;
      return address === top.address ? { owner: MINT_ACCOUNT.owner, data: b64(tokenAccountData(MINT as Address, W('new-owner') as Address, top.amount)), lamports: 1, executable: false } : acc(address);
    };
    switch (body.method) {
      case 'getMultipleAccounts': {
        const list = body.params[0] as string[];
        return rpcResult(bankSlot, list.map(o.movedOwner === true && list[0] === MINT ? moved : acc));
      }
      case 'getTokenLargestAccounts': {
        const top = [...HOLDERS].sort((a, b) => (a.amount > b.amount ? -1 : a.amount < b.amount ? 1 : 0)).slice(0, 20);
        return rpcResult(bankSlot - 1n, top.map((a) => ({ address: a.address, amount: String(a.amount), decimals: 6, uiAmountString: '0' })));
      }
      case 'getProgramAccounts': {
        // The extra PDA's tokens come out of a filler, so the set still adds up to the supply.
        const filler = HOLDERS.find((a) => a.amount === 1_000_000_000_000n)!;
        const list = o.extraPda !== true ? HOLDERS : [...HOLDERS.map((a) => (a === filler ? { ...a, amount: a.amount - 1n } : a)), { ...filler, ...pdaAccount }];
        const value = list.map((a) => ({ pubkey: a.address, account: acc(a.address) ?? { owner: MINT_ACCOUNT.owner, data: b64(tokenAccountData(MINT as Address, a.owner as Address, a.amount)), lamports: 1, executable: false } }));
        const answer = () => rpcResult(o.scanSlot ?? bankSlot, value.map((v, i) => (list[i]!.address === filler.address && o.extraPda === true ? { ...v, account: { owner: MINT_ACCOUNT.owner, data: b64(tokenAccountData(MINT as Address, filler.owner as Address, list[i]!.amount)), lamports: 1, executable: false } } : v)));
        if (o.hold !== true) return answer();
        return new Promise<HttpResponse>((ok) => void (release = () => ok(answer())));
      }
      default: throw new Error(`unexpected ${body.method}`);
    }
  };
  const sched = (spec: typeof HELIUS_FREE) => new Scheduler(spec, { timers, creditsUsed: 0 });
  const readers = new FactReaders({
    feed: { ingest: (_s, b, io) => void (b.type === 'offchain' && frames.push({ key: b.key, value: b.value, receivedAt: io.receivedAt })) },
    rpc: new FactRpc({ url: () => 'https://helius.test/?api-key=k', http, scheduler: sched(HELIUS_FREE), timeoutMs: 1000 }),
    http, timers, timeoutMs: 1000, rugcheck: { scheduler: sched(RUGCHECK_FREE) }, goplus: { scheduler: sched(GOPLUS_FREE) },
    ...(o.scansPerDay === undefined ? {} : { holderScansPerDay: o.scansPerDay }),
  });
  readers.simulate = async (mint, spend, ingest) => {
    const q = simulated(spend);
    if (q === null) return false;
    ingest({ mint, slot: bankSlot, spend, ok: true, ...q, error: null });
    return true;
  };
  const run = async (req: BatchRequest): Promise<BatchResult> => {
    let done: BatchResult | null = null;
    void readers.readBatch(MINT, req).then((v) => void (done = v));
    for (let k = 0; k < 200 && done === null; k++) {
      await settle();
      timers.advance(50);
    }
    return done ?? {};
  };
  return { readers, frames, seen, run, timers, PDA, release: () => release?.(), pending: () => release !== null };
};

const SPEND = 13_000_000n;
const allOk = (r: BatchResult): boolean => Object.keys(r).length > 0 && Object.values(r).every(Boolean);
const keysOf = (frames: readonly { key: string }[]) => frames.map((f) => f.key);

describe('FactReaders.readBatch', () => {
  it('a bounded batch: accounts, holders, simulation and cross-checks between its open and close, lag-bound inputs from one bank', async () => {
    const r = batchRig();
    expect(allOk(await r.run({ holders: 'largest', spend: SPEND, xcheck: true }))).toBe(true);
    // Open first and close last; the members in between, in the order they answered.
    expect(r.frames[0]!.key).toBe(RAW.batchOpen(MINT));
    expect(r.frames.at(-1)!.key).toBe(RAW.batchClose(MINT));
    expect(new Set(keysOf(r.frames))).toEqual(new Set([RAW.batchOpen(MINT), RAW.accounts(MINT), RAW.holders(MINT), RAW.goplus(MINT), RAW.rugcheck(MINT), RAW.sim(MINT), RAW.batchClose(MINT)]));
    // One moment: everything put on together.
    expect(new Set(r.frames.map((f) => f.receivedAt)).size).toBe(1);
    const accounts = parseAccountsRead(r.frames.find((f) => f.key === RAW.accounts(MINT))!.value)!;
    const holders = parseHoldersRead(r.frames.find((f) => f.key === RAW.holders(MINT))!.value)!;
    // Balances, supply and the mint at the same bank (H12/H13: holders at or after the supply read).
    expect(holders.slot).toBe(accounts.slot);
    expect(holders.accounts.length).toBe(20);
    expect(holders.accounts.find((a) => a.owner === POOL_ADDRESS)?.ownerProgram).toBe(PAMM);
    // The final bank held the accounts, the listed holders and their owners in one call.
    const banks = r.seen.filter((c) => c.method === 'getMultipleAccounts' && (c.params[1] as { dataSlice?: unknown }).dataSlice === undefined);
    const final = banks.at(-1)!.params[0] as string[];
    expect(final.slice(0, 5)).toEqual([MINT, POOL_ADDRESS, POOL.poolBaseTokenAccount, POOL.poolQuoteTokenAccount, POOL.lpMint]);
    expect(final).toContain(POOL_ADDRESS);
    expect(r.frames.at(-1)!.value).toMatchObject({ mint: MINT, slot: accounts.slot });
  });

  it('a complete scan at or after the bank, its off-curve owners classified by the bank', async () => {
    const r = batchRig({ scanSlot: 1_001n });
    expect(allOk(await r.run({ holders: 'all', spend: null, xcheck: false }))).toBe(true);
    expect(new Set(keysOf(r.frames))).toEqual(new Set([RAW.batchOpen(MINT), RAW.accounts(MINT), RAW.holdersAll(MINT), RAW.batchClose(MINT)]));
    const all = parseHoldersAllRead(r.frames.find((f) => f.key === RAW.holdersAll(MINT))!.value)!;
    expect(all).toMatchObject({ slot: 1_001n, mintSlot: 1_000n, ownerPrograms: [{ owner: POOL_ADDRESS, program: PAMM }] });
    expect(completeHolders(all)).not.toBeNull();
    // The scan asked for a bank no older than the discovery's.
    const gpa = r.seen.find((c) => c.method === 'getProgramAccounts')!;
    expect(BigInt((gpa.params[1] as { minContextSlot: number }).minContextSlot)).toBeGreaterThanOrEqual(999n);
    // The close carries the oldest slot-judged member: the bank.
    expect(r.frames.at(-1)!.value).toMatchObject({ slot: 1_000n });
  });

  it('a scan older than the bank\'s supply read is refused (H12/H13: the supply must be read first); the rest still lands', async () => {
    const r = batchRig({ scanSlot: 999n });
    expect(await r.run({ holders: 'all', spend: SPEND, xcheck: true })).toEqual({ accounts: true, 'holders-all': false, sim: true, xcheck: true });
    expect(keysOf(r.frames)).not.toContain(RAW.holdersAll(MINT));
    expect(keysOf(r.frames)).toContain(RAW.accounts(MINT));
    expect(r.readers.outcomes.find((x) => x.read === `holders-all:${MINT}`)).toMatchObject({ ok: false, detail: expect.stringContaining('older than the supply read') });
  });

  it('a scan with an off-curve owner the bank did not hold is refused, and the next batch classifies it', async () => {
    const r = batchRig({ extraPda: true });
    expect(await r.run({ holders: 'all', spend: null, xcheck: false })).toEqual({ accounts: true, 'holders-all': false });
    expect(keysOf(r.frames)).not.toContain(RAW.holdersAll(MINT));
    expect(r.readers.outcomes.find((x) => x.read === `holders-all:${MINT}`)!.detail).toContain(r.PDA);
    r.frames.length = 0;
    expect(allOk(await r.run({ holders: 'all', spend: null, xcheck: false }))).toBe(true);
    const all = parseHoldersAllRead(r.frames.find((f) => f.key === RAW.holdersAll(MINT))!.value)!;
    expect(all.ownerPrograms).toContainEqual({ owner: r.PDA, program: PAMM });
    expect(completeHolders(all)).not.toBeNull();
  });

  it('a listed account whose owner at the bank was not classified in it is refused (owners and balances at one slot)', async () => {
    const r = batchRig({ movedOwner: true });
    expect(await r.run({ holders: 'largest', spend: null, xcheck: false })).toEqual({ accounts: true, holders: false });
    expect(keysOf(r.frames)).not.toContain(RAW.holders(MINT));
    expect(r.readers.outcomes.find((x) => x.read === `holders:${MINT}`)!.detail).toContain(W('new-owner'));
  });

  it('nothing reaches the feed before the last part has answered', async () => {
    const r = batchRig({ hold: true });
    let done: BatchResult | null = null;
    void r.readers.readBatch(MINT, { holders: 'all', spend: SPEND, xcheck: true }).then((v) => void (done = v));
    for (let k = 0; k < 100 && !r.pending(); k++) {
      await settle();
      r.timers.advance(50);
    }
    expect(r.pending()).toBe(true);
    for (let k = 0; k < 20; k++) {
      await settle();
      r.timers.advance(50);
    }
    // The bank, the simulation and the cross-checks have answered; the scan has not.
    expect(r.frames).toEqual([]);
    r.release();
    for (let k = 0; k < 50 && done === null; k++) {
      await settle();
      r.timers.advance(50);
    }
    expect(done).toEqual({ accounts: true, 'holders-all': true, sim: true, xcheck: true });
    expect(r.frames[0]!.key).toBe(RAW.batchOpen(MINT));
    expect(r.frames.at(-1)!.key).toBe(RAW.batchClose(MINT));
    expect(keysOf(r.frames)).toContain(RAW.holdersAll(MINT));
  });

  it('each scan comes off the daily cap as before; at the cap the batch reads no scan and says so', async () => {
    const r = batchRig({ scansPerDay: 2 });
    const seenScans = () => r.seen.filter((c) => c.method === 'getProgramAccounts').length;
    for (let k = 0; k < 2; k++) expect(allOk(await r.run({ holders: 'all', spend: null, xcheck: false }))).toBe(true);
    expect(seenScans()).toBe(2);
    expect(await r.run({ holders: 'all', spend: null, xcheck: false })).toEqual({ accounts: true, 'holders-all': false });
    expect(seenScans()).toBe(2);
    expect(r.readers.outcomes).toContainEqual({ read: `holders-all:${MINT}`, ok: false, detail: 'daily scan cap reached' });
    // The default cap is unchanged.
    expect(HOLDER_SCANS_PER_DAY).toBe(100);
  });
});

// ---------- LiveFacts: what a batch reads ----------

const H16r = (input: string, code = 'missing', neededBy = 'H1'): CandidateReason => ({ gate: 'H16', code, input, neededBy, detail: `${input} ${code}` });

const sourceRig = () => {
  const timers = new ManualTimers(T);
  const batches: [string, BatchRequest][] = [];
  const single: string[] = [];
  const none = async (kind: string) => (single.push(kind), true);
  const readers: LiveReaders = {
    readAccounts: () => none('accounts'), readHolders: () => none('holders'), readHoldersAll: () => none('holders-all'),
    readCrossChecks: async () => [await none('xcheck')], readMintHistory: () => none('mint-history'), readSolUsd: async () => true,
    readSim: () => none('sim'),
    readBatch: async (mint, req) => (batches.push([mint, req]), { accounts: true, ...(req.holders === null ? {} : { [req.holders === 'all' ? 'holders-all' : 'holders']: false }), ...(req.xcheck ? { xcheck: true } : {}) }),
  };
  const cands = new Map<string, { migratedAtMs: number; gates: readonly CandidateReason[] | null; spend: bigint | null }>();
  let counts: Record<string, { ok: number; failed: number }> = {};
  const ctx = {
    sink: { fact: (k: string, v: { counts: typeof counts }) => void (k === FACT_READS_KEY && (counts = v.counts)), now: () => timers.now() }, timers, watched: () => new Set(cands.keys()), candidates: () => cands, tip: () => 1_000n,
  } as unknown as FactContext;
  const src = new LiveFacts({
    readers: () => readers, tickMs: 1_000, minReadGapMs: 60_000, survivalAfterMs: 9e12, survivalReadDelayMs: 5_000, solUsdStartHours: 27,
    mintHistory: { maxPages: 20, funderPages: 3, funderTransactions: 10, insiderSlots: 2, firstBuyers: 20 },
  });
  src.start(ctx);
  const step = async (gates: readonly CandidateReason[], spend: bigint | null = SPEND): Promise<BatchRequest | null> => {
    cands.set(MINT, { migratedAtMs: T - 90 * 60_000, gates, spend });
    const before = batches.length;
    timers.advance(60_000);
    src.step();
    await settle();
    return batches.length > before ? batches.at(-1)![1] : null;
  };
  return { step, single, batches, src, counts: () => counts };
};

describe('LiveFacts: one batch for the stage-2 and stage-3 read inputs', () => {
  it('before stage 2 passes: the accounts and the cross-checks only; nothing read alone', async () => {
    const r = sourceRig();
    expect(await r.step([H16r('mint'), H16r('lp', 'missing', 'H6'), H16r('xcheck', 'missing', 'H16')])).toEqual({ holders: null, spend: null, xcheck: true });
    expect(r.single).toEqual([]);
  });

  it('once stage 2 has passed, every input that ages goes in each batch: accounts, holder view, simulation, cross-checks', async () => {
    const r = sourceRig();
    expect(await r.step([H16r('holders', 'missing', 'H12'), H16r('sim', 'missing', 'H15')])).toEqual({ holders: 'largest', spend: SPEND, xcheck: true });
    // A later cadence evaluation saw only the age of the accounts: the stage-3 inputs are read again with them.
    expect(await r.step([H16r('mint', 'stale')])).toEqual({ holders: 'largest', spend: SPEND, xcheck: true });
    expect(r.single).toEqual([]);
  });

  it('the complete scan once the bounded view was the last thing missing, and from then on while only age stands in the way', async () => {
    const r = sourceRig();
    await r.step([H16r('holders', 'missing', 'H12')]);
    expect(await r.step([H16r('holders', 'not-covered', 'H12'), H16r('holders', 'not-covered', 'H13')])).toEqual({ holders: 'all', spend: SPEND, xcheck: true });
    expect(await r.step([H16r('mint', 'stale'), H16r('sim', 'stale', 'H15')])).toEqual({ holders: 'all', spend: SPEND, xcheck: true });
    // Something a batch cannot bring back (an input missing) keeps the scan back: the bounded view is read instead.
    expect(await r.step([H16r('sim', 'missing', 'H15')])).toEqual({ holders: 'largest', spend: SPEND, xcheck: true });
    // Insiders come from the mint history, read on its own as before; the scan waits for them.
    expect(await r.step([H16r('insiders', 'not-covered', 'H13'), H16r('holders', 'stale', 'H12')])).toEqual({ holders: 'largest', spend: SPEND, xcheck: true });
    expect(r.single).toEqual(['mint-history']);
  });

  it('a reason that is not missing evidence reads nothing, as before (staging)', async () => {
    const r = sourceRig();
    expect(await r.step([{ gate: 'H12', code: 'top10', input: 'holders' }])).toBeNull();
    expect(await r.step([{ gate: 'regime', code: 'off' }])).toBeNull();
    expect(r.single).toEqual([]);
  });

  it('the read counter counts each part under the kind it replaces (the coverage report reads as before)', async () => {
    const r = sourceRig();
    await r.step([H16r('mint')]);
    expect(r.counts()).toMatchObject({ accounts: { ok: 1, failed: 0 }, xcheck: { ok: 1, failed: 0 } });
    await r.step([H16r('holders', 'missing', 'H12')]);
    expect(r.counts()).toMatchObject({ accounts: { ok: 2, failed: 0 }, xcheck: { ok: 2, failed: 0 }, holders: { ok: 0, failed: 1 } });
    expect(r.counts()['batch']).toBeUndefined();
  });

  it('one batch a minute per candidate, whatever the reasons ask', async () => {
    const r = sourceRig();
    await r.step([H16r('mint')]);
    r.src.step();
    await settle();
    expect(r.batches.length).toBe(1);
  });
});

describe('LiveStrategy: a batch is judged at its close', () => {
  it('at the close event itself: the next event, a slot later, would find the batch past the state lag', async () => {
    const h = makeWorker();
    await h.worker.reconcile();
    const m = await passingMarket(h, { omit: READ_FACTS });
    await m.run(3_000, 400, () => {
      m.slot();
      m.pool();
    });
    const entered = () => journal(h).some((l) => l.kind === 'decision' && l.action === 'enter');
    expect(entered()).toBe(false);
    // A batch whose chain inputs were read exactly the state lag before its own slot: fresh at the close, stale one slot on.
    m.slot();
    m.pool();
    const at = h.worker.feed.openSlot - BigInt(h.session.policy.gates.maxStateSlotLag);
    const passing = passingFacts();
    const obsAt = (v: unknown) => {
      const o = (v as { obs: FactObs }).obs;
      return { ...(v as object), obs: { provider: 'helius', slot: o.slot === null ? null : at, receivedAt: m.now, quality: [], commitment: 'confirmed' } };
    };
    m.omit = new Set();
    m.offchain(RAW.batchOpen(MINT), { mint: MINT, members: READ_FACTS });
    for (const k of READ_FACTS) m.fact(k, k === simKey(MINT) ? { ...obsAt(passing.get(k)!.value), spend: SPEND_AT_PRICE, ...simulated(SPEND_AT_PRICE)! } : obsAt(passing.get(k)!.value));
    m.offchain(RAW.batchClose(MINT), { mint: MINT, slot: at, members: READ_FACTS });
    m.omit = new Set(READ_FACTS);
    await m.run(2_000, 400, () => m.slot());
    const enter = journal(h).find((l) => l.kind === 'decision' && l.action === 'enter');
    expect(enter?.event).toMatch(new RegExp(`^${RAW.batchClose(MINT)}#`));
    await h.worker.stop();
  });
});
