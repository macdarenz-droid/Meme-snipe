// FACTS-REREAD: a candidate whose stage-1 facts (migration, curve completion, candles, create) are missing has them read
// again, under its own daily budget in fetch-caps.json (never the fills' budget the boot seed can empty), with bounded
// retries. Fail-closed: the facts form only from the transactions put on the feed; a spent budget or spent retries keep
// the refusal. Real public mainnet transactions (test/fixtures/completion-read.json, as COMPLETION-READ's tests).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { recordFromRpc, type RpcTransactionBase64 } from '../../core/src/chain/index.ts';
import type { MarketEvent, StrategyContext } from '../../core/src/engine/index.ts';
import { evaluateHardRejects, migrationKey, type GateContext, type GateRequest, type HardResult } from '../../core/src/gates/index.ts';
import type { MicroUsd, Lamports } from '../../core/src/units/index.ts';
import { RESEARCH_CONFIG, RUG_CONFIG } from '../../core/src/config/index.ts';
import { COMPLETION_CREDITS, CUT_CREATE_RETRY_MS, REREAD_CREDITS_PER_DAY, REREAD_CURVE_READS, rereadRefund, reserveBudget, stage1Missing, type WorkerDeps } from '../src/run/worker.ts';
import type { CreateLookup } from '../src/run/sources.ts';
import { checkSession } from '../src/run/parity.ts';
import { replayLedgerFile } from '../../core/src/ledger/replay/index.ts';
import { fetchCapsFile } from '../src/run/state.ts';
import { type Harness, Market, makeWorker, tempState, virtualTimers } from './worker-harness.ts';
import { PUMP_MIGRATION_AUTHORITY as MIGRATION_AUTHORITY } from '../src/run/sources.ts';

interface Fixture {
  readonly meta: { readonly mint: string; readonly bondingCurve: string };
  readonly migration: { readonly signature: string; readonly rpc: RpcTransactionBase64 };
  readonly curveSignaturesBeforeMigration: readonly { readonly signature: string; readonly slot: number; readonly err: unknown; readonly blockTime: number | null }[];
  readonly complete: { readonly signature: string; readonly rpc: RpcTransactionBase64 };
}
const FIX = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'completion-read.json'), 'utf8')) as Fixture;
const migrate = recordFromRpc(FIX.migration.signature, FIX.migration.rpc);
const complete = recordFromRpc(FIX.complete.signature, FIX.complete.rpc);
const MINT = FIX.meta.mint;
const CURVE = FIX.meta.bondingCurve;
const AT = (migrate.blockTime ?? 0) * 1000;
const DAY_MS = 86_400_000;
const slotFor = (ms: number): bigint => migrate.slot + BigInt(Math.floor((ms - AT) / 400));

let port = 19_600;

type Rpc = { getSignaturesForAddress: (a: string, o: { before?: string; limit?: number }) => Promise<unknown[]>; getTransaction: (s: string) => Promise<unknown> };

let session: Parameters<typeof evaluateHardRejects>[1]['session'] | null = null;
/** H7 and H10 (the migration fact's two readers), as of an event's moment, from the facts the worker's engine sees. */
const judge = (ctx: StrategyContext): HardResult => {
  const req = { mint: MINT, universe: 'U2', notional: 1_000_000n as MicroUsd, spend: 1_000_000n as Lamports, roundTrip: { ok: false, reason: 'not read' } } as unknown as GateRequest;
  return evaluateHardRejects(ctx as unknown as GateContext, { session: session!, mode: 'live' }, req, { only: ['H7', 'H10'], stopAtFirst: false });
};
const missingMigration = (r: HardResult) => r.reasons.some((x) => x.gate === 'H16' && x.code === 'missing' && (x.input === 'curve' || x.input === 'migration'));

/**
 * The curve as mainnet answers after the migration: its newest signatures are the migration, then the completing buy
 * (COMPLETION-READ's fixture, before the migration). `fail` makes the first n reads of the curve throw.
 */
