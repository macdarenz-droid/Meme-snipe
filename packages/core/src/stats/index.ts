// Labels, statistics and promotion gates: the scoring stage behind ARCHITECTURE.md §13–§15.
// Pure functions only: no I/O, no clock, no Math.random (randomness comes from an injected, seeded Rng).
// The engine never imports this module; labels are scored after the engine has decided.

export * from './binomial.ts';
export * from './bootstrap.ts';
export * from './descriptive.ts';
export * from './eprocess.ts';
export * from './g2rule.ts';
export * from './gates.ts';
export * from './holdout.ts';
export * from './holm.ts';
export * from './labeller.ts';
export * from './pbo.ts';
export * from './power.ts';
export * from './predictive.ts';
export * from './rng.ts';
export * from './sharpe.ts';
export * from './special.ts';
