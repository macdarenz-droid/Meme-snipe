// The PumpPortal socket state machine (SPEC-A A-M03-01 logic 2-8, card Z08). Exactly one socket, never one per token
// [DA-02]; the two free subscriptions only; reconnect after a wait of 1 s → 60 s with full jitter (seeded Rng), and one
// `backfillSince(lastSeenSlot)` call per reconnect; 3 refused connections within 60 s → no connection for 1 h
// (suspected ban, warning). Notices are early warnings at `processed` (D14): recorded (M07 `pumpportal_notice`) and
// published (`discovery.pumpportal_notice`), influencing nothing until A-M03-02 verifies them on chain.
// Off by default (ruling Z08-2): with `enabled` false, `start()` opens nothing. The socket is a port; the production
// adapter (`webSocketConnect`) uses Node's global WebSocket and is wired by Z10 only if the owner turns PumpPortal on.
import type { Slot, SourceHealth, UnixMs } from '@bot/types';
import type { Rng } from '@bot/types';
import type { LogPort, MetricsPort, Scheduler } from '../m14/types.ts';
import { redactUrl } from '../m14/services.ts';
import {
  BAN_CLOSES, BAN_PAUSE_MS, BAN_WINDOW_MS, backoffMs, checkPumpPortalConfig, NoticeDedupe, parseNotice, PUMPPORTAL_URL,
  type PumpPortalConfig, type PumpPortalNotice,
} from './pumpportal.ts';

export const NOTICE_TOPIC = 'discovery.pumpportal_notice';
const HOUR_MS = 3_600_000;

export interface SocketHandlers { onOpen(): void; onMessage(text: string): void; onClose(code: number): void }
export interface SocketPort { send(text: string): void; close(): void }
export type Connect = (url: string, h: SocketHandlers) => SocketPort;

export interface PumpPortalDeps {
  config: PumpPortalConfig;
  connect: Connect;
  /** From M14's secret store (null when none is configured); never logged. */
  apiKey: string | null;
  /** Monotonic timers. */
  scheduler: Scheduler;
  /** Wall clock (receipt times). */
  nowMs: () => UnixMs;
  rng: Rng;
  /** A-M03-02 (card Z09); a port until then. */
  backfill: { backfillSince(fromSlot: Slot | null): Promise<unknown>; migrationsSeenSince(ms: UnixMs): number };
  publish: (n: PumpPortalNotice) => void;
  record: (n: PumpPortalNotice) => void;
  isPubkey: (s: string) => boolean;
  /** M15: the highest slot seen and the measured slot time, for the lag metric (null: no lag). */
  slots?: { highestSeenSlot(): Slot | null; slotMs(): number };
  log: LogPort;
  metrics: MetricsPort;
}

export interface PumpPortalClient {
  start(): void;
  stop(): void;
  health(): SourceHealth;
  /** Sockets open now (0 or 1). */
  sockets(): number;
}

