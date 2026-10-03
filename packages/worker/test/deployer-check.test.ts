// RUG-1c on real chain data (fixtures/rug-replay.json): the deployer check reads a prior mint's history through a
// source, judges it as of a moment under a credit cap, and gives the same answer from RPC or from a cached supplement.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { recordFromRpc, type RpcTransactionBase64 } from '../../core/src/chain/index.ts';
import { RUG_CONFIG, type RugCheckConfig } from '../../core/src/config/index.ts';
import type { Moment } from '../../core/src/engine/index.ts';
import { RUG_CHECK_PREFIX } from '../../core/src/gates/index.ts';
import {
  SupplementRecorder, checkDeployer, checkFacts, rpcHistorySource, supplementSource, type RugHistorySource, type RugSupplement,
} from '../src/providers/deployer-check.ts';
import { RpcHttp, rpcHandler, scriptedHttp } from '../src/providers/index.ts';
import { HELIUS_FREE, ManualTimers, P2, Scheduler } from '../src/scheduler/index.ts';
import { blockNetwork, settle } from './helpers.ts';

blockNetwork();
import type { SignatureInfo } from '../src/providers/solana-http.ts';

type Tx = RpcTransactionBase64 & { readonly signature: string; readonly slot: number; readonly blockTime: number };
interface Case { readonly name: string; readonly mint: string; readonly transactions: readonly Tx[] }
const FIXTURE = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'rug-replay.json'), 'utf8')) as { cases: Case[] };
const RUG = FIXTURE.cases.find((c) => c.name === 'rug')!;
const CLEAN = FIXTURE.cases.find((c) => c.name === 'non-rug')!;
const DEV = 'GaMPRt9yhnhRAB134imiwkmXAtVYkcTtZFzF1nBeqw6H';
const DUMP = '4f4YRWURmxFMtdrWB4EoYiodfBSawRrwnHQV3B9LZqtT2VJEtK9as4yDBfah9JmDkr615suRt9DtXGESji1CJUxq';
const CFG: RugCheckConfig = { version: 'rug-check-test', creditCapPerCandidate: 1_000, maxLagSlots: 150 };

/** A source over fixture cases, counting calls and the slots of the transactions it was asked for. */
const fixtureSource = (cases: readonly Case[], fail = false) => {
  const sigs = new Map(cases.map((c) => [c.mint, [...c.transactions].reverse().map((t): SignatureInfo => ({ signature: t.signature, slot: BigInt(t.slot), err: null, blockTime: t.blockTime }))]));
  const txs = new Map(cases.flatMap((c) => c.transactions.map((t) => [t.signature, t] as const)));
  const asked: bigint[] = [];
  let calls = 0;
  const source: RugHistorySource = {
    cost: { signatures: 1, transaction: 1 },
    signatures: async (address, before, limit) => {
      calls++;
      if (fail) throw new Error('rpc down');
      const all = sigs.get(address) ?? [];
      const from = before === undefined ? 0 : all.findIndex((s) => s.signature === before) + 1;
      return all.slice(from, from + limit);
    },
    transaction: async (signature) => {
      calls++;
      const t = txs.get(signature);
      if (t === undefined) return null;
      asked.push(BigInt(t.slot));
      return recordFromRpc(signature, t);
    },
  };
  return { source, asked, calls: () => calls, raw: async (s: string) => (txs.get(s) ?? null) as RpcTransactionBase64 | null };
};

const launch = (c: Case) => ({ mint: c.mint, createdAtMs: c.transactions[0]!.blockTime * 1_000 });
const at = (slot: bigint): Moment => ({ slot, txIndex: 0, ixIndex: 0, receivedAt: 0 });
const lastSlot = (c: Case) => BigInt(c.transactions.at(-1)!.slot);
const DAY = 86_400_000;

