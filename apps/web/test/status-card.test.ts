// APP-3: the worker card on the dashboard. It shows why entries are off, the exit state and alerts, only from the
// status flags the worker serves; an unknown or missing field adds nothing.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { STATUS_FLAGS, type StatusFlag, type WorkerStatus } from '../src/api/contract.ts';
import { StatusCard, statusRows } from '../src/dashboard/Sections.tsx';
import { findBanned } from './banned-copy.ts';

const status = (flags: readonly string[], connected = true): WorkerStatus => ({ mode: 'paper', connected, flags: flags as StatusFlag[], risk: [] });
const text = (s: WorkerStatus) => renderToStaticMarkup(h(StatusCard, { status: s })).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const rows = (flags: readonly string[]) => statusRows(status(flags)).map((r) => `${r.label}: ${r.value}`);

describe('worker card', () => {
  it.each([
    ['paused', 'Entries: Off: paused'],
    ['stale-data', 'Entries: Off: stale data'],
    ['regime-off', 'Entries: Off: regime'],
    ['waiting-for-evidence', 'Entries: Off: no evidence'],
    ['no-eligible-candidate', 'Candidates: None yet'],
    ['exit-blocked', 'Exits: Blocked'],
    ['exit-pending', 'Exits: Pending'],
    ['unknown-tx-result', 'Alerts: Unknown transaction result'],
    ['low-fee-reserve', 'Alerts: Low fee reserve'],
    ['rate-limited', 'Alerts: Rate limited'],
  ] as const)('%s renders as "%s"', (flag, row) => {
    expect(rows([flag])).toEqual([row]);
    expect(text(status([flag]))).toBe(row.replace(': ', ' '));
  });

  it('covers every status flag the worker can serve', () => {
    for (const f of STATUS_FLAGS) expect(rows([f]), f).toHaveLength(1);
  });

  it('lists every entry stop in one row, a blocked exit over a pending one, and alerts together', () => {
    expect(rows([...STATUS_FLAGS])).toEqual([
      'Entries: Off: paused, stale data, regime, no evidence',
      'Candidates: None yet',
      'Exits: Blocked',
      'Alerts: Unknown transaction result, Low fee reserve, Rate limited',
    ]);
    expect(statusRows(status(['exit-blocked', 'unknown-tx-result'])).map((r) => r.alert)).toEqual([true, true]);
    expect(statusRows(status(['paused', 'exit-pending'])).map((r) => r.alert)).toEqual([false, false]);
  });

  it('never claims entries are on, exits are ready or no alerts: with no proven row it renders nothing', () => {
    expect(rows([])).toEqual([]);
    expect(renderToStaticMarkup(h(StatusCard, { status: status([]) }))).toBe('');
    expect(text(status(['budget-halt']))).not.toContain('No alerts');
    for (const f of STATUS_FLAGS) expect(text(status([f]))).not.toMatch(/\bOn\b|Ready/);
  });

  it('an unknown or missing field renders nothing', () => {
    expect(rows(['budget-halt', 'divergence', ''])).toEqual([]);
    expect(rows(['regime-off', 'something-new'])).toEqual(['Entries: Off: regime']);
    expect(statusRows({ mode: 'paper', connected: true, risk: [] } as unknown as WorkerStatus)).toEqual([]);
    expect(statusRows({ mode: 'paper', connected: true, flags: null, risk: [] } as unknown as WorkerStatus)).toEqual([]);
  });

  it('shows only "Feeds down" when the worker reports no feed connected, whatever its last flags', () => {
    expect(text(status(['paused', 'exit-blocked'], false))).toBe('Feeds down');
  });

  it('uses short labels with no flagged words', () => {
    expect(findBanned(text(status([...STATUS_FLAGS])))).toEqual([]);
  });
});

describe('dashboard', () => {
  it('the Worker section renders the worker card', () => {
    const src = readFileSync(fileURLToPath(new URL('../src/dashboard/Dashboard.tsx', import.meta.url)), 'utf8');
    expect(src).toMatch(/title="Worker"[^]*?<Load loaded=\{status\}[^]*?\{\(s\) => <StatusCard status=\{s\} \/>\}/);
  });
});

