// Dialog family (UI-T07): Dialog/AlertDialog (C15), TypedConfirmDialog (C16) and StepUpAuth (C17, presentation only).
// Presentational and accessible; wiring to commands is UI-T13.
// - A native <dialog> opened with showModal(): the rest of the page is inert, and Tab and Shift+Tab also wrap inside the
//   dialog, so focus never leaves it. role="alertdialog" for destructive and money-affecting dialogs, aria-modal,
//   aria-labelledby (the title) and aria-describedby (the description).
// - Initial focus is on the least destructive action (Cancel), except HALT, where "Halt now" receives focus because
//   halting reduces risk. On close, focus returns to the control that had it when the dialog opened.
// - Mode-aware from VM-03: a money-affecting title starts with "Replay:", "Paper:" or "LIVE:", and live dialogs carry
//   the orchid top border. If the mode changes while the dialog is open, it closes and says "Mode changed to X —
//   review again" next to the control that opened it.
// - While the stream is disconnected, a non-HALT dialog says "Disconnected · cannot confirm current state" and its
//   submit is disabled; HALT stays enabled (UI.md HALT flow). Only HaltDialog is HALT: it owns its title and its
//   confirm, and the generic Dialog never exempts an action (Z05 round 5, ruling 23).
// - No native modal library: Radix Dialog's modal mode injects a <style> element, which the dashboard CSP refuses
//   (style-src 'self'; VERIFY.md C05, Radix menus).
import { createElement as h, Fragment, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactElement, type ReactNode } from 'react';
import { CircleCheck, CircleX, TriangleAlert } from 'lucide-react';
import type { Mode } from '@bot/types';
import {
  checkPhrase, DIALOG_EXIT_MS, DIALOG_TITLE_PREFIX, MODE_CHANGED_CONFIRM_TEXT, modeChangedText, modeTone, unknownStateReason,
  type ConnectionView, type SystemStateView,
} from '../lib/safety.ts';
import type { HaltCommand } from '../lib/halt-command.ts';
import { Button, type ButtonVariant } from './button.ts';
import { Countdown, type CountdownProps } from './countdown.ts';
import { cx } from './cx.ts';
import { TextInput } from './field.ts';
import { Icon, Spinner, STATE_ICONS } from './icon.ts';
import { Banner } from './status.ts';

export type DialogKind = 'standard' | 'alert';
/** C15 states while shown; `closing` is the exit fade after `open` turns false. */
export type DialogStatus = 'open' | 'submitting' | 'error';
export type CloseReason = 'cancel' | 'escape' | 'mode-changed';
export type { ConnectionView };

/** An action of a dialog. A secondary action is always gated like a money-affecting confirm (Z05 round 6, ruling 28). */
export interface DialogAction {
  label: ReactNode;
  onClick: () => void;
  variant?: ButtonVariant;
  disabledReason?: string;
}

export interface DialogBaseProps {
  open: boolean;
  title: string;
  description: ReactNode;
  children?: ReactNode;
  /** `alert` (default): role="alertdialog", for destructive and money-affecting dialogs. */
  kind?: DialogKind;
  /** Money-affecting (default true): the title carries the mode prefix and a live dialog the orchid border. */
  moneyAffecting?: boolean;
  /** VM-03; null while the mode is unknown. */
  system: SystemStateView | null;
  /** The stream's state. Required: a money-affecting dialog fails closed unless it is `connected`. */
  connection: ConnectionView;
  confirm?: DialogAction;
  cancelLabel?: string;
  status?: DialogStatus;
  /** The error shown when status is `error`. */
  error?: string;
  /** Extra class on the dialog. */
  className?: string;
  /**
   * Shown in place without showModal (the catalogue's galleries, which show many states at once): no inert page, no
   * focus move, no aria-modal. The app never sets it.
   */
  inline?: boolean;
  onClose(reason: CloseReason): void;
}

/** Every dialog but HALT's: no action is exempt from the fail-closed gates (Z05 round 5, ruling 23). */
export interface DialogProps extends DialogBaseProps {
  /** Another action between cancel and confirm, gated like confirm. */
  secondary?: DialogAction;
}

/** The HALT dialog's title and confirm label (UI.md HALT flow). */
export const HALT_TITLE = 'Halt trading';
export const HALT_CONFIRM_LABEL = 'Halt now';

