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
import { COMMAND_TTL_MS, OFFER_KEEP_MS, type HandledCommand, type OpenStops, handleCommand, commandsOf, openStops, tripId, withOverrideTag } from '../src/run/owner-review.ts';
import { controlFile, NO_CONTROL } from '../src/run/state.ts';
import type { HttpRequest } from '../src/providers/index.ts';
import { replySigned, sendHeartbeat, signReply } from '../src/run/heartbeat.ts';
import { sign, signReply as watchdogSignReply } from '../../ops/src/watchdog/logic.ts';
import { SOL_PRICE_KEY } from '../src/engine/strategy.ts';
import { type MicroUsd, microUsdToLamports } from '../../core/src/units/index.ts';
import { MINT, Market, SOL_PRICE, makeWorker, passingMarket, tempState, until } from './worker-harness.ts';
import { markedHistory } from '../src/engine/marks.ts';

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
    openStops({ latches: l, closed: trades, loss: LOSS, netLamports: (from, to) => BigInt(to - from), snapshot: null, codes: [], latchable: true, toLamports: (v) => v * 10n, dayLine: 1_500_000n, offer: 7 });

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
    const day = (codes: string[], l: Latches = NO_LATCHES, snapshot: RiskSnapshot | null = snap, latchable = true) =>
      openStops({ latches: l, closed: [], loss: LOSS, netLamports: () => 0n, snapshot, codes, latchable, toLamports: (v) => v * 10n, dayLine: 1_500_000n, offer: 7 });
    const at = (o: Partial<DayOverride>): Latches => ({ ...NO_LATCHES, dayOverride: { atMs: DAY + 1, dayStartMs: DAY, dayLossAt: null, streak: true, count: 1, ...o } });

    it('is open while risk shows a day-level stop, with the day loss and limit in SOL, and names the day and its overrides', () => {
      const s = day(['daily_loss', 'loss_cooldown', 'entries_per_day']).override;
      expect(s?.trip).toBe(`override-${DAY}-0`);
      expect(s?.evidence).toEqual({ daily: 1, streak: 2, day_loss_lamports: '16000000', day_line_lamports: '15000000', overrides: 0, day_ends_ms: melbourneDay(T).end, offer: 7 });
      expect(day(['loss_day_pause']).override?.evidence).toMatchObject({ daily: 0, streak: 2 });
      expect(day(['daily_loss']).override?.evidence).toMatchObject({ daily: 1, streak: 0 });
      // Not a day-level stop, or no valuation yet: nothing to override.
      expect(day(['loss_review', 'weekly_review', 'kill_switch']).override).toBeNull();
      expect(day(['daily_loss'], NO_LATCHES, null).override).toBeNull();
      // A valuation not fully marked at a fresh SOL price is not evidence: nothing to override.
      expect(day(['daily_loss', 'loss_cooldown'], NO_LATCHES, snap, false).override).toBeNull();
      // Yesterday's override does not count toward today's.
      expect(day(['daily_loss'], at({ dayStartMs: DAY - 86_400_000, count: 3 })).override?.trip).toBe(`override-${DAY}-0`);
      expect(day(['daily_loss'], at({ count: 1 })).override?.trip).toBe(`override-${DAY}-1`);
    });

    it('applies only what was tripped: R7 from the loss at the override, the streak if a streak pause was open', () => {
      const apply = (codes: string[], l: Latches = NO_LATCHES) => {
        const s = day(codes, l);
        return handleCommand({ id: 'o', kind: 'override', trip: s.override!.trip, at: T, offer: 7 }, s, l, [], T, (k) => (k === 7 ? s.override!.dayLoss : undefined));
      };
      expect(apply(['daily_loss'])?.latches.dayOverride).toEqual({ atMs: T, dayStartMs: DAY, dayLossAt: 1_600_000n, streak: false, count: 1, firstAtMs: T });
      expect(apply(['loss_cooldown'])?.latches.dayOverride).toEqual({ atMs: T, dayStartMs: DAY, dayLossAt: null, streak: true, count: 1, firstAtMs: T });
      expect(apply(['daily_loss', 'loss_day_pause'], at({ count: 1 }))?.latches.dayOverride).toEqual({ atMs: T, dayStartMs: DAY, dayLossAt: 1_600_000n, streak: true, count: 2, firstAtMs: DAY + 1 });
      // The day's first override's moment is kept through later ones; yesterday's does not carry over.
      expect(apply(['daily_loss'], at({ count: 2, atMs: DAY + 50, firstAtMs: DAY + 7 }))?.latches.dayOverride?.firstAtMs).toBe(DAY + 7);
      expect(apply(['daily_loss'], at({ dayStartMs: DAY - 86_400_000, atMs: DAY - 5, firstAtMs: DAY - 9 }))?.latches.dayOverride?.firstAtMs).toBe(T);
      // Only the day override changes.
      const r = apply(['daily_loss'], { ...NO_LATCHES, killTrippedAtMs: 5 });
      expect({ ...r?.latches, dayOverride: undefined }).toEqual({ ...NO_LATCHES, killTrippedAtMs: 5, dayOverride: undefined });
      // An earlier override's confirm (count 0) after one was applied (count 1) is stale.
      const s = day(['daily_loss'], at({ count: 1 }));
      expect(handleCommand({ id: 'old', kind: 'override', trip: `override-${DAY}-0`, at: T }, s, at({ count: 1 }), [], T)?.entry.result).toBe('stale');
      // The offer the owner confirmed (supervisor ruling): its day loss was 1.6; the fresh valuation's is `snap`'s 1.6.
      const s7 = day(['daily_loss']);
      const confirm = (offered: bigint | undefined, offer: number | null = T - 1) =>
        handleCommand({ id: 'c', kind: 'override', trip: s7.override!.trip, at: T, offer }, s7, NO_LATCHES, [], T, () => offered);
      // The day got worse since the offer: not applied, `changed` (offered again with the new figures).
      expect(confirm(1_599_999n)?.entry.result).toBe('changed');
      expect(confirm(1_599_999n)?.latches).toBe(NO_LATCHES);
      // No worse: applied with the fresh figure, even when the offer showed more.
      expect(confirm(1_600_000n)?.latches.dayOverride?.dayLossAt).toBe(1_600_000n);
      expect(confirm(1_700_000n)?.latches.dayOverride?.dayLossAt).toBe(1_600_000n);
      // An offer this process never made (a restart in between), or none named: stale.
      expect(confirm(undefined)?.entry.result).toBe('stale');
      // An offer older than the kept window (its figures too old), named and not kept: `old`, not a changed trip.
      expect(handleCommand({ id: 'o2', kind: 'override', trip: s7.override!.trip, at: T, offer: T - OFFER_KEEP_MS - 1 }, s7, NO_LATCHES, [], T, () => undefined)?.entry.result).toBe('old');
      expect(handleCommand({ id: 'o3', kind: 'override', trip: s7.override!.trip, at: T, offer: T - OFFER_KEEP_MS }, s7, NO_LATCHES, [], T, () => undefined)?.entry.result).toBe('stale');
      expect(confirm(1_600_000n, null)?.entry.result).toBe('stale');
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
    // Judged at the decision: before the override, or unknown, is not tagged.
    expect(withOverrideTag('entry', { trade: 'p' }, o, T - 2)).toEqual({ trade: 'p' });
    expect(withOverrideTag('entry', { trade: 'p' }, o, T - 1)).toEqual({ trade: 'p', override: true });
    expect(withOverrideTag('entry', { trade: 'p' }, o, null)).toEqual({ trade: 'p' });
    // A second override that day replaces the first in the latches; an entry decided between the two still counts.
    const second: Latches = { ...NO_LATCHES, dayOverride: { atMs: T + 100, dayStartMs: day, dayLossAt: null, streak: true, count: 2, firstAtMs: T - 1 } };
    expect(withOverrideTag('entry', { trade: 'p' }, second, T)).toEqual({ trade: 'p', override: true });
    expect(withOverrideTag('entry', { trade: 'p' }, second, T - 2)).toEqual({ trade: 'p' });
  });

  it('reads only well-formed commands from the reply', () => {
    expect(commandsOf(undefined)).toEqual([]);
    expect(commandsOf('x')).toEqual([]);
    expect(commandsOf([null, 1, { id: 'bad id!', kind: 'rearm', trip: 'rearm-1' }, { id: 'a', kind: 'rearm' }, { id: 'b', kind: 'rearm', trip: 'rearm-1', at: 5 }, { id: 'c', kind: 'rearm', trip: 'rearm-1', at: 1.5 }]))
      .toEqual([{ id: 'b', kind: 'rearm', trip: 'rearm-1', at: 5, offer: null }, { id: 'c', kind: 'rearm', trip: 'rearm-1', at: null, offer: null }]);
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
    expect(await beat((v1) => `t=1800000000,v1=${signReply('k', 1_800_000_000, v1, text)}`)).toEqual({ ok: true, paused: false, signed: true, commands: [{ id: 'a', kind: 'rearm', trip: 'rearm-1', at: 1, offer: null }] });
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
    w.reply([{ id: `${stop!.trip}:${stop!.evidence['offer']}`, kind: 'override', trip: stop!.trip, offer: stop!.evidence['offer'] }]);
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

  it('/override is offered and applied only on a fully marked valuation: an unknown mark\'s total-loss stand-in is not evidence', async () => {
    // A held position whose marking the test steers (as the RISK-LATCH review does), plus a $1.60 loss closed today:
    // R7 ($1.50) trips either way; with the mark unknown, risk counts the position as a total loss on top.
    const seam = { lost: false, more: false, unmarked: false };
    const mark: typeof markedHistory = (h0, held, sol, nowMs, st) => {
      const lost = { mint: 'MintD' as never, openedAtMs: nowMs - 120_000, closedAtMs: nowMs - 60_000, notional: 3_000_000n as never, netPnl: -1_600_000n as never, stoppedOut: true };
      const again = { ...lost, mint: 'MintE' as never, openedAtMs: nowMs - 100_000, closedAtMs: nowMs - 50_000 };
      const extra = [...(seam.lost ? [lost] : []), ...(seam.more ? [again] : [])];
      const r = markedHistory({ ...h0, closedTrades: [...h0.closedTrades, ...extra] }, held, sol, nowMs, st);
      return seam.unmarked ? { ...r, openPositions: r.openPositions.map((o) => ({ ...o, mark: null, markAtMs: null })) } : r;
    };
    const clock = { now: () => 0 };
    const w = watchdog(() => clock.now());
    const h = makeWorker({ markedHistory: mark, key: 'k', http: w.http });
    clock.now = () => h.timers.now();
    expect(await h.worker.reconcile()).toEqual({ ok: true });
    const m = await passingMarket(h);
    const read = h.worker.feed.releasedThrough;
    m.tradesStart(read - 100n);
    m.accountsRead(read);
    const held = () => Object.values(h.worker.book.positions).find((p) => String(p.mint) === MINT);
    expect(await until(m, 40_000, () => held()?.status === 'open', () => { m.slot(); m.pool(); })).toBe(true);
    const tick = (): void => {
      m.slot();
      m.chainSwap('buy', m.chainState.baseReserve / 1_000_000n, h.worker.feed.openSlot);
      m.solPrice();
    };
    const offered = async () => {
      await h.worker.heartbeat();
      return (w.sent.at(-1)!['review'] as Record<string, { trip: string; evidence: Record<string, unknown> } | null>)['override'];
    };
    // Unmarked: R7 trips on the stand-in, but nothing is offered, and a confirm of the day's trip is stale.
    seam.lost = true;
    seam.unmarked = true;
    await until(m, 2_000, () => false, tick);
    expect(held()?.status).toBe('open');
    expect(await offered()).toBeNull();
    const trip = `override-${melbourneDay(h.timers.now()).start}-0`;
    w.reply([{ id: trip, kind: 'override', trip, offer: 1 }]);
    await h.worker.heartbeat();
    w.reply(undefined);
    expect(controlFile(h.stateDir).read(NO_CONTROL).latches.dayOverride ?? null).toBeNull();
    expect(controlFile(h.stateDir).read(NO_CONTROL).commands?.map((c) => [c.id, c.result])).toEqual([[trip, 'stale']]);
    // The same day with fresh marks: offered, and applied with the real day loss (the $1.60 plus the position's real move).
    seam.unmarked = false;
    await until(m, 2_000, () => false, tick);
    const stop = await offered();
    expect(stop?.trip).toBe(trip);
    w.reply([{ id: `${trip}:2`, kind: 'override', trip, offer: stop!.evidence['offer'] }]);
    await h.worker.heartbeat();
    const o = controlFile(h.stateDir).read(NO_CONTROL).latches.dayOverride;
    // The real loss: the $1.60 and the position's marked move, below the total-loss stand-in ($1.60 plus its notional),
    // and the very figure the owner saw in SOL (the offer's evidence).
    const notional = accountFile(h.stateDir).read(null as never).trades.find((t) => t.positionId === held()!.id)!.notional;
    expect(o?.dayLossAt).toBeGreaterThan(1_600_000n);
    expect(o?.dayLossAt).toBeLessThan(1_600_000n + BigInt(notional));
    expect(String(microUsdToLamports(o!.dayLossAt!, SOL_PRICE as MicroUsd, 'ceil'))).toBe(stop?.evidence['day_loss_lamports']);
    // Before the override the line shown was the plain limit ($1.50).
    expect(stop?.evidence['day_line_lamports']).toBe(String(microUsdToLamports(1_500_000n as MicroUsd, SOL_PRICE as MicroUsd, 'ceil')));
    // Another $1.60 lost: R7 trips again past the moved line, and the second offer shows that line, not the plain limit.
    w.reply(undefined);
    seam.more = true;
    await until(m, 2_000, () => false, tick);
    const again = await offered();
    expect(again?.trip).toBe(`override-${melbourneDay(h.timers.now()).start}-1`);
    expect(again?.evidence['day_line_lamports']).toBe(String(microUsdToLamports((o!.dayLossAt! + 1_500_000n) as MicroUsd, SOL_PRICE as MicroUsd, 'ceil')));
    expect(again?.evidence).toMatchObject({ daily: 1, overrides: 1 });
    await h.worker.stop();
  });

  it('an entry line is tagged `override` by its decision moment: decided before the override and filled after is not', async () => {
    /** One paper entry from a fresh state, with an override (or none) already in control.json; its journal lines. */
    const enter = async (dayOverride: DayOverride | null) => {
      // control.json is read when the worker is made, so it is written first.
      const stateDir = tempState();
      if (dayOverride !== null) controlFile(stateDir).write({ ...NO_CONTROL, latches: { ...NO_LATCHES, dayOverride } });
      const h = makeWorker({ stateDir });
      expect(await h.worker.reconcile()).toEqual({ ok: true });
      const m = await passingMarket(h, { heldPoolFacts: true });
      const entered = () => lines(h.stateDir).some((l) => l['kind'] === 'entry');
      expect(await until(m, 30_000, entered, () => { m.slot(); m.pool(); })).toBe(true);
      const all = lines(h.stateDir);
      await h.worker.stop();
      const entry = all.find((l) => l['kind'] === 'entry')!;
      const decided = all.find((l) => l['kind'] === 'decision' && JSON.stringify(l).includes(String(entry['intent'])))!;
      return { entry, decidedAt: Date.parse(String(decided['ts'])), filledAt: Date.parse(String(entry['ts'])) };
    };
    const first = await enter(null);
    expect(first.entry['override']).toBeUndefined();
    expect(first.decidedAt).toBeLessThan(first.filledAt);
    const day = melbourneDay(first.decidedAt).start;
    const o = (atMs: number): DayOverride => ({ atMs, dayStartMs: day, dayLossAt: null, streak: true, count: 1, firstAtMs: atMs });
    // The same run (the harness is deterministic) with the override given after the decision (whose line is written at
    // or after its moment) and before the fill: the fill's line is not tagged.
    const between = await enter(o(first.filledAt - 1));
    expect([between.decidedAt, between.filledAt]).toEqual([first.decidedAt, first.filledAt]);
    expect(between.entry['override']).toBeUndefined();
    // With it in force from the start of that day: tagged.
    expect((await enter(o(day + 1))).entry['override']).toBe(true);
  });

  it('/override applies the figures the owner confirmed or better: worse since the offer is `changed` and offered again; a restart makes it stale', async () => {
    // A held position, fully marked, and steered losses closed today: $1.60, and a further $0.40 when `more` is set.
    const seam = { lost: false, more: false };
    const mark: typeof markedHistory = (h0, held, sol, nowMs, st) => {
      const t = (mint: string, net: bigint, at: number) => ({ mint: mint as never, openedAtMs: at - 60_000, closedAtMs: at, notional: 3_000_000n as never, netPnl: net as never, stoppedOut: true });
      const extra = [...(seam.lost ? [t('MintF', -1_600_000n, nowMs - 60_000)] : []), ...(seam.more ? [t('MintG', -400_000n, nowMs - 50_000)] : [])];
      return markedHistory({ ...h0, closedTrades: [...h0.closedTrades, ...extra] }, held, sol, nowMs, st);
    };
    const clock = { now: () => 0 };
    const w = watchdog(() => clock.now());
    let h = makeWorker({ markedHistory: mark, key: 'k', http: w.http });
    clock.now = () => h.timers.now();
    expect(await h.worker.reconcile()).toEqual({ ok: true });
    let m = await passingMarket(h);
    const read = h.worker.feed.releasedThrough;
    m.tradesStart(read - 100n);
    m.accountsRead(read);
    expect(await until(m, 40_000, () => Object.values(h.worker.book.positions).some((p) => p.status === 'open'), () => { m.slot(); m.pool(); })).toBe(true);
    const tick = (): void => {
      m.slot();
      m.chainSwap('buy', m.chainState.baseReserve / 1_000_000n, h.worker.feed.openSlot);
      m.solPrice();
    };
    type Offer = { trip: string; evidence: Record<string, unknown> };
    const loss = (o: Offer) => BigInt(String(o.evidence['day_loss_lamports']));
    const offer = async (): Promise<Offer> => {
      w.reply(undefined);
      await until(m, 2_000, () => false, tick);
      await h.worker.heartbeat();
      return (w.sent.at(-1)!['review'] as Record<string, Offer | null>)['override']!;
    };
    const confirm = async (o: Offer) => {
      w.reply([{ id: `${o.trip}:${o.evidence['offer']}`, kind: 'override', trip: o.trip, offer: o.evidence['offer'] }]);
      await h.worker.heartbeat();
      w.reply(undefined);
      return controlFile(h.stateDir).read(NO_CONTROL);
    };
    // Worse after the offer: the owner saw about $1.60, the day is now $0.40 worse: `changed`, nothing written.
    seam.lost = true;
    const a = await offer();
    seam.more = true;
    await until(m, 2_000, () => false, tick);
    let ctl = await confirm(a);
    expect(ctl.commands?.at(-1)?.result).toBe('changed');
    expect(ctl.latches.dayOverride ?? null).toBeNull();
    // Offered again (same trip) with the new figure.
    const b = await offer();
    expect(b.trip).toBe(a.trip);
    expect(loss(b)).toBeGreaterThan(loss(a));
    // A restart between that offer and its confirm: the new process never made it, so the confirm is stale.
    await h.worker.stop();
    h = makeWorker({ markedHistory: mark, key: 'k', http: w.http, stateDir: h.stateDir, timers: h.timers });
    expect(await h.worker.reconcile()).toEqual({ ok: true });
    m = new Market(h, { heldPoolFacts: true });
    await until(m, 2_000, () => false, () => { m.slot(); m.pool(); m.solPrice(); });
    ctl = await confirm(b);
    expect(ctl.commands?.at(-1)?.result).toBe('stale');
    expect(ctl.latches.dayOverride ?? null).toBeNull();
    // Offered by the new process; the day then gets better before the confirm, which applies with the fresh, lower
    // figure: never a looser line than the one the owner saw.
    const c = await (async () => {
      w.reply(undefined);
      await until(m, 2_000, () => false, () => { m.slot(); m.pool(); m.solPrice(); });
      await h.worker.heartbeat();
      return (w.sent.at(-1)!['review'] as Record<string, Offer | null>)['override']!;
    })();
    expect(c.trip).toBe(a.trip);
    seam.more = false;
    await until(m, 2_000, () => false, () => { m.slot(); m.pool(); m.solPrice(); });
    ctl = await confirm(c);
    expect(ctl.commands?.at(-1)?.result).toBe('applied');
    const applied = microUsdToLamports(ctl.latches.dayOverride!.dayLossAt!, SOL_PRICE as MicroUsd, 'ceil');
    expect(applied).toBeLessThan(loss(c));
    await h.worker.stop();
  });


  it('/override offers are kept by time, not by count: a confirm 70 heartbeats and 17 minutes later applies; one past the window is `old`', async () => {
    const seam = { lost: false };
    const mark: typeof markedHistory = (h0, held, sol, nowMs, st) => {
      const lost = { mint: 'MintH' as never, openedAtMs: nowMs - 120_000, closedAtMs: nowMs - 60_000, notional: 3_000_000n as never, netPnl: -1_600_000n as never, stoppedOut: true };
      return markedHistory(seam.lost ? { ...h0, closedTrades: [...h0.closedTrades, lost] } : h0, held, sol, nowMs, st);
    };
    const clock = { now: () => 0 };
    const w = watchdog(() => clock.now());
    const h = makeWorker({ markedHistory: mark, key: 'k', http: w.http });
    clock.now = () => h.timers.now();
    expect(await h.worker.reconcile()).toEqual({ ok: true });
    const m = await passingMarket(h);
    const read = h.worker.feed.releasedThrough;
    m.tradesStart(read - 100n);
    m.accountsRead(read);
    expect(await until(m, 40_000, () => Object.values(h.worker.book.positions).some((p) => p.status === 'open'), () => { m.slot(); m.pool(); })).toBe(true);
    seam.lost = true;
    await until(m, 2_000, () => false, () => { m.slot(); m.chainSwap('buy', m.chainState.baseReserve / 1_000_000n, h.worker.feed.openSlot); m.solPrice(); });
    type Offer = { trip: string; evidence: Record<string, unknown> };
    const beat = async (atMs: number): Promise<Offer> => {
      h.timers.set(atMs);
      await h.worker.heartbeat();
      return (w.sent.at(-1)!['review'] as Record<string, Offer | null>)['override']!;
    };
    const confirm = async (o: Offer, atMs: number) => {
      w.reply([{ id: `${o.trip}:${o.evidence['offer']}`, kind: 'override', trip: o.trip, offer: o.evidence['offer'] }]);
      await beat(atMs);
      w.reply(undefined);
      return controlFile(h.stateDir).read(NO_CONTROL).commands?.at(-1)?.result;
    };
    const t0 = h.timers.now();
    // Past the window (the 15-minute confirm window plus 5): the figures are too old.
    const a = await beat(t0 + 1);
    expect(await confirm(a, t0 + 1 + OFFER_KEEP_MS + 1_000)).toBe('old');
    // 70 heartbeats a second apart after an offer (more than the 64 once kept), and the confirm 17 minutes after it
    // (inside the 15-minute window's 5-minute margin): it applies.
    const t1 = h.timers.now();
    const b = await beat(t1 + 1_000);
    for (let i = 2; i <= 71; i++) await beat(t1 + i * 1_000);
    expect(await confirm(b, t1 + 1_000 + 17 * 60_000)).toBe('applied');
    await h.worker.stop();
  });
});
