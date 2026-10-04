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
  /** OWNER-REVIEW: the stops the owner can clear, by kind, with their trip ids and evidence (read with reviewOf). */
  review?: unknown;
  /** OWNER-REVIEW: owner commands the worker handled, with their results (read with ackedOf). */
  acked?: unknown;
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

/**
 * OWNER-REVIEW (ops ruling): the heartbeat reply is signed too, with the key that verified the heartbeat, over
 * "t\nREPLY\npath\n<the request's v1>\nbody". Binding the request's signature means an old reply never fits a new
 * heartbeat. The worker applies an unsigned or badly signed reply only to keep or start a pause (never an un-pause, never
 * a command).
 */
export const replyText = (t: number, path: string, requestV1: string, body: string) => `${t}\nREPLY\n${path}\n${requestV1}\n${body}`;

export async function signReply(key: string, t: number, path: string, requestV1: string, body: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', k, enc.encode(replyText(t, path, requestV1, body))));
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

export type OwnerKind = 'review' | 'rearm' | 'weekly' | 'override';
export const OWNER_KINDS: readonly OwnerKind[] = ['review', 'rearm', 'weekly', 'override'];
const isOwnerKind = (k: unknown): k is OwnerKind => typeof k === 'string' && (OWNER_KINDS as readonly string[]).includes(k);

/** The owner's message text, only from the owner's chat; null for anything else. */
const ownerText = (update: unknown, ownerChatId: string): string | null => {
  if (!ownerChatId) return null;
  const msg = (update as { message?: { chat?: { id?: unknown }; text?: unknown } } | null)?.message;
  if (!msg || String(msg.chat?.id ?? '') !== ownerChatId || typeof msg.text !== 'string') return null;
  return msg.text;
};

/** Telegram: /pause, /status and the review commands (/review, /rearm, /weekly), only from the owner's chat. Anything else is ignored. */
export function parseCommand(update: unknown, ownerChatId: string): 'pause' | 'status' | OwnerKind | 'other' | null {
  const text = ownerText(update, ownerChatId);
  if (text === null) return null;
  const cmd = text.trim().split(/\s+/)[0]?.replace(/@\w+$/, '').toLowerCase();
  if (cmd === '/pause') return 'pause';
  if (cmd === '/status') return 'status';
  const kind = cmd?.slice(1);
  if (cmd?.startsWith('/') && isOwnerKind(kind)) return kind;
  return 'other';
}

/** OWNER-REVIEW: the trip named by "/<command> confirm <trip>", else null (the command only shows the evidence). */
export function confirmedTrip(update: unknown, ownerChatId: string): string | null {
  const words = (ownerText(update, ownerChatId) ?? '').trim().split(/\s+/);
  return words.length === 3 && words[1]?.toLowerCase() === 'confirm' && TRIP.test(words[2] ?? '') ? (words[2] as string) : null;
}

// ---------- OWNER-REVIEW ----------

const TRIP = /^((review|rearm|weekly)-\d{1,16}|override-\d{1,16}-\d{1,4})$/;
const EVIDENCE_KEY = /^[a-z_]{1,24}$/;

/** A stop the worker reported, with its evidence (counts, moments in ms, lamports as decimal strings). */
export interface ReportedStop {
  trip: string;
  evidence: Record<string, string | number | null>;
}
export type Review = Record<OwnerKind, ReportedStop | null>;

/** A confirmed command waiting for the worker; its id is its trip, so a second confirm of the same trip is the same command. */
export interface PendingCommand {
  id: string;
  kind: OwnerKind;
  trip: string;
  /** When the owner confirmed it: the worker refuses it after COMMAND_TTL_MS (`expired`). */
  at: number;
  /** Sent in a heartbeat reply at least once: from then on only the worker's acknowledgement settles it. */
  sent?: boolean;
}

/** A confirm counts for 15 minutes: a /rearm never applies days later on evidence the owner saw long before. */
export const COMMAND_TTL_MS = 15 * 60_000;

export type AckResult = 'applied' | 'stale' | 'invalid' | 'expired';

/** The heartbeat's review block, checked field by field (signed, but never trusted blindly). Anything malformed reads as none. */
export function reviewOf(hb: Heartbeat | undefined): Review {
  const out: Review = { review: null, rearm: null, weekly: null, override: null };
  const r = hb?.review;
  if (typeof r !== 'object' || r === null) return out;
  for (const kind of OWNER_KINDS) {
    const v = (r as Record<string, unknown>)[kind];
    if (typeof v !== 'object' || v === null) continue;
    const { trip, evidence } = v as Record<string, unknown>;
    if (typeof trip !== 'string' || !TRIP.test(trip) || !trip.startsWith(`${kind}-`) || typeof evidence !== 'object' || evidence === null) continue;
    const ev: Record<string, string | number | null> = {};
    for (const [k, x] of Object.entries(evidence).slice(0, 8)) {
      if (!EVIDENCE_KEY.test(k)) continue;
      if (x === null || (typeof x === 'number' && Number.isFinite(x)) || (typeof x === 'string' && /^-?\d{1,20}$/.test(x))) ev[k] = x;
    }
    out[kind] = { trip, evidence: ev };
  }
  return out;
}

/** The heartbeat's acknowledgements: well-formed `{id, result}` entries only. */
export function ackedOf(hb: Heartbeat): { id: string; result: AckResult }[] {
  if (!Array.isArray(hb.acked)) return [];
  return hb.acked.filter((a): a is { id: string; result: AckResult } =>
    typeof a === 'object' && a !== null && typeof (a as { id?: unknown }).id === 'string' && ['applied', 'stale', 'invalid', 'expired'].includes((a as { result?: unknown }).result as string));
}

/** Lamports (a decimal string) as SOL, exact: up to 9 decimals, trailing zeros dropped. */
export function solText(lamports: string | number | null | undefined): string {
  if (typeof lamports !== 'string' || !/^-?\d+$/.test(lamports)) return 'unknown';
  const neg = lamports.startsWith('-');
  const digits = (neg ? lamports.slice(1) : lamports).padStart(10, '0');
  const whole = digits.slice(0, -9).replace(/^0+(?=\d)/, '');
  const frac = digits.slice(-9).replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''} SOL`;
}

/** A moment in Melbourne time, to the minute. */
export function melbourneText(ms: string | number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return 'unknown';
  return `${new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Melbourne', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms))} Melbourne`;
}

const NAMES: Record<OwnerKind, string> = { review: 'Loss review (R8)', rearm: 'Kill switch (R10)', weekly: 'Weekly loss (R9)', override: 'Day stop (R7, R8 streak)' };

/** What /review, /rearm or /weekly answers: the stop's evidence in SOL and the exact confirm line, or that none is open. */
export function stopText(kind: OwnerKind, stop: ReportedStop | null): string {
  if (stop === null) return `${NAMES[kind]}: not tripped.`;
  const e = stop.evidence;
  const confirm = `/${kind} confirm ${stop.trip}`;
  if (kind === 'review') {
    return [
      `${NAMES.review}: ${e['losses'] ?? '?'} losses in ${e['trades'] ?? '?'} trades, closed ${melbourneText(e['from_ms'])} to ${melbourneText(e['to_ms'])}.`,
      `Net of those trades: ${solText(e['net_lamports'])}.`,
      `To clear it, send: ${confirm}`,
    ].join('\n');
  }
  if (kind === 'rearm') {
    return [
      `${NAMES.rearm}: tripped ${melbourneText(e['tripped_ms'])}.`,
      `Equity ${solText(e['equity_lamports'])}, NAV ${solText(e['nav_lamports'])}, NAV peak ${solText(e['nav_peak_lamports'])}.`,
      `Re-arming also restarts the peak. To re-arm, send: ${confirm}`,
    ].join('\n');
  }
  if (kind === 'override') {
    const stops = [e['daily'] === 1 ? 'daily loss' : null, typeof e['streak'] === 'number' && e['streak'] > 0 ? `${e['streak']} losses in a row` : null].filter((x) => x !== null);
    return [
      `${NAMES.override}: ${stops.join(' and ') || 'tripped'}. Day loss ${solText(e['day_loss_lamports'])} (daily limit ${solText(e['day_limit_lamports'])}). Overrides today: ${e['overrides'] ?? '?'}.`,
      `Overriding resumes entries until midnight (${melbourneText(e['day_ends_ms'])}). Another full daily limit of loss, or a new losing streak, stops them again. The weekly loss, the kill switch and the loss review still apply.`,
      `To override, send: ${confirm}`,
    ].join('\n');
  }
  return [
    `${NAMES.weekly}: tripped ${melbourneText(e['tripped_ms'])}. Equity ${solText(e['equity_lamports'])}.`,
    `Entries stay paused until the week ends (${melbourneText(e['week_ends_ms'])}) and you have reviewed it.`,
    `To record your review, send: ${confirm}`,
  ].join('\n');
}

/**
 * A confirm: queued only when the trip is the one the worker reports open now for that command. Pending holds at most
 * one command per kind (a new confirm replaces the old one).
 */
export function queueConfirm(pending: readonly PendingCommand[], review: Review, kind: OwnerKind, trip: string, now: number): { queued: boolean; pending: PendingCommand[] } {
  if (review[kind]?.trip !== trip) return { queued: false, pending: [...pending] };
  return { queued: true, pending: [...pending.filter((p) => p.kind !== kind), { id: trip, kind, trip, at: now }] };
}

/** Pending commands after a heartbeat's acknowledgements, and one line per command acknowledged. */
export function settleAcks(pending: readonly PendingCommand[], acked: readonly { id: string; result: AckResult }[]): { pending: PendingCommand[]; lines: string[] } {
  const lines: string[] = [];
  const left: PendingCommand[] = [];
  for (const p of pending) {
    const a = acked.find((x) => x.id === p.id);
    if (a === undefined) {
      left.push(p);
      continue;
    }
    lines.push(
      a.result === 'applied' ? `Applied: /${p.kind} for ${p.trip}.`
        : a.result === 'stale' ? `Refused: /${p.kind} for ${p.trip} is no longer the current trip.`
          : a.result === 'expired' ? `Expired: /${p.kind} for ${p.trip} reached the worker more than 15 minutes after the confirm. Send it again.`
            : `Refused: /${p.kind} for ${p.trip} was not understood.`,
    );
  }
  return { pending: left, lines };
}

/**
 * Confirms never sent to the worker within COMMAND_TTL_MS are dropped, one line each. A command already sent waits for
 * the worker's answer (it refuses one past the TTL itself), so the owner is never told "expired" about one it applied.
 */
export function expireUnsent(pending: readonly PendingCommand[], now: number): { pending: PendingCommand[]; lines: string[] } {
  const lines: string[] = [];
  const left = pending.filter((p) => {
    if (p.sent === true || now - p.at <= COMMAND_TTL_MS) return true;
    lines.push(`Expired: /${p.kind} for ${p.trip} was not delivered within 15 minutes. Send it again.`);
    return false;
  });
  return { pending: left, lines };
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
