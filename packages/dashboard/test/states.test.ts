// UI-T05 components in a DOM, on fake timers: DeferredLoading (acceptances 1 and 2), StateView kinds, Copy
// diagnostics, FreshnessIndicator re-evaluating every second with one announcement per state change and one skew
// report per VM per skew episode, ConnectionStatus on the wall clock while replay data uses the simulation clock (acceptance 4),
// the risk panel (acceptance 3) and the disconnected banner's single alert.
import './dom.ts';
import { strict as assert } from 'node:assert';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import { createElement as h, useLayoutEffect, useState, type ReactElement } from 'react';
import type { Clock, UnixMs } from '@bot/types';
import { DEMO_NOW, LoadingTiming, RiskPanel, demoClock, statesSection } from '../src/catalogue/sections/states.ts';
import { ConnectionStatus, DeferredLoading, FreshnessIndicator, Skeleton, StateView, freshnessText, loginHref, useDelayedFlag } from '../src/components/states.ts';
import { wallClock } from '../src/lib/clock.ts';
import { CLOCK_SKEW_TOLERANCE_MS, SKEW_EPISODE_END_MS, thresholdsFor } from '../src/lib/freshness.ts';
import { actAsync, actSync, click, render, type Rendered } from './dom.ts';

const AS_OF = '2026-10-06T14:02:11.123Z';
/** The wall clock, which reads Date.now: mocked here, so it advances with vi.advanceTimersByTime. */
const mockedClock: Clock = wallClock;
/** Advances the fake clock in 10 ms steps, with a React commit after each, as a browser would render between timers. */
const tick = (ms: number): void => {
  for (let left = ms; left > 0; left -= 10) actSync(() => vi.advanceTimersByTime(Math.min(10, left)));
  if (ms === 0) actSync(() => vi.advanceTimersByTime(0));
};

const mounted: Rendered[] = [];
const mount = (el: ReactElement): Rendered => { const r = render(el); mounted.push(r); return r; };
beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'], now: Date.parse(AS_OF) }));
afterEach(() => { while (mounted.length > 0) mounted.pop()?.unmount(); vi.useRealTimers(); document.body.innerHTML = ''; });

function Loader(props: { resolveAfterMs: number }): ReactElement {
  const [loading, setLoading] = useState(true);
  setTimeout(() => setLoading(false), props.resolveAfterMs);
  return h(DeferredLoading, { loading, label: 'Positions', clock: mockedClock, skeleton: h(Skeleton, { shape: 'row' }) }, h('p', { className: 'data' }, 'data'));
}

