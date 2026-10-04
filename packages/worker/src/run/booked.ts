// When each position's entry fill was booked (EXIT-1f N2): live, at the fill's own moment, or during a boot's reconcile,
// where a status read can book a fill found after downtime later than it landed. Placed from the journal's start and
// reconcile lines only (nothing new is saved); a booking the journal cannot place with certainty stays exact, with why.
// The journal of a long run is large: it is streamed in chunks, every line is checked to be a whole record, and only
// start and reconcile lines are parsed (EXIT-1g N7).
import { closeSync, existsSync, openSync, readSync } from 'node:fs';

export type BookedWhen = 'live' | 'reconcile' | `unplaced: ${string}`;

interface Line { readonly kind?: unknown; readonly boot?: unknown; readonly ts?: unknown }
interface Boot { start: number; reconcile: number | null }

/** The journal's lines, read in chunks of `chunkBytes` (never the whole file at once). */
export function* journalLines(path: string, chunkBytes = 1 << 20): Generator<string> {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(chunkBytes);
    let rest = '';
    for (;;) {
      const n = readSync(fd, buf, 0, chunkBytes, null);
      if (n === 0) break;
      const text = rest + buf.toString('utf8', 0, n);
      const lines = text.split('\n');
      rest = lines.pop()!;
      yield* lines;
    }
    if (rest !== '') yield rest;
  } finally {
    closeSync(fd);
  }
}

// The journal writes JSON.stringify output, so a start or reconcile line holds this exact text, and a string value
// cannot (its quotes are escaped).
const KINDS = /"kind":"(start|reconcile)"/;

const bootsOf = (lines: Iterable<string>): { readonly boots: Map<string, Boot>; readonly unreadable: boolean } => {
  const boots = new Map<string, Boot>();
  let unreadable = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '') continue;
    // Every line must be a whole record; only the two kinds that place a booking are parsed.
    if (!line.startsWith('{') || !line.endsWith('}')) {
      unreadable = true;
      continue;
    }
    if (!KINDS.test(line)) continue;
    let l: Line;
    try {
      l = JSON.parse(line) as Line;
    } catch {
      unreadable = true;
      continue;
    }
    const ts = typeof l.ts === 'string' ? Date.parse(l.ts) : Number.NaN;
    if (typeof l.boot !== 'string' || !Number.isFinite(ts)) continue;
    if (l.kind === 'start' && !boots.has(l.boot)) boots.set(l.boot, { start: ts, reconcile: null });
    const b = boots.get(l.boot);
    if (l.kind === 'reconcile' && b !== undefined && b.reconcile === null) b.reconcile = ts;
  }
  return { boots, unreadable };
};

const place = (found: { readonly boots: Map<string, Boot>; readonly unreadable: boolean } | null, booked: Readonly<Record<string, number>>): Record<string, BookedWhen> => {
  const out: Record<string, BookedWhen> = {};
  for (const [pid, at] of Object.entries(booked)) {
    if (found === null) {
      out[pid] = 'unplaced: no journal';
      continue;
    }
    if (found.unreadable) {
      out[pid] = 'unplaced: a journal line could not be read';
      continue;
    }
    let boot: Boot | null = null;
    for (const b of found.boots.values()) if (b.start <= at && (boot === null || b.start >= boot.start)) boot = b;
    if (boot === null) out[pid] = 'unplaced: no boot started before the booking';
    else if (boot.reconcile === null) out[pid] = 'unplaced: that boot has no reconcile line';
    else out[pid] = at <= boot.reconcile ? 'reconcile' : 'live';
  }
  return out;
};

/**
 * Places each booking (position id → booked ms) against the boots in `journalText`: the latest boot started at or before
 * it decides. Booked between that boot's start and its reconcile line (either outcome): `reconcile`; after the reconcile
 * line: `live`. No such boot, no reconcile line for it, or an unreadable journal: unplaced, with the reason.
 */
export const placeBookings = (journalText: string | null, booked: Readonly<Record<string, number>>): Record<string, BookedWhen> =>
  place(journalText === null ? null : bootsOf(journalText.split('\n')), booked);

/** The same, streaming the journal file at `path` (absent: no journal). Nothing is read when there is nothing to place. */
export const placeBookingsAt = (path: string, booked: Readonly<Record<string, number>>): Record<string, BookedWhen> =>
  Object.keys(booked).length === 0 ? {} : place(existsSync(path) ? bootsOf(journalLines(path)) : null, booked);
