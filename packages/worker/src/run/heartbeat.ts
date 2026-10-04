// The signed heartbeat to the watchdog (ops/README.md "Worker contract", packages/ops/src/watchdog/logic.ts). The body
// is the health payload in the watchdog's shape, signed with HMAC-SHA256 over "t\nPOST\n/heartbeat\nbody" so the
// signature is valid for that one route. The reply's `paused` is applied both ways: true stops new entries (never
// exits), false allows them again. The reply's `commands` are the owner's review commands (owner-review.ts). Both count
// only from a signed reply (`replySigned`); an unsigned one can only keep or start a pause.
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Health } from '../../../runner/src/contract.ts';
import type { HttpClient } from '../providers/index.ts';
import { jsonText } from './json.ts';
import { type ackedOf, commandsOf, type reviewBlock } from './owner-review.ts';

/** The watchdog's `open_position` (numbers, plus the mark and the last exit attempt). */
export interface HeartbeatPosition {
  readonly mint: string;
  readonly qty: number;
  readonly entry: number;
  readonly stop: number;
  readonly mark: number | null;
  readonly last_exit_attempt_ts: number | null;
}

/** OWNER-REVIEW: the open stops with their evidence (null before the first valuation) and the commands handled. */
export interface HeartbeatReview {
  readonly review: ReturnType<typeof reviewBlock> | null;
  readonly acked: ReturnType<typeof ackedOf>;
}

export const heartbeatBody = (h: Health, position: HeartbeatPosition | null, ownerChatId: string | null, owner: HeartbeatReview = { review: null, acked: [] }): string => {
  const feedAges: Record<string, number> = {};
  for (const [k, v] of Object.entries(h.feed_ages_ms)) if (v !== null) feedAges[k] = v;
  return jsonText({ ...h, feed_ages_ms: feedAges, open_position: position, owner_chat_id: ownerChatId, review: owner.review, acked: owner.acked });
};

export const signHeartbeat = (key: string, t: number, body: string): string =>
  createHmac('sha256', key).update(`${t}\nPOST\n/heartbeat\n${body}`).digest('hex');

/**
 * The watchdog's reply signature (ops ruling on OWNER-REVIEW): HMAC-SHA256 with the same key over
 * "t\nREPLY\n/heartbeat\n<this heartbeat's v1>\nreply body", so a reply fits only the heartbeat it answers.
 */
export const signReply = (key: string, t: number, requestV1: string, body: string): string =>
  createHmac('sha256', key).update(`${t}\nREPLY\n/heartbeat\n${requestV1}\n${body}`).digest('hex');

export const replySigned = (key: string, header: string | null, requestV1: string, body: string): boolean => {
  const m = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/.exec(header ?? '');
  if (m === null) return false;
  const want = Buffer.from(signReply(key, Number(m[1]), requestV1, body), 'hex');
  return timingSafeEqual(want, Buffer.from(m[2] ?? '', 'hex'));
};

/**
 * `signed` false: the reply had no valid signature. Then `commands` is empty and the caller may only keep or start a
 * pause (fail closed): an unsigned `paused: false` is never applied.
 */
export type BeatResult = { readonly ok: true; readonly paused: boolean; readonly signed: boolean; readonly commands: ReturnType<typeof commandsOf> } | { readonly ok: false; readonly reason: string };

/** Sends one heartbeat. Never throws; the reason of a failure names no URL and no key. */
export const sendHeartbeat = async (http: HttpClient, url: string, key: string, body: string, nowMs: number): Promise<BeatResult> => {
  const t = Math.floor(nowMs / 1000);
  const v1 = signHeartbeat(key, t, body);
  try {
    const res = await http({
      method: 'POST', url: `${url}/heartbeat`, timeoutMs: 10_000, body,
      headers: { 'content-type': 'application/json', 'x-zeroed-signature': `t=${t},v1=${v1}` },
    });
    if (res.status < 200 || res.status >= 300) return { ok: false, reason: `HTTP ${res.status}` };
    const reply = JSON.parse(res.text) as { paused?: unknown; commands?: unknown };
    if (typeof reply.paused !== 'boolean') return { ok: false, reason: 'reply without paused' };
    const signed = replySigned(key, res.header('x-zeroed-signature'), v1, res.text);
    return { ok: true, paused: reply.paused, signed, commands: signed ? commandsOf(reply.commands) : [] };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.name : 'error' };
  }
};
