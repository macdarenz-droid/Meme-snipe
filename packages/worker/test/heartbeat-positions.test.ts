// ALERT-EXIT N3: the heartbeat carries every open position, and the watchdog checks each one's stop, so raising maxOpen
// never leaves a position unwatched. ALERT-EXIT B1: a blocked exit is a critical line of its own.
import { describe, expect, it } from 'vitest';
import type { PositionState } from '../../core/src/lifecycle/index.ts';
import { evaluate, limitsFrom, parseHeartbeat } from '../../ops/src/watchdog/logic.ts';
import type { Health } from '../../runner/src/contract.ts';
import { heartbeatBody, heartbeatPositions } from '../src/run/heartbeat.ts';
import { entryPrice, exitCritical } from '../src/run/open-positions.ts';

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
