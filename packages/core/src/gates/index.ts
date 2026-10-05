// Evidence gates (GATE-1, docs/ARCHITECTURE.md §6.3, §6.4, §7): hard rejects, soft features and the regime gate,
// all computed from as-of lookups. The bot acts only when the data proves the setup.
export * from './reasons.ts';
export * from './facts.ts';
export * from './evidence.ts';
export * from './series.ts';
export * from './holders.ts';
export * from './hard.ts';
export * from './regime.ts';
export * from './soft.ts';
export * from './deployer-index.ts';
export * from './tails.ts';
export * from './rug-labeller.ts';
export * from './deployer-check.ts';
export * from './staged.ts';
export * from './create-keep.ts';
