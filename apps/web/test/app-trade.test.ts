// APP-TRADE: the open trade reads like a live trade (Price now, P&L, Return, Running) and closed trades show their
// Return. Return has one formula (lib/money.ts returnHundredths), exact, on the net; Running counts from the server's
// openedAt. Margin is not shown: the bot buys outright, so size is the whole amount at risk (DECISIONS APP-TRADE).
import { readFileSync } from 'node:fs';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PositionRecord } from '../src/api/contract.ts';
import { schemaFor } from '../src/api/schemas.ts';
import { settle } from '../src/api/useEndpoint.ts';
import { fixturePosition, fixtureTrades } from '../src/dev/dashboardFixtures.ts';
import { OpenPosition, RUNNING_TICK_MS, markStale, runningSeconds } from '../src/dashboard/Sections.tsx';
import { TradeDetail, TradeTable } from '../src/dashboard/Trades.tsx';
import { formatPrice4, formatReturn, returnHundredths, toneOfReturn } from '../src/lib/money.ts';
import { TokenTable } from '../src/screens/Home.tsx';
import { TokenActions, copyClick, copyText, pumpFunUrl, stopRow } from '../src/components/TokenActions.tsx';
import { fixtureDecisions } from '../src/dev/dashboardFixtures.ts';
import { DecisionDetail, Journal } from '../src/dashboard/Sections.tsx';
import { findBanned } from './banned-copy.ts';

const text = (s: string) => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const OPENED = '2026-10-04T13:00:00.000Z';
const NOW = Date.parse(OPENED) + 3_725_000; // 1h 2m 5s later
const base: PositionRecord = { ...fixturePosition, openedAt: OPENED, sizeUsd: '2', unrealizedUsd: '0.31', costsSoFarUsd: '0.012', pnlUsd: '0.298', markPriceUsd: '0.0000123456', markedAt: new Date(NOW - 4_000).toISOString() };
const card = (p: PositionRecord, now = NOW) => renderToStaticMarkup(h(OpenPosition, { position: p, now }));
/** The value cell after a row's label. */
const cell = (html: string, label: string) => {
  const m = new RegExp(`<dt>${label.replace(/[&]/g, '&amp;')}</dt><dd(?: class="([^"]*)")?>(.*?)</dd>`).exec(html);
  return m === null ? null : { cls: (m[1] ?? '').trim(), text: text(m[2]!) };
};

describe('Return, exact (one formula for open and closed trades)', () => {
  it('net ÷ size in hundredths of a percent: gain, loss, zero, tiny and big sizes, rounding half away from zero', () => {
    expect(returnHundredths('0.298', '2')).toBe(1490n);
    expect(returnHundredths('-0.5', '2')).toBe(-2500n);
    expect(returnHundredths('0', '2')).toBe(0n);
    expect(returnHundredths('0.000001', '0.000003')).toBe(3333n); // 33.333…% at micro-dollar sizes
    expect(returnHundredths('0.000001', '0.000008')).toBe(1250n); // 12.5% exactly
    expect(returnHundredths('0.000049', '1')).toBe(0n); // 0.0049% → 0.00%
    expect(returnHundredths('0.00005', '1')).toBe(1n); // 0.005% → 0.01%, half away from zero
    expect(returnHundredths('-0.00005', '1')).toBe(-1n);
    expect(returnHundredths('123456789.123456', '987654321.654321')).toBe(1250n); // 12.4999…% → 12.50%
    expect(returnHundredths('12345678901234.5', '12345678901234.5')).toBe(10000n);
    expect(returnHundredths('1', '0')).toBeNull();
  });

  it('reads signed with 2 places and a true minus; tone follows the printed value', () => {
    expect(formatReturn(1490n)).toBe('+14.90%');
    expect(formatReturn(-2500n)).toBe('−25.00%');
    expect(formatReturn(-1n)).toBe('−0.01%');
    expect(formatReturn(0n)).toBe('0.00%');
    expect(formatReturn(null)).toBe('—');
    expect([toneOfReturn(1n), toneOfReturn(-1n), toneOfReturn(0n), toneOfReturn(null)]).toEqual(['gain', 'loss', '', '']);
  });
});