describe('UI-T05 DeferredLoading', () => {
  it('acceptance 1: a request resolving in 150 ms never shows the skeleton', () => {
    const r = mount(h(Loader, { resolveAfterMs: 150 }));
    const seen: boolean[] = [];
    for (let t = 0; t < 400; t += 10) { seen.push(r.container.querySelector('.skeleton') !== null); tick(10); }
    assert.ok(seen.every((s) => !s));
    assert.equal(r.container.querySelector('.data')?.textContent, 'data');
    assert.equal(r.container.querySelector('[role="region"]')?.getAttribute('aria-busy'), 'false');
  });

  it('acceptance 2: a request resolving in 250 ms shows the skeleton from 200 ms to 600 ms', () => {
    const r = mount(h(Loader, { resolveAfterMs: 250 }));
    const timeline: Array<[number, boolean]> = [];
    for (let t = 0; t <= 700; t += 10) { timeline.push([t, r.container.querySelector('.skeleton') !== null]); tick(10); }
    const shown = timeline.filter(([, s]) => s).map(([t]) => t);
    assert.equal(shown[0], 200);
    assert.equal(shown.at(-1), 590);
    assert.equal(timeline.find(([t]) => t === 100)?.[1], false);
    assert.equal(r.container.querySelector('[role="region"]')?.textContent, 'data');
  });

  it('nothing (never zeros or an empty table) shows before 200 ms; a request that restarts keeps the skeleton', () => {
    function Toggle(): ReactElement {
      const [loading, setLoading] = useState(true);
      const shown = useDelayedFlag(loading, mockedClock);
      return h('button', { type: 'button', onClick: () => setLoading(!loading), 'data-shown': shown }, 'toggle');
    }
    const r = mount(h(Toggle));
    const b = r.container.querySelector('button') as HTMLButtonElement;
    tick(250);
    assert.equal(b.dataset['shown'], 'true');
    click(b);
    tick(100);
    click(b);
    tick(1000);
    assert.equal(b.dataset['shown'], 'true', 'loading again before the minimum: stays shown');
    click(b);
    tick(0);
    assert.equal(b.dataset['shown'], 'false', 'shown longer than 400 ms: hides at once');
    const d = mount(h(DeferredLoading, { loading: true, label: 'L', skeleton: h(Skeleton, { shape: 'tile' }) }));
    assert.equal(d.container.querySelector('[role="region"]')?.childElementCount, 0);
  });

  /** A skeleton that logs, on `clock`, when it enters and leaves the DOM (layout effects run in the commit). */
  const commitLog = (clock: Clock, log: Array<[string, number]>): (() => ReactElement) => function Probe(): ReactElement {
    useLayoutEffect(() => {
      log.push(['in', clock.nowMs() - Date.parse(AS_OF)]);
      return () => { log.push(['out', clock.nowMs() - Date.parse(AS_OF)]); };
    }, []);
    return h(Skeleton, { shape: 'row' });
  };

  it('the 400 ms minimum counts from the commit that shows the skeleton, not from the timer that asked for it', () => {
    const log: Array<[string, number]> = [];
    const Probe = commitLog(mockedClock, log);
    const view = (loading: boolean): ReactElement => h(DeferredLoading, { loading, label: 'L', clock: mockedClock, skeleton: h(Probe) });
    const r = mount(view(true));
    tick(190);
    // The 200 ms timer fires, then 30 ms pass before React commits the skeleton (a busy main thread).
    actSync(() => { vi.advanceTimersByTime(10); vi.advanceTimersByTime(30); });
    assert.deepEqual(log, [['in', 230]]);
    tick(20);
    r.rerender(view(false));
    tick(600);
    assert.deepEqual(log, [['in', 230], ['out', 630]], 'visible for 400 ms from the commit');
  });

  it('a timer that fires early on the minimum\'s clock neither shows nor hides the skeleton early', () => {
    const log: Array<[string, number]> = [];
    let lag = 0;
    /** A clock that falls behind the timers by `lag` ms, as a coarser clock than the timers' does. */
    const lagging: Clock = { nowMs: () => (mockedClock.nowMs() - lag) as UnixMs, kind: 'wall' };
    const Probe = commitLog(lagging, log);
    const view = (loading: boolean): ReactElement => h(DeferredLoading, { loading, label: 'L', clock: lagging, skeleton: h(Probe) });
    const r = mount(view(true));
    tick(190);
    lag = 5;
    tick(10);
    assert.deepEqual(log, [], 'the 200 ms timer fired when the clock read 195 ms');
    actSync(() => vi.advanceTimersByTime(5));
    assert.deepEqual(log, [['in', 200]]);
    tick(50);
    r.rerender(view(false));
    lag = 10;
    actSync(() => vi.advanceTimersByTime(350));
    assert.deepEqual(log, [['in', 200]], 'the hide timer fired when the clock read 595 ms');
    actSync(() => vi.advanceTimersByTime(5));
    assert.deepEqual(log, [['in', 200], ['out', 600]]);
  });
});

