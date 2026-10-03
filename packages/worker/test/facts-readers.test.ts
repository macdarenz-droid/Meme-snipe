// FACTS-1 live readers against recorded mainnet answers (core/test/facts/fixtures/facts.json), served by a fake HTTP
// client: each reader ingests exactly the raw shape the core producers read, through its scheduler; a failed,
// refused or malformed answer ingests nothing. Also the per-candidate budget against the free plans.
import { describe, expect, it } from 'vitest';
import { decodeBase58 as decode, firstFunder, recordFromRpc, SYSTEM_PROGRAM } from '../../core/src/chain/index.ts';
import { RAW, completeHolders, insiderLinks, parseAccountsRead, parseFunderRead, parseHoldersAllRead, parseHoldersRead, parseSolUsdBar } from '../../core/src/facts/index.ts';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIX, MINT, POOL } from '../../core/test/facts/helpers.ts';
import {
  ASSUMPTIONS, FACT_RPC_METHODS, FactReaders, FactRpc, HELIUS_CALLS_PER_EVALUATION, SUPPLEMENT_FILE, candidateCapacity, freePlanPerMinute, perCandidate,
  readSupplement, supplementRow, writeSupplement, type Ingest,
} from '../src/facts/index.ts';
import type { FrameBody, Source } from '../src/providers/index.ts';
import type { HttpClient, HttpRequest, HttpResponse } from '../src/providers/http.ts';
import { COINBASE_PUBLIC, GOPLUS_FREE, HELIUS_FREE, ManualTimers, RUGCHECK_FREE, Scheduler } from '../src/scheduler/index.ts';
import { blockNetwork, settle, testSecrets } from './helpers.ts';

blockNetwork();

const resp = (status: number, text: string): HttpResponse => ({ status, text, header: () => null }) as unknown as HttpResponse;
const ok = (v: unknown) => resp(200, JSON.stringify(v));
const rpcResult = (result: unknown) => ok({ jsonrpc: '2.0', id: 1, result });

const ACCOUNTS = new Map(FIX.accountsRead.accounts.map((a) => [a.address, a]));
const acct = (address: string) => {
  const a = ACCOUNTS.get(address);
  return a === undefined || a.owner === null ? null : { owner: a.owner, data: [a.data, 'base64'], lamports: 2_000_000, executable: false, rentEpoch: 0 };
};

/** Mainnet answers recorded by fetch-facts.ts, keyed by what the reader asks. */
const chain = (req: HttpRequest): HttpResponse => {
  const body = JSON.parse(req.body ?? '{}') as { method: string; params: unknown[] };
  const [p0, p1] = body.params as [unknown, Record<string, unknown>];
  expect((p1 ?? {})['commitment'] ?? (body.params[1] as Record<string, unknown> | undefined)?.['commitment']).toBe('confirmed');
  switch (body.method) {
    case 'getMultipleAccounts': {
      const list = p0 as string[];
      const h = FIX.holdersRaw;
      if (list.at(-1) === MINT && list.length === h.largest.value.length + 1) {
        return rpcResult({ context: { slot: h.tokenAccountsSlot }, value: [...h.largest.value.map((a) => holderAccount(a.address)), { owner: h.mint.owner, data: [h.mint.data, 'base64'], lamports: 1, executable: false }] });
      }
      if (h.owners.some((o) => o.owner === list[0])) {
        return rpcResult({ context: { slot: h.ownersSlot }, value: list.map((o) => {
          const p = h.owners.find((x) => x.owner === o)!.program;
          return p === null ? null : { owner: p, data: ['', 'base64'], lamports: 1, executable: false };
        }) });
      }
      return rpcResult({ context: { slot: Number(FIX.accountsRead.slot) }, value: list.map(acct) });
    }
    case 'getTokenLargestAccounts':
      return rpcResult(FIX.holdersRaw.largest);
    case 'getSignaturesForAddress':
      return rpcResult([]);
    case 'getTransaction':
      return rpcResult(FIX.transactions.find((t) => t.signature === p0)!.base64);
    default:
      throw new Error(`unexpected ${body.method}`);
  }
};