/**
 * The HALT dialog (UI.md HALT flow). It owns its title and its confirm, which sends the halt command (`onHalt`), so
 * the exemption from the fail-closed gates cannot be given to any other action (Z05 round 5, ruling 23).
 */
export interface HaltDialogProps extends Omit<DialogBaseProps, 'title' | 'confirm' | 'kind' | 'moneyAffecting' | 'children'> {
  /** Sends the halt command: only `haltCommand` (lib/halt-command.ts) makes one (Z05 round 6, ruling 28). */
  onHalt: HaltCommand;
  /** "Halt and flatten all…" (the A2 flatten flow): always gated, like any money-affecting action. */
  secondary?: DialogAction;
}

/** What the shared dialog body renders: `halt` is set only by HaltDialog. */
interface DialogViewProps extends DialogBaseProps {
  halt: boolean;
  secondary?: DialogAction | undefined;
}

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** The focusable controls inside `root`, in tab order (enabled, not hidden by aria-hidden). */
function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !(el as HTMLButtonElement).disabled && el.closest('[aria-hidden="true"]') === null);
}

/** The title prefix of a dialog in `mode` (none for a dialog that does not affect money, or while the mode is unknown). */
export function titlePrefix(mode: Mode | null, moneyAffecting: boolean): string | null {
  return !moneyAffecting || mode === null ? null : DIALOG_TITLE_PREFIX[modeTone(mode)];
}

type Phase = 'closed' | 'open' | 'closing';

/** A dialog (C15). Never exempt: a `halt` key from any caller is overridden here. */
export function Dialog(props: DialogProps): ReactElement {
  return h(DialogView, { ...props, halt: false });
}

/** The HALT dialog: initial focus on "Halt now", which stays enabled while disconnected or the mode is unknown. */
export function HaltDialog(props: HaltDialogProps): ReactElement {
  return h(DialogView, {
    ...props, halt: true, kind: 'alert', moneyAffecting: true, title: HALT_TITLE,
    confirm: { label: HALT_CONFIRM_LABEL, onClick: props.onHalt },
  });
}

