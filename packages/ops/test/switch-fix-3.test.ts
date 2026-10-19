// Card SWITCH-FIX-3 SW-34: recorder.retention_failed is a held code: one ALERT that says what to check, STILL once a
// day, CLEARED when a retention step works again.
import { describe, expect, it } from 'vitest';
import { evaluate, HELD_CODES, limitsFrom, planAlerts, type Heartbeat } from '../src/watchdog/logic.ts';

describe('SW-34: recorder.retention_failed is held, with what to check', () => {
  const T0 = 1_800_000_000_000;
  const L = limitsFrom({});
  const hb = (critical: string[]): Heartbeat => ({ seq: 1, ts: T0, boot: 'b1', git_sha: 'a'.repeat(40), policy_version: 'stub', last_processed_slot: null, feed_ages_ms: {},
    open_position: null, unresolved_intents: { count: 0, oldest_age_s: null }, signer: 'not-ready', lease_epoch: null, sol_reserve: null, paused: false, critical });
  const at = (critical: string[]) => evaluate({ hb: hb(critical), receivedAt: T0 }, T0, L, { slot: null, heldMints: null });

  it('ALERT names the log line and the disk; STILL once a day; CLEARED (fails before: hourly, no text)', () => {
    expect(HELD_CODES.has('recorder.retention_failed')).toBe(true);
    const first = planAlerts({}, at(['recorder.retention_failed']), T0, L);
    expect(first.lines).toEqual(['ALERT Worker critical: recorder.retention_failed. The database retention keeps failing: check the recorder.retention_failed lines (error_code) in the journal, and the disk and the database file (ops/README.md).']);
    let state = first.next;
    const lines: string[] = [];
    for (let m = 1; m <= 25 * 60; m++) {
      const r = planAlerts(state, at(['recorder.retention_failed']), T0 + m * 60_000, L);
      lines.push(...r.lines);
      state = r.next;
    }
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^STILL Worker critical: recorder\.retention_failed\..*\(since 1440 min\)$/);
    expect(planAlerts(state, at([]), T0 + 26 * 3_600_000, L).lines[0]).toMatch(/^CLEARED Worker critical: recorder\.retention_failed\./);
  });
});
