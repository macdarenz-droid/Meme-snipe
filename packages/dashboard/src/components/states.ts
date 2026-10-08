// Universal states (UI-T05): StateView (C32), Skeleton (C33), DeferredLoading, FreshnessIndicator (C29) and
// ConnectionStatus (C30), per docs/UI.md "Universal states" and "Data freshness model".
// - Loading shows after 200 ms and stays at least 400 ms (no flash for fast answers); nothing, never zeros, before it.
// - Error keeps the last good data at full contrast, marked "as of", with Retry and Copy diagnostics (no secrets).
// - Freshness and connection re-evaluate every second; screen readers hear a state change once (a polite status whose
//   text changes only with the state), never the ticking age. The disconnected banner is an alert once: its changing
//   details sit outside the alert.
import { createElement as h, useEffect, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { CircleCheck, Inbox, LockKeyhole, OctagonAlert, RefreshCw, SearchX } from 'lucide-react';
import type { Clock } from '@bot/types';
import { monotonicClock, type ElapsedClock } from '../lib/clock.ts';
import { diagnosticsText, type DiagnosticInput } from '../lib/diagnostics.ts';
import { SKEW_EPISODE_END_MS, freshness, type Freshness, type FreshnessInput, type FreshnessState } from '../lib/freshness.ts';
import { LOADING_DELAY_MS, LOADING_MIN_MS } from '../lib/loading.ts';
import { formatAgeMs, formatTime } from '../lib/money.ts';
import { Button } from './button.ts';
import { cx } from './cx.ts';
import { Icon, STATE_ICONS } from './icon.ts';
import { Badge } from './status.ts';

/**
 * The clock's time, refreshed every `intervalMs` (1 s: the DS re-evaluation interval) and read afresh in the render
 * where `refreshKey` changes, so new data is measured against the time it arrived, not the last tick (up to 1 s old).
 */
export function useNow(clock: Clock, intervalMs = 1000, refreshKey?: string): number {
  const [reading, setReading] = useState(() => ({ now: clock.nowMs(), key: refreshKey }));
  useEffect(() => {
    const timer = setInterval(() => setReading((r) => ({ now: clock.nowMs(), key: r.key })), intervalMs);
    return () => clearInterval(timer);
  }, [clock, intervalMs]);
  if (reading.key !== refreshKey) {
    // React's "adjust state while rendering": the render restarts with the fresh reading before it commits.
    const fresh = { now: clock.nowMs(), key: refreshKey };
    setReading(fresh);
    return fresh.now;
  }
  return reading.now;
}

/**
 * Calls `fn` once `ms` have passed since `fromMs` on `clock`. A timer that fires before that on the clock (timers and
 * clocks round differently) waits for the rest. Returns the cancel.
 */
function whenElapsed(clock: ElapsedClock, fromMs: number, ms: number, fn: () => void): () => void {
  let timer: ReturnType<typeof setTimeout>;
  const check = (): void => {
    const left = ms - (clock.nowMs() - fromMs);
    if (left > 0) timer = setTimeout(check, left);
    else fn();
  };
  timer = setTimeout(check, Math.max(0, ms - (clock.nowMs() - fromMs)));
  return () => clearTimeout(timer);
}

/**
 * True while a loading indicator should show: from 200 ms after `active` turns on until at least 400 ms after the
 * indicator reached the DOM. Both durations are measured on `clock` (monotonic by default), and the 400 ms count from
 * the commit that shows the indicator, not from the timer that asked for it, so a slow render cannot shorten them.
 */
export function useDelayedFlag(active: boolean, clock: ElapsedClock = monotonicClock): boolean {
  const [shown, setShown] = useState(false);
  const shownAt = useRef(0);
  useLayoutEffect(() => {
    if (shown) shownAt.current = clock.nowMs();
  }, [shown, clock]);
  useEffect(() => {
    if (active && !shown) return whenElapsed(clock, clock.nowMs(), LOADING_DELAY_MS, () => setShown(true));
    if (!active && shown) return whenElapsed(clock, shownAt.current, LOADING_MIN_MS, () => setShown(false));
    return undefined;
  }, [active, shown, clock]);
  return shown;
}

export type SkeletonShape = 'line' | 'row' | 'tile' | 'chart';

/** Placeholder shaped like the final layout; shimmers, static under reduced motion. Hidden from assistive technology. */
export function Skeleton(props: { shape: SkeletonShape; count?: number }): ReactElement {
  return h('div', { className: `skeleton-group skeleton-group--${props.shape}`, 'aria-hidden': true },
    Array.from({ length: props.count ?? 1 }, (_, i) => h('div', { key: i, className: `skeleton skeleton--${props.shape}` })));
}

export interface DeferredLoadingProps {
  loading: boolean;
  skeleton: ReactNode;
  children?: ReactNode;
  /** Measures the 200 ms delay and the 400 ms minimum (default: monotonic). */
  clock?: ElapsedClock;
  label: string;
}

/** First load: nothing for 200 ms, then the skeleton for at least 400 ms, then the content. `aria-busy` while loading. */
export function DeferredLoading(props: DeferredLoadingProps): ReactElement {
  const showSkeleton = useDelayedFlag(props.loading, props.clock);
  const body = showSkeleton ? props.skeleton : props.loading ? null : props.children;
  return h('div', { className: 'deferred', 'aria-busy': props.loading || showSkeleton, 'aria-label': props.label, role: 'region' }, body);
}

export type StateKind = 'loading' | 'empty' | 'filtered-empty' | 'error' | 'stale' | 'disconnected' | 'unauthorised' | 'forbidden' | 'not-found';

export interface StateAction { label: string; onClick: () => void }

export interface StateViewProps {
  kind: StateKind;
  /** One sentence: why the panel is in this state. */
  reason?: string;
  /** Context, e.g. "bot RUNNING in PAPER · last candidate 2m ago". */
  context?: ReactNode;
  action?: StateAction;
  /** Error: what Copy diagnostics copies. */
  diagnostics?: DiagnosticInput;
  onRetry?: () => void;
  /** Error, stale and disconnected: the last good data, kept at full contrast. */
  lastGood?: ReactNode;
  /** The last good data's as_of. */
  asOf?: string;
  /** Stale: the age text (`12s`). */
  age?: string;
  /** Disconnected: reconnect attempt and seconds to the next one. */
  attempt?: number;
  nextInS?: number;
  /** Unauthorised: the URL to return to after signing in. */
  next?: string;
  /** Loading: the skeleton shape. */
  shape?: SkeletonShape;
}

/** A stand-in origin: a return path is safe only when it resolves to the origin it is resolved against. */
const SAME_ORIGIN = 'http://dashboard.invalid';

/** A return path's shape: one leading `/`, no backslash or control character. */
const isPathShaped = (p: string): boolean => p.startsWith('/') && !p.startsWith('//') && !/[\\\p{Cc}]/u.test(p);

/**
 * `/login?next=<path>` for a return path inside the dashboard; anything else returns to `/`. A path must start with one
 * `/`, hold no backslash or control character (URL parsing turns `\` into `/` and drops tabs and newlines, so
 * `/\evil.example` would mean `//evil.example`), and resolve to the same origin. The path returned is the normalised
 * one (dot segments resolved, as a router would), checked again: `/.//evil.example` normalises to `//evil.example`.
 */
export function loginHref(next: string): string {
  const url = isPathShaped(next) ? new URL(next, SAME_ORIGIN) : null;
  const normalised = url === null || url.origin !== SAME_ORIGIN ? null : `${url.pathname}${url.search}${url.hash}`;
  const safe = normalised !== null && isPathShaped(normalised) ? normalised : '/';
  return `/login?next=${encodeURIComponent(safe)}`;
}

/** `as of 14:02:11 UTC`; a missing or malformed time (refused upstream by the schema check) never throws out of render. */
export function asOfText(iso: string | undefined): string {
  if (iso === undefined) return 'as of an unknown time';
  try {
    return `as of ${formatTime(iso).text} UTC`;
  } catch {
    return 'as of an unknown time';
  }
}

function ActionButton(props: { action: StateAction | undefined }): ReactElement | null {
  return props.action === undefined ? null : h(Button, { onClick: props.action.onClick }, props.action.label);
}

function Message(props: { icon: typeof Inbox; reason: string; context?: ReactNode; action?: StateAction | undefined }): ReactElement {
  return h('div', { className: 'state' },
    h(Icon, { icon: props.icon, size: 20, className: 'state__icon' }),
    h('p', { className: 'state__reason' }, props.reason),
    props.context === undefined ? null : h('p', { className: 'state__context' }, props.context),
    h(ActionButton, { action: props.action }));
}

function CopyDiagnostics(props: { diagnostics: DiagnosticInput }): ReactElement {
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    void navigator.clipboard.writeText(diagnosticsText(props.diagnostics)).then(() => setCopied(true), () => setCopied(false));
  };
  return h(Button, { variant: 'ghost', onClick: copy, ...(copied ? { icon: CircleCheck } : {}) }, copied ? 'Copied' : 'Copy diagnostics');
}

