// RC-FIXES: the start's state check (state-check.ts) and the whole account.json check (account.ts `checkAccount`).
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkState, ledgerLost, ledgerPresent } from '../src/run/state-check.ts';
import { checkAccount } from '../src/run/account.ts';
import { typedText } from '../src/run/json.ts';
import { NO_CONTROL, controlFile } from '../src/run/state.ts';
import { StateRefused } from '../src/run/worker.ts';
import { makeWorker } from './worker-harness.ts';
import { EXIT } from '../../runner/src/contract.ts';

const dir = (files: Record<string, string> = {}): string => {
  const d = mkdtempSync(join(tmpdir(), 'state-check-'));
  for (const [k, v] of Object.entries(files)) writeFileSync(join(d, k), v);
  return d;
};
const TRADED_ACCOUNT = typedText({ openedAtMs: 1, openingEquity: 20_000_000n, walletLamports: 1n, trades: [{}], entries: [] });

describe('RC-FIXES: a lost ledger is never a cold start', () => {
  it('no ledger and no other state: a cold start', () => {
    expect(ledgerLost(dir(), 'ledger.sqlite')).toBeNull();
    expect(ledgerLost(dir({ 'account.json': typedText({ trades: [], entries: [] }), 'credits.json': '{}' }), 'ledger.sqlite')).toBeNull();
  });

  it.each([
    ['missing', {}],
    ['empty (0 bytes: SQLite would open it as a new ledger)', { 'ledger.sqlite': '' }],
  ])('a ledger %s while account.json holds a trade: refused', (_, extra) => {
    const d = dir({ ...extra, 'account.json': TRADED_ACCOUNT });
    expect(ledgerPresent(d, 'ledger.sqlite')).toBe(false);
    expect(ledgerLost(d, 'ledger.sqlite')).toMatch(/^ledger\.sqlite is (missing|empty) but account\.json holds 1 trades/);
  });

  it('paper attempts or exit plans alone are trade evidence too, and an unreadable file counts as evidence', () => {
    expect(ledgerLost(dir({ 'paper.json': typedText({ attempts: { s: {} } }) }), 'ledger.sqlite')).toContain('paper.json holds 1 paper attempts');
    expect(ledgerLost(dir({ 'exits.json': typedText({ p: {} }) }), 'ledger.sqlite')).toContain('exits.json holds 1 exit plans');
    expect(ledgerLost(dir({ 'account.json': '{"cut' }), 'ledger.sqlite')).toContain('account.json unreadable');
  });
});