/** Token accounts of the largest holders, rebuilt as base64 accounts from the recorded owners and amounts. */
const holderAccount = (address: string) => {
  const h = FIX.holdersRaw;
  const i = h.largest.value.findIndex((a) => a.address === address);
  const data = new Uint8Array(165);
  const put = (at: number, b58: string) => data.set(decode(b58), at);
  put(0, MINT);
  put(32, h.owners[i]!.owner);
  new DataView(data.buffer).setBigUint64(64, BigInt(h.largest.value[i]!.amount), true);
  data[108] = 1; // initialized
  return { owner: tokenProgramOf(h.mint.owner), data: [Buffer.from(data).toString('base64'), 'base64'], lamports: 2_039_280, executable: false };
};
const tokenProgramOf = (mintOwner: string) => mintOwner;

const setup = (http: HttpClient, start = 1_791_100_000_000) => {
  const timers = new ManualTimers(start);
  const ingested: { source: Source; body: FrameBody }[] = [];
  const feed: Ingest = { ingest: (source, body) => ingested.push({ source, body }) };
  const sched = (spec: typeof HELIUS_FREE) => new Scheduler(spec, { timers, creditsUsed: 0 });
  const helius = sched(HELIUS_FREE);
  const rpc = new FactRpc({ url: () => 'https://helius.test/?api-key=k', http, scheduler: helius, timeoutMs: 1000 });
  const readers = new FactReaders({
    feed, rpc, http, timers, timeoutMs: 1000,
    rugcheck: { scheduler: sched(RUGCHECK_FREE) }, goplus: { scheduler: sched(GOPLUS_FREE) },
    coinbase: { scheduler: sched(COINBASE_PUBLIC) },
  });
  const raw = (key: string) => ingested.filter((x) => x.body.type === 'offchain' && x.body.key === key).map((x) => (x.body as { value: unknown }).value);
  return { timers, readers, ingested, raw, helius };
};

const pump = async <T>(p: Promise<T>, timers: ManualTimers): Promise<T> => {
  let done = false;
  let out: T | undefined;
  void p.then((v) => { done = true; out = v; }, () => { done = true; });
  for (let k = 0; k < 200 && !done; k++) {
    await settle();
    timers.advance(100);
  }
  await settle();
  return out as T;
};

