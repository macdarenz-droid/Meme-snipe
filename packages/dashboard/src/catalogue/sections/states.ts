// Catalogue section "States" (UI-T05): every StateView kind, the skeleton shapes, every freshness and connection state
// on a fixed demo clock (so screenshots do not change), the risk panel of acceptance 3, replay freshness on the
// simulation clock (acceptance 4), and a loading-timing demo on the real clock (acceptances 1 and 2).
import { createElement as h, useCallback, useLayoutEffect, useRef, useState, type ReactElement } from 'react';
import type { Clock, UnixMs } from '@bot/types';
import { Button } from '../../components/button.ts';
import { ConnectionStatus, DeferredLoading, FreshnessIndicator, Skeleton, StateView, useFreshness, type ClockSource } from '../../components/states.ts';
import { Banner } from '../../components/status.ts';
import { monotonicClock, type ElapsedClock } from '../../lib/clock.ts';
import { blockedReason, thresholdsFor, type FreshnessInput } from '../../lib/freshness.ts';
import type { Section } from '../catalogue.ts';

const AS_OF = '2026-10-06T14:02:11.123Z';
/** The demo's "now": 6 s after AS_OF. */
export const DEMO_NOW = Date.parse('2026-10-06T14:02:17.123Z');
export const demoClock: Clock = { nowMs: () => DEMO_NOW as UnixMs, kind: 'wall' };
const demo: ClockSource = { clock: demoClock };

const at = (msBeforeNow: number): string => new Date(DEMO_NOW - msBeforeNow).toISOString();
const input = (vm: string, asOf: string | null, extra: Partial<FreshnessInput> = {}): FreshnessInput => ({ ...thresholdsFor(vm), as_of: asOf, clock: 'wall', ...extra });

function LastGoodTable(): ReactElement {
  return h('table', { className: 'gallery__table' },
    h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Token'), h('th', { scope: 'col' }, 'PnL'))),
    h('tbody', null, h('tr', null, h('td', null, 'BONK'), h('td', { className: 'num' }, '+0.0123 SOL'))));
}

/** Acceptance 3: VM-12 older than 5 s shows `Stale · 6s`, a danger banner, and blocks raising a limit. */
export function RiskPanel(props: { asOf: string; source: ClockSource }): ReactElement {
  const fresh = input('VM-12', props.asOf);
  const f = useFreshness(fresh, props.source);
  const reason = blockedReason(f, 'Risk status');
  return h('div', { className: 'panel' },
    h('div', { className: 'panel__header' }, h('h3', { className: 'panel__title' }, 'Risk limits'), h(FreshnessIndicator, { label: 'Risk limits', vm: 'VM-12', input: fresh, source: props.source })),
    reason === undefined ? null : h(Banner, { tone: 'danger', title: 'Risk status unknown' }, 'Raise-limit actions are disabled until the risk data is fresh.'),
    h('div', { className: 'panel__body' },
      h(Button, { variant: 'primary', ...(reason === undefined ? {} : { disabledReason: reason }) }, 'Raise limit'),
      h(Button, { variant: 'secondary' }, 'Lower limit')));
}

/**
 * Acceptances 1 and 2 on the real clock: a request of `ms`; records when the skeleton entered and left the DOM, on the
 * clock DeferredLoading measures with (monotonic by default).
 */
export function LoadingTiming(props: { clock?: ElapsedClock }): ReactElement {
  const clock = props.clock ?? monotonicClock;
  const [loading, setLoading] = useState(false);
  const [log, setLog] = useState<{ shown: number | null; hidden: number | null }>({ shown: null, hidden: null });
  const start = useRef(0);
  const run = (ms: number): void => {
    start.current = clock.nowMs();
    setLog({ shown: null, hidden: null });
    setLoading(true);
    setTimeout(() => setLoading(false), ms);
  };
  // Stable, so the probe's effect runs only when the skeleton mounts and unmounts.
  const onSkeleton = useCallback((visible: boolean): void => {
    const t = clock.nowMs() - start.current;
    setLog((l) => (visible ? { ...l, shown: t } : { ...l, hidden: t }));
  }, [clock]);
  return h('div', { className: 'demo__stack' },
    h('div', { className: 'demo__row' },
      h(Button, { onClick: () => run(150) }, 'Load in 150 ms'),
      h(Button, { onClick: () => run(250) }, 'Load in 250 ms')),
    h(DeferredLoading, { loading, label: 'Timing demo', clock, skeleton: h(SkeletonProbe, { onChange: onSkeleton }) }, h('p', { className: 'demo__text' }, 'Loaded')),
    h('output', { className: 'demo__out', 'data-shown-at': log.shown ?? '', 'data-hidden-at': log.hidden ?? '' },
      `skeleton shown at ${log.shown === null ? '-' : Math.round(log.shown)} ms, hidden at ${log.hidden === null ? '-' : Math.round(log.hidden)} ms`));
}

