import { describe, expect, it } from 'vitest';
import type { Health } from '../../runner/src/contract.ts';
import { heartbeatBody } from '../src/run/heartbeat.ts';

describe('local disk health', () => {
  it('never sends disk health to the watchdog and leaves the local payload intact', () => {
    const disk = { free_bytes: 100, total_bytes: 1000, recorder_bytes: 25, days_to_full: 1, recorder: 'paused' as const, entries_refused: true };
    const approved: Omit<Health, 'disk'> = {
      seq: 4, ts: 123, git_sha: 'a'.repeat(40), policy_version: 'test', last_processed_slot: 1,
      feed_ages_ms: { helius: 15, unknown: null }, open_position: null, open_positions: [], pending_exits: [],
      unresolved_intents: { count: 0, oldest_age_s: null, trades: [] }, signer: 'none', lease_epoch: null,
      sol_reserve: null, paused: false, boot: 'test', pid: 1, uptime_s: 2, rss_bytes: 100,
      mode: 'paper', recorder: 'on', simulation: 'on', reconciled: true, exit_capable: true,
      quota: [], lookups: { counts: [] }, entries_halted: false, halt_reasons: [], critical: [], feeds: {},
      journal_seq: 1, signing_key: false,
    };
    const h: Health = { ...approved, disk };
    const position = { mint: 'coin', qty: 2, entry: 3, stop: 1, mark: 4, last_exit_attempt_ts: null };
    const body = JSON.parse(heartbeatBody(h, position, '42')) as Record<string, unknown>;
    expect(body).not.toHaveProperty('disk');
    expect(body).toEqual({ ...approved, feed_ages_ms: { helius: 15 }, open_position: position, owner_chat_id: '42' });
    expect(h.disk).toBe(disk);
    expect(h.feed_ages_ms).toEqual({ helius: 15, unknown: null });
  });
});
