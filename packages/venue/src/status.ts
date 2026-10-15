// A-M01-05 venue status: one status per venue that M06, M20 and M21 read, built from the config cache's events, the
// PumpSwap `GlobalConfig.disable_flags` and the realised fees of our own fills (ARCH M01 failure table).
// - A config that did not decode: unquotable (`decode_failed`), 100 bps extra exit slippage, alert `config` critical.
// - A config older than `max_age_ms`: unquotable (`config_stale`).
// - A fee config whose hash changed: `venue.fee_schedule_changed` with its direction; `fee_config_known` fails for 10
//   minutes after it (ARCH 8.4); alert warning (ARCH 13.4).
// - `disable_flags` bits: VERIFY result (card Z07): the pinned pump_amm.json (pump-public-docs 8cda1fa, GlobalConfig
//   `disable_flags` docs, lines 8234-8238) documents bit 0 create pool, 1 deposit, 2 withdraw, 3 buy, 4 sell. The README
//   calls the field "currently not used" [TH-19, TH-V04]; it is honoured anyway.
// - Realised fees of our fills: a total more than `tolerance_bps` from every candidate schedule is a mismatch; three in
//   24 h make the venue unquotable (`fee_mismatch`) until acknowledged by `venue.fee_mismatch_ack` (A3).
// Status recovers by itself when its cause clears, except `fee_mismatch`. It never blocks exits (M20 uses the last
// valid schedule plus `extraExitSlippageBps`).
import type { Bps, Clock, DecodedEvent, FeeSchedule, Pubkey, Result, UnixMs, VenueId } from '@bot/types';
import type { ConfigAccount, ConfigEvent, FeeForError, VenueConfigCache, VenueConfigCacheEntry } from './cache.ts';
import { ACCOUNTS } from './constants.ts';
import { chainTierIndex, checkTiers, type FeeTierView } from './fees.ts';

/** `unknown_layout` (NEW, addendum A16, card Z07): an event of the venue's program with a length the pinned layout does not describe. */
export type VenueStatusReason = 'ok' | 'decode_failed' | 'config_stale' | 'fee_mismatch' | 'unknown_layout' | 'disabled_flag' | 'venue_not_specified';
export interface VenueStatus {
  venue: VenueId; quotable: boolean; enabledBuy: boolean | null; enabledSell: boolean | null; reason: VenueStatusReason;
  lastScheduleChangeAtMs: UnixMs | null; lastScheduleChangeDirection: 'raised' | 'lowered' | 'mixed' | null;
  extraExitSlippageBps: Bps; feeMismatches24h: number; asOfMs: UnixMs;
}
export interface FeeScheduleChanged { venue: VenueId; oldHash: string; newHash: string; direction: 'raised' | 'lowered' | 'mixed'; atMs: UnixMs }

export interface StatusLog { event(level: 'info' | 'warn' | 'error' | 'critical', code: string, fields: Readonly<Record<string, unknown>>): void }
export interface StatusMetrics { quotable(venue: VenueId, value: 0 | 1): void; feeMismatch(venue: VenueId): void }

export interface StatusSettings { toleranceBps: number; maxPer24h: number; acks: ReadonlyArray<{ venue: VenueId; ackedAtMs: number }> }
export const STATUS_DEFAULTS: Readonly<StatusSettings> = Object.freeze({ toleranceBps: 1, maxPer24h: 3, acks: [] });

/** The config table of A-M01-05: tolerance 0..10 bps, 1..10 mismatches a day. */
export function checkStatusSettings(s: StatusSettings): Result<StatusSettings, { code: 'E_CONFIG'; key: string }> {
  if (!Number.isInteger(s.toleranceBps) || s.toleranceBps < 0 || s.toleranceBps > 10) return { ok: false, error: { code: 'E_CONFIG', key: 'venue.fee_mismatch.tolerance_bps' } };
  if (!Number.isInteger(s.maxPer24h) || s.maxPer24h < 1 || s.maxPer24h > 10) return { ok: false, error: { code: 'E_CONFIG', key: 'venue.fee_mismatch.max_per_24h' } };
  return { ok: true, value: s };
}

/** `disable_flags` bits from the pinned IDL (header). */
export const DISABLE_BUY_BIT = 1 << 3;
export const DISABLE_SELL_BIT = 1 << 4;
const DAY_MS = 86_400_000;
const FEE_KNOWN_AFTER_CHANGE_MS = 600_000;
const UNQUOTABLE_EXIT_SLIPPAGE_BPS = 100;
const VENUES: readonly VenueId[] = ['pump_curve', 'pumpswap', 'raydium_amm_v4', 'raydium_cpmm'];

type FeeConfig = Extract<ConfigAccount, { kind: 'pump_fee_config' }>;
const tiersOf = (d: FeeConfig): FeeTierView[] => {
  const t = checkTiers(d.tiers.map((x) => ({ thresholdLamports: x.thresholdLamports, fees: { lpBps: x.lpBps, protocolBps: x.protocolBps, creatorBps: x.creatorBps } })));
  return t.ok ? t.value : [];
};
const total = (f: { lpBps: number; protocolBps: number; creatorBps: number }): number => f.lpBps + f.protocolBps + f.creatorBps;