describe('worker card with the API-1 fields', () => {
  const at = '2026-10-04T01:00:00.000Z';
  const halt = (code: string, source: string | null = null) => ({ mode: 'paper' as const, code, source }) as NonNullable<WorkerStatus['haltReasons']>[number];
  const reg = (state: 'on' | 'off', reasons: [string, string | null][] = [], current = true, waived: string[] = []): NonNullable<WorkerStatus['regime']> =>
    ({ state, at, current, reasons: reasons.map(([code, input]) => ({ mode: 'paper', code, input })), waived }) as NonNullable<WorkerStatus['regime']>;
  const alert = (code: string) => ({ mode: 'paper' as const, code, subject: 'p1', at }) as NonNullable<WorkerStatus['alerts']>[number];
  const with_ = (extra: Partial<WorkerStatus>, flags: readonly string[] = []) => statusRows({ ...status(flags), ...extra }).map((r) => `${r.label}: ${r.value}`);

  it.each([
    ['starting', 'starting'],
    ['feed-stale', 'stale data'],
    ['feed-disconnected', 'feed down'],
    ['feed-dropped', 'feed drill'],
    ['paused', 'paused'],
    ['seeding', 'seeding'],
    ['divergence', 'ledger mismatch'],
    ['budget', 'request budget'],
    ['daily-loss', 'daily loss'],
    ['weekly-loss', 'weekly loss'],
    ['weekly-review', 'weekly review'],
    ['kill-switch', 'kill switch'],
    ['wallet-below-kill-line', 'wallet below kill line'],
    ['loss-cooldown', 'loss cooldown'],
    ['loss-day-pause', 'losses today'],
    ['loss-review', 'loss review'],
    ['session-ended', 'session ended'],
    ['max-open-positions', 'open trade limit'],
    ['risk', 'risk limit'],
    ['risk-unknown', 'risk unknown'],
  ])('halt %s reads "Entries: Off: %s"', (code, why) => {
    expect(with_({ haltReasons: [halt(code)] })).toEqual([`Entries: Off: ${why}`]);
  });

  it('a halt reason the app does not name still proves entries are off, without a reason', () => {
    expect(with_({ haltReasons: [halt('other')] })).toEqual(['Entries: Off']);
    expect(with_({ haltReasons: [halt('something-new')] })).toEqual(['Entries: Off']);
  });

  it('joins flag and halt reasons once each', () => {
    expect(with_({ haltReasons: [halt('paused'), halt('feed-stale', 'helius'), halt('feed-stale', 'pumpportal'), halt('seeding')] }, ['paused', 'stale-data'])).toEqual(['Entries: Off: paused, stale data, seeding']);
  });

  it('"Entries: On" only with no halt reason, the regime on and no stopping flag', () => {
    expect(with_({ haltReasons: [], regime: reg('on') })).toEqual(['Entries: On', 'Regime: On']);
    expect(with_({ haltReasons: [], regime: reg('off', [['regime-off', null]]) })).toEqual(['Regime: Off: checks failed']);
    expect(with_({ haltReasons: [] })).toEqual([]);
    expect(with_({ haltReasons: [], regime: null })).toEqual([]);
    expect(with_({ regime: reg('on') })).toEqual(['Regime: On']);
    expect(with_({ haltReasons: [], regime: reg('on') }, ['waiting-for-evidence'])).toEqual(['Entries: Off: no evidence', 'Regime: On']);
  });

  it.each(['daily-loss', 'weekly-loss', 'weekly-review', 'kill-switch', 'loss-cooldown', 'loss-day-pause', 'loss-review', 'session-ended', 'risk-unknown'])(
    'a risk stop (%s) with the regime on and current is never "Entries: On"',
    (code) => {
      const r = with_({ haltReasons: [halt(code)], regime: reg('on') });
      expect(r).not.toContain('Entries: On');
      expect(r[0]).toMatch(/^Entries: Off: /);
    },
  );

  it('with the S0 diagnostic set waiving regime parts, the card never shows a plain "On"', () => {
    expect(with_({ haltReasons: [], regime: reg('on', [], true, ['regime-volume']) })).toEqual(['Entries: On (practice)', 'Regime: On (practice: volume not judged)']);
    expect(with_({ haltReasons: [], regime: reg('on', [], true, ['regime-volume', 'regime-survival', 'exec-health']) })).toEqual(['Entries: On (practice)', 'Regime: On (practice: volume, survival, execution health not judged)']);
    // No waived list served: neither plain On.
    const r = with_({ haltReasons: [], regime: { state: 'on', at, current: true, reasons: [] } as unknown as NonNullable<WorkerStatus['regime']> });
    expect(r).not.toContain('Entries: On');
    expect(r).not.toContain('Regime: On');
    expect(findBanned(with_({ haltReasons: [], regime: reg('on', [], true, ['regime-volume']) }).join(' '))).toEqual([]);
  });

  it('a regime evaluation that is not current never shows "Entries: On" or "Regime: On"', () => {
    expect(with_({ haltReasons: [], regime: reg('on', [], false) })).toEqual(['Regime: Not checked lately']);
    expect(with_({ haltReasons: [], regime: reg('off', [['regime-off', null]], false) })).toEqual(['Regime: Not checked lately']);
    expect(with_({ haltReasons: [], regime: { state: 'on', at, reasons: [] } as unknown as NonNullable<WorkerStatus['regime']> })).not.toContain('Entries: On');
  });

  it.each([
    [[['unknown', 'curve-volume']], 'Regime: Off: volume unknown'],
    [[['unknown', 'sol-usd']], 'Regime: Off: SOL price unknown'],
    [[['unknown', 'graduates']], 'Regime: Off: graduates unknown'],
    [[['unknown', 'exec-health']], 'Regime: Off: execution health unknown'],
    [[['regime-off', null]], 'Regime: Off: checks failed'],
    [[['exec-health', 'exec-health']], 'Regime: Off: execution health'],
    [[['policy-session-ended', null]], 'Regime: Off: session ended'],
    [[['unknown', 'curve-volume'], ['unknown', 'sol-usd']], 'Regime: Off: volume unknown, SOL price unknown'],
    [[['unknown', 'other-input']], 'Regime: Off'],
    [[['unknown', null]], 'Regime: Off'],
    [[], 'Regime: Off'],
  ] as [[string, string | null][], string][])('regime off %j reads "%s"', (reasons, row) => {
    expect(with_({ regime: reg('off', reasons) })).toEqual([row]);
  });

  it('a regime in a state the app does not know renders nothing', () => {
    expect(with_({ regime: { state: 'maybe', at, current: true, reasons: [] } as unknown as NonNullable<WorkerStatus['regime']> })).toEqual([]);
  });

  it('exits: ready, not ready, and a blocked or pending exit over either', () => {
    expect(with_({ exitCapable: true })).toEqual(['Exits: Ready']);
    expect(with_({ exitCapable: false })).toEqual(['Exits: Not ready']);
    expect(statusRows({ ...status([]), exitCapable: false })[0]!.alert).toBe(true);
    expect(with_({ exitCapable: true }, ['exit-blocked'])).toEqual(['Exits: Blocked']);
    expect(with_({ exitCapable: false }, ['exit-pending'])).toEqual(['Exits: Pending']);
  });

  it.each([
    ['cancel_after_broadcast', 'Cancel after send'],
    ['status_balance_mismatch', 'Balance mismatch'],
    ['late_landing', 'Late landing'],
    ['unbooked_landing', 'Unbooked landing'],
    ['double_fill', 'Double fill'],
    ['oversold', 'Oversold'],
    ['orphan_cleared', 'Orphan cleared'],
    ['exit_blocked', 'Exit blocked'],
    ['restart_recovery', 'Restart recovery'],
  ])('alert %s reads "%s"', (code, text) => {
    expect(with_({ alerts: [alert(code)] })).toEqual([`Alerts: ${text}`]);
  });

  it('alerts join the flag alerts once each; an unknown alert code adds nothing', () => {
    expect(with_({ alerts: [alert('double_fill'), alert('double_fill'), alert('nope')] }, ['rate-limited'])).toEqual(['Alerts: Rate limited, Double fill']);
    expect(with_({ alerts: [alert('nope')] })).toEqual([]);
    expect(with_({ alerts: [] })).toEqual([]);
  });

  it('a worker without the API-1 fields gets the APP-3 card, and malformed fields add nothing', () => {
    for (const f of STATUS_FLAGS) expect(with_({}, [f])).toEqual(rows([f]));
    expect(with_({ haltReasons: 'x', alerts: 3, regime: 'on', exitCapable: 'yes' } as unknown as Partial<WorkerStatus>)).toEqual([]);
  });

  it('every row of a full status uses short labels with no flagged words', () => {
    const s: WorkerStatus = { ...status([...STATUS_FLAGS]), haltReasons: [halt('starting'), halt('budget', 'helius'), halt('divergence')], exitCapable: false, alerts: ['cancel_after_broadcast', 'double_fill', 'restart_recovery'].map(alert), regime: reg('off', [['unknown', 'curve-volume'], ['regime-off', null]]) };
    expect(findBanned(text(s))).toEqual([]);
    expect(statusRows(s).map((r) => r.label)).toEqual(['Entries', 'Regime', 'Candidates', 'Exits', 'Alerts']);
  });
});