describe('the open trade card (APP-TRADE 1)', () => {
  it('Price now in the triggers\' format with its age; P&L net of costs; Return on the net; Running from openedAt', () => {
    const html = card(base);
    expect(cell(html, 'Price now')).toEqual({ cls: 'num', text: '$0.00001235 4s ago' });
    expect(cell(html, 'P&L')).toEqual({ cls: 'num gain', text: '+$0.30' });
    expect(cell(html, 'Return')).toEqual({ cls: 'num gain', text: '+14.90%' });
    expect(cell(html, 'Running')).toEqual({ cls: 'num', text: '1h 2m' });
    // The existing rows stay.
    for (const k of ['Token', 'Venue', 'Opened', 'Entry price', 'Size', 'Liquidation value', 'Unrealized', 'Costs so far', 'Worker']) expect(cell(html, k), k).not.toBeNull();
    expect(findBanned(text(html))).toEqual([]);
  });

  it('Return is on the P&L (net), not on Unrealized (gross)', () => {
    // Gross is a gain, the costs make it a loss: Return follows the loss.
    const html = card({ ...base, unrealizedUsd: '0.01', costsSoFarUsd: '0.03', pnlUsd: '-0.02' });
    expect(cell(html, 'Return')).toEqual({ cls: 'num loss', text: '−1.00%' });
    expect(cell(html, 'P&L')).toEqual({ cls: 'num loss', text: '−$0.02' });
  });

  it('Running counts from the server\'s openedAt and ticks every second', () => {
    expect(runningSeconds(OPENED, Date.parse(OPENED) + 59_999)).toBe(59);
    expect(runningSeconds(OPENED, Date.parse(OPENED) - 5_000)).toBe(0);
    expect(cell(card(base, Date.parse(OPENED) + 42_000), 'Running')!.text).toBe('42s');
    expect(cell(card({ ...base, openedAt: '2026-10-04T12:00:00.000Z' }, Date.parse(OPENED) + 42_000), 'Running')!.text).toBe('1h 0m');
    // Not the mark's time: a fresh mark on an old trade still reads the trade's age.
    expect(cell(card({ ...base, markedAt: new Date(NOW).toISOString() }), 'Running')!.text).toBe('1h 2m');
    expect(RUNNING_TICK_MS).toBe(1_000);
  });

  it('a mark older than the stale rule (15 s) is styled stale; a fresh one is not', () => {
    expect(markStale(new Date(NOW - 15_000).toISOString(), NOW)).toBe(false);
    expect(markStale(new Date(NOW - 15_001).toISOString(), NOW)).toBe(true);
    const html = card({ ...base, markedAt: new Date(NOW - 42_000).toISOString() });
    expect(html).toMatch(/<dt>Price now<\/dt><dd class="num"><span class="loss">\$0\.00001235<\/span> <span class="loss small">42s ago<\/span>/);
    expect(card(base)).toMatch(/<span class="">\$0\.00001235<\/span> <span class="muted small">4s ago<\/span>/);
  });

  it('an older worker (no mark, no P&L) still loads and shows "—"; no SOL price shows "—" too', () => {
    const { pnlUsd: _p, markPriceUsd: _m, markedAt: _a, ...older } = base;
    const loaded = settle('paper', schemaFor('position', 'paper'), { ok: true, value: { mode: 'paper', asOf: OPENED, data: older } }, Date.parse(OPENED));
    expect(loaded.state).toBe('ready');
    const html = card(older as PositionRecord);
    for (const k of ['Price now', 'P&L', 'Return']) expect(cell(html, k)!.text, k).toBe('—');
    const none = card({ ...base, pnlUsd: null, markPriceUsd: null, markedAt: null });
    for (const k of ['Price now', 'P&L', 'Return']) expect(cell(none, k)!.text, k).toBe('—');
    // The schema still refuses a float or a bad time in the new fields.
    for (const bad of [{ pnlUsd: 0.3 }, { markPriceUsd: 1e-5 }, { markedAt: 'now' }]) {
      expect(settle('paper', schemaFor('position', 'paper'), { ok: true, value: { mode: 'paper', asOf: OPENED, data: { ...base, ...bad } } }, Date.parse(OPENED))).toMatchObject({ state: 'error', reason: 'bad-data' });
    }
  });

  it('Price now is the triggers\' 4 significant digits', () => {
    expect(formatPrice4('0.0000123456')).toBe('$0.00001235');
    expect(formatPrice4('1.234567')).toBe('$1.235');
    expect(formatPrice4('1234.5')).toBe('$1235');
  });
});

describe('closed trades show their Return (APP-TRADE 2)', () => {
  const t = { ...fixtureTrades.paper[0]!, sizeUsd: '4', netUsd: '-0.37' };
  it('in the list, after Net, toned like Net', () => {
    const html = renderToStaticMarkup(h(TradeTable, { trades: [t] }));
    expect(text(html)).toMatch(/Net Return R/);
    expect(html).toContain('<td class="num loss">−9.25%</td>');
    const win = renderToStaticMarkup(h(TradeTable, { trades: [{ ...t, netUsd: '1' }] }));
    expect(win).toContain('<td class="num gain">+25.00%</td>');
  });

  it('in the detail, after Net', () => {
    const html = renderToStaticMarkup(h(TradeDetail, { trade: t }));
    expect(text(html)).toContain('Return −9.25%');
  });
});

describe('Home Discovered (APP-TRADE 5)', () => {
  it('has no column the worker never fills', () => {
    const html = renderToStaticMarkup(h(TokenTable, { rows: [] }));
    expect(html).not.toMatch(/Volume 24h|Holders/);
    const src = readFileSync(new URL('../src/screens/Home.tsx', import.meta.url), 'utf8');
    expect(src).not.toMatch(/volume24hUsd|holders|topHolderShare/);
  });
});

