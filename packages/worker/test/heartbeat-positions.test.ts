// ALERT-EXIT N3: the heartbeat carries every open position, and the watchdog checks each one's stop, so raising maxOpen
// never leaves a position unwatched. ALERT-EXIT B1: a blocked exit is a critical line of its own.
import { describe, expect, it } from 'vitest';
import type { PositionState } from '../../core/src/lifecycle/index.ts';
import type { LogRecord } from '../../core/src/engine/index.ts';
import type { AlertCode } from '../../core/src/lifecycle/types.ts';
import { evaluate, limitsFrom, parseHeartbeat, planAlerts } from '../../ops/src/watchdog/logic.ts';
import type { Health } from '../../runner/src/contract.ts';
import { heartbeatBody, heartbeatPositions } from '../src/run/heartbeat.ts';
import { type AlertSeen, collectAlerts } from '../src/run/api.ts';
import { criticalLines, entryPrice, exitCritical } from '../src/run/open-positions.ts';

const pos = (id: string, status: PositionState['status'], blockedReason: string | null = null): PositionState =>
  ({ id, mint: `mint-${id}`, venue: 'pumpswap', entryIntentId: `e-${id}`, status, quantity: 1_000n, cost: 1_000_000n, bought: 1_000n, sold: 0n, exitOwner: null, exitSeq: 0, blockedReason }) as unknown as PositionState;

const health = (trades: string[], critical: string[] = []): Health =>
  ({ seq: 1, ts: 1_000, boot: 'b', git_sha: 'g', policy_version: 'v', last_processed_slot: null, feed_ages_ms: {}, open_position: null, open_positions: trades.map((trade) => ({ trade })), unresolved_intents: { count: 0, oldest_age_s: null, trades: [] }, signer: 'none', lease_epoch: null, sol_reserve: null, paused: false, critical }) as unknown as Health;

describe('the heartbeat\'s positions (ALERT-EXIT N3)', () => {
  const book = { a: pos('a', 'open'), b: pos('b', 'exit_blocked', 'no quote: no-liquidity') };
  const entry = Number(entryPrice(book.a));

  it('sends every open position in /health\'s order; the watchdog alerts on the second one\'s stop', () => {
    const list = heartbeatPositions(health(['a', 'b']), book, {
      stop: () => 500n,
      mark: (id) => (id === 'a' ? 900n : 400n),
      lastExitAt: (id) => (id === 'a' ? 7 : null),
    });
    expect(list).toEqual([
      { mint: 'mint-a', qty: 1_000, entry, stop: 500, mark: 900, last_exit_attempt_ts: 7 },
      { mint: 'mint-b', qty: 1_000, entry, stop: 500, mark: 400, last_exit_attempt_ts: null },
    ]);
    const hb = parseHeartbeat(heartbeatBody(health(['a', 'b']), list, null))!;
    expect(hb.open_position).toEqual(list[0]);
    expect(hb.open_positions).toEqual(list);
    expect(evaluate({ hb, receivedAt: 1_000 }, 1_000, limitsFrom({}), { slot: null, heldMints: null }).map((x) => x.key)).toEqual(['stop:mint-b']);
  });

  it('unknown stop and mark are null, never 0; none open is an empty list', () => {
    const list = heartbeatPositions(health(['a']), book, { stop: () => null, mark: () => null, lastExitAt: () => null });
    expect(list[0]).toMatchObject({ stop: null, mark: null, last_exit_attempt_ts: null });
    const hb = parseHeartbeat(heartbeatBody(health([]), [], null))!;
    expect(hb.open_position).toBeNull();
    expect(hb.open_positions).toEqual([]);
  });
});

describe('exitCritical (ALERT-EXIT B1)', () => {
  it('one line per position booked blocked, by id; open, closed and pending exits have none', () => {
    const lines = exitCritical([pos('b', 'exit_blocked', 'exit ladder used: 3 attempts on this position'), pos('a', 'open'), pos('c', 'exit_pending'), pos('x', 'closed'), pos('a2', 'exit_blocked')]);
    expect(lines).toEqual([
      'mint-a2: exit blocked, position a2 (no reason recorded)',
      'mint-b: exit blocked, position b (exit ladder used: 3 attempts on this position)',
    ]);
    expect(exitCritical([pos('a', 'open')])).toEqual([]);
  });
});

describe('every critical book alert reaches the owner (ALERT-EXIT, supervisor ruling)', () => {
  const rec = (ms: number, effects: { level: string; code: AlertCode; subject: string }[]): LogRecord =>
    ({ type: 'world', seq: 1, at: { slot: 1n, receivedAt: ms }, eventId: 'e', inputs: [], action: null, reasons: [], result: 'applied', effects: effects.map((e) => ({ effect: { type: 'alert', ...e }, dispatch: 'runner' })) }) as unknown as LogRecord;
  const L = limitsFrom({});
  const pushed = (critical: string[], active = {}, now = 10_000) => {
    const hb = parseHeartbeat(heartbeatBody(health([], critical), [], null))!;
    return planAlerts(active, evaluate({ hb, receivedAt: now }, now, L, { slot: null, heldMints: null }), now, L);
  };
  const CLASSES: readonly AlertCode[] = ['double_fill', 'oversold', 'unbooked_landing', 'late_landing', 'status_balance_mismatch'];

  for (const code of CLASSES) {
    it(`${code}: a critical line of its own, pushed at once, also while another alert is up`, () => {
      const alerts: AlertSeen[] = [];
      collectAlerts(alerts, rec(5_000, [{ level: 'critical', code, subject: 'i:1' }]));
      const lines = criticalLines(['MintA: no fresh price (timeout)'], [], alerts);
      expect(lines).toEqual(['MintA: no fresh price (timeout)', `${code} i:1 (at ${new Date(5_000).toISOString()})`]);
      // WATCH-1's alert is already up; the book's alert is pushed now, not at that alert's repeat.
      const before = pushed(['MintA: no fresh price (timeout)']);
      const after = pushed(lines, before.next, 70_000);
      expect(after.lines).toEqual([`ALERT Worker critical: ${code} i:1 (at ${new Date(5_000).toISOString()}).`]);
      // A second subject of the same class is a second alert.
      collectAlerts(alerts, rec(6_000, [{ level: 'critical', code, subject: 'i:2' }]));
      expect(pushed(criticalLines([], [], alerts)).lines).toHaveLength(2);
    });
  }

  it('warnings are not pushed; exit_blocked follows its position, not the alert history', () => {
    const alerts: AlertSeen[] = [];
    collectAlerts(alerts, rec(5_000, [
      { level: 'warn', code: 'restart_recovery', subject: 'book' }, { level: 'warn', code: 'orphan_cleared', subject: 'i:9' },
      { level: 'warn', code: 'cancel_after_broadcast', subject: 'i:8' }, { level: 'critical', code: 'exit_blocked', subject: 'a' },
    ]));
    // The exit was booked blocked, then an exit owned the position again: no line.
    expect(criticalLines([], [pos('a', 'exit_pending')], alerts)).toEqual([]);
    expect(criticalLines([], [pos('a', 'exit_blocked', 'no quote: x')], alerts)).toEqual(['mint-a: exit blocked, position a (no quote: x)']);
  });
});
