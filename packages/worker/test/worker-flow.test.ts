// WORKER-1 end to end on a scripted market: gates, risk, the ledger reservation, TEST-2's simulation, the paper fill,
// the exit engine, the journal the runner checks and the ledger the replay check reads; then a restart drill mid-trade.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { replayLedgerFile } from '../../core/src/ledger/replay/index.ts';
import { isTerminal } from '../../core/src/lifecycle/index.ts';
import { openLedgerReader } from '../../core/src/ledger/index.ts';
import { checkJournal } from '../../runner/src/journal.ts';
import type { LogRecord } from '../../core/src/engine/index.ts';
import { EXEC_HEALTH_KEY, migrationKey } from '../../core/src/gates/index.ts';
import { passingFacts } from '../../core/test/gates/world.ts';
import { parseHeartbeat } from '../../ops/src/watchdog/logic.ts';
import { HALT_KEY, SEEDING, s0EntryAt, universeOfKey } from '../src/engine/strategy.ts';
import { FILL_CONFIG, PRICE_SCALE, TRIAL_POLICY } from '../../core/src/config/index.ts';
import type { SavedExit } from '../src/engine/strategy.ts';
import { type MicroUsd, microUsdToLamports } from '../../core/src/units/index.ts';
import { oneTimeRent } from '../src/run/settings.ts';
import { views } from '../src/run/api.ts';
import { runSeed } from '../src/run/seed-start.ts';
import { exitsFile, seedsFile } from '../src/run/state.ts';
import type { SignatureInfo } from '../src/providers/solana-http.ts';
import type { SeedRequest } from '../src/run/worker.ts';
import type { SeedRpc } from '../src/seed/rpc.ts';
import type { SimLeg } from '../src/run/paper-world.ts';
import { DEV, LANDS, MIGRATED_AT, MINT, Market, POOL_ADDRESS, SOL_PRICE, SUPPLY, T, dueTimers, makeWorker, okSimulation, passingMarket, slotAt, tempState, until, virtualTimers } from './worker-harness.ts';

/** Test-only (POS-1): these tests move a held position's price by re-publishing the pool fact. */
const HELD = { heldPoolFacts: true } as const;

const journalText = (dir: string) => readFileSync(join(dir, 'journal.jsonl'), 'utf8');
const lines = (dir: string) => journalText(dir).trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
const kinds = (dir: string, kind: string) => lines(dir).filter((l) => l['kind'] === kind);
const positions = (h: ReturnType<typeof makeWorker>) => Object.values(h.worker.book.positions);

/** Enters at T (the passing market), then lets the entry land. */
const entered = async (h: ReturnType<typeof makeWorker>) => {
  const r = await h.worker.reconcile();
  expect(r).toEqual({ ok: true });
  const m = await passingMarket(h, HELD);
  await m.run(4_000, 100, () => m.pool());
  await m.run(10_000, 400, () => {
    m.slot();
    m.pool();
  });
  return m;
};

describe('a paper trade end to end', () => {
  it('enters through gates, risk and a ledger reservation, simulates each leg first, and exits on the stop', async () => {
    const h = makeWorker();
    const m = await entered(h);
    const open = positions(h).find((p) => p.status === 'open');
    expect(open?.mint).toBe(MINT);
    // The price falls 30%: the price stop fires and the paper exit lands.
    await m.run(6_000, 400, () => {
      m.slot();
      m.pool(700_000n);
    });
    expect(h.worker.book.positions[open!.id]!.status).toBe('closed');

    // The journal is what the runner scores: complete, every fill after its own simulation line.
    const report = checkJournal(journalText(h.stateDir));
    expect(report.problems).toEqual([]);
    expect(report.complete).toBe(true);
    expect(report.entries).toBeGreaterThanOrEqual(1);
    expect(report.exits).toBeGreaterThanOrEqual(1);
    const sims = kinds(h.stateDir, 'simulation');
    expect(sims.map((s) => s['leg'])).toEqual(expect.arrayContaining(['entry', 'exit']));
    for (const s of sims) {
      // TEST-2's DryRunRecord fields, bigints as decimal strings (RUN-1b scores these lines).
      expect(s).toMatchObject({ outcome: 'simulated', success: true, error: null, standIn: null, amountErrorE4: 0, balancesFrom: 'simulation' });
      for (const k of ['quotedOut', 'simulatedOut', 'quoteAgeSlots', 'rentDeclared', 'rentPaid']) expect(s[k], k).toMatch(/^\d+$/);
    }
    expect(h.legs.map((l) => l.leg)).toEqual(sims.map((s) => s['leg']));
    // The entry's decision chain carries its reasons onto the entry line; the exit line names the stop.
    const entry = kinds(h.stateDir, 'entry')[0]!;
    expect(entry['reasons']).toEqual(expect.arrayContaining(['entry filled (paper)', 'enter', 'U2', MINT]));
    expect(kinds(h.stateDir, 'exit')[0]!['reasons']).toEqual(expect.arrayContaining(['exit filled (paper)', 'stop']));
    // The ledger holds what the engine did: the replay check reproduces it, and nothing is left open.
    await h.worker.stop();
    expect(replayLedgerFile(join(h.stateDir, 'ledger.sqlite'))).toMatchObject({ ok: true, purpose: 'paper' });
    expect(readFileSync(join(h.stateDir, 'open_intents'), 'utf8')).toBe('0\n');
    expect(existsSync(join(h.stateDir, 'clean_stop'))).toBe(true);
    expect(h.worker.desk.illegal).toBe(0);
    expect(h.worker.desk.ledgerRefusals).toBe(0);
    const account = JSON.parse(readFileSync(join(h.stateDir, 'account.json'), 'utf8')) as { trades: { closedAtMs: number | null; stoppedOut: boolean }[] };
    expect(account.trades.some((t) => t.closedAtMs !== null && t.stoppedOut)).toBe(true);
  });

  it('makes no entry while no edge is proven (edge 0: risk refuses every entry)', async () => {
    const h = makeWorker({ edgePpm: 0n });
    await entered(h);
    expect(positions(h)).toEqual([]);
    expect(kinds(h.stateDir, 'decision').some((d) => String((d['reasons'] as string[])[3]).startsWith('risk '))).toBe(true);
    await h.worker.stop();
  });

  it('an attempt that lands failed is abandoned and its reservation released', async () => {
    // Never dropped: with landing off, a drop draw would leave nothing to abandon.
    const h = makeWorker({ scenario: { ...LANDS, landPpm: { pumpswap: 0n, 'pump-curve': 0n }, dropPpm: 0n } });
    const m = await entered(h);
    expect(positions(h).every((p) => p.quantity === 0n && p.status !== 'open')).toBe(true);
    const abandoned = () => kinds(h.stateDir, 'decision').filter((d) => d['action'] === 'abandon');
    expect(await until(m, 60_000, () => abandoned().length >= 1, () => {
      m.slot();
      m.pool();
    })).toBe(true);
    // An entry that ended without a fill has its saved decision seed dropped; only entries still live keep theirs (EXIT-1h).
    await m.run(400, 400, () => m.slot());
    const kept = Object.keys(seedsFile(h.stateDir).read({}));
    const live = Object.values(h.worker.book.intents).filter((i) => i.intent.purpose === 'entry' && !isTerminal(i)).map((i) => String(i.intent.id));
    expect(abandoned().length).toBeGreaterThan(0);
    for (const a of abandoned()) expect(kept).not.toContain(String(a['intent']));
    expect(kept.sort()).toEqual(live.sort());
    await h.worker.stop();
    expect(replayLedgerFile(join(h.stateDir, 'ledger.sqlite'))).toMatchObject({ ok: true });
  });
});

describe('S0, the random-entry control (shakedown mode, supervisor ruling 2026-10-04)', () => {
  // The passing market's candidate migrated 90 min before T; U2's window is 60 to 240 min after, and it enters at T.
  const from = MIGRATED_AT + 60 * 60_000;
  const to = MIGRATED_AT + 240 * 60_000;
  const saltWhere = (ok: (at: number) => boolean) => {
    for (let k = 0; ; k++) if (ok(s0EntryAt(`salt-${k}`, MINT, from, to))) return `salt-${k}`;
  };

  it('enters only from its drawn moment, through the same gates and risk', async () => {
    const early = makeWorker({ entry: { timing: 'random', salt: saltWhere((at) => at < T - 60_000) } });
    await entered(early);
    expect(positions(early).some((p) => String(p.mint) === String(MINT))).toBe(true);
    await early.worker.stop();
    const late = makeWorker({ entry: { timing: 'random', salt: saltWhere((at) => at > T + 10 * 60_000) } });
    await entered(late);
    expect(positions(late)).toEqual([]);
    await late.worker.stop();
  });

  it('draws the same moment for the same salt and mint, in any order, inside the window', () => {
    const a = s0EntryAt('run-1', MINT, from, to);
    expect(s0EntryAt('run-1', MINT, from, to)).toBe(a);
    expect(a >= from && a < to).toBe(true);
    expect(s0EntryAt('run-2', MINT, from, to)).not.toBe(a);
  });
});

