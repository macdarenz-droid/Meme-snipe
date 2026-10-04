// EXIT-1f N2: where a position's entry fill booking sits against the boots, from the journal's start and reconcile lines.
import { describe, expect, it } from 'vitest';
import { placeBookings } from '../src/run/booked.ts';

const line = (boot: string, kind: string, ms: number, extra: Record<string, unknown> = {}) => JSON.stringify({ seq: 1, ts: new Date(ms).toISOString(), boot, kind, ...extra });
const journal = (...lines: string[]) => `${lines.join('\n')}\n`;

describe('booking placement (EXIT-1f N2)', () => {
  const j = journal(
    line('boot-1', 'start', 1_000), line('boot-1', 'reconcile', 2_000, { ok: true }),
    line('boot-2', 'start', 10_000), line('boot-2', 'reconcile', 12_000, { ok: false }),
    line('boot-3', 'start', 20_000),
  );
  it('a booking after its boot\'s reconcile line is live; one between the start and reconcile lines is at the reconcile', () => {
    expect(placeBookings(j, { a: 5_000, b: 1_500, c: 2_000, d: 1_000 })).toEqual({ a: 'live', b: 'reconcile', c: 'reconcile', d: 'reconcile' });
  });
  it('a failed reconcile still closes its boot\'s reconcile window', () => {
    expect(placeBookings(j, { a: 11_000, b: 13_000 })).toEqual({ a: 'reconcile', b: 'live' });
  });
  it('what the journal cannot place stays unplaced, with why', () => {
    expect(placeBookings(j, { a: 500, b: 25_000 })).toEqual({ a: 'unplaced: no boot started before the booking', b: 'unplaced: that boot has no reconcile line' });
    expect(placeBookings(null, { a: 5_000 })).toEqual({ a: 'unplaced: no journal' });
    expect(placeBookings(`${j}{not json\n`, { a: 5_000 })).toEqual({ a: 'unplaced: a journal line could not be read' });
  });
});
