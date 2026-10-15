// PumpPortal stream client (SPEC-A A-M03-01, card Z08). Built, but not run against PumpPortal (owner, 2026-10-07:
// "PumpPortal is not used for now"; ruling Z08-2): `discovery.pumpportal.enabled` defaults to false, the tests use a
// local fake socket and a SYNTHETIC fixture, and the backfill it calls on reconnect is a port until Z09 wires A-M03-02.
// Adapted from Zeroed's `worker/src/providers/pumpportal.ts` (one socket, the two free subscriptions, a 1 h stop) with
// the Zeroed bug fixed: its back-off ran 5 s → 300 s with no jitter; here 1 s → 60 s with full jitter on a seeded Rng.
//
// VERIFY (doc reads only, ruling Z08-11; read 2026-10-15):
// - https://pumpportal.fun/data-api/real-time: endpoint `wss://pumpportal.fun/api/data?api-key=...`; subscribe messages
//   `{"method":"subscribeNewToken"}` and `{"method":"subscribeMigration"}` (free); `subscribeTokenTrade` and
//   `subscribeAccountTrade` are paid (0.01 SOL per 10,000 events). Whether the two free subscriptions need a key is NOT
//   stated (every example passes one): the key is sent when the secret store has one, never logged. The page shows NO
//   notice message and names no fields. Zeroed's own measurement (docs/research/data.md §3.1, 2026-10-03) lists the
//   fields of a live create event: signature, mint, traderPublicKey, txType, initialBuy, solAmount, bondingCurveKey,
//   vTokensInBondingCurve, vSolInBondingCurve, marketCapSol, name, symbol, uri, is_mayhem_mode, pool; Zeroed's client
//   read `txType === 'create'` for creates. The migration notice's `txType` value (`migrate` here) and its `slot` field
//   are UNVERIFIED: whoever enables the client captures a sample first and replaces the synthetic fixture.
// - https://pumpportal.fun/FAQ: one connection; at most 200 subscription messages a second; at most 5,000 addresses in
//   one message; repeated violations bring temporary bans that "expire every hour". How a ban is signalled is NOT stated
//   (no close code or message), so the spec's fallback holds: 3 refused connections within 60 s (closed by the server
//   before any message arrived) are a suspected ban → no connection for 1 h, backfill polling covers it.
import type { Pubkey, Signature, Slot, UnixMs } from '@bot/types';
import { nextBelow } from '../m10/rng.ts';
import type { Rng } from '@bot/types';

export const PUMPPORTAL_URL = 'wss://pumpportal.fun/api/data';
export const MAX_NOTICE_BYTES = 65_536;
export const RAW_CAP_BYTES = 4_096;
export const DEDUPE_TTL_MS = 86_400_000;
export const DEDUPE_MAX = 200_000;
export const BACKOFF_BASE_MS = 1_000;
export const BAN_PAUSE_MS = 3_600_000;
export const BAN_CLOSES = 3;
export const BAN_WINDOW_MS = 60_000;
export const PAID_METHODS: readonly string[] = ['subscribeTokenTrade', 'subscribeAccountTrade'];

export interface PumpPortalConfig { enabled: boolean; maxSubMsgsPerS: number; backoffMaxMs: number; silenceAlertMs: number; paidMethods: readonly string[] }
export const PUMPPORTAL_DEFAULTS: PumpPortalConfig = { enabled: false, maxSubMsgsPerS: 10, backoffMaxMs: 60_000, silenceAlertMs: 300_000, paidMethods: [] };

/** Config validation (A-M03-01 config table); a paid method listed is an error (cost control). */
export function checkPumpPortalConfig(c: PumpPortalConfig): string | null {
  if (c.paidMethods.length > 0) return 'discovery.pumpportal.paid_methods must be empty (paid subscriptions are never sent)';
  if (!Number.isInteger(c.maxSubMsgsPerS) || c.maxSubMsgsPerS < 1 || c.maxSubMsgsPerS > 200) return 'discovery.pumpportal.max_sub_msgs_per_s must be 1-200 [DA-02]';
  if (!Number.isInteger(c.backoffMaxMs) || c.backoffMaxMs < 5_000 || c.backoffMaxMs > 300_000) return 'discovery.pumpportal.backoff_max_ms must be 5,000-300,000';
  if (!Number.isInteger(c.silenceAlertMs) || c.silenceAlertMs < 60_000 || c.silenceAlertMs > 3_600_000) return 'discovery.pumpportal.silence_alert_ms must be 60,000-3,600,000';
  return null;
}

