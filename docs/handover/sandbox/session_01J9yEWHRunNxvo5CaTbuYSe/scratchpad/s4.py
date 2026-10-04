p='packages/core/src/stats/gates.ts'
s=open(p).read()
def rep(a,b):
    global s
    assert s.count(a)==1, a[:80]
    s=s.replace(a,b)
rep("""  /** Net returns of the dry-run paper trades (the candidates live kept). */
  readonly dryRunReturns: readonly number[];""","""  /** Net returns of the dry-run paper trades (the candidates live kept). */
  readonly dryRunReturns: readonly number[];
  /**
   * Creator cluster of each kept trade, aligned with dryRunReturns (decision-time facts). The veto-gap bounds are
   * cluster-robust over these (external audit S4): trades of one creator in a 48-hour run are not assumed independent.
   */
  readonly dryRunClusters: readonly string[];""")
rep("""  readonly returns: readonly number[];
  /** Vetoed candidates whose outcome window is not fully observed yet. */
  readonly censored: number;
}""","""  readonly returns: readonly number[];
  /** Creator cluster of each scored return, aligned with `returns`. */
  readonly clusters: readonly string[];
  /** Vetoed candidates whose outcome window is not fully observed yet. */
  readonly censored: number;
}""")
rep("""export const scoreVetoCounterfactuals = (labels: readonly TripleBarrierLabel[]): VetoCounterfactuals => {
  if (new Set(labels.map((l) => l.cfgId)).size > 1) throw new RangeError('veto counterfactuals must use one barrier configuration');
  const returns: number[] = [];
  let censored = 0;
  for (const l of labels) {
    if (l.censored || l.rNet === null) censored++;
    else returns.push(l.rNet);
  }
  return { returns, censored };
};""","""export const scoreVetoCounterfactuals = (labels: readonly TripleBarrierLabel[], creatorClusters: readonly string[]): VetoCounterfactuals => {
  if (new Set(labels.map((l) => l.cfgId)).size > 1) throw new RangeError('veto counterfactuals must use one barrier configuration');
  if (creatorClusters.length !== labels.length) throw new RangeError(`${labels.length} labels but ${creatorClusters.length} creator clusters`);
  const returns: number[] = [];
  const clusters: string[] = [];
  let censored = 0;
  labels.forEach((l, i) => {
    if (l.censored || l.rNet === null) censored++;
    else {
      returns.push(l.rNet);
      clusters.push(creatorClusters[i]!);
    }
  });
  return { returns, clusters, censored };
};""")
rep("""/** One-sided (1 − α) Welch bounds on mean(a) − mean(b). */""","""/**
 * Cluster-robust variance of a sample mean (CR1, Liang & Zeger 1986; Cameron & Miller, J. Human Resources 50(2),
 * 2015): G/(G − 1) · Σ_c (Σ_{i∈c} (x_i − x̄))² / n², with G clusters. With every trade its own cluster it is s²/n.
 */
const clusterMeanVariance = (xs: readonly number[], clusters: readonly string[]): { variance: number; clusters: number } => {
  const m = mean(xs);
  const sums = new Map<string, number>();
  xs.forEach((x, i) => sums.set(clusters[i]!, (sums.get(clusters[i]!) ?? 0) + (x - m)));
  const g = sums.size;
  let ss = 0;
  for (const v of sums.values()) ss += v * v;
  return { variance: g > 1 ? (g / (g - 1)) * ss / (xs.length * xs.length) : Number.NaN, clusters: g };
};

/**
 * One-sided (1 − α) cluster-robust Welch bounds on mean(a) − mean(b): CR1 variances, Satterthwaite degrees of freedom
 * with G − 1 per side (external audit S4). Equals the classic Welch bound when every observation is its own cluster.
 */
export const clusterWelchBounds = (
  a: readonly number[], ca: readonly string[], b: readonly number[], cb: readonly string[], alpha = 0.05,
): { diff: number; lower: number; upper: number; clustersA: number; clustersB: number } => {
  if (ca.length !== a.length || cb.length !== b.length) throw new RangeError('every observation needs its cluster');
  const diff = mean(a) - mean(b);
  const va = clusterMeanVariance(a, ca);
  const vb = clusterMeanVariance(b, cb);
  if (va.clusters < 2 || vb.clusters < 2) throw new RangeError('cluster-robust bounds need at least two clusters on each side');
  const se = Math.sqrt(va.variance + vb.variance);
  const base = { diff, clustersA: va.clusters, clustersB: vb.clusters };
  if (!(se > 0)) return { ...base, lower: diff, upper: diff };
  const df = (va.variance + vb.variance) ** 2 / (va.variance ** 2 / (va.clusters - 1) + vb.variance ** 2 / (vb.clusters - 1));
  const t = studentTQuantile(1 - alpha, df);
  return { ...base, lower: diff - t * se, upper: diff + t * se };
};

/** One-sided (1 − α) Welch bounds on mean(a) − mean(b). */""")
rep("""  const complete = unscored === 0 && cf.censored === 0;
  const measured = complete && scored >= th.minVetoedForGap && m >= th.minKeptForGap;""","""  const complete = unscored === 0 && cf.censored === 0;
  // Cluster labels for the cluster-robust gap: one per scored vetoed and kept trade, none empty. Missing labels fail.
  const labelled = cf.clusters?.length === scored && input.dryRunClusters?.length === m
    && [...cf.clusters, ...input.dryRunClusters].every((x) => typeof x === 'string' && x !== '');
  if (!labelled) c.add('veto clusters', false, `${cf.clusters?.length ?? 0} cluster labels for ${scored} scored vetoed and ${input.dryRunClusters?.length ?? 0} for ${m} kept trades (need one non-empty creator cluster each)`);
  const clusterCount = (xs: readonly string[] | undefined) => new Set(xs ?? []).size;
  const enoughClusters = labelled && clusterCount(cf.clusters) >= 2 && clusterCount(input.dryRunClusters) >= 2;
  const measured = complete && labelled && enoughClusters && scored >= th.minVetoedForGap && m >= th.minKeptForGap;""")
