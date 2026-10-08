// UI-T07 components in a DOM: Dialog/AlertDialog (C15), TypedConfirmDialog (C16), StepUpAuth (C17), Countdown (C44),
// DiffView (C38) and HoldButton (C03), with the VM-03 fixtures. Acceptance 1 (case-sensitive phrase), 2 (release at
// 700 ms), 3 (LIVE: title, announced through the dialog's name) and 4 (Esc returns focus) are here and, in a browser,
// in test/e2e/dialogs.e2e.ts.
import './dom.ts';
import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import { createElement as h, useState, type ReactElement } from 'react';
import type { Clock, Mode, UnixMs } from '@bot/types';
import { Countdown } from '../src/components/countdown.ts';
import { Dialog, StepUpAuth, TypedConfirmDialog, type CloseReason, type DialogProps, type StepUpStatus, type TypedConfirmStatus } from '../src/components/dialog.ts';
import { DiffView } from '../src/components/diff-view.ts';
import { HoldButton, type HoldServerStatus } from '../src/components/hold-button.ts';
import { DIALOG_EXIT_MS, HOLD_REWIND_MS, HOLD_TO_CONFIRM_MS, type SystemStateView } from '../src/lib/safety.ts';
import { actSync, click, fire, key, render, typeInto, type Rendered } from './dom.ts';
import { PACKAGE_DIR } from './tooling/build.ts';

const mounted: Rendered[] = [];
const mount = (el: ReactElement): Rendered => { const r = render(el); mounted.push(r); return r; };
beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] }));
afterEach(() => { while (mounted.length > 0) mounted.pop()?.unmount(); vi.useRealTimers(); document.body.innerHTML = ''; });
const tick = (ms: number): void => actSync(() => vi.advanceTimersByTime(ms));

const sys = (mode: Mode): SystemStateView => ({ state_version: '1', mode, simulated: mode !== 'live' && mode !== 'live_small', trading_state: 'running' });
const PAPER = sys('paper');
const LIVE = sys('live_small');

/** Compares by identity without printing the DOM nodes (an assertion message that inspects happy-dom nodes runs out of memory). */
function assertFocused(el: Element | null, message = 'focus'): void {
  assert.ok(document.activeElement === el, `${message}: expected ${el?.outerHTML.slice(0, 80) ?? 'null'}, got ${document.activeElement?.outerHTML.slice(0, 80) ?? 'null'}`);
}
const dialogEl = (r: Rendered): HTMLDialogElement => r.container.querySelector('dialog') as HTMLDialogElement;
const btn = (root: ParentNode, cls: string): HTMLButtonElement => root.querySelector(`button.${cls}`) as HTMLButtonElement;
const buttonByText = (root: ParentNode, text: string): HTMLButtonElement =>
  [...root.querySelectorAll('button')].find((b) => b.textContent?.includes(text) === true) as HTMLButtonElement;

/** A trigger button and a controlled Dialog, like a page would use it. */
function Harness(props: { system: SystemStateView | null; onClose?: (r: CloseReason) => void; dialog?: Partial<DialogProps> }): ReactElement {
  const [open, setOpen] = useState(false);
  return h('div', null,
    h('button', { type: 'button', id: 'trigger', onClick: () => setOpen(true) }, 'Open'),
    h(Dialog, {
      open, system: props.system, title: 'Close position', description: 'Sell now.',
      confirm: { label: 'Close position', onClick: () => undefined },
      ...props.dialog,
      onClose: (r) => { props.onClose?.(r); setOpen(false); },
    }));
}

function openHarness(system: SystemStateView | null, extra: Partial<Parameters<typeof Harness>[0]> = {}): { r: Rendered; trigger: HTMLButtonElement } {
  const r = mount(h(Harness, { system, ...extra }));
  const trigger = r.container.querySelector('#trigger') as HTMLButtonElement;
  trigger.focus();
  click(trigger);
  return { r, trigger };
}

