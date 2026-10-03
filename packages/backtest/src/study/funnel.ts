// The funnel, gate by gate (consensus of the three reviews, 2026-10-04: "funnel first"). Every check inside the entry
// window is counted once at the stage where it stopped: the first hard gate (in H1…H16 order) it failed, then setup,
// stop distance, a busy book, risk, or entry. A gate failure is "adverse" when the evidence was read and said no, and
// "not covered" when the evidence was missing, stale, partial or outside what the dataset holds (a lead-in mint, a
// deployer without its prior trades, no funding source): those are not rejects of the setup, and are never shown as
// such. Each distinct mint is also counted once, at the furthest stage any of its checks reached. The research run
// (each candidate on its own, no account) and the deployment replay (one account, its limits) are counted apart.
import { type EvidenceCode, HARD_GATES, type HardGate, type HardResult } from '../../../core/src/gates/index.ts';

// Every EvidenceCode of the gates: the evidence was not there to judge. The record type fails to compile when the
// gates add an evidence code this list lacks.
const EVIDENCE: Record<EvidenceCode, true> = { missing: true, malformed: true, future: true, stale: true, degraded: true, gap: true, 'not-covered': true, inconsistent: true };
export const NOT_COVERED_CODES: ReadonlySet<string> = new Set(Object.keys(EVIDENCE));

export const STAGES = [...HARD_GATES, 'market data', 'setup', 'stop distance', 'book busy', 'risk', 'entered'] as const;
export type Stage = (typeof STAGES)[number];
export type StopClass = 'adverse' | 'not covered';

export interface StageCount {
  readonly adverse: number;
  readonly notCovered: number;
}

export interface FunnelSummary {
  /** Checks inside the entry window. */
  readonly checks: number;
  /** Distinct mints with a check inside the entry window. */
  readonly mints: number;
  /** Checks by the stage where they stopped ('entered' counts entries). */
  readonly checksAt: Readonly<Record<string, StageCount>>;
  /** Mints by the furthest stage any of their checks reached. */
  readonly mintsAt: Readonly<Record<string, StageCount>>;
  /** Every gate failure (not only the first), by gate: how often each gate said no or could not judge. */
  readonly gateFailures: Readonly<Record<string, StageCount>>;
  /** Checks whose every failed gate was "not covered": the evidence alone stopped them. */
  readonly evidenceOnly: number;
}

/** The first failed gate in H1…H16 order and its class; a reason that names the gate it serves is counted there. */
export const firstStop = (g: HardResult): { gate: HardGate; cls: StopClass } | null => {
  const by = gateClasses(g);
  for (const gate of HARD_GATES) {
    const cls = by.get(gate);
    if (cls !== undefined) return { gate, cls };
  }
  return null;
};

/** Every failed gate with its class: adverse when any of its reasons is adverse. */
export const gateClasses = (g: HardResult): Map<HardGate, StopClass> => {
  const out = new Map<HardGate, StopClass>();
  for (const r of g.reasons) {
    const gate = ('neededBy' in r && r.neededBy !== undefined ? r.neededBy : r.gate) as HardGate;
    const cls: StopClass = NOT_COVERED_CODES.has(r.code) ? 'not covered' : 'adverse';
    if (out.get(gate) !== 'adverse') out.set(gate, cls);
  }
  return out;
};

const add = (m: Record<string, { adverse: number; notCovered: number }>, k: string, cls: StopClass) => {
  const c = (m[k] ??= { adverse: 0, notCovered: 0 });
  if (cls === 'adverse') c.adverse++;
  else c.notCovered++;
};

class TagFunnel {
  readonly checksAt: Record<string, { adverse: number; notCovered: number }> = {};
  readonly gateFailures: Record<string, { adverse: number; notCovered: number }> = {};
  readonly best = new Map<string, { index: number; cls: StopClass }>();
  checks = 0;
  evidenceOnly = 0;
}

/** Counts by tag (U1, U2, S0-U1, …): a universe's funnel is never pooled with another's. */
export class Funnel {
  readonly #tags = new Map<string, TagFunnel>();

  /** One check stopped at `stage` (or entered). `gates` is the hard-reject result when the gates were evaluated. */
  record(tag: string, mint: string, stage: Stage, cls: StopClass, gates?: HardResult): void {
    let f = this.#tags.get(tag);
    if (f === undefined) this.#tags.set(tag, (f = new TagFunnel()));
    f.checks++;
    add(f.checksAt, stage, cls);
    if (gates !== undefined && !gates.pass) {
      const by = gateClasses(gates);
      for (const [gate, c] of by) add(f.gateFailures, gate, c);
      if (by.size > 0 && [...by.values()].every((c) => c === 'not covered')) f.evidenceOnly++;
    }
    const index = STAGES.indexOf(stage);
    const prev = f.best.get(mint);
    if (prev === undefined || index > prev.index || (index === prev.index && prev.cls === 'not covered' && cls === 'adverse')) f.best.set(mint, { index, cls });
  }

  /** The hard gates' part of a check: the first failed gate, or nothing when they all passed. True when it stopped. */
  gates(tag: string, mint: string, g: HardResult): boolean {
    const stop = firstStop(g);
    if (stop === null) return false;
    this.record(tag, mint, stop.gate, stop.cls, g);
    return true;
  }

  summary(): Record<string, FunnelSummary> {
    const order = (m: Record<string, StageCount>) => Object.fromEntries(STAGES.filter((s) => m[s] !== undefined).map((s) => [s, m[s]!]));
    return Object.fromEntries([...this.#tags.keys()].sort().map((tag) => {
      const f = this.#tags.get(tag)!;
      const mintsAt: Record<string, { adverse: number; notCovered: number }> = {};
      for (const b of f.best.values()) add(mintsAt, STAGES[b.index]!, b.cls);
      return [tag, { checks: f.checks, mints: f.best.size, checksAt: order(f.checksAt), mintsAt: order(mintsAt), gateFailures: order(f.gateFailures), evidenceOnly: f.evidenceOnly }];
    }));
  }
}

/** Plain lines for a report: stage, checks (adverse / not covered) and mints. */
export const funnelLines = (f: FunnelSummary): string[] => {
  const n = (c: StageCount | undefined, s: Stage) => (c === undefined ? '0' : s === 'entered' ? String(c.adverse + c.notCovered) : `${c.adverse + c.notCovered} (${c.adverse} adverse, ${c.notCovered} not covered)`);
  return [
    `${f.checks} checks on ${f.mints} mints; ${f.evidenceOnly} checks stopped by missing evidence alone`,
    ...STAGES.filter((s) => f.checksAt[s] !== undefined || f.mintsAt[s] !== undefined).map((s) => `${s}: checks ${n(f.checksAt[s], s)}; mints ${n(f.mintsAt[s], s)}`),
  ];
};
