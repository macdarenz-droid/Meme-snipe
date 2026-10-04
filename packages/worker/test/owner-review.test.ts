// OWNER-REVIEW on the worker: the heartbeat reports each stop the owner can clear (trip id and SOL evidence) and the
// commands handled; a command from the reply is applied only for the worker's own open trip, writes only its own review
// moment into control.json, is journaled, and is never applied twice (a restart included).
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { melbourneDay } from '../../core/src/risk/melbourne.ts';
import { NO_LATCHES, type DayOverride, type Latches, type RiskSnapshot } from '../../core/src/risk/index.ts';
import { accountFile } from '../src/run/account.ts';
import { COMMAND_TTL_MS, type HandledCommand, type OpenStops, handleCommand, commandsOf, openStops, tripId, withOverrideTag } from '../src/run/owner-review.ts';
import { controlFile, NO_CONTROL } from '../src/run/state.ts';
import type { HttpRequest } from '../src/providers/index.ts';
import { replySigned, sendHeartbeat, signReply } from '../src/run/heartbeat.ts';
import { sign, signReply as watchdogSignReply } from '../../ops/src/watchdog/logic.ts';
import { SOL_PRICE_KEY } from '../src/engine/strategy.ts';
import { Market, SOL_PRICE, makeWorker } from './worker-harness.ts';

/** A fresh SOL/USD price and a new slot, then one worker step (the account valuation runs on it). */
const priced = (h: ReturnType<typeof makeWorker>, m: Market): void => {
  m.slot();
  m.fact(SOL_PRICE_KEY, { value: SOL_PRICE, atMs: m.now - 50 });
  h.worker.step();
};

