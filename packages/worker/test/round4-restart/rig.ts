// Shared rig for the round-4 paralysis probes: a copy of read-coherent.test.ts's fake chain and run(), with the
// RPC, the third-party cross-checks and the simulation each answering after their own delay (in slots), and a hook
// that lets a probe occupy the cross-check schedulers just before each batch (another candidate's batch).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';
import { type PoolState } from '../../../core/src/amm/index.ts';
import { type Address, TOKEN_PROGRAM, toBase64 } from '../../../core/src/chain/index.ts';
import { holdersKey, lpKey, mintKey, poolKey, simKey, xcheckKey } from '../../../core/src/gates/index.ts';
import { ACC, BASE_VAULT, FEE_CONTEXT, QUOTE_VAULT, W, account, holderAccounts } from '../../../core/test/gates/world.ts';
import { poolBuyExactQuoteIn, poolSell } from '../../../core/src/amm/index.ts';
import { FactReaders, FactRpc, LiveFacts, type BatchRequest, type LiveReaders, type SimFn } from '../../src/facts/index.ts';
import type { HttpClient, HttpRequest, HttpResponse } from '../../src/providers/http.ts';
import type { FactContext } from '../../src/run/facts.ts';
import { GOPLUS_FREE, RUGCHECK_FREE, Scheduler } from '../../src/scheduler/index.ts';
import { tokenAccountData } from '../dryrun-chain.ts';
import { MINT, type Market, POOL, POOL_ADDRESS, T, dueTimers, makeWorker, passingMarket, type Harness } from '../worker-harness.ts';

