// Feature stage of the survival study (RES-5, docs/research/survival.md §2). Rows are released to RES-3's as-of
// tracker in chain order; every graduate gets a decision at 60 min, 240 min and 24 h after migration, with 15 as-of
// features and the look-alike strata (market cap, quote vault). This module never imports the outcome stage
// (survival-outcome.ts); it uses the pure label rule only for other graduates whose label time has passed.
import type { Policy } from '../../../core/src/config/index.ts';
import type { DatasetRow } from '../dataset/rows.ts';
import { baseRejects, PLAN_DRIVE, type Universe } from './candidates.ts';
import { guardRows, isPracticeDay, melbourneDay, type PracticeWindow, regimeAt, wallMs } from './practice.ts';
import { SURVIVAL_RULE, survivalLabel } from './survival-label.ts';
import { type Features, type PoolInfo, SignalTracker } from './tracker.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const SURVIVAL_FEATURES = [
  's_indep60', 's_new60', 's_bundle', 's_top10', 's_top10chg', 's_devnet', 's_early_sold', 's_liqmig', 's_liqchg60',
  's_c2g', 's_net60', 's_ret60', 's_creator_surv', 's_creator_rugs', 's_market_surv',
] as const;
export type SurvivalFeature = (typeof SURVIVAL_FEATURES)[number];

/** Decision ages after migration (survival.md §2). */
export const DECISION_AGES_MS = [60 * MIN, 240 * MIN, DAY] as const;

export interface SurvivalDecision {
  readonly id: string;
  readonly mint: string;
  readonly pool: string;
  readonly ageMs: number;
  /** Melbourne day of the decision. */
  readonly day: string;
  readonly regime: string;
  readonly decisionMs: number;
  readonly decisionSlot: bigint;
  readonly migratedAtMs: number;
  /** When the label is read (survival-label.ts). */
  readonly labelAtMs: number;
  readonly solUsd: number;
  readonly mcapSol: number | null;
  readonly quoteSol: number | null;
  readonly stratum: string;
  readonly features: Readonly<Record<SurvivalFeature, number | null>>;
  /** RES-3's features at the same moment (RES-4's rules read these). */
  readonly f: Features;
  /** The universe whose base filters this decision passes (U2 at 60/240 min, U1 at 24 h), or null. */
  readonly eligibleAs: Universe | null;
  readonly rejects: readonly string[];
}

export interface SurvivalOptions {
  readonly window: PracticeWindow;
  readonly policy: Policy;
  readonly solUsd: (ms: number) => number | null;
}

export interface SurvivalDrive {
  readonly decisions: SurvivalDecision[];
  /** Decisions skipped because their label time lies at or after the wall. */
  readonly labelPastWall: number;
  /** Labels of other graduates the feature stage matured (for creator and market history). */
  readonly matured: number;
}

const MCAP_EDGES = [300, 1_000, 3_000];
const QUOTE_EDGES = [20, 50, 150];
const bin = (v: number | null, edges: readonly number[]): string => (v === null ? 'na' : String(edges.filter((e) => v >= e).length));
/** The look-alike stratum: decision age × market-cap bin × real quote-vault bin (survival.md §3). */
export const stratumOf = (ageMs: number, mcapSol: number | null, quoteSol: number | null): string => `${ageMs / MIN}m|c${bin(mcapSol, MCAP_EDGES)}|q${bin(quoteSol, QUOTE_EDGES)}`;

interface Flow {
  readonly ms: number;
  readonly user: string;
  readonly delta: bigint;
}

interface Matured {
  readonly atMs: number;
  readonly survived: boolean;
  readonly rug: boolean;
  readonly mint: string;
}

const top10Share = (net: ReadonlyMap<string, bigint>, supply: bigint): number => {
  const held = [...net.values()].filter((v) => v > 0n).sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
  return Number(held.slice(0, 10).reduce((a, b) => a + b, 0n)) / Number(supply);
};