function DialogView(props: DialogViewProps): ReactElement {
  const id = useId();
  const ref = useRef<HTMLDialogElement>(null);
  const [phase, setPhase] = useState<Phase>('closed');
  const [notice, setNotice] = useState<string | null>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  /** The mode when the dialog opened; null is a known "unknown". Read in render to disable confirm after a change. */
  const openedMode = useRef<Mode | null>(null);
  const moneyAffecting = props.moneyAffecting ?? true;
  const mode = props.system?.mode ?? null;
  const status = props.status ?? 'open';
  const busy = status === 'submitting';
  // Fail closed (Z05 round 2, red team M3): a money-affecting non-HALT confirm needs a connected stream and a known mode.
  const unknownReason = moneyAffecting && !props.halt ? unknownStateReason(props.connection, mode)
    : props.connection === 'disconnected' && !props.halt ? unknownStateReason('disconnected', mode) : undefined;
  const { onClose } = props;

  // Open: remember the control to return to and the mode, then show modally and focus the initial action.
  useLayoutEffect(() => {
    const el = ref.current;
    if (props.inline === true || !props.open || el === null || phase === 'open') return;
    if (phase === 'closed') {
      const active = document.activeElement;
      returnTo.current = active instanceof HTMLElement && active !== document.body ? active : null;
    }
    openedMode.current = mode;
    setNotice(null);
    if (!el.open) el.showModal();
    setPhase('open');
    const initial = el.querySelector<HTMLElement>(props.halt ? 'button.dialog__confirm' : 'button.dialog__cancel');
    (initial ?? focusables(el)[0] ?? el).focus();
  }, [props.open, phase, mode, props.halt]);

  // Close: fade out, then close the native dialog and return focus. Reopening during the fade cancels the close.
  useEffect(() => {
    if (!props.open && phase === 'open') setPhase('closing');
  }, [props.open, phase]);
  useEffect(() => {
    if (props.open || phase !== 'closing') return undefined;
    const timer = setTimeout(() => {
      setPhase('closed');
      const back = returnTo.current;
      returnTo.current = null;
      // Only when focus is still ours to give back: in this dialog, or nowhere (another dialog may have taken it).
      const active = document.activeElement;
      const ours = active === null || active === document.body || ref.current?.contains(active) === true;
      ref.current?.close();
      if (ours && back?.isConnected === true) back.focus();
    }, DIALOG_EXIT_MS);
    return () => clearTimeout(timer);
  }, [props.open, phase]);

  // A mode change while open closes the dialog with a notice (the operator must review the action in the new mode).
  useEffect(() => {
    // A change from or to an unknown mode is a mode change too (Z05 round 2, red team M3).
    if (phase !== 'open' || !props.open || mode === openedMode.current) return;
    setNotice(modeChangedText(mode));
    onClose('mode-changed');
  }, [mode, phase, props.open, onClose]);

  // Esc arrives as the dialog's cancel event (and as a keydown in browsers that send one first): close through onClose.
  useEffect(() => {
    const el = ref.current;
    if (el === null) return undefined;
    const cancel = (e: Event): void => { e.preventDefault(); if (!busy) onClose('escape'); };
    el.addEventListener('cancel', cancel);
    return () => el.removeEventListener('cancel', cancel);
  }, [busy, onClose, phase]);

  const onKeyDown = (e: KeyboardEvent<HTMLDialogElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (!busy && phase === 'open') onClose('escape');
      return;
    }
    if (e.key !== 'Tab') return;
    const list = focusables(e.currentTarget);
    const first = list[0];
    const last = list.at(-1);
    if (first === undefined || last === undefined) { e.preventDefault(); return; }
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !e.currentTarget.contains(active))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (active === last || !e.currentTarget.contains(active))) { e.preventDefault(); first.focus(); }
  };

  const prefix = titlePrefix(mode, moneyAffecting);
  const live = moneyAffecting && mode !== null && modeTone(mode) === 'live';
  const confirm = props.confirm;
  const inline = props.inline === true;
  // In the frame between a mode change and the close, confirm is already disabled (Z05 round 2, red team m3).
  // HALT's confirm alone stays enabled in that frame (Z05 round 4, ruling 19): halting is always allowed.
  const modeMoved = !inline && phase !== 'closed' && mode !== openedMode.current;
  const confirmReason = modeMoved && !props.halt ? MODE_CHANGED_CONFIRM_TEXT : unknownReason ?? confirm?.disabledReason;
  // The secondary action is gated like a money-affecting confirm, in every dialog: HALT's "Halt and flatten all…" is the
  // A2 flatten flow and sells (Z05 round 6, ruling 28: no action but HALT's confirm is ever exempt).
  const secondary = props.secondary;
  const secondaryGate = moneyAffecting ? unknownStateReason(props.connection, mode)
      : props.connection === 'disconnected' ? unknownStateReason('disconnected', mode) : undefined;
  const secondaryReason = modeMoved ? MODE_CHANGED_CONFIRM_TEXT : secondaryGate ?? secondary?.disabledReason;
  const rendered = props.open || phase !== 'closed';
  return h(Fragment, null,
    notice === null ? null : h('p', { className: 'dialog-notice', role: 'alert' }, h(Icon, { icon: STATE_ICONS['warning'] as typeof TriangleAlert }), notice),
    rendered ? h('dialog', {
      ref,
      className: cx('dialog', `dialog--${props.kind ?? 'alert'}`, live && 'dialog--live', props.className),
      role: (props.kind ?? 'alert') === 'alert' ? 'alertdialog' : 'dialog',
      'aria-modal': inline ? undefined : 'true',
      open: inline ? true : undefined,
      'aria-labelledby': `${id}-title`,
      'aria-describedby': `${id}-desc`,
      'data-state': phase === 'closing' ? 'closing' : status,
      'data-inline': inline || undefined,
      'data-mode': mode ?? 'unknown',
      onKeyDown,
    },
    h('h2', { id: `${id}-title`, className: 'dialog__title' },
      prefix === null ? null : h('span', { className: 'dialog__prefix' }, prefix), prefix === null ? null : ' ', props.title),
    h('div', { id: `${id}-desc`, className: 'dialog__description' }, props.description),
    unknownReason === undefined ? null : h(Banner, { tone: 'disconnected', title: unknownReason }),
    props.children === undefined ? null : h('div', { className: 'dialog__body' }, props.children),
    status === 'error' && props.error !== undefined
      ? h('p', { className: 'dialog__error', role: 'alert' }, h(Icon, { icon: CircleX }), props.error) : null,
    h('div', { className: 'dialog__actions' },
      h(Button, {
        variant: 'secondary', className: 'dialog__cancel', onClick: () => onClose('cancel'),
        ...(busy ? { disabledReason: 'Waiting for the server' } : {}),
      }, props.cancelLabel ?? 'Cancel'),
      secondary === undefined ? null : h(Button, {
        variant: secondary.variant ?? 'secondary', className: 'dialog__secondary', onClick: secondary.onClick,
        ...(secondaryReason === undefined ? {} : { disabledReason: secondaryReason }),
      }, secondary.label),
      confirm === undefined ? null : h(Button, {
        variant: confirm.variant ?? (props.halt ? 'danger' : live ? 'live-confirm' : 'primary'),
        className: 'dialog__confirm',
        onClick: confirm.onClick,
        ...(busy ? { status: 'pending' as const } : {}),
        ...(confirmReason === undefined ? {} : { disabledReason: confirmReason }),
      }, confirm.label, live && !props.halt ? h('span', { className: 'btn__sublabel' }, 'real funds') : null))) : null);
}