/** The danger banner of a lost stream: one alert line; the changing details are outside the alert. */
export function DisconnectedBanner(props: { asOf?: string | undefined; attempt?: number | undefined; nextInS?: number | undefined }): ReactElement {
  const retry = props.attempt === undefined ? 'reconnecting' : `reconnecting (attempt ${props.attempt}${props.nextInS === undefined ? '' : `, next in ${props.nextInS}s`})`;
  return h('div', { className: 'banner banner--disconnected' },
    h(Icon, { icon: STATE_ICONS['disconnected'] as typeof Inbox, className: 'banner__icon' }),
    h('div', { className: 'banner__text' },
      h('p', { className: 'banner__title', role: 'alert' }, 'Disconnected from bot'),
      h('div', { className: 'banner__body' }, `Showing data ${asOfText(props.asOf)} · ${retry}. Trading continues on the server under its own risk limits.`)));
}

export function StateView(props: StateViewProps): ReactElement {
  switch (props.kind) {
    case 'loading':
      return h('div', { className: 'state state--loading', role: 'status', 'aria-busy': true },
        h('span', { className: 'visually-hidden' }, 'Loading'), h(Skeleton, { shape: props.shape ?? 'row', count: 3 }));
    case 'empty':
      return h(Message, { icon: Inbox, reason: props.reason ?? 'Nothing here yet', context: props.context, action: props.action });
    case 'filtered-empty':
      return h(Message, { icon: SearchX, reason: props.reason ?? 'Nothing matches these filters', context: props.context, action: props.action });
    case 'not-found':
      return h(Message, { icon: SearchX, reason: props.reason ?? 'Not found', context: props.context, action: props.action });
    case 'forbidden':
      return h('div', { className: 'state' }, h(Badge, { tone: 'neutral' }, h(Icon, { icon: LockKeyhole }), 'Read only'),
        h('p', { className: 'state__reason' }, props.reason ?? 'Your role can view this page but not change it'));
    case 'unauthorised':
      return h('div', { className: 'state' }, h(Icon, { icon: LockKeyhole, size: 20, className: 'state__icon' }),
        h('p', { className: 'state__reason' }, props.reason ?? 'Your session has ended'),
        h('a', { className: 'btn btn--primary btn--md', href: loginHref(props.next ?? '/') }, 'Sign in'));
    case 'error': {
      const d = props.diagnostics;
      return h('div', { className: 'state state--error' },
        h('div', { className: 'state__error', role: 'alert' },
          h(Icon, { icon: OctagonAlert, className: 'state__error-icon' }),
          h('p', { className: 'state__reason' }, d?.code === undefined || d.code === null ? null : h('code', { className: 'state__code' }, d.code), ' ', props.reason ?? d?.message ?? 'The request failed'),
          h('div', { className: 'state__actions' },
            props.onRetry === undefined ? null : h(Button, { onClick: props.onRetry, icon: RefreshCw }, 'Retry'),
            d === undefined ? null : h(CopyDiagnostics, { diagnostics: d }))),
        props.lastGood === undefined ? null : h(LastGood, { asOf: props.asOf }, props.lastGood));
    }
    case 'stale':
      return h('div', { className: 'state state--stale' },
        h('div', { className: 'state__meta' }, h(Badge, { tone: 'warn' }, `Stale · ${props.age ?? '?'}`), h('span', null, asOfText(props.asOf))),
        props.lastGood ?? null);
    case 'disconnected':
      return h('div', { className: 'state state--disconnected' }, h(DisconnectedBanner, { asOf: props.asOf, attempt: props.attempt, nextInS: props.nextInS }), props.lastGood ?? null);
  }
}

