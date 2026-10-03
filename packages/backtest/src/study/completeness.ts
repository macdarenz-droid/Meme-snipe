// The completeness manifest (external review, supervisor ruling 2026-10-04): for every gate input, whether the dataset
// plus the supplements given can rebuild it as of each decision moment. A candidate whose safety evidence cannot be
// rebuilt is rejected (H16), as live would reject it; this table says which inputs that is, and the run's reject mix
// says how often it happened.

export type Availability = 'rebuilt' | 'supplement' | 'missing' | 'live-only veto';

export interface ManifestRow {
  readonly gate: string;
  readonly input: string;
  readonly availability: Availability;
  readonly source: string;
}

export interface CompletenessOptions {
  /** A funding supplement (FACTS-1) was given: H13 can be complete. */
  readonly funding: boolean;
  /** A per-deployer rug supplement (RUG-1c) was given: H14's rug half is covered for deployers whose prior mints' trades are outside the dataset. */
  readonly rugs: boolean;
  /** Raw records exist for every create and pool creation (DATA-1 #46), not only the 5% hash sample. */
  readonly rawForAll: boolean;
}

export const completenessManifest = (o: CompletenessOptions): ManifestRow[] => {
  const raw: Availability = o.rawForAll ? 'rebuilt' : 'missing';
  const rawNote = o.rawForAll ? 'raw record of every create and pool creation' : 'raw records exist for the 5% hash sample only; other mints are rejected as missing';
  return [
    { gate: 'H1–H4', input: 'mint program, authorities, extensions', availability: raw, source: `create transaction's token instructions (${rawNote})` },
    { gate: 'H5', input: 'pool, canonical address, mayhem flag, quote mint', availability: 'rebuilt', source: 'CreatePoolEvent and the migration event; vault ATAs derived' },
    { gate: 'H5', input: 'trade-event tails (GATE-1c)', availability: 'rebuilt', source: 'extra_hex of every curve and pool trade row' },
    { gate: 'H6', input: 'LP outstanding', availability: raw, source: `LP minted and burned in the pool's creation transaction, then Deposit/Withdraw lp_mint_supply (${rawNote})` },
    { gate: 'H7', input: 'curve complete and migrated', availability: 'rebuilt', source: 'CompleteEvent and CompletePumpAmmMigrationEvent' },
    { gate: 'H8', input: 'quote at migration, effective quote reserve, SOL/USD', availability: 'rebuilt', source: 'migration event, pool trades replayed with our own trades in, hourly SOL/USD (fixed candles)' },
    { gate: 'H9–H11', input: 'creation, graduation and migration times; 1-minute candles', availability: 'rebuilt', source: 'create, complete and migration events; pool trades' },
    { gate: 'H12', input: 'holders', availability: raw, source: `token balances of every recorded transaction, checked for supply conservation (${rawNote})` },
    { gate: 'H13', input: 'creation-slot buyers', availability: 'rebuilt', source: 'curve trades in the creation slot and the next two' },
    { gate: 'H13', input: 'deployer-funded wallets, dev cluster', availability: o.funding ? 'supplement' : 'missing', source: o.funding ? 'funding supplement (FACTS-1), dated as of the decision' : 'not in the dataset: every candidate is rejected (H16 not-covered)' },
    { gate: 'H14', input: 'mints per deployer in 24 h', availability: 'rebuilt', source: 'every create event (kept for every mint)' },
    { gate: 'H14', input: 'prior rugs within 14 days', availability: o.rugs ? 'supplement' : 'rebuilt', source: o.rugs ? 'RUG-1 labels from the dataset plus the rug supplement (RUG-1c)' : 'RUG-1 labels from recorded trades; a prior mint without its trades (lead-in day, outside the sample, other quote) is unjudged and H14 is not covered for that deployer' },
    { gate: 'H15', input: 'round-trip simulation', availability: 'live-only veto', source: 'the exact local round-trip quote stands in (§16.3)' },
    { gate: 'H16', input: 'third-party cross-checks', availability: 'live-only veto', source: 'absent in the backtest (§16.3); staleness still applies' },
    { gate: 'R16', input: 'regime gate (survival, on-chain volume, SOL change)', availability: 'missing', source: 'producers pending (FACTS-1); logged, not applied' },
  ];
};

/** How often each gate rejected for missing or uncovered evidence in a run's reject mix (by tag). */
export const missingEvidence = (mix: Readonly<Record<string, Readonly<Record<string, number>>>>): Record<string, Record<string, number>> =>
  Object.fromEntries(Object.entries(mix).map(([tag, m]) => [tag, Object.fromEntries(Object.entries(m).filter(([k]) => /:(missing|not-covered|malformed|stale|degraded)$/.test(k)))]));
