// RUN-1c's `coverage_gap` journal lines, from FEED-1's coverage facts (`coverage:<name>:start|gap|resume`). A gap of a
// discovery stream is journaled when it opens (`to_ts` null) and again when it closes, under one `gap_id`; a bounded
// gap reported at once is one line spanning its slots (400 ms each, the slot target, since the chain gives no times
// for slots it missed). Streams are the coverage name's first part: `creates`, `rugs`, `trades` (`trades:<pool>`).
const SLOT_MS = 400;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const iso = (ms: number): string => new Date(ms).toISOString();

export class CoverageJournal {
  readonly #write: (fields: Readonly<Record<string, unknown>>) => void;
  /** Open gaps by id, with when they opened and their watch. */
  readonly #open = new Map<string, { readonly stream: string; readonly via: string; readonly fromMs: number }>();

  constructor(write: (fields: Readonly<Record<string, unknown>>) => void) {
    this.#write = write;
  }

  get open(): number {
    return this.#open.size;
  }

  /** A coverage fact as it arrived (its key, its value and its receipt time). */
  fact(key: string, value: unknown, atMs: number): void {
    const m = /^coverage:(.+):(start|gap|resume)$/.exec(key);
    if (m === null) return;
    const name = m[1]!;
    const kind = m[2]!;
    const v = isObj(value) && isObj(value['value']) ? value['value'] : isObj(value) ? value : null;
    if (v === null || typeof v['via'] !== 'string') return;
    const via = v['via'];
    const stream = name.split(':')[0]!;
    const id = `${name}|${via}|${String(v['fromSlot'] ?? 'unknown')}`;
    const close = (gid: string, reason: string): void => {
      const g = this.#open.get(gid);
      if (g === undefined) return;
      this.#open.delete(gid);
      this.#write({ stream: g.stream, gap_id: gid, from_ts: iso(g.fromMs), to_ts: iso(Math.max(atMs, g.fromMs)), reason, coverage: name, via });
    };
    if (kind === 'start') {
      // A new start on a watch settles its open gaps: the range before it was missed.
      for (const [gid, g] of [...this.#open]) if (g.via === via && gid.startsWith(`${name}|`)) close(gid, 'watch started again');
      return;
    }
    if (kind === 'resume') {
      close(id, 'restored by backfill');
      return;
    }
    const reason = typeof v['reason'] === 'string' ? v['reason'] : 'gap';
    if (v['toSlot'] === null) {
      if (this.#open.has(id)) return;
      this.#open.set(id, { stream, via, fromMs: atMs });
      this.#write({ stream, gap_id: id, from_ts: iso(atMs), to_ts: null, reason, coverage: name, via });
      return;
    }
    if (this.#open.has(id)) {
      close(id, reason);
      return;
    }
    const from = typeof v['fromSlot'] === 'bigint' ? v['fromSlot'] : null;
    const to = typeof v['toSlot'] === 'bigint' ? v['toSlot'] : null;
    const span = from !== null && to !== null && to >= from ? Number(to - from + 1n) * SLOT_MS : 0;
    this.#write({ stream, gap_id: id, from_ts: iso(atMs - span), to_ts: iso(atMs), reason, coverage: name, via, estimated_from_slots: true });
  }
}