const curveRpc = (fail = 0) => {
  const asked: string[] = [];
  let failures = fail;
  const rpc: Rpc = {
    getSignaturesForAddress: async (address, o) => {
      asked.push(`sigs ${address}${o.before === undefined ? '' : ` before ${o.before}`}`);
      if (address === CURVE && o.before === undefined) {
        if (failures > 0) {
          failures--;
          throw new Error('timeout');
        }
        return [{ signature: migrate.signature, slot: migrate.slot, err: null, blockTime: migrate.blockTime }, ...FIX.curveSignaturesBeforeMigration.map((x) => ({ ...x, slot: BigInt(x.slot) }))];
      }
      return address === CURVE && o.before === migrate.signature ? FIX.curveSignaturesBeforeMigration.map((x) => ({ ...x, slot: BigInt(x.slot) })) : [];
    },
    getTransaction: async (sig) => {
      asked.push(`tx ${sig}`);
      return sig === complete.signature ? complete : sig === migrate.signature ? migrate : null;
    },
  };
  return { asked, rpc };
};

/**
 * A live worker whose fills' budget is spent (so COMPLETION-READ skips the completion): the migration arrives as the
 * migration watch's fetch puts it on the feed, then the run goes into the candidate's window. `reread` is what
 * fetch-caps.json holds for today when it starts (null: no file).
 */
const run = async (rpc: Rpc, o: { readonly reread?: number | null; readonly stateDir?: string; readonly window?: boolean; readonly logsOnly?: boolean; readonly timers?: ReturnType<typeof virtualTimers>; readonly noMigration?: boolean; readonly runMs?: number; readonly findCreate?: WorkerDeps['findCreate']; readonly fill?: number; readonly found?: (sig: string, why: string, h: Harness) => boolean; readonly after?: (h: Harness, m: Market, tick: () => void) => Promise<void> } = {}) => {
  let left = o.fill ?? COMPLETION_CREDITS - 1;
  const budget = { remaining: () => left, spend: (c: number) => { left -= c; }, refund: (c: number) => { left += c; } };
  const timers = o.timers ?? virtualTimers(AT - 30_000);
  const stateDir = o.stateDir ?? tempState();
  if (o.reread !== undefined && o.reread !== null) fetchCapsFile(stateDir).write({ day: Math.floor(timers.now() / DAY_MS), cutCreate: 0, cutTrade: 0, reread: o.reread });
  let ref: Harness | null = null;
  const h = makeWorker({ ...(o.found === undefined ? {} : { found: (sig: string, why: string) => o.found!(sig, why, ref!) }), stateDir, timers, config: { ZEROED_HEALTH_ADDR: `127.0.0.1:${port++}`, ZEROED_API_ADDR: `127.0.0.1:${port++}` }, restartReads: { rpc: rpc as never, budget }, ...(o.findCreate === undefined ? {} : { findCreate: o.findCreate }) });
  ref = h;
  session = h.session;
  const judged: { readonly at: number; readonly migration: boolean; readonly r: HardResult }[] = [];
  const s = h.worker.strategy as unknown as { onMarket: (e: MarketEvent, ctx: StrategyContext) => unknown };
  const onMarket = s.onMarket.bind(s);
  s.onMarket = (e, ctx) => {
    judged.push({ at: ctx.now.receivedAt, migration: ctx.lookup(migrationKey(MINT)).ok, r: judge(ctx) });
    return onMarket(e, ctx);
  };
  const m = new Market(h);
  const tick = () => {
    m.slot(slotFor(m.now));
    m.solPrice();
  };
  const started = h.worker.start();
  while (!h.order.includes('start helius-ws')) await new Promise<void>((r) => setImmediate(r));
  tick();
  m.offchain('coverage:creates:start', { fromSlot: slotFor(m.now), via: 'logs:TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM' });
  expect(await started).toEqual({ ok: true });
  m.offchain('feed:status:helius', { state: 'up' });
  m.offchain('feed:status:coinbase', { state: 'up' });
  await m.run(20_000, 400, tick);
  if (o.noMigration === true) {
    // A restarted process: the migration came before it; only what the restore brings back.
  } else if (o.logsOnly === true) {
    // The migration watch's log line at processed, and its fetch of the transaction failed (solana-ws: fetch_failed):
    // the strategy has a candidate, the producer has nothing at confirmed to make its facts from.
    h.worker.feed.ingest('helius', { type: 'logs', signature: migrate.signature, slot: migrate.slot, err: null, via: `logs:${MIGRATION_AUTHORITY}`, logs: [...migrate.logMessages!] }, { receivedAt: m.now });
    await m.run(2_000, 400, tick);
    h.worker.feed.ingest('worker', { type: 'offchain', key: 'feed:status:helius', value: { state: 'fetch_failed', signature: migrate.signature } }, { receivedAt: m.now });
  } else {
    h.worker.feed.ingest('helius', { type: 'tx', record: migrate }, { receivedAt: m.now, lookup: true });
  }
  await m.run(20_000, 400, tick);
  if (o.runMs !== undefined) await m.run(o.runMs, 5_000, tick);
  else if (o.window !== false) await m.run(RESEARCH_CONFIG.s0.u2WindowFromMs + 40 * 60_000, 5_000, tick);
  if (o.after !== undefined) await o.after(h, m, tick);
  const last = judged.at(-1)!;
  await h.worker.stop();
  let caps: { readonly reread?: number } = {};
  try {
    caps = fetchCapsFile(stateDir).read({ day: -1, cutCreate: 0, cutTrade: 0, reread: 0 });
  } catch {
    // A file the test made unreadable, left as it was.
  }
  const rereads = readFileSync(join(stateDir, 'journal.jsonl'), 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l['kind'] === 'facts_reread');
  return { h, judged, last, fillLeft: () => left, caps, rereads };
};