export function createPumpPortalClient(deps: PumpPortalDeps): PumpPortalClient {
  const problem = checkPumpPortalConfig(deps.config);
  if (problem !== null) throw new RangeError(problem);
  const cfg = deps.config;
  const url = deps.apiKey === null || deps.apiKey === '' ? PUMPPORTAL_URL : `${PUMPPORTAL_URL}?api-key=${encodeURIComponent(deps.apiKey)}`;
  const dedupe = new NoticeDedupe();
  let socket: SocketPort | null = null;
  let open = 0;
  let timer: (() => void) | null = null;
  let stopped = true;
  let attempt = 0;
  let connectedOnce = false;
  let openedAt = 0;
  let messagesThisConn = 0;
  let lastSeenSlot: Slot | null = null;
  let lastEventAtMs: UnixMs | null = null;
  let lagMs: number | null = null;
  let bannedUntil = Number.NEGATIVE_INFINITY;
  let refused: number[] = [];
  let reconnects: number[] = [];
  const mono = (): number => deps.scheduler.nowMs();

  const schedule = (ms: number): void => {
    timer?.();
    timer = deps.scheduler.set(() => { timer = null; connect(); }, ms);
  };

  const connect = (): void => {
    if (stopped || socket !== null) return;                              // one socket, ever
    const reconnect = connectedOnce;
    connectedOnce = true;
    messagesThisConn = 0;
    openedAt = mono();
    let mine: SocketPort | null = null;
    const handlers: SocketHandlers = {
      onOpen: () => {
        const s = socket;
        if (s === null || s !== mine) return;
        deps.log.event('info', 'm03.pp_connected', { reconnect });
        // Subscription messages, at most `maxSubMsgsPerS` a second (two messages: the second waits its turn).
        const gap = Math.ceil(1_000 / cfg.maxSubMsgsPerS);
        s.send(JSON.stringify({ method: 'subscribeNewToken' }));
        deps.scheduler.set(() => { if (socket === s) s.send(JSON.stringify({ method: 'subscribeMigration' })); }, gap);
        if (reconnect) {
          reconnects.push(mono());
          deps.metrics.counter('stream_reconnects_total', { source: 'pumpportal' }).inc();
          void deps.backfill.backfillSince(lastSeenSlot).catch(() => undefined);
        }
      },
      onMessage: (text: string) => {
        if (socket !== mine) return;
        messagesThisConn += 1;
        const now = deps.nowMs();
        const n = parseNotice(text, now, deps.isPubkey);
        if ('drop' in n) {
          if (n.drop !== 'not_a_notice') deps.metrics.counter('pumpportal_dropped_total', { reason: n.drop }).inc();
          return;
        }
        lastEventAtMs = now;
        if (n.slot !== null) {
          if (lastSeenSlot === null || n.slot > lastSeenSlot) lastSeenSlot = n.slot;
          const high = deps.slots?.highestSeenSlot() ?? null;
          if (high !== null && deps.slots !== undefined) {
            const gap: bigint = high > n.slot ? high - n.slot : 0n;           // a slot count, capped before it becomes a number
            lagMs = (gap > 1_000_000n ? 1_000_000 : Number(gap)) * deps.slots.slotMs();
            deps.metrics.gauge('stream_lag_ms', { source: 'pumpportal' }).set(lagMs);
          }
        }
        if (!dedupe.first(n, mono())) return;
        deps.metrics.counter('pumpportal_notices_total', { kind: n.kind }).inc();
        deps.record(n);
        deps.publish(n);
      },
      onClose: (code: number) => {
        if (socket !== mine) return;
        socket = null;
        open -= 1;
        deps.log.event('warn', 'm03.pp_disconnected', { code });
        if (stopped) return;
        const now = mono();
        if (now - openedAt >= cfg.backoffMaxMs) attempt = 0;               // a connection that held resets the back-off
        if (messagesThisConn === 0) refused = [...refused.filter((t) => t > now - BAN_WINDOW_MS), now];
        if (refused.length >= BAN_CLOSES) {
          refused = [];
          bannedUntil = now + BAN_PAUSE_MS;
          deps.log.event('warn', 'm03.pp_ban_suspected', { pause_ms: BAN_PAUSE_MS });
          schedule(BAN_PAUSE_MS);
          return;
        }
        schedule(backoffMs(deps.rng, attempt, cfg.backoffMaxMs));
        attempt += 1;
      },
    };
    try {
      mine = deps.connect(url, handlers);
    } catch {
      deps.log.event('warn', 'm03.pp_disconnected', { code: -1 });
      schedule(backoffMs(deps.rng, attempt++, cfg.backoffMaxMs));
      return;
    }
    socket = mine;
    open += 1;
  };

  return {
    start(): void {
      if (!cfg.enabled) {
        deps.log.event('info', 'm03.pp_disabled', {});
        return;
      }
      if (!stopped) return;
      stopped = false;
      deps.log.event('info', 'm03.pp_starting', { endpoint: redactUrl(url) });
      connect();
    },
    stop(): void {
      stopped = true;
      timer?.();
      timer = null;
      const s = socket;
      socket = null;
      if (s !== null) { open -= 1; s.close(); }
    },
    health(): SourceHealth {
      const now = mono();
      reconnects = reconnects.filter((t) => t > now - HOUR_MS);
      const wall = deps.nowMs();
      const silent = lastEventAtMs === null || wall - lastEventAtMs >= cfg.silenceAlertMs;
      const down = !cfg.enabled || stopped || now < bannedUntil || (silent && deps.backfill.migrationsSeenSince((wall - cfg.silenceAlertMs) as UnixMs) > 0);
      return {
        streamId: 'pumpportal', label: 'PumpPortal', lagMs, lastEventAtMs, reconnects1h: reconnects.length,
        status: down ? 'down' : socket === null ? 'degraded' : 'ok',
      };
    },
    sockets: () => open,
  };
}

/** The production socket: Node's global WebSocket (Node 22). Wired by Z10 only if the owner turns PumpPortal on. */
export function webSocketConnect(url: string, h: SocketHandlers): SocketPort {
  const Ws = (globalThis as unknown as { WebSocket?: new (u: string) => WebSocketLike }).WebSocket;
  if (Ws === undefined) throw new Error('no WebSocket in this runtime');
  const ws = new Ws(url);
  ws.onopen = () => h.onOpen();
  ws.onmessage = (e) => { if (typeof e.data === 'string') h.onMessage(e.data); };
  ws.onclose = (e) => h.onClose(e.code);
  return { send: (t) => ws.send(t), close: () => ws.close() };
}
interface WebSocketLike {
  onopen: (() => void) | null; onmessage: ((e: { data: unknown }) => void) | null; onclose: ((e: { code: number }) => void) | null;
  send(t: string): void; close(): void;
}