export const collectSurvival = (rows: Iterable<DatasetRow>, o: SurvivalOptions): SurvivalDrive => {
  const t = new SignalTracker({ solUsd: o.solUsd });
  const wall = wallMs(o.window);
  const drive = { window: o.window, policy: o.policy, solUsd: o.solUsd, ...PLAN_DRIVE };
  const firstSeen = new Map<string, Map<string, number>>();
  const flows = new Map<string, Flow[]>();
  const dues: { at: number; pool: string; ageMs: number }[] = [];
  const maturing: { at: number; pool: string }[] = [];
  const market: Matured[] = [];
  const byCreator = new Map<string, Matured[]>();
  const decisions: SurvivalDecision[] = [];
  let labelPastWall = 0;
  let matured = 0;

  const seen = (mint: string, user: string, ms: number, delta: bigint): void => {
    let m = firstSeen.get(mint);
    if (m === undefined) firstSeen.set(mint, (m = new Map()));
    if (!m.has(user)) m.set(user, ms);
    let f = flows.get(mint);
    if (f === undefined) flows.set(mint, (f = []));
    f.push({ ms, user, delta });
    while (f.length > 0 && f[0]!.ms < ms - 2 * HOUR) f.shift();
  };

  let dirty = false;
  let lastPrune = 0;
  const mature = (now: number): void => {
    if (dirty) maturing.sort((a, b) => a.at - b.at);
    while (maturing.length > 0 && maturing[0]!.at <= now) {
      const { at, pool } = maturing.shift()!;
      const p = t.pools.get(pool);
      if (p === undefined) continue;
      const last = t.tradeAsOf(p, at);
      const l = survivalLabel({ labelAtMs: at, nowMs: now, migrationPrice: p.migrationPrice, priceAtT: last?.price ?? null, quoteVaultAtT: last?.quote ?? null, lastSwapMs: last?.ms ?? null });
      if (l === null) continue;
      matured++;
      const rec = { atMs: at, survived: l.survived, rug: l.rug, mint: p.mint };
      market.push(rec);
      const creator = t.mints.get(p.mint)?.creator;
      if (creator !== undefined) {
        const list = byCreator.get(creator) ?? [];
        list.push(rec);
        byCreator.set(creator, list);
      }
    }
    while (market.length > 0 && market[0]!.atMs < now - 2 * DAY) market.shift();
  };

  const decide = (p: PoolInfo, ageMs: number, now: number, slot: bigint): void => {
    const day = melbourneDay(now);
    if (!isPracticeDay(o.window, day)) return;
    const labelAtMs = p.migratedAtMs! + SURVIVAL_RULE.horizonMs(ageMs);
    if (labelAtMs >= wall) {
      labelPastWall++;
      return;
    }
    const f = t.features(p.pool, now, slot);
    const m = t.mints.get(p.mint);
    const live = t.liveState(p.pool);
    const mcapSol = live.price === null ? null : (live.price * Number(live.supply)) / 1e9;
    const quoteSol = live.quote === null ? null : Number(live.quote) / 1e9;
    // Wallets that bought and did not sell in the last 60 min, first seen on this mint inside that hour.
    const fl = (flows.get(p.mint) ?? []).filter((x) => x.ms > now - HOUR && x.ms <= now);
    const buyers = new Set(fl.filter((x) => x.delta > 0n).map((x) => x.user));
    for (const x of fl) if (x.delta < 0n) buyers.delete(x.user);
    const fs = firstSeen.get(p.mint);
    const new60 = [...buyers].filter((u) => (fs?.get(u) ?? 0) > now - HOUR).length;
    let top10chg: number | null = null;
    if (m !== undefined && m.supply > 0n) {
      const before = new Map(m.net);
      for (const x of fl) before.set(x.user, (before.get(x.user) ?? 0n) - x.delta);
      top10chg = top10Share(m.net, m.supply) - top10Share(before, m.supply);
    }
    const mine = m === undefined ? [] : (byCreator.get(m.creator) ?? []).filter((x) => x.mint !== p.mint && x.atMs <= now);
    // Other graduates only: a graduate's own earlier label never feeds its own market rate.
    const recent = market.filter((x) => x.atMs > now - DAY && x.atMs <= now && x.mint !== p.mint);
    const px = o.solUsd(now);
    const u: Universe = ageMs >= DAY ? 'U1' : 'U2';
    const rejects = px === null ? ['H16 SOL/USD unknown'] : baseRejects(t, p, u, now, px, drive);
    decisions.push({
      id: `S:${p.mint}:${ageMs / MIN}m`, mint: p.mint, pool: p.pool, ageMs, day, regime: regimeAt(o.window, now), decisionMs: now, decisionSlot: slot,
      migratedAtMs: p.migratedAtMs!, labelAtMs, solUsd: px ?? 0, mcapSol, quoteSol, stratum: stratumOf(ageMs, mcapSol, quoteSol),
      features: {
        s_indep60: f.f_indep60, s_new60: new60, s_bundle: f.f_bundle, s_top10: f.f_top10, s_top10chg: top10chg, s_devnet: f.f_devnet,
        s_early_sold: f.f_early_sold, s_liqmig: f.f_liqmig, s_liqchg60: f.f_liqchg60, s_c2g: f.f_c2g, s_net60: f.f_net60, s_ret60: f.f_ret60,
        s_creator_surv: mine.length === 0 ? null : mine.filter((x) => x.survived).length / mine.length,
        s_creator_rugs: m === undefined ? null : mine.filter((x) => x.rug).length,
        s_market_surv: recent.length === 0 ? null : recent.filter((x) => x.survived).length / recent.length,
      },
      f, eligibleAs: rejects.length === 0 ? u : null, rejects,
    });
  };

  for (const row of guardRows(o.window, rows)) {
    const mig = row.kind === 'event' && row.event === 'CompletePumpAmmMigrationEvent' ? row.fields['pool'] ?? '' : null;
    const known = mig === null || t.pools.has(mig);
    t.push(row);
    if (row.kind === 'curve') seen(row.mint, row.user, row.blockTime * 1000, row.isBuy ? row.tokenAmount : -row.tokenAmount);
    if (row.kind === 'amm') {
      const p = t.pools.get(row.pool);
      const last = p?.last;
      if (p !== undefined && last !== null && last !== undefined && last.ms === row.blockTime * 1000 && last.user === row.user && last.slot === row.slot) {
        seen(p.mint, row.user, last.ms, last.buy ? last.base : -last.base);
      }
    }
    if (!known) {
      const p = t.pools.get(mig!);
      if (p !== undefined && p.canonical && p.mayhem === false && t.isSolQuote(p)) {
        for (const a of DECISION_AGES_MS) dues.push({ at: p.migratedAtMs! + a, pool: p.pool, ageMs: a });
        maturing.push({ at: p.migratedAtMs! + SURVIVAL_RULE.horizonMs(0), pool: p.pool });
        dirty = true;
      }
    }
    if (row.kind !== 'block') continue;
    const now = row.blockTime * 1000;
    mature(now);
    if (dues.length > 0) {
      if (dirty) dues.sort((a, b) => a.at - b.at || (a.pool < b.pool ? -1 : 1));
      dirty = false;
      while (dues.length > 0 && dues[0]!.at <= now) {
        const d = dues.shift()!;
        const p = t.pools.get(d.pool);
        if (p !== undefined) decide(p, d.ageMs, now, row.slot);
      }
    }
    dirty = false;
    if (now - lastPrune >= HOUR) {
      // Pools older than the last decision and label (48 h) plus margin are no longer needed.
      t.prune(now, 3 * DAY);
      for (const k of firstSeen.keys()) if (!t.mints.has(k)) firstSeen.delete(k);
      for (const k of flows.keys()) if (!t.mints.has(k)) flows.delete(k);
      lastPrune = now;
    }
  }
  return { decisions, labelPastWall, matured };
};