describe('status schema (API-1 fields optional, strict when present)', () => {
  it('accepts a status with and without the fields, and refuses a malformed one', async () => {
    const { schemaFor } = await import('../src/api/schemas.ts');
    const check = schemaFor('status', 'paper');
    const base = { mode: 'paper', connected: true, flags: [], risk: [] };
    expect(() => check(base, '$')).not.toThrow();
    const full = { ...base, haltReasons: [{ mode: 'paper', code: 'budget', source: 'helius' }], exitCapable: true, alerts: [{ mode: 'paper', code: 'oversold', subject: 'p1', at: '2026-10-04T01:00:00.000Z' }], regime: { state: 'off', at: '2026-10-04T01:00:00.000Z', current: true, reasons: [{ mode: 'paper', code: 'unknown', input: 'sol-usd' }], waived: [] } };
    expect(() => check(full, '$')).not.toThrow();
    expect(() => check({ ...full, regime: null }, '$')).not.toThrow();
    for (const bad of [
      { ...full, haltReasons: [{ mode: 'paper', code: 'nope', source: null }] },
      { ...full, haltReasons: [{ code: 'paused', source: null }] },
      { ...full, exitCapable: 'yes' },
      { ...full, alerts: [{ mode: 'paper', code: 'oversold', subject: 'p1', at: 'yesterday' }] },
      { ...full, regime: { state: 'maybe', at: full.regime.at, reasons: [] } },
      { ...full, regime: { ...full.regime, extra: 1 } },
      { ...full, regime: { state: 'on', at: full.regime.at, reasons: [] } },
      { ...full, regime: { ...full.regime, waived: ['nope'] } },
      { ...full, regime: { ...full.regime, waived: undefined } },
      { ...full, unknownField: 1 },
    ]) expect(() => check(bad, '$')).toThrow();
  });
});