describe('UI-T07 Dialog (C15)', () => {
  it('opens modally as a labelled, described alertdialog with focus on the least destructive action', () => {
    const { r } = openHarness(PAPER);
    const d = dialogEl(r);
    assert.equal(d.open, true);
    assert.equal(d.getAttribute('role'), 'alertdialog');
    assert.equal(d.getAttribute('aria-modal'), 'true');
    assert.equal(document.getElementById(d.getAttribute('aria-labelledby') as string)?.textContent, 'Paper: Close position');
    assert.equal(document.getElementById(d.getAttribute('aria-describedby') as string)?.textContent, 'Sell now.');
    assertFocused(btn(d, 'dialog__cancel'));
    assert.equal(d.dataset['state'], 'open');
  });

  it('acceptance 4: Esc closes it and focus returns to the triggering control', () => {
    const onClose = vi.fn();
    const { r, trigger } = openHarness(PAPER, { onClose });
    key(dialogEl(r), 'keydown', { key: 'Escape' });
    assert.deepEqual(onClose.mock.calls, [['escape']]);
    assert.equal(dialogEl(r).dataset['state'], 'closing');
    tick(DIALOG_EXIT_MS - 1);
    assert.equal(dialogEl(r).open, true, 'still fading out');
    tick(1);
    assert.equal(r.container.querySelector('dialog'), null);
    assertFocused(trigger);
  });

  it('the native cancel event (Esc in a browser) closes it the same way; Cancel does too', () => {
    const onClose = vi.fn();
    const { r, trigger } = openHarness(PAPER, { onClose });
    const cancel = new Event('cancel', { cancelable: true });
    fire(dialogEl(r), cancel);
    assert.equal(cancel.defaultPrevented, true, 'the browser does not close it by itself');
    assert.deepEqual(onClose.mock.calls, [['escape']]);
    tick(DIALOG_EXIT_MS);
    assertFocused(trigger);
    click(trigger);
    click(btn(dialogEl(r), 'dialog__cancel'));
    assert.deepEqual(onClose.mock.calls.at(-1), ['cancel']);
  });

  it('does not close while submitting', () => {
    const onClose = vi.fn();
    const { r } = openHarness(PAPER, { onClose, dialog: { status: 'submitting' } });
    key(dialogEl(r), 'keydown', { key: 'Escape' });
    fire(dialogEl(r), new Event('cancel', { cancelable: true }));
    assert.equal(onClose.mock.calls.length, 0);
    const confirm = btn(dialogEl(r), 'dialog__confirm');
    assert.equal(confirm.getAttribute('aria-busy'), 'true');
    assert.equal(btn(dialogEl(r), 'dialog__cancel').getAttribute('aria-disabled'), 'true');
  });

  it('traps focus: Tab from the last control goes to the first, Shift+Tab from the first to the last', () => {
    const { r } = openHarness(PAPER);
    const d = dialogEl(r);
    const cancel = btn(d, 'dialog__cancel');
    const confirm = btn(d, 'dialog__confirm');
    confirm.focus();
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    fire(confirm, tab);
    assert.equal(tab.defaultPrevented, true);
    assertFocused(cancel);
    const back = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
    fire(cancel, back);
    assertFocused(confirm);
    cancel.focus();
    const mid = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    fire(cancel, mid);
    assert.equal(mid.defaultPrevented, false, 'between the ends the browser moves focus');
    key(d, 'keydown', { key: 'a' });
    assert.equal(d.open, true);
  });

  it('focus outside the dialog is pulled back in by Tab', () => {
    const { r, trigger } = openHarness(PAPER);
    trigger.focus();
    fire(dialogEl(r), new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    assertFocused(btn(dialogEl(r), 'dialog__cancel'));
    trigger.focus();
    fire(dialogEl(r), new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
    assertFocused(btn(dialogEl(r), 'dialog__confirm'));
  });

  it('acceptance 3: in live the title starts with "LIVE:" and names the dialog; the orchid border and "real funds" show', () => {
    const { r } = openHarness(LIVE);
    const d = dialogEl(r);
    const name = document.getElementById(d.getAttribute('aria-labelledby') as string)?.textContent ?? '';
    assert.ok(name.startsWith('LIVE:'), name);
    assert.equal(name, 'LIVE: Close position');
    assert.ok(d.classList.contains('dialog--live'));
    assert.match(btn(d, 'dialog__confirm').textContent ?? '', /real funds/);
    assert.ok(btn(d, 'dialog__confirm').classList.contains('btn--live-confirm'));
    for (const [mode, prefix] of [['live', 'LIVE:'], ['replay', 'Replay:'], ['backtest', 'Replay:']] as const) {
      const other = mount(h(Dialog, { open: true, inline: true, system: sys(mode), title: 'T', description: 'D', onClose: () => undefined }));
      assert.equal(other.container.querySelector('.dialog__title')?.textContent, `${prefix} T`);
    }
  });

  it('a dialog that does not affect money, or with the mode unknown, has no prefix and no live marks', () => {
    const plain = mount(h(Dialog, { open: true, inline: true, kind: 'standard', moneyAffecting: false, system: LIVE, title: 'Columns', description: 'D', onClose: () => undefined }));
    const d = plain.container.querySelector('dialog') as HTMLDialogElement;
    assert.equal(d.querySelector('.dialog__title')?.textContent, 'Columns');
    assert.equal(d.getAttribute('role'), 'dialog');
    assert.equal(d.getAttribute('aria-modal'), null, 'an in-place frame is not modal');
    assert.equal(d.classList.contains('dialog--live'), false);
    const unknown = mount(h(Dialog, { open: true, inline: true, system: null, title: 'T', description: 'D', onClose: () => undefined }));
    assert.equal(unknown.container.querySelector('.dialog__title')?.textContent, 'T');
    assert.equal(unknown.container.querySelector('dialog')?.dataset['mode'], 'unknown');
  });

  it('disconnected: a non-HALT dialog says so and disables submit; HALT stays enabled with initial focus on "Halt now"', () => {
    const onConfirm = vi.fn();
    const { r } = openHarness(PAPER, { dialog: { connection: 'disconnected', confirm: { label: 'Close position', onClick: onConfirm } } });
    const d = dialogEl(r);
    assert.equal(d.querySelector('.banner--disconnected .banner__title')?.textContent, 'Disconnected · cannot confirm current state');
    const confirm = btn(d, 'dialog__confirm');
    assert.equal(confirm.getAttribute('aria-disabled'), 'true');
    click(confirm);
    assert.equal(onConfirm.mock.calls.length, 0);
    const onHalt = vi.fn();
    const halt = openHarness(PAPER, { dialog: { halt: true, connection: 'disconnected', title: 'Halt trading', confirm: { label: 'Halt now', onClick: onHalt } } });
    const hd = dialogEl(halt.r);
    assert.equal(hd.querySelector('.banner--disconnected'), null);
    const haltNow = btn(hd, 'dialog__confirm');
    assertFocused(haltNow);
    assert.equal(haltNow.getAttribute('aria-disabled'), null);
    assert.ok(haltNow.classList.contains('btn--danger'));
    assert.doesNotMatch(haltNow.textContent ?? '', /real funds/);
    click(haltNow);
    assert.equal(onHalt.mock.calls.length, 1);
  });

  it('a mode change while open closes it and says "Mode changed to X — review again"; reopening clears the notice', () => {
    const onClose = vi.fn();
    function ModeHarness(props: { mode: Mode }): ReactElement {
      return h(Harness, { system: sys(props.mode), onClose });
    }
    const r = mount(h(ModeHarness, { mode: 'paper' }));
    const trigger = r.container.querySelector('#trigger') as HTMLButtonElement;
    trigger.focus();
    click(trigger);
    r.rerender(h(ModeHarness, { mode: 'paper' }));
    assert.equal(onClose.mock.calls.length, 0, 'the same mode is no change');
    r.rerender(h(ModeHarness, { mode: 'live_small' }));
    assert.deepEqual(onClose.mock.calls, [['mode-changed']]);
    const notice = r.container.querySelector('.dialog-notice') as HTMLElement;
    assert.equal(notice.getAttribute('role'), 'alert');
    assert.equal(notice.textContent, 'Mode changed to LIVE-SMALL — review again');
    tick(DIALOG_EXIT_MS);
    assertFocused(trigger);
    click(trigger);
    assert.equal(r.container.querySelector('.dialog-notice'), null);
    assert.equal(r.container.querySelector('.dialog__title')?.textContent, 'LIVE: Close position');
  });

  it('shows the error state with its message and a secondary action', () => {
    const onSecondary = vi.fn();
    const r = mount(h(Dialog, {
      open: true, inline: true, system: PAPER, status: 'error', error: 'Timed out.', title: 'T', description: 'D', onClose: () => undefined,
      secondary: { label: 'Halt and flatten all…', onClick: onSecondary }, confirm: { label: 'Go', onClick: () => undefined },
    }));
    const err = r.container.querySelector('.dialog__error') as HTMLElement;
    assert.equal(err.getAttribute('role'), 'alert');
    assert.equal(err.textContent, 'Timed out.');
    click(btn(r.container, 'dialog__secondary'));
    assert.equal(onSecondary.mock.calls.length, 1);
    const blocked = mount(h(Dialog, {
      open: true, inline: true, system: PAPER, title: 'T', description: 'D', onClose: () => undefined,
      secondary: { label: 'More', onClick: onSecondary, disabledReason: 'Not now' }, confirm: { label: 'Go', onClick: () => undefined, disabledReason: 'Wait' },
    }));
    assert.equal(btn(blocked.container, 'dialog__secondary').getAttribute('aria-disabled'), 'true');
    assert.equal(btn(blocked.container, 'dialog__confirm').getAttribute('aria-disabled'), 'true');
  });

  it('an in-place frame neither opens modally nor moves focus; with no control, focus goes to the dialog itself', () => {
    const outside = document.createElement('button');
    document.body.append(outside);
    outside.focus();
    mount(h(Dialog, { open: true, inline: true, system: PAPER, title: 'T', description: 'D', onClose: () => undefined }));
    assertFocused(outside);
    outside.remove();
  });

  it('closing before the fade ends and reopening keeps the dialog open and the original trigger', () => {
    function Toggle(props: { open: boolean }): ReactElement {
      return h(Dialog, { open: props.open, system: PAPER, title: 'T', description: 'D', onClose: () => undefined });
    }
    const trigger = document.createElement('button');
    document.body.append(trigger);
    trigger.focus();
    const r = mount(h(Toggle, { open: true }));
    r.rerender(h(Toggle, { open: false }));
    assert.equal(dialogEl(r).dataset['state'], 'closing');
    r.rerender(h(Toggle, { open: true }));
    tick(DIALOG_EXIT_MS * 2);
    assert.equal(dialogEl(r).open, true);
    assert.equal(dialogEl(r).dataset['state'], 'open');
    r.rerender(h(Toggle, { open: false }));
    tick(DIALOG_EXIT_MS);
    assertFocused(trigger);
    trigger.remove();
  });
});

describe('UI-T07 TypedConfirmDialog (C16)', () => {
  function Typed(props: { status?: TypedConfirmStatus; stepUp?: StepUpStatus; onConfirm?: () => void; system?: SystemStateView; extra?: object }): ReactElement {
    return h(TypedConfirmDialog, {
      open: true, system: props.system ?? LIVE, actionClass: 'A3', requiredPhrase: 'LIVE-SMALL 0.25', actionName: 'the switch to LIVE-SMALL',
      title: 'Switch to LIVE-SMALL', description: 'Real funds.', confirmLabel: 'Switch mode', onConfirm: props.onConfirm ?? (() => undefined),
      onClose: () => undefined, ...(props.status === undefined ? {} : { status: props.status }), ...(props.stepUp === undefined ? {} : { stepUp: props.stepUp }),
      countdown: { label: 'LIVE-SMALL', effectiveAt: '2026-10-06T14:03:11.123Z', source: { clock: { nowMs: () => Date.parse('2026-10-06T14:02:29.123Z') as UnixMs, kind: 'wall' } } },
      ...props.extra,
    });
  }
  const input = (r: Rendered): HTMLInputElement => r.container.querySelector('input') as HTMLInputElement;

  it('acceptance 1: `live-small 0.25` keeps confirm disabled and the hint shows the case mismatch; the exact phrase enables it', () => {
    const onConfirm = vi.fn();
    const r = mount(h(Typed, { onConfirm }));
    const d = dialogEl(r);
    const confirm = (): HTMLButtonElement => btn(d, 'dialog__confirm');
    assert.equal(d.querySelector('.typed-confirm__body')?.getAttribute('data-state'), 'empty');
    assert.equal(confirm().getAttribute('aria-disabled'), 'true');
    typeInto(input(r), 'live-small 0.25');
    assert.equal(d.querySelector('.typed-confirm__body')?.getAttribute('data-state'), 'mismatch');
    assert.equal(confirm().getAttribute('aria-disabled'), 'true');
    click(confirm());
    assert.equal(onConfirm.mock.calls.length, 0);
    assert.equal(d.querySelector('.field__message')?.textContent, 'Letter case does not match. The phrase is case-sensitive.');
    assert.equal(input(r).getAttribute('aria-invalid'), 'true');
    assert.equal(d.querySelectorAll('.phrase__char--case').length, 9);
    assert.equal(document.getElementById((input(r).getAttribute('aria-describedby') as string).split(' ')[0] as string)?.textContent,
      'Letter case does not match. The phrase is case-sensitive.', 'the hint is the input\'s description');
    typeInto(input(r), '  LIVE-SMALL 0.25 ');
    assert.equal(d.querySelector('.typed-confirm__body')?.getAttribute('data-state'), 'match');
    assert.equal(confirm().getAttribute('aria-disabled'), null);
    click(confirm());
    assert.equal(onConfirm.mock.calls.length, 1);
  });

  it('a partial phrase is not marked invalid; extra characters are', () => {
    const r = mount(h(Typed, {}));
    typeInto(input(r), 'LIVE-SM');
    assert.equal(input(r).getAttribute('aria-invalid'), null);
    assert.equal(r.container.querySelector('.field__message')?.textContent, '7 of 15 characters typed.');
    typeInto(input(r), 'LIVE-SMALL 0.255');
    assert.equal(input(r).getAttribute('aria-invalid'), 'true');
    assert.equal(r.container.querySelector('.phrase__extra')?.textContent, '+1');
  });

  it('paste is not blocked: a pasted phrase is read like typed text', () => {
    const r = mount(h(Typed, {}));
    const paste = new Event('paste', { bubbles: true, cancelable: true });
    fire(input(r), paste);
    assert.equal(paste.defaultPrevented, false);
  });

  it('a controlled phrase is reported and shown; the dialog clears its own phrase when it reopens', () => {
    const onPhraseChange = vi.fn();
    const r = mount(h(Typed, { extra: { phrase: 'LIVE', onPhraseChange } }));
    assert.equal(input(r).value, 'LIVE');
    typeInto(input(r), 'LIVE-');
    assert.deepEqual(onPhraseChange.mock.calls, [['LIVE-']]);
    function Reopen(props: { open: boolean }): ReactElement { return h(Typed, { extra: { open: props.open } }); }
    const own = mount(h(Reopen, { open: true }));
    typeInto(input(own), 'LIVE');
    own.rerender(h(Reopen, { open: false }));
    tick(DIALOG_EXIT_MS);
    own.rerender(h(Reopen, { open: true }));
    assert.equal(input(own).value, '');
  });

  it('step-up required shows the passkey prompt; submitting keeps the phrase read-only and the confirm pending', () => {
    const r = mount(h(Typed, { status: 'step-up-required', stepUp: 'failed', extra: { onStepUpRetry: () => undefined } }));
    assert.equal(r.container.querySelector('.step-up')?.getAttribute('data-state'), 'failed');
    assert.ok(buttonByText(r.container, 'Try again') !== undefined);
    const plain = mount(h(Typed, { status: 'step-up-required' }));
    assert.equal(plain.container.querySelector('.step-up')?.getAttribute('data-state'), 'prompting');
    const s = mount(h(Typed, { status: 'submitting' }));
    assert.equal(input(s).readOnly, true);
    assert.equal(btn(s.container, 'dialog__confirm').getAttribute('aria-busy'), 'true');
    assert.equal(dialogEl(s).dataset['state'], 'submitting');
  });

  it('final states replace the form with the outcome and a Close button', () => {
    const outcome = (status: TypedConfirmStatus, extra: object = {}): Rendered => mount(h(Typed, { status, extra }));
    const scheduled = outcome('scheduled');
    assert.equal(scheduled.container.querySelector('input'), null);
    assert.equal(btn(scheduled.container, 'dialog__confirm'), null);
    assert.equal(btn(scheduled.container, 'dialog__cancel').textContent, 'Close');
    assert.equal(scheduled.container.querySelector('.countdown__text')?.textContent, 'LIVE-SMALL in 0:42');
    assert.equal(outcome('scheduled', { countdown: undefined }).container.querySelector('.countdown'), null);
    assert.equal(outcome('cancelled').container.querySelector('.dialog__result')?.textContent, 'Cancelled. Nothing changed.');
    assert.equal(outcome('executed').container.querySelector('.dialog__result')?.textContent, 'Done. The change is in the audit log.');
    const rejected = outcome('rejected', { rejectReason: 'Gate P-6 failing <b>' });
    assert.equal(rejected.container.querySelector('.banner--danger .banner__body')?.textContent, 'Gate P-6 failing <b>', 'the server reason, verbatim and as text');
    assert.equal(outcome('rejected').container.querySelector('.banner--danger .banner__body')?.textContent, '');
    assert.equal(outcome('unknown-outcome').container.querySelector('.banner--warning .banner__body')?.textContent,
      'We could not confirm whether the switch to LIVE-SMALL was applied. Checking…');
  });

  it('paper and live titles; disconnected disables confirm even on a match', () => {
    const paper = mount(h(Typed, { system: PAPER }));
    assert.equal(paper.container.querySelector('.dialog__title')?.textContent, 'Paper: Switch to LIVE-SMALL');
    const off = mount(h(Typed, { extra: { connection: 'disconnected', phrase: 'LIVE-SMALL 0.25' } }));
    assert.equal(btn(off.container, 'dialog__confirm').getAttribute('aria-disabled'), 'true');
    assert.ok(off.container.querySelector('.banner--disconnected') !== null);
  });
});

describe('UI-T07 StepUpAuth (C17)', () => {
  it('renders every state; failed is an alert; retry and cancel only where they apply', () => {
    const onRetry = vi.fn();
    const onCancel = vi.fn();
    const states: readonly StepUpStatus[] = ['prompting', 'success', 'cancelled', 'failed', 'unsupported'];
    const titles = states.map((status) => {
      const r = mount(h(StepUpAuth, { status, onRetry, onCancel }));
      const root = r.container.querySelector('.step-up') as HTMLElement;
      assert.equal(root.getAttribute('role'), status === 'failed' ? 'alert' : 'status');
      assert.equal(buttonByText(root, 'Try again') !== undefined, status === 'cancelled' || status === 'failed', status);
      assert.equal(buttonByText(root, 'Cancel') !== undefined, status !== 'success', status);
      return root.querySelector('.step-up__title')?.textContent;
    });
    assert.deepEqual(titles, ['Confirm with your passkey', 'Passkey confirmed', 'Passkey check cancelled', 'Passkey check failed', 'Passkeys are not available in this browser']);
    const failed = mount(h(StepUpAuth, { status: 'failed', onRetry, onCancel }));
    click(buttonByText(failed.container, 'Try again'));
    click(buttonByText(failed.container, 'Cancel'));
    assert.deepEqual([onRetry.mock.calls.length, onCancel.mock.calls.length], [1, 1]);
    assert.equal(mount(h(StepUpAuth, { status: 'failed' })).container.querySelector('.step-up__actions'), null);
    assert.match(mount(h(StepUpAuth, { status: 'unsupported' })).container.textContent ?? '', /Halting needs no passkey/);
  });
});

describe('UI-T07 Countdown (C44)', () => {
  let nowMs = 0;
  const clock: Clock = { nowMs: () => nowMs as UnixMs, kind: 'wall' };
  const effectiveAt = '2026-10-06T14:03:11.123Z';
  const at = (iso: string): number => Date.parse(iso);

  it('counts down each second on the server clock, never below 0:00, then waits for the server', () => {
    nowMs = at('2026-10-06T14:02:29.123Z');
    const onCancel = vi.fn();
    const r = mount(h(Countdown, { label: 'LIVE-SMALL', effectiveAt, source: { clock }, onCancel }));
    const text = (): string => r.container.querySelector('.countdown__text')?.textContent ?? '';
    assert.equal(text(), 'LIVE-SMALL in 0:42');
    assert.equal(r.container.querySelector('[role="timer"]')?.getAttribute('aria-label'), 'LIVE-SMALL in 0:42');
    nowMs += 1000;
    tick(1000);
    assert.equal(text(), 'LIVE-SMALL in 0:41');
    click(buttonByText(r.container, 'Cancel'));
    assert.equal(onCancel.mock.calls.length, 1);
    nowMs += 41_000;
    tick(41_000);
    assert.equal(text(), 'LIVE-SMALL due · waiting for the server');
    assert.equal(r.container.querySelector('.countdown')?.getAttribute('data-state'), 'elapsed');
    assert.equal(buttonByText(r.container, 'Cancel'), undefined, 'nothing left to cancel');
    nowMs += 10_000;
    tick(10_000);
    assert.equal(text(), 'LIVE-SMALL due · waiting for the server');
  });

  it('uses the server clock offset, and shows cancelled and applied', () => {
    nowMs = at('2026-10-06T14:02:29.123Z');
    const ahead = mount(h(Countdown, { label: 'RAISE MAXPOS 0.30', effectiveAt, source: { clock, offsetMs: 2000 } }));
    assert.equal(ahead.container.querySelector('.countdown__text')?.textContent, 'RAISE MAXPOS 0.30 in 0:40');
    const cancelled = mount(h(Countdown, { label: 'LIVE-SMALL', effectiveAt, source: { clock }, outcome: 'cancelled', onCancel: () => undefined }));
    assert.equal(cancelled.container.querySelector('.countdown__text')?.textContent, 'LIVE-SMALL cancelled');
    assert.equal(buttonByText(cancelled.container, 'Cancel'), undefined);
    const applied = mount(h(Countdown, { label: 'LIVE-SMALL', effectiveAt, source: { clock }, outcome: 'server-confirmed' }));
    assert.equal(applied.container.querySelector('.countdown__text')?.textContent, 'LIVE-SMALL applied');
  });
});

describe('UI-T07 DiffView (C38)', () => {
  it('shows each line with its unit and risk direction; no changes; a conflict banner', () => {
    const lines = [
      { key: 'a', label: 'Max position', before: '0.25', after: '0.30', unit: 'SOL', direction: 'raises' as const },
      { key: 'b', label: 'Daily loss', before: '0.60', after: '0.50', unit: 'SOL', direction: 'lowers' as const },
      { key: 'c', label: 'Max slippage', before: '150', after: '150', unit: 'bps', direction: 'neutral' as const },
    ];
    const r = mount(h(DiffView, { kind: 'limits', lines }));
    const rows = [...r.container.querySelectorAll('tbody tr')].map((tr) => [...tr.children].map((c) => c.textContent));
    assert.deepEqual(rows, [
      ['Max position', '0.25 SOL', '', '0.30 SOL', 'Raises risk'],
      ['Daily loss', '0.60 SOL', '', '0.50 SOL', 'Lowers risk'],
      ['Max slippage', '150 bps', '', '150 bps', 'No risk change'],
    ]);
    assert.equal(r.container.querySelector('caption')?.textContent, 'Limit changes');
    const none = mount(h(DiffView, { kind: 'config', lines: [] }));
    assert.equal(none.container.querySelector('.diff')?.getAttribute('data-state'), 'no-changes');
    assert.equal(none.container.querySelector('.diff__empty')?.textContent, 'No changes.');
    const conflict = mount(h(DiffView, { kind: 'config', lines, conflict: true }));
    assert.equal(conflict.container.querySelector('.banner--warning .banner__title')?.textContent, 'The server’s version changed');
    assert.equal(conflict.container.querySelector('caption')?.textContent, 'Configuration changes');
  });
});

describe('UI-T07 HoldButton (C03)', () => {
  function Hold(props: { status?: HoldServerStatus; onConfirm: () => void; onOpenDialog: () => void }): ReactElement {
    return h(HoldButton, { ...(props.status === undefined ? {} : { status: props.status }), onConfirm: props.onConfirm, onOpenDialog: props.onOpenDialog });
  }
  const pointer = (type: string, init: PointerEventInit = {}): PointerEvent => new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 1, ...init });
  const setup = (status?: HoldServerStatus): { r: Rendered; b: HTMLButtonElement; onConfirm: ReturnType<typeof vi.fn>; onOpenDialog: ReturnType<typeof vi.fn> } => {
    const onConfirm = vi.fn();
    const onOpenDialog = vi.fn();
    const r = mount(h(Hold, { ...(status === undefined ? {} : { status }), onConfirm, onOpenDialog }));
    return { r, b: r.container.querySelector('button') as HTMLButtonElement, onConfirm, onOpenDialog };
  };

  it('acceptance 2: released at 700 ms, no confirm fires; the ring rewinds over 160 ms', () => {
    const { b, onConfirm, onOpenDialog } = setup();
    fire(b, pointer('pointerdown'));
    assert.equal(b.dataset['state'], 'holding');
    tick(700);
    fire(b, pointer('pointerup'));
    fire(b, new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
    assert.equal(b.dataset['state'], 'released-early');
    tick(HOLD_TO_CONFIRM_MS);
    assert.equal(onConfirm.mock.calls.length, 0);
    assert.equal(onOpenDialog.mock.calls.length, 0, 'the click that ends a pointer press opens nothing');
    assert.equal(b.dataset['state'], 'idle');
  });

  it('holding for 1000 ms confirms once; the click that follows opens nothing', () => {
    const { b, onConfirm, onOpenDialog } = setup();
    fire(b, pointer('pointerdown'));
    tick(HOLD_TO_CONFIRM_MS - 1);
    assert.equal(onConfirm.mock.calls.length, 0);
    tick(1);
    assert.equal(onConfirm.mock.calls.length, 1);
    fire(b, pointer('pointerup'));
    fire(b, new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
    assert.equal(onConfirm.mock.calls.length, 1);
    assert.equal(onOpenDialog.mock.calls.length, 0);
    assert.equal(b.dataset['state'], 'idle');
  });

  it('a touch cancel or a lost pointer rewinds; a second press during the rewind starts a fresh hold', () => {
    const { b, onConfirm } = setup();
    fire(b, pointer('pointerdown', { pointerType: 'touch' }));
    tick(500);
    fire(b, pointer('pointercancel', { pointerType: 'touch' }));
    assert.equal(b.dataset['state'], 'released-early');
    tick(HOLD_REWIND_MS / 2);
    fire(b, pointer('pointerdown'));
    assert.equal(b.dataset['state'], 'holding');
    tick(HOLD_REWIND_MS);
    assert.equal(b.dataset['state'], 'holding', 'the old rewind does not end the new hold');
    fire(b, pointer('lostpointercapture'));
    tick(HOLD_TO_CONFIRM_MS);
    assert.equal(onConfirm.mock.calls.length, 0);
  });

  it('Enter and Space do not hold: they open the HALT dialog; a click no pointer started (assistive technology) does too', () => {
    const { b, onConfirm, onOpenDialog } = setup();
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    fire(b, enter);
    assert.equal(enter.defaultPrevented, true, 'no native click from Enter');
    key(b, 'keydown', { key: ' ' });
    key(b, 'keydown', { key: 'Enter', repeat: true });
    const spaceUp = new KeyboardEvent('keyup', { key: ' ', bubbles: true, cancelable: true });
    fire(b, spaceUp);
    assert.equal(spaceUp.defaultPrevented, true);
    key(b, 'keydown', { key: 'a' });
    key(b, 'keyup', { key: 'a' });
    assert.equal(onOpenDialog.mock.calls.length, 2);
    click(b);
    assert.equal(onOpenDialog.mock.calls.length, 3);
    tick(HOLD_TO_CONFIRM_MS * 2);
    assert.equal(onConfirm.mock.calls.length, 0);
    assert.equal(b.dataset['state'], 'idle');
  });

  it('a secondary-button press, or a press while sending, does not hold', () => {
    const { b, onConfirm } = setup();
    fire(b, pointer('pointerdown', { button: 2 }));
    assert.equal(b.dataset['state'], 'idle');
    const ctx = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    fire(b, ctx);
    assert.equal(ctx.defaultPrevented, true, 'a long touch does not open the context menu');
    const sending = setup('sending');
    fire(sending.b, pointer('pointerdown'));
    tick(HOLD_TO_CONFIRM_MS);
    assert.equal(sending.onConfirm.mock.calls.length, 0);
    assert.equal(onConfirm.mock.calls.length, 0);
  });

  it('pressing twice without releasing starts one hold only', () => {
    const { b, onConfirm } = setup();
    fire(b, pointer('pointerdown'));
    tick(400);
    fire(b, pointer('pointerdown'));
    tick(HOLD_TO_CONFIRM_MS - 400);
    assert.equal(onConfirm.mock.calls.length, 1);
  });

  it('server states replace the label and are announced; the hint names both paths', () => {
    const labels = (['idle', 'sending', 'acked', 'unconfirmed', 'failed'] as const).map((s) => {
      const { b, r } = setup(s);
      assert.equal(b.dataset['state'], s);
      assert.equal(r.container.querySelector('[role="status"]')?.textContent, s === 'idle' ? '' : b.querySelector('.hold-btn__label')?.textContent);
      assert.equal(b.getAttribute('aria-busy'), s === 'sending' ? 'true' : null);
      return b.querySelector('.hold-btn__label')?.textContent;
    });
    assert.deepEqual(labels, ['Halt', 'Halting…', 'Halted', 'Halt not confirmed', 'Halt failed']);
    const { b } = setup();
    assert.equal(document.getElementById(b.getAttribute('aria-describedby') as string)?.textContent,
      'Press and hold for 1 second to halt. Enter opens the halt dialog.');
  });

  it('a hold pending at unmount is cancelled', () => {
    const { r, b, onConfirm } = setup();
    fire(b, pointer('pointerdown'));
    r.unmount();
    mounted.splice(mounted.indexOf(r), 1);
    tick(HOLD_TO_CONFIRM_MS);
    assert.equal(onConfirm.mock.calls.length, 0);
    const again = setup();
    fire(again.b, pointer('pointerdown'));
    fire(again.b, pointer('pointerup'));
    again.r.unmount();
    mounted.splice(mounted.indexOf(again.r), 1);
    tick(HOLD_REWIND_MS);
  });
});

describe('UI-T07 VM-03 fixtures (fixture first: INTEGRATION.md, UI-T07 depends on VM-03)', () => {
  const dir = join(PACKAGE_DIR, 'test/fixtures/vm-03');
  const fixtures = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  const PREFIX: Readonly<Record<Mode, string>> = { backtest: 'Replay:', replay: 'Replay:', paper: 'Paper:', live_small: 'LIVE:', live: 'LIVE:' };

  it('covers paper, live-small, live, replay, null fields, u64 maximum and maximum-length untrusted strings', () => {
    assert.deepEqual(fixtures, ['halted-live.json', 'live-small.json', 'nulls.json', 'paper.json', 'replay-paused.json', 'untrusted-max.json']);
    const max = JSON.parse(readFileSync(join(dir, 'untrusted-max.json'), 'utf8')) as { state_version: string; kill: { reason_text: string; halted_by: { display: string } } };
    assert.equal(max.state_version, '18446744073709551615');
    assert.equal(max.kill.reason_text.length, 1000);
    assert.ok(max.kill.halted_by.display.startsWith('\u202e'));
  });

  for (const file of fixtures) {
    it(`${file}: the HALT and typed dialogs take the fixture's mode`, () => {
      const vm = JSON.parse(readFileSync(join(dir, file), 'utf8')) as SystemStateView;
      const system: SystemStateView = { state_version: vm.state_version, mode: vm.mode, simulated: vm.simulated, trading_state: vm.trading_state };
      const halt = mount(h(Dialog, { open: true, inline: true, halt: true, system, title: 'Halt trading', description: 'D', confirm: { label: 'Halt now', onClick: () => undefined }, onClose: () => undefined }));
      assert.equal(halt.container.querySelector('.dialog__title')?.textContent, `${PREFIX[vm.mode]} Halt trading`);
      assert.equal(halt.container.querySelector('dialog')?.dataset['mode'], vm.mode);
      const typed = mount(h(TypedConfirmDialog, {
        open: true, inline: true, system, actionClass: 'A2', requiredPhrase: 'RESUME', actionName: 'the resume', title: 'Resume trading', description: 'D',
        confirmLabel: 'Resume', onConfirm: () => undefined, onClose: () => undefined,
      }));
      assert.equal(typed.container.querySelector('dialog')?.classList.contains('dialog--live'), vm.mode === 'live' || vm.mode === 'live_small');
    });
  }

  it.todo('the VM-03 fixtures validate against the @bot/contract VM-03 schema: waits for B-M28-01 (card Z02), which exports the VM schemas; @bot/contract has no VM-03 schema yet');
});
