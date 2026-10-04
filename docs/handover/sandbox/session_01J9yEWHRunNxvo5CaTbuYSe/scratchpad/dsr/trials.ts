// Effective number of independent trials for the deflated Sharpe ratio.
// Many registry trials are variants of one rule (a threshold moved, a barrier widened) and trade mostly the same
// candidates, so counting each as an independent trial over-deflates: no real edge could pass (RES-3). Bailey &
// López de Prado (J. Portfolio Management 40(5), 2014, Appendix) and López de Prado & Lewis, "Detection of false
// investment strategies using unsupervised learning methods", Quantitative Finance 19(9):1555–1565, 2019, cluster the
// trials by the correlation of their returns, take N as the number of clusters and V across the clusters.
//
// Method (the ONC base step of López de Prado & Lewis 2019, with hierarchical clustering in place of repeated k-means
// so the result is deterministic):
//   1. Pearson correlation ρ of the trials' daily P&L series; distance d = √(½(1 − ρ)).
//   2. Average-linkage agglomerative clustering on d.
//   3. For each cut K = 2..N − 1, the silhouette s_i of every trial (Rousseeuw, J. Comput. Appl. Math. 20, 1987;
//      0 for a singleton); the cut's quality is q = mean(s)/sd(s). The best cut is the one with the largest q.
//   4. A cut is only accepted when it separates real structure: its mean silhouette must exceed NULL_SILHOUETTE.
//      Otherwise every trial counts as one independent trial (N = number of trials), the conservative answer: under
//      independence any cut has a mean silhouette near 0, and accepting one would undercount trials and loosen the
//      DSR. In simulation (N = 10–200 independent series, 10–60 days, 300 runs each) a cut was accepted at most once.
//   5. N = Σ over clusters of ρ̄ₖ + (1 − ρ̄ₖ)·mₖ, rounded up: the implied number of independent trials of Bailey &
//      López de Prado (2014, Appendix), applied within each cluster (ρ̄ₖ the mean pairwise correlation of its mₖ
//      members, clamped to [0, 1]); clusters count as independent of each other. The formula is not applied across all
//      trials without a cut: a market factor shared by every rule correlates daily P&L without making the trials'
//      Sharpe estimates any less independent, and would undercount N.
// Each cluster's representative is its medoid (the member with the highest mean correlation to the others); without
// an accepted cut every trial represents itself.

const pearson = (a: readonly number[], b: readonly number[]): number => {
  const n = a.length;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i]!;
    mb += b[i]!;
  }
  ma /= n;
  mb /= n;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i]! - ma;
    const y = b[i]! - mb;
    sab += x * y;
    saa += x * x;
    sbb += y * y;
  }
  // A constant series has no correlation with anything: it stays apart (counted as its own trial).
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 0;
};

/** Mean silhouette a cut must exceed before it is accepted over "every trial independent". */
export const NULL_SILHOUETTE = 0.25;

export interface TrialClustering {
  /** Trial ids per cluster, each sorted; clusters ordered by their first id. */
  readonly clusters: readonly (readonly string[])[];
  /** Medoid id of each cluster, in cluster order. */
  readonly representatives: readonly string[];
  /** Mean silhouette of the chosen cut; null when no cut was accepted (K = N) or N < 3. */
  readonly meanSilhouette: number | null;
  /** Effective number of independent trials (step 5 above), 1..N. */
  readonly effectiveTrials: number;
}

/**
 * Cluster trials by the correlation of their daily P&L. `series` maps trial id to its daily P&L, every series over the
 * same days in the same order.
 */