/**
 * Logic 3: compares the total charged at every threshold either config names, and the flat schedule. `raised` when some
 * total rose and none fell, `lowered` the reverse, else `mixed` (also when no total moved: the account changed anyway).
 */
export function changeDirection(prev: ConfigAccount, next: ConfigAccount): 'raised' | 'lowered' | 'mixed' {
  if (prev.kind !== 'pump_fee_config' || next.kind !== 'pump_fee_config') return 'mixed';
  const [a, b] = [prev as FeeConfig, next as FeeConfig];
  const [ta, tb] = [tiersOf(a), tiersOf(b)];
  const deltas = [total(b.flat) - total(a.flat)];
  if (ta.length > 0 && tb.length > 0) {
    for (const m of new Set([...ta, ...tb].map((t) => t.thresholdLamports))) {
      deltas.push(total((tb[chainTierIndex(tb, m)] as FeeTierView).fees) - total((ta[chainTierIndex(ta, m)] as FeeTierView).fees));
    }
  }
  const up = deltas.some((d) => d > 0);
  const down = deltas.some((d) => d < 0);
  return up && !down ? 'raised' : down && !up ? 'lowered' : 'mixed';
}

/** The realised total of one of our fills, or null when it says nothing about the schedule (logic 5, edges 1-2). */
function realisedBps(e: DecodedEvent): { venue: VenueId; bps: number } | null {
  if (e.kind === 'pumpswap_buy' || e.kind === 'pumpswap_sell') return { venue: 'pumpswap', bps: e.lpFeeBps + e.protocolFeeBps + e.coinCreatorFeeBps };
  // Edge 1: a mayhem-mode curve trade charges 0/0 [EX-05]; the frozen `pump_trade` has no `mayhem_mode` field, so a
  // zero total is read as mayhem and not counted (a zero fee is never a cost understated).
  if (e.kind === 'pump_trade') return e.feeBps + e.creatorFeeBps === 0 ? null : { venue: 'pump_curve', bps: e.feeBps + e.creatorFeeBps };
  return null;
}

export interface VenueStatusService {
  status(venue: VenueId): VenueStatus;
  /** `fee_config_known` (ARCH 8.4): false for 10 minutes after any change of the venue's fee config. */
  feeConfigKnown(venue: VenueId): boolean;
  onFillEvent(e: DecodedEvent, expected: { poolId: Pubkey; candidates: readonly FeeSchedule[] }): void;
  /** Recomputes every status (staleness moves with the clock) and publishes the ones that changed. */
  evaluate(): void;
  /** A new `venue.fee_mismatch_ack` list (applied config): mismatches up to each ack are cleared. */
  setAcks(acks: StatusSettings['acks']): void;
  /**
   * Addendum A16: M02 found an event of this venue's program whose length the pinned layout does not describe
   * (`decoder.unknown_layout`, kind `unknown_length`). The venue is unquotable until the pair is in
   * `decoders.reviewed_discriminators` (`isReviewed`, re-read at every evaluation).
   */
  onUnknownLayout(e: { venue: VenueId; programId: Pubkey; discriminatorHex: string }): void;
}

