// Watchdog logic with no Cloudflare APIs, so it runs and is tested in plain Node. worker.ts wires it to the
// Worker cron, the Durable Object storage and Telegram.

/** What the worker reports every 15–30 s (security.md 5.2). Fields the stub cannot know yet are null. */
export interface Heartbeat {
  seq: number;
  ts: number;
  boot: string;
  git_sha: string;
  policy_version: string;
  stub?: boolean;
  wallet?: string | null;
  last_processed_slot: number | null;
  feed_ages_ms: Record<string, number>;
  open_position: { mint: string; qty: number; entry: number; stop: number; mark: number | null; last_exit_attempt_ts: number | null } | null;
  unresolved_intents: { count: number; oldest_age_s: number | null };
  signer: string;
  lease_epoch: number | null;
  sol_reserve: number | null;
  paused: boolean;
  /** The Telegram chat the server paired with (/pair); the watchdog learns it only from signed heartbeats. */
  owner_chat_id?: string | null;
  /** Critical alerts the worker raised (WATCH-1: a held position with no fresh price), one line each. */
  critical?: string[];
  /** DISK-GUARD: free space where the worker's state lives, and the steps it took as space ran low. */
  disk?: { free_bytes: number | null; total_bytes: number | null; recorder_bytes: number | null; days_to_full: number | null; recorder: string; entries_refused: boolean };
}

export interface Stored {
  hb: Heartbeat;
  receivedAt: number;
}

export interface Limits {
  heartbeatMaxAgeS: number;
  slotLagMax: number;
  intentMaxAgeS: number;
  stopNoExitS: number;
  solReserveFloor: number;
  repeatCriticalS: number;
  /** DISK-GUARD: alert below this many free bytes, or under this many days to full at the worker's measured slope. */
  diskFreeMinBytes: number;
  diskDaysToFullMin: number;
}

export interface ChainView {
  slot: number | null;
  /** Mints the bot wallet holds a non-zero balance of (WSOL excluded); null when not checked. */
  heldMints: string[] | null;
}

export interface Alert {
  key: string;
  text: string;
}

export interface ActiveAlert {
  text: string;
  since: number;
  lastSent: number;
}

export type Lease = { holder: string; epoch: number; expiresAt: number };

const enc = new TextEncoder();

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** The signed message: timestamp, method, path and body, so a signature is valid for one route only. */
export const signedText = (t: number, method: string, path: string, body: string) => `${t}\n${method.toUpperCase()}\n${path}\n${body}`;

export async function sign(key: string, t: number, method: string, path: string, body: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', k, enc.encode(signedText(t, method, path, body))));
}

/**
 * Checks `x-zeroed-signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "t\nMETHOD\npath\nbody">`. Refuses a
 * missing key, a malformed header and a timestamp more than `maxSkewS` from now. Returns the timestamp when
 * valid (callers use it to refuse replays), otherwise null.
 */
