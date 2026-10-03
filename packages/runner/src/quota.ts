// Quota and coverage for the dry-run report (RUN-1c): provider credits by class with a monthly projection,
// historical-lookup latency, discovery coverage gaps, and the rejection rate by gate reason. Pure.
import { LOOKUP_BOUNDS_MS, type JournalLine, type QuotaStatus } from './contract.ts';

/** The last health values of one boot. Scheduler counters restart at 0 each boot, so a run's total is the sum over boots. */
export interface BootTotals {
  readonly quota: readonly QuotaStatus[];
  readonly lookups: { readonly counts: readonly number[] };
}

const MONTH_MS = 30 * 24 * 3_600_000;
type Four = [number, number, number, number];
const add4 = (a: Four, b: readonly number[]): Four => [a[0] + (b[0] ?? 0), a[1] + (b[1] ?? 0), a[2] + (b[2] ?? 0), a[3] + (b[3] ?? 0)];

export interface ProviderQuota {
  readonly provider: string;
  readonly credits_used: number;
  readonly credits_by_class: Four;
  readonly monthly_credits: number | null;
  /** credits_used scaled from the run's wall time to 30 days; null when the run had no time. */
  readonly projected_monthly: number | null;
  /** null for rate-only providers (no monthly budget). */
  readonly within_free_tier: boolean | null;
  readonly shed: Four;
}

export interface QuotaReport {
  readonly reported: boolean;
  readonly providers: readonly ProviderQuota[];
  /** P0 and P1 requests shed over the whole run (exits and position monitoring). Must be 0. */
  readonly exit_capacity_shed: number;
  readonly within_free_tier: boolean;
}

export const quotaReport = (boots: readonly BootTotals[], durationMs: number): QuotaReport => {
  const by = new Map<string, { used: number; cls: Four; shed: Four; monthly: number | null }>();
  for (const b of boots) {
    for (const q of b.quota) {
      const cur = by.get(q.provider) ?? { used: 0, cls: [0, 0, 0, 0] as Four, shed: [0, 0, 0, 0] as Four, monthly: q.monthly_credits };
      by.set(q.provider, { used: cur.used + q.credits_used, cls: add4(cur.cls, q.credits_by_class), shed: add4(cur.shed, q.shed), monthly: q.monthly_credits ?? cur.monthly });
    }
  }
  const providers = [...by].sort(([a], [b]) => a.localeCompare(b)).map(([provider, v]): ProviderQuota => {
    const projected = durationMs > 0 ? Math.ceil((v.used * MONTH_MS) / durationMs) : null;
    return {
      provider,
      credits_used: v.used,
      credits_by_class: v.cls,
      monthly_credits: v.monthly,
      projected_monthly: projected,
      within_free_tier: v.monthly === null ? null : projected !== null && projected <= v.monthly,
      shed: v.shed,
    };
  });
  return {
    reported: providers.length > 0,
    providers,
    exit_capacity_shed: providers.reduce((n, p) => n + p.shed[0] + p.shed[1], 0),
    within_free_tier: providers.length > 0 && providers.every((p) => p.within_free_tier !== false),
  };
};

export interface LookupLatency {
  readonly count: number;
  /** Upper bound of the bucket holding the median and p95, in ms; null when that bucket is the open-ended one. */
  readonly p50_ms_at_most: number | null;
  readonly p95_ms_at_most: number | null;
  readonly slower_than_last_bound: number;
}

export const lookupLatency = (boots: readonly BootTotals[]): LookupLatency => {
  const counts = new Array<number>(LOOKUP_BOUNDS_MS.length + 1).fill(0);
  for (const b of boots) b.lookups.counts.forEach((c, i) => (counts[Math.min(i, counts.length - 1)]! += c));
  const total = counts.reduce((a, c) => a + c, 0);
  const at = (q: number): number | null => {
    if (total === 0) return null;
    const rank = Math.ceil(q * total);
    let seen = 0;
    for (let i = 0; i < counts.length; i++) {
      seen += counts[i]!;
      if (seen >= rank) return LOOKUP_BOUNDS_MS[i] ?? null;
    }
    return null;
  };
  return { count: total, p50_ms_at_most: at(0.5), p95_ms_at_most: at(0.95), slower_than_last_bound: counts[counts.length - 1]! };
};

export type CoverageReport = Readonly<Record<string, StreamCoverage>>;

export interface StreamCoverage {
  readonly gaps: number;
  readonly open: number;
  readonly total_s: number;
  readonly longest_s: number;
}

/** Coverage gaps by discovery stream (creates, trades, rugs, …). An open gap runs to the end of the run. */
export const coverageGaps = (journal: readonly JournalLine[], endMs: number): Readonly<Record<string, StreamCoverage>> => {
  const out: Record<string, { gaps: number; open: number; total: number; longest: number }> = {};
  for (const l of journal) {
    if (l.kind !== 'coverage_gap') continue;
    const stream = typeof l['stream'] === 'string' ? l['stream'] : 'unknown';
    const from = Date.parse(String(l['from_ts']));
    const to = l['to_ts'] === null || l['to_ts'] === undefined ? Number.NaN : Date.parse(String(l['to_ts']));
    const open = Number.isNaN(to);
    const ms = Number.isNaN(from) ? 0 : Math.max(0, (open ? endMs : to) - from);
    const s = (out[stream] ??= { gaps: 0, open: 0, total: 0, longest: 0 });
    s.gaps += 1;
    if (open) s.open += 1;
    s.total += ms;
    s.longest = Math.max(s.longest, ms);
  }
  return Object.fromEntries(
    Object.entries(out)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, { gaps: v.gaps, open: v.open, total_s: Math.round(v.total / 100) / 10, longest_s: Math.round(v.longest / 100) / 10 }]),
  );
};

export interface Rejections {
  readonly decisions: number;
  readonly rejected: number;
  /** `<gate>:<code>` → decisions rejected for it (a decision counts once per key) and its share of all decisions. */
  readonly by_reason: Readonly<Record<string, { readonly count: number; readonly rate: number }>>;
  readonly h16_not_covered: { readonly count: number; readonly rate: number };
}

const rate = (n: number, d: number): number => (d === 0 ? 0 : Math.round((n / d) * 10_000) / 10_000);

/** From `decision` lines: action `enter` is not a rejection; every other decision's typed `gate_reasons` are counted. */
export const rejections = (journal: readonly JournalLine[]): Rejections => {
  let decisions = 0;
  let rejected = 0;
  const counts = new Map<string, number>();
  for (const l of journal) {
    if (l.kind !== 'decision') continue;
    decisions += 1;
    if (l['action'] === 'enter') continue;
    rejected += 1;
    const gr = Array.isArray(l['gate_reasons']) ? (l['gate_reasons'] as unknown[]) : [];
    const keys = new Set(
      gr.flatMap((r) => (typeof r === 'object' && r !== null && typeof (r as { gate?: unknown }).gate === 'string' && typeof (r as { code?: unknown }).code === 'string' ? [`${(r as { gate: string }).gate}:${(r as { code: string }).code}`] : [])),
    );
    if (keys.size === 0) keys.add('untyped');
    for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const h16 = counts.get('H16:not-covered') ?? 0;
  return {
    decisions,
    rejected,
    by_reason: Object.fromEntries([...counts].sort(([a], [b]) => a.localeCompare(b)).map(([k, n]) => [k, { count: n, rate: rate(n, decisions) }])),
    h16_not_covered: { count: h16, rate: rate(h16, decisions) },
  };
};
