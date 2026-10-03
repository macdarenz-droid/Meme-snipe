// FACTS-1 live readers against recorded mainnet answers (core/test/facts/fixtures/facts.json), served by a fake HTTP
// client: each reader ingests exactly the raw shape the core producers read, through its scheduler; a failed,
// refused or malformed answer ingests nothing. Also the per-candidate budget against the free plans.
import { describe, expect, it } from 'vitest';
import { decodeBase58 as decode, firstFunder, recordFromRpc, SYSTEM_PROGRAM } from '../../core/src/chain/index.ts';
import { RAW, parseAccountsRead, parseCurveVolumeSnapshot, parseFunderRead, parseHoldersRead, parseSolUsdBar } from '../../core/src/facts/index.ts';
import { FIX, MINT, POOL } from '../../core/test/facts/helpers.ts';
import {
  ASSUMPTIONS, FACT_RPC_METHODS, FactReaders, FactRpc, HELIUS_CALLS_PER_EVALUATION, candidateCapacity, freePlanPerMinute, perCandidate, type Ingest,
} from '../src/facts/index.ts';
import type { FrameBody, Source } from '../src/providers/index.ts';
import type { HttpClient, HttpRequest, HttpResponse } from '../src/providers/http.ts';
import { COINBASE_PUBLIC, DEFILLAMA_FREE, GOPLUS_FREE, HELIUS_FREE, ManualTimers, RUGCHECK_FREE, Scheduler } from '../src/scheduler/index.ts';
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
    coinbase: { scheduler: sched(COINBASE_PUBLIC) }, defillama: { scheduler: sched(DEFILLAMA_FREE) },
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

  it('a first funder from the wallet\'s oldest real transaction, by the shared decoder', async () => {
    const f0 = FIX.funders.find((f) => f.complete && f.signature !== null);
    if (f0 === undefined) return;
    const t = FIX.transactions.find((x) => x.signature === f0.signature)!;
    expect(firstFunder(recordFromRpc(t.signature, t.base64), f0.wallet)?.from).toBe(f0.funder);
    const { readers, raw, timers } = setup(async (req) => {
      const body = JSON.parse(req.body!) as { method: string; params: unknown[] };
      if (body.method === 'getSignaturesForAddress') return rpcResult([{ signature: t.signature, slot: Number(t.slot), err: null }]);
      return chain(req);
    });
    expect(await pump(readers.readFunder(f0.wallet, 3), timers)).toBe(true);
    expect(parseFunderRead(raw(RAW.funder(f0.wallet))[0])).toEqual({ wallet: f0.wallet, complete: true, funder: f0.funder, signature: t.signature, slot: BigInt(t.slot) });
  });

  it('a history longer than the page cap is reported incomplete, never guessed', async () => {
    const page = Array.from({ length: 1000 }, (_, i) => ({ signature: `s${i}`, slot: 1000 - i, err: null }));
    const { readers, raw, timers } = setup(async () => rpcResult(page));
    await pump(readers.readFunder(MINT, 2), timers);
    expect(raw(RAW.funder(MINT))).toEqual([{ wallet: MINT, complete: false, funder: null, signature: null, slot: null }]);
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

  it('SOL/USD bars are released once usable and never twice; DefiLlama becomes one dated snapshot', async () => {
    const { readers, raw, timers } = setup(async (req) => (req.url.includes('coinbase') ? resp(200, FIX.coinbase) : ok({ totalDataChart: FIX.llama })), Date.parse(FIX.meta.fetchedAt));
    await pump(readers.readSolUsd(72), timers);
    const bars = raw(RAW.solUsd).map((b) => parseSolUsdBar(b)!);
    expect(bars.length).toBeGreaterThan(40);
    const now = timers.now();
    for (const b of bars) expect(b.start + 2 * 3_600_000).toBeLessThanOrEqual(now);
    await pump(readers.readSolUsd(72), timers);
    expect(raw(RAW.solUsd).length).toBe(bars.length);
    await pump(readers.readCurveVolume(), timers);
    const v = parseCurveVolumeSnapshot(raw(RAW.curveVolume)[0])!;
    expect(v.days.length).toBe(FIX.llama.length);
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
    expect([...FACT_RPC_METHODS]).toEqual(['getMultipleAccounts', 'getTokenLargestAccounts', 'getSignaturesForAddress', 'getTransaction']);
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