const LOSS = { reviewWindowTrades: 20, reviewLosses: 5 };
const lines = (dir: string) => readFileSync(join(dir, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
const ownerLines = (dir: string) => lines(dir).filter((l) => l['kind'] === 'owner_command');

describe('owner commands against the open stops', () => {
  const T = 1_800_000_000_000;
  const latched: Latches = { ...NO_LATCHES, killTrippedAtMs: T - 600_000, weeklyTrippedAtMs: T - 1_200_000 };
  // Five losses, then a win: the window runs past the trip.
  const trades = [1, 2, 3, 4, 5, 6].map((i) => ({ mint: `M${i}`, openedAtMs: T - 7_200_000 + i, closedAtMs: T - 3_600_000 + i * 60_000, notional: 2_000_000n, netPnl: i === 6 ? 50_000n : -100_000n, stoppedOut: i !== 6 }) as never);
  // A stand-in sum that shows which closes it was asked for.
  const stops = (l: Latches): OpenStops =>
    openStops({ latches: l, closed: trades, loss: LOSS, netLamports: (from, to) => BigInt(to - from), snapshot: null, codes: [], toLamports: (v) => v * 10n, dailyLimit: 1_500_000n });

  it('names each open stop by kind and moment; a cleared one is not open', () => {
    const s = stops(latched);
    expect(s.review?.trip).toBe(tripId('review', T - 3_600_000 + 5 * 60_000));
    expect(s.review?.evidence).toEqual({ losses: 5, trades: 6, from_ms: T - 3_600_000 + 60_000, to_ms: T - 3_600_000 + 6 * 60_000, net_lamports: String(5 * 60_000) });
    expect(s.rearm).toMatchObject({ trip: `rearm-${T - 600_000}`, atMs: T - 600_000 });
    expect(s.weekly?.evidence['week_ends_ms']).toBeGreaterThan(T - 1_200_000);
    const cleared = stops({ ...latched, killRearmedAtMs: T - 1, weeklyReviewedAtMs: T - 1, lossReviewedAtMs: T - 1 });
    expect(cleared).toEqual({ review: null, rearm: null, weekly: null, override: null });
    // A re-arm at or before the trip clears nothing (evaluate.ts R10: strictly after).
    expect(stops({ ...latched, killRearmedAtMs: T - 600_000 }).rearm).not.toBeNull();
  });

  it('applies a command only to its own stop, only for its current trip, only strictly after the trip, and never twice', () => {
    const s = stops(latched);
    const rearm = { id: 'c1', kind: 'rearm', trip: s.rearm!.trip, at: T };
    const a = handleCommand(rearm, s, latched, [], T);
    expect(a?.entry).toEqual({ id: 'c1', kind: 'rearm', trip: s.rearm!.trip, result: 'applied', atMs: T });
    expect(a?.latches).toEqual({ ...latched, killRearmedAtMs: T });
    expect(handleCommand({ id: 'c2', kind: 'review', trip: s.review!.trip, at: T }, s, latched, [], T)?.latches).toEqual({ ...latched, lossReviewedAtMs: T });
    expect(handleCommand({ id: 'c3', kind: 'weekly', trip: s.weekly!.trip, at: T }, s, latched, [], T)?.latches).toEqual({ ...latched, weeklyReviewedAtMs: T });
    // Already handled: nothing.
    expect(handleCommand(rearm, s, latched, [a!.entry as HandledCommand], T + 1)).toBeNull();
    // Stale: an older trip, a trip of a stop not open, or a review moment not after the trip.
    expect(handleCommand({ id: 'c4', kind: 'rearm', trip: `rearm-${T - 600_001}`, at: T }, s, latched, [], T)?.entry.result).toBe('stale');
    expect(handleCommand({ id: 'c5', kind: 'rearm', trip: s.rearm!.trip, at: T }, stops({ ...latched, killTrippedAtMs: null }), { ...latched, killTrippedAtMs: null }, [], T)?.entry.result).toBe('stale');
    expect(handleCommand({ id: 'c6', kind: 'rearm', trip: s.rearm!.trip, at: T }, s, latched, [], T - 600_000)?.entry.result).toBe('stale');
    // Invalid: another kind's trip, an unknown kind or a malformed trip; the latches never change.
    for (const c of [{ id: 'c7', kind: 'review', trip: s.rearm!.trip, at: T }, { id: 'c8', kind: 'override', trip: 'override-1', at: T }, { id: 'c9', kind: 'rearm', trip: 'rearm-x', at: T }]) {
      const r = handleCommand(c, s, latched, [], T);
      expect(r?.entry.result).toBe('invalid');
      expect(r?.latches).toBe(latched);
    }
    expect(handleCommand({ ...rearm, id: 'c10', at: null }, s, latched, [], T)?.entry.result).toBe('invalid');
  });

  it('a confirm counts for 15 minutes on the worker clock, either way', () => {
    const s = stops(latched);
    const c = (at: number) => handleCommand({ id: 'x', kind: 'rearm', trip: s.rearm!.trip, at }, s, latched, [], T);
    expect(c(T - COMMAND_TTL_MS)?.entry.result).toBe('applied');
    expect(c(T + COMMAND_TTL_MS)?.entry.result).toBe('applied');
    expect(c(T - COMMAND_TTL_MS - 1)?.entry.result).toBe('expired');
    expect(c(T - COMMAND_TTL_MS - 1)?.latches).toBe(latched);
    expect(c(T + COMMAND_TTL_MS + 1)?.entry.result).toBe('expired');
  });

  describe('/override', () => {
    const DAY = melbourneDay(T).start;
    const snap = { dayStartMs: DAY, dayLoss: 1_600_000n, lossStreak: 2 } as unknown as RiskSnapshot;
    const day = (codes: string[], l: Latches = NO_LATCHES, snapshot: RiskSnapshot | null = snap) =>
      openStops({ latches: l, closed: [], loss: LOSS, netLamports: () => 0n, snapshot, codes, toLamports: (v) => v * 10n, dailyLimit: 1_500_000n });
    const at = (o: Partial<DayOverride>): Latches => ({ ...NO_LATCHES, dayOverride: { atMs: DAY + 1, dayStartMs: DAY, dayLossAt: null, streak: true, count: 1, ...o } });

    it('is open while risk shows a day-level stop, with the day loss and limit in SOL, and names the day and its overrides', () => {
      const s = day(['daily_loss', 'loss_cooldown', 'entries_per_day']).override;
      expect(s?.trip).toBe(`override-${DAY}-0`);
      expect(s?.evidence).toEqual({ daily: 1, streak: 2, day_loss_lamports: '16000000', day_limit_lamports: '15000000', overrides: 0, day_ends_ms: melbourneDay(T).end });
      expect(day(['loss_day_pause']).override?.evidence).toMatchObject({ daily: 0, streak: 2 });
      expect(day(['daily_loss']).override?.evidence).toMatchObject({ daily: 1, streak: 0 });
      // Not a day-level stop, or no valuation yet: nothing to override.
      expect(day(['loss_review', 'weekly_review', 'kill_switch']).override).toBeNull();
      expect(day(['daily_loss'], NO_LATCHES, null).override).toBeNull();
      // Yesterday's override does not count toward today's.
      expect(day(['daily_loss'], at({ dayStartMs: DAY - 86_400_000, count: 3 })).override?.trip).toBe(`override-${DAY}-0`);
      expect(day(['daily_loss'], at({ count: 1 })).override?.trip).toBe(`override-${DAY}-1`);
    });

    it('applies only what was tripped: R7 from the loss at the override, the streak if a streak pause was open', () => {
      const apply = (codes: string[], l: Latches = NO_LATCHES) => {
        const s = day(codes, l);
        return handleCommand({ id: 'o', kind: 'override', trip: s.override!.trip, at: T }, s, l, [], T);
      };
      expect(apply(['daily_loss'])?.latches.dayOverride).toEqual({ atMs: T, dayStartMs: DAY, dayLossAt: 1_600_000n, streak: false, count: 1 });
      expect(apply(['loss_cooldown'])?.latches.dayOverride).toEqual({ atMs: T, dayStartMs: DAY, dayLossAt: null, streak: true, count: 1 });
      expect(apply(['daily_loss', 'loss_day_pause'], at({ count: 1 }))?.latches.dayOverride).toEqual({ atMs: T, dayStartMs: DAY, dayLossAt: 1_600_000n, streak: true, count: 2 });
      // Only the day override changes.
      const r = apply(['daily_loss'], { ...NO_LATCHES, killTrippedAtMs: 5 });
      expect({ ...r?.latches, dayOverride: undefined }).toEqual({ ...NO_LATCHES, killTrippedAtMs: 5, dayOverride: undefined });
      // An earlier override's confirm (count 0) after one was applied (count 1) is stale.
      const s = day(['daily_loss'], at({ count: 1 }));
      expect(handleCommand({ id: 'old', kind: 'override', trip: `override-${DAY}-0`, at: T }, s, at({ count: 1 }), [], T)?.entry.result).toBe('stale');
      // Nothing open: stale.
      expect(handleCommand({ id: 'x', kind: 'override', trip: `override-${DAY}-0`, at: T }, day([]), NO_LATCHES, [], T)?.entry.result).toBe('stale');
    });
  });

  it('tags an entry line made while the day override holds, and nothing else', () => {
    const day = melbourneDay(T).start;
    const o: Latches = { ...NO_LATCHES, dayOverride: { atMs: T - 1, dayStartMs: day, dayLossAt: null, streak: true, count: 1 } };
    expect(withOverrideTag('entry', { trade: 'p' }, o, T)).toEqual({ trade: 'p', override: true });
    expect(withOverrideTag('exit', { trade: 'p' }, o, T)).toEqual({ trade: 'p' });
    expect(withOverrideTag('entry', { trade: 'p' }, NO_LATCHES, T)).toEqual({ trade: 'p' });
    expect(withOverrideTag('entry', { trade: 'p' }, o, melbourneDay(T).end)).toEqual({ trade: 'p' });
  });

  it('reads only well-formed commands from the reply', () => {
    expect(commandsOf(undefined)).toEqual([]);
    expect(commandsOf('x')).toEqual([]);
    expect(commandsOf([null, 1, { id: 'bad id!', kind: 'rearm', trip: 'rearm-1' }, { id: 'a', kind: 'rearm' }, { id: 'b', kind: 'rearm', trip: 'rearm-1', at: 5 }, { id: 'c', kind: 'rearm', trip: 'rearm-1', at: 1.5 }]))
      .toEqual([{ id: 'b', kind: 'rearm', trip: 'rearm-1', at: 5 }, { id: 'c', kind: 'rearm', trip: 'rearm-1', at: null }]);
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
  /**
   * A stand-in watchdog: signs its reply as the real one does (key 'k', bound to the heartbeat's signature) unless told
   * to send it unsigned, forged, or as an old signed reply replayed; each command is stamped with the confirm time `at`.
   */
  const watchdog = (now: () => number) => {
    const sent: Record<string, unknown>[] = [];
    let commands: Record<string, unknown>[] | undefined = undefined;
    let paused = false;
    let mode: 'signed' | 'unsigned' | 'forged' | 'replay' = 'signed';
    let saved: { text: string; sig: string } | null = null;
    let saveNext = false;
    const http = async (req: HttpRequest) => {
      sent.push(JSON.parse(req.body!) as Record<string, unknown>);
      const text = JSON.stringify({ ok: true, paused, ...(commands === undefined ? {} : { commands: commands.map((c) => ({ at: now(), ...c })) }) });
      const v1 = /v1=([0-9a-f]{64})$/.exec(req.headers!['x-zeroed-signature']!)![1]!;
      const t = Math.floor(now() / 1000);
      const sig = `t=${t},v1=${signReply(mode === 'forged' ? 'not-the-key' : 'k', t, v1, text)}`;
      const out = mode === 'replay' && saved !== null ? saved : { text, sig };
      if (saveNext) {
        saved = { text, sig };
        saveNext = false;
      }
      return { status: 200, header: (n: string) => (n === 'x-zeroed-signature' && mode !== 'unsigned' ? out.sig : null), text: out.text };
    };
    return { sent, http, reply: (c: Record<string, unknown>[] | undefined) => { commands = c; }, pause: (p: boolean) => { paused = p; }, mode: (m: typeof mode) => { mode = m; }, saveNext: () => { saveNext = true; } };
  };

  it('reports the open stops, applies a confirmed re-arm once, keeps the others, and acknowledges it, across a restart', async () => {
    const f = await latchedWorker();
    const w = watchdog(() => f.timers.now());
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
    const w = watchdog(() => f.timers.now());
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
    const w = watchdog(() => f.timers.now());
    const h = makeWorker({ stateDir: f.stateDir, timers: f.timers, key: 'k', http: w.http });
    const trip = `rearm-${f.latches.killTrippedAtMs}`;
    w.reply([{ id: trip, kind: 'rearm', trip }]);
    await h.worker.heartbeat();
    expect(w.sent[0]!['review']).toBeNull();
    expect(controlFile(f.stateDir).read(NO_CONTROL)).toEqual({ ...NO_CONTROL, latches: f.latches });
    await h.worker.stop();
  });
  it('a forged, unsigned or replayed reply never applies a command or lifts a pause; an unsigned pause still pauses', async () => {
    const f = await latchedWorker();
    const w = watchdog(() => f.timers.now());
    const h = makeWorker({ stateDir: f.stateDir, timers: f.timers, key: 'k', http: w.http });
    expect(await h.worker.reconcile()).toEqual({ ok: true });
    const trip = `rearm-${f.latches.killTrippedAtMs}`;
    const ctl = () => controlFile(f.stateDir).read(NO_CONTROL);
    // An old signed reply (pause) is kept for the replay below.
    w.pause(true);
    await h.worker.heartbeat();
    expect(ctl().paused).toBe(true);
    // Forged (wrong key) with the current trip: ignored, and its un-pause too.
    w.pause(false);
    w.reply([{ id: trip, kind: 'rearm', trip }]);
    w.mode('forged');
    f.timers.set(f.now + 1_000);
    await h.worker.heartbeat();
    expect(ctl().latches).toEqual(f.latches);
    expect(ctl().paused).toBe(true);
    // Unsigned: the same.
    w.mode('unsigned');
    f.timers.set(f.now + 2_000);
    await h.worker.heartbeat();
    expect(ctl().latches).toEqual(f.latches);
    expect(ctl().paused).toBe(true);
    expect(ctl().commands ?? []).toEqual([]);
    // An old signed un-pause replayed onto a new heartbeat does not fit it.
    w.reply(undefined);
    w.mode('signed');
    w.saveNext();
    f.timers.set(f.now + 3_000);
    await h.worker.heartbeat();
    expect(ctl().paused).toBe(false);
    w.pause(true);
    f.timers.set(f.now + 4_000);
    await h.worker.heartbeat();
    expect(ctl().paused).toBe(true);
    w.mode('replay');
    f.timers.set(f.now + 6_000);
    await h.worker.heartbeat();
    expect(ctl().paused).toBe(true);
    w.pause(false);
    // An unsigned pause still pauses (fail closed): first lift it with a signed reply.
    w.mode('signed');
    f.timers.set(f.now + 7_000);
    await h.worker.heartbeat();
    expect(ctl().paused).toBe(false);
    w.mode('unsigned');
    w.pause(true);
    f.timers.set(f.now + 8_000);
    await h.worker.heartbeat();
    expect(ctl().paused).toBe(true);
    // Signed, the command applies.
    w.mode('signed');
    w.reply([{ id: trip, kind: 'rearm', trip }]);
    f.timers.set(f.now + 9_000);
    await h.worker.heartbeat();
    expect(ctl().latches.killRearmedAtMs).toBe(f.now + 9_000);
    await h.worker.stop();
  });

  it('sendHeartbeat drops the commands of a reply that is not signed for this heartbeat', async () => {
    const text = JSON.stringify({ ok: true, paused: false, commands: [{ id: 'a', kind: 'rearm', trip: 'rearm-1', at: 1 }] });
    const beat = (sign: (v1: string) => string | null) =>
      sendHeartbeat(async (req) => ({ status: 200, header: () => sign(/v1=([0-9a-f]{64})$/.exec(req.headers!['x-zeroed-signature']!)![1]!), text }), 'https://w.test', 'k', '{}', 1_800_000_000_000);
    expect(await beat((v1) => `t=1800000000,v1=${signReply('k', 1_800_000_000, v1, text)}`)).toEqual({ ok: true, paused: false, signed: true, commands: [{ id: 'a', kind: 'rearm', trip: 'rearm-1', at: 1 }] });
    expect(await beat(() => null)).toEqual({ ok: true, paused: false, signed: false, commands: [] });
    expect(await beat((v1) => `t=1800000000,v1=${signReply('x', 1_800_000_000, v1, text)}`)).toEqual({ ok: true, paused: false, signed: false, commands: [] });
  });

  it('signs and checks the reply exactly as the watchdog does', async () => {
    const body = '{"ok":true,"paused":false}';
    const v1 = await sign('k', 1_800_000_000, 'POST', '/heartbeat', '{}');
    expect(signReply('k', 1_800_000_000, v1, body)).toBe(await watchdogSignReply('k', 1_800_000_000, '/heartbeat', v1, body));
    const header = `t=1800000000,v1=${signReply('k', 1_800_000_000, v1, body)}`;
    expect(replySigned('k', header, v1, body)).toBe(true);
    expect(replySigned('k', header, v1, `${body} `)).toBe(false);
    expect(replySigned('other', header, v1, body)).toBe(false);
    expect(replySigned('k', header, v1.replace(/^./, (c) => (c === '0' ? '1' : '0')), body)).toBe(false);
    expect(replySigned('k', null, v1, body)).toBe(false);
    expect(replySigned('k', 't=1,v1=zz', v1, body)).toBe(false);
  });

  it('a command confirmed more than 15 minutes before it reaches the worker is answered expired and changes nothing', async () => {
    const f = await latchedWorker();
    const w = watchdog(() => f.timers.now());
    const h = makeWorker({ stateDir: f.stateDir, timers: f.timers, key: 'k', http: w.http });
    expect(await h.worker.reconcile()).toEqual({ ok: true });
    const trip = `rearm-${f.latches.killTrippedAtMs}`;
    w.reply([{ id: trip, kind: 'rearm', trip, at: f.now - COMMAND_TTL_MS - 1_000 }]);
    f.timers.set(f.now + 1);
    await h.worker.heartbeat();
    const ctl = controlFile(f.stateDir).read(NO_CONTROL);
    expect(ctl.latches).toEqual(f.latches);
    expect(ctl.commands?.map((c) => c.result)).toEqual(['expired']);
    await h.worker.stop();
  });

  it('/override: a day stop from a real valuation is overridden by a signed confirm and the next valuation lets entries resume', async () => {
    const h0 = makeWorker();
    expect(await h0.worker.reconcile()).toEqual({ ok: true });
    const m0 = new Market(h0);
    await m0.run(2_000, 400, () => priced(h0, m0));
    await h0.worker.stop();
    const now = h0.timers.now();
    const file = accountFile(h0.stateDir);
    const a = file.read(null as never);
    // Two losses closed just now, $1 each: past the $1.50 daily limit, and two in a row (cooldown).
    const lost = 7_000_000n;
    const trades = [1, 2].map((i) => ({ positionId: `p:o:${i}`, mint: `MintO${i}`, openedAtMs: now - 120_000 + i, notional: 2_000_000n, closedAtMs: now - 60_000 + i * 1_000, netLamports: -lost, netPnl: -1_000_000n, stoppedOut: true, booked: -lost }));
    file.write({ ...a, walletLamports: a.walletLamports === null ? null : a.walletLamports - 2n * lost, trades } as never);
    expect(melbourneDay(now - 60_000).start).toBe(melbourneDay(now).start);
    const timers = h0.timers;
    const w = watchdog(() => timers.now());
    const h = makeWorker({ stateDir: h0.stateDir, timers, key: 'k', http: w.http });
    expect(await h.worker.reconcile()).toEqual({ ok: true });
    const m = new Market(h);
    await m.run(2_000, 400, () => priced(h, m));
    await h.worker.heartbeat();
    const stop = (w.sent.at(-1)!['review'] as Record<string, { trip: string; evidence: Record<string, unknown> } | null>)['override'];
    const dayStart = melbourneDay(timers.now()).start;
    expect(stop?.trip).toBe(`override-${dayStart}-0`);
    expect(stop?.evidence).toMatchObject({ daily: 1, streak: 2, overrides: 0 });
    w.reply([{ id: stop!.trip, kind: 'override', trip: stop!.trip }]);
    await h.worker.heartbeat();
    const applied = controlFile(h.stateDir).read(NO_CONTROL).latches.dayOverride;
    expect(applied).toMatchObject({ dayStartMs: dayStart, streak: true, count: 1 });
    expect(applied?.dayLossAt).toBeGreaterThanOrEqual(2_000_000n);
    w.reply(undefined);
    await m.run(2_000, 400, () => priced(h, m));
    await h.worker.heartbeat();
    expect((w.sent.at(-1)!['review'] as Record<string, unknown>)['override']).toBeNull();
    expect(ownerLines(h.stateDir).map((l) => [l['command'], l['result']])).toEqual([['override', 'applied']]);
    await h.worker.stop();
  });
});
