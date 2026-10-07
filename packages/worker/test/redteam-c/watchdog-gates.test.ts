// RED TEAM C probes: watchdog checks that fail OPEN on what the release worker really sends. Each test asserts the
// correct behaviour, so it FAILS on the current code.
import { describe, expect, it } from 'vitest';
import { evaluate, limitsFrom, parseHeartbeat, statusText, type Stored } from '../../../ops/src/watchdog/logic.ts';
import { heartbeatBody } from '../../src/run/heartbeat.ts';
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

describe('RC-C5: the SOL reserve floor in lamports, end to end (worker health → signed body → watchdog)', () => {
  it('alerts just under the floor, never at it or just over it (0.02 SOL = 20,000,000 lamports)', () => {
    expect(judged(health({ sol_reserve: '19999999' }))).toContain('reserve');
    expect(judged(health({ sol_reserve: '20000000' }))).not.toContain('reserve');
    expect(judged(health({ sol_reserve: '20000001' }))).not.toContain('reserve');
  });

  it('follows a configured floor exactly, also one with 9 decimals', () => {
    const at = (floor: string, lamports: string) => {
      const hb = parseHeartbeat(heartbeatBody(health({ sol_reserve: lamports }), null, null))!;
      return evaluate({ hb, receivedAt: T0 }, T0, limitsFrom({ SOL_RESERVE_FLOOR: floor }), noChain).map((a) => a.key);
    };
    expect(at('1.5', '1499999999')).toContain('reserve');
    expect(at('1.5', '1500000000')).not.toContain('reserve');
    expect(at('0.000000003', '2')).toContain('reserve');
    expect(at('0.000000003', '3')).not.toContain('reserve');
    // More than 9 decimals rounds the floor up, never down (2.5 lamports: 3).
    expect(at('0.0000000025', '2')).toContain('reserve');
    expect(at('0.0000000025', '3')).not.toContain('reserve');
  });

  it('a reserve that cannot be read raises the alert; an unknown one (null) does not', () => {
    for (const bad of [0.01, 10_000_000, '', '-1', '1.5', '0x10', '01', ' 5', '18446744073709551616', true, {}]) {
      expect(judged(health({ sol_reserve: bad }))).toContain('reserve');
    }
    expect(judged(health({ sol_reserve: '18446744073709551615' }))).not.toContain('reserve');
    expect(judged(health({ sol_reserve: null }))).not.toContain('reserve');
  });

  it('names the amounts in SOL in the alert and in /status', () => {
    const hb = parseHeartbeat(heartbeatBody(health({ sol_reserve: '10000000' }), null, null))!;
    const a = evaluate({ hb, receivedAt: T0 }, T0, L, noChain).find((x) => x.key === 'reserve');
    expect(a?.text).toBe('SOL reserve 0.010000000 SOL is below the floor 0.020000000 SOL.');
    expect(statusText({ hb, receivedAt: T0 }, T0, null, {}, null)).toContain('SOL reserve: 0.010000000 SOL.');
  });
});

describe('RC-C5 sweep: the other numeric checks fail closed on a missing value', () => {
  it('a held position the worker reports with no stop (null) raises the stop alert', () => {
    const hb = parseHeartbeat(heartbeatBody(health(), { mint: 'MintA', qty: 1, entry: 2, stop: null as unknown as number, mark: 1, last_exit_attempt_ts: null }, null))!;
    expect(evaluate({ hb, receivedAt: T0 }, T0, L, noChain).map((a) => a.key)).toContain('stop');
    const ok = parseHeartbeat(heartbeatBody(health(), { mint: 'MintA', qty: 1, entry: 2, stop: 1, mark: 1.5, last_exit_attempt_ts: null }, null))!;
    expect(evaluate({ hb: ok, receivedAt: T0 }, T0, L, noChain).map((a) => a.key)).not.toContain('stop');
  });
});