describe('the swap stream of a watched pool (review of f679188, items 3 and 9)', () => {
  it('with no fee-context fact, the terms of the latest swap on the pool price the entry', async () => {
    const without = makeWorker();
    expect(await without.worker.reconcile()).toEqual({ ok: true });
    const m0 = await passingMarket(without, { ...HELD, fees: false });
    await m0.run(4_000, 100, () => m0.pool());
    expect(positions(without)).toEqual([]);
    await without.worker.stop();

    const h = makeWorker();
    expect(await h.worker.reconcile()).toEqual({ ok: true });
    // The migration names the pool; the swap stream then gives its terms (before the minute bars the stop needs).
    const pre = new Market(h);
    pre.slot();
    pre.fact(migrationKey(MINT), passingFacts().get(migrationKey(MINT))!.value);
    pre.swap('BuyEvent', 'someone', 1_000n);
    h.worker.step();
    const m = await passingMarket(h, { ...HELD, fees: false });
    await m.run(4_000, 100, () => m.pool());
    await m.run(10_000, 400, () => {
      m.slot();
      m.pool();
    });
    expect(positions(h).some((p) => String(p.mint) === String(MINT) && p.status === 'open')).toBe(true);
    // The pool is watched for swaps while the position is open (exit traffic).
    expect([...h.worker.strategy.watchedPools()]).toEqual([[POOL_ADDRESS, { mint: MINT, held: true }]]);
    await h.worker.stop();
  });

  it('the deployer selling more than the policy share of supply after the entry exits the position', async () => {
    const h = makeWorker();
    expect(await h.worker.reconcile()).toEqual({ ok: true });
    const pre = new Market(h);
    pre.create();
    h.worker.step();
    const m = await passingMarket(h, HELD);
    await m.run(4_000, 100, () => m.pool());
    await m.run(10_000, 400, () => {
      m.slot();
      m.pool();
    });
    const open = positions(h).find((p) => p.status === 'open')!;
    expect(open).toBeDefined();
    // Someone else selling, and the deployer selling up to the limit, keep it open.
    m.swap('SellEvent', 'someone-else', SUPPLY / 10n);
    m.swap('SellEvent', DEV, (SUPPLY * 200n) / 10_000n);
    await m.run(2_000, 400, () => {
      m.slot();
      m.pool();
    });
    expect(h.worker.book.positions[open.id]!.status).toBe('open');
    m.swap('SellEvent', DEV, (SUPPLY * 2n) / 10_000n);
    await m.run(10_000, 400, () => {
      m.slot();
      m.pool();
    });
    expect(h.worker.book.positions[open.id]!.status).toBe('closed');
    expect(kinds(h.stateDir, 'exit')[0]!['reasons']).toEqual(expect.arrayContaining(['thesis_lost']));
    await h.worker.stop();
  });

  it('a deployer-sell trigger that cannot be judged is said once, never silent', async () => {
    const h = makeWorker();
    await entered(h);
    const notJudged = kinds(h.stateDir, 'decision').filter((d) => (d['reasons'] as string[])[0] === 'deployer sell not judged');
    expect(notJudged).toHaveLength(1);
    expect(notJudged[0]!['reasons']).toEqual(expect.arrayContaining(['its create was not seen']));
    await h.worker.stop();
  });
});

describe('a stalled feed (supervisor ruling 2026-10-04: stale state never becomes fresh through a new receipt time)', () => {
  it('while nothing new arrives, the clock keeps running, the facts age and the stale-data reject fires', async () => {
    const h = makeWorker();
    expect(await h.worker.reconcile()).toEqual({ ok: true });
    const m = await passingMarket(h, HELD);
    // The feed stalls before the passing facts are released: only the clock moves (and slots, so the engine runs).
    await m.run(6_000, 400, () => m.slot());
    expect(positions(h)).toEqual([]);
    const rejects = kinds(h.stateDir, 'decision').filter((d) => (d['reasons'] as string[])[0] === 'reject').map((d) => (d['reasons'] as string[])[3]!);
    // The facts were read at T - 50 ms; 2 s later they are past maxQuoteAgeMs and named as old.
    expect(rejects.some((r) => / \d+ ms old/.test(r))).toBe(true);
    // The same old read put on the feed again (a replay after a stall) is dated by its own observation: still old.
    const before = kinds(h.stateDir, 'decision').length;
    m.fact(EXEC_HEALTH_KEY, passingFacts().get(EXEC_HEALTH_KEY)!.value);
    await m.run(2_000, 400, () => m.slot());
    expect(positions(h)).toEqual([]);
    const later = kinds(h.stateDir, 'decision').slice(before).filter((d) => (d['reasons'] as string[])[0] === 'reject').map((d) => (d['reasons'] as string[])[3]!);
    expect(later.every((r) => !r.includes('exec-health') || / \d+ ms old/.test(r))).toBe(true);
    await h.worker.stop();
  });
});

describe('the heartbeat\'s open position (review of f679188: unknown is null, never 0)', () => {
  it('sends entry, stop and a fresh mark in one price unit, and no mark once it is older than 30 s', async () => {
    const sent: { body?: string }[] = [];
    const h = makeWorker({ key: 'k', http: async (req) => {
      sent.push(req);
      return { status: 200, header: () => null, text: JSON.stringify({ ok: true, paused: false }) };
    } });
    const m = await entered(h);
    await h.worker.heartbeat();
    const hb = parseHeartbeat(sent.at(-1)!.body!)!;
    const p = hb.open_position!;
    expect(p.mint).toBe(MINT);
    expect(p.stop).toBeGreaterThan(0);
    expect(p.stop).toBeLessThan(p.entry);
    expect(p.mark).not.toBeNull();
    // The mark sits near the entry (the same pool, after costs) and above the stop.
    expect(p.mark!).toBeGreaterThan(p.stop);
    expect(Math.abs(p.mark! - p.entry) / p.entry).toBeLessThan(0.05);
    expect(h.worker.health().open_position).toMatchObject({ entry: String(p.entry), stop: String(p.stop) });
    // No pool read for 31 s: the mark is no longer a price.
    await m.run(31_000, 1_000, () => m.slot());
    await h.worker.heartbeat();
    expect(parseHeartbeat(sent.at(-1)!.body!)!.open_position!.mark).toBeNull();
    await h.worker.stop();
  });
});

describe('one-time rent from the paper wallet (review of f679188, item 7)', () => {
  it('the paper wallet pays the volume accumulator rent once, at its setup, so no trade carries it', async () => {
    const h = makeWorker();
    const rent = oneTimeRent(FILL_CONFIG);
    expect(rent).toBe((128n + 137n) * 5_080n);
    await entered(h);
    const a = JSON.parse(readFileSync(join(h.stateDir, 'account.json'), 'utf8'), (_k, v) => (v !== null && typeof v === 'object' && '$n' in v ? BigInt(v['$n']) : v)) as { oneTimePaid: boolean; walletLamports: bigint; trades: { booked: bigint }[] };
    expect(a.oneTimePaid).toBe(true);
    const opening = microUsdToLamports(h.session.policy.capital.bankroll, SOL_PRICE as MicroUsd, 'floor');
    expect(a.walletLamports).toBe(opening + a.trades.reduce((s, t) => s + t.booked, 0n) - rent);
    await h.worker.stop();
  });
});

