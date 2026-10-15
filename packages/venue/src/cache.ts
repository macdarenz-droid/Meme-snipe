// A-M01-02 venue config cache and A-M01-03's `VenueModel` on it. One `getMultipleAccounts` (confirmed, P3) every
// `venue.fee_config.refresh_ms` reads the two pump-fees `FeeConfig`s, the PumpSwap `GlobalConfig` and the pump `Global`
// [EX-01]; each is checked for owner, decoded (A-M02-02) and hashed (sha256 of the raw data). A changed hash bumps the
// entry's version and is reported to the listeners (A-M01-05 turns it into `venue.fee_schedule_changed`). Versions stay
// in memory and in the log line `m01.fee_config_changed` (ruling Z07-4; an M24 table is clarification C-81).
// Single writer: `refresh()`; a refresh builds new entry objects and swaps them in, so readers keep immutable entries.
// Reads go through the `AccountsReader` port (the engine wires it to M14 `RpcGateway.call`), so this package has no I/O.
import { createHash } from 'node:crypto';
import type { Bps, Clock, FeeSchedule, Lamports, Pubkey, Quote, Result, Slot, UnixMs } from '@bot/types';
import { ACCOUNTS, PROGRAMS } from './constants.ts';
import { candidateSplits, feeScheduleFor, marketCapOf, toSchedule, type FeeConfigView, type FeeInputs, type FeeSplit } from './fees.ts';
import type { CpPoolState } from './pool.ts';
import { effectiveQuote, isAllowedVenue, minOut, quoteExactIn, type QuoteError, type TierRule } from './quote.ts';

/** The decoded variants this cache reads (A-M02-02 `DecodedAccount`), structurally. */
export type ConfigAccount =
  | { kind: 'pump_fee_config'; tiers: Array<{ thresholdLamports: Lamports; lpBps: Bps; protocolBps: Bps; creatorBps: Bps }>;
      flat: { lpBps: Bps; protocolBps: Bps; creatorBps: Bps }; raw: Record<string, unknown> }
  | { kind: 'pumpswap_global_config'; disableFlags: number; creatorFeeConfigurable: boolean; maxConfigurableCreatorFeeBps: Bps; raw: Record<string, unknown> }
  | { kind: 'pump_global'; raw: Record<string, unknown> }
  | { kind: string };

export interface RawAccount { owner: Pubkey; data: Uint8Array }
/** One batched read at `confirmed`: the context slot and each account in order (null when missing). */
export interface AccountsReader {
  read(accounts: readonly Pubkey[]): Promise<Result<{ contextSlot: Slot; accounts: ReadonlyArray<RawAccount | null> }, { code: string; message?: string }>>;
}
export interface ConfigDecoder { decodeAccount(owner: Pubkey, data: Uint8Array): ConfigAccount }
export interface VenueLog { event(level: 'info' | 'warning' | 'error' | 'critical', code: string, fields: Readonly<Record<string, unknown>>): void }

export type ConfigName = 'feeConfigCurve' | 'feeConfigPumpSwap' | 'pumpSwapGlobalConfig' | 'pumpGlobal';
const CONFIGS: ReadonlyArray<{ name: ConfigName; account: Pubkey; owner: Pubkey; kind: string }> = [
  { name: 'feeConfigCurve', account: ACCOUNTS.feeConfigCurve, owner: PROGRAMS.pumpFees, kind: 'pump_fee_config' },
  { name: 'feeConfigPumpSwap', account: ACCOUNTS.feeConfigPumpSwap, owner: PROGRAMS.pumpFees, kind: 'pump_fee_config' },
  { name: 'pumpSwapGlobalConfig', account: ACCOUNTS.pumpSwapGlobalConfig, owner: PROGRAMS.pumpSwap, kind: 'pumpswap_global_config' },
  { name: 'pumpGlobal', account: ACCOUNTS.pumpGlobal, owner: PROGRAMS.pumpCurve, kind: 'pump_global' },
];

export interface VenueConfigCacheEntry {
  venue: 'pump_curve' | 'pumpswap'; name: ConfigName; account: Pubkey; version: number; configHash: string;
  decoded: ConfigAccount; asOfSlot: Slot; readAtMs: UnixMs; changedAtMs: UnixMs;
}

/** A config account changed (`previous` null on the first read) or failed to decode; a refresh ended (`ok` false: the read failed). */
export type ConfigEvent =
  | { kind: 'changed'; previous: VenueConfigCacheEntry | null; entry: VenueConfigCacheEntry }
  | { kind: 'decode_failed'; name: ConfigName; account: Pubkey; reason: string }
  | { kind: 'refreshed'; ok: boolean };

export interface VenueConfigSettings { refreshMs: number; maxAgeMs: number }
export const VENUE_CONFIG_DEFAULTS: Readonly<VenueConfigSettings> = Object.freeze({ refreshMs: 60_000, maxAgeMs: 600_000 });

