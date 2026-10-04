// When each position's entry fill was booked (EXIT-1f N2): live, at the fill's own moment, or during a boot's reconcile,
// where a status read can book a fill found after downtime later than it landed. Placed from the journal's start and
// reconcile lines only (nothing new is saved); a booking the journal cannot place with certainty stays exact, with why.

export type BookedWhen = 'live' | 'reconcile' | `unplaced: ${string}`;

interface Line { readonly kind?: unknown; readonly boot?: unknown; readonly ts?: unknown }

/**
 * Places each booking (position id → booked ms) against the boots in `journalText`: the latest boot started at or before
 * it decides. Booked between that boot's start and its reconcile line (either outcome): `reconcile`; after the reconcile
 * line: `live`. No such boot, no reconcile line for it, or an unreadable journal: unplaced, with the reason.
 */
export const placeBookings = (journalText: string | null, booked: Readonly<Record<string, number>>): Record<string, BookedWhen> => {
  const out: Record<string, BookedWhen> = {};
  if (journalText === null) {
    for (const pid of Object.keys(booked)) out[pid] = 'unplaced: no journal';
    return out;
  }
  const boots = new Map<string, { start: number; reconcile: number | null }>();
  let unreadable = false;
  for (const raw of journalText.split('\n')) {
    if (raw.trim() === '') continue;
    let l: Line;
    try {
      l = JSON.parse(raw) as Line;
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
  for (const [pid, at] of Object.entries(booked)) {
    if (unreadable) {
      out[pid] = 'unplaced: a journal line could not be read';
      continue;
    }
    let boot: { start: number; reconcile: number | null } | null = null;
    for (const b of boots.values()) if (b.start <= at && (boot === null || b.start >= boot.start)) boot = b;
    if (boot === null) out[pid] = 'unplaced: no boot started before the booking';
    else if (boot.reconcile === null) out[pid] = 'unplaced: that boot has no reconcile line';
    else out[pid] = at <= boot.reconcile ? 'reconcile' : 'live';
  }
  return out;
};
