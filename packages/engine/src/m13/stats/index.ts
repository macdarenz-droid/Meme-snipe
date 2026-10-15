// The statistics library (A-M13-03): pure, seeded, no I/O. SPEC-A names it `@bot/stats`; it lives in `@bot/engine`
// because the engine runs M13 online too (ARCH section 6: M13 online metrics in the engine, batch in the research CLI)
// and a new package would need a manifest and lockfile change (supervisor-owned files).
import { kurtosisNonExcess, mean, skew, tStatMean } from './descriptive.ts';
import { dayClusterMeanCi, gateMeanCi, nonInferiorityLowerBound, stationaryBootstrapMeanCi, studentizedTsBootstrapSharpeDiff, wilson } from './intervals.ts';
import { cscvPbo, rankStability } from './pbo.ts';
import { dsr, loSharpeSe, maxTrialsForWindow, minBtlYears, minTrl, psr } from './sharpe.ts';
import { normalQuantile } from './special.ts';

export * from './descriptive.ts';
export * from './intervals.ts';
export * from './pbo.ts';
// `dsrFromVariance` (the paper's raw DSR, without ruling Z06-1's floor) stays internal: worked-example tests only (Z06-5).
export { daysToYears, dsr, EULER_GAMMA, expectedMaxSharpe, loSharpeSe, maxTrialsForWindow, minBtlYears, minTrl, psr } from './sharpe.ts';
export { normalCdf, normalQuantile, studentTCdf, studentTQuantile } from './special.ts';

/** The SPEC-A `Stats` interface, plus A14's day-cluster and gate intervals. */
export const stats = Object.freeze({
  mean, skew, kurtosisNonExcess, stationaryBootstrapMeanCi, wilson, tStatMean, loSharpeSe, psr, dsr, minTrl, minBtlYears,
  maxTrialsForWindow, cscvPbo, rankStability, studentizedTsBootstrapSharpeDiff, nonInferiorityLowerBound,
  normInv: normalQuantile, dayClusterMeanCi, gateMeanCi,
});