function LastGood(props: { asOf: string | undefined; children?: ReactNode }): ReactElement {
  return h('div', { className: 'state__last-good' }, h('p', { className: 'state__as-of' }, `Last good data, ${asOfText(props.asOf)}`), props.children);
}

const FRESHNESS_LABEL: Readonly<Record<FreshnessState, string>> = { live: 'Live', delayed: 'Delayed', stale: 'Stale', disconnected: 'Disconnected', paused: 'Paused' };

export interface ClockSource { clock: Clock; offsetMs?: number; simTime?: string | null }

/** Freshness of `input` at `nowMs`, and that time. */
interface FreshnessReading { f: Freshness; nowMs: number }

/**
 * Freshness of `input` and the wall-clock time it was measured at: re-evaluated every second on `source`'s clock, and
 * on a fresh clock reading when as_of or the server offset changes (age and skew of new data are never measured
 * against a tick up to 1 s old, which would add up to 1 s of apparent lead).
 */
function useFreshnessReading(input: FreshnessInput, source: ClockSource): FreshnessReading {
  const offsetMs = source.offsetMs ?? 0;
  const now = useNow(source.clock, 1000, `${input.as_of ?? ''} ${offsetMs}`);
  return { f: freshness(input, { nowMs: now, offsetMs, simTime: source.simTime ?? null }), nowMs: now };
}