export const clusterTrials = (series: Readonly<Record<string, readonly number[]>>): TrialClustering => {
  const ids = Object.keys(series).sort();
  const n = ids.length;
  if (n === 0) throw new RangeError('no trials to cluster');
  const days = series[ids[0]!]!.length;
  for (const id of ids) {
    const s = series[id]!;
    if (s.length !== days) throw new RangeError(`trial ${id} has ${s.length} days, expected ${days}`);
    for (const x of s) if (!Number.isFinite(x)) throw new RangeError(`trial ${id} has a non-finite daily P&L`);
  }
  if (days < 3) throw new RangeError('clustering trials needs at least three days of P&L');
  const rho: number[][] = ids.map(() => new Array<number>(n).fill(1));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const r = pearson(series[ids[i]!]!, series[ids[j]!]!);
      rho[i]![j] = r;
      rho[j]![i] = r;
    }
  }
  const dist = rho.map((row) => row.map((r) => Math.sqrt(Math.max(0, 0.5 * (1 - r)))));
  const implied = (g: readonly number[]): number => {
    if (g.length === 1) return 1;
    let sum = 0;
    for (const i of g) for (const j of g) if (i < j) sum += rho[i]![j]!;
    const r = Math.min(1, Math.max(0, sum / ((g.length * (g.length - 1)) / 2)));
    return r + (1 - r) * g.length;
  };
  // Rounded up, with a tolerance so float noise in an exact count does not add a trial.
  const roundUp = (x: number): number => Math.min(n, Math.max(1, Math.ceil(x - 1e-9)));
  const unclustered = (): TrialClustering => ({
    clusters: ids.map((id) => [id]), representatives: [...ids], meanSilhouette: null, effectiveTrials: n,
  });
  if (n < 3) return unclustered();

  // Average linkage. Each step merges the closest pair (ties broken by the lowest indices: deterministic) and records
  // the partition, so partitions[K] is the cut with K clusters.
  let groups: number[][] = ids.map((_, i) => [i]);
  const avg = (a: readonly number[], b: readonly number[]): number => {
    let s = 0;
    for (const i of a) for (const j of b) s += dist[i]![j]!;
    return s / (a.length * b.length);
  };
  const partitions = new Map<number, number[][]>();
  while (groups.length > 2) {
    let best = Infinity;
    let bi = 0;
    let bj = 1;
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        const d = avg(groups[i]!, groups[j]!);
        if (d < best) {
          best = d;
          bi = i;
          bj = j;
        }
      }
    }
    const merged = [...groups[bi]!, ...groups[bj]!].sort((x, y) => x - y);
    groups = groups.filter((_, k) => k !== bi && k !== bj);
    groups.push(merged);
    groups.sort((x, y) => x[0]! - y[0]!);
    partitions.set(groups.length, groups.map((g) => [...g]));
  }

  const silhouettes = (part: readonly (readonly number[])[]): number[] => {
    const of = new Array<number>(n);
    part.forEach((g, k) => g.forEach((i) => (of[i] = k)));
    return ids.map((_, i) => {
      const own = part[of[i]!]!;
      if (own.length === 1) return 0;
      let a = 0;
      for (const j of own) if (j !== i) a += dist[i]![j]!;
      a /= own.length - 1;
      let b = Infinity;
      part.forEach((g, k) => {
        if (k === of[i]) return;
        let s = 0;
        for (const j of g) s += dist[i]![j]!;
        b = Math.min(b, s / g.length);
      });
      const m = Math.max(a, b);
      return m > 0 ? (b - a) / m : 0;
    });
  };

  let chosen: number[][] | null = null;
  let chosenMean = 0;
  let bestQ = -Infinity;
  for (let k = 2; k <= n - 1; k++) {
    const part = partitions.get(k);
    if (!part) continue;
    const s = silhouettes(part);
    const m = s.reduce((x, y) => x + y, 0) / n;
    const v = s.reduce((x, y) => x + (y - m) ** 2, 0) / (n - 1);
    const q = v > 0 ? m / Math.sqrt(v) : m > 0 ? Infinity : -Infinity;
    if (q > bestQ) {
      bestQ = q;
      chosen = part;
      chosenMean = m;
    }
  }
  if (!chosen || !(chosenMean > NULL_SILHOUETTE)) return unclustered();

  const representatives = chosen.map((g) => {
    if (g.length === 1) return ids[g[0]!]!;
    let best = g[0]!;
    let bestMean = -Infinity;
    for (const i of g) {
      let s = 0;
      for (const j of g) if (j !== i) s += rho[i]![j]!;
      if (s / (g.length - 1) > bestMean) {
        bestMean = s / (g.length - 1);
        best = i;
      }
    }
    return ids[best]!;
  });
  return {
    clusters: chosen.map((g) => g.map((i) => ids[i]!)), representatives, meanSilhouette: chosenMean,
    effectiveTrials: roundUp(chosen.reduce((s, g) => s + implied(g), 0)),
  };
};
