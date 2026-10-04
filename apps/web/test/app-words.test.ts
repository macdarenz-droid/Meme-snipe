// APP-WORDS part 2: the worker's codes reach the screen only as words a trader would write (a), the funnel's heading
// is a noun phrase (c), and the funding notices carry no explaining sentence (N1, N2).
import { readFileSync } from 'node:fs';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DecisionRecord } from '../src/api/contract.ts';
import { fixtureDecisions, fixtureFunnel, fixtureTrades } from '../src/dev/dashboardFixtures.ts';
import { RISK_CODE_LABEL, TRADE_REASON_LABEL, WORKER_CODE_LABEL } from '../src/dashboard/labels.ts';
import { DecisionDetail, decisionReasons, Funnel, headline } from '../src/dashboard/Sections.tsx';
import { TradeDetail, tradeReasons } from '../src/dashboard/Trades.tsx';
import { findBanned } from './banned-copy.ts';

const text = (s: string) => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
/** A code as the worker writes it: snake_case, kebab-case with a digit-free word, or a gate id with a code. */
const RAW = /\b[a-z]+_[a-z_]+\b|\bgate_reasons\b|\bs0_diagnostic\b|\{"gate"/;

describe('worker codes in words (a)', () => {
  it('a trade\'s reasons: the book\'s exit codes as exit labels, each once; unknown codes are left out', () => {
    const t = { ...fixtureTrades.paper[0]!, reasons: ['stop', 'max_hold', 'stop', 'take_profit', 'trailing_stop', 'thesis_lost', 'liquidity', 'emergency', 'new_code'] };
    expect(tradeReasons(t)).toEqual(['Price stop', 'Time stop', 'Take profit', 'Trailing stop', 'Thesis stop', 'Liquidity dropped', 'Emergency exit']);
    const out = text(renderToStaticMarkup(h(TradeDetail, { trade: t })));
    expect(out).toContain('Price stop');
    expect(out.match(RAW)?.[0] ?? null).toBeNull();
    expect(out).not.toContain('new_code');
  });

  it('a decision\'s reasons: the typed gate list, the practice parts and a paper fill, never a journal line', () => {
    const reasons = [
      'hard reject H3,H12: H3 freeze-authority set; H12 top10 41%',
      `gate_reasons ${JSON.stringify([
        { gate: 'H3', code: 'freeze-authority', detail: 'set' },
        { gate: 'H12', code: 'concentration', detail: 'top10 41%' },
        { gate: 'H16', code: 'missing', detail: 'pool' },
        { gate: 'R7', code: 'daily_loss', detail: 'x' },
        { gate: 'regime', code: 'unknown', detail: 'x' },
        { gate: 'worker', code: 'no-sol-price', detail: 'x' },
        { gate: 'stop', code: 'no-atr', detail: 'x' },
        { gate: 'R99', code: 'brand_new', detail: 'x' },
        { gate: 'H3', code: 'again', detail: 'x' },
      ])}`,
      's0_diagnostic regime-volume,exec-health,brand-new',
    ];
    expect(decisionReasons(reasons)).toEqual([
      'Freeze authority', 'Holder concentration', 'Stale or unknown data', 'Daily loss', 'Market regime unknown', 'SOL price unknown', 'Not enough price bars',
      'Practice: volume, execution health not judged',
    ]);
    expect(decisionReasons(['entry filled (paper)'])).toEqual(['Filled (paper)']);
    expect(decisionReasons(['gate_reasons {not json', 'risk R7 daily_loss: the costs of this trade would reach the daily loss trigger'])).toEqual([]);
    const d: DecisionRecord = { ...fixtureDecisions('paper').find((x) => x.outcome === 'rejected')!, checks: [], reasons };
    const out = text(renderToStaticMarkup(h(DecisionDetail, { decision: d })));
    expect(out).toContain('Freeze authority');
    expect(out.match(RAW)?.[0] ?? null).toBeNull();
    expect(out).not.toContain('hard reject');
  });

  it('an entry with no failed check is headed by its labelled reason', () => {
    const entered = fixtureDecisions('paper').find((x) => x.outcome === 'entered')!;
    expect(headline({ ...entered, checks: [] })).toBe('Filled (paper)');
    expect(headline({ ...entered, checks: [], reasons: ['enter', 'U1'] })).toBe('All checks passed');
  });

  it('every new label passes the copy guard; the sample trades and decisions show no raw code', () => {
    for (const v of [...Object.values(TRADE_REASON_LABEL), ...Object.values(RISK_CODE_LABEL), ...Object.values(WORKER_CODE_LABEL)]) {
      expect(findBanned(v), v).toEqual([]);
      expect(v).not.toMatch(RAW);
    }
    for (const t of fixtureTrades.paper) expect(tradeReasons(t).length, t.id).toBeGreaterThan(0);
    for (const d of fixtureDecisions('paper')) expect(text(renderToStaticMarkup(h(DecisionDetail, { decision: d }))).match(RAW)?.[0] ?? null).toBeNull();
  });
});

describe('copy (c, N1, N2)', () => {
  it('the funnel\'s rejections heading is a noun phrase', () => {
    const out = text(renderToStaticMarkup(h(Funnel, { funnel: fixtureFunnel('paper') })));
    expect(out).toContain('Rejections');
    expect(out).not.toContain('Rejected by');
  });

  it('the saved-wallet notices state the change and its time, with no sentence explaining the rule', () => {
    const src = readFileSync(new URL('../src/funding/WithdrawPanel.tsx', import.meta.url), 'utf8');
    expect(src).toContain('A new address takes effect 24 hours after you confirm with your passkey.');
    expect(src).not.toContain('Until then');
  });
});