/** Config validation (A-M01-02 config table): refresh 10 s..300 s; max age ≥ 2 × refresh and ≤ 600 s. */
export function checkVenueConfigSettings(s: VenueConfigSettings): Result<VenueConfigSettings, { code: 'E_CONFIG'; key: string }> {
  const int = (v: number) => Number.isInteger(v);
  if (!int(s.refreshMs) || s.refreshMs < 10_000 || s.refreshMs > 300_000) return { ok: false, error: { code: 'E_CONFIG', key: 'venue.fee_config.refresh_ms' } };
  if (!int(s.maxAgeMs) || s.maxAgeMs < 2 * s.refreshMs || s.maxAgeMs > 600_000) return { ok: false, error: { code: 'E_CONFIG', key: 'venue.fee_config.max_age_ms' } };
  return { ok: true, value: s };
}

export type FeeForError = { code: 'E_FEE_UNKNOWN' | 'E_CONFIG_STALE'; detail: string };

export interface VenueConfigCache {
  refresh(): Promise<void>;
  entry(account: Pubkey): VenueConfigCacheEntry | null;
  /** The fee inputs for `venue` now, or why they cannot be trusted (decode failure, unread, older than `max_age_ms`). */
  inputs(venue: CpPoolState['venue']): Result<FeeInputs, FeeForError>;
  /** True when the account's last read failed to decode (A-M01-05 logic 1). */
  decodeFailed(name: ConfigName): boolean;
  /** Every schedule the conservative rule considers at the pool's market cap (A-M01-05 realised-fee check). */
  candidateTiers(p: CpPoolState): FeeSchedule[];
  onEvent(listener: (e: ConfigEvent) => void): () => void;
}

const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

const split = (f: unknown): FeeSplit => {
  const x = f as { lp_fee_bps: bigint; protocol_fee_bps: bigint; creator_fee_bps: bigint };
  return { lpBps: Number(x.lp_fee_bps), protocolBps: Number(x.protocol_fee_bps), creatorBps: Number(x.creator_fee_bps) };
};

/** A decoded `pump_fee_config` entry as the fee rules read it. */
export function feeConfigView(e: VenueConfigCacheEntry): FeeConfigView {
  const d = e.decoded as Extract<ConfigAccount, { kind: 'pump_fee_config' }>;
  return {
    account: e.account, asOfSlot: e.asOfSlot, configHash: e.configHash,
    tiers: d.tiers.map((t) => ({ thresholdLamports: t.thresholdLamports, fees: { lpBps: t.lpBps, protocolBps: t.protocolBps, creatorBps: t.creatorBps } })),
    flat: { ...d.flat }, exoticFlat: split(d.raw.exotic_flat_fees),
  };
}