export async function verifySignature(header: string | null, method: string, path: string, body: string, key: string, nowS: number, maxSkewS = 300): Promise<number | null> {
  if (!key || !header) return null;
  const m = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/.exec(header);
  if (!m) return null;
  const t = Number(m[1]);
  if (Math.abs(nowS - t) > maxSkewS) return null;
  return sameText(await sign(key, t, method, path, body), m[2] ?? '') ? t : null;
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Shape check for a signed heartbeat. Signed by the host, but still never trusted blindly. */
export function parseHeartbeat(body: string): Heartbeat | null {
  let x: unknown;
  try {
    x = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof x !== 'object' || x === null) return null;
  const h = x as Record<string, unknown>;
  if (!num(h['seq']) || !num(h['ts']) || typeof h['boot'] !== 'string' || typeof h['git_sha'] !== 'string') return null;
  if (typeof h['signer'] !== 'string' || typeof h['paused'] !== 'boolean') return null;
  const ui = h['unresolved_intents'] as Record<string, unknown> | undefined;
  if (typeof ui !== 'object' || ui === null || !num(ui['count'])) return null;
  return x as Heartbeat;
}

/** A heartbeat is new if it is later than the last one, and from a new boot or with a higher sequence number. */
export function isNewer(prev: Stored | undefined, hb: Heartbeat): boolean {
  if (!prev) return true;
  if (hb.ts <= prev.hb.ts) return false;
  return prev.hb.boot !== hb.boot || hb.seq > prev.hb.seq;
}

export function limitsFrom(env: Record<string, unknown>): Limits {
  const n = (k: string, d: number) => {
    const v = Number(env[k]);
    return Number.isFinite(v) && v > 0 ? v : d;
  };
  return {
    heartbeatMaxAgeS: n('HEARTBEAT_MAX_AGE_S', 90),
    slotLagMax: n('SLOT_LAG_MAX', 150),
    intentMaxAgeS: n('INTENT_MAX_AGE_S', 90),
    stopNoExitS: n('STOP_NO_EXIT_S', 60),
    solReserveFloor: n('SOL_RESERVE_FLOOR', 0.02),
    repeatCriticalS: n('REPEAT_CRITICAL_S', 300),
    // 3 GiB: the warning comes while a worst-case recorder day (about 1 GiB) still fits above the worker's own
    // recorder pause at 1.5 GiB, so the owner hears of it before any data is lost.
    diskFreeMinBytes: n('DISK_FREE_MIN_BYTES', 3 * 1024 ** 3),
    diskDaysToFullMin: n('DISK_DAYS_TO_FULL_MIN', 3),
  };
}

/** The independent checks (security.md 5.2). Nothing is checked before the first heartbeat ever arrives. */
export function evaluate(s: Stored | undefined, now: number, l: Limits, chain: ChainView): Alert[] {
  if (!s) return [];
  const out: Alert[] = [];
  const { hb } = s;
  const age = Math.round((now - s.receivedAt) / 1000);
  if (age > l.heartbeatMaxAgeS) out.push({ key: 'heartbeat', text: `No heartbeat for ${age} s (limit ${l.heartbeatMaxAgeS} s).` });
  if (num(chain.slot) && num(hb.last_processed_slot)) {
    const lag = chain.slot - hb.last_processed_slot;
    if (lag > l.slotLagMax) out.push({ key: 'slot_lag', text: `Worker is ${lag} slots behind the chain (limit ${l.slotLagMax}).` });
  }
  if (chain.heldMints) {
    const reported = hb.open_position?.mint ?? null;
    const held = chain.heldMints;
    if (reported && !held.includes(reported)) out.push({ key: 'position', text: `Worker reports an open position in ${reported}, but the wallet holds none on chain.` });
    const extra = held.filter((m) => m !== reported);
    if (extra.length) out.push({ key: 'position_unreported', text: `Wallet holds ${extra.join(', ')} on chain, but the worker reports ${reported ? 'only ' + reported : 'no position'}.` });
  }
  const p = hb.open_position;
  if (p && num(p.mark) && p.mark < p.stop) {
    const since = num(p.last_exit_attempt_ts) ? Math.round((now - p.last_exit_attempt_ts) / 1000) : null;
    if (since === null || since > l.stopNoExitS) out.push({ key: 'stop', text: `${p.mint} is below its stop with no exit attempt in the last ${l.stopNoExitS} s.` });
  }
  const oldest = hb.unresolved_intents.oldest_age_s;
  if (hb.unresolved_intents.count > 0 && num(oldest) && oldest > l.intentMaxAgeS) {
    out.push({ key: 'intent', text: `${hb.unresolved_intents.count} unresolved intent(s), oldest ${oldest} s (blockhash expiry ${l.intentMaxAgeS} s).` });
  }
  if (num(hb.sol_reserve) && hb.sol_reserve < l.solReserveFloor) out.push({ key: 'reserve', text: `SOL reserve ${hb.sol_reserve} is below the floor ${l.solReserveFloor}.` });
  if (hb.signer === 'unreachable' || hb.signer === 'timeout') out.push({ key: 'signer', text: `Worker cannot reach the signer (${hb.signer}).` });
  const critical = Array.isArray(hb.critical) ? hb.critical.filter((c): c is string => typeof c === 'string' && c !== '') : [];
  if (critical.length > 0) out.push({ key: 'worker_critical', text: `Worker critical: ${critical.join('; ')}.` });
  const d = hb.disk;
  if (typeof d === 'object' && d !== null) {
    const gib = (b: number) => `${(b / 1024 ** 3).toFixed(1)} GiB`;
    const low = num(d.free_bytes) && d.free_bytes < l.diskFreeMinBytes;
    const soon = num(d.days_to_full) && d.days_to_full < l.diskDaysToFullMin;
    if (low || soon) {
      const free = num(d.free_bytes) ? `${gib(d.free_bytes)} free${num(d.total_bytes) ? ` of ${gib(d.total_bytes)}` : ''}` : 'free space unknown';
      const days = num(d.days_to_full) ? `, full in about ${d.days_to_full} days at the current rate` : '';
      out.push({ key: 'disk_low', text: `Server disk: ${free}${days} (alert below ${gib(l.diskFreeMinBytes)} or ${l.diskDaysToFullMin} days).` });
    }
    if (d.recorder === 'paused') out.push({ key: 'disk_recorder', text: 'Server disk: the market recorder is paused for lack of space; this gap is missing from the recorded data.' });
    if (d.entries_refused === true) out.push({ key: 'disk_entries', text: `Server disk: new entries are refused (${num(d.free_bytes) ? `${gib(d.free_bytes)} free` : 'free space unknown'}); open positions still exit.` });
  }
  return out;
}

/** OPS-SUMMARY: a summary that was refused or not written. Trading and the other checks are unaffected. */
export const summaryAlert = (reason: string): Alert => ({ key: 'summary', text: `Daily summary not written: ${reason}.` });

/**
 * Dedupe and escalate: a new alert is sent at once, repeated every `repeatCriticalS` during its first hour
 * and hourly after that while it lasts, and a "cleared" line is always sent when it goes away. All lines of
 * one run go out as one message (Telegram allows about one message per second per chat).
 */
export function planAlerts(active: Record<string, ActiveAlert>, current: Alert[], now: number, l: Limits): { lines: string[]; next: Record<string, ActiveAlert> } {
  const next: Record<string, ActiveAlert> = {};
  const lines: string[] = [];
  for (const a of current) {
    const prev = active[a.key];
    if (!prev) {
      lines.push(`ALERT ${a.text}`);
      next[a.key] = { text: a.text, since: now, lastSent: now };
      continue;
    }
    const every = now - prev.since < 3_600_000 ? l.repeatCriticalS * 1000 : 3_600_000;
    if (now - prev.lastSent >= every) {
      lines.push(`STILL ${a.text} (since ${Math.round((now - prev.since) / 60000)} min)`);
      next[a.key] = { text: a.text, since: prev.since, lastSent: now };
    } else {
      next[a.key] = { ...prev, text: a.text };
    }
  }
  for (const [key, prev] of Object.entries(active)) {
    if (!next[key]) lines.push(`CLEARED ${prev.text}`);
  }
  return { lines, next };
}

/** Telegram: only /pause and /status, only from the owner's chat. Anything else is ignored. */
export function parseCommand(update: unknown, ownerChatId: string): 'pause' | 'status' | 'other' | null {
  if (!ownerChatId) return null;
  const msg = (update as { message?: { chat?: { id?: unknown }; text?: unknown } } | null)?.message;
  if (!msg || String(msg.chat?.id ?? '') !== ownerChatId || typeof msg.text !== 'string') return null;
  const cmd = msg.text.trim().split(/\s+/)[0]?.replace(/@\w+$/, '').toLowerCase();
  if (cmd === '/pause') return 'pause';
  if (cmd === '/status') return 'status';
  return 'other';
}

export function statusText(s: Stored | undefined, now: number, paused: { at: number } | null, active: Record<string, ActiveAlert>, lease: Lease | null): string {
  const lines: string[] = [];
  if (!s) {
    lines.push('Heartbeat: none received yet.');
  } else {
    const { hb } = s;
    lines.push(`Heartbeat: ${Math.round((now - s.receivedAt) / 1000)} s ago (seq ${hb.seq}).`);
    lines.push(`Release: ${hb.git_sha.slice(0, 12)}, policy ${hb.policy_version}${hb.stub ? ' (stub worker)' : ''}.`);
    lines.push(`Position: ${hb.open_position ? `${hb.open_position.mint}, stop ${hb.open_position.stop}` : 'none'}.`);
    lines.push(`Unresolved intents: ${hb.unresolved_intents.count}.`);
    lines.push(`Signer: ${hb.signer}.`);
    lines.push(`SOL reserve: ${hb.sol_reserve ?? 'unknown'}.`);
  }
  lines.push(`Entries: ${paused ? `paused since ${new Date(paused.at).toISOString().slice(0, 16)} UTC` : 'allowed'}.`);
  if (lease) lines.push(`Lease: ${lease.holder}, epoch ${lease.epoch}, ${lease.expiresAt > now ? 'valid' : 'expired'}.`);
  const alerts = Object.values(active);
  lines.push(alerts.length ? `Alerts: ${alerts.map((a) => a.text).join(' ')}` : 'Alerts: none.');
  return lines.join('\n');
}

/**
 * Lease with a fencing epoch. A holder renews its own lease; another holder gets it only after it expired,
 * and the epoch then goes up, so a stale primary's writes can be refused downstream.
 */
export function takeLease(cur: Lease | null, holder: string, ttlS: number, now: number): { granted: boolean; lease: Lease | null } {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(holder) || !(ttlS >= 5 && ttlS <= 600)) return { granted: false, lease: cur };
  if (cur && cur.holder !== holder && cur.expiresAt > now) return { granted: false, lease: cur };
  const epoch = cur ? (cur.holder === holder && cur.expiresAt > now ? cur.epoch : cur.epoch + 1) : 1;
  const lease = { holder, epoch, expiresAt: now + ttlS * 1000 };
  return { granted: true, lease };
}
