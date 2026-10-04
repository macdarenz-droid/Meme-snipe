// KEY-ROTATE-SAFE: two slots per watchdog secret, so a key rotation never cuts off the server's heartbeat.
//
// Each rotated secret (the heartbeat HMAC key, the Telegram webhook secret) has the slots `A` and `B`, set by the Deploy
// workflow as `<NAME>_A` and `<NAME>_B`, and the old single secret `<NAME>`, the `legacy` slot. The Durable Object keeps
// which slot is active and the SHA-256 of every value it retired; it never stores a value. Accepted: the active slot's
// value, and a non-legacy other slot's value while it is a new offer (its hash was never retired). The first use of an
// offer (a heartbeat signed with it, a Telegram request carrying it) promotes it: the old value is retired and refused
// from then on. The workflow reads the active slot (GET /slot) and writes only the other one, so a key the server never
// received (a stale or wrong DEPLOY_CODE, a pickup that never came) changes nothing: the active key keeps working.

export type Slot = 'legacy' | 'A' | 'B';
export const SLOTS: readonly Slot[] = ['legacy', 'A', 'B'];

export interface Ring {
  readonly active: Slot;
  /** SHA-256 (hex) of every value retired, newest last (capped). */
  readonly retired: readonly string[];
}
export const NEW_RING: Ring = { active: 'legacy', retired: [] };
const MAX_RETIRED = 32;

export const isRing = (v: unknown): v is Ring =>
  typeof v === 'object' && v !== null && SLOTS.includes((v as Ring).active) && Array.isArray((v as Ring).retired) && (v as Ring).retired.every((h) => typeof h === 'string');

/** The env name of a slot: `NAME` for legacy, `NAME_A`, `NAME_B`. */
export const slotName = (base: string, slot: Slot): string => (slot === 'legacy' ? base : `${base}_${slot}`);

/** The slot the workflow writes next: never the active one. */
export const nextSlot = (active: Slot): Slot => (active === 'A' ? 'B' : 'A');

export const sha256 = async (text: string): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('');

export interface Candidate {
  readonly slot: Slot;
  readonly value: string;
  /** True for the active slot; false for an offer (its use promotes it). */
  readonly active: boolean;
}

/** The values accepted now, the active one first. Empty values never count. */
export const candidates = async (ring: Ring, env: Record<string, unknown>, base: string): Promise<Candidate[]> => {
  const out: Candidate[] = [];
  const value = (s: Slot): string => {
    const v = env[slotName(base, s)];
    return typeof v === 'string' ? v : '';
  };
  const act = value(ring.active);
  if (act !== '' && !ring.retired.includes(await sha256(act))) out.push({ slot: ring.active, value: act, active: true });
  for (const s of ['A', 'B'] as const) {
    if (s === ring.active) continue;
    const v = value(s);
    if (v === '' || v === act) continue;
    if (ring.retired.includes(await sha256(v))) continue;
    out.push({ slot: s, value: v, active: false });
  }
  return out;
};

/** The ring after an offer in `slot` was used: it becomes active and the old active value is retired. */
export const promote = async (ring: Ring, env: Record<string, unknown>, base: string, slot: Slot): Promise<Ring> => {
  if (slot === ring.active) return ring;
  const old = env[slotName(base, ring.active)];
  const retired = typeof old === 'string' && old !== '' ? [...ring.retired, await sha256(old)] : [...ring.retired];
  return { active: slot, retired: retired.slice(-MAX_RETIRED) };
};

/** When the value now on offer in a slot was first seen: reset when the offer changes or goes. */
export interface Offer {
  readonly slot: Slot;
  readonly hash: string;
  readonly since: number;
}

/** An offer left unused this long is an alert: the server did not get the new key. */
export const OFFER_ALERT_MS = 24 * 3_600_000;

/** The offer record after a look at the slots now: kept while the same value is on offer, else new or none. */
export const trackOffer = async (prev: Offer | null, ring: Ring, env: Record<string, unknown>, base: string, now: number): Promise<Offer | null> => {
  const offer = (await candidates(ring, env, base)).find((c) => !c.active);
  if (offer === undefined) return null;
  const hash = await sha256(offer.value);
  return prev !== null && prev.slot === offer.slot && prev.hash === hash ? prev : { slot: offer.slot, hash, since: now };
};
