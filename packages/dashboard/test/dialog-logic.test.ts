// UI-T07 logic: the typed-phrase matcher (C16, acceptance 1), mode naming and title prefixes (acceptance 3), countdown
// arithmetic (C44: server time, never below 0) and the DiffView states (C38).
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import type { Mode } from '@bot/types';
import { countdownState } from '../src/components/countdown.ts';
import { titlePrefix } from '../src/components/dialog.ts';
import { diffState } from '../src/components/diff-view.ts';
import { formatCountdown } from '../src/lib/money.ts';
import { checkPhrase, DIALOG_TITLE_PREFIX, MODE_NAME, modeChangedText, modeTone, remainingMs } from '../src/lib/safety.ts';

const PHRASE = 'LIVE-SMALL 0.25';

describe('UI-T07 checkPhrase (C16)', () => {
  it('acceptance 1: `live-small 0.25` against `LIVE-SMALL 0.25` is a case mismatch, never a match', () => {
    const c = checkPhrase('live-small 0.25', PHRASE);
    assert.equal(c.state, 'mismatch');
    assert.equal(c.hint, 'Letter case does not match. The phrase is case-sensitive.');
    assert.deepEqual(c.marks.map((m) => m.mark), [
      'case', 'case', 'case', 'case', 'match', 'case', 'case', 'case', 'case', 'case', 'match', 'match', 'match', 'match', 'match',
    ]);
    assert.equal(c.extra, 0);
  });

  it('matches exactly after trimming the surrounding whitespace only', () => {
    assert.equal(checkPhrase(PHRASE, PHRASE).state, 'match');
    assert.equal(checkPhrase(` \t${PHRASE}\n `, PHRASE).state, 'match');
    assert.equal(checkPhrase(PHRASE, PHRASE).hint, 'The phrase matches.');
    const inner = checkPhrase('LIVE-SMALL  0.25', PHRASE);
    assert.equal(inner.state, 'mismatch', 'inner whitespace is part of the phrase');
    assert.equal(inner.hint, 'Character 12 does not match.');
  });

  it('empty, partial, wrong and too long', () => {
    const empty = checkPhrase('   ', PHRASE);
    assert.equal(empty.state, 'empty');
    assert.equal(empty.hint, `Type ${PHRASE} to confirm.`);
    assert.ok(empty.marks.every((m) => m.mark === 'missing'));
    const partial = checkPhrase('LIVE-SM', PHRASE);
    assert.equal(partial.state, 'mismatch');
    assert.equal(partial.hint, '7 of 15 characters typed.');
    assert.equal(checkPhrase('LIVE-SMALL 0.30', PHRASE).hint, 'Character 14 does not match.');
    const long = checkPhrase(`${PHRASE}0`, PHRASE);
    assert.deepEqual([long.state, long.extra, long.hint], ['mismatch', 1, '1 character too many.']);
    assert.equal(checkPhrase(`${PHRASE}00`, PHRASE).hint, '2 characters too many.');
    assert.equal(checkPhrase('live-small 0.25x', PHRASE).hint, 'Letter case does not match. The phrase is case-sensitive.', 'case is reported first');
  });

  it('a wrong character is reported before a case difference, at its 1-based position', () => {
    assert.equal(checkPhrase('live-smXll 0.25', PHRASE).hint, 'Character 8 does not match.');
  });

  it('compares by code point, so a surrogate pair is one character', () => {
    const c = checkPhrase('A😀', 'A😀B');
    assert.deepEqual(c.marks.map((m) => m.mark), ['match', 'match', 'missing']);
    assert.equal(c.hint, '2 of 3 characters typed.');
  });
});

describe('UI-T07 mode treatment (acceptance 3)', () => {
  const modes: readonly Mode[] = ['backtest', 'replay', 'paper', 'live_small', 'live'];
  it('live-small and live are live; backtest and replay are offline', () => {
    assert.deepEqual(modes.map(modeTone), ['offline', 'offline', 'paper', 'live', 'live']);
    assert.deepEqual(modes.map((m) => titlePrefix(m, true)), ['Replay:', 'Replay:', 'Paper:', 'LIVE:', 'LIVE:']);
    assert.deepEqual(DIALOG_TITLE_PREFIX, { offline: 'Replay:', paper: 'Paper:', live: 'LIVE:' });
  });
  it('no prefix for a dialog that does not affect money, or while the mode is unknown', () => {
    assert.equal(titlePrefix('live', false), null);
    assert.equal(titlePrefix(null, true), null);
  });
  it('names each mode as the mode bar does', () => {
    assert.deepEqual(modes.map((m) => MODE_NAME[m]), ['BACKTEST', 'REPLAY', 'PAPER', 'LIVE-SMALL', 'LIVE']);
    assert.equal(modeChangedText('live_small'), 'Mode changed to LIVE-SMALL — review again');
  });
});

describe('UI-T07 countdown (C44)', () => {
  it('time left follows the server clock (local now + offset) and never goes below 0', () => {
    assert.equal(remainingMs(100_000, 58_000, 0), 42_000);
    assert.equal(remainingMs(100_000, 58_000, 2_000), 40_000, 'server 2 s ahead: 2 s less left');
    assert.equal(remainingMs(100_000, 58_000, -2_000), 44_000);
    assert.equal(remainingMs(100_000, 200_000, 0), 0);
  });
  it('formats whole seconds rounded up: 0:00 only when nothing is left', () => {
    const cases: ReadonlyArray<[number, string]> = [
      [42_000, '0:42'], [41_001, '0:42'], [999, '0:01'], [1, '0:01'], [0, '0:00'], [-5_000, '0:00'], [60_000, '1:00'], [61_000, '1:01'],
      [599_000, '9:59'], [3_600_000, '1:00:00'], [3_723_000, '1:02:03'],
    ];
    for (const [ms, text] of cases) assert.equal(formatCountdown(ms), text, String(ms));
    assert.throws(() => formatCountdown(Number.NaN), /finite/);
    assert.throws(() => formatCountdown(Number.POSITIVE_INFINITY), /finite/);
  });
  it('states: running, elapsed at 0, and the caller\'s cancelled or server-confirmed', () => {
    assert.equal(countdownState(1, undefined), 'running');
    assert.equal(countdownState(0, undefined), 'elapsed');
    assert.equal(countdownState(5_000, 'cancelled'), 'cancelled');
    assert.equal(countdownState(0, 'server-confirmed'), 'server-confirmed');
  });
});

describe('UI-T07 DiffView states (C38)', () => {
  const line = { key: 'k', label: 'Max position', before: '0.25', after: '0.30', unit: 'SOL', direction: 'raises' as const };
  it('no-changes, changes, conflict', () => {
    assert.equal(diffState({ kind: 'limits', lines: [] }), 'no-changes');
    assert.equal(diffState({ kind: 'limits', lines: [line] }), 'changes');
    assert.equal(diffState({ kind: 'config', lines: [line], conflict: true }), 'conflict');
    assert.equal(diffState({ kind: 'config', lines: [], conflict: false }), 'no-changes');
  });
});
