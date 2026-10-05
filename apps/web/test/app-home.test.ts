// APP-HOME: the shell's session line and Home's Discovered list come from the worker, never from placeholders. The
// owner's phone showed "Not started" and "Waiting for the data feed" while the paper worker ran.
import { readFileSync } from 'node:fs';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DiscoveredView, WorkerStatus } from '../src/api/contract.ts';
import { schemaFor } from '../src/api/schemas.ts';
import { settle, type Loaded } from '../src/api/useEndpoint.ts';
import { fixtureDiscovered } from '../src/dev/dashboardFixtures.ts';
import { shortAddress } from '../src/lib/format.ts';
import { DiscoveredBody, rowsOf } from '../src/screens/Home.tsx';
import { SessionCard } from '../src/screens/Snipe.tsx';
import { sessionView, shellSession } from '../src/shell/Status.tsx';
import { findBanned } from './banned-copy.ts';

const AT = '2026-10-04T11:30:00.000Z';
const NOW = Date.parse(AT);
const text = (s: string) => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const running: WorkerStatus = { mode: 'paper', connected: true, flags: [], risk: [], haltReasons: [] };
const ready = (data: WorkerStatus): Loaded<WorkerStatus> => settle('paper', schemaFor('status', 'paper'), { ok: true, value: { mode: 'paper', asOf: AT, data } }, NOW);
const online = { state: 'online' } as const;

describe('the shell session line', () => {
  it('a running paper worker reads Running; its pause and an ended policy session read as such', () => {
    expect(shellSession(ready(running), online)).toEqual({ label: 'Running', on: true });
    expect(shellSession(ready({ ...running, flags: ['paused'] }), online)).toEqual({ label: 'Paused', on: false });
    expect(shellSession(ready({ ...running, haltReasons: [{ mode: 'paper', code: 'session-ended', source: null }] }), online)).toEqual({ label: 'Ended', on: false });
    // Entries halted for another reason: the worker still runs.
    expect(shellSession(ready({ ...running, haltReasons: [{ mode: 'paper', code: 'feed-stale', source: 'helius' }] }), online).label).toBe('Running');
  });

  it('without a status it says why, never "Not started"', () => {
    const cases: [Loaded<WorkerStatus>, 'none' | 'online' | 'offline', string][] = [
      [{ state: 'loading' }, 'none', 'No server'],
      [{ state: 'loading' }, 'online', 'Connecting'],
      [{ state: 'error', reason: 'offline' }, 'offline', 'Offline'],
      [{ state: 'error', reason: 'bad-data' }, 'online', 'Unknown'],
      [{ state: 'not-running' }, 'online', 'Not running'],
    ];
    for (const [status, state, label] of cases) {
      const s = shellSession(status, { state });
      expect(s.label, label).toBe(label);
      expect(s.on).toBe(false);
      expect(findBanned(s.label)).toEqual([]);
    }
  });

  it('the shell and the Snipe screen read the session from the worker, not the empty placeholder', () => {
    const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
    expect(app).toContain('const paper = usePaperSession(conn);');
    expect(app).not.toMatch(/sessionLabel\(EMPTY_SESSION\)|session=\{EMPTY_SESSION\}|modeLabel\(EMPTY_SESSION\)/);
    expect(app).toContain('<StatusList session={paper.view} state={paper.line} conn={conn} />');
    expect(app).toContain('<Snipe session={paper.view} sessionState={paper.line.label} />');
  });
});