rep("""    const one = welchBounds(cf.returns, input.dryRunReturns, VETO_COMPOSITE_ALPHA);
    const two = welchBounds(cf.returns, input.dryRunReturns, VETO_COMPOSITE_ALPHA / 2);""","""    const one = clusterWelchBounds(cf.returns, cf.clusters, input.dryRunReturns, input.dryRunClusters, VETO_COMPOSITE_ALPHA);
    const two = clusterWelchBounds(cf.returns, cf.clusters, input.dryRunReturns, input.dryRunClusters, VETO_COMPOSITE_ALPHA / 2);
    metrics.vetoGapClustersVetoed = one.clustersA;
    metrics.vetoGapClustersKept = one.clustersB;""")
rep("""all scored): the worst case ${fmt(worstGap)} is used`);""","""all scored, labelled and on >= 2 creator clusters each): the worst case ${fmt(worstGap)} is used`);""")
rep(""" * holdoutLower − v⁺·max(0, Δ⁺) − execution allowance > 0, and v⁺·|Δ|⁺ ≤ 5 points. Each of the three components is
 * at α/3 (VETO_COMPOSITE_ALPHA): the holdout's one-sided lower bound, v⁺ the one-sided Clopper–Pearson upper bound,
 * Δ⁺ the one-sided Welch upper bound for the selection allowance and |Δ|⁺ from the two-sided Welch bounds (α/6 a
 * side) for the bias. With fewer than 10 scored vetoed or kept trades Δ is the worst case the
 * return range allows (cap − RETURN_FLOOR), never an assumed value. A failure that more run time can clear (missing,
 * censored or too few counterfactuals; a bound that fails while the point estimate passes) is "not proven": extend the
 * dry run. Kept trades within one run are treated as independent (48 h holds about two days, too few to estimate day
 * correlation); the run says so.""",""" * holdoutLower − v⁺·max(0, Δ⁺) − execution allowance > 0, and v⁺·|Δ|⁺ ≤ 5 points. Each of the four components is
 * at α/4 (VETO_COMPOSITE_ALPHA): the holdout's one-sided lower bound, v⁺ the one-sided Clopper–Pearson upper bound,
 * Δ⁺ the one-sided Welch upper bound for the selection allowance (with |Δ|⁺ from the two-sided bounds, α/8 a side, for
 * the bias) and the fill-error bound in the execution allowance. The gap bounds are cluster-robust by creator (external
 * audit S4): trades of one creator are not assumed independent, and with every trade its own creator the bound is the
 * classic Welch bound. With fewer than 10 scored vetoed or kept trades, unlabelled trades or fewer than two creators a
 * side, Δ is the worst case the return range allows (cap − RETURN_FLOOR), never an assumed value. A failure that more
 * run time can clear (missing, censored or too few counterfactuals; a bound that fails while the point estimate passes)
 * is "not proven": extend the dry run. The consistency ("agree") checks still treat kept trades as independent: that
 * makes their intervals narrower, so it can only add disagreements, never hide one.""")
open(p,'w').write(s)