export function createVenueConfigCache(deps: { reader: AccountsReader; decoder: ConfigDecoder; clock: Clock; log: VenueLog; settings?: VenueConfigSettings }): VenueConfigCache {
  const settings = deps.settings ?? VENUE_CONFIG_DEFAULTS;
  const checked = checkVenueConfigSettings(settings);
  if (!checked.ok) throw checked.error;
  const entries = new Map<ConfigName, VenueConfigCacheEntry>();
  const failed = new Set<ConfigName>();
  const listeners = new Set<(e: ConfigEvent) => void>();
  const emit = (e: ConfigEvent): void => { for (const l of listeners) l(e); };

  const fail = (c: (typeof CONFIGS)[number], reason: string): void => {
    failed.add(c.name);
    deps.log.event('critical', 'm01.fee_config_decode_failed', { name: c.name, reason });
    emit({ kind: 'decode_failed', name: c.name, account: c.account, reason });
  };

  async function refresh(): Promise<void> {
    const r = await deps.reader.read(CONFIGS.map((c) => c.account));
    if (!r.ok) {
      // Edge 3: keep the last entries; `inputs` turns stale after max_age_ms.
      deps.log.event('warning', 'm01.fee_config_refresh_failed', { code: r.error.code });
      emit({ kind: 'refreshed', ok: false });
      return;
    }
    const now = deps.clock.nowMs();
    CONFIGS.forEach((c, i) => {
      const raw = r.value.accounts[i] ?? null;
      // Edge 2: a missing account, or one not owned by the expected program, is a decode failure.
      if (raw === null) return fail(c, 'missing');
      if (raw.owner !== c.owner) return fail(c, 'owner');
      const decoded = deps.decoder.decodeAccount(raw.owner, raw.data);
      if (decoded.kind !== c.kind) return fail(c, 'layout');
      failed.delete(c.name);
      const configHash = sha256(raw.data);
      const prev = entries.get(c.name) ?? null;
      const same = prev !== null && prev.configHash === configHash;
      const entry: VenueConfigCacheEntry = {
        venue: c.name === 'feeConfigCurve' || c.name === 'pumpGlobal' ? 'pump_curve' : 'pumpswap', name: c.name, account: c.account,
        version: same ? prev.version : (prev?.version ?? 0) + 1, configHash, decoded, asOfSlot: r.value.contextSlot, readAtMs: now,
        changedAtMs: same ? prev.changedAtMs : now,
      };
      entries.set(c.name, entry);
      if (!same) {
        deps.log.event(prev === null ? 'info' : 'warning', 'm01.fee_config_changed', { name: c.name, oldHash: prev?.configHash ?? null, newHash: configHash, version: entry.version });
        emit({ kind: 'changed', previous: prev, entry });
      }
    });
    deps.log.event('info', 'm01.fee_config_refreshed', { slot: r.value.contextSlot });
    emit({ kind: 'refreshed', ok: true });
  }

  /** The entry when it decoded and is younger than max_age_ms; otherwise why not. */
  function usable(name: ConfigName, now: UnixMs): Result<VenueConfigCacheEntry, FeeForError> {
    const e = entries.get(name);
    if (failed.has(name)) return { ok: false, error: { code: 'E_FEE_UNKNOWN', detail: `${name} did not decode` } };
    if (e === undefined) return { ok: false, error: { code: 'E_FEE_UNKNOWN', detail: `${name} not read yet` } };
    if (now - e.readAtMs > settings.maxAgeMs) return { ok: false, error: { code: 'E_CONFIG_STALE', detail: `${name} read ${now - e.readAtMs} ms ago` } };
    return { ok: true, value: e };
  }

  function inputs(venue: CpPoolState['venue']): Result<FeeInputs, FeeForError> {
    const now = deps.clock.nowMs();
    if (venue === 'pump_curve') {
      const c = usable('feeConfigCurve', now);
      return c.ok ? { ok: true, value: { curve: feeConfigView(c.value), pumpswap: null, creatorFeeConfigurable: null } } : c;
    }
    if (venue !== 'pumpswap') return { ok: false, error: { code: 'E_FEE_UNKNOWN', detail: `no fee rules for ${venue} until A-M01-06` } };
    const f = usable('feeConfigPumpSwap', now);
    if (!f.ok) return f;
    const g = usable('pumpSwapGlobalConfig', now);
    if (!g.ok) return g;
    const global = g.value.decoded as Extract<ConfigAccount, { kind: 'pumpswap_global_config' }>;
    return { ok: true, value: { curve: null, pumpswap: feeConfigView(f.value), creatorFeeConfigurable: global.creatorFeeConfigurable } };
  }

  return {
    refresh,
    entry: (account) => [...entries.values()].find((e) => e.account === account) ?? null,
    inputs,
    decodeFailed: (name) => failed.has(name),
    candidateTiers(p) {
      const i = inputs(p.venue);
      const mcap = marketCapOf(p);
      if (!i.ok || mcap === null) return [];
      const c = candidateSplits(p, i.value, [mcap]);
      return c.ok ? c.value.splits.map((s) => toSchedule(s, c.value.cfg)) : [];
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

/** ARCH M01 `VenueModel` (A-M01-02 and A-M01-03), reading the cache at call time. */
export interface VenueModel {
  effectiveQuote(p: CpPoolState): Lamports;
  marketCapLamports(p: CpPoolState): Lamports;
  feeFor(p: CpPoolState): Result<FeeSchedule, FeeForError>;
  quoteExactIn(p: CpPoolState, side: 'buy' | 'sell', amountIn: bigint, rule?: TierRule): Result<Quote, QuoteError>;
  minOut(q: Quote, slippageBps: Bps): bigint;
  isAllowedVenue(programId: Pubkey): CpPoolState['venue'] | null;
}

export function createVenueModel(cache: VenueConfigCache): VenueModel {
  return {
    effectiveQuote,
    marketCapLamports(p) {
      const m = marketCapOf(p);
      if (m === null) throw { code: p.baseReserve <= 0n ? 'E_ZERO_RESERVE' : 'E_NEGATIVE_EFFECTIVE' };
      return m;
    },
    feeFor(p) {
      const i = cache.inputs(p.venue);
      return i.ok ? feeScheduleFor(p, i.value) : i;
    },
    quoteExactIn(p, side, amountIn, rule = 'conservative') {
      if (p.venue === 'pump_curve' || p.venue === 'pumpswap') {
        const i = cache.inputs(p.venue);
        if (!i.ok) return { ok: false, error: { code: i.error.code, detail: i.error.detail } };
        return quoteExactIn(p, side, amountIn, i.value, rule);
      }
      return quoteExactIn(p, side, amountIn, { curve: null, pumpswap: null, creatorFeeConfigurable: null }, rule);
    },
    minOut,
    isAllowedVenue,
  };
}