describe('deployer check on real chain data', () => {
  it('finds the known rug at the deployer\'s dump and releases its label and the coverage fact', async () => {
    const { source } = fixtureSource([RUG]);
    const r = await checkDeployer(source, RUG_CONFIG, CFG, { creator: DEV, mints: [launch(RUG)], fromMs: 0, asOf: at(lastSlot(RUG) + 1n), asOfMs: launch(RUG).createdAtMs + 200_000 }, 7);
    expect(r.fact.mints).toEqual([expect.objectContaining({ mint: RUG.mint, status: 'rug', detail: 'creator-dump: the deployer sold 50591814205825 of 1000000000000000 tokens within 126000 ms of launch' })]);
    expect(r.fact).toMatchObject({ creator: DEV, version: 'rug-check-test', obs: { slot: lastSlot(RUG) + 1n, receivedAt: 7, commitment: 'confirmed' } });
    expect(r.fact.credits).toBe(1 + RUG.transactions.length);
    expect(checkFacts(r).map((f) => f.key)).toEqual([`rug:${RUG.mint}`, `${RUG_CHECK_PREFIX}${DEV}`]);
  });

  it('as of the dump\'s own slot the mint is still open, and no transaction from that slot on is read', async () => {
    const { source, asked } = fixtureSource([RUG]);
    const r = await checkDeployer(source, RUG_CONFIG, CFG, { creator: DEV, mints: [launch(RUG)], fromMs: 0, asOf: at(lastSlot(RUG)), asOfMs: launch(RUG).createdAtMs + 200_000 }, 7);
    expect(r.fact.mints[0]).toMatchObject({ status: 'open' });
    expect(r.labels).toEqual([]);
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((s) => s < lastSlot(RUG))).toBe(true);
    expect(RUG.transactions.at(-1)!.signature).toBe(DUMP);
  });

  it('a mint with no rule met is clear once its windows ended before the as-of time', async () => {
    const { source } = fixtureSource([CLEAN]);
    const req = { creator: DEV, mints: [launch(CLEAN)], fromMs: 0, asOf: at(lastSlot(CLEAN) + 1_000_000n) };
    expect((await checkDeployer(source, RUG_CONFIG, CFG, { ...req, asOfMs: launch(CLEAN).createdAtMs + DAY + 1 }, 0)).fact.mints[0]!.status).toBe('clear');
    expect((await checkDeployer(source, RUG_CONFIG, CFG, { ...req, asOfMs: launch(CLEAN).createdAtMs + DAY }, 0)).fact.mints[0]!.status).toBe('open');
  });

  it('past the credit cap, the mint being read and every later one are unfetched', async () => {
    const { source, calls } = fixtureSource([RUG, CLEAN]);
    const need = 1 + RUG.transactions.length;
    const req = { creator: DEV, mints: [launch(RUG), launch(CLEAN)], fromMs: 0, asOf: at(lastSlot(CLEAN) + 1_000_000n), asOfMs: launch(CLEAN).createdAtMs + DAY + 1 };
    // Newest launch first: RUG (22:07 UTC), then CLEAN (08:28 UTC the same day), which costs a page and its one transaction.
    const full = await checkDeployer(source, RUG_CONFIG, { ...CFG, creditCapPerCandidate: need + 2 }, req, 0);
    expect(full.fact.mints.map((m) => m.status)).toEqual(['rug', 'clear']);
    expect(full.fact.credits).toBe(need + 2);
    const short = await checkDeployer(fixtureSource([RUG, CLEAN]).source, RUG_CONFIG, { ...CFG, creditCapPerCandidate: need + 1 }, req, 0);
    expect(short.fact.mints.map((m) => [m.status, m.detail])).toEqual([['rug', expect.any(String)], ['unfetched', `credit cap ${need + 1} reached`]]);
    expect(short.fact.credits).toBeLessThanOrEqual(need + 1);
    const none = await checkDeployer(fixtureSource([RUG, CLEAN]).source, RUG_CONFIG, { ...CFG, creditCapPerCandidate: 1 }, req, 0);
    expect(none.fact.mints.map((m) => m.status)).toEqual(['unfetched', 'unfetched']);
    expect(calls()).toBe(need + 2);
  });

  it('once over the cap, no later mint is read, even one cheap enough for what is left', async () => {
    // Transactions cost 2: RUG stops on a transaction with 1 credit left, which would pay CLEAN's signature page.
    const src = { ...fixtureSource([RUG, CLEAN]).source, cost: { signatures: 1, transaction: 2 } };
    const req = { creator: DEV, mints: [launch(RUG), launch(CLEAN)], fromMs: 0, asOf: at(lastSlot(CLEAN) + 1_000_000n), asOfMs: launch(CLEAN).createdAtMs + DAY + 1 };
    const r = await checkDeployer(src, RUG_CONFIG, { ...CFG, creditCapPerCandidate: 4 }, req, 0);
    expect(r.fact.mints.map((m) => [m.status, m.detail])).toEqual([['unfetched', 'credit cap 4 reached'], ['unfetched', 'credit cap 4 reached']]);
    expect(r.fact.credits).toBe(3);
  });

  it('skips failed transactions, stops reading at the label, and reads nothing after the window or the as-of time', async () => {
    const real = [...RUG.transactions].reverse().map((t): SignatureInfo => ({ signature: t.signature, slot: BigInt(t.slot), err: null, blockTime: t.blockTime }));
    const dump = real[0]!;
    // Not in the source: a failed one before the dump, and a later one after it. Reading either would fail the mint.
    const failed: SignatureInfo = { signature: 'failedTx', slot: real[1]!.slot, err: { failed: true }, blockTime: real[1]!.blockTime };
    const later: SignatureInfo = { signature: 'laterTx', slot: dump.slot + 5n, err: null, blockTime: dump.blockTime! + 2 };
    const list = [later, dump, failed, ...real.slice(1)];
    const base = fixtureSource([RUG]).source;
    const source: RugHistorySource = { ...base, signatures: async () => list };
    const req = { creator: DEV, mints: [launch(RUG)], fromMs: 0, asOf: at(dump.slot + 10n), asOfMs: launch(RUG).createdAtMs + 200_000 };
    expect((await checkDeployer(source, RUG_CONFIG, CFG, req, 0)).fact.mints[0]!.status).toBe('rug');
    // As-of chain time before the dump: the dump is outside what may be read, so the mint is open.
    expect((await checkDeployer(source, RUG_CONFIG, CFG, { ...req, asOfMs: dump.blockTime! * 1_000 - 1 }, 0)).fact.mints[0]!.status).toBe('open');
  });

  it('a failing source leaves the mint unfetched, never throws', async () => {
    const r = await checkDeployer(fixtureSource([RUG], true).source, RUG_CONFIG, CFG, { creator: DEV, mints: [launch(RUG)], fromMs: 0, asOf: at(lastSlot(RUG) + 1n), asOfMs: 0 }, 0);
    expect(r.fact.mints).toEqual([expect.objectContaining({ status: 'unfetched', detail: 'rpc down' })]);
  });

  it('pages back through signatures until a page reaches past the launch', async () => {
    const pad = (k: number): SignatureInfo => ({ signature: `pad${k}`, slot: BigInt(RUG.transactions.at(-1)!.slot), err: { failed: true }, blockTime: RUG.transactions.at(-1)!.blockTime });
    const real = [...RUG.transactions].reverse().map((t): SignatureInfo => ({ signature: t.signature, slot: BigInt(t.slot), err: null, blockTime: t.blockTime }));
    const all = [...Array.from({ length: 1_000 }, (_, k) => pad(k)), ...real];
    const pages: (string | undefined)[] = [];
    const base = fixtureSource([RUG]).source;
    const source: RugHistorySource = { ...base, signatures: async (_a, before, limit) => {
      pages.push(before);
      const from = before === undefined ? 0 : all.findIndex((s) => s.signature === before) + 1;
      return all.slice(from, from + limit);
    } };
    const r = await checkDeployer(source, RUG_CONFIG, CFG, { creator: DEV, mints: [launch(RUG)], fromMs: 0, asOf: at(lastSlot(RUG) + 1n), asOfMs: launch(RUG).createdAtMs + 200_000 }, 0);
    expect(pages).toEqual([undefined, 'pad999']);
    expect(r.fact.mints[0]!.status).toBe('rug');
    // A full page that already reaches before the launch is the last one asked for.
    const early = [...Array.from({ length: 999 }, (_, k) => pad(k)), ...real.slice(0, 1).map((x) => ({ ...x, blockTime: RUG.transactions[0]!.blockTime - 1 }))];
    const asked: (string | undefined)[] = [];
    await checkDeployer({ ...base, signatures: async (_a, before) => (asked.push(before), before === undefined ? early : []) }, RUG_CONFIG, CFG,
      { creator: DEV, mints: [launch(RUG)], fromMs: 0, asOf: at(lastSlot(RUG) + 1n), asOfMs: launch(RUG).createdAtMs + 200_000 }, 0);
    expect(asked).toEqual([undefined]);
  });
});

