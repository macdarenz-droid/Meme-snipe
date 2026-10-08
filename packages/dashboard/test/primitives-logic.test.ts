// UI-T04 pure logic: AmountInput parsing (acceptance 2 and the edge cases), the listbox moves, the toast queue, the
// keyboard labels and the Lucide icon audit.
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import * as lucide from 'lucide-react';
import { STATE_ICONS } from '../src/components/icon.ts';
import { isApplePlatform, keyLabel } from '../src/components/kbd.ts';
import { amountValue, formatStored, parseAmountInput, readBack, unitScale, type AmountSpec } from '../src/lib/amount.ts';
import { chooseValue, filterOptions, moveActive, openingIndex, type ListOption } from '../src/lib/listbox.ts';
import { MAX_TOASTS, TOAST_DURATION_MS, autoDismissMs, toastReducer, toastStack, type ToastItem } from '../src/lib/toasts.ts';

const SOL: AmountSpec = { unit: 'sol' };

describe('UI-T04 AmountInput parsing', () => {
  it('acceptance 2: 0.25 SOL is "250000000" lamports', () => {
    assert.deepEqual(parseAmountInput('0.25', SOL), { kind: 'valid', value: '250000000' });
  });
  it('edge: 10 decimals of SOL is invalid and never rounded', () => {
    assert.deepEqual(parseAmountInput('0.1234567891', SOL), { kind: 'invalid', message: 'SOL has at most 9 decimals' });
  });
  it('Z05 round 2 (red team M4): a SOL amount refuses commas outright: 0,250 and 1,500 never read as 250 or 1,500 SOL', () => {
    for (const bad of ['0,250', '1,500', '1,000.5', ' 12,345,678 ', '0,25', '1,00', ',5']) {
      assert.deepEqual(parseAmountInput(bad, SOL), { kind: 'invalid', message: 'Use a dot for decimals; no commas in SOL amounts' }, bad);
    }
  });
  it('Z05 round 3 (ruling 16): a token amount refuses commas too', () => {
    const TOKEN: AmountSpec = { unit: 'token', decimals: 2 };
    for (const bad of ['1,500', '1,000.5', '0,250']) {
      assert.deepEqual(parseAmountInput(bad, TOKEN), { kind: 'invalid', message: 'Use a dot for decimals; no commas in token amounts' }, bad);
    }
    assert.deepEqual(parseAmountInput('1500', TOKEN), { kind: 'valid', value: '150000' });
  });
  it('bps and percent accept thousands separators only as real groups that do not start with 0', () => {
    assert.deepEqual(parseAmountInput(' 12,345,678 ', { unit: 'bps' }), { kind: 'valid', value: '12345678' });
    assert.deepEqual(parseAmountInput('1,000.5', { unit: 'percent' }), { kind: 'valid', value: '100050' });
    for (const bad of ['0,250', '0,25', '1,00', '1,0000', ',5', '1,000,00']) assert.equal(parseAmountInput(bad, { unit: 'bps' }).kind, 'invalid', bad);
  });
  it('Z05 round 3 (ruling 12): bps and percent read back from the bigint, every digit kept', () => {
    const bps = parseAmountInput('99999999999999999', { unit: 'bps' });
    assert.deepEqual(bps, { kind: 'valid', value: '99999999999999999' });
    assert.equal(formatStored('99999999999999999', { unit: 'bps' }), '99,999,999,999,999,999 bps');
    const pct = parseAmountInput('999999999999999.99', { unit: 'percent' });
    assert.deepEqual(pct, { kind: 'valid', value: '99999999999999999' });
    assert.equal(formatStored('99999999999999999', { unit: 'percent' }), '999,999,999,999,999.99%');
    assert.equal(readBack(pct, { unit: 'percent' }), 'Reads as 999,999,999,999,999.99%');
    assert.equal(formatStored('5', { unit: 'percent' }), '0.05%');
    assert.equal(formatStored('35', { unit: 'bps' }), '35 bps');
    assert.equal(formatStored('1200', { unit: 'bps' }), '1,200 bps');
  });
  it('accepts .5, 1. and leading zeros; refuses signs, exponents, letters and a lone dot', () => {
    assert.deepEqual(parseAmountInput('.5', SOL), { kind: 'valid', value: '500000000' });
    assert.deepEqual(parseAmountInput('1.', SOL), { kind: 'valid', value: '1000000000' });
    assert.deepEqual(parseAmountInput('007', SOL), { kind: 'valid', value: '7000000000' });
    assert.deepEqual(parseAmountInput('', SOL), { kind: 'empty' });
    assert.deepEqual(parseAmountInput('   ', SOL), { kind: 'empty' });
    assert.deepEqual(parseAmountInput('-1', SOL), { kind: 'invalid', message: 'Enter an amount of zero or more' });
    for (const bad of ['1e3', 'abc', '.', '+1', '1.2.3']) assert.deepEqual(parseAmountInput(bad, SOL), { kind: 'invalid', message: 'Enter a number' }, bad);
    assert.deepEqual(parseAmountInput('18446744073.709551616', SOL), { kind: 'invalid', message: 'This amount is too large' });
    assert.deepEqual(parseAmountInput('18446744073.709551615', SOL), { kind: 'valid', value: '18446744073709551615' });
  });
  it('token, bps and percent units', () => {
    assert.deepEqual(parseAmountInput('1234.56789', { unit: 'token', decimals: 5 }), { kind: 'valid', value: '123456789' });
    assert.deepEqual(parseAmountInput('1.123456', { unit: 'token', decimals: 5 }), { kind: 'invalid', message: 'This amount has at most 5 decimals' });
    assert.deepEqual(parseAmountInput('7', { unit: 'token' }), { kind: 'valid', value: '7' });
    assert.deepEqual(parseAmountInput('35', { unit: 'bps' }), { kind: 'valid', value: '35' });
    assert.deepEqual(parseAmountInput('35.5', { unit: 'bps' }), { kind: 'invalid', message: 'Enter a whole number of basis points' });
    assert.deepEqual(parseAmountInput('2.5', { unit: 'percent' }), { kind: 'valid', value: '250' });
    assert.deepEqual(parseAmountInput('2.555', { unit: 'percent' }), { kind: 'invalid', message: 'This amount has at most 2 decimals' });
  });
  it('out of range shows the bounds; over the limit shows the limit', () => {
    assert.deepEqual(parseAmountInput('0.75', { unit: 'sol', min: '10000000', max: '500000000' }), { kind: 'out-of-range', value: '750000000', message: 'Enter between 0.01 SOL and 0.5 SOL' });
    assert.deepEqual(parseAmountInput('0.001', { unit: 'sol', min: '10000000' }), { kind: 'out-of-range', value: '1000000', message: 'Enter at least 0.01 SOL' });
    assert.deepEqual(parseAmountInput('1200', { unit: 'bps', max: '1000' }), { kind: 'out-of-range', value: '1200', message: 'Enter at most 1,000 bps' });
    assert.deepEqual(parseAmountInput('0.3', { unit: 'sol', limit: '250000000' }), { kind: 'exceeds-limit', value: '300000000', message: 'Above the limit of 0.25 SOL' });
    assert.deepEqual(parseAmountInput('0.25', { unit: 'sol', limit: '250000000', min: '0', max: '1000000000' }), { kind: 'valid', value: '250000000' });
  });
  it('formatStored, unitScale and amountValue', () => {
    assert.equal(formatStored('123456700', { unit: 'token', decimals: 5 }), '1,234.567');
    assert.equal(formatStored('1', { unit: 'token' }), '1');
    assert.equal(formatStored('250', { unit: 'percent' }), '2.50%');
    assert.deepEqual([unitScale(SOL), unitScale({ unit: 'token', decimals: 6 }), unitScale({ unit: 'bps' }), unitScale({ unit: 'percent' })], [9, 6, 0, 2]);
    assert.equal(amountValue({ kind: 'valid', value: '5' }), '5');
    // Z05 round 2 (red team M4): out-of-range and over-limit values are never handed on.
    assert.equal(amountValue({ kind: 'exceeds-limit', value: '5', message: '' }), null);
    assert.equal(amountValue({ kind: 'out-of-range', value: '5', message: '' }), null);
    assert.equal(amountValue({ kind: 'empty' }), null);
    assert.equal(amountValue({ kind: 'invalid', message: '' }), null);
  });
});

