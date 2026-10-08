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
import { Dialog, HaltDialog, StepUpAuth, TypedConfirmDialog, type CloseReason, type ConnectionView, type DialogAction, type DialogProps, type HaltDialogProps, type StepUpStatus, type TypedConfirmStatus } from '../src/components/dialog.ts';
import { DiffView } from '../src/components/diff-view.ts';
import { CLICK_AFTER_UP_MS, HoldButton, type HoldServerStatus } from '../src/components/hold-button.ts';
import { haltCommand } from '../src/lib/halt-command.ts';
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
function Harness(props: { system: SystemStateView | null; onClose?: (r: CloseReason) => void; dialog?: Partial<DialogProps>; halt?: Partial<HaltDialogProps> }): ReactElement {
  const [open, setOpen] = useState(false);
  return h('div', null,
    h('button', { type: 'button', id: 'trigger', onClick: () => setOpen(true) }, 'Open'),
    props.halt !== undefined ? h(HaltDialog, { connection: 'connected', open, system: props.system, description: 'Stop new entries.', onHalt: haltCommand(() => undefined),
      ...props.halt, onClose: (r) => { props.onClose?.(r); setOpen(false); } }) : h(Dialog, { connection: 'connected',
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
      const other = mount(h(Dialog, { connection: 'connected', open: true, inline: true, system: sys(mode), title: 'T', description: 'D', onClose: () => undefined }));
      assert.equal(other.container.querySelector('.dialog__title')?.textContent, `${prefix} T`);
    }
  });

  it('a dialog that does not affect money, or with the mode unknown, has no prefix and no live marks', () => {
    const plain = mount(h(Dialog, { connection: 'connected', open: true, inline: true, kind: 'standard', moneyAffecting: false, system: LIVE, title: 'Columns', description: 'D', onClose: () => undefined }));
    const d = plain.container.querySelector('dialog') as HTMLDialogElement;
    assert.equal(d.querySelector('.dialog__title')?.textContent, 'Columns');
    assert.equal(d.getAttribute('role'), 'dialog');
    assert.equal(d.getAttribute('aria-modal'), null, 'an in-place frame is not modal');
    assert.equal(d.classList.contains('dialog--live'), false);
    const unknown = mount(h(Dialog, { connection: 'connected', open: true, inline: true, system: null, title: 'T', description: 'D', onClose: () => undefined }));
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
    const sent = vi.fn();
    const halt = openHarness(PAPER, { halt: { connection: 'disconnected', onHalt: haltCommand(sent) } });
    const hd = dialogEl(halt.r);
    assert.equal(hd.querySelector('.banner--disconnected'), null);
    const haltNow = btn(hd, 'dialog__confirm');
    assertFocused(haltNow);
    assert.equal(haltNow.getAttribute('aria-disabled'), null);
    assert.ok(haltNow.classList.contains('btn--danger'));
    assert.doesNotMatch(haltNow.textContent ?? '', /real funds/);
    click(haltNow);
    assert.deepEqual(sent.mock.calls, [[{ type: 'halt', params: {} }]]);
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

  it('Z05 round 2 (red team M3, reviewer m2): confirm fails closed while the connection is unknown or reconnecting, or the mode is unknown', () => {
    const cases: ReadonlyArray<[ConnectionView, SystemStateView | null, string]> = [
      ['unknown', PAPER, 'Connection unknown · cannot confirm current state'],
      ['reconnecting', LIVE, 'Reconnecting · cannot confirm current state'],
      ['disconnected', LIVE, 'Disconnected · cannot confirm current state'],
      ['connected', null, 'Mode unknown · cannot confirm current state'],
    ];
    for (const [connection, system, reason] of cases) {
      const onConfirm = vi.fn();
      const r = mount(h(Dialog, { open: true, inline: true, connection, system, title: 'T', description: 'D', confirm: { label: 'Go', onClick: onConfirm }, onClose: () => undefined }));
      const confirm = btn(r.container, 'dialog__confirm');
      assert.equal(confirm.getAttribute('aria-disabled'), 'true', reason);
      assert.equal(document.getElementById((confirm.getAttribute('aria-describedby') as string).split(' ')[0] as string)?.textContent, reason);
      assert.equal(r.container.querySelector('.banner .banner__title')?.textContent, reason);
      click(confirm);
      assert.equal(onConfirm.mock.calls.length, 0, reason);
    }
    // HALT reduces risk: it stays enabled in every one of these states.
    for (const [connection, system] of cases) {
      const r = mount(h(HaltDialog, { open: true, inline: true, connection, system, description: 'D', onHalt: haltCommand(() => undefined), onClose: () => undefined }));
      assert.equal(btn(r.container, 'dialog__confirm').getAttribute('aria-disabled'), null, connection);
    }
    // A dialog that does not affect money is not blocked by an unknown mode or a reconnecting stream.
    const plain = mount(h(Dialog, { open: true, inline: true, kind: 'standard', moneyAffecting: false, connection: 'reconnecting', system: null, title: 'Columns', description: 'D', confirm: { label: 'Save', onClick: () => undefined }, onClose: () => undefined }));
    assert.equal(btn(plain.container, 'dialog__confirm').getAttribute('aria-disabled'), null);
  });

  it('Z05 round 3 (ruling 15, with ruling 28): the secondary action always gets the confirm gate, HALT\'s included', () => {
    const onSecondary = vi.fn();
    // A mark that gets past the type (a cast) changes nothing: there is no risk-reducing secondary (ruling 28).
    const marked = { label: 'Halt and flatten all…', onClick: onSecondary, riskReducing: true } as unknown as DialogAction;
    const frame = (connection: ConnectionView, system: SystemStateView | null, halt: boolean, secondary: DialogAction): HTMLButtonElement => {
      const r = mount(halt
        ? h(HaltDialog, { open: true, inline: true, connection, system, description: 'D', secondary, onHalt: haltCommand(() => undefined), onClose: () => undefined })
        : h(Dialog, { open: true, inline: true, connection, system, title: 'Halt trading', description: 'D', secondary, confirm: { label: 'Halt now', onClick: () => undefined }, onClose: () => undefined }));
      return btn(r.container, 'dialog__secondary');
    };
    const plain: DialogAction = { label: 'Halt and flatten all…', onClick: onSecondary };
    for (const [connection, system] of [['reconnecting', PAPER], ['unknown', LIVE], ['disconnected', LIVE], ['connected', null]] as const) {
      for (const halt of [false, true]) {
        for (const secondary of [plain, marked]) {
          const b = frame(connection, system, halt, secondary);
          assert.equal(b.getAttribute('aria-disabled'), 'true', `${connection} ${system?.mode ?? 'unknown'} halt=${halt}`);
          click(b);
        }
      }
    }
    assert.equal(onSecondary.mock.calls.length, 0);
    assert.equal(frame('connected', PAPER, true, plain).getAttribute('aria-disabled'), null, 'connected with a known mode: enabled');
    // The type has no such mark.
    // @ts-expect-error a dialog action has no riskReducing (ruling 28)
    const typed: DialogAction = { label: 'More', onClick: onSecondary, riskReducing: true };
    void typed;
  });

  it('Z05 round 4 (ruling 19, with ruling 28): a mode change disables every button but HALT\'s confirm', () => {
    const onSecondary = vi.fn();
    const marked = { label: 'Halt and flatten all…', onClick: onSecondary, riskReducing: true } as unknown as DialogAction;
    const sent = vi.fn();
    function Halt(props: { mode: Mode }): ReactElement {
      return h(HaltDialog, { open: true, connection: 'connected', system: sys(props.mode), description: 'D', secondary: marked, onHalt: haltCommand(sent), onClose: () => undefined });
    }
    const halt = mount(h(Halt, { mode: 'paper' }));
    assert.equal(btn(dialogEl(halt), 'dialog__secondary').getAttribute('aria-disabled'), null, 'before the change');
    halt.rerender(h(Halt, { mode: 'live' }));
    assert.equal(btn(dialogEl(halt), 'dialog__confirm').getAttribute('aria-disabled'), null, 'HALT stays enabled');
    click(btn(dialogEl(halt), 'dialog__confirm'));
    assert.equal(sent.mock.calls.length, 1);
    const flatten = btn(dialogEl(halt), 'dialog__secondary');
    assert.equal(flatten.getAttribute('aria-disabled'), 'true', 'the secondary is disabled in that frame');
    click(flatten);
    function Plain(props: { mode: Mode }): ReactElement {
      return h(Dialog, { open: true, connection: 'connected', system: sys(props.mode), title: 'T', description: 'D', secondary: marked, onClose: () => undefined });
    }
    const plain = mount(h(Plain, { mode: 'paper' }));
    plain.rerender(h(Plain, { mode: 'live' }));
    const wrong = btn(dialogEl(plain), 'dialog__secondary');
    assert.equal(wrong.getAttribute('aria-disabled'), 'true', 'a non-HALT secondary is disabled in that frame');
    click(wrong);
    assert.equal(onSecondary.mock.calls.length, 0);
  });

  it('Z05 round 6 (ruling 28): HaltDialog\'s onHalt takes only a halt command', () => {
    const noop = (): void => undefined;
    // @ts-expect-error a plain function is not a HaltCommand
    const bad: HaltDialogProps = { open: true, connection: 'connected', system: PAPER, description: 'D', onHalt: noop, onClose: noop };
    void bad;
    // @ts-expect-error nor is a close-position action's handler
    const alsoBad: HaltDialogProps['onHalt'] = { label: 'Close position', onClick: noop }.onClick;
    void alsoBad;
    const sent = vi.fn();
    const good: HaltDialogProps = { open: true, inline: true, connection: 'connected', system: PAPER, description: 'D', onHalt: haltCommand(sent), onClose: noop };
    click(btn(mount(h(HaltDialog, good)).container, 'dialog__confirm'));
    assert.deepEqual(sent.mock.calls, [[{ type: 'halt', params: {} }]]);
  });

  it('Z05 round 5 (ruling 23): a free `halt` flag never carries the exemption; HaltDialog owns its title and confirm', () => {
    const onClose = vi.fn();
    const closeAction = vi.fn();
    const haltProps = { halt: true, title: 'Halt trading', description: 'D', confirm: { label: 'Halt now', onClick: () => undefined } };
    for (const [connection, system] of [['reconnecting', PAPER], ['unknown', LIVE], ['disconnected', LIVE], ['connected', null]] as const) {
      // A generic Dialog given HALT's props, then reused for another action, is gated like any money confirm.
      const props = { ...haltProps, open: true, inline: true, connection, system, title: 'Close position', confirm: { label: 'Close position', onClick: closeAction }, onClose } as unknown as DialogProps;
      const r = mount(h(Dialog, props));
      const confirm = btn(r.container, 'dialog__confirm');
      assert.equal(confirm.getAttribute('aria-disabled'), 'true', `${connection} ${system?.mode ?? 'unknown'}`);
      assert.ok(!confirm.classList.contains('btn--danger'), 'no HALT styling either');
      click(confirm);
    }
    assert.equal(closeAction.mock.calls.length, 0);
    // HaltDialog ignores a title or confirm slipped past its type: the confirm is always "Halt now", sending onHalt.
    const sentHalt = vi.fn();
    const onHalt = haltCommand(sentHalt);
    const sneaky = { open: true, inline: true, connection: 'disconnected', system: LIVE, description: 'D', onHalt, onClose, title: 'Close position', confirm: { label: 'Close position', onClick: closeAction } } as unknown as HaltDialogProps;
    const r = mount(h(HaltDialog, sneaky));
    assert.equal(r.container.querySelector('.dialog__title')?.textContent, 'LIVE: Halt trading');
    const haltNow = btn(r.container, 'dialog__confirm');
    assert.equal(haltNow.textContent, 'Halt now');
    assert.equal(haltNow.getAttribute('aria-disabled'), null);
    click(haltNow);
    assert.equal(sentHalt.mock.calls.length, 1);
    assert.equal(closeAction.mock.calls.length, 0);
  });

  it('Z05 round 2 (red team M3): a change to or from an unknown mode is a mode change', () => {
    const onClose = vi.fn();
    function M(props: { system: SystemStateView | null }): ReactElement {
      return h(Harness, { system: props.system, onClose });
    }
    const r = mount(h(M, { system: PAPER }));
    const trigger = r.container.querySelector('#trigger') as HTMLButtonElement;
    click(trigger);
    r.rerender(h(M, { system: null }));
    assert.deepEqual(onClose.mock.calls, [['mode-changed']]);
    assert.equal(r.container.querySelector('.dialog-notice')?.textContent, 'Mode unknown — review again');
    tick(DIALOG_EXIT_MS);
    click(trigger);
    r.rerender(h(M, { system: LIVE }));
    assert.deepEqual(onClose.mock.calls.at(-1), ['mode-changed']);
    assert.equal(r.container.querySelector('.dialog-notice')?.textContent, 'Mode changed to LIVE-SMALL — review again');
  });

  it('Z05 round 2 (red team m3): in the render where the mode changed, confirm is already disabled', () => {
    const onConfirm = vi.fn();
    // A parent that ignores onClose keeps the dialog open: the render itself must still refuse the click.
    function Stuck(props: { mode: Mode }): ReactElement {
      return h(Dialog, { open: true, connection: 'connected', system: sys(props.mode), title: 'T', description: 'D', confirm: { label: 'Go', onClick: onConfirm }, onClose: () => undefined });
    }
    const r = mount(h(Stuck, { mode: 'paper' }));
    assert.equal(btn(dialogEl(r), 'dialog__confirm').getAttribute('aria-disabled'), null);
    r.rerender(h(Stuck, { mode: 'live' }));
    const confirm = btn(dialogEl(r), 'dialog__confirm');
    assert.equal(confirm.getAttribute('aria-disabled'), 'true');
    assert.equal(document.getElementById((confirm.getAttribute('aria-describedby') as string).split(' ')[0] as string)?.textContent, 'The mode changed · review again');
    click(confirm);
    assert.equal(onConfirm.mock.calls.length, 0);
  });

  it('shows the error state with its message and a secondary action', () => {
    const onSecondary = vi.fn();
    const r = mount(h(Dialog, { connection: 'connected',
      open: true, inline: true, system: PAPER, status: 'error', error: 'Timed out.', title: 'T', description: 'D', onClose: () => undefined,
      secondary: { label: 'Halt and flatten all…', onClick: onSecondary }, confirm: { label: 'Go', onClick: () => undefined },
    }));
    const err = r.container.querySelector('.dialog__error') as HTMLElement;
    assert.equal(err.getAttribute('role'), 'alert');
    assert.equal(err.textContent, 'Timed out.');
    click(btn(r.container, 'dialog__secondary'));
    assert.equal(onSecondary.mock.calls.length, 1);
    const blocked = mount(h(Dialog, { connection: 'connected',
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
    mount(h(Dialog, { connection: 'connected', open: true, inline: true, system: PAPER, title: 'T', description: 'D', onClose: () => undefined }));
    assertFocused(outside);
    outside.remove();
  });

  it('closing before the fade ends and reopening keeps the dialog open and the original trigger', () => {
    function Toggle(props: { open: boolean }): ReactElement {
      return h(Dialog, { connection: 'connected', open: props.open, system: PAPER, title: 'T', description: 'D', onClose: () => undefined });
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
    return h(TypedConfirmDialog, { connection: 'connected',
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

  it('a malformed effective time shows as unknown, never a throw, and Cancel stays offered', () => {
    nowMs = at('2026-10-06T14:02:29.123Z');
    const onCancel = vi.fn();
    const r = mount(h(Countdown, { label: 'LIVE-SMALL', effectiveAt: '2026-10-06T14:03:11Z', source: { clock }, onCancel }));
    assert.equal(r.container.querySelector('.countdown__text')?.textContent, 'LIVE-SMALL at an unknown time · waiting for the server');
    click(buttonByText(r.container, 'Cancel'));
    assert.equal(onCancel.mock.calls.length, 1);
    const done = mount(h(Countdown, { label: 'LIVE-SMALL', effectiveAt: 'x', source: { clock }, outcome: 'cancelled', onCancel }));
    assert.equal(buttonByText(done.container, 'Cancel'), undefined);
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

  it('Z05 round 2 (reviewer m3): a refused press, a cancelled press or a lost capture never swallows the next screen-reader click', () => {
    const at = new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 });
    const { b, onOpenDialog, onConfirm } = setup();
    fire(b, pointer('pointerdown', { button: 2 }));
    fire(b, at);
    assert.equal(onOpenDialog.mock.calls.length, 1, 'a secondary-button press marks nothing');
    fire(b, pointer('pointerdown'));
    tick(300);
    fire(b, pointer('pointercancel'));
    fire(b, new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }));
    assert.equal(onOpenDialog.mock.calls.length, 2, 'after a touch cancel');
    tick(HOLD_REWIND_MS);
    fire(b, pointer('pointerdown'));
    fire(b, pointer('lostpointercapture'));
    fire(b, new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }));
    assert.equal(onOpenDialog.mock.calls.length, 3, 'after a lost capture with no pointer up');
    const sending = setup('sending');
    fire(sending.b, pointer('pointerdown'));
    fire(sending.b, new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }));
    assert.equal(sending.onOpenDialog.mock.calls.length, 1, 'a press refused while sending marks nothing');
    tick(HOLD_TO_CONFIRM_MS);
    assert.equal(onConfirm.mock.calls.length, 0);
  });

  it('Z05 round 2: the click after a pointer up is the press\'s own; if it never comes, the mark expires', () => {
    const { b, onOpenDialog } = setup();
    fire(b, pointer('pointerdown'));
    tick(200);
    fire(b, pointer('pointerup'));
    fire(b, pointer('lostpointercapture'));
    fire(b, new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
    assert.equal(onOpenDialog.mock.calls.length, 0, 'lost capture after the up keeps the mark for its click');
    click(b);
    assert.equal(onOpenDialog.mock.calls.length, 1, 'the next click is a new activation');
    tick(HOLD_REWIND_MS);
    fire(b, pointer('pointerdown'));
    fire(b, pointer('pointerup'));
    tick(CLICK_AFTER_UP_MS);
    click(b);
    assert.equal(onOpenDialog.mock.calls.length, 2, 'no click came after the up: the mark expired');
  });

  it('Z05 round 2 (red team m4): a move over 10 px or leaving the button cancels a hold; a small move does not', () => {
    const { b, onConfirm } = setup();
    fire(b, pointer('pointerdown', { clientX: 100, clientY: 100 }));
    fire(b, pointer('pointermove', { clientX: 106, clientY: 108 }));
    tick(HOLD_TO_CONFIRM_MS);
    assert.equal(onConfirm.mock.calls.length, 1, 'a 10 px move is a hold');
    fire(b, pointer('pointerup'));
    click(b);
    tick(HOLD_REWIND_MS);
    fire(b, pointer('pointerdown', { clientX: 100, clientY: 100 }));
    tick(400);
    fire(b, pointer('pointermove', { clientX: 100, clientY: 111 }));
    assert.equal(b.dataset['state'], 'released-early');
    fire(b, pointer('pointermove', { clientX: 100, clientY: 140 }));
    tick(HOLD_TO_CONFIRM_MS);
    assert.equal(onConfirm.mock.calls.length, 1, 'a scroll is not a hold');
    tick(HOLD_REWIND_MS);
    fire(b, pointer('pointerdown'));
    tick(400);
    // React builds onPointerLeave from pointerout with a target outside the button.
    fire(b, pointer('pointerout', { relatedTarget: document.body }));
    tick(HOLD_TO_CONFIRM_MS);
    assert.equal(onConfirm.mock.calls.length, 1, 'leaving the button is not a hold');
  });

  it('Z05 round 3 (ruling 13): a press cancelled by a move keeps its click: released on the button, it opens no dialog', () => {
    const { b, onConfirm, onOpenDialog } = setup();
    fire(b, pointer('pointerdown', { clientX: 100, clientY: 100 }));
    tick(300);
    fire(b, pointer('pointermove', { clientX: 100, clientY: 115 }));
    assert.equal(b.dataset['state'], 'released-early');
    fire(b, pointer('pointerup', { clientX: 100, clientY: 115 }));
    fire(b, new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
    assert.equal(onOpenDialog.mock.calls.length, 0, 'the click of a scrolled press opens nothing');
    tick(HOLD_TO_CONFIRM_MS);
    assert.equal(onConfirm.mock.calls.length, 0);
    click(b);
    assert.equal(onOpenDialog.mock.calls.length, 1, 'the next activation still opens the dialog');
    // The same for leaving the button, and the claim still expires 1 s after the pointer up.
    tick(HOLD_REWIND_MS);
    fire(b, pointer('pointerdown'));
    fire(b, pointer('pointerout', { relatedTarget: document.body }));
    fire(b, pointer('pointerup'));
    fire(b, new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
    assert.equal(onOpenDialog.mock.calls.length, 1);
    fire(b, pointer('pointerdown', { clientX: 0, clientY: 0 }));
    fire(b, pointer('pointermove', { clientX: 0, clientY: 50 }));
    fire(b, pointer('pointerup'));
    tick(CLICK_AFTER_UP_MS);
    click(b);
    assert.equal(onOpenDialog.mock.calls.length, 2, 'no click came: the claim expired');
  });

  it('Z05 round 4 (ruling 18, with ruling 22): with no pointer capture, a press moved away and lifted outside the button does not swallow a later click', () => {
    for (const away of ['move', 'leave'] as const) {
      const { b, onConfirm, onOpenDialog } = setup();
      // No setPointerCapture: the pointer up lands outside the button, so the button sees no pointerup and no click.
      Object.defineProperty(b, 'setPointerCapture', { value: undefined, configurable: true });
      fire(b, pointer('pointerdown', { clientX: 100, clientY: 100 }));
      tick(300);
      if (away === 'move') fire(b, pointer('pointermove', { clientX: 100, clientY: 140 }));
      else fire(b, pointer('pointerout', { relatedTarget: document.body }));
      assert.equal(b.dataset['state'], 'released-early', away);
      // The pointer lifts outside the button: only the page sees the pointer up (ruling 22).
      fire(document.body, pointer('pointerup'));
      tick(CLICK_AFTER_UP_MS);
      // A screen reader's activation: a click no pointer press started.
      fire(b, new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }));
      assert.equal(onOpenDialog.mock.calls.length, 1, `${away}: the later click opens the HALT dialog`);
      assert.equal(onConfirm.mock.calls.length, 0, away);
    }
  });

  it('Z05 round 5 (ruling 22): the claim is kept while the pointer is down, so a long scroll released on the button opens no dialog', () => {
    const { b, onConfirm, onOpenDialog } = setup();
    fire(b, pointer('pointerdown', { clientX: 100, clientY: 100 }));
    fire(b, pointer('pointermove', { clientX: 100, clientY: 130 }));
    assert.equal(b.dataset['state'], 'released-early');
    tick(CLICK_AFTER_UP_MS + 500);
    fire(b, pointer('pointerup', { clientX: 100, clientY: 130 }));
    fire(b, new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
    assert.equal(onOpenDialog.mock.calls.length, 0, 'held more than 1 s after the drag, released on the button: no dialog');
    assert.equal(onConfirm.mock.calls.length, 0);
    // The same after leaving the button and coming back.
    tick(HOLD_REWIND_MS);
    fire(b, pointer('pointerdown'));
    fire(b, pointer('pointerout', { relatedTarget: document.body }));
    tick(CLICK_AFTER_UP_MS * 3);
    fire(b, pointer('pointerup'));
    fire(b, new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
    assert.equal(onOpenDialog.mock.calls.length, 0, 'left and came back');
    // A pointer up of another pointer elsewhere does not end the claim.
    fire(b, pointer('pointerdown', { clientX: 0, clientY: 0 }));
    fire(b, pointer('pointermove', { clientX: 0, clientY: 50 }));
    fire(document.body, pointer('pointerup', { pointerId: 2 }));
    tick(CLICK_AFTER_UP_MS * 2);
    fire(b, pointer('pointerup'));
    fire(b, new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
    assert.equal(onOpenDialog.mock.calls.length, 0, 'another pointer');
    // After the claimed click, the next activation opens the dialog.
    click(b);
    assert.equal(onOpenDialog.mock.calls.length, 1);
  });

  it('Z05 round 6 (ruling 27): a touch that leaves the button and is cancelled elsewhere does not swallow a later click', () => {
    const { b, onConfirm, onOpenDialog } = setup();
    Object.defineProperty(b, 'setPointerCapture', { value: undefined, configurable: true });
    fire(b, pointer('pointerdown', { pointerType: 'touch' }));
    fire(b, pointer('pointerout', { pointerType: 'touch', relatedTarget: document.body }));
    // Another pointer's cancel changes nothing.
    fire(document.body, pointer('pointercancel', { pointerId: 2 }));
    fire(document.body, pointer('pointercancel', { pointerType: 'touch' }));
    // A screen reader's activation right after: a click no pointer press started.
    fire(b, new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }));
    assert.equal(onOpenDialog.mock.calls.length, 1, 'the click opens the HALT dialog at once');
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

  it('Z05 round 2 (reviewer m1): every fixture carries every VM-03 field (UI.md VM-03 table)', () => {
    const FIELDS = ['schema_version', 'state_version', 'mode', 'simulated', 'mode_since', 'run_id', 'trading_state', 'trading_state_changed_at',
      'kill', 'signer', 'live_caps', 'scheduled_change', 'strategies', 'sim_clock', 'versions', 'trading_wallet_pubkey'].sort();
    const KILL = ['halted_by', 'latch_set_by', 'latch_clear_requires', 'reason_code', 'reason_text', 'components'].sort();
    for (const file of fixtures) {
      const vm = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Record<string, unknown> & { kill: Record<string, unknown>; signer: object; live_caps: object; versions: object };
      assert.deepEqual(Object.keys(vm).sort(), FIELDS, file);
      assert.deepEqual(Object.keys(vm.kill).sort(), KILL, file);
      assert.deepEqual(Object.keys(vm.signer).sort(), ['exit_lease_holder', 'lock'], file);
      assert.deepEqual(Object.keys(vm.live_caps).sort(), ['max_daily_loss_lamports', 'max_open_positions', 'max_trade_lamports'], file);
      assert.deepEqual(Object.keys(vm.versions).sort(), ['bot', 'config'], file);
    }
  });

  for (const file of fixtures) {
    it(`${file}: the HALT and typed dialogs take the fixture's mode`, () => {
      const vm = JSON.parse(readFileSync(join(dir, file), 'utf8')) as SystemStateView;
      const system: SystemStateView = { state_version: vm.state_version, mode: vm.mode, simulated: vm.simulated, trading_state: vm.trading_state };
      const halt = mount(h(HaltDialog, { connection: 'connected', open: true, inline: true, system, description: 'D', onHalt: haltCommand(() => undefined), onClose: () => undefined }));
      assert.equal(halt.container.querySelector('.dialog__title')?.textContent, `${PREFIX[vm.mode]} Halt trading`);
      assert.equal(halt.container.querySelector('dialog')?.dataset['mode'], vm.mode);
      const typed = mount(h(TypedConfirmDialog, { connection: 'connected',
        open: true, inline: true, system, actionClass: 'A2', requiredPhrase: 'RESUME', actionName: 'the resume', title: 'Resume trading', description: 'D',
        confirmLabel: 'Resume', onConfirm: () => undefined, onClose: () => undefined,
      }));
      assert.equal(typed.container.querySelector('dialog')?.classList.contains('dialog--live'), vm.mode === 'live' || vm.mode === 'live_small');
    });
  }

  it.todo('the VM-03 fixtures validate against the @bot/contract VM-03 schema: waits for B-M28-01 (card Z02), which exports the VM schemas; @bot/contract has no VM-03 schema yet');
});