const curveReads = (asked: readonly string[]) => asked.filter((a) => a === `sigs ${CURVE}`).length;

describe('FACTS-REREAD: a candidate missing its migration fact has it read again under its own budget', () => {
  it('reads the stage-1 inputs a reject names as H16 missing, and nothing else', () => {
    const line = (gates: unknown) => ['reject', 'U2', MINT, 'hard reject', `gate_reasons ${JSON.stringify(gates)}`];
    expect(stage1Missing(line([
      { gate: 'H16', code: 'missing', input: 'curve', neededBy: 'H7', detail: 'x' },
      { gate: 'H16', code: 'missing', input: 'create', neededBy: 'H9', detail: 'x' },
      { gate: 'H16', code: 'missing', input: 'migration', neededBy: 'H10', detail: 'x' },
      { gate: 'H16', code: 'missing', input: 'candles', neededBy: 'H11', detail: 'x' },
      { gate: 'H16', code: 'missing', input: 'mint', neededBy: 'H1', detail: 'x' },
      { gate: 'H16', code: 'gap', input: 'stream', neededBy: 'H11', detail: 'x' },
      { gate: 'H16', code: 'stale', input: 'migration', neededBy: 'H10', detail: 'x' },
      { gate: 'H9', code: 'missing', input: 'create', detail: 'x' },
    ]))).toEqual(['candles', 'create', 'curve', 'migration']);
    expect(stage1Missing(['reject', 'U2', MINT, 'regime off'])).toEqual([]);
    expect(stage1Missing(['reject', 'U2', MINT, 'x', 'gate_reasons not json'])).toEqual([]);
  });

  it('the fills\' budget spent: the curve is read under the re-read budget, the migration fact forms, and H7 and H10 pass', async () => {
    const { asked, rpc } = curveRpc();
    const r = await run(rpc, { reread: null });
    // COMPLETION-READ skipped for want of the fills' budget; that budget is never touched by the re-read.
    expect(r.h.logs).toContain(`Curve completion of ${MINT} not read: the fill budget is spent; H7 waits for it.`);
    expect(r.fillLeft()).toBe(COMPLETION_CREDITS - 1);
    expect(asked).toEqual([`sigs ${CURVE}`, `tx ${migrate.signature}`, `tx ${complete.signature}`]);
    // Charged to fetch-caps.json: the migration asked by its signature (1), the page and the two transactions read (3);
    // the rest of the reserve given back.
    expect(r.caps.reread).toBe(4);
    expect(r.rereads).toEqual([expect.objectContaining({ mint: MINT, try: 1, why: 'fill-budget', needs: ['curve'], landed: true })]);
    const first = r.judged.findIndex((j) => j.migration);
    expect(first).toBeGreaterThan(-1);
    expect(r.judged.slice(0, first).some((j) => missingMigration(j.r))).toBe(true);
    // From then on never missing again; H10's own timing rule (excluded-window) holds it until the window opens, and in
    // the window both pass.
    for (const j of r.judged.slice(first)) expect(missingMigration(j.r)).toBe(false);
    const inWindow = r.judged.filter((j) => j.at >= AT + RESEARCH_CONFIG.s0.u2WindowFromMs);
    expect(inWindow.length).toBeGreaterThan(0);
    for (const j of inWindow) expect(j.r).toEqual(expect.objectContaining({ passed: ['H7', 'H10'], failed: [], reasons: [] }));
    // Parity (TEST-1): the session, the re-read's transactions included, replays ten times to the live decisions.
    const p = checkSession(r.h.stateDir, { session: r.h.session, rugs: RUG_CONFIG, strategy: r.h.worker.strategyConfig }, replayLedgerFile, 10);
    expect(p.boots.map((b) => [b.replays, b.deterministic, b.divergence])).toEqual([[10, true, null]]);
    expect(p.boots[0]!.decisions).toBeGreaterThan(1);
    expect(p.ok).toBe(true);
  }, 60_000);

  it('(b) the migration watch\'s fetch failed: the candidate\'s migration is asked for again, the curve brings it, H7 and H10 pass', async () => {
    const { asked, rpc } = curveRpc();
    const r = await run(rpc, { reread: null, logsOnly: true });
    // No completion read (it keys on the fetched transaction); the failed fetch's status asked for the re-read.
    expect(asked.filter((a) => a.includes('before'))).toEqual([]);
    expect(r.rereads[0]).toEqual(expect.objectContaining({ mint: MINT, try: 1, why: 'fetch-failed', needs: ['migration'], landed: true }));
    expect(asked).toEqual([`sigs ${CURVE}`, `tx ${migrate.signature}`, `tx ${complete.signature}`]);
    const first = r.judged.findIndex((j) => j.migration);
    expect(first).toBeGreaterThan(-1);
    expect(r.judged.slice(0, first).some((j) => missingMigration(j.r))).toBe(true);
    expect(r.last.r).toEqual(expect.objectContaining({ passed: ['H7', 'H10'], failed: [], reasons: [] }));
  }, 60_000);

  it('(a) a restored candidate whose one re-fetch failed is read again at boot, before its window, and passes H7 and H10', async () => {
    const stateDir = tempState();
    const timers = virtualTimers(AT - 30_000);
    // The first process: no re-read budget left, so the coin is saved a candidate without its migration fact.
    const first = await run(curveRpc().rpc, { stateDir, timers, reread: REREAD_CREDITS_PER_DAY, window: false, runMs: 60_000 });
    expect(first.judged.some((j) => j.migration)).toBe(false);
    // The second process, a minute later, the same day, with the budget back (as at a new UTC day): the restore's one
    // re-fetch of the migration fails (the harness's fetch finds nothing), and the re-read brings it.
    fetchCapsFile(stateDir).write({ day: Math.floor(timers.now() / DAY_MS), cutCreate: 0, cutTrade: 0, reread: 0 });
    const { asked, rpc } = curveRpc();
    const second = await run(rpc, { stateDir, timers, noMigration: true, window: false, runMs: 60_000 });
    expect(second.h.logs.some((l) => l.startsWith('Saved state restored'))).toBe(true);
    // The journal holds both processes: the second one's re-read is the one asked because of the restore.
    expect(second.rereads.find((x) => x['why'] === 'restored')).toEqual(expect.objectContaining({ mint: MINT, try: 1, landed: true }));
    expect(asked.slice(0, 3)).toEqual([`sigs ${CURVE}`, `tx ${migrate.signature}`, `tx ${complete.signature}`]);
    // Before its window opened: no refusal was needed to ask.
    const formed = second.judged.find((j) => j.migration);
    expect(formed).toBeDefined();
    expect(formed!.at).toBeLessThan(AT + RESEARCH_CONFIG.s0.u2WindowFromMs);
    expect(second.last.r.reasons.some((x) => x.code === 'missing')).toBe(false);
  }, 120_000);

  it('a failed re-read is tried again after its wait, and lands', async () => {
    const { asked, rpc } = curveRpc(1);
    const r = await run(rpc, { reread: null });
    expect(curveReads(asked)).toBe(2);
    expect(r.rereads.map((x) => [x['try'], x['landed']])).toEqual([[1, false], [2, true]]);
    const first = r.judged.findIndex((j) => j.migration);
    expect(first).toBeGreaterThan(-1);
    // The second try came after the first wait: never ahead of it.
    const failedAt = r.judged.find((j) => !j.migration)!.at;
    expect(r.judged[first]!.at - failedAt).toBeGreaterThanOrEqual(CUT_CREATE_RETRY_MS[0]!);
    expect(missingMigration(r.last.r)).toBe(false);
  }, 60_000);

  it('fails closed: every try failing keeps the refusal, after 5 tries no more are made', async () => {
    const { asked, rpc } = curveRpc(99);
    const r = await run(rpc, { reread: null });
    expect(curveReads(asked)).toBe(CUT_CREATE_RETRY_MS.length + 1);
    expect(r.rereads.every((x) => x['landed'] === false)).toBe(true);
    expect(r.judged.some((j) => j.migration)).toBe(false);
    expect(missingMigration(r.last.r)).toBe(true);
    expect(r.h.logs).toContain(`Candidate ${MINT}: its stage-1 facts were not read again in ${CUT_CREATE_RETRY_MS.length + 1} tries; its refusal stands.`);
  }, 60_000);

  it('the day\'s re-read budget spent (as fetch-caps.json says at boot): nothing is read and the refusal stands', async () => {
    const { asked, rpc } = curveRpc();
    const r = await run(rpc, { reread: REREAD_CREDITS_PER_DAY - 2 });
    // A try needs its migration ask, a page and REREAD_CURVE_READS transactions: 2 credits left pay for none of it.
    expect(curveReads(asked)).toBe(0);
    expect(r.judged.some((j) => j.migration)).toBe(false);
    expect(missingMigration(r.last.r)).toBe(true);
    expect(r.caps.reread).toBe(REREAD_CREDITS_PER_DAY - 2);
  }, 60_000);

  it('a fetch-caps.json that cannot be read counts the day as spent: nothing is read', async () => {
    const { asked, rpc } = curveRpc();
    const stateDir = tempState();
    writeFileSync(join(stateDir, 'fetch-caps.json'), 'not json\n');
    const r = await run(rpc, { stateDir });
    expect(curveReads(asked)).toBe(0);
    expect(missingMigration(r.last.r)).toBe(true);
    expect(r.h.logs.some((l) => l.includes('fetch-caps.json cannot be read'))).toBe(true);
  }, 60_000);
  it('a need that arrives after the chain landed starts a new chain for just that need, inside the same tries and budget', async () => {
    const { asked, rpc } = curveRpc();
    const stateDir = tempState();
    const landedCurve = () => readFileSync(join(stateDir, 'journal.jsonl'), 'utf8').includes('"kind":"facts_reread"');
    const calls: string[] = [];
    const none = (mint: string, stopped_by: CreateLookup['stopped_by']): CreateLookup => ({ mint, found: false, signature: null, slot: null, pages: 0, credits: 0, stopped_by, latency_ms: 0 });
    // The fills' lookup answers only once the curve re-read has landed, and finds the fills' budget spent; the re-read's
    // lookups find nothing, so the create stays missing.
    const findCreate = async (mint: string, b?: unknown): Promise<CreateLookup> => {
      calls.push(b === undefined ? 'fills' : 'reread');
      if (b !== undefined) return none(mint, 'not-found');
      while (!landedCurve()) await new Promise<void>((r) => setImmediate(r));
      return none(mint, 'skipped-no-budget');
    };
    const r = await run(rpc, { reread: null, stateDir, findCreate });
    expect(r.rereads[0]).toEqual(expect.objectContaining({ try: 1, why: 'fill-budget', needs: ['curve'], landed: true }));
    // The create's chain: its own needs only, the tries counted on from the curve's (5 in all), never the curve again.
    expect(r.rereads.slice(1).map((x) => [x['try'], x['needs'], x['landed']])).toEqual([2, 3, 4, 5].map((t) => [t, ['create'], false]));
    expect(calls).toEqual(['fills', 'reread', 'reread', 'reread', 'reread']);
    expect(curveReads(asked)).toBe(1);
    expect(r.h.logs).toContain(`Candidate ${MINT}: its stage-1 facts were not read again in ${CUT_CREATE_RETRY_MS.length + 1} tries; its refusal stands.`);
  }, 60_000);

  it('a try that finds the migration without its completion has not landed: it is asked again, without reading the migration twice', async () => {
    // The first try lands the migration only (its completion cannot be read yet); the second reads the curve for the
    // completion alone.
    const { asked: asked2, rpc: rpc2 } = curveRpc();
    let first = true;
    const get2 = rpc2.getTransaction;
    rpc2.getTransaction = async (sig) => (first && sig === complete.signature ? ((first = false), asked2.push(`tx ${sig}`), null) : get2(sig));
    const t = await run(rpc2, { reread: null });
    expect(t.rereads.map((x) => [x['try'], x['landed']])).toEqual([[1, false], [2, true]]);
    // The first try reads on past the completion it cannot get; the second skips the migration it already has.
    const second = asked2.lastIndexOf(`sigs ${CURVE}`);
    expect(asked2.slice(0, 3)).toEqual([`sigs ${CURVE}`, `tx ${migrate.signature}`, `tx ${complete.signature}`]);
    expect(asked2.slice(second)).toEqual([`sigs ${CURVE}`, `tx ${complete.signature}`]);
    expect(asked2.filter((a) => a === `tx ${migrate.signature}`)).toHaveLength(1);
    expect(missingMigration(t.last.r)).toBe(false);
  }, 120_000);

  it('the budget edge: a try that needs exactly what is left is made and spends no more than the cap; one credit less makes none', async () => {
    // Fill-budget case: the migration's signature is known (1), then a page and REREAD_CURVE_READS transactions.
    const cost = 1 + 1 + REREAD_CURVE_READS;
    const { asked, rpc } = curveRpc();
    const at = await run(rpc, { reread: REREAD_CREDITS_PER_DAY - cost, window: false, runMs: 60_000 });
    expect(curveReads(asked)).toBe(1);
    expect(at.rereads[0]).toEqual(expect.objectContaining({ try: 1, landed: true }));
    // Charged what was used: the signature ask, the page and two transactions.
    expect(at.caps.reread).toBe(REREAD_CREDITS_PER_DAY - cost + 4);
    const less = curveRpc();
    const under = await run(less.rpc, { reread: REREAD_CREDITS_PER_DAY - cost + 1, window: false, runMs: 60_000 });
    expect(curveReads(less.asked)).toBe(0);
    expect(less.asked).toEqual([]);
    expect(under.rereads).toEqual([expect.objectContaining({ try: 1, landed: false, budget: 'spent' })]);
    expect(under.caps.reread).toBe(REREAD_CREDITS_PER_DAY - cost + 1);
  }, 60_000);

  it('a chain stopped by a spent budget resumes on the next UTC day, in the same process, and lands', async () => {
    const { asked, rpc } = curveRpc();
    const r = await run(rpc, {
      reread: REREAD_CREDITS_PER_DAY, window: false, runMs: 60_000,
      after: async (h) => {
        expect(curveReads(asked)).toBe(0);
        // A later step the same day does not resume it.
        h.worker.step();
        for (let k = 0; k < 20; k++) await new Promise<void>((res) => setImmediate(res));
        expect(curveReads(asked)).toBe(0);
        // The UTC day rolls over (the candidate still one): the next step resumes the chain under the new day's budget.
        h.timers.set((Math.floor(h.timers.now() / DAY_MS) + 1) * DAY_MS + 1_000);
        h.worker.step();
        for (let k = 0; k < 20; k++) await new Promise<void>((res) => setImmediate(res));
      },
    });
    expect(curveReads(asked)).toBe(1);
    expect(r.rereads.map((x) => [x['try'], x['landed'], x['budget'] ?? null])).toEqual([[1, false, 'spent'], [1, true, null]]);
    // The new day's count holds this try alone.
    expect(r.caps.reread).toBe(4);
  }, 60_000);
  it('the re-read\'s own migration does not start a second curve read from the fills\' budget while its chain reads the curve', async () => {
    const { asked, rpc } = curveRpc();
    let first = true;
    const get = rpc.getTransaction;
    rpc.getTransaction = async (sig) => (first && sig === complete.signature ? ((first = false), asked.push(`tx ${sig}`), null) : get(sig));
    // The fills' budget has room: only the running re-read keeps COMPLETION-READ from reading the curve as well.
    const r = await run(rpc, { reread: null, logsOnly: true, fill: 10 * COMPLETION_CREDITS });
    expect(r.rereads.map((x) => [x['try'], x['landed']])).toEqual([[1, false], [2, true]]);
    expect(asked.filter((a) => a.includes('before'))).toEqual([]);
    expect(r.fillLeft()).toBe(10 * COMPLETION_CREDITS);
    expect(missingMigration(r.last.r)).toBe(false);
  }, 60_000);
  it('once the completion is on the feed, a later try fetches the migration by its signature alone and reads no curve', async () => {
    const { asked, rpc } = curveRpc();
    let hidden = true;
    const get = rpc.getTransaction;
    // The curve's newest transactions give the completion, not the migration (not readable yet); its signature fetch
    // fails the first time and finds it the second, putting it on the feed as the fetcher does.
    rpc.getTransaction = async (sig) => (hidden && sig === migrate.signature ? ((hidden = false), asked.push(`tx ${sig}`), null) : get(sig));
    let asks = 0;
    const found = (sig: string, why: string, h: Harness): boolean => {
      if (why !== 'reread' || sig !== migrate.signature || ++asks < 2) return false;
      h.worker.feed.ingest('helius', { type: 'tx', record: migrate }, { receivedAt: h.timers.now(), backfilled: true, lookup: true });
      return true;
    };
    const r = await run(rpc, { reread: null, found });
    expect(r.rereads.map((x) => [x['try'], x['landed']])).toEqual([[1, false], [2, true]]);
    expect(curveReads(asked)).toBe(1);
    expect(asks).toBe(2);
    expect(missingMigration(r.last.r)).toBe(false);
  }, 60_000);
  it.each([
    [CUT_CREATE_RETRY_MS.length, ['fills']],
    [CUT_CREATE_RETRY_MS.length - 1, ['fills', 'reread']],
  ])('the try cap holds across chains: a chain landing after %i failed tries, then a later need', async (failed, lookups) => {
    // The curve read fails `failed` times, then lands; only then does the fills' lookup answer, skipped. Landing on the
    // fifth try leaves the create unread (5 tries in all); landing on the fourth leaves it one try.
    const { asked, rpc } = curveRpc(failed);
    const stateDir = tempState();
    const landed = () => readFileSync(join(stateDir, 'journal.jsonl'), 'utf8').includes('"landed":true');
    const calls: string[] = [];
    const findCreate = async (mint: string, b?: unknown): Promise<CreateLookup> => {
      calls.push(b === undefined ? 'fills' : 'reread');
      while (b === undefined && !landed()) await new Promise<void>((r) => setImmediate(r));
      return { mint, found: false, signature: null, slot: null, pages: 0, credits: 0, stopped_by: b === undefined ? 'skipped-no-budget' : 'not-found', latency_ms: 0 };
    };
    const r = await run(rpc, { reread: null, stateDir, findCreate });
    expect(curveReads(asked)).toBe(failed + 1);
    expect(r.rereads.slice(0, failed + 1).map((x) => x['landed'])).toEqual([...Array(failed).fill(false), true]);
    expect(r.rereads.slice(failed + 1).map((x) => [x['try'], x['needs']])).toEqual(lookups.length === 1 ? [] : [[CUT_CREATE_RETRY_MS.length + 1, ['create']]]);
    expect(calls).toEqual(lookups);
  }, 60_000);

  it('a refund is given back only to the day its reserve was taken on', () => {
    expect(rereadRefund({ day: 10, reread: 20 }, 8, 10)).toBe(12);
    expect(rereadRefund({ day: 10, reread: 5 }, 8, 10)).toBe(0);
    // Taken before midnight, refunded after: the new day's count keeps what the new day spent.
    expect(rereadRefund({ day: 11, reread: 20 }, 8, 10)).toBe(20);
    expect(rereadRefund({ day: 11, reread: 20 }, 0, 11)).toBe(20);
    expect(rereadRefund({ day: 11, reread: 20 }, 8, -1)).toBe(20);
    // A reserve refunds to the day its take was counted on, whatever the day is when it refunds.
    const refunds: [number, number][] = [];
    let day = 10;
    const b = reserveBudget({ remaining: () => 99, take: () => day, refund: (n, d) => refunds.push([n, d]) });
    b.spend(8);
    day = 11;
    b.refund(4);
    expect(refunds).toEqual([[4, 10]]);
    expect(() => reserveBudget({ remaining: () => 0, take: () => null, refund: () => undefined }).spend(1)).toThrow('spent');
  });

  it('a COMPLETION-READ that stood aside is made once its chain is spent without the completion, from the fills\' budget', async () => {
    const { asked, rpc } = curveRpc();
    let fails = CUT_CREATE_RETRY_MS.length + 1;
    const get = rpc.getTransaction;
    // The completion cannot be read during the chain's five tries; it can afterwards.
    rpc.getTransaction = async (sig) => (sig === complete.signature && fails-- > 0 ? (asked.push(`tx ${sig}`), null) : get(sig));
    const r = await run(rpc, { reread: null, logsOnly: true, fill: 10 * COMPLETION_CREDITS });
    expect(r.rereads.map((x) => x['landed'])).toEqual([false, false, false, false, false]);
    // After the last try, COMPLETION-READ reads the curve before the migration once, from the fills' budget.
    const before = asked.findIndex((a) => a.includes('before'));
    expect(before).toBeGreaterThan(asked.lastIndexOf(`sigs ${CURVE}`));
    expect(asked.filter((a) => a.includes('before'))).toHaveLength(1);
    expect(r.fillLeft()).toBeLessThan(10 * COMPLETION_CREDITS);
    expect(missingMigration(r.last.r)).toBe(false);
  }, 60_000);
});