describe('RC-FIXES: a ledger with trades needs its files', () => {
  const traded = { existed: true, traded: true, positions: 1, fills: ['sigA', 'sigB'] };
  it('everything there: no refusal, nothing lost', () => {
    const d = dir({ 'account.json': TRADED_ACCOUNT, 'paper.json': typedText({ attempts: { sigA: {}, sigB: {}, sigC: {} } }), 'control.json': '{}' });
    expect(checkState(d, traded)).toEqual({ refuse: [], controlLost: false });
  });

  it('account.json missing, paper.json missing or short of a ledger attempt: refused', () => {
    expect(checkState(dir({ 'paper.json': typedText({ attempts: { sigA: {}, sigB: {} } }), 'control.json': '{}' }), traded).refuse).toEqual([expect.stringContaining('account.json is missing')]);
    expect(checkState(dir({ 'account.json': TRADED_ACCOUNT, 'control.json': '{}' }), traded).refuse).toEqual([expect.stringContaining('paper.json is missing while the ledger holds fills')]);
    expect(checkState(dir({ 'account.json': TRADED_ACCOUNT, 'paper.json': typedText({ attempts: { sigA: {} } }), 'control.json': '{}' }), traded).refuse).toEqual([expect.stringContaining('lacks 1 of the ledger\'s 2 filled attempts')]);
  });

  it('control.json missing after a start of this code (the marker): latched and paused, not refused; at a cold start: nothing', () => {
    const marked = { 'state-version.json': '{"version":1}' };
    expect(checkState(dir({ ...marked, 'account.json': TRADED_ACCOUNT, 'paper.json': typedText({ attempts: { sigA: {}, sigB: {} } }) }), traded)).toEqual({ refuse: [], controlLost: true });
    expect(checkState(dir(marked), { existed: true, traded: false, positions: 0, fills: [] })).toEqual({ refuse: [], controlLost: true });
    expect(checkState(dir(marked), { existed: false, traded: false, positions: 0, fills: [] })).toEqual({ refuse: [], controlLost: false });
  });

  it('R4-1: before the marker (a dir from a release that wrote control.json only on a trip or a pause), a missing control.json was never written', () => {
    expect(checkState(dir({ 'account.json': TRADED_ACCOUNT, 'paper.json': typedText({ attempts: { sigA: {}, sigB: {} } }) }), traded)).toEqual({ refuse: [], controlLost: false });
    expect(checkState(dir(), { existed: true, traded: false, positions: 0, fills: [] })).toEqual({ refuse: [], controlLost: false });
  });

  it('an empty ledger while paper attempts or exit plans say the bot traded: refused (an older ledger restored with newer files)', () => {
    const empty = { existed: true, traded: false, positions: 0, fills: [] };
    expect(checkState(dir({ 'paper.json': typedText({ attempts: { s: {} } }), 'control.json': '{}' }), empty).refuse).toEqual([expect.stringContaining('the ledger holds no trades but paper.json holds 1 paper attempts')]);
    expect(checkState(dir({ 'exits.json': typedText({ p: {} }), 'control.json': '{}' }), empty).refuse).toEqual([expect.stringContaining('exits.json holds 1 exit plans')]);
  });

  it('an open trade in account.json with no position in the ledger: refused; closed trades alone are not', () => {
    const acct = (closedAtMs: number | null) => typedText({ openedAtMs: 1, openingEquity: 20_000_000n, walletLamports: 1n, trades: [{ positionId: 'p', closedAtMs }], entries: [] });
    const flat = { existed: true, traded: false, positions: 0, fills: [] };
    expect(checkState(dir({ 'account.json': acct(null), 'control.json': '{}' }), flat).refuse).toEqual([expect.stringContaining('account.json holds 1 open trades but the ledger holds no position')]);
    expect(checkState(dir({ 'account.json': acct(5), 'control.json': '{}' }), flat).refuse).toEqual([]);
    expect(checkState(dir({ 'account.json': acct(null), 'control.json': '{}', 'paper.json': typedText({ attempts: { sigA: {}, sigB: {} } }) }), { existed: true, traded: true, positions: 1, fills: [] }).refuse).toEqual([]);
  });

  it('an attempt signed but never sent (in the ledger, not in paper.json) is no loss: only fills are asked for', () => {
    const d = dir({ 'account.json': TRADED_ACCOUNT, 'paper.json': typedText({ attempts: {} }), 'control.json': '{}' });
    expect(checkState(d, { existed: true, traded: true, positions: 1, fills: [] })).toEqual({ refuse: [], controlLost: false });
  });
});

describe('RC-FIXES: account.json is checked whole', () => {
  const trade = { positionId: 'p', mint: 'm', openedAtMs: 5, notional: 1n, booked: -3n, stoppedOut: false, closedAtMs: null, netLamports: null, netPnl: null };
  const ok = {
    openedAtMs: 1, openingEquity: 20_000_000n, walletLamports: 100n, trades: [trade], entries: [{ mint: 'm', atMs: 4 }], oneTimePaid: true,
    setup: { atMs: 1, lamports: 10n, cost: 2n }, navPeak: { atMs: 3, nav: 5n }, dayMark: { startMs: 0, atMs: 2, equity: 7n }, weekMark: { startMs: 0, atMs: 2, equity: 7n },
    counts: { trades: 1, entries: 1 }, present: ['walletLamports', 'oneTimePaid', 'setup', 'navPeak', 'dayMark', 'weekMark'],
  };
  it('a file from before (no counts, no list of what it held) is checked by type and range only', () => {
    const { counts: _c, present: _p, navPeak: _n, dayMark: _d, ...old } = ok;
    expect(checkAccount(old)).not.toBeNull();
  });

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
    ['the NAV peak it held is gone', { navPeak: undefined }],
    ['the day mark it held is gone', { dayMark: undefined }],
    ['the week mark it held is gone', { weekMark: undefined }],
    ['the setup it held is gone', { setup: undefined, oneTimePaid: undefined }],
    ['the wallet it held is gone', { walletLamports: null }],
  ])('refused: %s', (_, change) => {
    const v: Record<string, unknown> = { ...ok, ...change };
    for (const k of Object.keys(change)) if ((change as Record<string, unknown>)[k] === undefined) delete v[k];
    expect(checkAccount(v)).toBeNull();
  });
});

