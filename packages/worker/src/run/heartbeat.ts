// The signed heartbeat to the watchdog (ops/README.md "Worker contract", packages/ops/src/watchdog/logic.ts). The body
// is the health payload in the watchdog's shape, signed with HMAC-SHA256 over "t\nPOST\n/heartbeat\nbody" so the
// signature is valid for that one route. The reply's `paused` is applied both ways: true stops new entries (never
// exits), false allows them again.
import { createHmac } from 'node:crypto';
import type { Health } from '../../../runner/src/contract.ts';
import type { HttpClient } from '../providers/index.ts';
import type { PositionState } from '../../../core/src/lifecycle/index.ts';
import { jsonText } from './json.ts';
import { entryPrice } from './open-positions.ts';

/** One of the watchdog's `open_positions` (numbers, plus the mark and the last exit attempt). */
export interface HeartbeatPosition {
  readonly mint: string;
  readonly qty: number;
  readonly entry: number;
  readonly stop: number;
  readonly mark: number | null;
  readonly last_exit_attempt_ts: number | null;
}

/** What the heartbeat needs per position, besides the book's state. */
export interface HeartbeatSources {
  /** The saved exit plan's stop; null without a saved plan (sent as null, never 0). */
  readonly stop: (id: string) => bigint | null;
  /** A mark fresh enough to show (30 s); null otherwise. */
  readonly mark: (id: string) => bigint | null;
  /** When the latest exit attempt was sent; null when none was. */
  readonly lastExitAt: (id: string) => number | null;
}

/**
 * The watchdog's positions (ALERT-EXIT N3): every one of /health's open positions (oldest first), so the
 * watchdog checks each one's stop. Unknown is null, never 0 (a 0 stop or mark reads as a price to the watchdog). Entry,
 * stop and mark share one unit: an executable price (PRICE_SCALE lamports per token).
 */
export const heartbeatPositions = (h: Pick<Health, 'open_positions'>, book: Readonly<Record<string, PositionState>>, s: HeartbeatSources): HeartbeatPosition[] =>
  h.open_positions.map((o) => {
    const p = book[o.trade]!;
    const stop = s.stop(p.id);
    const mark = s.mark(p.id);
    return {
      mint: p.mint, qty: Number(p.quantity), entry: Number(entryPrice(p)), stop: stop === null ? (null as unknown as number) : Number(stop),
      mark: mark === null ? null : Number(mark), last_exit_attempt_ts: s.lastExitAt(p.id),
    };
  });

/** `positions`: every open position, oldest first (ALERT-EXIT N3); `open_position` is the first, kept for older readers. */
export const heartbeatBody = (h: Health, positions: readonly HeartbeatPosition[], ownerChatId: string | null): string => {
  const feedAges: Record<string, number> = {};
  for (const [k, v] of Object.entries(h.feed_ages_ms)) if (v !== null) feedAges[k] = v;
  return jsonText({ ...h, feed_ages_ms: feedAges, open_position: positions[0] ?? null, open_positions: positions, owner_chat_id: ownerChatId });
};

export const signHeartbeat = (key: string, t: number, body: string): string =>
  createHmac('sha256', key).update(`${t}\nPOST\n/heartbeat\n${body}`).digest('hex');

export type BeatResult = { readonly ok: true; readonly paused: boolean } | { readonly ok: false; readonly reason: string };

/** Sends one heartbeat. Never throws; the reason of a failure names no URL and no key. */
export const sendHeartbeat = async (http: HttpClient, url: string, key: string, body: string, nowMs: number): Promise<BeatResult> => {
  const t = Math.floor(nowMs / 1000);
  try {
    const res = await http({
      method: 'POST', url: `${url}/heartbeat`, timeoutMs: 10_000, body,
      headers: { 'content-type': 'application/json', 'x-zeroed-signature': `t=${t},v1=${signHeartbeat(key, t, body)}` },
    });
    if (res.status < 200 || res.status >= 300) return { ok: false, reason: `HTTP ${res.status}` };
    const reply = JSON.parse(res.text) as { paused?: unknown };
    return typeof reply.paused === 'boolean' ? { ok: true, paused: reply.paused } : { ok: false, reason: 'reply without paused' };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.name : 'error' };
  }
};
