// Catalogue sections for UI-T07. "Dialogs" shows every state of C03, C15, C16, C17, C38 and C44 in paper and in live,
// as in-place frames (many dialogs cannot be modal at once). "Open dialog" (standalone) is the working flow for the
// browser tests: the HALT HoldButton, the HALT dialog, an A3 typed confirmation and a standard dialog, opened modally.
// `?mode=` (paper, live_small, live, replay, or unknown) and `?connection=` (disconnected, reconnecting, unknown) set the demo's VM-03 and stream state; a
// `catalogue:set-mode` event with a mode in `detail` changes the mode while a dialog is open.
import { createElement as h, Fragment, useEffect, useState, type ReactElement, type ReactNode } from 'react';
import type { Clock, Mode, UnixMs } from '@bot/types';
import { Button } from '../../components/button.ts';
import { Countdown } from '../../components/countdown.ts';
import { Dialog, HaltDialog, StepUpAuth, TypedConfirmDialog, type ConnectionView, type StepUpStatus, type TypedConfirmStatus } from '../../components/dialog.ts';
import { DiffView, type DiffLine } from '../../components/diff-view.ts';
import { HoldButton, type HoldServerStatus } from '../../components/hold-button.ts';
import { haltCommand } from '../../lib/halt-command.ts';
import { MODE_NAME, type SystemStateView } from '../../lib/safety.ts';
import type { Section } from '../catalogue.ts';

const PAPER: SystemStateView = { state_version: '101', mode: 'paper', simulated: true, trading_state: 'running' };
const LIVE: SystemStateView = { state_version: '102', mode: 'live_small', simulated: false, trading_state: 'running' };
const MODES: ReadonlyArray<[string, SystemStateView]> = [['Paper', PAPER], ['Live', LIVE]];

/** The demo's fixed "now" and a scheduled change 42 s after it (screenshots do not change). */
const DEMO_NOW = Date.parse('2026-10-06T14:02:29.123Z');
const demoClock: Clock = { nowMs: () => DEMO_NOW as UnixMs, kind: 'wall' };
const EFFECTIVE_AT = '2026-10-06T14:03:11.123Z';

const LIMIT_LINES: readonly DiffLine[] = [
  { key: 'max_position', label: 'Max position', before: '0.25', after: '0.30', unit: 'SOL', direction: 'raises' },
  { key: 'daily_loss', label: 'Daily loss', before: '0.60', after: '0.50', unit: 'SOL', direction: 'lowers' },
  { key: 'slippage', label: 'Max slippage', before: '150', after: '150', unit: 'bps', direction: 'neutral' },
];

const noop = (): void => undefined;

function Frame(props: { title: string; children?: ReactNode }): ReactElement {
  return h('div', { className: 'demo demo--dialog' }, h('h3', { className: 'demo__title' }, props.title), props.children);
}

const HALT_TEXT = 'Stop new entries and cancel queued entries. Open positions (3) keep their stops and targets. This does not sell anything.';

function HaltDemo(props: { open: boolean; system: SystemStateView | null; connection?: ConnectionView; inline?: boolean; onClose: () => void; onConfirm: () => void }): ReactElement {
  return h(HaltDialog, {
    open: props.open, system: props.system, description: HALT_TEXT,
    connection: props.connection ?? 'connected', ...(props.inline === true ? { inline: true } : {}),
    secondary: { label: 'Halt and flatten all…', onClick: noop },
    onHalt: haltCommand(() => props.onConfirm()),
    onClose: props.onClose,
  });
}

function LiveSwitchBody(): ReactElement {
  return h(DiffView, { kind: 'limits', lines: [{ key: 'mode', label: 'Mode', before: 'PAPER', after: 'LIVE-SMALL', unit: '', direction: 'raises' }] });
}

function TypedFrame(props: { system: SystemStateView; status: TypedConfirmStatus; phrase: string; stepUp?: StepUpStatus }): ReactElement {
  return h(TypedConfirmDialog, {
    open: true, inline: true, connection: 'connected', system: props.system, actionClass: 'A3', requiredPhrase: 'LIVE-SMALL 0.25', actionName: 'the switch to LIVE-SMALL',
    title: 'Switch to LIVE-SMALL', description: 'Real funds, at most 0.25 SOL per trade and 2 open positions.', confirmLabel: 'Switch mode',
    phrase: props.phrase, status: props.status, onConfirm: noop, onClose: noop,
    ...(props.stepUp === undefined ? {} : { stepUp: props.stepUp }),
    ...(props.status === 'rejected' ? { rejectReason: 'Readiness gate P-6 is failing: 91.2% of simulations succeeded (95% needed).' } : {}),
    countdown: { label: 'LIVE-SMALL', effectiveAt: EFFECTIVE_AT, source: { clock: demoClock }, onCancel: noop },
  }, h(LiveSwitchBody));
}