describe('copy address and open in Pump.fun (APP-TRADE 6)', () => {
  const MINT = 'So11111111111111111111111111111111111111112';
  afterEach(() => vi.unstubAllGlobals());

  it('the Pump.fun link is built only from a mint that passes the mint check; anything else gets no button', () => {
    expect(pumpFunUrl(MINT)).toBe(`https://pump.fun/coin/${MINT}`);
    for (const bad of ['', 'abc', `${MINT}0`, 'So1111111111111111111111111111111O', 'So11111111111111111111111111111111111111l12', `${MINT.slice(0, 40)}/x`, 'javascript:alert(1)', `https://evil.example/${MINT}`, ` ${MINT}`, 'x'.repeat(45)]) {
      expect(pumpFunUrl(bad), bad).toBeNull();
      expect(renderToStaticMarkup(h(TokenActions, { mint: bad })), bad).toBe('');
    }
    const html = renderToStaticMarkup(h(TokenActions, { mint: MINT }));
    expect(html).toContain(`href="https://pump.fun/coin/${MINT}"`);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('aria-label="Copy address"');
    expect(html).toContain('aria-label="Open in Pump.fun"');
    expect((html.match(/class="icon-button token-action"/g) ?? []).length).toBe(2);
  });

  it('copy writes the full mint, says "Copied" only on success and "Copy failed" otherwise, and never reaches the row', async () => {
    const wrote: string[] = [];
    const results: boolean[] = [];
    let stopped = 0;
    const ev = { stopPropagation: () => void stopped++ };
    await copyClick(MINT, async (t) => (wrote.push(t), true), (ok) => results.push(ok))(ev);
    await copyClick(MINT, async () => false, (ok) => results.push(ok))(ev);
    expect(wrote).toEqual([MINT]);
    expect(results).toEqual([true, false]);
    stopRow(ev);
    expect(stopped).toBe(3);
  });

  it('copyText: the Clipboard API, else the copy command; false when both fail', async () => {
    const written: string[] = [];
    vi.stubGlobal('navigator', { clipboard: { writeText: async (t: string) => void written.push(t) } });
    expect(await copyText(MINT)).toBe(true);
    expect(written).toEqual([MINT]);
    // Blocked API (a webview): the copy command on a hidden field with the full mint.
    vi.stubGlobal('navigator', { clipboard: { writeText: async () => { throw new Error('blocked'); } } });
    const fields: { value: string }[] = [];
    const doc = (ok: boolean) => ({
      createElement: () => { const f = { value: '', style: {}, setAttribute() {}, select() {}, remove() {} }; fields.push(f); return f; },
      body: { appendChild() {} },
      execCommand: (c: string) => c === 'copy' && ok,
    }) as unknown as Document;
    expect(await copyText(MINT, doc(true))).toBe(true);
    expect(fields.at(-1)!.value).toBe(MINT);
    expect(await copyText(MINT, doc(false))).toBe(false);
    vi.stubGlobal('navigator', {});
    expect(await copyText(MINT, { createElement: () => { throw new Error('no document'); } } as unknown as Document)).toBe(false);
  });

  it('every place a token shows has both buttons, outside any row button (no row-tap conflict)', () => {
    const mint = fixturePosition.mint;
    const places: [string, string][] = [
      ['open trade', card(base)],
      ['trades list', renderToStaticMarkup(h(TradeTable, { trades: [fixtureTrades.paper[0]!], onSelect: () => undefined }))],
      ['trade detail', renderToStaticMarkup(h(TradeDetail, { trade: fixtureTrades.paper[0]! }))],
      ['journal', renderToStaticMarkup(h(Journal, { decisions: fixtureDecisions('paper').slice(0, 1), onOpen: () => undefined }))],
      ['decision detail', renderToStaticMarkup(h(DecisionDetail, { decision: fixtureDecisions('paper')[0]! }))],
      ['home', renderToStaticMarkup(h(TokenTable, { rows: [{ mint, symbol: 'X', ageSeconds: 1, venue: 'PumpSwap', liquidityUsd: null, security: 'passed', promoted: false, dataAgeSeconds: null }] }))],
    ];
    for (const [where, html] of places) {
      expect(html, where).toContain('aria-label="Copy address"');
      expect(html, where).toContain('aria-label="Open in Pump.fun"');
      // No button or link inside another button: every token-actions block starts after any open row button closed.
      for (const at of [...html.matchAll(/<span class="token-actions">/g)].map((m) => m.index!)) {
        const before = html.slice(0, at);
        expect((before.match(/<button/g) ?? []).length, where).toBe((before.match(/<\/button>/g) ?? []).length);
      }
      expect(findBanned(text(html)), where).toEqual([]);
    }
  });
});
