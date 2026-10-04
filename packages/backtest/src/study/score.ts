// The scoring stage (docs/ARCHITECTURE.md §13, §16.1): outcomes are computed after a run, outside the engine, from
// its final book and the fill model's records. Nothing here is reachable from the engine or the strategy.
import type { FillConfig } from '../../../core/src/config/index.ts';
import type { FunderRead } from '../../../core/src/facts/index.ts';
import type { ClusteredReturn, TradeOutcome } from '../../../core/src/stats/index.ts';
import type { LogRecord } from '../../../core/src/engine/index.ts';
import { melbourneDay } from '../report.ts';
import type { RunResult } from '../run.ts';
import { type StrayCost, type TradeRecord, tradesOf } from '../trades.ts';

/** A trade with its universe tag (U1, U2, S0-U1, S0-U2) and its labels. */
export interface ScoredTrade extends TradeOutcome, ClusteredReturn {
  readonly tag: string;
  readonly mint: string;
  readonly openedAt: number;
  readonly closedAt: number;
  readonly net: string;
  readonly entrySol: string;
  readonly exitReason: TradeRecord['exitReason'];
  /** Still held when the data ended (valued at the last rung's quote): its window was not fully observed. */
  readonly censored: boolean;
  /** Sensitivity line: the same trade with the token-account rent never returned (reported, never gating). */
  readonly rNetNoRent: number;
  /**
   * Failed entries of its tag this trade carries (audit B5): each landed fee, at its own time. `net`, `rNet` and
   * `rNetNoRent` already include them; the SPA's daily series books each on its own day.
   */
  readonly stray: readonly StrayCharge[];
}

/** One failed entry's landed fee (lamports, decimal), at its landing time. */
export interface StrayCharge {
  readonly at: number;
  readonly lamports: string;
}

/** The universe tag of a study position id `p:<tag>:<mint>`. */
export const tagOf = (positionId: string): string => positionId.split(':')[1] ?? '?';

/** Net return on the entry spend, all costs included (§13.1 r_net); severe at −50% or worse, or blocked (y_severe). */
/**
 * G2's resampling clusters (STATS-1b). Creator: the deployer named in the entry's log line. Funder: the dev's first
 * funder, read point in time by the same reader as live (the insider-funding supplement, core facts/funding.ts). A trade
 * without either label has none: G2 fails it as missing evidence (the stricter outcome; supervisor ruling). There is
 * no shared "unknown" cluster and no singleton for an unknown, either of which would loosen the gate.
 */
export const NO_CLUSTER = '';
/** The dev's first funder of a mint, or null when the read was incomplete or there is none. */
export type FunderOf = (mint: string) => string | null;

/** G2's funder label from the insider-funding supplement's rows: the dev's own read, complete and with a funder. */
export const devFunderOf = (rows: ReadonlyMap<string, { readonly creator: string; readonly reads: readonly FunderRead[] }> | undefined): FunderOf => (mint) => {
  const r = rows?.get(mint);
  const dev = r?.reads.find((x) => x.wallet === r.creator);
  return dev !== undefined && dev.complete && dev.funder !== null ? dev.funder : null;
};
const creatorsOf = (records: readonly LogRecord[]): Map<string, string> => {
  const out = new Map<string, string>();
  for (const rec of records) {
    if (rec.type !== 'decision' || rec.reasons[0] !== 'enter') continue;
    const c = rec.reasons.find((x) => x.startsWith('creator '));
    if (c !== undefined) out.set(`${rec.reasons[1]}|${rec.reasons[2]}`, c.slice('creator '.length));
  }
  return out;
};

/**
 * Every trade of a run with its labels, and the failed-entry fees no trade carries (audit B5). A failed entry is a
 * real cost of the strategy that decided it: its fee is charged to the next trade of the same tag opened at or after
 * it (else the tag's last trade before it), so the per-trade inputs of G1, G2 and the power estimate carry it without
 * adding a trade; a tag with no trade at all keeps it in `uncarried`, which the portfolio and SPA series still book.
 */
export const scoreRunAll = (r: RunResult, fills: FillConfig, funderOf: FunderOf = () => null): { readonly trades: ScoredTrade[]; readonly uncarried: readonly (StrayCharge & { readonly tag: string })[] } => {
  const { trades, stray } = tradesOf(r, fills);
  const creators = creatorsOf(r.records);
  const charged = new Map<number, StrayCost[]>();
  const uncarried: (StrayCharge & { tag: string })[] = [];
  for (const s of [...stray].sort((a, b) => a.at - b.at || (a.intentId < b.intentId ? -1 : a.intentId > b.intentId ? 1 : 0))) {
    const tag = tagOf(s.positionId);
    let k = -1;
    trades.forEach((t, j) => {
      if (tagOf(t.id) !== tag) return;
      const best = k < 0 ? null : trades[k]!;
      const after = t.openedAt >= s.at;
      if (best === null) return void (k = j);
      const bestAfter = best.openedAt >= s.at;
      // The earliest trade at or after the failed entry; with none, the latest before it.
      if (after ? !bestAfter || t.openedAt < best.openedAt : !bestAfter && t.openedAt > best.openedAt) k = j;
    });
    if (k < 0) uncarried.push({ tag, at: s.at, lamports: s.lamports.toString() });
    else charged.set(k, [...(charged.get(k) ?? []), s]);
  }
  return {
    uncarried,
    trades: trades.map((t, j) => {
      const mine = charged.get(j) ?? [];
      const fee = mine.reduce((a, s) => a + s.lamports, 0n);
      const net = t.net - fee;
      const rNet = Number(net) / Number(t.entrySol);
      const rNetNoRent = Number(net - t.rentReturned) / Number(t.entrySol);
      const blocked = t.exitReason === 'blocked';
      return {
        tag: tagOf(t.id), mint: t.mint, day: melbourneDay(t.openedAt), rNet, ySevere: blocked || rNet <= -0.5, blocked,
        openedAt: t.openedAt, closedAt: t.closedAt, net: net.toString(), entrySol: t.entrySol.toString(), exitReason: t.exitReason,
        censored: blocked && t.closedAt >= r.endedAt, rNetNoRent, stray: mine.map((s) => ({ at: s.at, lamports: s.lamports.toString() })),
        creatorCluster: creators.get(`${tagOf(t.id)}|${t.mint}`) ?? NO_CLUSTER, funderCluster: funderOf(t.mint) ?? NO_CLUSTER,
      };
    }),
  };
};

/** The trades of `scoreRunAll`, each carrying its tag's failed-entry fees. */
export const scoreRun = (r: RunResult, fills: FillConfig, funderOf: FunderOf = () => null): ScoredTrade[] => scoreRunAll(r, fills, funderOf).trades;

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
