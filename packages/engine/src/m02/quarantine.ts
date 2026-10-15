// A-M02-05 quarantine of unknown discriminators and layouts (M02 owns the writer; ARCH M02 failure table). Each
// unknown event or account layout from an allowlisted program is recorded once per (program, discriminator): one
// `quarantine` row (M24, append-only) with the first raw sample, one `config` warning, and one `decoder.unknown_layout`
// per affected pool. Counts stay in memory and are logged every flush (`m02.quarantine_counts`); the table has no count
// column (ARCH 15). A failed database write keeps the record in memory and retries at the next flush; it never blocks
// decoding. Unblocking needs the pair in `decoders.reviewed_discriminators` (an `apply_config`, A3: increases risk).
// Addendum A16 (card Z07): an event whose length the pinned layout does not describe (`layoutExtended`) is recorded the
// same way with `kind: 'unknown_length'`, and M01 demotes its venue until the pair is reviewed (A-M01-05).
// Raw bytes are stored base64, capped at 10 KB, and never rendered unescaped (security notes).
import type { Clock, Pubkey, Signature, UnixMs } from '@bot/types';

export type LayoutKind = 'unknown_discriminator' | 'unknown_length';
export interface QuarantineInput { programId: Pubkey; discriminatorHex: string; rawB64: string; signature: Signature | null; poolId: Pubkey | null; kind?: LayoutKind }
export interface UnknownLayout { programId: Pubkey; discriminatorHex: string; poolId: Pubkey | null; kind: LayoutKind; firstSeenAtMs: UnixMs }
/** The `quarantine` row (M24 schema) the writer inserts. */
export interface QuarantineRow { id: string; programId: Pubkey; discriminator: string; rawB64: string; signature: Signature | null; firstSeen: UnixMs; createdAt: UnixMs }

export interface QuarantineDeps {
  clock: Clock;
  /** Inserts one row (the engine runs `repos.quarantine.insert` in `db.withTx`); throws on failure. */
  insert(row: QuarantineRow): void;
  newId(): string;
  /** The programs whose unknown layouts are quarantined (pump and PumpSwap; A-M01-01 `PROGRAMS`). */
  allowlisted: ReadonlySet<Pubkey>;
  log: { event(level: 'info' | 'warn' | 'error' | 'critical', code: string, fields: Readonly<Record<string, unknown>>): void };
  publish(e: UnknownLayout): void;
  metrics?: { recorded(programId: Pubkey): void };
  /** `decoders.reviewed_discriminators`. */
  reviewed?: ReadonlyArray<{ programId: Pubkey; discriminatorHex: string; note: string }>;
}

export interface Quarantine {
  record(e: QuarantineInput): void;
  isReviewed(programId: Pubkey, discriminatorHex: string): boolean;
  /** Retries unwritten rows and logs the counts; the engine calls it every minute. */
  flush(): void;
  setReviewed(list: NonNullable<QuarantineDeps['reviewed']>): void;
}

/** Security notes: a sample is capped at 10 KB of base64. */
export const MAX_SAMPLE_B64 = 10_240;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export const M02_QUARANTINE_LOG_CODES = {
  'm02.quarantined': { fields: { program: 'id', discriminator: 'string', kind: 'string', pool: 'id' } },
  'm02.quarantine_write_failed': { fields: { program: 'id', discriminator: 'string', error_message: 'string' } },
  'm02.quarantine_counts': { fields: { counts: 'json' } },
} as const;

export function createQuarantine(deps: QuarantineDeps): Quarantine {
  let reviewed = deps.reviewed ?? [];
  const seen = new Map<string, { row: QuarantineRow; written: boolean; count: number; pools: Set<string>; kind: LayoutKind }>();

  const write = (key: string): void => {
    const r = seen.get(key);
    if (r === undefined || r.written) return;
    try {
      deps.insert(r.row);
      r.written = true;
    } catch (e) {
      deps.log.event('error', 'm02.quarantine_write_failed', { program: r.row.programId, discriminator: r.row.discriminator, error_message: (e as Error).message });
    }
  };

  return {
    record(e) {
      if (!deps.allowlisted.has(e.programId)) return;
      const key = `${e.programId}:${e.discriminatorHex}`;
      const kind = e.kind ?? 'unknown_discriminator';
      let r = seen.get(key);
      if (r === undefined) {
        const now = deps.clock.nowMs();
        const sample = BASE64.test(e.rawB64) ? e.rawB64.slice(0, MAX_SAMPLE_B64 - (MAX_SAMPLE_B64 % 4)) : '';
        r = { row: { id: deps.newId(), programId: e.programId, discriminator: e.discriminatorHex, rawB64: sample, signature: e.signature, firstSeen: now, createdAt: now }, written: false, count: 0, pools: new Set(), kind };
        seen.set(key, r);
        deps.metrics?.recorded(e.programId);
        deps.log.event('warn', 'm02.quarantined', { program: e.programId, discriminator: e.discriminatorHex, kind, pool: e.poolId });   // alert `config` warning, once
        write(key);
      }
      r.count++;
      const poolKey = e.poolId ?? '';
      if (!r.pools.has(poolKey)) {
        r.pools.add(poolKey);
        deps.publish({ programId: e.programId, discriminatorHex: e.discriminatorHex, poolId: e.poolId, kind: r.kind, firstSeenAtMs: r.row.firstSeen });
      }
    },
    isReviewed: (programId, disc) => reviewed.some((x) => x.programId === programId && x.discriminatorHex === disc),
    flush() {
      for (const key of seen.keys()) write(key);
      if (seen.size > 0) deps.log.event('info', 'm02.quarantine_counts', { counts: Object.fromEntries([...seen].map(([k, v]) => [k, v.count])) });
    },
    setReviewed(list) { reviewed = list; },
  };
}