const TYPED_STATES: ReadonlyArray<[string, TypedConfirmStatus, string, StepUpStatus?]> = [
  ['Empty', 'editing', ''], ['Mismatch (letter case)', 'editing', 'live-small 0.25'], ['Mismatch (partial)', 'editing', 'LIVE-SM'],
  ['Match', 'editing', 'LIVE-SMALL 0.25'], ['Step-up required', 'step-up-required', 'LIVE-SMALL 0.25', 'prompting'],
  ['Submitting', 'submitting', 'LIVE-SMALL 0.25'], ['Scheduled', 'scheduled', ''], ['Cancelled', 'cancelled', ''],
  ['Executed', 'executed', ''], ['Rejected', 'rejected', ''], ['Outcome unknown', 'unknown-outcome', ''],
];

function ModeGallery(props: { label: string; system: SystemStateView }): ReactElement {
  const s = props.system;
  return h('div', { className: 'dialog-gallery', 'data-mode': s.mode },
    h('h3', { className: 'tokens__heading' }, `${props.label}: dialogs`),
    h('div', { className: 'dialog-gallery__grid' },
      h(Frame, { title: 'Dialog, open' }, h(Dialog, { open: true, inline: true, connection: 'connected', system: s, title: 'Close position', description: 'Sell 1,234,567 BONK at market now.', confirm: { label: 'Close position', onClick: noop }, onClose: noop })),
      h(Frame, { title: 'Dialog, submitting' }, h(Dialog, { open: true, inline: true, connection: 'connected', system: s, status: 'submitting', title: 'Close position', description: 'Sell 1,234,567 BONK at market now.', confirm: { label: 'Close position', onClick: noop }, onClose: noop })),
      h(Frame, { title: 'Dialog, error' }, h(Dialog, { open: true, inline: true, connection: 'connected', system: s, status: 'error', error: 'The request timed out. Nothing was retried.', title: 'Close position', description: 'Sell 1,234,567 BONK at market now.', confirm: { label: 'Close position', onClick: noop }, onClose: noop })),
      h(Frame, { title: 'Dialog, disconnected' }, h(Dialog, { open: true, inline: true, system: s, connection: 'disconnected', title: 'Close position', description: 'Sell 1,234,567 BONK at market now.', confirm: { label: 'Close position', onClick: noop }, onClose: noop })),
      h(Frame, { title: 'Dialog, reconnecting' }, h(Dialog, { open: true, inline: true, system: s, connection: 'reconnecting', title: 'Close position', description: 'Sell 1,234,567 BONK at market now.', confirm: { label: 'Close position', onClick: noop }, onClose: noop })),
      h(Frame, { title: 'Dialog, mode unknown' }, h(Dialog, { open: true, inline: true, system: null, connection: 'connected', title: 'Close position', description: 'Sell 1,234,567 BONK at market now.', confirm: { label: 'Close position', onClick: noop }, onClose: noop })),
      h(Frame, { title: 'Standard dialog' }, h(Dialog, { open: true, inline: true, kind: 'standard', moneyAffecting: false, connection: 'connected', system: s, title: 'Column settings', description: 'Choose the columns this table shows.', confirm: { label: 'Save', onClick: noop }, onClose: noop })),
      h(Frame, { title: 'HALT dialog, disconnected (stays enabled)' }, h(HaltDemo, { open: true, inline: true, system: s, connection: 'disconnected', onClose: noop, onConfirm: noop }))),
    h('h3', { className: 'tokens__heading' }, `${props.label}: typed confirmation`),
    h('div', { className: 'dialog-gallery__grid' },
      TYPED_STATES.map(([title, status, phrase, stepUp]) => h(Frame, { key: title, title }, h(TypedFrame, { system: s, status, phrase, ...(stepUp === undefined ? {} : { stepUp }) })))));
}

function HoldStates(): ReactElement {
  const states: ReadonlyArray<[string, HoldServerStatus, ('holding' | 'released-early')?]> = [
    ['Idle', 'idle'], ['Holding', 'idle', 'holding'], ['Released early', 'idle', 'released-early'], ['Sending', 'sending'],
    ['Acknowledged', 'acked'], ['Not confirmed', 'unconfirmed'], ['Failed', 'failed'],
  ];
  return h('div', { className: 'demo__row' }, states.map(([title, status, preview]) => h('div', { key: title, className: 'demo__cell' },
    h('p', { className: 'demo__caption' }, title),
    h(HoldButton, { status, onConfirm: noop, onOpenDialog: noop, ...(preview === undefined ? {} : { preview }) }))));
}