describe('RC-FIXES: the worker at start', () => {
  it('every start writes control.json; a later start without it latches the kill switch, pauses and alerts', async () => {
    const h = makeWorker();
    expect(await h.worker.reconcile()).toEqual({ ok: true });
    await h.worker.stop();
    expect(existsSync(join(h.stateDir, 'control.json'))).toBe(true);
    expect(controlFile(h.stateDir).read(NO_CONTROL).latches.killTrippedAtMs).toBeNull();
    rmSync(join(h.stateDir, 'control.json'));
    const h2 = makeWorker({ stateDir: h.stateDir, timers: h.timers });
    expect(await h2.worker.reconcile()).toEqual({ ok: true });
    await h2.worker.stop();
    const c = controlFile(h.stateDir).read(NO_CONTROL);
    expect(c.paused).toBe(true);
    expect(c.latches.killTrippedAtMs).not.toBeNull();
    expect(readFileSync(join(h.stateDir, 'journal.jsonl'), 'utf8')).toContain('"code":"state_lost"');
  });

  it('a lost ledger with trade evidence refuses the start before anything is written', () => {
    const h = makeWorker();
    const dir = h.stateDir;
    writeFileSync(join(dir, 'account.json'), TRADED_ACCOUNT);
    rmSync(join(dir, 'ledger.sqlite'), { force: true });
    writeFileSync(join(dir, 'ledger.sqlite'), '');
    rmSync(join(dir, 'cold_start'), { force: true });
    expect(() => makeWorker({ stateDir: dir, timers: h.timers })).toThrow(StateRefused);
    // Still empty: SQLite did not open it as a new ledger, so the next start refuses again.
    expect(readFileSync(join(dir, 'ledger.sqlite'), 'utf8')).toBe('');
    expect(existsSync(join(dir, 'cold_start'))).toBe(false);
    // R4-3: the reason is where it can be read: refused.json (with the exit code the unit does not restart) and the
    // journal (a start line of its own, a critical alert, a stop line).
    const refused = JSON.parse(readFileSync(join(dir, 'refused.json'), 'utf8')) as Record<string, unknown>;
    expect(Object.keys(refused).sort()).toEqual(['atMs', 'commit', 'reason']);
    expect(refused['reason']).toContain('ledger.sqlite is empty');
    expect(refused['atMs']).toBe(h.timers.now());
    expect(EXIT.stateRefused).toBe(78);
    const lines = readFileSync(join(dir, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    const tail = lines.slice(-3).map((l) => [l['kind'], l['code'] ?? l['refused'] ?? null]);
    expect(tail).toEqual([['start', true], ['alert', 'state_refused'], ['stop', null]]);
  });

  it('R4-3: the next start that is not refused removes refused.json', async () => {
    const h = makeWorker();
    writeFileSync(join(h.stateDir, 'refused.json'), '{"reason":"old"}\n');
    await h.worker.stop();
    const h2 = makeWorker({ stateDir: h.stateDir, timers: h.timers });
    expect(existsSync(join(h.stateDir, 'refused.json'))).toBe(false);
    await h2.worker.stop();
  });
});

describe('RC-STATE: a refused start is not restarted', () => {
  it('zeroed-worker.service names EXIT.stateRefused in RestartPreventExitStatus', () => {
    const unit = readFileSync(new URL('../../../ops/host/files/etc/systemd/system/zeroed-worker.service', import.meta.url), 'utf8');
    expect(unit).toMatch(new RegExp(`^RestartPreventExitStatus=${EXIT.stateRefused}$`, 'm'));
    expect(unit).toMatch(/^Restart=always$/m);
  });
});