describe('entry halts fail closed (review of f679188, items 5 and 6)', () => {
  it('entries start halted, and a missing or malformed halt fact keeps them halted', async () => {
    const h = makeWorker();
    expect(h.worker.health().halt_reasons).toEqual(['starting']);
    expect(await h.worker.reconcile()).toEqual({ ok: true });
    h.worker.step();
    // A halt fact that cannot be read: the passing market that enters otherwise (the end-to-end test) makes no entry.
    new Market(h).fact(HALT_KEY, { halted: 'no' });
    const m = await passingMarket(h, HELD);
    await m.run(4_000, 100, () => m.pool());
    expect(positions(h)).toEqual([]);
    await h.worker.stop();
  });

  it('a ledger/book divergence halts entries for the rest of the process; exits go on', async () => {
    const h = makeWorker();
    const m = await entered(h);
    const open = positions(h).find((p) => p.status === 'open')!;
    h.worker.desk.consume([{ type: 'world', seq: 1, at: { slot: 0n, txIndex: 0, ixIndex: 0, receivedAt: 0 }, eventId: 'world#x', event: { type: 'intent', intentId: 'unknown', event: { type: 'cancel' } }, result: 'applied', effects: [] } as unknown as LogRecord]);
    await m.run(400, 400, () => m.slot());
    expect(h.worker.health().halt_reasons).toContain('ledger and book diverged');
    expect(kinds(h.stateDir, 'halt').some((l) => String((l['reasons'] as string[])[0]).startsWith('ledger and book diverged'))).toBe(true);
    await m.run(6_000, 400, () => {
      m.slot();
      m.pool(700_000n);
    });
    expect(h.worker.book.positions[open.id]!.status).toBe('closed');
    expect(h.worker.health().halt_reasons).toContain('ledger and book diverged');
    await h.worker.stop();
  });
});

describe('restart drill mid-trade (EXIT-1 restore acceptance)', () => {
  it('a kill with a runner open restores the same plan, trail, peak, flatMet and partials, and reconciles before any entry', async () => {
    const h = makeWorker();
    const m = await entered(h);
    const pid = positions(h).find((p) => p.status === 'open')!.id;
    // +15%: past 1.5R, so the first partial sells half; the runner's trail starts from the peak.
    await m.run(8_000, 400, () => {
      m.slot();
      m.pool(1_150_000n);
    });
    const p = h.worker.book.positions[pid]!;
    expect(p.status).toBe('open');
    expect(p.sold > 0n && p.quantity > 0n).toBe(true);
    const before = h.worker.strategy.saved()[pid]!;
    expect(before.tracker.partials).toBe(1);
    expect(before.tracker.trail).not.toBeNull();
    expect(before.tracker.flatMet).toBe(true);
    // What is on disk is what the strategy holds (saved after every step).
    expect(exitsFile(h.stateDir).read({})[pid]).toEqual(before);

    await h.worker.kill();
    const h2 = makeWorker({ stateDir: h.stateDir, timers: h.timers });
    const r = await h2.worker.reconcile();
    expect(r).toEqual({ ok: true });
    const after = h2.worker.strategy.saved()[pid]!;
    expect(after.plan).toEqual(before.plan);
    expect(after.tracker.trail).toBe(before.tracker.trail);
    expect(after.tracker.peak).toBe(before.tracker.peak);
    expect(after.tracker.flatMet).toBe(true);
    expect(after.tracker.partials).toBe(1);
    expect(after.tracker.partialSeq).toBe(before.tracker.partialSeq);
    expect(h2.worker.book.positions[pid]).toMatchObject({ status: 'open', quantity: p.quantity, sold: p.sold, exitSeq: p.exitSeq });

    // The journal across both boots: each boot opens with start; no entry before its own reconcile line.
    const report = checkJournal(journalText(h.stateDir));
    expect(report.problems).toEqual([]);
    expect(report.boots).toBe(2);
    const second = lines(h.stateDir).filter((l) => l['boot'] === h2.worker.boot);
    expect(second[0]!['kind']).toBe('start');
    expect(second.findIndex((l) => l['kind'] === 'reconcile')).toBeLessThan(Math.max(0, second.findIndex((l) => l['kind'] === 'entry')) || Number.MAX_SAFE_INTEGER);
    expect(second.find((l) => l['kind'] === 'reconcile')).toMatchObject({ ok: true, open_positions: [pid] });
    await h2.worker.stop();
    expect(replayLedgerFile(join(h.stateDir, 'ledger.sqlite'))).toMatchObject({ ok: true });
  });

  it('partials come from the book after a restart, whatever the saved file says', async () => {
    const h = makeWorker();
    const m = await entered(h);
    const pid = positions(h).find((p) => p.status === 'open')!.id;
    await m.run(8_000, 400, () => {
      m.slot();
      m.pool(1_150_000n);
    });
    const sold = h.worker.book.positions[pid]!.sold;
    expect(sold > 0n).toBe(true);
    await h.worker.kill();
    // A saved file that lost the partial (written before it, or damaged): the book still holds the sale.
    const file = exitsFile(h.stateDir);
    const saved = file.read({});
    file.write({ ...saved, [pid]: { ...saved[pid]!, tracker: { ...saved[pid]!.tracker, partials: 0, lastSold: 0n, partialSeq: null } } });
    const h2 = makeWorker({ stateDir: h.stateDir, timers: h.timers });
    expect(await h2.worker.reconcile()).toEqual({ ok: true });
    const t = h2.worker.strategy.saved()[pid]!.tracker;
    expect(t).toMatchObject({ partials: 1, lastSold: sold, partialSeq: 1 });
    expect(kinds(h.stateDir, 'decision').some((d) => (d['reasons'] as string[])[0] === 'partials from the book')).toBe(true);
    await h2.worker.stop();
  });

  it('a restored position keeps the universe it was entered under (saved plan, else its intent key), never the worker\'s (CFG-2)', async () => {
    const h = makeWorker();
    await entered(h);
    const pid = positions(h).find((p) => p.status === 'open')!.id;
    expect(h.worker.strategy.saved()[pid]!.plan.universe).toBe('U2');
    expect(String(h.worker.book.intents[h.worker.book.positions[pid]!.entryIntentId]!.intent.key)).toMatch(/^entry:[^:]+:U2\./);
    await h.worker.kill();
    // A U1 position on disk (U1's exits differ: T_flat, ATR bars), restored by a worker whose own universe is U2.
    const file = exitsFile(h.stateDir);
    const saved = file.read({});
    file.write({ ...saved, [pid]: { ...saved[pid]!, plan: { ...saved[pid]!.plan, universe: 'U1' } } });
    const h2 = makeWorker({ stateDir: h.stateDir, timers: h.timers });
    expect(await h2.worker.reconcile()).toEqual({ ok: true });
    await new Market(h2, HELD).run(1_000, 400, () => undefined);
    expect(h2.worker.strategy.saved()[pid]!.plan.universe).toBe('U1');
    await h2.worker.kill();
    // A plan saved before universes were stored: the universe comes from the entry's intent key.
    const old = file.read({});
    const { universe: _u, ...plan } = old[pid]!.plan;
    file.write({ ...old, [pid]: { ...old[pid]!, plan: plan as typeof old[string]['plan'] } });
    const h3 = makeWorker({ stateDir: h.stateDir, timers: h.timers, universe: 'U1' });
    expect(await h3.worker.reconcile()).toEqual({ ok: true });
    await new Market(h3, HELD).run(1_000, 400, () => undefined);
    expect(h3.worker.strategy.saved()[pid]!.plan.universe).toBe('U2');
    expect(kinds(h.stateDir, 'decision').some((d) => (d['reasons'] as string[])[0] === 'plan universe restored')).toBe(true);
    await h3.worker.stop();
    expect(universeOfKey(`entry:${MINT}:U1.paper-u2-0.x.y.1`)).toBe('U1');
    expect(universeOfKey(`entry:${MINT}:paper-u2-0.x.y.1`)).toBeNull();
  });

  it('an attempt in flight at the kill never lands: the restart settles it before any entry', async () => {
    const h = makeWorker();
    await h.worker.reconcile();
    const m = await passingMarket(h, HELD);
    // Run until the entry is submitted, then kill before its landing slot.
    await m.run(4_000, 100, () => m.pool());
    const live = Object.values(h.worker.book.intents).filter((i) => i.status === 'pending' || i.status === 'submitted');
    expect(live).toHaveLength(1);
    await h.worker.kill();
    expect(readFileSync(join(h.stateDir, 'open_intents'), 'utf8')).toBe('1\n');

    // A reconcile with no time to settle exits 3 (contract), and journals why.
    const quick = makeWorker({ stateDir: h.stateDir, timers: h.timers, reconcileTimeoutMs: 0 });
    expect(await quick.worker.reconcile()).toMatchObject({ ok: false, code: 3 });
    expect(kinds(h.stateDir, 'reconcile').at(-1)).toMatchObject({ ok: false });
    await quick.worker.kill();

    const h2 = makeWorker({ stateDir: h.stateDir, timers: h.timers });
    expect(await h2.worker.reconcile()).toEqual({ ok: true });
    const i = h2.worker.book.intents[live[0]!.intent.id]!;
    expect(['abandoned', 'cancelled']).toContain(i.status);
    expect(i.reservation?.status).toBe('released');
    expect(readFileSync(join(h.stateDir, 'open_intents'), 'utf8')).toBe('0\n');
    await h2.worker.stop();
    expect(replayLedgerFile(join(h.stateDir, 'ledger.sqlite'))).toMatchObject({ ok: true });
  });
});

