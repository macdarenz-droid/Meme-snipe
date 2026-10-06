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
/** Bounds for app-only retained state. An incomplete view is refused, never presented as a complete count. */
export const FUNNEL_KEYS_MAX = 200_000;

type Line = Readonly<Record<string, unknown>>;
type Stage = { day: string; stage: number; check: string | null };

const KINDS: readonly string[] = [SHORTLIST, 'reject', 'enter', 'no entry', 'risk approved'];

export class FunnelView {
  readonly rows: DecisionRow[] = [];
  readonly funnel: { fromMs: number; readonly stage: Map<string, Stage>; readonly enteredByDay: Map<string, number> };
  /** Trades counted as entered: one per trade, however many fill lines it has (partial fills). */
  readonly #entered = new Set<string>();
  #day: ReturnType<typeof melbourneDay>;
  #dayOverflow = false;
  #tradeOverflow = false;

  get available(): boolean {
    return !this.#dayOverflow && !this.#tradeOverflow;
  }

  /** Rotate the displayed day without forgetting the first-ever entry identity of a trade. */
  advance(nowMs: number): void {
    if (nowMs < this.#day.end) return;
    this.#day = melbourneDay(nowMs);
    this.funnel.fromMs = nowMs;
    this.funnel.stage.clear();
    this.funnel.enteredByDay.clear();
    this.rows.length = 0;
    this.#dayOverflow = false;
  }

  #rememberEntry(trade: string): boolean {
    if (this.#entered.has(trade)) return false;
    if (this.#entered.size >= FUNNEL_KEYS_MAX) {
      this.#tradeOverflow = true;
      return false;
    }
    this.#entered.add(trade);
    return true;
  }

  constructor(fromMs: number) {
    this.#day = melbourneDay(fromMs);
    this.funnel = { fromMs, stage: new Map(), enteredByDay: new Map() };
  }

  /** One journal line, as written (`seq`, `ts`, `kind` and its fields); any other kind, or a line without them, is ignored. */
  apply(l: Line): void {
    const atMs = typeof l['ts'] === 'string' ? Date.parse(l['ts']) : Number.NaN;
    if (!Number.isFinite(atMs) || typeof l['seq'] !== 'number' || !Number.isSafeInteger(l['seq']) || l['seq'] <= 0) return;
    if (l['kind'] !== 'decision' && l['kind'] !== 'entry') return;
    if (l['kind'] === 'decision') {
      if (typeof l['event'] !== 'string' || l['event'].length === 0 || l['event'].length > 256) return;
      const reasons = l['reasons'];
      if (!Array.isArray(reasons) || !reasons.every((x) => typeof x === 'string')) return;
      if (typeof reasons[2] !== 'string' || reasons[2].length === 0 || reasons[2].length > 128) return;
    } else {
      if (typeof l['trade'] !== 'string' || l['trade'].length === 0 || l['trade'].length > 256) return;
      if (typeof l['mint'] !== 'string' || l['mint'].length === 0 || l['mint'].length > 128) return;
    }
    // Before today's display window, entry lines still establish the first fill of a trade.
    if (atMs < this.#day.start) {
      if (l['kind'] === 'entry') this.#rememberEntry(l['trade'] as string);
      return;
    }
    this.advance(atMs);
    this.funnel.fromMs = this.#day.start;
    if (!this.available && l['kind'] === 'decision') return;
    if (l['kind'] === 'decision') this.#decision(l, atMs);
    else this.#entry(l, atMs);
  }

  #stageOf(mint: string, atMs: number): Stage | null {
    if (!this.funnel.stage.has(mint) && this.funnel.stage.size >= FUNNEL_KEYS_MAX) {
      this.#dayOverflow = true;
      return null;
    }
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
    if (st === null) return;
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
    if (typeof mint !== 'string' || typeof trade !== 'string' || !this.#rememberEntry(trade)) return;
    if (!this.available) return;
    const st = this.#stageOf(mint, atMs);
    if (st === null) return;
    st.stage = 4;
    const day = melbourneDate(atMs);
    this.funnel.enteredByDay.set(day, (this.funnel.enteredByDay.get(day) ?? 0) + 1);
    this.#push({ id: `entry/${trade}`, atMs, mint, outcome: 'entered', check: null, reasons: ['entry filled (paper)'], tradeId: trade });
  }
}

/**
 * The view as of a start at `nowMs`: today's (Melbourne) `decision` and `entry` lines of the journal at `path`, streamed
 * in file order. Earlier decisions, future lines, torn and malformed records are skipped. With valid lines today the view
 * counts from the start of the day; with none, from `nowMs`. Earlier entries seed first-fill dedupe only.
 */
export const rebuildFunnel = (path: string, nowMs: number): FunnelView => {
  const view = new FunnelView(nowMs);
  if (!existsSync(path)) return view;
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
    if (!Number.isFinite(at) || at > nowMs) continue;
    view.apply(l as Line);
  }
  return view;
};
