// OWNER-REVIEW on the worker: the heartbeat reports each stop the owner can clear (trip id and SOL evidence) and the
// commands handled; a command from the reply is applied only for the worker's own open trip, writes only its own review
// moment into control.json, is journaled, and is never applied twice (a restart included).
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NO_LATCHES, type Latches } from '../../core/src/risk/index.ts';
import { accountFile } from '../src/run/account.ts';
import { type HandledCommand, type OpenStops, handleCommand, commandsOf, openStops, tripId } from '../src/run/owner-review.ts';
import { controlFile, NO_CONTROL } from '../src/run/state.ts';
import type { HttpRequest } from '../src/providers/index.ts';
import { makeWorker } from './worker-harness.ts';

const LOSS = { reviewWindowTrades: 20, reviewLosses: 5 };
const lines = (dir: string) => readFileSync(join(dir, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
const ownerLines = (dir: string) => lines(dir).filter((l) => l['kind'] === 'owner_command');

describe('owner commands against the open stops', () => {
  const T = 1_800_000_000_000;
  const latched: Latches = { ...NO_LATCHES, killTrippedAtMs: T - 600_000, weeklyTrippedAtMs: T - 1_200_000 };
  // Five losses, then a win: the window runs past the trip.
  const trades = [1, 2, 3, 4, 5, 6].map((i) => ({ mint: `M${i}`, openedAtMs: T - 7_200_000 + i, closedAtMs: T - 3_600_000 + i * 60_000, notional: 2_000_000n, netPnl: i === 6 ? 50_000n : -100_000n, stoppedOut: i !== 6 }) as never);
  // A stand-in sum that shows which closes it was asked for.
  const stops = (l: Latches): OpenStops => openStops({ latches: l, closed: trades, loss: LOSS, netLamports: (from, to) => BigInt(to - from), snapshot: null });

  it('names each open stop by kind and moment; a cleared one is not open', () => {
    const s = stops(latched);
    expect(s.review?.trip).toBe(tripId('review', T - 3_600_000 + 5 * 60_000));
    expect(s.review?.evidence).toEqual({ losses: 5, trades: 6, from_ms: T - 3_600_000 + 60_000, to_ms: T - 3_600_000 + 6 * 60_000, net_lamports: String(5 * 60_000) });
    expect(s.rearm).toMatchObject({ trip: `rearm-${T - 600_000}`, atMs: T - 600_000 });
    expect(s.weekly?.evidence['week_ends_ms']).toBeGreaterThan(T - 1_200_000);
    const cleared = stops({ ...latched, killRearmedAtMs: T - 1, weeklyReviewedAtMs: T - 1, lossReviewedAtMs: T - 1 });
    expect(cleared).toEqual({ review: null, rearm: null, weekly: null });
    // A re-arm at or before the trip clears nothing (evaluate.ts R10: strictly after).
    expect(stops({ ...latched, killRearmedAtMs: T - 600_000 }).rearm).not.toBeNull();
  });

  it('applies a command only to its own stop, only for its current trip, only strictly after the trip, and never twice', () => {
    const s = stops(latched);
    const rearm = { id: 'c1', kind: 'rearm', trip: s.rearm!.trip };
    const a = handleCommand(rearm, s, latched, [], T);
    expect(a?.entry).toEqual({ id: 'c1', kind: 'rearm', trip: s.rearm!.trip, result: 'applied', atMs: T });
    expect(a?.latches).toEqual({ ...latched, killRearmedAtMs: T });
    expect(handleCommand({ id: 'c2', kind: 'review', trip: s.review!.trip }, s, latched, [], T)?.latches).toEqual({ ...latched, lossReviewedAtMs: T });
    expect(handleCommand({ id: 'c3', kind: 'weekly', trip: s.weekly!.trip }, s, latched, [], T)?.latches).toEqual({ ...latched, weeklyReviewedAtMs: T });
    // Already handled: nothing.
    expect(handleCommand(rearm, s, latched, [a!.entry as HandledCommand], T + 1)).toBeNull();
    // Stale: an older trip, a trip of a stop not open, or a review moment not after the trip.
    expect(handleCommand({ id: 'c4', kind: 'rearm', trip: `rearm-${T - 600_001}` }, s, latched, [], T)?.entry.result).toBe('stale');
    expect(handleCommand({ id: 'c5', kind: 'rearm', trip: s.rearm!.trip }, stops({ ...latched, killTrippedAtMs: null }), { ...latched, killTrippedAtMs: null }, [], T)?.entry.result).toBe('stale');
    expect(handleCommand({ id: 'c6', kind: 'rearm', trip: s.rearm!.trip }, s, latched, [], T - 600_000)?.entry.result).toBe('stale');
    // Invalid: another kind's trip, an unknown kind or a malformed trip; the latches never change.
    for (const c of [{ id: 'c7', kind: 'review', trip: s.rearm!.trip }, { id: 'c8', kind: 'override', trip: 'override-1' }, { id: 'c9', kind: 'rearm', trip: 'rearm-x' }]) {
      const r = handleCommand(c, s, latched, [], T);
      expect(r?.entry.result).toBe('invalid');
      expect(r?.latches).toBe(latched);
    }
  });

  it('reads only well-formed commands from the reply', () => {
    expect(commandsOf(undefined)).toEqual([]);
    expect(commandsOf('x')).toEqual([]);
    expect(commandsOf([null, 1, { id: 'bad id!', kind: 'rearm', trip: 'rearm-1' }, { id: 'a', kind: 'rearm' }, { id: 'b', kind: 'rearm', trip: 'rearm-1' }])).toEqual([{ id: 'b', kind: 'rearm', trip: 'rearm-1' }]);
    expect(commandsOf(Array.from({ length: 20 }, (_, i) => ({ id: `c${i}`, kind: 'rearm', trip: 'rearm-1' })))).toHaveLength(8);
  });
});

describe('control.json with handled commands', () => {
  it('reads a file from before (no commands) and refuses a malformed command list', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zeroed-control-'));
    const file = controlFile(dir);
    writeFileSync(file.path, JSON.stringify({ paused: false, pausedAtMs: null, latches: NO_LATCHES }));
    expect(file.read(NO_CONTROL).commands).toBeUndefined();
    const good = { id: 'a', kind: 'rearm', trip: 'rearm-1', result: 'applied', atMs: 2 };
    file.write({ ...NO_CONTROL, commands: [good as HandledCommand] });
    expect(file.read(NO_CONTROL).commands).toEqual([good]);
    for (const bad of ['x', [{ ...good, result: 'done' }], [{ ...good, atMs: '2' }], [{ ...good, id: 1 }]]) {
      writeFileSync(file.path, JSON.stringify({ paused: false, pausedAtMs: null, latches: NO_LATCHES, commands: bad }));
      expect(() => file.read(NO_CONTROL)).toThrow(/not a valid state file/);
    }
  });
});

describe('owner commands through the heartbeat (worker harness)', () => {
  /** A worker whose stop files hold a kill latch, a weekly latch and five losing trades (R8), as a restart finds them. */
  const latchedWorker = async () => {
    const h0 = makeWorker();
    expect(await h0.worker.reconcile()).toEqual({ ok: true });
    await h0.worker.stop();
    const now = h0.timers.now();
    const file = accountFile(h0.stateDir);
    const a = file.read(null as never);
    const lost = 1_000_000n;
    const trades = [1, 2, 3, 4, 5].map((i) => ({ positionId: `p:x:${i}`, mint: `Mint${i}`, openedAtMs: now - 7_200_000 + i, notional: 2_000_000n, closedAtMs: now - 3_600_000 + i * 60_000, netLamports: -lost, netPnl: -150_000n, stoppedOut: true, booked: -lost }));
    file.write({ ...a, walletLamports: a.walletLamports === null ? null : a.walletLamports - 5n * lost, trades } as never);
    const latches: Latches = { ...NO_LATCHES, killTrippedAtMs: now - 600_000, weeklyTrippedAtMs: now - 1_200_000 };
    controlFile(h0.stateDir).write({ ...NO_CONTROL, latches });
    return { stateDir: h0.stateDir, timers: h0.timers, now, latches, r8At: now - 3_600_000 + 5 * 60_000, lost };
  };
  const watchdog = () => {
    const sent: Record<string, unknown>[] = [];
    let commands: unknown = undefined;
    const http = async (req: HttpRequest) => {
      sent.push(JSON.parse(req.body!) as Record<string, unknown>);
      return { status: 200, header: () => null, text: JSON.stringify({ ok: true, paused: false, ...(commands === undefined ? {} : { commands }) }) };
    };
    return { sent, http, reply: (c: unknown) => { commands = c; } };
  };

  it('reports the open stops, applies a confirmed re-arm once, keeps the others, and acknowledges it, across a restart', async () => {
    const f = await latchedWorker();
    const w = watchdog();
    const h = makeWorker({ stateDir: f.stateDir, timers: f.timers, key: 'k', http: w.http });
    expect(await h.worker.reconcile()).toEqual({ ok: true });
    await h.worker.heartbeat();
    const review = w.sent[0]!['review'] as Record<string, { trip: string; evidence: Record<string, unknown> } | null>;
    expect(review['rearm']?.trip).toBe(`rearm-${f.latches.killTrippedAtMs}`);
    expect(review['weekly']?.trip).toBe(`weekly-${f.latches.weeklyTrippedAtMs}`);
    expect(review['review']?.trip).toBe(`review-${f.r8At}`);
    expect(review['review']?.evidence).toEqual({ losses: 5, trades: 5, from_ms: f.r8At - 4 * 60_000, to_ms: f.r8At, net_lamports: String(-5n * f.lost) });
    expect(w.sent[0]!['acked']).toEqual([]);

    // A stale trip, another kind's trip, and the current one: only the last is applied, to its own field.
    const trip = `rearm-${f.latches.killTrippedAtMs}`;
    w.reply([{ id: 'old', kind: 'rearm', trip: `rearm-${f.latches.killTrippedAtMs! - 1}` }, { id: 'cross', kind: 'review', trip }, { id: trip, kind: 'rearm', trip }]);
    f.timers.set(f.now + 1_000);
    await h.worker.heartbeat();
    const at = h.timers.now();
    const ctl = controlFile(f.stateDir).read(NO_CONTROL);
    expect(ctl.latches).toEqual({ ...f.latches, killRearmedAtMs: at });
    expect(ctl.commands?.map((c) => [c.id, c.result])).toEqual([['old', 'stale'], ['cross', 'invalid'], [trip, 'applied']]);
    expect(ownerLines(f.stateDir).map((l) => [l['id'], l['command'], l['trip'], l['result']])).toEqual([
      ['old', 'rearm', `rearm-${f.latches.killTrippedAtMs! - 1}`, 'stale'], ['cross', 'review', trip, 'invalid'], [trip, 'rearm', trip, 'applied'],
    ]);

    // The next heartbeat acknowledges all three and no longer reports the kill stop; the others are still open.
    f.timers.set(f.now + 2_000);
    await h.worker.heartbeat();
    const next = w.sent.at(-1)!;
    expect(next['acked']).toEqual([{ id: 'old', result: 'stale' }, { id: 'cross', result: 'invalid' }, { id: trip, result: 'applied' }]);
    expect((next['review'] as Record<string, unknown>)['rearm']).toBeNull();
    expect((next['review'] as Record<string, unknown>)['weekly']).not.toBeNull();
    expect(controlFile(f.stateDir).read(NO_CONTROL).latches.killRearmedAtMs).toBe(at);
    expect(ownerLines(f.stateDir)).toHaveLength(3);
    await h.worker.stop();

    // A restart: the same command again is a no-op, still acknowledged.
    const h2 = makeWorker({ stateDir: f.stateDir, timers: f.timers, key: 'k', http: w.http });
    expect(await h2.worker.reconcile()).toEqual({ ok: true });
    f.timers.set(f.now + 3_000);
    await h2.worker.heartbeat();
    f.timers.set(f.now + 4_000);
    await h2.worker.heartbeat();
    expect(controlFile(f.stateDir).read(NO_CONTROL).latches.killRearmedAtMs).toBe(at);
    expect(ownerLines(f.stateDir)).toHaveLength(3);
    expect(w.sent.at(-1)!['acked']).toContainEqual({ id: trip, result: 'applied' });
    await h2.worker.stop();
  });

  it('/review and /weekly each write only their own review moment; the R8 stop then counts only later trades', async () => {
    const f = await latchedWorker();
    const w = watchdog();
    const h = makeWorker({ stateDir: f.stateDir, timers: f.timers, key: 'k', http: w.http });
    expect(await h.worker.reconcile()).toEqual({ ok: true });
    w.reply([{ id: 'r', kind: 'review', trip: `review-${f.r8At}` }]);
    f.timers.set(f.now + 1_000);
    await h.worker.heartbeat();
    const reviewedAt = h.timers.now();
    expect(controlFile(f.stateDir).read(NO_CONTROL).latches).toEqual({ ...f.latches, lossReviewedAtMs: reviewedAt });
    w.reply([{ id: 'w', kind: 'weekly', trip: `weekly-${f.latches.weeklyTrippedAtMs}` }]);
    f.timers.set(f.now + 2_000);
    await h.worker.heartbeat();
    expect(controlFile(f.stateDir).read(NO_CONTROL).latches).toEqual({ ...f.latches, lossReviewedAtMs: reviewedAt, weeklyReviewedAtMs: h.timers.now() });
    w.reply(undefined);
    f.timers.set(f.now + 3_000);
    await h.worker.heartbeat();
    const review = w.sent.at(-1)!['review'] as Record<string, unknown>;
    expect(review['review']).toBeNull();
    expect(review['weekly']).toBeNull();
    expect(review['rearm']).not.toBeNull();
    await h.worker.stop();
  });

  it('before the start reconcile nothing is reported or handled: the watchdog keeps the command', async () => {
    const f = await latchedWorker();
    const w = watchdog();
    const h = makeWorker({ stateDir: f.stateDir, timers: f.timers, key: 'k', http: w.http });
    const trip = `rearm-${f.latches.killTrippedAtMs}`;
    w.reply([{ id: trip, kind: 'rearm', trip }]);
    await h.worker.heartbeat();
    expect(w.sent[0]!['review']).toBeNull();
    expect(controlFile(f.stateDir).read(NO_CONTROL)).toEqual({ ...NO_CONTROL, latches: f.latches });
    await h.worker.stop();
  });
});
