// RUG-1c: the on-demand rug check of one deployer (docs/DECISIONS.md "Rug labels"). Neither the live feed nor the
// backtest day files hold every trade of every prior mint, so at decision time the worker fetches the history of the
// candidate deployer's prior mints and judges each with rugs-1, as of the decision moment. The result is one fact per
// deployer, `coverage:rugs:deployer:<creator>`, plus a `rug:<mint>` label per rug found. H14 accepts it as coverage
// for that deployer only, and only when every prior mint in the look-back was judged; anything else is not covered.
import { compareMoments, type Moment } from '../engine/moment.ts';
import type { MarketEvent } from '../engine/feed.ts';
import type { RugCheckConfig, RugConfig } from '../config/rugs.ts';
import type { FactObs } from './facts.ts';
import { RUG_PREFIX, RUG_UNJUDGED_PREFIX } from './deployer-index.ts';
import { RugLabeller, type RugLabel } from './rug-labeller.ts';

export const RUG_CHECK_PREFIX = 'coverage:rugs:deployer:';
export const rugCheckKey = (creator: string): string => `${RUG_CHECK_PREFIX}${creator}`;

/**
 * - `rug`: labelled by rugs-1 at or before the as-of moment.
 * - `clear`: no label, and the mint's windows ended before the as-of moment.
 * - `open`: no label so far, windows still open: judged on what exists, and judged again at the next check.
 * - `unfetched`: its history was not read in full (credit cap, RPC failure, no create in it): not judged.
 * - `unjudged`: rugs-1 cannot judge it (no total supply).
 */
export type MintStatus = 'rug' | 'clear' | 'open' | 'unfetched' | 'unjudged';

export interface MintCheck {
  readonly mint: string;
  readonly createdAtMs: number;
  readonly status: MintStatus;
  readonly detail: string;
  readonly label?: RugLabel;
}

/** The per-deployer check. `obs.slot` is the as-of slot: no transaction after it was read. */
export interface RugCheckFact {
  readonly obs: FactObs;
  readonly creator: string;
  readonly version: string;
  /** Prior mints created from this time on were listed for the check (the look-back start it was asked for). */
  readonly fromMs: number;
  /** Chain time of the as-of slot. */
  readonly asOfMs: number;
  readonly mints: readonly MintCheck[];
  /** Credits the check used. */
  readonly credits: number;
}

const STATUSES: ReadonlySet<string> = new Set(['rug', 'clear', 'open', 'unfetched', 'unjudged']);
type Obj = Readonly<Record<string, unknown>>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isMs = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);

/** A check fact as FEED-1 delivers it (wrapped as `{ value, … }` for off-chain facts), or null. */
export const parseRugCheck = (raw: unknown): RugCheckFact | null => {
  const v = isObj(raw) && isObj(raw['value']) ? raw['value'] : raw;
  if (!isObj(v) || !isObj(v['obs']) || typeof v['creator'] !== 'string' || typeof v['version'] !== 'string') return null;
  const o = v['obs'];
  if (typeof o['slot'] !== 'bigint' || !isMs(o['receivedAt']) || o['commitment'] !== 'confirmed') return null;
  if (!isMs(v['fromMs']) || !isMs(v['asOfMs']) || !isMs(v['credits']) || !Array.isArray(v['mints'])) return null;
  for (const m of v['mints'] as unknown[]) {
    if (!isObj(m) || typeof m['mint'] !== 'string' || !isMs(m['createdAtMs']) || typeof m['status'] !== 'string' || !STATUSES.has(m['status'])) return null;
  }
  return v as unknown as RugCheckFact;
};

/**
 * Judges one prior mint from its released events (DEC-1's events as FEED-1 emits them), as of `asOf`: events after it
 * are not read. Feed events in order; `observe` returns true once the answer can no longer change (a label).
 */
export class MintJudge {
  readonly #labeller: RugLabeller;
  readonly #config: RugConfig;
  readonly #mint: string;
  readonly #createdAtMs: number;
  readonly #asOf: Moment;
  #created = false;
  #label: RugLabel | null = null;
  #unjudged: string | null = null;

  constructor(config: RugConfig, mint: string, createdAtMs: number, asOf: Moment) {
    this.#labeller = new RugLabeller(config);
    this.#config = config;
    this.#mint = mint;
    this.#createdAtMs = createdAtMs;
    this.#asOf = asOf;
  }