export type StepUpStatus = 'prompting' | 'success' | 'cancelled' | 'failed' | 'unsupported';

export interface StepUpAuthProps { status: StepUpStatus; onRetry?: () => void; onCancel?: () => void }

const STEP_UP_TEXT: Readonly<Record<StepUpStatus, { title: string; body: string }>> = {
  prompting: { title: 'Confirm with your passkey', body: 'Follow the prompt from your browser or device.' },
  success: { title: 'Passkey confirmed', body: 'You can continue.' },
  cancelled: { title: 'Passkey check cancelled', body: 'Nothing was sent. Try again to continue.' },
  failed: { title: 'Passkey check failed', body: 'Nothing was sent. Try again, or cancel.' },
  unsupported: {
    title: 'Passkeys are not available in this browser',
    body: 'Open the dashboard in a current browser on a device where your passkey is set up. Halting needs no passkey.',
  },
};

/** StepUpAuth (C17), presentation only: the WebAuthn call is UI-T09. */
export function StepUpAuth(props: StepUpAuthProps): ReactElement {
  const text = STEP_UP_TEXT[props.status];
  const icon = props.status === 'prompting' ? h(Spinner)
    : h(Icon, { icon: props.status === 'success' ? CircleCheck : props.status === 'failed' ? CircleX : STATE_ICONS['step-up'] as typeof CircleX });
  const retry = (props.status === 'cancelled' || props.status === 'failed') && props.onRetry !== undefined;
  return h('div', { className: cx('step-up', `step-up--${props.status}`), role: props.status === 'failed' ? 'alert' : 'status', 'data-state': props.status },
    h('span', { className: 'step-up__icon' }, icon),
    h('div', { className: 'step-up__text' }, h('p', { className: 'step-up__title' }, text.title), h('p', { className: 'step-up__body' }, text.body)),
    retry || (props.onCancel !== undefined && props.status !== 'success')
      ? h('div', { className: 'step-up__actions' },
        retry ? h(Button, { variant: 'secondary', size: 'sm', onClick: props.onRetry as () => void }, 'Try again') : null,
        props.onCancel !== undefined && props.status !== 'success' ? h(Button, { variant: 'ghost', size: 'sm', onClick: props.onCancel }, 'Cancel') : null)
      : null);
}

/** C16 states once the phrase matches and the operator confirms; `editing` shows the phrase states (empty, mismatch, match). */
export type TypedConfirmStatus = 'editing' | 'step-up-required' | 'submitting' | 'scheduled' | 'cancelled' | 'executed' | 'rejected' | 'unknown-outcome';

export interface TypedConfirmDialogProps extends Omit<DialogBaseProps, 'confirm' | 'status' | 'kind' | 'error'> {
  /** Another action between cancel and confirm; never risk-reducing (a typed confirm is never HALT). */
  secondary?: DialogAction;
  actionClass: 'A2' | 'A3';
  /** The exact phrase, with its dynamic part (`LIVE-SMALL 0.25`). */
  requiredPhrase: string;
  /** What the action is called in the outcome text ("the switch to LIVE-SMALL"). */
  actionName: string;
  confirmLabel: string;
  onConfirm(): void;
  status?: TypedConfirmStatus;
  /** The server's reason, shown verbatim when status is `rejected`. */
  rejectReason?: string;
  stepUp?: StepUpStatus;
  onStepUpRetry?: () => void;
  /** The scheduled change (status `scheduled`). */
  countdown?: CountdownProps;
  /** The phrase typed so far (a controlled input); the dialog keeps its own when omitted. */
  phrase?: string;
  onPhraseChange?: (value: string) => void;
}