describe('UI-T05 StateView', () => {
  it('renders every kind with its reason, context and action', () => {
    const onClick = vi.fn();
    const r = mount(h('div', null,
      h(StateView, { kind: 'loading' }),
      h(StateView, { kind: 'empty', reason: 'No open positions', context: 'Bot running in paper mode', action: { label: 'Open settings', onClick } }),
      h(StateView, { kind: 'empty' }),
      h(StateView, { kind: 'filtered-empty', reason: 'No trades match these filters', action: { label: 'Clear filters', onClick } }),
      h(StateView, { kind: 'filtered-empty' }),
      h(StateView, { kind: 'not-found' }),
      h(StateView, { kind: 'forbidden' }),
      h(StateView, { kind: 'forbidden', reason: 'Viewer role' }),
      h(StateView, { kind: 'unauthorised', next: '/positions?strategy=mr' }),
      h(StateView, { kind: 'unauthorised', reason: 'Signed out' }),
      h(StateView, { kind: 'stale', asOf: AS_OF, age: '12s', lastGood: h('p', null, 'last good') }),
      h(StateView, { kind: 'stale' }),
      h(StateView, { kind: 'disconnected', attempt: 3, nextInS: 4, asOf: AS_OF, lastGood: h('p', null, 'last good') }),
      h(StateView, { kind: 'disconnected' }),
      h(StateView, { kind: 'disconnected', attempt: 5 })));
    const text = r.container.textContent ?? '';
    for (const s of ['No open positions', 'Bot running in paper mode', 'Nothing here yet', 'No trades match these filters', 'Nothing matches these filters', 'Not found',
      'Read only', 'Your role can view this page but not change it', 'Viewer role', 'Your session has ended', 'Signed out', 'Stale · 12s', 'as of 14:02:11 UTC',
      'Stale · ?', 'as of an unknown time', 'reconnecting (attempt 3, next in 4s)', 'reconnecting (attempt 5).', 'Trading continues on the server under its own risk limits']) assert.ok(text.includes(s), s);
    assert.equal(r.container.querySelector('a[href^="/login"]')?.getAttribute('href'), '/login?next=%2Fpositions%3Fstrategy%3Dmr');
    assert.equal(r.container.querySelector('.state--loading')?.getAttribute('aria-busy'), 'true');
    for (const b of r.container.querySelectorAll('button')) click(b);
    assert.equal(onClick.mock.calls.length, 2);
    const alerts = r.container.querySelectorAll('[role="alert"]');
    assert.deepEqual([...alerts].map((a) => a.textContent), ['Disconnected from bot', 'Disconnected from bot', 'Disconnected from bot'], 'the alert holds only the fixed line');
  });

  it('error: code and message, Retry, Copy diagnostics (no secrets), last good data as of', async () => {
    const onRetry = vi.fn();
    const writes: string[] = [];
    const clip = vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(async (t: string) => { writes.push(t); });
    try {
      const r = mount(h(StateView, { kind: 'error', onRetry, asOf: AS_OF, lastGood: h('p', null, 'last good'),
        diagnostics: { vm: 'VM-05', field_path: 'positions[3].size_base', http_status: 200, seq: '1842', code: 'E_SCHEMA', message: 'size_base is not a U64Str' } }));
      assert.match(r.container.querySelector('[role="alert"]')?.textContent ?? '', /E_SCHEMA size_base is not a U64Str/);
      assert.match(r.container.textContent ?? '', /Last good data, as of 14:02:11 UTC.*last good/);
      const [retry, copy] = [...r.container.querySelectorAll('button')] as HTMLButtonElement[];
      click(retry as HTMLButtonElement);
      assert.equal(onRetry.mock.calls.length, 1);
      await actAsync(() => { (copy as HTMLButtonElement).click(); });
      assert.deepEqual(JSON.parse(writes[0] as string), { vm: 'VM-05', field_path: 'positions[3].size_base', http_status: 200, seq: '1842', code: 'E_SCHEMA', message: 'size_base is not a U64Str' });
      assert.equal(copy?.textContent, 'Copied');
      clip.mockImplementation(async () => { throw new Error('denied'); });
      await actAsync(() => { (copy as HTMLButtonElement).click(); });
      assert.equal(copy?.textContent, 'Copy diagnostics');
    } finally { clip.mockRestore(); }
    const plain = mount(h(StateView, { kind: 'error', reason: 'Request failed', diagnostics: { vm: 'VM-12', code: null } }));
    assert.equal(plain.container.querySelector('[role="alert"] p')?.textContent, ' Request failed');
    const bare = mount(h(StateView, { kind: 'error' }));
    assert.equal(bare.container.querySelectorAll('button').length, 0);
    assert.match(bare.container.textContent ?? '', /The request failed/);
  });

  it('loginHref keeps only paths inside the dashboard', () => {
    assert.equal(loginHref('/journal?x=1'), '/login?next=%2Fjournal%3Fx%3D1');
    assert.equal(loginHref('https://evil.example/'), '/login?next=%2F');
    assert.equal(loginHref('//evil.example/'), '/login?next=%2F');
  });

  it('loginHref refuses backslashes and control characters, which URL parsing turns into another origin (review m1)', () => {
    const origin = 'http://127.0.0.1:4173';
    const landing = (next: string): string => new URL(new URL(loginHref(next), origin).searchParams.get('next') as string, origin).host;
    for (const bad of ['/\\evil.example/x', '/\t/evil.example/x', '/\n/evil.example', '/\r/evil.example', '/a\u0000b', '/a\u0085b', '/a\u007Fb']) {
      assert.equal(loginHref(bad), '/login?next=%2F', JSON.stringify(bad));
    }
    assert.equal(landing('/\\evil.example/x'), '127.0.0.1:4173');
    assert.equal(loginHref('/positions/a%5Cb'), '/login?next=%2Fpositions%2Fa%255Cb', 'an encoded backslash stays in the path');
    // Review n3: dot segments that normalise to `//host` (a protocol-relative URL for a later redirect) return to `/`;
    // other dot segments return their normalised path.
    for (const bad of ['/.//evil.example', '/%2e//evil.example', '/a/..//evil.example', '/./%2E//evil.example/x?y#z']) {
      assert.equal(loginHref(bad), '/login?next=%2F', bad);
    }
    assert.equal(loginHref('/a/./b/../journal?x=1#t'), `/login?next=${encodeURIComponent('/a/journal?x=1#t')}`);
    const nextOf = (p: string): string => new URL(loginHref(p), 'http://127.0.0.1:4173').searchParams.get('next') as string;
    fc.assert(fc.property(fc.array(fc.constantFrom('', '.', '..', '%2e', '.%2E', 'a', 'evil.example', '/'), { maxLength: 6 }), (parts) => {
      const next = nextOf(`/${parts.join('/')}`);
      return !next.startsWith('//') && new URL(next, 'http://127.0.0.1:4173').pathname === next.replace(/[?#].*$/, '');
    }), { seed: 20261007, numRuns: 2000 });
    // Whatever the input, the return path lands on the dashboard's own origin.
    fc.assert(fc.property(fc.string({ unit: 'binary', maxLength: 24 }), (tail) => landing(`/${tail}`) === '127.0.0.1:4173' && landing(tail) === '127.0.0.1:4173'), { seed: 20261007, numRuns: 2000 });
  });
});

describe('UI-T05 FreshnessIndicator and ConnectionStatus', () => {
  it('re-evaluates every second; announces only state changes', () => {
    const r = mount(h(FreshnessIndicator, { label: 'Risk limits', vm: 'VM-12', input: { ...thresholdsFor('VM-12'), as_of: AS_OF, clock: 'wall' }, source: { clock: mockedClock } }));
    const text = (): string => r.container.querySelector('.freshness__text')?.textContent ?? '';
    const said = (): string => r.container.querySelector('[role="status"]')?.textContent ?? '';
    assert.equal(text(), 'Live · 0s');
    assert.equal(said(), 'Risk limits: live');
    tick(1000);
    assert.equal(text(), 'Live · 1s');
    tick(3000);
    assert.equal(text(), 'Delayed · 4s');
    assert.equal(said(), 'Risk limits: delayed');
    tick(2000);
    assert.equal(text(), 'Stale · 6s');
    assert.equal(said(), 'Risk limits: stale');
    assert.match(r.container.firstElementChild?.className ?? '', /freshness--stale freshness--dot/);
  });

  it('reports clock skew once per VM per skew episode (review m6)', () => {
    const onDiagnostic = vi.fn();
    const props = (asOf: string, vm = 'VM-12') => ({ label: 'Risk', vm, onDiagnostic, variant: 'text' as const, input: { ...thresholdsFor('VM-12'), as_of: asOf, clock: 'wall' as const }, source: { clock: mockedClock } });
    const ahead = new Date(Date.parse(AS_OF) + 5000).toISOString();
    const r = mount(h(FreshnessIndicator, props(ahead)));
    tick(3000);
    assert.equal(onDiagnostic.mock.calls.length, 1);
    assert.deepEqual(onDiagnostic.mock.calls[0], [{ kind: 'clock-skew', vm: 'VM-12', skew_ms: 5000 }]);
    const lead = (ms: number): string => new Date(mockedClock.nowMs() + ms).toISOString();
    // A new as_of in the same episode is not another report.
    r.rerender(h(FreshnessIndicator, props(lead(6000))));
    assert.equal(onDiagnostic.mock.calls.length, 1);
    // A reading without skew within SKEW_EPISODE_END_MS of the last skewed one does not end the episode (review N1).
    r.rerender(h(FreshnessIndicator, props(lead(0))));
    tick(SKEW_EPISODE_END_MS - 1000);
    r.rerender(h(FreshnessIndicator, props(lead(6000))));
    assert.equal(onDiagnostic.mock.calls.length, 1);
    // Free of skew for SKEW_EPISODE_END_MS: the episode ends, and the next skew is a new one.
    r.rerender(h(FreshnessIndicator, props(lead(0))));
    tick(SKEW_EPISODE_END_MS);
    r.rerender(h(FreshnessIndicator, props(lead(6000))));
    assert.equal(onDiagnostic.mock.calls.length, 2);
    // Another VM is reported on its own.
    r.rerender(h(FreshnessIndicator, props(lead(9000), 'VM-05')));
    assert.equal(onDiagnostic.mock.calls.length, 3);
    assert.equal((onDiagnostic.mock.calls[2]?.[0] as { vm: string }).vm, 'VM-05');
    const quiet = mount(h(FreshnessIndicator, { ...props(lead(5000)), onDiagnostic: undefined as never }));
    // Without a callback nothing is reported and no episode starts: one given later reports the skew still showing.
    const late = vi.fn();
    quiet.rerender(h(FreshnessIndicator, { ...props(lead(5000)), onDiagnostic: late }));
    assert.equal(late.mock.calls.length, 1);
    const within = vi.fn();
    mount(h(FreshnessIndicator, { ...props(new Date(mockedClock.nowMs() + 500).toISOString()), onDiagnostic: within }));
    assert.equal(within.mock.calls.length, 0, 'ahead by 500 ms, within the skew tolerance: not reported');
  });

  it('server 3 s ahead, VM-12 updating at 1 Hz with a new callback each render: one report in 10 s (review m6)', () => {
    let calls = 0;
    const el = (asOf: string): ReactElement => h(FreshnessIndicator, {
      label: 'Risk', vm: 'VM-12', input: { ...thresholdsFor('VM-12'), as_of: asOf, clock: 'wall' }, source: { clock: mockedClock }, onDiagnostic: () => { calls += 1; },
    });
    const r = mount(el(new Date(mockedClock.nowMs() + 3000).toISOString()));
    for (let i = 1; i <= 10; i += 1) {
      tick(1000);
      r.rerender(el(new Date(mockedClock.nowMs() + 3000).toISOString()));
    }
    assert.equal(calls, 1);
  });

  // Review N1: as_of arriving late in a 1 s tick cycle was measured against the last tick, up to 1 s old, which added
  // up to 1 s of apparent lead: a 150 ms lead read as skew, and a 1200 ms lead was reported on every update, inflated.
  for (const phaseMs of [100, 500, 900]) {
    for (const leadMs of [150, 800, 1200, 3000]) {
      it(`server ${leadMs} ms ahead, VM-12 at 1 Hz arriving ${phaseMs} ms after the tick: ${leadMs > CLOCK_SKEW_TOLERANCE_MS ? 'one exact report' : 'no report'} in 10 s (review N1)`, () => {
        const onDiagnostic = vi.fn();
        const el = (): ReactElement => h(FreshnessIndicator, {
          label: 'Risk', vm: 'VM-12', onDiagnostic, variant: 'text', source: { clock: mockedClock },
          input: { ...thresholdsFor('VM-12'), as_of: new Date(mockedClock.nowMs() + leadMs).toISOString(), clock: 'wall' },
        });
        const r = mount(el());
        for (let i = 0; i < 10; i += 1) {
          tick(phaseMs);
          r.rerender(el());
          tick(1000 - phaseMs);
        }
        const reports = onDiagnostic.mock.calls.map((c) => c[0] as { skew_ms: number });
        assert.deepEqual(reports.map((d) => d.skew_ms), leadMs > CLOCK_SKEW_TOLERANCE_MS ? [leadMs] : []);
      });
    }
  }

  it('a lead hovering around the tolerance is one skew episode, not a report per crossing (review N1)', () => {
    const onDiagnostic = vi.fn();
    const el = (leadMs: number): ReactElement => h(FreshnessIndicator, {
      label: 'Risk', vm: 'VM-12', onDiagnostic, source: { clock: mockedClock },
      input: { ...thresholdsFor('VM-12'), as_of: new Date(mockedClock.nowMs() + leadMs).toISOString(), clock: 'wall' },
    });
    const r = mount(el(900));
    for (let i = 1; i <= 50; i += 1) {
      tick(1000);
      r.rerender(el(i % 2 === 0 ? 900 : 1100));
    }
    assert.equal(onDiagnostic.mock.calls.length, 1);
  });

  it('VM-09 (60 s cadence) with a steady 1500 ms lead reports once per update a full minute apart; a sooner update continues the episode (red-team 3 RT3-3)', () => {
    const onDiagnostic = vi.fn();
    const el = (): ReactElement => h(FreshnessIndicator, {
      label: 'Wallet', vm: 'VM-09', onDiagnostic, source: { clock: mockedClock },
      input: { ...thresholdsFor('VM-09'), as_of: new Date(mockedClock.nowMs() + 1500).toISOString(), clock: 'wall' },
    });
    const r = mount(el());
    for (let i = 0; i < 5; i += 1) {
      tick(SKEW_EPISODE_END_MS);
      r.rerender(el());
    }
    assert.deepEqual(onDiagnostic.mock.calls.map((c) => (c[0] as { skew_ms: number }).skew_ms), [1500, 1500, 1500, 1500, 1500, 1500]);
    tick(SKEW_EPISODE_END_MS - 1000);
    r.rerender(el());
    assert.equal(onDiagnostic.mock.calls.length, 6);
  });

  it('a new server offset is measured on a fresh clock reading too (review N1)', () => {
    const onDiagnostic = vi.fn();
    const asOf = new Date(mockedClock.nowMs() + 900).toISOString();
    const el = (offsetMs: number): ReactElement => h(FreshnessIndicator, {
      label: 'Risk', vm: 'VM-12', onDiagnostic, source: { clock: mockedClock, offsetMs },
      input: { ...thresholdsFor('VM-12'), as_of: asOf, clock: 'wall' },
    });
    const r = mount(el(0));
    tick(900);
    // The offset falls by 200 ms, 900 ms after the tick: the lead is now 200 ms; against that tick it would read 1100 ms.
    r.rerender(el(-200));
    assert.equal(onDiagnostic.mock.calls.length, 0);
  });

  it('the age of new data is measured on arrival, not at the last tick (review N1)', () => {
    const el = (): ReactElement => h(FreshnessIndicator, {
      label: 'Risk', vm: 'VM-12', variant: 'text', source: { clock: mockedClock },
      input: { ...thresholdsFor('VM-12'), as_of: new Date(mockedClock.nowMs() - 2500).toISOString(), clock: 'wall' },
    });
    const r = mount(el());
    tick(900);
    r.rerender(el());
    // 2.5 s old on arrival; against the tick 900 ms earlier it would read 1.6 s.
    assert.equal(r.container.querySelector('.freshness__text')?.textContent, 'Live · 2s');
  });

  it('a malformed as_of renders stale with its reason instead of unmounting the page (review m5)', () => {
    const r = mount(h(FreshnessIndicator, { label: 'Risk', vm: 'VM-12', variant: 'text', input: { ...thresholdsFor('VM-12'), as_of: '2026-10-07T14:02:11Z', clock: 'wall' }, source: { clock: mockedClock } }));
    assert.equal(r.container.querySelector('.freshness__text')?.textContent, 'Stale · invalid timestamp');
    assert.equal(r.container.querySelector('[role="status"]')?.textContent, 'Risk: stale');
  });

  it('freshnessText for every state', () => {
    assert.equal(freshnessText({ state: 'paused', ageState: 'live', ageMs: 1 }), 'Paused');
    assert.equal(freshnessText({ state: 'disconnected', ageState: 'live', ageMs: 1 }), 'Disconnected');
    assert.equal(freshnessText({ state: 'stale', ageState: 'stale', ageMs: null, reason: 'no timestamp' }), 'Stale · no timestamp');
    assert.equal(freshnessText({ state: 'stale', ageState: 'stale', ageMs: null }), 'Stale · ');
    assert.equal(freshnessText({ state: 'delayed', ageState: 'delayed', ageMs: 252000 }), 'Delayed · 4m 12s');
    assert.equal(freshnessText({ state: 'stale', ageState: 'stale', ageMs: 0, reason: 'clock skew', skewMs: 2500 }), 'Stale · clock skew');
  });

  it('acceptance 4: in replay, data freshness follows the paused simulation clock while ConnectionStatus counts down on the wall clock', () => {
    const r = mount(h('div', null,
      h(FreshnessIndicator, { label: 'Positions', vm: 'VM-05', input: { ...thresholdsFor('VM-05'), as_of: '2026-09-30T14:02:10.123Z', clock: 'sim' },
        source: { clock: mockedClock, simTime: '2026-09-30T14:02:11.123Z' } }),
      h(ConnectionStatus, { state: 'reconnecting', attempt: 2, nextRetryAt: Date.parse(AS_OF) + 4000, clock: mockedClock })));
    const fresh = (): string => r.container.querySelector('.freshness__text')?.textContent ?? '';
    const conn = (): string => r.container.querySelector('.connection > span:nth-child(2)')?.textContent ?? '';
    assert.deepEqual([fresh(), conn()], ['Live · 1s', 'Reconnecting · attempt 2 · next in 4s']);
    tick(3000);
    assert.deepEqual([fresh(), conn()], ['Live · 1s', 'Reconnecting · attempt 2 · next in 1s']);
    tick(60000);
    assert.deepEqual([fresh(), conn()], ['Live · 1s', 'Reconnecting · attempt 2 · next in 0s']);
    assert.equal(r.container.querySelectorAll('[role="status"]')[1]?.textContent, 'Connection: Reconnecting, attempt 2');
  });

  it('ConnectionStatus states', () => {
    const r = mount(h('div', null, ...(['connected', 'disconnected', 'auth-expired', 'reconnecting'] as const).map((state) => h(ConnectionStatus, { key: state, state, clock: mockedClock }))));
    assert.deepEqual([...r.container.querySelectorAll('[role="status"]')].map((s) => s.textContent),
      ['Connection: Connected', 'Connection: Disconnected', 'Connection: Session expired', 'Connection: Reconnecting']);
  });
});

describe('Z05 round 2 (red team m2): a malformed asOf', () => {
  it('renders "as of an unknown time" in every state that shows it, never a throw', () => {
    for (const bad of ['2026-10-07T14:02:11Z', 'not a time', '2026-02-30T00:00:00.000Z']) {
      const views = [
        h(StateView, { kind: 'stale', asOf: bad, age: '12s', lastGood: h('p', null, 'last good') }),
        h(StateView, { kind: 'disconnected', attempt: 3, nextInS: 4, asOf: bad, lastGood: h('p', null, 'last good') }),
        h(StateView, { kind: 'error', onRetry: () => undefined, asOf: bad, lastGood: h('p', null, 'last good') }),
      ];
      for (const v of views) {
        const r = mount(v);
        assert.match(r.container.textContent ?? '', /as of an unknown time/, bad);
        assert.doesNotMatch(r.container.textContent ?? '', /UTC/, bad);
      }
    }
  });
});

describe('UI-T05 catalogue: risk panel, loading timing and the States section', () => {
  it('acceptance 3: VM-12 6 s old shows Stale · 6s, a danger banner, and Raise limit disabled with "Risk status is stale"', () => {
    const r = mount(h(RiskPanel, { asOf: AS_OF, source: { clock: demoClock } }));
    assert.equal(r.container.querySelector('.freshness__text')?.textContent, 'Stale · 6s');
    assert.equal(r.container.querySelector('.banner--danger [role="alert"], .banner--danger')?.getAttribute('role'), 'alert');
    const raise = [...r.container.querySelectorAll('button')].find((b) => b.textContent === 'Raise limit') as HTMLButtonElement;
    assert.equal(raise.getAttribute('aria-disabled'), 'true');
    assert.equal(document.getElementById(raise.getAttribute('aria-describedby') as string)?.textContent, 'Risk status is stale');
    const lower = [...r.container.querySelectorAll('button')].find((b) => b.textContent === 'Lower limit') as HTMLButtonElement;
    assert.equal(lower.getAttribute('aria-disabled'), null, 'risk-reducing actions stay enabled');
    const fresh = mount(h(RiskPanel, { asOf: new Date(DEMO_NOW - 1000).toISOString(), source: { clock: demoClock } }));
    assert.equal(fresh.container.querySelector('.banner'), null);
  });

  it('the loading-timing demo records when the skeleton showed and hid', () => {
    const r = mount(h(LoadingTiming, { clock: mockedClock }));
    const [fast, slow] = [...r.container.querySelectorAll('button')] as HTMLButtonElement[];
    const out = (): DOMStringMap => (r.container.querySelector('output') as HTMLOutputElement).dataset;
    click(fast as HTMLButtonElement);
    tick(1000);
    assert.deepEqual([out()['shownAt'], out()['hiddenAt']], ['', '']);
    click(slow as HTMLButtonElement);
    tick(1000);
    assert.deepEqual([out()['shownAt'], out()['hiddenAt']], ['200', '600']);
    mount(h(LoadingTiming, {}));
  });

  it('the States section renders every state', () => {
    const r = mount(h('div', null, statesSection.render()));
    assert.equal(r.container.querySelectorAll('.state-grid > *').length, 13);
    assert.equal(r.container.querySelectorAll('.freshness').length, 9);
    assert.equal(r.container.querySelectorAll('.connection').length, 5);
    for (const name of ['Retry', 'Clear filters', 'Back to candidates']) click([...r.container.querySelectorAll('button')].find((b) => b.textContent === name) as HTMLElement);
  });
});