/** Freshness of `input`, re-evaluated every second on `source`'s clock and when new data arrives. */
export function useFreshness(input: FreshnessInput, source: ClockSource): Freshness {
  return useFreshnessReading(input, source).f;
}

export interface FreshnessIndicatorProps {
  /** What the data is ("Risk limits"), for the announcement. */
  label: string;
  vm: string;
  input: FreshnessInput;
  source: ClockSource;
  variant?: 'dot' | 'text';
  /**
   * Receives a clock-skew diagnostic when the data is ahead of now by more than CLOCK_SKEW_TOLERANCE_MS: once per VM per
   * skew episode (from the first skewed reading until a reading without skew SKEW_EPISODE_END_MS after the last skewed
   * one), however often as_of or the callback changes.
   */
  onDiagnostic?: (d: { kind: 'clock-skew'; vm: string; skew_ms: number }) => void;
}

/** The text of a freshness state: `Live · 2s`, `Stale · 6s`, `Stale · no timestamp`, `Paused`, `Disconnected`. */
export function freshnessText(f: Freshness): string {
  if (f.state === 'paused' || f.state === 'disconnected') return FRESHNESS_LABEL[f.state];
  if (f.ageMs === null || f.reason !== undefined) return `${FRESHNESS_LABEL[f.state]} · ${f.reason ?? ''}`;
  return `${FRESHNESS_LABEL[f.state]} · ${formatAgeMs(f.ageMs)}`;
}

export function FreshnessIndicator(props: FreshnessIndicatorProps): ReactElement {
  const { f, nowMs } = useFreshnessReading(props.input, props.source);
  const { onDiagnostic, vm } = props;
  const skew = f.skewMs;
  // The current skew episode: the VM it was reported for and when skew last showed. It ends at a reading without
  // skew SKEW_EPISODE_END_MS after that.
  const episode = useRef<{ vm: string; lastSkewAt: number } | null>(null);
  useEffect(() => {
    const open = episode.current;
    if (skew === undefined) {
      if (open !== null && nowMs - open.lastSkewAt >= SKEW_EPISODE_END_MS) episode.current = null;
      return;
    }
    if (open !== null && open.vm === vm) {
      open.lastSkewAt = nowMs;
      return;
    }
    if (onDiagnostic === undefined) return;
    episode.current = { vm, lastSkewAt: nowMs };
    onDiagnostic({ kind: 'clock-skew', vm, skew_ms: skew });
  }, [skew, nowMs, onDiagnostic, vm]);
  return h('span', { className: cx('freshness', `freshness--${f.state}`, `freshness--${props.variant ?? 'dot'}`) },
    h('span', { className: 'freshness__dot', 'aria-hidden': true }),
    h('span', { className: 'freshness__text', 'aria-hidden': true }, freshnessText(f)),
    h('span', { className: 'visually-hidden', role: 'status' }, `${props.label}: ${FRESHNESS_LABEL[f.state].toLowerCase()}`));
}

export type ConnectionState = 'connected' | 'reconnecting' | 'disconnected' | 'auth-expired';

export interface ConnectionStatusProps { state: ConnectionState; attempt?: number; nextRetryAt?: number; clock: Clock }

/** Status-bar connection item, on the wall clock (also in replay, where data freshness uses the simulation clock). */
export function ConnectionStatus(props: ConnectionStatusProps): ReactElement {
  const now = useNow(props.clock);
  const nextIn = props.nextRetryAt === undefined ? null : Math.max(0, Math.ceil((props.nextRetryAt - now) / 1000));
  const text = props.state === 'connected' ? 'Connected'
    : props.state === 'disconnected' ? 'Disconnected'
      : props.state === 'auth-expired' ? 'Session expired'
        : `Reconnecting${props.attempt === undefined ? '' : ` · attempt ${props.attempt}`}${nextIn === null ? '' : ` · next in ${nextIn}s`}`;
  const announced = props.state === 'reconnecting' ? `Reconnecting${props.attempt === undefined ? '' : `, attempt ${props.attempt}`}` : text;
  return h('span', { className: `connection connection--${props.state}` },
    h('span', { className: 'connection__dot', 'aria-hidden': true }),
    h('span', { 'aria-hidden': true }, text),
    h('span', { className: 'visually-hidden', role: 'status' }, `Connection: ${announced}`));
}