describe('exits never wait at a restart (EXIT-1c)', () => {
  it('downtime longer than T_max: the time stop decided at the reconcile has no quote yet, is never booked blocked, and goes on the first pool read', async () => {
    const h = makeWorker();
    const m = await entered(h);
    const pid = positions(h).find((p) => p.status === 'open')!.id;
    const qty = h.worker.book.positions[pid]!.quantity;
    await h.worker.kill();
    // Down for longer than the universe's maximum hold: the last pool state is long stale.
    h.timers.set(m.now + TRIAL_POLICY.exits.universes.U2.tMaxMs + 60_000);
    const h2 = makeWorker({ stateDir: h.stateDir, timers: h.timers });
    expect(await h2.worker.reconcile()).toEqual({ ok: true });
    const m2 = new Market(h2, HELD);
    const mine = () => lines(h.stateDir).filter((l) => l['boot'] === h2.worker.boot && l['kind'] === 'decision');
    // Slots only, no pool read: the exit waits, open, with nothing booked blocked, and it is visible: said once in the
    // log, pending in the status flags, the position view and the heartbeat's pending exits.
    await m2.run(4_000, 400, () => m2.slot());
    expect(h2.worker.book.positions[pid]!.status).toBe('open');
    expect(mine().some((l) => l['action'] === 'exit_blocked')).toBe(false);
    const said = () => mine().filter((l) => (l['reasons'] as string[])[0] === 'exit waiting for a fresh quote');
    expect(said()).toHaveLength(1);
    expect(said()[0]!['reasons']).toContain('max_hold');
    expect(h2.worker.health().pending_exits).toEqual([pid]);
    expect(views.status(h2.worker.apiInputs()).flags).toContain('exit-pending');
    expect(views.status(h2.worker.apiInputs()).flags).not.toContain('exit-blocked');
    expect(views.position(h2.worker.apiInputs())).toMatchObject({ exit: 'pending' });
    // Once it has waited the blocked-retry time, it is also an alert; still nothing booked blocked, still said once.
    await m2.run(TRIAL_POLICY.exits.blockedRetryMs, 400, () => m2.slot());
    expect(views.status(h2.worker.apiInputs()).flags).toEqual(expect.arrayContaining(['exit-pending', 'exit-blocked']));
    expect(h2.worker.book.positions[pid]!.status).toBe('open');
    expect(mine().some((l) => l['action'] === 'exit_blocked')).toBe(false);
    expect(said()).toHaveLength(1);
    // The first pool read: the exit goes at once on the ladder's first rung and sells the whole holding.
    const at = m2.now;
    m2.pool();
    await m2.run(6_000, 400, () => { m2.slot(); m2.pool(); });
    const exit = mine().find((l) => (l['reasons'] as string[])[0] === 'exit');
    expect(exit).toBeDefined();
    expect((exit!['reasons'] as string[]).some((r) => r.startsWith('time_max'))).toBe(true);
    expect(Date.parse(exit!['ts'] as string) - at).toBeLessThanOrEqual(400);
    expect(mine().find((l) => (l['reasons'] as string[])[0] === 'prepare exit')!['reasons']).toContain('rung 0');
    await m2.run(20_000, 400, () => {
      m2.slot();
      m2.pool();
    });
    expect(h2.worker.book.positions[pid]).toMatchObject({ status: 'closed', sold: qty });
    expect(mine().some((l) => l['action'] === 'exit_blocked')).toBe(false);
    expect(h2.worker.health().pending_exits).toEqual([]);
    expect(views.status(h2.worker.apiInputs()).flags).not.toContain('exit-pending');
    await h2.worker.stop();
    expect(replayLedgerFile(join(h.stateDir, 'ledger.sqlite'))).toMatchObject({ ok: true });
  });
});

/** Every exit attempt lands failed (none dropped). */
const FAILS = { ...LANDS, landPpm: { pumpswap: 0n, 'pump-curve': 0n }, dropPpm: 0n };

/** A boot of `stateDir` on the shared clock, reconciled, with its own decision lines. */
const reboot = async (h: ReturnType<typeof makeWorker>, scenario = FAILS) => {
  const b = makeWorker({ stateDir: h.stateDir, timers: h.timers, scenario });
  expect(await b.worker.reconcile()).toEqual({ ok: true });
  const mine = () => lines(h.stateDir).filter((l) => l['boot'] === b.worker.boot && l['kind'] === 'decision');
  const first = (r: string) => mine().filter((l) => (l['reasons'] as string[])[0] === r);
  return { b, m: new Market(b, HELD), mine, first };
};

/** Entered, killed, then down past T_max: the time stop is due at the next boot. */
const dueAfterDowntime = async () => {
  const h = makeWorker();
  const m = await entered(h);
  const pid = positions(h).find((p) => p.status === 'open')!.id;
  await h.worker.kill();
  h.timers.set(m.now + TRIAL_POLICY.exits.universes.U2.tMaxMs + 60_000);
  return { h, pid };
};

/** Runs slots only until the clock reaches `at`. */
const slotsUntil = async (m: Market, at: number) => {
  while (m.now < at) await m.run(Math.min(400, at - m.now), Math.min(400, at - m.now), () => m.slot());
};

