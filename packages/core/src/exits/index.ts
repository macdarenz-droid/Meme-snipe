// The exit engine (EXIT-1, docs/ARCHITECTURE.md §9): triggers on executable liquidation value, the escalation ladder
// and the blocked-exit retry. Pure functions; the strategy turns a decision into CORE-1 book events.
export * from './value.ts';
export * from './ladder.ts';
export * from './rules.ts';
export * from './book.ts';
