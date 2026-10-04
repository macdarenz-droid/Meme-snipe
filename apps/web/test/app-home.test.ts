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
import { shellSession } from '../src/shell/Status.tsx';
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

  it('the shell reads the session from the worker, not the empty placeholder', () => {
    const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
    expect(app).toContain('const session = useShellSession(conn);');
    expect(app).not.toContain('sessionLabel(EMPTY_SESSION)');
    expect(app).toContain('state={session}');
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
    expect(rows[0]).toMatchObject({ ageSeconds: 7 * 60, volume24hUsd: null, holders: null, security: 'passed', dataAgeSeconds: 2 });
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