/** A skeleton that reports when it enters and leaves the DOM (layout effects run in the commit, before paint). */
function SkeletonProbe(props: { onChange: (visible: boolean) => void }): ReactElement {
  const { onChange } = props;
  useLayoutEffect(() => {
    onChange(true);
    return () => onChange(false);
  }, [onChange]);
  return h(Skeleton, { shape: 'row', count: 2 });
}

function States(): ReactElement {
  const noop = (): void => undefined;
  const replay: ClockSource = { clock: demoClock, simTime: '2026-09-30T14:02:11.123Z' };
  return h('div', { className: 'demos' },
    h('div', { className: 'demo' }, h('h3', { className: 'demo__title' }, 'State views'), h('div', { className: 'state-grid' },
      h(StateView, { kind: 'loading', shape: 'row' }),
      h(StateView, { kind: 'empty', reason: 'No open positions', context: 'Bot running in paper mode · last candidate 2m ago' }),
      h(StateView, { kind: 'filtered-empty', reason: 'No trades match these filters', action: { label: 'Clear filters', onClick: noop } }),
      h(StateView, { kind: 'not-found', reason: 'No token with this mint', action: { label: 'Back to candidates', onClick: noop } }),
      h(StateView, { kind: 'unauthorised', next: '/positions?strategy=mr' }),
      h(StateView, { kind: 'forbidden' }),
      h(StateView, { kind: 'error', onRetry: noop, asOf: AS_OF, lastGood: h(LastGoodTable),
        diagnostics: { vm: 'VM-05', field_path: 'positions[3].size_base', http_status: 200, seq: '1842', code: 'E_SCHEMA', message: 'size_base is not a U64Str' } }),
      h(StateView, { kind: 'stale', age: '12s', asOf: AS_OF, lastGood: h(LastGoodTable) }),
      h(StateView, { kind: 'disconnected', attempt: 3, nextInS: 4, asOf: AS_OF, lastGood: h(LastGoodTable) }))),
    h('div', { className: 'demo' }, h('h3', { className: 'demo__title' }, 'Skeletons'), h('div', { className: 'state-grid' },
      h(Skeleton, { shape: 'line', count: 3 }), h(Skeleton, { shape: 'row', count: 3 }), h(Skeleton, { shape: 'tile', count: 2 }), h(Skeleton, { shape: 'chart' }))),
    h('div', { className: 'demo' }, h('h3', { className: 'demo__title' }, 'Freshness'), h('div', { className: 'demo__row' },
      h(FreshnessIndicator, { label: 'Positions', vm: 'VM-05', input: input('VM-05', at(1000)), source: demo }),
      h(FreshnessIndicator, { label: 'Positions', vm: 'VM-05', input: input('VM-05', at(7000)), source: demo }),
      h(FreshnessIndicator, { label: 'Risk limits', vm: 'VM-12', input: input('VM-12', at(6000)), source: demo }),
      h(FreshnessIndicator, { label: 'Positions', vm: 'VM-05', input: input('VM-05', at(1000), { disconnected: true }), source: demo }),
      h(FreshnessIndicator, { label: 'Signal feed', vm: 'VM-05', input: input('VM-05', at(1000), { paused: true }), source: demo }),
      h(FreshnessIndicator, { label: 'Balances', vm: 'VM-04', input: input('VM-04', null), source: demo }),
      h(FreshnessIndicator, { label: 'Positions', vm: 'VM-05', input: input('VM-05', at(2000)), source: demo, variant: 'text' }))),
    h('div', { className: 'demo' }, h('h3', { className: 'demo__title' }, 'Connection'), h('div', { className: 'demo__row' },
      h(ConnectionStatus, { state: 'connected', clock: demoClock }),
      h(ConnectionStatus, { state: 'reconnecting', attempt: 3, nextRetryAt: DEMO_NOW + 4000, clock: demoClock }),
      h(ConnectionStatus, { state: 'disconnected', clock: demoClock }),
      h(ConnectionStatus, { state: 'auth-expired', clock: demoClock }))),
    h('div', { className: 'demo' }, h('h3', { className: 'demo__title' }, 'Risk panel'), h(RiskPanel, { asOf: AS_OF, source: demo })),
    h('div', { className: 'demo' }, h('h3', { className: 'demo__title' }, 'Replay'), h('div', { className: 'demo__row' },
      h(FreshnessIndicator, { label: 'Positions (replay)', vm: 'VM-05', input: input('VM-05', '2026-09-30T14:02:10.123Z', { clock: 'sim' }), source: replay }),
      h(ConnectionStatus, { state: 'reconnecting', attempt: 1, nextRetryAt: DEMO_NOW + 2000, clock: demoClock }))),
    h('div', { className: 'demo' }, h('h3', { className: 'demo__title' }, 'Loading timing'), h(LoadingTiming, {})));
}

export const statesSection: Section = { id: 'states', title: 'States', render: () => h(States) };
