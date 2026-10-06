// Quota and coverage for the dry-run report (RUN-1c): provider credits by class with a monthly projection,
// historical-lookup latency, discovery coverage gaps, and the rejection rate by gate reason. Pure.
import { LOOKUP_BOUNDS_MS, REGISTERED_STRATEGIES, type JournalLine, type QuotaStatus } from './contract.ts';
import type { StartFields } from './journal.ts';

/**
 * The free plans the run is judged against: the runner's own facts, never the worker's. A worker that reports another
 * monthly figure is a problem, not a new limit.
 */
export const FREE_PLANS: Readonly<Record<string, { readonly monthly: number | null; readonly source: string }>> = {
  // Helius Free: 1M credits a month (docs/research/data.md §1).
  helius: { monthly: 1_000_000, source: 'docs/research/data.md §1' },
  // Alchemy Free: 30M compute units a month (docs/research/data.md §4 table, line 306).
  alchemy: { monthly: 30_000_000, source: 'docs/research/data.md §4 (line 306)' },
  // Jupiter free key: rate limits only, no monthly budget (docs/research/data.md §1).
  jupiter: { monthly: null, source: 'docs/research/data.md §1' },
};

/**
 * The last valid health values of one boot. Scheduler counters restart at 0 each boot, so a run's total is the sum
 * over boots. `problems` records every sample whose quota was missing or invalid: the last valid counters are kept.
 */
export interface BootTotals {
  readonly quota: readonly QuotaStatus[];
  readonly lookups: { readonly counts: readonly number[] };
  readonly problems?: readonly string[];
}

const MONTH_MS = 30 * 24 * 3_600_000;
type Four = [number, number, number, number];
const add4 = (a: Four, b: readonly number[]): Four => [a[0] + b[0]!, a[1] + b[1]!, a[2] + b[2]!, a[3] + b[3]!];
const count = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;
const four = (x: unknown): x is Four => Array.isArray(x) && x.length === 4 && x.every(count);

/** Why one provider's status cannot be used, or null. Credits are whole numbers (fractional metering is rounded up by the worker). */
export const quotaProblem = (q: unknown): string | null => {
  if (typeof q !== 'object' || q === null) return 'quota entry is not an object';
  const s = q as Record<string, unknown>;
  const name = typeof s['provider'] === 'string' ? s['provider'] : '?';
  if (!count(s['credits_used'])) return `${name}: credits_used is not a non-negative integer`;
  for (const k of ['credits_by_class', 'granted', 'shed'] as const) if (!four(s[k])) return `${name}: ${k} is not four non-negative integers`;
  const cls = s['credits_by_class'] as Four;
  if (cls[0] + cls[1] + cls[2] + cls[3] !== s['credits_used']) return `${name}: credits_by_class does not sum to credits_used`;
  if (!(s['monthly_credits'] === null || count(s['monthly_credits']))) return `${name}: monthly_credits is not an integer or null`;
  if (typeof s['halted'] !== 'boolean') return `${name}: halted is not a boolean`;
  const plan = FREE_PLANS[name];
  if (plan && s['monthly_credits'] !== plan.monthly) return `${name}: worker reports monthly_credits ${String(s['monthly_credits'])}, the free plan is ${String(plan.monthly)}`;
  return null;
};

/** A health reply's quota for one boot: valid with every free-plan provider, or the problems that make it unusable. */
export const checkQuota = (quota: unknown): { readonly ok: true; readonly quota: readonly QuotaStatus[] } | { readonly ok: false; readonly problems: readonly string[] } => {
  if (!Array.isArray(quota)) return { ok: false, problems: ['no quota in the health reply'] };
  const problems = quota.flatMap((q) => quotaProblem(q) ?? []);
  const seen = new Set(quota.map((q) => (q as { provider?: unknown }).provider));
  for (const p of Object.keys(FREE_PLANS)) if (!seen.has(p)) problems.push(`${p}: not reported`);
  return problems.length ? { ok: false, problems } : { ok: true, quota: quota as QuotaStatus[] };
};

export interface ProviderQuota {
  readonly provider: string;
  readonly credits_used: number;
  readonly credits_by_class: Four;
  /** From FREE_PLANS; null for rate-only providers and for providers outside the free-plan list. */
  readonly monthly_credits: number | null;
  /** credits_used scaled linearly from the run's wall time to 30 days; null when the run had no time. */
  readonly projected_monthly: number | null;
  /** null for rate-only providers (no monthly budget). */
  readonly within_free_tier: boolean | null;
  readonly shed: Four;
}

export interface QuotaReport {
  /** Every boot reported a valid quota for every free-plan provider at every sample. */
  readonly reported: boolean;
  readonly problems: readonly string[];
  readonly providers: readonly ProviderQuota[];
  /** P0 and P1 requests shed over the whole run (exits and position monitoring). Must be 0. */
  readonly exit_capacity_shed: number;
  readonly within_free_tier: boolean;
}

