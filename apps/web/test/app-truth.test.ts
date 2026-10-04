// APP-TRUTH (owner, from the phone): every row reads as what it is. The Session card's R3 row is the open trade limit,
// not a count of open trades; and "Entries: Off" names the risk rule that stopped them, not just "risk limit".
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { WorkerStatus } from '../src/api/contract.ts';
import { statusRows } from '../src/dashboard/Sections.tsx';
import { HALT_LABEL, RISK_CODE_LABEL } from '../src/dashboard/labels.ts';
import { SessionCard } from '../src/screens/Snipe.tsx';
import { EMPTY_SESSION } from '../src/screens/types.ts';
import { findBanned } from './banned-copy.ts';

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

describe('the Session card names the limit as a limit', () => {
  it('maxOpenPositions reads "Open trade limit", never "Open positions" (it is R3\'s limit, not a count)', () => {
    const t = text(renderToStaticMarkup(h(SessionCard, { session: { ...EMPTY_SESSION, workerConnected: true, maxOpenPositions: 1 }, label: 'Running' })));
    expect(t).toContain('Open trade limit 1');
    expect(t).not.toContain('Open positions');
    // The same words as the halt it stops entries with.
    expect(HALT_LABEL['max-open-positions']).toBe('open trade limit');
  });
});

describe('a risk halt names its rule', () => {
  const status = (source: string | null): WorkerStatus => ({ mode: 'paper', connected: true, flags: [], risk: [], haltReasons: [{ mode: 'paper', code: 'risk', source }] });

  it('sol_price_unknown reads "SOL price unknown", not "risk limit"', () => {
    expect(statusRows(status('sol_price_unknown')).map((r) => `${r.label}: ${r.value}`)).toEqual(['Entries: Off: SOL price unknown']);
  });

  it.each([
    ['sol_price_stale', 'SOL price stale'],
    ['balance_unknown', 'balance unknown'],
    ['balance_stale', 'balance stale'],
    ['mark_unknown', 'position value unknown'],
    ['mark_stale', 'position value stale'],
    ['risk_fault', 'risk check failed'],
    ['ops_reserve', 'SOL reserve'],
    ['full_loss_kill_line', 'kill line room'],
  ])('%s reads "Entries: Off: %s"', (source, words) => {
    expect(statusRows(status(source)).map((r) => `${r.label}: ${r.value}`)).toEqual([`Entries: Off: ${words}`]);
  });

  it('a rule the app does not know, or none given, still reads "risk limit"', () => {
    expect(statusRows(status('something_new')).map((r) => r.value)).toEqual(['Off: risk limit']);
    expect(statusRows(status(null)).map((r) => r.value)).toEqual(['Off: risk limit']);
  });

  it('every risk rule has words, and none is flagged by the copy guard', () => {
    for (const code of ['sol_price_unknown', 'sol_price_stale', 'balance_unknown', 'balance_stale', 'mark_unknown', 'mark_stale', 'risk_fault']) expect(RISK_CODE_LABEL[code], code).toBeDefined();
    expect(findBanned(Object.values(RISK_CODE_LABEL).join(' '))).toEqual([]);
  });
});