describe('fact readers', () => {
  it('reads mint, canonical pool, vaults and LP mint in one confirmed bank, learning the layout once', async () => {
    let calls = 0;
    const { readers, raw, timers } = setup(async (req) => { calls++; return chain(req); });
    expect(FactReaders.canonicalPool(MINT)).toBe(POOL);
    expect(await pump(readers.readAccounts(MINT), timers)).toBe(true);
    expect(calls).toBe(2);
    const r = parseAccountsRead(raw(RAW.accounts(MINT))[0])!;
    expect(r).toMatchObject({ mint: MINT, commitment: 'confirmed', slot: BigInt(FIX.accountsRead.slot) });
    expect(r.accounts.map((a) => a.address)).toEqual(FIX.accountsRead.accounts.map((a) => a.address));
    await pump(readers.readAccounts(MINT), timers);
    expect(calls).toBe(3);
  });

  it('reads the largest holders with owners classified: System wallets carry no program', async () => {
    const { readers, raw, timers } = setup(async (req) => chain(req));
    expect(await pump(readers.readHolders(MINT), timers)).toBe(true);
    const h = parseHoldersRead(raw(RAW.holders(MINT))[0])!;
    expect(h.slot).toBe(BigInt(Math.min(FIX.holdersRaw.largest.context.slot, FIX.holdersRaw.tokenAccountsSlot, FIX.holdersRaw.ownersSlot)));
    expect(h.accounts.map((a) => a.amount)).toEqual(FIX.holdersRaw.largest.value.map((a) => BigInt(a.amount)));
    for (const [i, a] of h.accounts.entries()) {
      const p = FIX.holdersRaw.owners[i]!.program;
      expect(a.ownerProgram).toBe(p === null || p === SYSTEM_PROGRAM ? null : p);
    }
  });

  const asOf = BigInt(FIX.meta.asOfSlot);
  const withSigs = (sigs: { signature: string; slot: number; err: null }[]) => async (req: HttpRequest) => {
    const body = JSON.parse(req.body!) as { method: string; params: unknown[] };
    if (body.method === 'getSignaturesForAddress') return rpcResult(sigs);
    return chain(req);
  };

  const funded = () => {
    const f0 = FIX.funders.find((f) => f.complete && f.funder !== null)!;
    return { f0, t: FIX.transactions.find((x) => x.signature === f0.signature)! };
  };
  /** A real recorded transaction from an earlier slot that does not credit the wallet. */
  const nonCredit = (wallet: string, beforeSlot: number) => FIX.transactions.find((x) => Number(x.slot) < beforeSlot && firstFunder(recordFromRpc(x.signature, x.base64), wallet) === null)!;
  const opts = (beforeSlot: bigint, over: Partial<{ maxPages: number; maxTransactions: number; asOfSlot: bigint }> = {}) => ({ asOfSlot: asOf, beforeSlot, maxPages: 3, maxTransactions: 10, ...over });

  it('a first funder from the wallet\'s real funding transaction, by the shared decoder, as of the decision slot', async () => {
    const { f0, t } = funded();
    expect(firstFunder(recordFromRpc(t.signature, t.base64), f0.wallet)?.from).toBe(f0.funder);
    const { readers, raw, timers } = setup(withSigs([{ signature: t.signature, slot: Number(t.slot), err: null }]));
    expect(await pump(readers.readFunder(f0.wallet, opts(asOf)), timers)).toBe(true);
    expect(parseFunderRead(raw(RAW.funder(f0.wallet))[0])).toEqual({
      wallet: f0.wallet, asOfSlot: asOf, complete: true, funder: f0.funder, signature: t.signature, slot: BigInt(t.slot), atMs: f0.atMs,
    });
  });

  it('a first transaction that does not fund the wallet (a spam token account, a close refund) is passed over', async () => {
    const { f0, t } = funded();
    const u = nonCredit(f0.wallet, Number(t.slot));
    // Newest first, as RPC answers: the funding, then the earlier transaction that credits nothing.
    const { readers, raw, timers } = setup(withSigs([{ signature: t.signature, slot: Number(t.slot), err: null }, { signature: u.signature, slot: Number(u.slot), err: null }]));
    await pump(readers.readFunder(f0.wallet, opts(asOf)), timers);
    expect(parseFunderRead(raw(RAW.funder(f0.wallet))[0])).toMatchObject({ complete: true, funder: f0.funder, signature: t.signature });
  });

  it('no credit before the wallet\'s first buy, or more transactions than the budget, is unknown, never "no funder"', async () => {
    const { f0, t } = funded();
    const u = nonCredit(f0.wallet, Number(t.slot));
    const sigs = [{ signature: t.signature, slot: Number(t.slot), err: null }, { signature: u.signature, slot: Number(u.slot), err: null }];
    const unknown = { wallet: f0.wallet, asOfSlot: asOf, complete: false, funder: null, signature: null, slot: null, atMs: null };
    const early = setup(withSigs(sigs));
    await pump(early.readers.readFunder(f0.wallet, opts(BigInt(t.slot) - 1n)), early.timers);
    expect(early.raw(RAW.funder(f0.wallet))).toEqual([unknown]);
    const budget = setup(withSigs(sigs));
    await pump(budget.readers.readFunder(f0.wallet, opts(asOf, { maxTransactions: 1 })), budget.timers);
    expect(budget.raw(RAW.funder(f0.wallet))).toEqual([unknown]);
  });

  it('history after the decision slot never counts: a wallet funded later has no known funder as of then', async () => {
    const { f0, t } = funded();
    const { readers, raw, timers } = setup(withSigs([{ signature: t.signature, slot: Number(t.slot), err: null }]));
    await pump(readers.readFunder(f0.wallet, opts(asOf, { asOfSlot: BigInt(t.slot) - 1n })), timers);
    expect(raw(RAW.funder(f0.wallet))).toEqual([{ wallet: f0.wallet, asOfSlot: BigInt(t.slot) - 1n, complete: false, funder: null, signature: null, slot: null, atMs: null }]);
  });

  it('a history longer than the page cap is reported incomplete, never guessed', async () => {
    const page = Array.from({ length: 1000 }, (_, i) => ({ signature: `s${i}`, slot: 1000 - i, err: null }));
    const { readers, raw, timers } = setup(async () => rpcResult(page));
    await pump(readers.readFunder(MINT, { asOfSlot: 5000n, beforeSlot: 5000n, maxPages: 2, maxTransactions: 10 }), timers);
    expect(raw(RAW.funder(MINT))).toEqual([{ wallet: MINT, asOfSlot: 5000n, complete: false, funder: null, signature: null, slot: null, atMs: null }]);
  });

  it('the supplement replays byte for byte and gives the same links as the live rule; a tampered file is refused', async () => {
    const reads = new Map(FIX.funders.map((f) => [f.wallet, { ...f, asOfSlot: asOf, slot: f.slot === null ? null : BigInt(f.slot) }]));
    const lookup = async (w: string) => reads.get(w)!;
    const input = { mint: MINT, creator: FIX.meta.creator, createSlot: BigInt(FIX.meta.creationSlot), firstBuyers: FIX.meta.firstBuyers.map((wallet) => ({ wallet, slot: BigInt(FIX.meta.creationSlot) })), asOfSlot: asOf };
    const row = await supplementRow(input, lookup);
    expect(row.devCluster).toEqual(insiderLinks(FIX.meta.creator, FIX.meta.firstBuyers, (w) => reads.get(w))!.devCluster);
    const dir = mkdtempSync(join(tmpdir(), 'facts-supplement-'));
    const a = writeSupplement(dir, [row]);
    const back = readSupplement(dir);
    expect(back.get(MINT)).toEqual(row);
    expect(writeSupplement(mkdtempSync(join(tmpdir(), 'facts-supplement-')), [...back.values()]).sha256).toBe(a.sha256);
    writeFileSync(join(dir, SUPPLEMENT_FILE), readFileSync(join(dir, SUPPLEMENT_FILE), 'utf8').replace(MINT, POOL));
    expect(() => readSupplement(dir)).toThrow(/sha256/);
    // One incomplete read: no links, so BT-2's insiders stay not covered.
    const short = await supplementRow(input, async (w) => (w === FIX.meta.creator ? { ...reads.get(w)!, complete: false } : reads.get(w)!));
    expect([short.funded, short.devCluster, short.knownAtMs]).toEqual([null, null, null]);
  });

  it('the complete holder set is one program-account read at confirmed; the daily cap stops it', async () => {
    const hc = FIX.holdersComplete;
    let gpaCalls = 0;
    const http = async (req: HttpRequest) => {
      const body = JSON.parse(req.body!) as { method: string; params: unknown[] };
      if (body.method === 'getAccountInfo') return rpcResult({ context: { slot: hc.mint.slot }, value: { owner: hc.mint.owner, data: [hc.mint.data, 'base64'], lamports: 1, executable: false } });
      if (body.method === 'getProgramAccounts') {
        gpaCalls++;
        const cfg = body.params[1] as { filters: unknown[]; commitment: string; minContextSlot: number };
        expect(cfg.filters).toEqual([{ memcmp: { offset: 0, bytes: MINT } }, { memcmp: { offset: 165, bytes: '3' } }]);
        expect(cfg.minContextSlot).toBe(hc.mint.slot);
        expect(cfg.commitment).toBe('confirmed');
        return rpcResult({ context: { slot: hc.gpa.slot }, value: hc.gpa.accounts.map((a) => ({ pubkey: a.address, account: { owner: a.owner, data: [a.data, 'base64'], lamports: 1, executable: false } })) });
      }
      return rpcResult({ context: { slot: hc.gpa.slot }, value: (body.params[0] as string[]).map(() => ({ owner: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', data: ['', 'base64'], lamports: 1, executable: false })) });
    };
    const timers = new ManualTimers(1_791_100_000_000);
    const ingested: { body: FrameBody }[] = [];
    const rpc = new FactRpc({ url: () => 'x', http, scheduler: new Scheduler(HELIUS_FREE, { timers, creditsUsed: 0 }), timeoutMs: 1000 });
    const readers = new FactReaders({ feed: { ingest: (_s, body) => ingested.push({ body }) }, rpc, http, timers, timeoutMs: 1000, holderScansPerDay: 1 });
    expect(await pump(readers.readHoldersAll(MINT), timers)).toBe(true);
    expect(await pump(readers.readHoldersAll(MINT), timers)).toBe(false);
    expect(gpaCalls).toBe(1);
    expect(readers.outcomes.at(-1)).toMatchObject({ ok: false, detail: 'daily scan cap reached' });
    const r = parseHoldersAllRead((ingested[0]!.body as { value: unknown }).value)!;
    expect(r.accounts.length).toBe(hc.gpa.accounts.length);
    expect(new Set(r.accounts.map((a) => a.address)).size).toBe(r.accounts.length);
    expect(completeHolders(r)!.accounts.reduce((x, a) => x + a.amount, 0n)).toBe(completeHolders(r)!.supply);
    // The pool's own vault is owned by a PDA: its program was read.
    expect(r.ownerPrograms.length).toBeGreaterThan(0);
  });

  it('third-party reads are trimmed to the authorities; a report without them ingests nothing', async () => {
    const tp = FIX.thirdParty;
    const { readers, raw, timers } = setup(async (req) => {
      if (req.url.includes('rugcheck')) return ok({ mint: MINT, mintAuthority: tp.rugcheck.mintAuthority, freezeAuthority: tp.rugcheck.freezeAuthority, topHolders: [] });
      if (req.url.includes('gopluslabs')) return ok({ code: 1, result: { [MINT]: tp.goplus } });
      return resp(500, 'x');
    });
    await pump(readers.readCrossChecks(MINT), timers);
    expect(raw(RAW.rugcheck(MINT))).toEqual([{ mint: MINT, mintAuthority: tp.rugcheck.mintAuthority, freezeAuthority: tp.rugcheck.freezeAuthority }]);
    if (tp.goplus !== null) expect(raw(RAW.goplus(MINT))).toEqual([{ mint: MINT, mintable: tp.goplus.mintable.status, freezable: tp.goplus.freezable.status }]);
    const bad = setup(async () => ok({ mint: MINT, score: 1 }));
    expect(await pump(bad.readers.readRugCheck(MINT), bad.timers)).toBe(false);
    expect(bad.ingested).toEqual([]);
  });

  it('SOL/USD bars are released once usable and never twice', async () => {
    const { readers, raw, timers } = setup(async () => resp(200, FIX.coinbase), Date.parse(FIX.meta.fetchedAt));
    await pump(readers.readSolUsd(72), timers);
    const bars = raw(RAW.solUsd).map((b) => parseSolUsdBar(b)!);
    expect(bars.length).toBeGreaterThan(40);
    const now = timers.now();
    for (const b of bars) expect(b.start + 2 * 3_600_000).toBeLessThanOrEqual(now);
    await pump(readers.readSolUsd(72), timers);
    expect(raw(RAW.solUsd).length).toBe(bars.length);
  });

  it('HTTP errors, RPC errors and rate limits ingest nothing', async () => {
    for (const r of [resp(500, ''), resp(429, ''), ok({ jsonrpc: '2.0', id: 1, error: { code: -32005 } }), ok({ jsonrpc: '2.0', id: 1, result: { value: [] } })]) {
      const s = setup(async () => r);
      expect(await pump(s.readers.readAccounts(MINT), s.timers)).toBe(false);
      expect(await pump(s.readers.readHolders(MINT), s.timers)).toBe(false);
      expect(s.ingested).toEqual([]);
    }
  });

  it('the read-only method list has no way to send', () => {
    expect([...FACT_RPC_METHODS]).toEqual(['getAccountInfo', 'getMultipleAccounts', 'getProgramAccounts', 'getTokenLargestAccounts', 'getSignaturesForAddress', 'getTransaction']);
    expect(Object.isFrozen(FACT_RPC_METHODS)).toBe(true);
    const { helius } = setup(async () => resp(200, '{}'));
    const rpc = new FactRpc({ url: () => 'x', http: async () => resp(200, '{}'), scheduler: helius, timeoutMs: 1 });
    return expect(rpc.call('sendTransaction' as never, [], 2)).rejects.toThrow(/not allowed/);
  });
});

describe('budget per candidate per minute', () => {
  it('fits the free plans at the assumed cadence, and says how many candidates', () => {
    const c = perCandidate();
    expect(c.heliusCreditsPerMinute).toBe(HELIUS_CALLS_PER_EVALUATION.accounts + HELIUS_CALLS_PER_EVALUATION.holders + HELIUS_CALLS_PER_EVALUATION.sim);
    const f = freePlanPerMinute();
    // 1M credits a month, halted at 70%: about 16.2 credits a minute for everything.
    expect(f.heliusCredits).toBeCloseTo(16.2, 1);
    const cap = candidateCapacity();
    expect(cap.helius).toBe(3);
    expect(cap.alchemy).toBeGreaterThan(cap.helius);
    expect(cap.rugcheck).toBe(13);
    expect(cap.goplus).toBe(12);
    expect(ASSUMPTIONS.evaluationsPerMinute).toBe(1);
  });
});
