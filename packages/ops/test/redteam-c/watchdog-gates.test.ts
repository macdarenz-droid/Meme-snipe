// RED TEAM C probes: watchdog checks that fail OPEN on what the release worker really sends. Each test asserts the
// correct behaviour, so it FAILS on the current code.
import { describe, expect, it } from 'vitest';
import { evaluate, limitsFrom, parseHeartbeat, type Stored } from '../../src/watchdog/logic.ts';
import { heartbeatBody } from '../../../worker/src/run/heartbeat.ts';
import type { Health } from '../../../runner/src/contract.ts';

const L = limitsFrom({});
const T0 = 1_800_000_000_000;
const noChain = { slot: null, heldMints: null };

/** The release worker's /health in the fields the watchdog reads (worker.ts health(), ~line 2666). */
const health = (over: Partial<Record<keyof Health, unknown>> = {}): Health =>
  ({
    seq: 1, ts: T0, git_sha: 'a'.repeat(40), policy_version: 'v', last_processed_slot: null, feed_ages_ms: {},
    open_position: null, open_positions: [], pending_exits: [], unresolved_intents: { count: 0, oldest_age_s: null, trades: [] },
    signer: 'none', lease_epoch: null, sol_reserve: null, paused: false, boot: 'b1', pid: 1, uptime_s: 1, rss_bytes: 1,
    mode: 'paper', recorder: 'on', simulation: 'on', reconciled: true, exit_capable: true,
    ...over,
  }) as unknown as Health;

const judged = (h: Health) => {
  const hb = parseHeartbeat(heartbeatBody(h, null, null));
  expect(hb).not.toBeNull();
  const s: Stored = { hb: hb!, receivedAt: T0 };
  return evaluate(s, T0, L, noChain).map((a) => a.key);
};

describe('watchdog SOL reserve floor (security.md 5.2)', () => {
  it('alerts when the worker reports a wallet of 0.01 SOL (floor 0.02 SOL)', () => {
    // worker.ts:2674 sends `sol_reserve: String(walletLamports)`: lamports, as a decimal string (contract.ts:110).
    // logic.ts:163 only checks `num(hb.sol_reserve)` (a finite number, in SOL), so this reserve is never compared.
    expect(judged(health({ sol_reserve: String(10_000_000n) }))).toContain('reserve');
  });

  it('alerts at 0 lamports (an empty wallet)', () => {
    expect(judged(health({ sol_reserve: '0' }))).toContain('reserve');
  });
});

describe('watchdog stuck-intent check', () => {
  it('alerts on unresolved intents whose age the worker cannot give', () => {
    // worker.ts:2205 records an intent's time only for propose_entry, in memory (#intentAt): every exit intent, and
    // every intent restored after a restart, is reported with oldest_age_s null (desk.ts:397). logic.ts:159 needs a
    // number, so a stuck exit (count > 0) never raises the intent alert.
    expect(judged(health({ unresolved_intents: { count: 1, oldest_age_s: null, trades: ['t1'] } }))).toContain('intent');
  });
});