describe('Snipe: Session card', () => {
  const session = { state: 'running' as const, bankrollUsd: '20', entryUsd: '2', maxEntryUsd: '5', maxOpenPositions: 1, dailyLossLimitUsd: '1', weeklyLossLimitUsd: '3', sessionLossLimitUsd: null, startable: false };
  const card = (status: Loaded<WorkerStatus>, conn: { state: 'none' | 'online' | 'offline' } = online) =>
    text(renderToStaticMarkup(h(SessionCard, { session: sessionView(status), label: shellSession(status, conn).label })));

  it('a running paper worker: Running, the policy\'s real limits, and no start button', () => {
    const v = sessionView(ready({ ...running, session }));
    expect(v).toMatchObject({ state: 'running', bankrollUsd: 20, entryUsd: 2, maxEntryUsd: 5, maxOpenPositions: 1, dailyLossLimitUsd: 1, weeklyLossLimitUsd: 3, sessionLossLimitUsd: null, startable: false, workerConnected: true });
    const t = card(ready({ ...running, session }));
    expect(t).toContain('Session Running');
    expect(t).toContain('Bankroll $20.00');
    expect(t).toContain('Entry $2.00, max $5.00');
    expect(t).toContain('Open trade limit 1');
    expect(t).toContain('Daily loss $1.00');
    expect(t).toContain('Weekly loss $3.00');
    // A limit the policy does not have reads "None" (review N2).
    expect(t).toContain('Session loss None');
    expect(t).not.toContain('Not set');
    expect(t).not.toMatch(/Start paper session|Worker not connected|Not started/);
    expect(findBanned(t)).toEqual([]);
  });

  it('paused and ended read as such; the start button needs a worker that accepts a start and a start to send', () => {
    expect(card(ready({ ...running, flags: ['paused'], session: { ...session, state: 'paused' } }))).toContain('Session Paused');
    const ended = ready({ ...running, haltReasons: [{ mode: 'paper', code: 'session-ended', source: null }], session: { ...session, state: 'ended', startable: true } });
    expect(card(ended)).toContain('Session Ended');
    // Review N1: startable but no start handler, so no dead button.
    expect(card(ended)).not.toContain('Start paper session');
    const withStart = text(renderToStaticMarkup(h(SessionCard, { session: sessionView(ended), label: 'Ended', onStart: () => undefined })));
    expect(withStart).toContain('Start paper session');
    // A handler alone is not enough: the worker must accept a start, and a running session never shows it.
    const notStartable = ready({ ...running, session: { ...session, state: 'ended' } });
    expect(text(renderToStaticMarkup(h(SessionCard, { session: sessionView(notStartable), label: 'Ended', onStart: () => undefined })))).not.toContain('Start paper session');
    const runningStartable = ready({ ...running, session: { ...session, startable: true } });
    expect(text(renderToStaticMarkup(h(SessionCard, { session: sessionView(runningStartable), label: 'Running', onStart: () => undefined })))).not.toContain('Start paper session');
  });

  it('no status: the reason, values "Not set", and no start button', () => {
    for (const [status, conn, label] of [[{ state: 'loading' }, 'none', 'No server'], [{ state: 'error', reason: 'offline' }, 'offline', 'Offline'], [{ state: 'not-running' }, 'online', 'Not running']] as const) {
      const t = card(status as Loaded<WorkerStatus>, { state: conn });
      expect(t).toContain(`Session ${label}`);
      expect(t).toContain('Bankroll Not set');
      expect(t).not.toMatch(/Start paper session|Not started/);
    }
  });
});

describe('Home: Discovered', () => {
  const view = fixtureDiscovered('paper', NOW);
  const loaded = settle<DiscoveredView>('paper', schemaFor('discovered', 'paper'), { ok: true, value: { mode: 'paper', asOf: AT, data: view } }, NOW);
  const out = (l: Loaded<DiscoveredView>) => text(renderToStaticMarkup(h(DiscoveredBody, { loaded: l })));

  it('lists the worker\'s tokens with their count, ages from the answer and "—" for what it does not serve', () => {
    expect(loaded.state).toBe('ready');
    const t = out(loaded);
    expect(t).toContain(`${view.tokens.length} tokens`);
    for (const tok of view.tokens) expect(t).toContain(shortAddress(tok.mint));
    expect(t).toContain('FAKE1');
    expect(t).not.toMatch(/Waiting for the data feed|No tokens discovered|Not started/);
    const rows = rowsOf(view, AT);
    expect(rows[0]).toMatchObject({ ageSeconds: 7 * 60, security: 'passed', dataAgeSeconds: 2 });
    expect(rows[4]!.liquidityUsd).toBeNull();
    expect(rows[5]).toMatchObject({ symbol: null, dataAgeSeconds: null });
    expect(t).toContain('—');
    expect(findBanned(t)).toEqual([]);
  });

  it('none discovered yet: "No tokens discovered", with no claim about the feed', () => {
    const empty = settle<DiscoveredView>('paper', schemaFor('discovered', 'paper'), { ok: true, value: { mode: 'paper', asOf: AT, data: { mode: 'paper', tokens: [] } } }, NOW);
    const t = out(empty);
    expect(t).toContain('No tokens discovered');
    expect(t).not.toContain('Waiting for the data feed');
  });

  it('no answer: the offline state or "Not running", never the empty list', () => {
    expect(out({ state: 'error', reason: 'offline' })).toBe('Discovered Offline');
    expect(out({ state: 'not-running' })).toBe('Discovered Not running');
    expect(out({ state: 'loading' })).not.toContain('No tokens discovered');
  });

  it('the schema refuses a token in another mode or with float money', () => {
    const bad = (tok: object) => settle('paper', schemaFor('discovered', 'paper'), { ok: true, value: { mode: 'paper', asOf: AT, data: { mode: 'paper', tokens: [{ ...view.tokens[0], ...tok }] } } }, NOW);
    expect(bad({ mode: 'live' })).toMatchObject({ state: 'error' });
    expect(bad({ liquidityUsd: 1234.5 })).toMatchObject({ state: 'error', reason: 'bad-data' });
    expect(bad({ checks: 'ok' })).toMatchObject({ state: 'error', reason: 'bad-data' });
  });
});
