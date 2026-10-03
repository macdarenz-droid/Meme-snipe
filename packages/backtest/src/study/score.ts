// The scoring stage (docs/ARCHITECTURE.md §13, §16.1): outcomes are computed after a run, outside the engine, from
// its final book and the fill model's records. Nothing here is reachable from the engine or the strategy.
import type { FillConfig } from '../../../core/src/config/index.ts';
import type { TradeOutcome } from '../../../core/src/stats/index.ts';
import type { LogRecord } from '../../../core/src/engine/index.ts';
import { melbourneDay } from '../report.ts';
import type { RunResult } from '../run.ts';
import { type TradeRecord, tradesOf } from '../trades.ts';

/** A trade with its universe tag (U1, U2, S0-U1, S0-U2) and its labels. */
export interface ScoredTrade extends TradeOutcome {
  readonly tag: string;
  readonly mint: string;
  readonly openedAt: number;
  readonly closedAt: number;
  readonly net: string;
  readonly entrySol: string;
  readonly exitReason: TradeRecord['exitReason'];
  /** Still held when the data ended (valued at the last rung's quote): its window was not fully observed. */
  readonly censored: boolean;
}

/** The universe tag of a study position id `p:<tag>:<mint>`. */
export const tagOf = (positionId: string): string => positionId.split(':')[1] ?? '?';

/** Net return on the entry spend, all costs included (§13.1 r_net); severe at −50% or worse, or blocked (y_severe). */
export const scoreRun = (r: RunResult, fills: FillConfig): ScoredTrade[] => {
  const { trades } = tradesOf(r, fills);
  return trades.map((t) => {
    const rNet = Number(t.net) / Number(t.entrySol);
    const blocked = t.exitReason === 'blocked';
    return {
      tag: tagOf(t.id), mint: t.mint, day: melbourneDay(t.openedAt), rNet, ySevere: blocked || rNet <= -0.5, blocked,
      openedAt: t.openedAt, closedAt: t.closedAt, net: t.net.toString(), entrySol: t.entrySol.toString(), exitReason: t.exitReason,
      censored: blocked && t.closedAt >= r.endedAt,
    };
  });
};

/** Candidates (first check logged per universe and mint), entries and entry days per tag, from the log and fills only. */
export const countsOf = (r: RunResult): Record<string, { candidates: number; entries: number; entryDays: number }> => {
  const out: Record<string, { candidates: number; entries: number; days: Set<string> }> = {};
  const get = (tag: string) => (out[tag] ??= { candidates: 0, entries: 0, days: new Set() });
  const tagOfMint = new Map<string, string>();
  for (const rec of r.records) {
    if (rec.type !== 'decision') continue;
    if (rec.reasons[0] === 'candidate') get(rec.reasons[1]!).candidates++;
  }
  for (const p of Object.values(r.book.positions)) tagOfMint.set(`${p.entryIntentId}`, tagOf(p.id));
  for (const a of r.attempts) {
    if (a.purpose !== 'entry' || a.outcome !== 'filled' || a.landedAt === null) continue;
    const tag = tagOfMint.get(a.intentId);
    if (tag === undefined) throw new Error(`an entry fill without a study position (${a.intentId})`);
    get(tag).entries++;
    get(tag).days.add(melbourneDay(a.landedAt));
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, { candidates: v.candidates, entries: v.entries, entryDays: v.days.size }]));
};

/** The reject mix: how often each failing gate and code appeared, per tag (a G3 input and the calibration log). */
export const rejectMix = (records: readonly LogRecord[]): Record<string, Record<string, number>> => {
  const out: Record<string, Record<string, number>> = {};
  for (const rec of records) {
    if (rec.type !== 'decision') continue;
    const [kind, tag] = rec.reasons;
    if (tag === undefined) continue;
    const m = (out[tag] ??= {});
    const keys = kind === 'reject' ? rec.reasons.slice(3) : ['no setup', 'no entry', 'risk refused'].includes(kind!) ? [`${kind}: ${(rec.reasons[3] ?? '').replace(/[-\d]+/g, '#').slice(0, 60)}`] : [];
    for (const k of keys) m[k] = (m[k] ?? 0) + 1;
  }
  return out;
};