const DAY = 86_400_000;
export const SLOT_MS = 400;
const READ_FACTS = [mintKey(MINT), lpKey(MINT), holdersKey(MINT), simKey(MINT), xcheckKey(MINT)];
const PAMM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const resp = (status: number, text: string): HttpResponse => ({ status, text, header: () => null }) as unknown as HttpResponse;
const rpcResult = (slot: bigint, value: unknown) => resp(200, JSON.stringify({ jsonrpc: '2.0', id: 1, result: { context: { slot: Number(slot) }, value } }));
const b64 = (d: Uint8Array) => [toBase64(d), 'base64'];
void (null as unknown as PoolState);
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
export const fakeChain = (h: Harness, slotsPerCall = 1, feeAccounts = false, xcheckMs = SLOT_MS * slotsPerCall, scanMs = SLOT_MS * slotsPerCall): FakeChain => {
  const calls: FakeChain['calls'] = [];
  const later = (r: () => HttpResponse, ms = SLOT_MS * slotsPerCall): Promise<HttpResponse> => new Promise((ok) => h.timers.setTimeout(() => ok(r()), ms));
  const http: HttpClient = async (req: HttpRequest) => {
    const tip = h.worker.feed.tip ?? 0n;
    const slot = tip - 1n;
    if (req.url.includes('rugcheck')) return later(() => resp(200, JSON.stringify({ mint: MINT, mintAuthority: null, freezeAuthority: null })), xcheckMs);
    if (req.url.includes('gopluslabs')) return later(() => resp(200, JSON.stringify({ code: 1, result: { [MINT]: { mintable: { status: '0' }, freezable: { status: '0' } } } })), xcheckMs);
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
      void feeAccounts; return null;
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
        return later(() => rpcResult(slot, HOLDERS.map((a) => ({ pubkey: a.address, account: one(a.address) ?? { owner: MINT_ACCOUNT.owner, data: b64(holderData.get(a.address)!), lamports: 1, executable: false } }))), scanMs);
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
const simOf = (ctx: FactContext, slotsPerCall = 1, simMs = SLOT_MS * slotsPerCall): SimFn => (mint, spend, ingest) =>
  new Promise((ok) => {
    const slot = (ctx.tip() ?? 1n) - 1n;
    ctx.timers.setTimeout(() => {
      const q = simulated(spend);
      if (q === null) return ok(false);
      ingest({ mint, slot, spend, ok: true, ...q, error: null });
      ok(true);
    }, simMs);
  });

/** The production LiveFacts settings (liveFacts), on FactReaders over the fake chain. */
export interface RigOptions {
  /** Helius RPC answer delay in slots (the bank, discovery). */
  readonly slotsPerCall?: number;
  /** RugCheck and GoPlus answer delay in ms (third-party HTTP). */
  readonly xcheckMs?: number;
  /** getProgramAccounts (the complete holder scan) answer delay in ms. */
  readonly scanMs?: number;
  /** H15 simulation answer delay in ms. */
  readonly simMs?: number;
  /** Called just before each batch starts, with the cross-check schedulers (another candidate's batch queued first). */
  readonly beforeBatch?: (s: { readonly rugcheck: Scheduler; readonly goplus: Scheduler }) => void;
  readonly each?: (m: Market) => void;
  readonly minutes?: number;
}

const liveFactsOn = (chain: FakeChain, o: RigOptions) => new LiveFacts({
  readers: (ctx) => {
    const timers = ctx.timers;
    const rugcheck = new Scheduler(RUGCHECK_FREE, { timers });
    const goplus = new Scheduler(GOPLUS_FREE, { timers });
    const r = new FactReaders({
      feed: ctx.ingest, http: chain.http, timers, timeoutMs: 10_000,
      rpc: new FactRpc({ url: () => 'https://helius.test/?api-key=k', http: chain.http, scheduler: ctx.schedulers.helius, timeoutMs: 10_000 }),
      rugcheck: { scheduler: rugcheck }, goplus: { scheduler: goplus },
    });
    const sim = simOf(ctx, o.slotsPerCall ?? 1, o.simMs);
    r.simulate = sim;
    const orig = r.readBatch.bind(r);
    const live: LiveReaders = Object.assign(r, {
      readSim: (mint: string, spend: bigint) => sim(mint, spend, (read) => r.ingestSim(read)),
      readBatch: (mint: string, req: BatchRequest) => {
        o.beforeBatch?.({ rugcheck, goplus });
        return orig(mint, req);
      },
    });
    return live;
  },
  tickMs: 1_000, minReadGapMs: 60_000, survivalAfterMs: 30 * 60_000, survivalReadDelayMs: 5_000, solUsdStartHours: 27,
  mintHistory: { maxPages: 20, funderPages: 3, funderTransactions: 10, insiderSlots: 2, firstBuyers: 20 },
});

export type JournalLine = { kind: string; action?: string; event?: string; reasons?: string[]; gate_reasons?: { gate: string; code: string; detail?: string }[] };
const journal = (h: Harness): JournalLine[] => readFileSync(join(h.stateDir, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as JournalLine);

/** Starts the worker with the read-backed fact source and runs `minutes` of market (a slot every 400 ms). */
export const runRig = async (port: number, o: RigOptions = {}) => {
  const timers = dueTimers(T - 16 * DAY);
  const facts = { name: 'facts', start: (c: FactContext) => src.start(c), stop: () => src.stop() };
  let src: LiveFacts = null as unknown as LiveFacts;
  const h = makeWorker({ timers, facts: [facts], config: { ZEROED_HEALTH_ADDR: `127.0.0.1:${port}`, ZEROED_API_ADDR: `127.0.0.1:${port + 1}` } });
  const chain = fakeChain(h, o.slotsPerCall ?? 1, false, o.xcheckMs, o.scanMs);
  src = liveFactsOn(chain, o);
  let started: unknown = null;
  void h.worker.start().then((r) => void (started = r));
  for (let k = 0; k < 200 && started === null; k++) {
    h.timers.set(h.timers.now() + 100);
    for (let j = 0; j < 4; j++) await new Promise<void>((r) => setImmediate(r));
  }
  expect(started).toEqual({ ok: true });
  h.worker.feed.ingest('helius', { type: 'offchain', key: 'feed:status:helius', value: { state: 'up' } }, { receivedAt: h.timers.now() });
  const m = await passingMarket(h, { heldPoolFacts: true, omit: READ_FACTS });
  await m.run((o.minutes ?? 5) * 60_000, SLOT_MS, () => {
    m.slot();
    m.pool();
    o.each?.(m);
  });
  await h.worker.stop();
  const lines = journal(h);
  const decisions = lines.filter((l) => l.kind === 'decision');
  const entered = decisions.some((l) => l.action === 'enter');
  const rejects = decisions.filter((l) => l.action === 'reject').map((l) => (l.gate_reasons ?? []).map((g) => `${g.gate} ${g.code} ${g.detail ?? ''}`).join(' | '));
  const atClose = decisions.filter((l) => l.event?.startsWith(`reads:${MINT}#`) === true).map((l) => `${l.action ?? 'none'}: ${(l.gate_reasons ?? []).map((g) => `${g.gate} ${g.code} ${g.detail ?? ''}`).join(' | ')}`);
  return { h, chain, entered, rejects, atClose };
};