function Dialogs(): ReactElement {
  const steps: readonly StepUpStatus[] = ['prompting', 'success', 'cancelled', 'failed', 'unsupported'];
  return h('div', null,
    h('h3', { className: 'tokens__heading' }, 'HoldButton (HALT)'), h(HoldStates),
    h('h3', { className: 'tokens__heading' }, 'Step-up'),
    h('div', { className: 'dialog-gallery__grid' }, steps.map((st) => h(StepUpAuth, { key: st, status: st, onRetry: noop, onCancel: noop }))),
    h('h3', { className: 'tokens__heading' }, 'Countdown'),
    h('div', { className: 'demo__row' },
      h(Countdown, { label: 'LIVE-SMALL', effectiveAt: EFFECTIVE_AT, source: { clock: demoClock }, onCancel: noop }),
      h(Countdown, { label: 'LIVE-SMALL', effectiveAt: '2026-10-06T14:02:11.123Z', source: { clock: demoClock } }),
      h(Countdown, { label: 'LIVE-SMALL', effectiveAt: EFFECTIVE_AT, source: { clock: demoClock }, outcome: 'cancelled' }),
      h(Countdown, { label: 'LIVE-SMALL', effectiveAt: EFFECTIVE_AT, source: { clock: demoClock }, outcome: 'server-confirmed' })),
    h('h3', { className: 'tokens__heading' }, 'Diff'),
    h('div', { className: 'dialog-gallery__grid' },
      h(DiffView, { kind: 'limits', lines: LIMIT_LINES }), h(DiffView, { kind: 'config', lines: [] }), h(DiffView, { kind: 'limits', lines: LIMIT_LINES, conflict: true })),
    MODES.map(([label, system]) => h(ModeGallery, { key: label, label, system })));
}

const KNOWN_MODES: readonly Mode[] = ['backtest', 'replay', 'paper', 'live_small', 'live'];

/** The demo's VM-03 for `mode`: null (mode unknown) for "unknown", paper for anything else not a mode. */
function systemFor(mode: string | null): SystemStateView | null {
  if (mode === 'unknown') return null;
  const m = KNOWN_MODES.find((k) => k === mode) ?? 'paper';
  return { state_version: '200', mode: m, simulated: m !== 'live' && m !== 'live_small', trading_state: 'running' };
}

type OpenDialog = 'halt' | 'typed' | 'standard' | null;

/** The working flow (standalone): modal dialogs, focus handling, the hold gesture and a mode change while open. */
function OpenDialogDemo(): ReactElement {
  const params = new URLSearchParams(location.search);
  const [system, setSystem] = useState(() => systemFor(params.get('mode')));
  const asked = params.get('connection');
  const connection: ConnectionView = asked === 'disconnected' || asked === 'reconnecting' || asked === 'unknown' ? asked : 'connected';
  const [open, setOpen] = useState<OpenDialog>(null);
  const [confirms, setConfirms] = useState(0);
  const [last, setLast] = useState('');
  useEffect(() => {
    const onMode = (e: Event): void => setSystem(systemFor((e as CustomEvent<string>).detail));
    document.addEventListener('catalogue:set-mode', onMode);
    return () => document.removeEventListener('catalogue:set-mode', onMode);
  }, []);
  const close = (reason: string): void => { setOpen(null); setLast(reason); };
  const confirmed = (what: string): void => { setConfirms((n) => n + 1); setLast(what); setOpen(null); };
  const phrase = `${MODE_NAME.live_small} 0.25`;
  return h(Fragment, null,
    h('div', { className: 'demo__row' },
      h(HoldButton, { onConfirm: () => confirmed('hold'), onOpenDialog: () => setOpen('halt') }),
      h(Button, { variant: 'secondary', onClick: () => setOpen('typed') }, 'Switch to LIVE-SMALL'),
      h(Button, { variant: 'secondary', onClick: () => setOpen('standard') }, 'Close position')),
    h('output', { className: 'demo__out', 'data-confirms': confirms, 'data-last': last }, `Confirmed ${confirms} · last: ${last === '' ? 'none' : last}`),
    h(HaltDemo, { open: open === 'halt', system, connection, onClose: () => close('halt-cancel'), onConfirm: () => confirmed('halt-dialog') }),
    h(TypedConfirmDialog, {
      open: open === 'typed', system, connection, actionClass: 'A3', requiredPhrase: phrase, actionName: 'the switch to LIVE-SMALL',
      title: 'Switch to LIVE-SMALL', description: 'Real funds, at most 0.25 SOL per trade and 2 open positions.', confirmLabel: 'Switch mode',
      onConfirm: () => confirmed('typed'), onClose: (r) => close(`typed-${r}`),
    }, h(LiveSwitchBody)),
    h(Dialog, {
      open: open === 'standard', system, connection, title: 'Close position', description: 'Sell 1,234,567 BONK at market now.',
      confirm: { label: 'Close position', onClick: () => confirmed('standard') }, onClose: (r) => close(`standard-${r}`),
    }));
}

export const dialogsSection: Section = { id: 'dialogs', title: 'Dialogs and safety', render: () => h(Dialogs) };
export const dialogOpenSection: Section = { id: 'dialog-open', title: 'Open dialog', render: () => h(OpenDialogDemo), standalone: true };