describe('an exit owner never waits booked blocked for a fresh market (EXIT-1d)', () => {
  it('an attempt that fails while the pool state goes stale: the replacement waits for the first fresh market, visibly, then goes on the next rung', async () => {
    const h = makeWorker();
    const m = await entered(h);
    const pid = positions(h).find((p) => p.status === 'open')!.id;
    await h.worker.kill();
    // Every exit attempt of the second boot lands failed (none dropped), and the time stop is due at once.
    h.timers.set(m.now + TRIAL_POLICY.exits.universes.U2.tMaxMs + 60_000);
    const h2 = makeWorker({ stateDir: h.stateDir, timers: h.timers, scenario: { ...LANDS, landPpm: { pumpswap: 0n, 'pump-curve': 0n }, dropPpm: 0n } });
    expect(await h2.worker.reconcile()).toEqual({ ok: true });
    const m2 = new Market(h2, HELD);
    const mine = () => lines(h.stateDir).filter((l) => l['boot'] === h2.worker.boot && l['kind'] === 'decision');
    const first = (r: string) => mine().filter((l) => (l['reasons'] as string[])[0] === r);
    await m2.run(800, 400, () => m2.slot());
    m2.pool();
    // The first attempt goes; then slots only, so the pool state is stale when the attempt resolves failed.
    await m2.run(800, 400, () => m2.slot());
    expect(first('submit exit (paper)')).toHaveLength(1);
    const failed = await until(m2, 60_000, () => first('exit waiting for a fresh market').length > 0, () => m2.slot());
    expect(failed).toBe(true);
    expect(first('exit waiting for a fresh market')[0]!['reasons']).toContain('pool state is stale');
    expect(mine().some((l) => l['action'] === 'exit_blocked')).toBe(false);
    expect(h2.worker.book.positions[pid]!.status).not.toBe('exit_blocked');
    expect(h2.worker.health().pending_exits).toEqual([pid]);
    expect(views.status(h2.worker.apiInputs()).flags).toContain('exit-pending');
    expect(views.status(h2.worker.apiInputs()).flags).not.toContain('exit-blocked');
    // After the blocked-retry time of waiting it is also an alert; still said once, still not booked blocked.
    await m2.run(TRIAL_POLICY.exits.blockedRetryMs, 400, () => m2.slot());
    expect(views.status(h2.worker.apiInputs()).flags).toEqual(expect.arrayContaining(['exit-pending', 'exit-blocked']));
    expect(first('exit waiting for a fresh market')).toHaveLength(1);
    expect(mine().some((l) => l['action'] === 'exit_blocked')).toBe(false);
    // The first fresh market: attempt 2 goes at once, one rung up.
    const at = m2.now;
    m2.pool();
    expect(await until(m2, 4_000, () => first('exit attempt 2').length > 0, () => m2.slot())).toBe(true);
    const second = first('exit attempt 2');
    expect(Date.parse(second[0]!['ts'] as string) - at).toBeLessThanOrEqual(400);
    expect(second).toHaveLength(1);
    expect(second[0]!['reasons']).toContain('rung 1');
    expect(mine().some((l) => l['action'] === 'exit_blocked')).toBe(false);
    // Sent: the wait is over (#93 N1), whatever the position's status says.
    expect(h2.worker.strategy.waitingExits().has(pid)).toBe(false);
    await h2.worker.stop();
    expect(replayLedgerFile(join(h.stateDir, 'ledger.sqlite'))).toMatchObject({ ok: true });
  });

  it('a fresh market that refuses the sale is a real refusal: booked blocked with its "no quote" reason, and no wait', async () => {
    const { h, pid } = await dueAfterDowntime();
    const { b, m: m2, mine, first } = await reboot(h);
    await m2.run(800, 400, () => m2.slot());
    m2.pool();
    await m2.run(800, 400, () => m2.slot());
    expect(first('submit exit (paper)')).toHaveLength(1);
    // From here every read is fresh and the pool holds no SOL: the replacement cannot be quoted.
    expect(await until(m2, 60_000, () => mine().some((l) => l['action'] === 'exit_blocked'), () => {
      m2.slot();
      m2.pool(0n);
    })).toBe(true);
    const blocked = mine().find((l) => l['action'] === 'exit_blocked')!;
    expect((blocked['reasons'] as string[]).some((r) => r.startsWith('no quote: '))).toBe(true);
    expect(first('exit waiting for a fresh market')).toEqual([]);
    expect(b.worker.book.positions[pid]!.status).toBe('exit_blocked');
    expect(b.worker.strategy.waitingExits().has(pid)).toBe(false);
    await b.worker.stop();
  });

  it('a wait that ends another way (a refusal books it blocked) stops being reported (#100 N1)', async () => {
    const { h, pid } = await dueAfterDowntime();
    const { b, m: m2, first } = await reboot(h);
    await m2.run(800, 400, () => m2.slot());
    m2.pool();
    await m2.run(800, 400, () => m2.slot());
    expect(await until(m2, 60_000, () => first('exit waiting for a fresh market').length > 0, () => m2.slot())).toBe(true);
    expect(b.worker.strategy.waitingExits().has(pid)).toBe(true);
    // A fresh pool that refuses the sale: booked blocked, so the wait is no longer reported as one.
    m2.pool(0n);
    await m2.run(800, 400, () => {
      m2.slot();
      m2.pool(0n);
    });
    expect(b.worker.book.positions[pid]!.status).toBe('exit_blocked');
    expect(b.worker.strategy.waitingExits().has(pid)).toBe(false);
    await b.worker.stop();
  });

  it('a wait whose owner is settled is over even when the saved file still has it (a kill between the ledger write and the plan save) (#100 N1)', async () => {
    const { h, pid } = await dueAfterDowntime();
    const d2 = await reboot(h);
    await d2.m.run(800, 400, () => d2.m.slot());
    d2.m.pool();
    await d2.m.run(800, 400, () => d2.m.slot());
    expect(await until(d2.m, 60_000, () => d2.first('exit waiting for a fresh market').length > 0, () => d2.m.slot())).toBe(true);
    const since = d2.b.worker.strategy.waitingExits().get(pid)!;
    // A fresh pool that refuses the sale books the owner blocked, which ends the wait.
    expect(await until(d2.m, 10_000, () => d2.b.worker.book.positions[pid]!.status === 'exit_blocked', () => {
      d2.m.slot();
      d2.m.pool(0n);
    })).toBe(true);
    await d2.b.worker.kill();
    // The kill lands after the ledger took the blocked booking but before the plans were saved: the file still waits.
    const file = exitsFile(h.stateDir);
    const saved = file.read({});
    file.write({ ...saved, [pid]: { ...saved[pid]!, waitingSinceMs: since } });
    const d3 = await reboot(h);
    await d3.m.run(800, 400, () => d3.m.slot());
    expect(d3.b.worker.book.positions[pid]!.status).toBe('exit_blocked');
    expect(d3.b.worker.strategy.waitingExits().has(pid)).toBe(false);
    expect(d3.b.worker.strategy.saved()[pid]!.waitingSinceMs ?? null).toBeNull();
    await d3.b.worker.stop();
  });

  it('a restart keeps the wait start: the alert comes at the first boot\'s start + blockedRetryMs, for an EXIT-1c and an EXIT-1d wait (B2, #93 N3)', async () => {
    const retry = TRIAL_POLICY.exits.blockedRetryMs;
    const alerted = (w: ReturnType<typeof makeWorker>) => views.status(w.worker.apiInputs()).flags.includes('exit-blocked');
    // EXIT-1c: a due exit with no quote yet, killed mid-wait.
    const one = await dueAfterDowntime();
    const c2 = await reboot(one.h, LANDS);
    await c2.m.run(2_000, 400, () => c2.m.slot());
    const since1c = c2.b.worker.strategy.waitingExits().get(one.pid)!;
    expect(since1c).toBeDefined();
    await c2.m.run(20_000, 400, () => c2.m.slot());
    await c2.b.worker.kill();
    const c3 = await reboot(one.h, LANDS);
    await c3.m.run(400, 400, () => c3.m.slot());
    expect(c3.b.worker.strategy.waitingExits().get(one.pid)).toBe(since1c);
    await slotsUntil(c3.m, since1c + retry - 400);
    expect(alerted(c3.b)).toBe(false);
    await slotsUntil(c3.m, since1c + retry);
    expect(alerted(c3.b)).toBe(true);
    await c3.b.worker.stop();
    // EXIT-1d: an owner's replacement waiting for a fresh market, killed mid-wait.
    const two = await dueAfterDowntime();
    const d2 = await reboot(two.h);
    await d2.m.run(800, 400, () => d2.m.slot());
    d2.m.pool();
    await d2.m.run(800, 400, () => d2.m.slot());
    expect(await until(d2.m, 60_000, () => d2.first('exit waiting for a fresh market').length > 0, () => d2.m.slot())).toBe(true);
    const since1d = d2.b.worker.strategy.waitingExits().get(two.pid)!;
    await d2.m.run(20_000, 400, () => d2.m.slot());
    await d2.b.worker.kill();
    const d3 = await reboot(two.h);
    await d3.m.run(400, 400, () => d3.m.slot());
    expect(d3.b.worker.strategy.waitingExits().get(two.pid)).toBe(since1d);
    await slotsUntil(d3.m, since1d + retry - 400);
    expect(alerted(d3.b)).toBe(false);
    await slotsUntil(d3.m, since1d + retry);
    expect(alerted(d3.b)).toBe(true);
    expect(d3.mine().some((l) => l['action'] === 'exit_blocked')).toBe(false);
    await d3.b.worker.stop();
  });
});

describe('a restored position is never managed from a plan it was not entered with (EXIT-1e)', () => {
  it('boot 2 sees a market event before its restore fact: no "no entry plan" line, no stop from the policy-maximum plan, the saved plan kept', async () => {
    const h = makeWorker();
    const m = await entered(h);
    const pid = positions(h).find((p) => p.status === 'open')!.id;
    const before = h.worker.strategy.saved()[pid]!;
    await h.worker.kill();
    const h2 = makeWorker({ stateDir: h.stateDir, timers: h.timers });
    const m2 = new Market(h2, HELD);
    // Market events published right after the boot's start facts. The saved plans now come first, 1 ms before the halt
    // (WORKER-1b), so no market event reaches the strategy before the restore at all; the strategy's own gate for one
    // that does is proved by replay (worker-recorder, "two market events before the restore…").
    m2.slot();
    m2.pool();
    expect(await h2.worker.reconcile()).toEqual({ ok: true });
    await m2.run(2_000, 400, () => {
      m2.slot();
      m2.pool();
    });
    const mine = () => lines(h.stateDir).filter((l) => l['boot'] === h2.worker.boot && l['kind'] === 'decision');
    expect(mine().filter((l) => (l['reasons'] as string[])[0] === 'no entry plan')).toEqual([]);
    expect(mine().filter((l) => (l['reasons'] as string[])[0] === 'entry plan')).toEqual([]);
    expect(h2.worker.strategy.saved()[pid]!.plan).toEqual(before.plan);
    expect(h2.worker.strategy.saved()[pid]!.tracker.peak).toBe(before.tracker.peak);
    // No wait was needed (the restore came first); nothing exits at an unchanged price; the position stays open and
    // managed after the restore.
    expect(mine().filter((l) => (l['reasons'] as string[])[0] === 'positions wait for the restore')).toEqual([]);
    expect(mine().some((l) => l['action'] === 'trigger_exit')).toBe(false);
    expect(h2.worker.book.positions[pid]!.status).toBe('open');
    await h2.worker.stop();
  });
});