/** Full jitter: a wait drawn uniformly from [0, min(max, base × 2^attempt)] on the seeded Rng. */
export function backoffMs(rng: Rng, attempt: number, maxMs: number): number {
  const cap = Math.min(maxMs, BACKOFF_BASE_MS * 2 ** Math.min(attempt, 30));
  return nextBelow(rng, cap + 1);
}

export interface PumpPortalNotice {
  kind: 'new_token' | 'migration'; mint: Pubkey; pool: Pubkey | null; signature: Signature | null; slot: Slot | null;
  receivedAtMs: UnixMs; rawB64: string;
}

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SIG58 = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;

/**
 * Parses one message. UNVERIFIED shape (see the header): an object with `mint` and `txType` `create` (new token) or
 * `migrate` (migration), optional `signature`, `pool` and `slot`. Anything else is dropped with a reason.
 */
export function parseNotice(text: string, receivedAtMs: UnixMs, isPubkey: (s: string) => boolean): PumpPortalNotice | { drop: 'oversize' | 'malformed' | 'invalid_notice' | 'not_a_notice' } {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MAX_NOTICE_BYTES) return { drop: 'oversize' };
  let o: unknown;
  try {
    o = JSON.parse(text);
  } catch {
    return { drop: 'malformed' };
  }
  if (typeof o !== 'object' || o === null || Array.isArray(o)) return { drop: 'malformed' };
  const m = o as Record<string, unknown>;
  if (typeof m.message === 'string' && m.mint === undefined) return { drop: 'not_a_notice' };      // e.g. a subscribe reply
  const kind = m.txType === 'create' ? 'new_token' : m.txType === 'migrate' ? 'migration' : null;
  if (kind === null) return { drop: 'invalid_notice' };
  if (typeof m.mint !== 'string' || !BASE58.test(m.mint) || !isPubkey(m.mint)) return { drop: 'invalid_notice' };
  const pool = typeof m.pool === 'string' && BASE58.test(m.pool) && isPubkey(m.pool) ? m.pool : null;
  const signature = typeof m.signature === 'string' && SIG58.test(m.signature) ? m.signature : null;
  const slot = typeof m.slot === 'number' && Number.isSafeInteger(m.slot) && m.slot >= 0 ? BigInt(m.slot) : null;
  const raw = Buffer.from(text, 'utf8');
  return { kind, mint: m.mint, pool, signature, slot: slot as Slot | null, receivedAtMs, rawB64: raw.subarray(0, RAW_CAP_BYTES).toString('base64') };
}

/** `(signature, mint)` dedupe with a 24 h TTL, bounded (oldest first out). */
export class NoticeDedupe {
  private readonly seen = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly max: number;
  constructor(ttlMs = DEDUPE_TTL_MS, max = DEDUPE_MAX) { this.ttlMs = ttlMs; this.max = max; }
  /** True the first time a key is seen within the TTL. */
  first(n: Pick<PumpPortalNotice, 'signature' | 'mint' | 'kind'>, nowMs: number): boolean {
    for (const [k, at] of this.seen) {
      if (at > nowMs - this.ttlMs) break;
      this.seen.delete(k);
    }
    const key = `${n.kind}\u0000${n.signature ?? ''}\u0000${n.mint}`;
    const at = this.seen.get(key);
    if (at !== undefined && at > nowMs - this.ttlMs) return false;
    this.seen.delete(key);
    this.seen.set(key, nowMs);
    while (this.seen.size > this.max) this.seen.delete(this.seen.keys().next().value as string);
    return true;
  }
  size(): number { return this.seen.size; }
}