describe('UI-T04 listbox logic', () => {
  const options: ListOption[] = [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta', disabled: true }, { value: 'c', label: 'Gamma' }];
  it('filters by label, case-insensitive', () => {
    assert.deepEqual(filterOptions(options, ' AL').map((o) => o.value), ['a']);
    assert.deepEqual(filterOptions(options, '').length, 3);
    assert.deepEqual(filterOptions(options, 'zzz'), []);
  });
  it('moves without wrapping; disabled options are reachable', () => {
    assert.equal(moveActive(0, 'ArrowDown', 3), 1);
    assert.equal(moveActive(2, 'ArrowDown', 3), 2);
    assert.equal(moveActive(1, 'ArrowUp', 3), 0);
    assert.equal(moveActive(0, 'ArrowUp', 3), 0);
    assert.equal(moveActive(-1, 'ArrowUp', 3), 2);
    assert.equal(moveActive(1, 'Home', 3), 0);
    assert.equal(moveActive(0, 'End', 3), 2);
    assert.equal(moveActive(0, 'ArrowDown', 0), -1);
  });
  it('chooses (single replaces, multi toggles) and picks the opening option', () => {
    assert.deepEqual(chooseValue(['a'], 'c', false), ['c']);
    assert.deepEqual(chooseValue(['a'], 'c', true), ['a', 'c']);
    assert.deepEqual(chooseValue(['a', 'c'], 'a', true), ['c']);
    assert.equal(openingIndex(options, ['c'], false), 2);
    assert.equal(openingIndex(options, [], false), 0);
    assert.equal(openingIndex(options, [], true), 2);
    assert.equal(openingIndex([], [], false), -1);
  });
});

describe('UI-T04 toast queue', () => {
  const add = (state: ToastItem[], id: string, tone: ToastItem['tone'] = 'info'): ToastItem[] => toastReducer(state, { type: 'add', toast: { id, tone, title: id } });
  it('moves through entering, visible, paused and exiting, then is removed', () => {
    let s = add([], 'a');
    assert.equal(s[0]?.phase, 'entering');
    s = toastReducer(s, { type: 'shown', id: 'a' });
    assert.equal(s[0]?.phase, 'visible');
    s = toastReducer(s, { type: 'pause', id: 'a' });
    assert.equal(s[0]?.paused, true);
    s = toastReducer(s, { type: 'resume', id: 'a' });
    assert.equal(s[0]?.paused, false);
    s = toastReducer(s, { type: 'dismiss', id: 'a' });
    assert.equal(s[0]?.phase, 'exiting');
    assert.equal(toastReducer(s, { type: 'shown', id: 'a' })[0]?.phase, 'exiting', 'shown only moves an entering toast');
    assert.deepEqual(toastReducer(s, { type: 'remove', id: 'a' }), []);
  });
  it('a repeated id replaces the toast; beyond the maximum the oldest non-danger toast exits', () => {
    let s: ToastItem[] = [];
    s = add(s, 'd', 'danger');
    for (const id of ['a', 'b', 'c']) s = add(s, id);
    assert.equal(s.filter((t) => t.phase !== 'exiting').length, MAX_TOASTS);
    s = add(s, 'e');
    assert.deepEqual(s.filter((t) => t.phase === 'exiting').map((t) => t.id), ['a']);
    s = add(s, 'e');
    assert.equal(s.filter((t) => t.id === 'e').length, 1);
  });
  it('twelve danger toasts: all stay, the newest four show and eight wait behind "8 more" (review M2)', () => {
    let s: ToastItem[] = [];
    for (let i = 1; i <= 12; i++) s = add(s, `d${i}`, 'danger');
    assert.equal(s.filter((t) => t.phase !== 'exiting').length, 12, 'danger toasts stay until dismissed');
    const collapsed = toastStack(s, false);
    assert.deepEqual(collapsed.shown.map((t) => t.id), ['d9', 'd10', 'd11', 'd12']);
    assert.equal(collapsed.more, 8);
    assert.equal(collapsed.shown.length, MAX_TOASTS);
    const expanded = toastStack(s, true);
    assert.equal(expanded.shown.length, 12);
    assert.equal(expanded.more, 8);
    // An exiting toast keeps rendering until it is removed, beside the newest four; the one behind it moves up.
    s = toastReducer(s, { type: 'dismiss', id: 'd12' });
    assert.deepEqual(toastStack(s, false).shown.map((t) => t.id), ['d8', 'd9', 'd10', 'd11', 'd12']);
    assert.equal(toastStack(s, false).more, 7);
    // Within the maximum nothing waits.
    assert.deepEqual(toastStack(add([], 'a'), false), { shown: add([], 'a'), more: 0 });
  });
  it('only an announced toast is marked hidden; a toast never announced is not (red-team 3 RT3-1)', () => {
    let s = add(add([], 'a', 'danger'), 'b', 'danger');
    s = toastReducer(s, { type: 'hidden', id: 'a' });
    assert.equal(s[0]?.hiddenOnce, undefined, 'never announced: it is announced when it first shows');
    s = toastReducer(s, { type: 'announced', id: 'a' });
    s = toastReducer(s, { type: 'hidden', id: 'a' });
    assert.deepEqual(s.map((t) => [t.id, t.announced === true, t.hiddenOnce === true]), [['a', true, true], ['b', false, false]]);
  });

  it('danger toasts stay until dismissed; others leave after 5 s', () => {
    assert.equal(autoDismissMs('danger'), null);
    assert.equal(autoDismissMs('warning'), TOAST_DURATION_MS);
    assert.equal(TOAST_DURATION_MS, 5000);
  });
});

describe('UI-T04 keys and icons', () => {
  it('Mod is ⌘ on Apple platforms and Ctrl elsewhere', () => {
    assert.equal(isApplePlatform({ platform: 'MacIntel' }), true);
    assert.equal(isApplePlatform({ userAgentData: { platform: 'macOS' }, platform: 'Win32' }), true);
    assert.equal(isApplePlatform({ platform: 'iPhone' }), true);
    assert.equal(isApplePlatform({ platform: 'Linux x86_64' }), false);
    assert.equal(isApplePlatform({}), false);
    assert.equal(isApplePlatform(undefined), false);
    assert.deepEqual(['Mod', 'Alt', 'Shift', 'K'].map((k) => keyLabel(k, true)), ['⌘', '⌥', '⇧', 'K']);
    assert.deepEqual(['Mod', 'Alt', 'K'].map((k) => keyLabel(k, false)), ['Ctrl', 'Alt', 'K']);
  });
  it('icon audit: every DS reserved state icon exists in lucide-react 1.47.0', () => {
    const reserved = { profit: 'TrendingUp', loss: 'TrendingDown', warning: 'TriangleAlert', danger: 'OctagonAlert', halt: 'OctagonX', paper: 'FlaskConical',
      live: 'Radio', offline: 'History', stale: 'ClockAlert', disconnected: 'Unplug', 'step-up': 'LockKeyhole' };
    const exports = lucide as unknown as Record<string, unknown>;
    for (const [state, name] of Object.entries(reserved)) {
      assert.ok(exports[name] !== undefined, `${name} exists`);
      assert.equal(STATE_ICONS[state], exports[name], state);
    }
    assert.equal(Object.keys(STATE_ICONS).length, 11);
  });
});