describe('a restart never extends a time stop (EXIT-1f)', () => {
  it('a refused saved plan falls back to the fill at the moment the ledger booked it: the time stop due during the downtime fires at once', async () => {
    const { h, pid } = await dueAfterDowntime();
    // The saved plan is refused (its stop is not an amount): the position falls back to the plan from its fill.
    const file = exitsFile(h.stateDir);
    const saved = file.read({});
    file.write({ ...saved, [pid]: { ...saved[pid]!, plan: { ...saved[pid]!.plan, stopPrice: 'none' as unknown as bigint } } });
    const { b, m, first } = await reboot(h, LANDS);
    expect(await until(m, 4_000, () => b.worker.strategy.saved()[pid] !== undefined, () => m.slot())).toBe(true);
    expect(first('restore entry refused')).toHaveLength(1);
    // Exact: the open time is the entry fill's booking moment in the ledger, never this boot's clock.
    const ledger = openLedgerReader(join(h.stateDir, 'ledger.sqlite'));
    const booked = Number(ledger.positionEvents().find((e) => e.positionId === pid && e.status === 'open')!.ts);
    ledger.close();
    const plan = b.worker.strategy.saved()[pid]!.plan;
    expect(plan.openedAtMs).toBe(booked);
    expect(plan.openedAtMs).toBeLessThanOrEqual(saved[pid]!.plan.openedAtMs);
    expect(first('entry plan waits for the first slot')).toEqual([]);
    m.pool();
    expect(await until(m, 4_000, () => first('exit').length > 0, () => m.slot())).toBe(true);
    expect((first('exit')[0]!['reasons'] as string[]).some((r) => r.startsWith('time_max'))).toBe(true);
    await b.worker.stop();
  });
});

describe('the fallback plan opens at the first open event (EXIT-1f review B1)', () => {
  it('an exit attempt left unfilled reopens the position (a second open event); a refused plan still opens at the entry fill, and the time stop runs on that clock', async () => {
    const h = makeWorker();
    const m = await entered(h);
    const pid = positions(h).find((p) => p.status === 'open')!.id;
    // The price falls through the stop: the exit attempt is sent, and the worker is killed before it can land.
    const held = new Market(h, HELD);
    await until(held, 10_000, () => Object.values(h.worker.book.intents).some((i) => i.intent.purpose === 'exit' && (i.status === 'submitted' || i.status === 'pending')), () => {
      held.slot();
      held.pool(700_000n);
    });
    await h.worker.kill();
    // The next boot's reconcile settles that attempt unfilled: the position is open again.
    const b2 = await reboot(h, LANDS);
    await b2.m.run(400, 400, () => b2.m.slot());
    expect(b2.b.worker.book.positions[pid]!.status).toBe('open');
    await b2.b.worker.kill();
    const ledger = openLedgerReader(join(h.stateDir, 'ledger.sqlite'));
    const opens = ledger.positionEvents().filter((e) => e.positionId === pid && e.status === 'open').map((e) => Number(e.ts));
    ledger.close();
    expect(opens.length).toBeGreaterThanOrEqual(2);
    const [first, last] = [opens[0]!, opens[opens.length - 1]!];
    expect(last - first).toBeGreaterThan(10_000);
    // Refuse the saved plan, and come back 5 s past T_max counted from the entry fill (still inside it from the reopen).
    const file = exitsFile(h.stateDir);
    const saved = file.read({});
    file.write({ ...saved, [pid]: { ...saved[pid]!, plan: { ...saved[pid]!.plan, stopPrice: 'none' as unknown as bigint } } });
    h.timers.set(first + TRIAL_POLICY.exits.universes.U2.tMaxMs + 5_000);
    const { b, m: m3, first: said } = await reboot(h, LANDS);
    expect(await until(m3, 4_000, () => b.worker.strategy.saved()[pid] !== undefined, () => m3.slot())).toBe(true);
    expect(said('restore entry refused')).toHaveLength(1);
    expect(b.worker.strategy.saved()[pid]!.plan.openedAtMs).toBe(first);
    m3.pool();
    expect(await until(m3, 4_000, () => said('exit').length > 0, () => m3.slot())).toBe(true);
    expect((said('exit')[0]!['reasons'] as string[]).some((r) => r.startsWith('time_max'))).toBe(true);
    await b.worker.stop();
  });
});

describe('sell-only recovery for a position without its own plan (EXIT-1g, audit M7)', () => {
  /** Entered, killed, its saved exit changed, and booted again at once (no time stop due): what the next boot does. */
  const recovered = async (change: (saved: Record<string, SavedExit>, pid: string) => Record<string, SavedExit>) => {
    const h = makeWorker();
    await entered(h);
    const pid = positions(h).find((p) => p.status === 'open')!.id;
    await h.worker.kill();
    const file = exitsFile(h.stateDir);
    file.write(change(file.read({}), pid));
    const r = await reboot(h, LANDS);
    return { ...r, pid };
  };
  const exitsAtNormalPrice = async (r: Awaited<ReturnType<typeof recovered>>, why: string) => {
    await r.m.run(800, 400, () => r.m.slot());
    // The price has not moved: only the recovery exits, at the first fresh quote, on the ladder's first rung.
    r.m.pool();
    expect(await until(r.m, 4_000, () => r.mine().some((l) => l['action'] === 'trigger_exit'), () => r.m.slot())).toBe(true);
    expect(r.first('prepare exit')[0]!['reasons']).toContain('rung 0');
    const said = r.first('recovery exit');
    expect(said).toHaveLength(1);
    expect(said[0]!['reasons']).toEqual(['recovery exit', r.pid, why, 'the whole holding exits at the next fresh quote']);
    await r.b.worker.stop();
  };
  it('the saved plan is missing', async () => {
    await exitsAtNormalPrice(await recovered((saved, pid) => Object.fromEntries(Object.entries(saved).filter(([k]) => k !== pid))), 'no saved plan');
  });
  it('the saved plan is refused', async () => {
    await exitsAtNormalPrice(await recovered((saved, pid) => ({ ...saved, [pid]: { ...saved[pid]!, plan: { ...saved[pid]!.plan, stopPrice: 'none' as unknown as bigint } } })), 'saved plan refused');
  });
  it('the saved tracker is refused (its trail and peak cannot be recovered)', async () => {
    await exitsAtNormalPrice(await recovered((saved, pid) => ({ ...saved, [pid]: { ...saved[pid]!, tracker: { ...saved[pid]!.tracker, trail: 'high' as unknown as bigint } } })), 'saved tracker refused');
  });
  it('after a partial sale, the fallback plan prices the entry from the book (cost over tokens bought), not from what is left', async () => {
    const h = makeWorker();
    const m = await entered(h);
    const pid = positions(h).find((p) => p.status === 'open')!.id;
    const held = new Market(h, HELD);
    await held.run(8_000, 400, () => {
      held.slot();
      held.pool(1_150_000n);
    });
    const p = h.worker.book.positions[pid]!;
    expect(p.sold > 0n && p.quantity > 0n && p.quantity < p.bought).toBe(true);
    await h.worker.kill();
    void m;
    const file = exitsFile(h.stateDir);
    const saved = file.read({});
    file.write({ ...saved, [pid]: { ...saved[pid]!, plan: { ...saved[pid]!.plan, stopPrice: 'none' as unknown as bigint } } });
    const r = await reboot(h, LANDS);
    expect(await until(r.m, 4_000, () => r.b.worker.strategy.saved()[pid] !== undefined, () => r.m.slot())).toBe(true);
    const entryPx = (p.cost * PRICE_SCALE) / p.bought;
    expect(r.b.worker.strategy.saved()[pid]!.plan.stopPrice).toBe(entryPx - (entryPx * BigInt(TRIAL_POLICY.loss.stopMaxBps)) / 10_000n);
    await r.b.worker.stop();
  });
});

describe('the entry decision survives a kill before its plan is made (EXIT-1h)', () => {
  it('killed after the entry fills but before the next market event makes its plan: the restart rebuilds the real plan and does not sell', async () => {
    const h = makeWorker();
    expect(await h.worker.reconcile()).toEqual({ ok: true });
    const m = await passingMarket(h, HELD);
    // Step until the entry has filled, and stop there: its plan is made on the market event after the fill.
    expect(await until(m, 30_000, () => positions(h).some((p) => p.status === 'open'), () => {
      m.slot();
      m.pool();
    })).toBe(true);
    const p = positions(h).find((x) => x.status === 'open')!;
    const seed = seedsFile(h.stateDir).read({})[p.entryIntentId];
    expect(seed).toBeDefined();
    expect(exitsFile(h.stateDir).read({})[p.id]).toBeUndefined();
    await h.worker.kill();
    const { b, m: m2, first, mine } = await reboot(h, LANDS);
    expect(await until(m2, 4_000, () => b.worker.strategy.saved()[p.id] !== undefined, () => m2.slot())).toBe(true);
    // The plan is the decision's own (its stop), not a recovery.
    expect(first('recovery exit')).toEqual([]);
    expect(first('no entry plan')).toEqual([]);
    expect(b.worker.strategy.saved()[p.id]!.plan).toMatchObject({ stopPrice: seed!.stopPrice, universe: seed!.universe, notional: seed!.notional });
    // Dated at the fill as the ledger booked it, never at the restart.
    const ledger = openLedgerReader(join(h.stateDir, 'ledger.sqlite'));
    const booked = Number(ledger.positionEvents().find((e) => e.positionId === p.id && e.status === 'open')!.ts);
    ledger.close();
    expect(b.worker.strategy.saved()[p.id]!.plan.openedAtMs).toBe(booked);
    // At an unchanged price nothing sells.
    await m2.run(4_000, 400, () => {
      m2.slot();
      m2.pool();
    });
    expect(mine().some((l) => l['action'] === 'trigger_exit')).toBe(false);
    expect(b.worker.book.positions[p.id]!.status).toBe('open');
    // The seed is gone once its plan is made.
    expect(seedsFile(h.stateDir).read({})[p.entryIntentId]).toBeUndefined();
    await b.worker.stop();
  });
});