describe('cached supplement (backtest)', () => {
  const record = async () => {
    const f = fixtureSource([RUG, CLEAN]);
    const rec = new SupplementRecorder(f.source, f.raw);
    const req = { creator: DEV, mints: [launch(RUG), launch(CLEAN)], fromMs: 0, asOf: at(lastSlot(CLEAN) + 1_000_000n), asOfMs: launch(CLEAN).createdAtMs + DAY + 1 };
    const live = await checkDeployer(rec.source, RUG_CONFIG, CFG, req, 5);
    return { live, req, sup: rec.build('https://api.mainnet-beta.solana.com', '2026-10-04T00:00:00Z') };
  };

  it('gives the same check as the live read, through the same code', async () => {
    const { live, req, sup } = await record();
    const cached = await checkDeployer(supplementSource(sup, sup.manifest.sha256), RUG_CONFIG, CFG, req, 5);
    expect(cached).toEqual(live);
  });

  it('pages its signature lists like the RPC: newest first, after `before`', async () => {
    const { sup } = await record();
    const src = supplementSource(sup, sup.manifest.sha256);
    const all = sup.signatures[RUG.mint]!;
    expect((await src.signatures(RUG.mint, undefined, 2)).map((x) => x.signature)).toEqual([all[0]!.signature, all[1]!.signature]);
    expect((await src.signatures(RUG.mint, all[1]!.signature, 1)).map((x) => x.signature)).toEqual([all[2]!.signature]);
    await expect(src.signatures(RUG.mint, 'nope', 1)).rejects.toThrow(/holds no signature nope/);
  });

  it('refuses a file whose content does not match its manifest, or that is not the expected one', async () => {
    const { sup } = await record();
    const [sig] = Object.keys(sup.transactions);
    const tampered: RugSupplement = { ...sup, transactions: { ...sup.transactions, [sig!]: { ...sup.transactions[sig!]!, slot: 1 } } };
    expect(() => supplementSource(tampered, sup.manifest.sha256)).toThrow(/does not match its manifest/);
    expect(() => supplementSource(sup, '0'.repeat(64))).toThrow(/is not the expected/);
  });

  it('a read the file does not hold leaves the mint unfetched', async () => {
    const { sup, req } = await record();
    const src = supplementSource(sup, sup.manifest.sha256);
    const r = await checkDeployer(src, RUG_CONFIG, CFG, { ...req, mints: [{ mint: 'NotInFile', createdAtMs: 0 }] }, 0);
    expect(r.fact.mints[0]).toMatchObject({ status: 'unfetched', detail: 'the supplement holds no signatures for NotInFile' });
    const [first] = Object.keys(sup.transactions);
    const holes: RugSupplement = { ...sup, transactions: Object.fromEntries(Object.entries(sup.transactions).filter(([k]) => k !== first)) };
    const fixed = { ...holes, manifest: { ...holes.manifest, sha256: '' } };
    const h = (await import('../src/providers/deployer-check.ts')).supplementHash(fixed);
    const r2 = await checkDeployer(supplementSource({ ...fixed, manifest: { ...fixed.manifest, sha256: h } }, h), RUG_CONFIG, CFG, req, 0);
    expect(r2.fact.mints.some((m) => m.status === 'unfetched' && m.detail.includes('is not available'))).toBe(true);
  });
});