const FINAL: ReadonlySet<TypedConfirmStatus> = new Set(['scheduled', 'cancelled', 'executed', 'rejected', 'unknown-outcome']);

function PhraseHint(props: { required: string; typed: string }): ReactElement {
  const check = checkPhrase(props.typed, props.required);
  return h('div', { className: 'phrase', 'data-state': check.state },
    h('p', { className: 'phrase__target', 'aria-hidden': true },
      check.marks.map((m, i) => h('span', { key: i, className: `phrase__char phrase__char--${m.mark}` }, m.char === ' ' ? ' ' : m.char)),
      check.extra > 0 ? h('span', { className: 'phrase__extra' }, `+${check.extra}`) : null));
}

/** TypedConfirmDialog (C16): confirm stays disabled until the trimmed input equals the phrase exactly, case included. */
export function TypedConfirmDialog(props: TypedConfirmDialogProps): ReactElement {
  const [own, setOwn] = useState('');
  const typed = props.phrase ?? own;
  const setTyped = (v: string): void => { if (props.phrase === undefined) setOwn(v); props.onPhraseChange?.(v); };
  useEffect(() => { if (props.open) setOwn(''); }, [props.open]);
  const status = props.status ?? 'editing';
  const check = checkPhrase(typed, props.requiredPhrase);
  const final = FINAL.has(status);
  const editing = status === 'editing' || status === 'step-up-required' || status === 'submitting';
  const tone = check.state === 'mismatch' && (check.extra > 0 || check.marks.some((m) => m.mark === 'wrong' || m.mark === 'case')) ? 'invalid' as const : undefined;
  const result = ((): ReactNode => {
    switch (status) {
      case 'scheduled': return props.countdown === undefined ? null : h(Countdown, props.countdown);
      case 'cancelled': return h('p', { className: 'dialog__result', role: 'status' }, 'Cancelled. Nothing changed.');
      case 'executed': return h('p', { className: 'dialog__result dialog__result--done', role: 'status' }, h(Icon, { icon: CircleCheck }), 'Done. The change is in the audit log.');
      case 'rejected': return h(Banner, { tone: 'danger', title: 'The server refused this' }, props.rejectReason ?? '');
      case 'unknown-outcome': return h(Banner, { tone: 'warning', title: 'Outcome unknown' }, `We could not confirm whether ${props.actionName} was applied. Checking…`);
      default: return null;
    }
  })();
  const { requiredPhrase, actionClass, actionName, confirmLabel, onConfirm, rejectReason, stepUp, onStepUpRetry, countdown, phrase, onPhraseChange, ...dialog } = props;
  return h(Dialog, {
    ...dialog,
    kind: 'alert',
    className: cx('typed-confirm', props.className),
    status: status === 'submitting' ? 'submitting' : 'open',
    ...(final ? { cancelLabel: 'Close' } : {}),
    ...(final ? {} : {
      confirm: {
        label: confirmLabel,
        onClick: onConfirm,
        ...(check.state === 'match' ? {} : { disabledReason: 'Type the phrase exactly to confirm' }),
      },
    }),
  },
  h('div', { className: 'typed-confirm__body', 'data-class': actionClass, 'data-state': editing ? (status === 'editing' ? check.state : status) : status },
    props.children,
    editing ? h(TextInput, {
      label: `Type ${props.requiredPhrase} to confirm`,
      value: typed,
      onChange: setTyped,
      message: check.hint,
      ...(tone === undefined ? {} : { tone }),
      ...(status === 'submitting' ? { readOnly: true } : {}),
      extra: h(PhraseHint, { required: props.requiredPhrase, typed }),
    }) : null,
    status === 'step-up-required' ? h(StepUpAuth, { status: stepUp ?? 'prompting', ...(onStepUpRetry === undefined ? {} : { onRetry: onStepUpRetry }) }) : null,
    result));
}
