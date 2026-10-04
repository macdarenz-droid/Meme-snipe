// STRATEGY-HEALTH-OBS step 3 in the worker: observation only. An episode is observed once it is final, journaled as a
// `strategy_health` line marked "observed; entries not stopped", saved so a restart neither repeats nor loses it, and the
// worker's other journal lines are byte-identical with the monitor on or off.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FILL_CONFIG } from '../../core/src/config/index.ts';
import { HealthMonitor, strategyHealthFile } from '../src/run/strategy-health.ts';
import { HEALTH_DEFAULTS, type StrategyIdentity } from '../../core/src/strategy-health/index.ts';
import { attemptFee } from '../../core/src/fills/index.ts';
import type { Book } from '../../core/src/lifecycle/index.ts';
import type { PaperLegs, PaperTrade } from '../src/run/account.ts';
import type { PaperAttempt } from '../src/run/paper-world.ts';
import { runHealth } from '../../backtest/src/strategy-health.ts';
import type { TradeRecord } from '../../backtest/src/trades.ts';
import { LANDS, makeWorker, passingMarket, tempState, until } from './worker-harness.ts';

const HELD = { heldPoolFacts: true } as const;
type Line = { kind: string; [k: string]: unknown };
const journal = (dir: string): Line[] => readFileSync(join(dir, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Line);
const healthLines = (dir: string) => journal(dir).filter((l) => l.kind === 'strategy_health');
const bigints = (_k: string, v: unknown) => (v !== null && typeof v === 'object' && '$n' in v ? BigInt((v as { $n: string }).$n) : v);
const closedTrade = (dir: string) => (JSON.parse(readFileSync(join(dir, 'account.json'), 'utf8'), bigints) as { trades: { positionId: string; netLamports: bigint | null; closedAtMs: number | null }[] }).trades.find((t) => t.closedAtMs !== null)!;

const roundTrip = async (h: ReturnType<typeof makeWorker>, whileOpen?: () => void) => {
  expect(await h.worker.reconcile()).toEqual({ ok: true });
  const m = await passingMarket(h, HELD);
  await m.run(4_000, 100, () => m.pool());
  await m.run(10_000, 400, () => { m.slot(); m.pool(); });
  expect(await until(m, 120_000, () => Object.values(h.worker.book.positions).some((p) => p.status === 'closed'), () => {
    if (Object.values(h.worker.book.positions).some((p) => p.status !== 'closed')) whileOpen?.();
    m.slot();
    m.pool(700_000n);
  })).toBe(true);
  return m;
};
const scenario = { ...LANDS, closeSuccessPpm: 1_000_000n, dustPpm: 0n };

describe('strategy health in the worker (observation only)', () => {
  it('a closed episode is observed once, at its settled lamport net over the entry size, and marked observed', async () => {
    const h = makeWorker({ scenario });
    let openLines = -1;
    await roundTrip(h, () => { openLines = Math.max(openLines, healthLines(h.stateDir).length); });
    // No future labels: nothing was observed while the position was still open.
    expect(openLines).toBe(0);
    const lines = healthLines(h.stateDir);
    expect(lines).toHaveLength(1);
    const entry = Object.values(h.worker.book.intents).find((i) => i.intent.purpose === 'entry')!;
    const net = closedTrade(h.stateDir).netLamports!;
    expect(lines[0]).toMatchObject({ observation: 'episode', episode: entry.intent.id, z: Number(net) / Number(entry.intent.purpose === 'entry' ? entry.intent.spend : 0n), from: null, to: 'unregistered', display: 'health: unregistered (observed; entries not stopped)' });
    expect(lines[0]!['lineage']).toMatch(/^paper\|U[12]$/);
    expect(Math.sign(Number(lines[0]!['z']))).toBe(Math.sign(Number(net)));
    expect(FILL_CONFIG.network.tokenAccountRent).toBeGreaterThan(0n);
    await h.worker.stop();
  });

  it('a restart neither repeats nor loses an observation', async () => {
    const h = makeWorker({ scenario });
    await roundTrip(h);
    expect(healthLines(h.stateDir)).toHaveLength(1);
    await h.worker.stop();
    const h2 = makeWorker({ stateDir: h.stateDir, timers: h.timers, scenario });
    expect(await h2.worker.reconcile()).toEqual({ ok: true });
    expect(healthLines(h.stateDir)).toHaveLength(1);
    const saved = JSON.parse(readFileSync(join(h.stateDir, 'health.json'), 'utf8')) as { lineages: Record<string, { observations: number }> };
    expect(Object.values(saved.lineages).map((l) => l.observations)).toEqual([1]);
    await h2.worker.stop();
  });

  it('every other journal line is byte-identical with the monitor on or off, and a monitor failure stops nothing', async () => {
    const strip = (dir: string) => journal(dir).filter((l) => l.kind !== 'strategy_health').map(({ seq: _s, ts: _t, boot: _b, ...rest }) => JSON.stringify(rest));
    const on = makeWorker({ scenario });
    await roundTrip(on);
    await on.worker.stop();
    const spy = vi.spyOn(HealthMonitor.prototype, 'update').mockImplementation(() => { throw new Error('monitor broken'); });
    const off = makeWorker({ scenario });
    await roundTrip(off);
    await off.worker.stop();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
    expect(strip(off.stateDir)).toEqual(strip(on.stateDir));
    expect(strip(on.stateDir).some((l) => l.includes('"kind":"decision"'))).toBe(true);
    // The failure is said once and nothing else changes.
    expect(healthLines(off.stateDir)).toEqual([expect.objectContaining({ display: 'health: off for this run (observed only; entries not stopped)', reasons: ['monitor broken'] })]);
  });

  it('parity with a failed entry: the backtest path observes the same failed-entry episode from the same book', async () => {
    // Nothing lands: entry attempts fail (fees paid) until the intent ends unfilled.
    const h = makeWorker({ scenario: { ...LANDS, landPpm: { pumpswap: 0n, 'pump-curve': 0n }, dropPpm: 0n } });
    expect(await h.worker.reconcile()).toEqual({ ok: true });
    const m = await passingMarket(h, HELD);
    await m.run(4_000, 100, () => m.pool());
    expect(await until(m, 180_000, () => healthLines(h.stateDir).length >= 1, () => { m.slot(); m.pool(); })).toBe(true);
    const worker = healthLines(h.stateDir).map((l) => [l['episode'], l['z'], l['s'], l['to']]);
    const paper = Object.values((JSON.parse(readFileSync(join(h.stateDir, 'paper.json'), 'utf8'), bigints) as { attempts: Record<string, PaperAttempt> }).attempts);
    // The backtest's stray costs: each landed failed entry attempt's fee, by its entry intent.
    const stray = paper.filter((a) => a.purpose === 'entry' && a.outcome === 'failed').map((a) => ({ at: a.sentAtMs ?? 0, lamports: attemptFee(FILL_CONFIG.network, a.priorityFee, 'failed'), intentId: a.intentId }));
    expect(stray.length).toBeGreaterThan(0);
    const bt = runHealth({ book: h.worker.book, endedAt: h.timers.now() }, { trades: [], stray }, { lineageId: 'U', strategyVersionHash: 'v', universe: 'U', policyHash: 'p', executionModelHash: 'x' });
    const failedEntries = bt.observations.filter((o) => o.z < 0);
    expect(failedEntries.length).toBeGreaterThan(0);
    expect(bt.observations.map((o) => [o.episodeId, o.z, o.s, o.to])).toEqual(worker);
    await h.worker.stop();
  });

  it('parity: the backtest path observes the same episodes from the same book as the worker did', async () => {
    const h = makeWorker({ scenario });
    await roundTrip(h);
    const worker = healthLines(h.stateDir).map((l) => [l['episode'], l['z'], l['s'], l['to']]);
    const trades = (JSON.parse(readFileSync(join(h.stateDir, 'account.json'), 'utf8'), bigints) as { trades: { positionId: string; netLamports: bigint | null; closedAtMs: number | null }[] }).trades
      .filter((t) => t.closedAtMs !== null).map((t) => ({ id: t.positionId, net: t.netLamports!, closedAt: t.closedAtMs! }) as unknown as TradeRecord);
    const bt = runHealth({ book: h.worker.book, endedAt: h.timers.now() }, { trades, stray: [] }, { lineageId: 'U', strategyVersionHash: 'v', universe: 'U', policyHash: 'p', executionModelHash: 'x' });
    expect(bt.observations.map((o) => [o.episodeId, o.z, o.s, o.to])).toEqual(worker);
    expect(worker).toHaveLength(1);
    await h.worker.stop();
  });
});

describe('when the worker counts an episode as final (unit)', () => {
  const SPEND = 100_000_000n;
  const ID: StrategyIdentity = { lineageId: 'U1', strategyVersionHash: 'v', universe: 'U1', venue: 'pumpswap', policyHash: 'p', executionModelHash: 'x', mode: 'paper' };
  const monitor = () => new HealthMonitor(strategyHealthFile(tempState()), { ...HEALTH_DEFAULTS, registered: [] }, () => ID);
  const intent = (id: string, purpose: 'entry' | 'exit', status: string, fills: number, sigs: string[] = []) => ({
    intent: { id, purpose, venue: 'pumpswap', spend: SPEND, positionId: 'p1', key: 'entry:M:U1.v.0' }, status,
    fills: Array.from({ length: fills }, (_, k) => ({ signature: `${id}-f${k}` })), attempts: sigs.map((signature) => ({ signature })),
  });
  const att = (signature: string, intentId: string, outcome: PaperAttempt['outcome']) => ({ signature, intentId, outcome, priorityFee: 10_000n, sentAtMs: 5 }) as unknown as PaperAttempt;
  const legs = (as: PaperAttempt[]): PaperLegs => ({ network: FILL_CONFIG.network, attempts: new Map(as.map((a) => [a.signature, a])), closedAccount: () => false });
  const book = (positionStatus: string, intents: ReturnType<typeof intent>[]) =>
    ({ intents: Object.fromEntries(intents.map((i) => [i.intent.id, i])), positions: { p1: { id: 'p1', entryIntentId: 'e1', status: positionStatus } } }) as unknown as Book;
  const trades = [{ positionId: 'p1', closedAtMs: 100, netLamports: -SPEND / 4n }] as unknown as PaperTrade[];

  it('a closed trade with an attempt still in flight is not final; it is once the attempt resolves', () => {
    const m = monitor();
    const b = book('closed', [intent('e1', 'entry', 'reconciled', 1), intent('x1', 'exit', 'reconciled', 1)]);
    expect(m.update(b, legs([att('s1', 'x1', 'in_flight')]), trades)).toEqual([]);
    expect(m.update(b, legs([att('s1', 'x1', 'failed')]), trades).map((o) => o.z)).toEqual([-0.25]);
  });

  it('a late settlement after the episode was observed counts at once as a correction (PAPER-2)', () => {
    const m = monitor();
    const b = book('closed', [intent('e1', 'entry', 'reconciled', 1)]);
    expect(m.update(b, legs([]), trades).map((o) => [o.kind, o.z])).toEqual([['episode', -0.25]]);
    // PAPER-2 keeps the net at the close and books what lands later in `late` (#198).
    const later = [{ ...trades[0]!, late: [{ atMs: 200, lamports: -20_000n, usd: null }] }] as unknown as PaperTrade[];
    expect(m.update(b, legs([]), later).map((o) => [o.kind, o.z, o.previous?.z])).toEqual([['correction', Number(-SPEND / 4n - 20_000n) / Number(SPEND), -0.25]]);
    expect(m.update(b, legs([]), later)).toEqual([]);
    expect(m.state.finished['e1']!.netLamports).toBe(-SPEND / 4n - 20_000n);
  });

  it('a trade the account closed while the book still holds the position is not final', () => {
    const m = monitor();
    expect(m.update(book('exit_pending', [intent('e1', 'entry', 'reconciled', 1)]), legs([]), trades)).toEqual([]);
  });

  it('a failed entry counts its landed fees once the intent is terminal', () => {
    const m = monitor();
    const b = { intents: { e2: intent('e2', 'entry', 'abandoned', 0, ['s2', 's3']) }, positions: {} } as unknown as Book;
    const fee = attemptFee(FILL_CONFIG.network, 10_000n, 'failed');
    expect(m.update(b, legs([att('s2', 'e2', 'failed'), att('s3', 'e2', 'dropped')]), [])).toMatchObject([{ episodeId: 'e2', z: -Number(fee) / Number(SPEND) }]);
  });

  it('the backtest groups stray fees by entry intent, and refuses one it cannot group', () => {
    const b = { intents: { e2: intent('e2', 'entry', 'abandoned', 0) }, positions: {} } as unknown as Book;
    const ident = { lineageId: 'U', strategyVersionHash: 'v', universe: 'U', policyHash: 'p', executionModelHash: 'x' };
    const r = runHealth({ book: b, endedAt: 9 }, { trades: [], stray: [{ at: 3, lamports: 5_000n, intentId: 'e2' }, { at: 4, lamports: 7_000n, intentId: 'e2' }] }, ident);
    expect(r.observations).toMatchObject([{ episodeId: 'e2', z: -12_000 / Number(SPEND) }]);
    expect(() => runHealth({ book: b, endedAt: 9 }, { trades: [], stray: [{ at: 3, lamports: 5_000n }] }, ident)).toThrow(/without its entry intent/);
  });
});