export const quotaReport = (boots: readonly BootTotals[], durationMs: number): QuotaReport => {
  const problems = [...new Set(boots.flatMap((b) => b.problems ?? []))];
  const by = new Map<string, { used: number; cls: Four; shed: Four }>();
  for (const b of boots) {
    const check = checkQuota(b.quota);
    if (!check.ok) {
      problems.push(...check.problems.filter((p) => !problems.includes(p)));
      continue;
    }
    for (const q of check.quota) {
      const cur = by.get(q.provider) ?? { used: 0, cls: [0, 0, 0, 0] as Four, shed: [0, 0, 0, 0] as Four };
      by.set(q.provider, { used: cur.used + q.credits_used, cls: add4(cur.cls, q.credits_by_class), shed: add4(cur.shed, q.shed) });
    }
  }
  if (boots.length === 0) problems.push('no boot reported a quota');
  const providers = [...by].sort(([a], [b]) => a.localeCompare(b)).map(([provider, v]): ProviderQuota => {
    const monthly = FREE_PLANS[provider]?.monthly ?? null;
    const projected = durationMs > 0 ? Math.ceil((v.used * MONTH_MS) / durationMs) : null;
    return {
      provider,
      credits_used: v.used,
      credits_by_class: v.cls,
      monthly_credits: monthly,
      projected_monthly: projected,
      within_free_tier: monthly === null ? null : projected !== null && projected <= monthly,
      shed: v.shed,
    };
  });
  const reported = problems.length === 0;
  return {
    reported,
    problems,
    providers,
    exit_capacity_shed: providers.reduce((n, p) => n + p.shed[0] + p.shed[1], 0),
    within_free_tier: reported && providers.every((p) => p.within_free_tier !== false),
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

/** The discovery streams every report lists (§6.1): a boot's down window is a gap in each of them. */
export const COVERAGE_STREAMS = ['creates', 'rugs', 'trades'] as const;

export interface StreamCoverage {
  /** Merged gap intervals (worker gaps and down windows together, overlaps counted once). */
  readonly gaps: number;
  /** Still open at the end of the run. */
  readonly open: number;
  readonly total_s: number;
  readonly longest_s: number;
}

export interface CoverageReport {
  readonly streams: Readonly<Record<string, StreamCoverage>>;
  /** Malformed gap lines: the coverage cannot be judged. */
  readonly problems: readonly string[];
}

const ts = (x: unknown): number => (typeof x === 'string' ? Date.parse(x) : Number.NaN);
const s1 = (ms: number): number => Math.round(ms / 100) / 10;

/**
 * Coverage gaps by stream. The worker journals a gap when it opens (`to_ts` null) and again when it closes (same
 * `gap_id`, `to_ts` set). A gap still open when its boot ends runs to the next boot's start (or the end of the run),
 * and every boot's down window, from its last journal line to the next boot's `start`, is a gap in every stream.
 */
export const coverageGaps = (journal: readonly JournalLine[], endMs: number, startMs = Number.NEGATIVE_INFINITY): CoverageReport => {
  const problems: string[] = [];
  const intervals = new Map<string, [number, number][]>(COVERAGE_STREAMS.map((s) => [s, []]));
  const openAtEnd = new Map<string, number>();
  // Boot boundaries: first and last line of each boot, in journal order.
  const bootOrder: string[] = [];
  const firstTs = new Map<string, number>();
  const lastTs = new Map<string, number>();
  for (const l of journal) {
    const t = ts(l.ts);
    if (!firstTs.has(l.boot)) {
      bootOrder.push(l.boot);
      firstTs.set(l.boot, t);
    }
    lastTs.set(l.boot, t);
  }
  const nextStart = (boot: string): number => {
    const i = bootOrder.indexOf(boot);
    const next = bootOrder[i + 1];
    return next === undefined ? endMs : firstTs.get(next)!;
  };
  for (let i = 0; i + 1 < bootOrder.length; i++) {
    const from = lastTs.get(bootOrder[i]!)!;
    const to = firstTs.get(bootOrder[i + 1]!)!;
    if (Number.isNaN(from) || Number.isNaN(to)) problems.push(`boot ${bootOrder[i]}: bad journal time`);
    else if (to > from) for (const s of COVERAGE_STREAMS) intervals.get(s)!.push([from, to]);
  }
  const open = new Map<string, { stream: string; from: number; boot: string }>();
  for (const l of journal) {
    if (l.kind !== 'coverage_gap') continue;
    const stream = l['stream'];
    const id = l['gap_id'];
    const from = ts(l['from_ts']);
    if (typeof stream !== 'string' || stream === '' || typeof id !== 'string' || id === '' || Number.isNaN(from)) {
      problems.push(`seq ${l.seq}: coverage_gap needs stream, gap_id and a valid from_ts`);
      continue;
    }
    if (!intervals.has(stream)) intervals.set(stream, []);
    if (l['to_ts'] === null || l['to_ts'] === undefined) {
      open.set(id, { stream, from, boot: l.boot });
      continue;
    }
    const to = ts(l['to_ts']);
    if (Number.isNaN(to) || to < from) {
      problems.push(`seq ${l.seq}: coverage_gap ${id} has a bad to_ts`);
      continue;
    }
    // A close observed after the fixed end cannot claim the gap was closed within the run.
    if (to > endMs) open.set(id, { stream, from, boot: l.boot });
    else open.delete(id);
    intervals.get(stream)!.push([from, to]);
  }
  for (const g of open.values()) {
    if (g.from >= endMs) continue;
    const end = Math.min(nextStart(g.boot), endMs);
    intervals.get(g.stream)!.push([g.from, Math.max(g.from, end)]);
    if (end === endMs) openAtEnd.set(g.stream, (openAtEnd.get(g.stream) ?? 0) + 1);
  }
  const streams: Record<string, StreamCoverage> = {};
  for (const [stream, list] of [...intervals].sort(([a], [b]) => a.localeCompare(b))) {
    const merged: [number, number][] = [];
    // Retain and validate all journal evidence, while measuring only coverage before the fixed end.
    const bounded = list.filter(([a, b]) => a < endMs && b >= startMs).map(([a, b]): [number, number] => [Math.max(a, startMs), Math.min(b, endMs)]);
    for (const [a, b] of bounded.sort((x, y) => x[0] - y[0])) {
      const last = merged[merged.length - 1];
      if (last && a <= last[1]) last[1] = Math.max(last[1], b);
      else merged.push([a, b]);
    }
    const lens = merged.map(([a, b]) => b - a);
    streams[stream] = { gaps: merged.length, open: openAtEnd.get(stream) ?? 0, total_s: s1(lens.reduce((x, y) => x + y, 0)), longest_s: s1(Math.max(0, ...lens)) };
  }
  return { streams, problems };
};

export interface Rejections {
  readonly decisions: number;
  readonly rejected: number;
  /** `<gate>:<code>` → decisions rejected for it (a decision counts once per key) and its share of all decisions. */
  readonly by_reason: Readonly<Record<string, { readonly count: number; readonly rate: number }>>;
  readonly h16_not_covered: { readonly count: number; readonly rate: number };
}

const rate = (n: number, d: number): number => (d === 0 ? 0 : Math.round((n / d) * 10_000) / 10_000);

/**
 * From `decision` lines. Only `reject` and `skip` are rejections; `enter` and the worker's lifecycle steps (prepare,
 * sign, submit, reconcile, …) are decisions but not rejections. The rate is over all decision lines.
 */
export const rejections = (journal: readonly JournalLine[]): Rejections => {
  let decisions = 0;
  let rejected = 0;
  const counts = new Map<string, number>();
  for (const l of journal) {
    if (l.kind !== 'decision') continue;
    decisions += 1;
    if (l['action'] !== 'reject' && l['action'] !== 'skip') continue;
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

export interface EntryRule {
  /** The runner's `--strategy`: the strategy id every boot must run (`none` until BT-2 registers one). */
  readonly expected: string;
  readonly seen: readonly string[];
  readonly ok: boolean;
  readonly problems: readonly string[];
}

/**
 * The qualifying run's start lines: at least one; every boot runs the runner's `--strategy`, which must be a registered
 * strategy (REGISTERED_STRATEGIES), with no paper edge and `qualifying: true`; neither the rule nor the random-entry
 * salt changes between boots. A host unit or resumed state carrying the S0 shakedown or a paper edge into the
 * qualifying run would otherwise pass on random entries.
 */
export const entryRule = (starts: readonly StartFields[], expected: string, registered: readonly string[] = REGISTERED_STRATEGIES): EntryRule => {
  const problems: string[] = [];
  const seen = [...new Set(starts.map((l) => String(l.entry_rule ?? null)))];
  const salts = new Set(starts.map((l) => JSON.stringify(l.s0_salt ?? null)));
  if (starts.length === 0) problems.push('no start line');
  if (expected === 'none') problems.push('no registered strategy (--strategy none)');
  else if (!registered.includes(expected)) problems.push(`strategy ${expected} is not registered (registered: ${registered.join(', ') || 'none yet'})`);
  for (const l of starts) {
    if (l.entry_rule !== expected) problems.push(`boot ${l.boot}: entry rule ${JSON.stringify(l.entry_rule ?? null)}, the run's strategy is ${expected}`);
    if (l.paper_edge_ppm !== null && l.paper_edge_ppm !== undefined) problems.push(`boot ${l.boot}: paper edge ${String(l.paper_edge_ppm)} ppm`);
    if (l.qualifying !== true) problems.push(`boot ${l.boot}: qualifying ${JSON.stringify(l.qualifying ?? null)}`);
    if (l.s0_diagnostic !== null && l.s0_diagnostic !== undefined) problems.push(`boot ${l.boot}: S0 diagnostic ${JSON.stringify(l.s0_diagnostic)}`);
  }
  if (seen.length > 1) problems.push(`entry rule changed between boots: ${seen.join(', ')}`);
  if (salts.size > 1) problems.push('random-entry salt changed between boots');
  return { expected, seen, ok: problems.length === 0, problems };
};
