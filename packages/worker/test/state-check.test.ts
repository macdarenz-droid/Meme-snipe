// RC-FIXES: the start's state check (state-check.ts) and the whole account.json check (account.ts `checkAccount`).
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkState, ledgerLost, ledgerPresent } from '../src/run/state-check.ts';
import { checkAccount } from '../src/run/account.ts';
import { typedText } from '../src/run/json.ts';

const dir = (files: Record<string, string> = {}): string => {
  const d = mkdtempSync(join(tmpdir(), 'state-check-'));
  for (const [k, v] of Object.entries(files)) writeFileSync(join(d, k), v);
  return d;
};
const TRADED_ACCOUNT = typedText({ openedAtMs: 1, openingEquity: 20_000_000n, walletLamports: 1n, trades: [{}], entries: [] });

describe('RC-FIXES: a lost ledger is never a cold start', () => {
  it('no ledger and no other state: a cold start', () => {
    expect(ledgerLost(dir())).toBeNull();
    expect(ledgerLost(dir({ 'account.json': typedText({ trades: [], entries: [] }), 'credits.json': '{}' }))).toBeNull();
  });

  it.each([
    ['missing', {}],
    ['empty (0 bytes: SQLite would open it as a new ledger)', { 'ledger.sqlite': '' }],
  ])('a ledger %s while account.json holds a trade: refused', (_, extra) => {
    const d = dir({ ...extra, 'account.json': TRADED_ACCOUNT });
    expect(ledgerPresent(d)).toBe(false);
    expect(ledgerLost(d)).toMatch(/^ledger\.sqlite is (missing|empty) but account\.json holds 1 trades/);
  });

  it('paper attempts or exit plans alone are trade evidence too, and an unreadable file counts as evidence', () => {
    expect(ledgerLost(dir({ 'paper.json': typedText({ attempts: { s: {} } }) }))).toContain('paper.json holds 1 paper attempts');
    expect(ledgerLost(dir({ 'exits.json': typedText({ p: {} }) }))).toContain('exits.json holds 1 exit plans');
    expect(ledgerLost(dir({ 'account.json': '{"cut' }))).toContain('account.json unreadable');
  });
});

describe('RC-FIXES: a ledger with trades needs its files', () => {
  const traded = { existed: true, traded: true, attempts: ['sigA', 'sigB'] };
  it('everything there: no refusal, nothing lost', () => {
    const d = dir({ 'account.json': TRADED_ACCOUNT, 'paper.json': typedText({ attempts: { sigA: {}, sigB: {}, sigC: {} } }), 'control.json': '{}' });
    expect(checkState(d, traded)).toEqual({ refuse: [], controlLost: false });
  });

  it('account.json missing, paper.json missing or short of a ledger attempt: refused', () => {
    expect(checkState(dir({ 'paper.json': typedText({ attempts: { sigA: {}, sigB: {} } }), 'control.json': '{}' }), traded).refuse).toEqual([expect.stringContaining('account.json is missing')]);
    expect(checkState(dir({ 'account.json': TRADED_ACCOUNT, 'control.json': '{}' }), traded).refuse).toEqual([expect.stringContaining('paper.json is missing')]);
    expect(checkState(dir({ 'account.json': TRADED_ACCOUNT, 'paper.json': typedText({ attempts: { sigA: {} } }), 'control.json': '{}' }), traded).refuse).toEqual([expect.stringContaining('lacks 1 of the ledger\'s 2 attempts')]);
  });

  it('control.json missing after an earlier start (traded or not): latched and paused, not refused; at a cold start: nothing', () => {
    expect(checkState(dir({ 'account.json': TRADED_ACCOUNT, 'paper.json': typedText({ attempts: { sigA: {}, sigB: {} } }) }), traded)).toEqual({ refuse: [], controlLost: true });
    expect(checkState(dir(), { existed: true, traded: false, attempts: [] })).toEqual({ refuse: [], controlLost: true });
    expect(checkState(dir(), { existed: false, traded: false, attempts: [] })).toEqual({ refuse: [], controlLost: false });
  });

  it('an empty ledger while the files hold trades: refused (an older ledger restored with newer files)', () => {
    expect(checkState(dir({ 'account.json': TRADED_ACCOUNT, 'control.json': '{}' }), { existed: true, traded: false, attempts: [] }).refuse).toEqual([expect.stringContaining('the ledger holds no trades but account.json holds 1 trades')]);
  });
});

describe('RC-FIXES: account.json is checked whole', () => {
  const trade = { positionId: 'p', mint: 'm', openedAtMs: 5, notional: 1n, booked: -3n, stoppedOut: false, closedAtMs: null, netLamports: null, netPnl: null };
  const ok = {
    openedAtMs: 1, openingEquity: 20_000_000n, walletLamports: 100n, trades: [trade], entries: [{ mint: 'm', atMs: 4 }], oneTimePaid: true,
    setup: { atMs: 1, lamports: 10n, cost: 2n }, navPeak: { atMs: 3, nav: 5n }, dayMark: { startMs: 0, atMs: 2, equity: 7n }, weekMark: { startMs: 0, atMs: 2, equity: 7n },
    counts: { trades: 1, entries: 1 },
  };
  it('a whole file passes; a fresh one (no trades, no wallet yet) passes', () => {
    expect(checkAccount(ok)).not.toBeNull();
    expect(checkAccount({ openedAtMs: 1, openingEquity: 20_000_000n, walletLamports: null, trades: [], entries: [] })).not.toBeNull();
  });

  it.each([
    ['wallet negative', { walletLamports: -1n }],
    ['wallet past SOL\'s supply', { walletLamports: 10n ** 18n }],
    ['wallet not a bigint', { walletLamports: 'NaN' }],
    ['opening equity not positive', { openingEquity: 0n }],
    ['NAV peak not positive', { navPeak: { atMs: 3, nav: -5n } }],
    ['NAV peak not a bigint', { navPeak: { atMs: 3, nav: 'x' } }],
    ['opened time negative', { openedAtMs: -1 }],
    ['a trade booked as a string', { trades: [{ ...trade, booked: 'x' }] }],
    ['trades shorter than their count', { trades: [] }],
    ['entries shorter than their count', { entries: [] }],
    ['traded with no NAV peak', { navPeak: undefined }],
    ['traded with no day mark', { dayMark: undefined }],
    ['traded with no week mark', { weekMark: undefined }],
    ['traded with no setup', { setup: undefined, oneTimePaid: undefined }],
    ['traded with no wallet', { walletLamports: null }],
  ])('refused: %s', (_, change) => {
    const v: Record<string, unknown> = { ...ok, ...change };
    for (const k of Object.keys(change)) if ((change as Record<string, unknown>)[k] === undefined) delete v[k];
    expect(checkAccount(v)).toBeNull();
  });
});