describe('live source', () => {
  it('reads through RpcHttp and FEED-1\'s scheduler at the given priority; the scheduler and the fact count the same credits', async () => {
    const timers = new ManualTimers(1_000_000);
    const scheduler = new Scheduler(HELIUS_FREE, { timers });
    const sigs = [...RUG.transactions].reverse().map((t) => ({ signature: t.signature, slot: t.slot, err: null, blockTime: t.blockTime }));
    const seen: unknown[] = [];
    const http = scriptedHttp(rpcHandler((method, params) => {
      seen.push([method, params[1]]);
      if (method === 'getSignaturesForAddress') return sigs;
      const t = RUG.transactions.find((x) => x.signature === params[0]);
      return t === undefined ? null : { slot: t.slot, blockTime: t.blockTime, transaction: t.transaction, meta: t.meta };
    }));
    const rpc = new RpcHttp({ provider: 'helius', url: () => 'https://rpc.test/?api-key=k', http, scheduler, timeoutMs: 1_000 });
    const run = checkDeployer(rpcHistorySource(rpc, P2), RUG_CONFIG, CFG, { creator: DEV, mints: [launch(RUG)], fromMs: 0, asOf: at(lastSlot(RUG) + 1n), asOfMs: launch(RUG).createdAtMs + 200_000 }, 0);
    for (let k = 0; k < 50; k++) {
      await settle();
      timers.advance(200);
    }
    const r = await run;
    expect(r.fact.mints[0]!.status).toBe('rug');
    expect(scheduler.status().creditsUsed).toBe(r.fact.credits);
    expect(seen[0]).toEqual(['getSignaturesForAddress', { commitment: 'confirmed', limit: 1_000 }]);
    expect(seen.slice(1).every((x) => (x as [string, { commitment: string }])[1].commitment === 'confirmed')).toBe(true);
  });
});
