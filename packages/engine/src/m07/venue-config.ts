// Recording the venue config accounts (card Z08, supervisor 2026-10-07: "the PumpSwap GlobalConfig and FeeConfig
// accounts at start and every 10 min"). The Z07 cache (`@bot/venue` cache.ts) already reads the two pump-fees
// FeeConfigs, the PumpSwap GlobalConfig and the pump Global in one getMultipleAccounts every
// `venue.fee_config.refresh_ms` (60 s, at most 300 s); this module adds no read. It writes, on the never-dropped
// `venue_config` stream, a snapshot of every cached entry at start (after the first successful refresh) and every
// 10 minutes, and a record for every change and every decode failure the cache reports. Payloads are public chain data
// (decoded fields, the raw data's hash, version and slot); bigints are written as decimal strings by the recorder.
import type { Slot, UnixMs } from '@bot/types';
import type { ConfigEvent, ConfigName, VenueConfigCache, VenueConfigCacheEntry } from '@bot/venue';
import { ACCOUNTS } from '@bot/venue';

export const SNAPSHOT_EVERY_MS = 600_000;
const NAMES: readonly ConfigName[] = ['feeConfigCurve', 'feeConfigPumpSwap', 'pumpSwapGlobalConfig', 'pumpGlobal'];

export interface VenueConfigRecord { stream: 'venue_config'; recvMs: UnixMs; slot: Slot | null; commitment: 'confirmed'; source: 'm01'; payload: unknown }

/** Byte arrays become hex; everything else is kept (the recorder writes bigints as decimal strings). */
function plain(v: unknown): unknown {
  if (v instanceof Uint8Array) return Buffer.from(v).toString('hex');
  if (Array.isArray(v)) return v.map(plain);
  if (typeof v === 'object' && v !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = plain(x);
    return out;
  }
  return v;
}

const entryPayload = (kind: 'snapshot' | 'changed', e: VenueConfigCacheEntry, previousHash: string | null): unknown => ({
  kind, name: e.name, account: e.account, venue: e.venue, version: e.version, configHash: e.configHash, previousHash,
  asOfSlot: e.asOfSlot, readAtMs: e.readAtMs, changedAtMs: e.changedAtMs, decoded: plain(e.decoded),
});

export interface VenueConfigRecorder {
  /** Call every second or so: writes the snapshot when one is due. */
  tick(nowMs: UnixMs): void;
  stop(): void;
}

export function recordVenueConfig(o: { cache: VenueConfigCache; append: (r: VenueConfigRecord) => void; nowMs: () => UnixMs; everyMs?: number }): VenueConfigRecorder {
  const every = o.everyMs ?? SNAPSHOT_EVERY_MS;
  let lastSnapshot: number | null = null;
  const write = (payload: unknown, slot: Slot | null): void => {
    o.append({ stream: 'venue_config', recvMs: o.nowMs(), slot, commitment: 'confirmed', source: 'm01', payload });
  };
  const snapshot = (now: number): boolean => {
    const entries = NAMES.map((n) => o.cache.entry(ACCOUNTS[n])).filter((e): e is VenueConfigCacheEntry => e !== null);
    if (entries.length === 0) return false;                                // nothing read yet: the first refresh writes it
    for (const e of entries) write(entryPayload('snapshot', e, null), e.asOfSlot);
    lastSnapshot = now;
    return true;
  };
  const off = o.cache.onEvent((ev: ConfigEvent) => {
    if (ev.kind === 'changed') write(entryPayload('changed', ev.entry, ev.previous?.configHash ?? null), ev.entry.asOfSlot);
    else if (ev.kind === 'decode_failed') write({ kind: 'decode_failed', name: ev.name, account: ev.account, reason: ev.reason }, null);
    else if (ev.ok && lastSnapshot === null) snapshot(o.nowMs());          // the start snapshot, after the first good refresh
  });
  return {
    tick(nowMs: UnixMs): void {
      if (lastSnapshot === null || nowMs - lastSnapshot >= every || nowMs < lastSnapshot) snapshot(nowMs);
    },
    stop: off,
  };
}
