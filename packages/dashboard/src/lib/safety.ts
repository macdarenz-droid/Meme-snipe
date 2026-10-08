// Safety logic for the dialog family (UI-T07; UI.md Mode treatment, Safety UX): the VM-03 fields the dialogs read,
// how each mode is named and marked, the typed-phrase matcher of TypedConfirmDialog (C16) and the hold gesture's
// timing (C03). Pure functions only; the components are in components/dialog.ts and components/hold-button.ts.
import type { Mode, TradingState } from '@bot/types';

/**
 * The VM-03 fields the dialogs read (UI.md VM-03). A local projection until `@bot/contract` (B-M28-01, card Z02)
 * exports the VM-03 schema; the fixture test checks the fixtures against that schema once it exists.
 */
export interface SystemStateView {
  state_version: string;
  mode: Mode;
  simulated: boolean;
  trading_state: TradingState;
}

/** How a mode is marked (UI.md Mode treatment): offline (backtest, replay), paper, or live (live-small and live). */
export type ModeTone = 'offline' | 'paper' | 'live';

export function modeTone(mode: Mode): ModeTone {
  if (mode === 'live' || mode === 'live_small') return 'live';
  return mode === 'paper' ? 'paper' : 'offline';
}

/** The mode's name as the mode bar writes it. */
export const MODE_NAME: Readonly<Record<Mode, string>> = {
  backtest: 'BACKTEST', replay: 'REPLAY', paper: 'PAPER', live_small: 'LIVE-SMALL', live: 'LIVE',
};

/**
 * The title prefix of a money-affecting dialog (UI.md Mode treatment, "Confirmation dialogs"): "Replay:" for both
 * offline modes (the table's offline column names only that prefix), "Paper:", and "LIVE:" for live-small and live.
 */
export const DIALOG_TITLE_PREFIX: Readonly<Record<ModeTone, string>> = { offline: 'Replay:', paper: 'Paper:', live: 'LIVE:' };

/** The notice shown when the mode changes while a dialog is open (UI-T07 edge case). */
export function modeChangedText(mode: Mode | null): string {
  return mode === null ? 'Mode unknown — review again' : `Mode changed to ${MODE_NAME[mode]} — review again`;
}

/** The text a non-HALT dialog shows, and its submit's reason, while the stream is disconnected (UI-T07 edge case). */
export const DISCONNECTED_CONFIRM_TEXT = 'Disconnected · cannot confirm current state';

/** The stream's state as a dialog sees it; `unknown` until the data client reports one. */
export type ConnectionView = 'connected' | 'reconnecting' | 'disconnected' | 'unknown';

/**
 * Why a money-affecting confirm is disabled by what the dashboard cannot know (Z05 round 2, red team M3, reviewer m2):
 * the connection is not `connected`, or the mode is unknown. Undefined when neither holds. It fails closed: anything
 * but a known mode on a connected stream disables it. HALT is exempt (it reduces risk; UI.md HALT flow).
 */
export function unknownStateReason(connection: ConnectionView, mode: Mode | null): string | undefined {
  if (connection === 'disconnected') return DISCONNECTED_CONFIRM_TEXT;
  if (connection === 'reconnecting') return 'Reconnecting · cannot confirm current state';
  if (connection === 'unknown') return 'Connection unknown · cannot confirm current state';
  return mode === null ? 'Mode unknown · cannot confirm current state' : undefined;
}

/** The confirm's reason in the frame between a mode change and the dialog closing (Z05 round 2, red team m3). */
export const MODE_CHANGED_CONFIRM_TEXT = 'The mode changed · review again';

export type PhraseState = 'empty' | 'mismatch' | 'match';
/** One character of the required phrase: typed and equal, equal but for case, different, or not typed yet. */
export type CharMark = 'match' | 'case' | 'wrong' | 'missing';

export interface PhraseCheck {
  state: PhraseState;
  /** One mark per character of the required phrase. */
  marks: Array<{ char: string; mark: CharMark }>;
  /** Characters typed beyond the phrase's length. */
  extra: number;
  /** The text the hint shows and announces. */
  hint: string;
}

/**
 * Compares typed text to the required phrase (C16): the input is trimmed of surrounding whitespace, then it must equal
 * the phrase exactly, letter case included. Paste is never blocked; the phrase carries a dynamic part instead.
 */
export function checkPhrase(input: string, required: string): PhraseCheck {
  const typed = [...input.trim()];
  const want = [...required];
  const marks = want.map((char, i): { char: string; mark: CharMark } => {
    const got = typed[i];
    if (got === undefined) return { char, mark: 'missing' };
    if (got === char) return { char, mark: 'match' };
    return { char, mark: got.toLowerCase() === char.toLowerCase() ? 'case' : 'wrong' };
  });
  const extra = Math.max(0, typed.length - want.length);
  const state: PhraseState = typed.length === 0 ? 'empty' : typed.join('') === required ? 'match' : 'mismatch';
  return { state, marks, extra, hint: phraseHint(state, marks, extra, required) };
}

function phraseHint(state: PhraseState, marks: PhraseCheck['marks'], extra: number, required: string): string {
  if (state === 'empty') return `Type ${required} to confirm.`;
  if (state === 'match') return 'The phrase matches.';
  const wrong = marks.findIndex((m) => m.mark === 'wrong');
  if (wrong >= 0) return `Character ${wrong + 1} does not match.`;
  if (marks.some((m) => m.mark === 'case')) return 'Letter case does not match. The phrase is case-sensitive.';
  if (extra > 0) return `${extra} ${extra === 1 ? 'character' : 'characters'} too many.`;
  const typed = marks.filter((m) => m.mark !== 'missing').length;
  return `${typed} of ${marks.length} characters typed.`;
}

/** The HALT hold gesture (DS Motion `--hold-to-confirm`). */
export const HOLD_TO_CONFIRM_MS = 1000;
/** A hold released early rewinds its ring over this long (C03 `released-early`). */
export const HOLD_REWIND_MS = 160;
/** A closing dialog fades out over this long: exits are 30% faster than the 240 ms entry (DS Motion). */
export const DIALOG_EXIT_MS = 170;

/** Time left until `effectiveAtMs` (server time) at local `nowMs` with the server clock offset; never below 0. */
export function remainingMs(effectiveAtMs: number, nowMs: number, offsetMs: number): number {
  return Math.max(0, effectiveAtMs - (nowMs + offsetMs));
}
