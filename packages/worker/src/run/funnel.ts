// FUNNEL-PERSIST: the app's candidate views (the funnel, entries per day, the latest decisions) come from the journal's
// own lines, live and at a start alike. Live, every `decision` and `entry` line the worker writes is applied as written;
// at a start, today's lines (Melbourne time) already on disk are applied first, so a restart keeps Seen, the stages,
// the entries and the decision rows a worker that never stopped would show. Nothing new is stored: the journal is read.
import { melbourneDay } from '../../../core/src/risk/melbourne.ts';
import { GATE_REASONS_PREFIX, S0_DIAGNOSTIC_PREFIX, SHORTLIST } from '../engine/strategy.ts';
import { type DecisionRow, classify, melbourneDate } from './api.ts';
import { journalLines } from './booked.ts';
import { existsSync } from 'node:fs';

/** The latest decision rows kept for the app. */
export const DECISION_ROWS_MAX = 500;

type Line = Readonly<Record<string, unknown>>;
type Stage = { day: string; stage: number; check: string | null };

const KINDS: readonly string[] = [SHORTLIST, 'reject', 'enter', 'no entry', 'risk approved'];

export class FunnelView {
  readonly rows: DecisionRow[] = [];
  readonly funnel: { fromMs: number; readonly stage: Map<string, Stage>; readonly enteredByDay: Map<string, number> };
  /** Trades counted as entered: one per trade, however many fill lines it has (partial fills). */
  readonly #entered = new Set<string>();

  constructor(fromMs: number) {
    this.funnel = { fromMs, stage: new Map(), enteredByDay: new Map() };
  }

  /** One journal line, as written (`seq`, `ts`, `kind` and its fields); any other kind, or a line without them, is ignored. */
  apply(l: Line): void {
    const atMs = typeof l['ts'] === 'string' ? Date.parse(l['ts']) : Number.NaN;
    if (!Number.isFinite(atMs) || typeof l['seq'] !== 'number') return;
    if (l['kind'] === 'decision') this.#decision(l, atMs);
    else if (l['kind'] === 'entry') this.#entry(l, atMs);
  }

  #stageOf(mint: string, atMs: number): Stage {
    const st = this.funnel.stage.get(mint) ?? { day: melbourneDate(atMs), stage: 0, check: null };
    this.funnel.stage.set(mint, st);
    return st;
  }

  #push(row: DecisionRow): void {
    this.rows.push(row);
    if (this.rows.length > DECISION_ROWS_MAX) this.rows.splice(0, this.rows.length - DECISION_ROWS_MAX);
  }

  /** A candidate decision: its furthest stage and check, and a row for a reject or a window ended without an entry. */
  #decision(l: Line, atMs: number): void {
    const reasons = Array.isArray(l['reasons']) ? l['reasons'].filter((x): x is string => typeof x === 'string') : [];
    const [kind, , mint, why] = reasons;
    if (kind === undefined || mint === undefined || !KINDS.includes(kind)) return;
    const st = this.#stageOf(mint, atMs);
    const id = `${String(l['event'])}/${String(l['seq'])}`;
    if (kind === 'reject' && why !== undefined) {
      const { check, stage } = classify(why);
      st.check = check;
      st.stage = Math.max(st.stage, stage);
      // The typed reasons and the S0 diagnostic ride on the line as fields; the row serves them as reasons again.
      const typed = l['gate_reasons'] === undefined ? [] : [`${GATE_REASONS_PREFIX}${JSON.stringify(l['gate_reasons'])}`];
      const diag = Array.isArray(l['s0_diagnostic']) ? [`${S0_DIAGNOSTIC_PREFIX}${(l['s0_diagnostic'] as unknown[]).join(',')}`] : [];
      this.#push({ id, atMs, mint, outcome: 'rejected', check, reasons: [...reasons.slice(3), ...typed, ...diag], tradeId: null });
    } else if (kind === 'risk approved') {
      st.stage = Math.max(st.stage, 3);
      st.check = null;
    } else if (kind === 'no entry') {
      this.#push({ id, atMs, mint, outcome: 'no-trade', check: st.check, reasons: reasons.slice(3), tradeId: null });
    }
  }

  /** An entry fill: the candidate reached the last stage; counted once per trade on its first fill line. */
  #entry(l: Line, atMs: number): void {
    const mint = l['mint'];
    const trade = l['trade'];
    if (typeof mint !== 'string' || typeof trade !== 'string' || this.#entered.has(trade)) return;
    this.#entered.add(trade);
    this.#stageOf(mint, atMs).stage = 4;
    const day = melbourneDate(atMs);
    this.funnel.enteredByDay.set(day, (this.funnel.enteredByDay.get(day) ?? 0) + 1);
    this.#push({ id: `entry/${trade}`, atMs, mint, outcome: 'entered', check: null, reasons: ['entry filled (paper)'], tradeId: trade });
  }
}

/**
 * The view as of a start at `nowMs`: today's (Melbourne) `decision` and `entry` lines of the journal at `path`, streamed
 * in file order. Lines from before today, after `nowMs`, torn or unreadable are skipped. With any line of today the view
 * counts from the start of the day; with none, from `nowMs`, as a fresh worker always did.
 */
export const rebuildFunnel = (path: string, nowMs: number): FunnelView => {
  const day = melbourneDay(nowMs);
  const view = new FunnelView(nowMs);
  if (!existsSync(path)) return view;
  let any = false;
  for (const text of journalLines(path)) {
    // Cheap filters first: only decision and entry lines are parsed.
    if (!text.includes('"kind":"decision"') && !text.includes('"kind":"entry"')) continue;
    let l: unknown;
    try {
      l = JSON.parse(text);
    } catch {
      continue;
    }
    if (typeof l !== 'object' || l === null) continue;
    const ts = (l as Line)['ts'];
    const at = typeof ts === 'string' ? Date.parse(ts) : Number.NaN;
    if (!Number.isFinite(at) || at < day.start || at >= day.end || at > nowMs) continue;
    any = true;
    view.apply(l as Line);
  }
  if (any) view.funnel.fromMs = day.start;
  return view;
};
