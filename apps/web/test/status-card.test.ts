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

  it('never claims entries are on or exits are ready: the worker does not serve that yet', () => {
    expect(rows([])).toEqual([]);
    expect(text(status([]))).toBe('No alerts');
    for (const f of STATUS_FLAGS) expect(text(status([f]))).not.toMatch(/\bOn\b|Ready/);
  });

  it('an unknown or missing field renders nothing', () => {
    expect(rows(['budget-halt', 'divergence', ''])).toEqual([]);
    expect(rows(['regime-off', 'something-new'])).toEqual(['Entries: Off: regime']);
    expect(statusRows({ mode: 'paper', connected: true, risk: [] } as unknown as WorkerStatus)).toEqual([]);
    expect(statusRows({ mode: 'paper', connected: true, flags: null, risk: [] } as unknown as WorkerStatus)).toEqual([]);
  });

  it('shows only "Worker not connected" when the worker is down, whatever its last flags', () => {
    expect(text(status(['paused', 'exit-blocked'], false))).toBe('Worker not connected');
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
