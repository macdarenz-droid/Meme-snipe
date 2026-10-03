// The signed heartbeat to the watchdog (ops/README.md "Worker contract", packages/ops/src/watchdog/logic.ts). The body
// is the health payload in the watchdog's shape, signed with HMAC-SHA256 over "t\nPOST\n/heartbeat\nbody" so the
// signature is valid for that one route. The reply's `paused` is applied both ways: true stops new entries (never
// exits), false allows them again.
import { createHmac } from 'node:crypto';
import type { Health } from '../../../runner/src/contract.ts';
import type { HttpClient } from '../providers/index.ts';
import { jsonText } from './json.ts';

/** The watchdog's `open_position` (numbers, plus the mark and the last exit attempt). */
export interface HeartbeatPosition {
  readonly mint: string;
  readonly qty: number;
  readonly entry: number;
  readonly stop: number;
  readonly mark: number | null;
  readonly last_exit_attempt_ts: number | null;
}

export const heartbeatBody = (h: Health, position: HeartbeatPosition | null, ownerChatId: string | null): string => {
  const feedAges: Record<string, number> = {};
  for (const [k, v] of Object.entries(h.feed_ages_ms)) if (v !== null) feedAges[k] = v;
  return jsonText({ ...h, feed_ages_ms: feedAges, open_position: position, owner_chat_id: ownerChatId });
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