  observe(e: MarketEvent): boolean {
    if (this.#label !== null || this.#unjudged !== null || compareMoments(e.moment, this.#asOf) > 0) return this.decided;
    for (const f of this.#labeller.observe(e)) {
      const v = f.value as RugLabel & { readonly reason?: string };
      if (v.mint !== this.#mint) continue;
      if (f.key.startsWith(RUG_UNJUDGED_PREFIX)) this.#unjudged = v.reason ?? 'not judged';
      else if (f.key.startsWith(RUG_PREFIX)) this.#label = v;
    }
    if (!this.#created && this.#labeller.tracked.launches > 0) this.#created = true;
    return this.decided;
  }

  get decided(): boolean {
    return this.#label !== null || this.#unjudged !== null;
  }

  /** The answer as of the as-of moment, whose chain time is `asOfMs`. */
  result(asOfMs: number): MintCheck {
    const base = { mint: this.#mint, createdAtMs: this.#createdAtMs };
    if (this.#label !== null) return { ...base, status: 'rug', detail: `${this.#label.rule}: ${this.#label.detail}`, label: this.#label };
    if (this.#unjudged !== null) return { ...base, status: 'unjudged', detail: this.#unjudged };
    if (!this.#created) return { ...base, status: 'unfetched', detail: 'the history read holds no create of this mint' };
    const end = this.#createdAtMs + Math.max(this.#config.creatorDump.windowMs, this.#config.collapse.windowMs);
    return end < asOfMs
      ? { ...base, status: 'clear', detail: 'no rule met inside its windows' }
      : { ...base, status: 'open', detail: `no rule met so far; windows end at ${end}` };
  }
}

/**
 * The earliest launch a deployer check must read: H14's look-back start less the longest rug window. A mint launched
 * just before the look-back can still be labelled inside it (the stream dates a label when it is made), so the check
 * covers the same mints the stream would.
 */
export const rugCheckFromMs = (lookbackStartMs: number, rugs: RugConfig): number =>
  lookbackStartMs - Math.max(rugs.creatorDump.windowMs, rugs.collapse.windowMs);

export type CheckCover = { readonly covered: true; readonly rugs: readonly { readonly mint: string; readonly kind?: string; readonly atMs?: number }[] } | { readonly covered: false; readonly detail: string };

/**
 * Whether a deployer's check covers H14's rug half at `now`: made for this creator, listing mints from at or before
 * `fromMs` (`rugCheckFromMs`), at most `maxLagSlots` behind now, and with every prior mint the index knows from then (the candidate
 * excepted) judged as rug, clear or open. Returns the mints it found to be rugs.
 */
export const deployerCheckCovers = (
  fact: RugCheckFact, creator: string, priorMints: readonly string[], fromMs: number, now: Moment, cfg: RugCheckConfig,
): CheckCover => {
  if (fact.creator !== creator) return { covered: false, detail: `the check is for ${fact.creator}, not ${creator}` };
  if (fact.fromMs > fromMs) return { covered: false, detail: `the check lists mints from ${fact.fromMs}; it must list mints from ${fromMs}` };
  if (fact.obs.slot === null) return { covered: false, detail: 'the check has no as-of slot' };
  const behind = now.slot - fact.obs.slot;
  if (behind < 0n) return { covered: false, detail: `the check is dated after now (slot ${fact.obs.slot})` };
  if (behind > BigInt(cfg.maxLagSlots)) return { covered: false, detail: `the check is ${behind} slots behind now (at most ${cfg.maxLagSlots})` };
  const byMint = new Map(fact.mints.map((m) => [m.mint, m]));
  for (const mint of [...priorMints].sort()) {
    const m = byMint.get(mint);
    if (m === undefined) return { covered: false, detail: `the check did not list ${mint}` };
    if (m.status === 'unfetched' || m.status === 'unjudged') return { covered: false, detail: `${mint} ${m.status}: ${m.detail}` };
  }
  const rugs = fact.mints.filter((m) => m.status === 'rug').sort((a, b) => (a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0));
  // R2-2: the label's chain time goes with it, so H14 applies the same look-back as to the stream's labels. A label
  // without a usable date carries none (H14 counts it: the safe side).
  const atOf = (m: MintCheck): { atMs?: number } => (m.label !== undefined && isMs(m.label.atMs) ? { atMs: m.label.atMs } : {});
  return { covered: true, rugs: rugs.map((m) => (m.label === undefined ? { mint: m.mint } : { mint: m.mint, kind: m.label.rule, ...atOf(m) })) };
};