describe('the --reconcile entry (the host unit\'s ExecStartPre)', () => {
  it('settles what a killed worker left open, writes open_intents 0 and exits 0, as a separate process', async () => {
    const h = makeWorker();
    await h.worker.reconcile();
    const m = await passingMarket(h, HELD);
    await m.run(4_000, 100, () => m.pool());
    await h.worker.kill();
    expect(readFileSync(join(h.stateDir, 'open_intents'), 'utf8')).toBe('1\n');
    const root = join(import.meta.dirname, '..', '..', '..');
    const r = spawnSync(process.execPath, ['--no-warnings', 'packages/worker/src/main.ts', '--reconcile'], {
      cwd: root, encoding: 'utf8', timeout: 60_000,
      env: { PATH: process.env['PATH'] ?? '', ZEROED_STATE_DIR: h.stateDir, ZEROED_MODE: 'paper', ZEROED_RECORDER: 'on', ZEROED_SIMULATE: 'on', ZEROED_GIT_SHA: 'testsha' },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(join(h.stateDir, 'open_intents'), 'utf8')).toBe('0\n');
    const report = checkJournal(journalText(h.stateDir));
    expect(report.problems).toEqual([]);
    expect(lines(h.stateDir).filter((l) => l['kind'] === 'reconcile').at(-1)).toMatchObject({ ok: true });
    expect(replayLedgerFile(join(h.stateDir, 'ledger.sqlite'))).toMatchObject({ ok: true });
  }, 60_000);
});

describe('a restart rebuilds the stored book before it decides', () => {
  /** A clock that moves 1 ms on every read, as a host's wall clock does while a start opens the ledger and the book. */
  const moving = (t: ReturnType<typeof virtualTimers>): ReturnType<typeof virtualTimers> => ({
    ...t,
    now: () => {
      const v = t.now();
      t.set(v + 1);
      return v;
    },
  });

  // Tying: every frame in one millisecond, so the order fell to the ids and `worker:halt` sorts before `world#`
  // ("work" < "worl"). Moving: the restored frames are stamped after the constructor's first clock read, so a start
  // fact dated from that read came before some of them.
  it.each([['a tying clock', false], ['a clock that moves during the start', true]] as const)(
    'an entry still in flight at the kill, on %s: the stored book is rebuilt first, so the ledger and the engine agree',
    async (_name, move) => {
      const h = makeWorker();
      await h.worker.reconcile();
      const m = await passingMarket(h);
      await m.run(4_000, 100, () => m.pool());
      // The entry reached the paper network and no fill has landed: the ledger carries it past what a fresh engine has.
      expect(Object.values(h.worker.book.intents).map((i) => i.status)).toEqual(['pending']);
      await h.worker.kill();

      const timers = h.timers as ReturnType<typeof virtualTimers>;
      const h2 = makeWorker({ stateDir: h.stateDir, timers: move ? moving(timers) : timers });
      expect(await h2.worker.reconcile()).toEqual({ ok: true });
      const dir = join(h.stateDir, 'recorder', h2.worker.boot);
      const released = readdirSync(join(dir, 'days')).sort()
        .flatMap((d) => readdirSync(join(dir, 'days', d)).filter((f) => /^releases-/.test(f)).sort().map((f) => join(dir, 'days', d, f)))
        .flatMap((f) => readFileSync(f, 'utf8').split('\n').filter((l) => l !== '').map((l) => (JSON.parse(l) as { eventId: string }).eventId));
      // Frames are numbered in arrival order, so the stored book's are every `world#` below the halt fact's own number.
      const seqOf = (id: string) => Number(id.slice(id.indexOf('#') + 1));
      const haltAt = released.findIndex((x) => x.startsWith(HALT_KEY));
      expect(haltAt).toBeGreaterThanOrEqual(0);
      const stored = released.map((x, k) => ({ x, k })).filter(({ x }) => x.startsWith('world#') && seqOf(x) < seqOf(released[haltAt]!));
      expect(stored.length).toBeGreaterThan(0);
      expect(stored.filter(({ k }) => k > haltAt)).toEqual([]);
      const mine = lines(h.stateDir).filter((l) => l['boot'] === h2.worker.boot);
      expect(mine.filter((l) => l['kind'] === 'halt')).toEqual([]);
      expect(h2.worker.health().halt_reasons).not.toContain('ledger and book diverged');
      // What the host unit's ExecStartPre reports: 0, from the ledger's book, which now matches the engine's.
      expect(readFileSync(join(h.stateDir, 'open_intents'), 'utf8')).toBe('0\n');
      await h2.worker.kill();
    },
    60_000,
  );
});

describe('a restart restores the saved exit plans before it manages a position', () => {
  it('a tracker that met its flat target is not judged by a fresh one: no time_flat exit after the restart', async () => {
    const h = makeWorker();
    await h.worker.reconcile();
    const m = await passingMarket(h, HELD);
    await m.run(4_000, 100, () => m.pool());
    await m.run(10_000, 400, () => {
      m.slot();
      m.pool();
    });
    const pid = Object.values(h.worker.book.positions).find((p) => p.status === 'open')!.id;
    await h.worker.kill();
    // Met its flat target before the kill; the restart comes after the flat deadline and well before the time max.
    const file = exitsFile(h.stateDir);
    const saved = file.read({});
    const plan = saved[pid]!.plan;
    file.write({ ...saved, [pid]: { ...saved[pid]!, tracker: { ...saved[pid]!.tracker, flatMet: true } } });
    const x = h.session.policy.exits.universes[plan.universe]!;
    expect(x.tMaxMs).toBeGreaterThan(x.tFlatMs + 10 * 60_000);
    h.timers.set(plan.openedAtMs + x.tFlatMs + 5 * 60_000);
    const h2 = makeWorker({ stateDir: h.stateDir, timers: h.timers });
    expect(await h2.worker.reconcile()).toEqual({ ok: true });
    const m2 = new Market(h2, HELD);
    await m2.run(10_000, 400, () => {
      m2.slot();
      m2.pool();
    });
    // Before the fix the halt fact came before the saved plans at the same instant: the position got a fresh plan and
    // tracker (flatMet false), and the flat time stop sold it.
    const mine = lines(h.stateDir).filter((l) => l['boot'] === h2.worker.boot && l['kind'] === 'decision');
    expect(mine.filter((l) => (l['reasons'] as string[])[0] === 'no entry plan')).toEqual([]);
    expect(mine.filter((l) => (l['reasons'] as string[]).some((r) => r.startsWith('time_flat')))).toEqual([]);
    expect(h2.worker.book.positions[pid]!.status).toBe('open');
    await h2.worker.stop();
  }, 60_000);
});

describe('a killed worker writes no state file afterwards', () => {
  it('a simulation that answers after the kill does not overwrite what the next process wrote', async () => {
    let answer = (): void => undefined;
    const legs: SimLeg[] = [];
    const held = async (leg: SimLeg) => {
      await new Promise<void>((done) => {
        answer = done;
      });
      return okSimulation(legs)(leg);
    };
    const h = makeWorker({ simulate: held });
    await h.worker.reconcile();
    const m = await passingMarket(h);
    // Stepped by hand: `run` awaits the paper simulations, and this one is held open on purpose.
    for (let k = 0; k < 40; k++) {
      m.pool();
      h.worker.step();
      h.timers.set(h.timers.now() + 100);
      await new Promise<void>((r) => setImmediate(r));
    }
    expect(readFileSync(join(h.stateDir, 'open_intents'), 'utf8')).toBe('1\n');
    await h.worker.kill();
    // The host unit's ExecStartPre settles the intent and writes 0 (here: what that next process would write).
    writeFileSync(join(h.stateDir, 'open_intents'), '0\n');
    const paper = readFileSync(join(h.stateDir, 'paper.json'), 'utf8');
    // The killed process's simulation answers now: its save would write `paper.json` and `open_intents` from a
    // process that is gone, over the successor's.
    answer();
    for (let k = 0; k < 20; k++) await new Promise<void>((r) => setImmediate(r));
    expect(legs.length).toBe(1);
    expect(readFileSync(join(h.stateDir, 'open_intents'), 'utf8')).toBe('0\n');
    expect(readFileSync(join(h.stateDir, 'paper.json'), 'utf8')).toBe(paper);
  }, 60_000);
});

describe('restart drill: H14 creates coverage across a restart (SEED-1 ruling 2026-10-04)', () => {
  // An RPC whose history reaches past the range with no create in it: the seed and the downtime fill complete.
  const emptyRpc = { getSignaturesForAddress: async () => [{ signature: 'before-the-range', slot: 0n, err: null, blockTime: 0 }], getTransaction: async () => null };
  const VIA = 'logs:TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM';
  const ports = (n: number) => ({ ZEROED_HEALTH_ADDR: `127.0.0.1:${18820 + 2 * n}`, ZEROED_API_ADDR: `127.0.0.1:${18821 + 2 * n}` });

  /** Starts the worker with the live creates watch reporting its first slot once its sources start, as on the host. */
  const boot = async (h: ReturnType<typeof makeWorker>) => {
    const m = new Market(h);
    const started = h.worker.start();
    while (!h.order.includes('start helius-ws')) await new Promise<void>((r) => setImmediate(r));
    m.slot();
    m.offchain('coverage:creates:start', { fromSlot: slotAt(m.now), via: VIA });
    expect(await started).toEqual({ ok: true });
    await m.run(3_000, 400, () => m.slot());
    return m;
  };

  it('a seed that never answers does not hold the start: it gives up and the loop runs (rehearsal 37148935094)', async () => {
    const h = makeWorker({ seed: () => new Promise(() => undefined), seedMaxMs: 90_000, config: ports(3) });
    expect(await h.worker.start()).toEqual({ ok: true });
    expect(h.logs.some((l) => /Deployer index: none \(seed failed: no answer within 90000 ms\)/.test(l))).toBe(true);
    await h.worker.stop();
  }, 60_000);

  it('a restart reloads the saved coverage and fills the downtime: covered from the first live start, with no gap', async () => {
    const stateDir = tempState();
    const timers = virtualTimers(T);
    const seed = (r: SeedRequest) => runSeed(r, { rpc: emptyRpc, timers });
    const h = makeWorker({ stateDir, timers, seed, config: ports(0) });
    const m = await boot(h);
    // A first start reads no history: the look-back is covered once the live watch has run through it.
    expect(h.worker.strategy.coverage).toMatchObject({ covered: false });
    timers.set(timers.now() + 15 * 86_400_000);
    await m.run(2_000, 400, () => m.slot());
    const first = h.worker.strategy.coverage;
    expect(first).toMatchObject({ covered: true });
    await h.worker.kill();
    const killed = `${stateDir}-killed`;
    cpSync(stateDir, killed, { recursive: true });

    // Ten minutes down, then the restart: the saved watch is closed by the fill, the new start continues it.
    timers.set(timers.now() + 10 * 60_000);
    const requests: SeedRequest[] = [];
    const h2 = makeWorker({ stateDir, timers, seed: (r) => (requests.push(r), seed(r)), config: ports(1) });
    await boot(h2);
    expect(requests[0]!.saved.last).not.toBeNull();
    expect(requests[0]!.close).toEqual({ via: VIA, fromSlot: null });
    expect(h2.worker.strategy.coverage).toEqual(first);
    // The seed came after live events, which waited for it: the index took it in full, never refused.
    const seeds = lines(stateDir).filter((l) => l['boot'] === h2.worker.boot && l['kind'] === 'decision' && /^seed/.test((l['reasons'] as string[])[0] ?? ''));
    expect(seeds.map((l) => (l['reasons'] as string[])[0])).toEqual(['seed']);
    await h2.worker.stop();

    // Control: the same restart without a fill marks the downtime a gap, so H14 is not covered.
    const h3 = makeWorker({ stateDir: killed, timers, seed: async () => { throw new Error('RPC down'); }, config: ports(2) });
    await boot(h3);
    expect(h3.worker.strategy.coverage).toMatchObject({ covered: false });
    await h3.worker.stop();
  }, 60_000);

  it('a restart whose fill does not answer within the 90 s cap: H14 is not covered across the downtime, and the fill stops its RPC', async () => {
    const stateDir = tempState();
    const timers = virtualTimers(T);
    const h = makeWorker({ stateDir, timers, seed: (r) => runSeed(r, { rpc: emptyRpc, timers }), config: ports(4) });
    const m = await boot(h);
    timers.set(timers.now() + 15 * 86_400_000);
    await m.run(2_000, 400, () => m.slot());
    expect(h.worker.strategy.coverage).toMatchObject({ covered: true });
    await h.worker.kill();
    timers.set(timers.now() + 10 * 60_000);
    // The fill's first signature page hangs past the cap; answered later, it names a downtime transaction.
    const calls: string[] = [];
    let answer = (): void => undefined;
    const hanging: SeedRpc = {
      getSignaturesForAddress: async (_a, o) => {
        calls.push('page');
        return new Promise<SignatureInfo[]>((r) => {
          answer = () => r([{ signature: 'in-the-downtime', slot: o.minContextSlot ?? 0n, err: null, blockTime: 0 }]);
        });
      },
      getTransaction: async () => (calls.push('transaction'), null),
    };
    const h2 = makeWorker({ stateDir, timers, seed: (r) => runSeed(r, { rpc: hanging, timers }), seedMaxMs: 90_000, config: ports(5) });
    const m2 = await boot(h2);
    expect(h2.logs.some((l) => /Deployer index: none \(seed failed: no answer within 90000 ms\)/.test(l))).toBe(true);
    expect(h2.worker.strategy.coverage).toMatchObject({ covered: false });
    answer();
    await m2.run(2_000, 400, () => m2.slot());
    expect(calls).toEqual(['page']);
    expect(h2.worker.strategy.coverage).toMatchObject({ covered: false });
    await h2.worker.stop();
  }, 60_000);
});

describe('exits never wait for the seed (review of 9fdf837)', () => {
  it('a restart with an open position and a seed that never answers: the stop exits during the wait, before seedMaxMs; entries halt', async () => {
    const h = makeWorker();
    await h.worker.reconcile();
    const m = await passingMarket(h, HELD);
    await m.run(4_000, 100, () => m.pool());
    await m.run(10_000, 400, () => {
      m.slot();
      m.pool();
    });
    expect(Object.values(h.worker.book.positions).some((p) => p.status === 'open')).toBe(true);
    await h.worker.kill();

    const t2 = dueTimers(h.timers.now());
    const h2 = makeWorker({ stateDir: h.stateDir, timers: t2, seed: () => new Promise(() => undefined), seedMaxMs: 90_000, config: { ZEROED_HEALTH_ADDR: '127.0.0.1:18836', ZEROED_API_ADDR: '127.0.0.1:18837' } });
    const t0 = t2.now();
    void h2.worker.start();
    // Only the clock moves: every step is the worker's own loop.
    const tick = async (): Promise<void> => {
      t2.set(t2.now() + 100);
      for (let k = 0; k < 4; k++) await new Promise<void>((r) => setImmediate(r));
    };
    for (let k = 0; k < 600 && !h2.order.includes('start helius-ws'); k++) await tick();
    const m2 = new Market(h2, HELD);
    const mine = () => lines(h.stateDir).filter((l) => l['boot'] === h2.worker.boot && l['kind'] === 'decision');
    let exit: Record<string, unknown> | undefined;
    for (let k = 0; k < 300 && exit === undefined; k++) {
      m2.slot();
      m2.pool(700_000n);
      await tick();
      exit = mine().find((l) => (l['reasons'] as string[])[0] === 'exit');
    }
    expect(exit).toBeDefined();
    expect(Date.parse(exit!['ts'] as string) - t0).toBeLessThan(90_000);
    expect(h2.logs.some((l) => /Deployer index/.test(l))).toBe(false);
    expect(h2.worker.health().halt_reasons).toContain(SEEDING);
    expect(mine().some((l) => l['action'] === 'enter')).toBe(false);
    await h2.worker.stop();
  }, 60_000);
});