export function createVenueStatusService(deps: {
  clock: Clock; cache: VenueConfigCache; log: StatusLog; metrics?: StatusMetrics; settings?: StatusSettings;
  publishStatus(s: VenueStatus): void; publishScheduleChange(e: FeeScheduleChanged): void;
  /** `decoders.reviewed_discriminators` (A-M02-05 `Quarantine.isReviewed`); none reviewed when absent. */
  isReviewed?(programId: Pubkey, discriminatorHex: string): boolean;
}): VenueStatusService {
  const settings = { ...(deps.settings ?? STATUS_DEFAULTS) };
  const checked = checkStatusSettings(settings);
  if (!checked.ok) throw checked.error;
  const mismatches = new Map<VenueId, number[]>();
  /** When a venue reached max_per_24h; it stays unquotable until an ack at or after this time (logic 7). */
  const latchedAt = new Map<VenueId, number>();
  const lastChange = new Map<VenueId, { atMs: UnixMs; direction: FeeScheduleChanged['direction'] }>();
  const published = new Map<VenueId, string>();
  const unknownLayouts = new Map<VenueId, Array<{ programId: Pubkey; discriminatorHex: string }>>();
  const demoted = (venue: VenueId): boolean => (unknownLayouts.get(venue) ?? []).some((u) => !(deps.isReviewed?.(u.programId, u.discriminatorHex) ?? false));

  deps.cache.onEvent((e: ConfigEvent) => {
    // A decode failure is logged by the cache (`m01.fee_config_decode_failed`); the status change below alerts too.
    if (e.kind === 'changed' && e.previous !== null && (e.entry.name === 'feeConfigCurve' || e.entry.name === 'feeConfigPumpSwap')) {
      scheduleChanged(e.previous, e.entry);
    }
    evaluate();
  });

  function scheduleChanged(prev: VenueConfigCacheEntry, next: VenueConfigCacheEntry): void {
    const direction = changeDirection(prev.decoded, next.decoded);
    const atMs = deps.clock.nowMs();
    lastChange.set(next.venue, { atMs, direction });
    deps.log.event('warn', 'm01.fee_schedule_changed', { venue: next.venue, old_hash: prev.configHash, new_hash: next.configHash, direction });
    deps.publishScheduleChange({ venue: next.venue, oldHash: prev.configHash, newHash: next.configHash, direction, atMs });
  }

  const lastAck = (venue: VenueId): number => Math.max(-Infinity, ...settings.acks.filter((a) => a.venue === venue).map((a) => a.ackedAtMs));
  /** Mismatches in the last 24 h, after the last ack. */
  const recent = (venue: VenueId, now: number): number[] => (mismatches.get(venue) ?? []).filter((t) => t > lastAck(venue) && now - t < DAY_MS);
  const latched = (venue: VenueId): boolean => {
    const at = latchedAt.get(venue);
    return at !== undefined && lastAck(venue) < at;
  };

  function compute(venue: VenueId): VenueStatus {
    const now = deps.clock.nowMs();
    const change = lastChange.get(venue) ?? null;
    const base = {
      venue, lastScheduleChangeAtMs: change?.atMs ?? null, lastScheduleChangeDirection: change?.direction ?? null,
      feeMismatches24h: recent(venue, now).length, asOfMs: now,
    };
    const unquotable = (reason: VenueStatusReason, enabledBuy: boolean | null = null, enabledSell: boolean | null = null): VenueStatus =>
      ({ ...base, quotable: false, enabledBuy, enabledSell, reason, extraExitSlippageBps: UNQUOTABLE_EXIT_SLIPPAGE_BPS });
    if (venue !== 'pump_curve' && venue !== 'pumpswap') return unquotable('venue_not_specified');
    const names = venue === 'pump_curve' ? (['feeConfigCurve'] as const) : (['feeConfigPumpSwap', 'pumpSwapGlobalConfig'] as const);
    if (names.some((n) => deps.cache.decodeFailed(n))) return unquotable('decode_failed');
    if (latched(venue)) return unquotable('fee_mismatch');
    if (demoted(venue)) return unquotable('unknown_layout');
    const inputs: Result<unknown, FeeForError> = deps.cache.inputs(venue);
    // Decode failures were caught above, so what is left is a config never read or older than max_age_ms.
    if (!inputs.ok) return unquotable('config_stale');
    let enabledBuy = true;
    let enabledSell = true;
    if (venue === 'pumpswap') {
      // `inputs` succeeded, so the global config decoded and is fresh.
      const g = deps.cache.entry(ACCOUNTS.pumpSwapGlobalConfig)?.decoded as Extract<ConfigAccount, { kind: 'pumpswap_global_config' }>;
      enabledBuy = (g.disableFlags & DISABLE_BUY_BIT) === 0;
      enabledSell = (g.disableFlags & DISABLE_SELL_BIT) === 0;
    }
    return { ...base, quotable: true, enabledBuy, enabledSell, reason: enabledBuy && enabledSell ? 'ok' : 'disabled_flag', extraExitSlippageBps: 0 };
  }

  function evaluate(): void {
    for (const venue of VENUES) {
      const s = compute(venue);
      const key = `${s.quotable}|${s.reason}|${s.enabledBuy}|${s.enabledSell}|${s.lastScheduleChangeAtMs}`;
      if (published.get(venue) === key) continue;
      published.set(venue, key);
      deps.metrics?.quotable(venue, s.quotable ? 1 : 0);
      deps.log.event(s.quotable ? 'info' : 'critical', 'm01.venue_status_changed', { venue, reason: s.reason, quotable: s.quotable });
      deps.publishStatus(s);
    }
  }

  return {
    status: compute,
    feeConfigKnown(venue) {
      const c = lastChange.get(venue);
      return compute(venue).quotable && (c === undefined || deps.clock.nowMs() - c.atMs >= FEE_KNOWN_AFTER_CHANGE_MS);
    },
    onFillEvent(e, expected) {
      const r = realisedBps(e);
      if (r === null) return;
      if (expected.candidates.some((c) => Math.abs(c.totalBps - r.bps) <= settings.toleranceBps)) return;
      const now = deps.clock.nowMs();
      mismatches.set(r.venue, [...recent(r.venue, now), now]);
      if (recent(r.venue, now).length >= settings.maxPer24h) latchedAt.set(r.venue, now);
      deps.metrics?.feeMismatch(r.venue);
      deps.log.event('error', 'm01.fee_mismatch', { venue: r.venue, pool: expected.poolId, realised_bps: r.bps, candidates: expected.candidates.map((c) => c.totalBps) });
      evaluate();
    },
    evaluate,
    setAcks(acks) {
      settings.acks = acks;
      evaluate();
    },
    onUnknownLayout(e) {
      const list = unknownLayouts.get(e.venue) ?? [];
      if (!list.some((u) => u.programId === e.programId && u.discriminatorHex === e.discriminatorHex)) list.push({ programId: e.programId, discriminatorHex: e.discriminatorHex });
      unknownLayouts.set(e.venue, list);
      evaluate();
    },
  };
}
