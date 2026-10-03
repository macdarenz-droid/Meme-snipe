// Platform changes that start a new regime (ARCHITECTURE.md §6.5, §14; venues.md §2.7). Read by the post-change
// revalidation gate (stats/gates.ts, whose PlatformChange type documents the fields; stats imports nothing from here).
// Times are integer ms since the epoch, UTC. economicsUnchanged: null means not reviewed (treated as contradicted).

/**
 * Regime boundaries B2–B5. B2–B4 changed economics and lie before the holdout. B5's "economics unchanged" is UPG-1's
 * finding (DECISIONS 2026-10-03); set it to false here if a later review contradicts it.
 */
export const KNOWN_PLATFORM_CHANGES: readonly { readonly id: string; readonly atMs: number; readonly economicsUnchanged: boolean | null }[] = [
  { id: 'B2', atMs: 1_784_643_780_000, economicsUnchanged: false }, // 2026-07-21 14:23 UTC, BOOST on
  { id: 'B3', atMs: 1_788_982_200_000, economicsUnchanged: false }, // 2026-09-09 19:30 UTC, fee and creator-fee config
  { id: 'B4', atMs: 1_789_226_640_000, economicsUnchanged: false }, // 2026-09-12 15:24 UTC, holder rewards
  { id: 'B5', atMs: 1_790_956_020_000, economicsUnchanged: true }, //  2026-10-02 15:47 UTC, unpublished upgrade (UPG-1)
];
