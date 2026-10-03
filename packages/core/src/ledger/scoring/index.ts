// The scoring store's entry point (`@meme-snipe/core/ledger/scoring`): labels, the experiment registry and
// gate results. The SQLite code lives in ../adapters, the only place in core allowed to touch files.
export * from '../adapters/scoring.ts';
