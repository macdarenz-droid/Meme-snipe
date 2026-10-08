// Toast queue (UI-T04, C19): states entering, visible, paused-on-hover and exiting. Info, success and warning toasts
// leave after 5 s (paused while hovered or focused); danger toasts stay until dismissed. Money-affecting results are
// never toast-only: they also land in the Alerts or Audit page. A toast is announced when it first renders in its live
// region (marked announced). An announced toast that leaves the stack (beyond MAX_TOASTS) is marked hiddenOnce, so when
// it shows again it is not put back in a live region and announced a second time. A toast that waited beyond the
// maximum from the start (several arrived at once) was never announced: it is announced when it first shows.

export type ToastTone = 'info' | 'success' | 'warning' | 'danger';
export type ToastPhase = 'entering' | 'visible' | 'exiting';

export interface ToastInput { id: string; tone: ToastTone; title: string; body?: string }
export interface ToastItem extends ToastInput {
  phase: ToastPhase;
  paused: boolean;
  /** It has rendered in its live region, so a screen reader has announced it. */
  announced?: boolean;
  /** It was announced, then hidden behind "n more": shown again, it sits outside the live regions. */
  hiddenOnce?: boolean;
}

export type ToastAction =
  | { type: 'add'; toast: ToastInput }
  | { type: 'shown' | 'pause' | 'resume' | 'dismiss' | 'remove' | 'announced' | 'hidden'; id: string };

export const TOAST_DURATION_MS = 5000;
/** Entering lasts --d-base; exiting is faster, --d-fast (DS Motion: exits 30% faster). */
export const TOAST_ENTER_MS = 160;
export const TOAST_EXIT_MS = 100;
/**
 * At most this many toasts show at once. A new one pushes out the oldest that is not danger; danger toasts stay until
 * dismissed, so beyond the maximum the oldest wait behind an "n more" control (toastStack).
 */
export const MAX_TOASTS = 4;

/** How long a toast stays visible, or null when it stays until dismissed. */
export function autoDismissMs(tone: ToastTone): number | null {
  return tone === 'danger' ? null : TOAST_DURATION_MS;
}

const set = (state: readonly ToastItem[], id: string, patch: Partial<ToastItem>): ToastItem[] =>
  state.map((t) => (t.id === id ? { ...t, ...patch } : t));

export function toastReducer(state: readonly ToastItem[], action: ToastAction): ToastItem[] {
  switch (action.type) {
    case 'add': {
      const next: ToastItem[] = [...state.filter((t) => t.id !== action.toast.id), { ...action.toast, phase: 'entering', paused: false }];
      const showing = next.filter((t) => t.phase !== 'exiting');
      const oldest = showing.length > MAX_TOASTS ? showing.find((t) => t.tone !== 'danger') : undefined;
      return oldest === undefined ? next : set(next, oldest.id, { phase: 'exiting' });
    }
    case 'shown': return state.map((t) => (t.id === action.id && t.phase === 'entering' ? { ...t, phase: 'visible' } : t));
    case 'pause': return set(state, action.id, { paused: true });
    case 'resume': return set(state, action.id, { paused: false });
    case 'dismiss': return set(state, action.id, { phase: 'exiting' });
    case 'remove': return state.filter((t) => t.id !== action.id);
    case 'announced': return set(state, action.id, { announced: true });
    // Only an announced toast is marked: one that was never on screen is announced when it first shows.
    case 'hidden': return state.map((t) => (t.id === action.id && t.announced === true ? { ...t, hiddenOnce: true } : t));
  }
}

/** What a toast region renders: the toasts to show, and how many more wait beyond MAX_TOASTS (0 when none). */
export interface ToastStack { shown: ToastItem[]; more: number }

/**
 * The newest MAX_TOASTS toasts that are not exiting, or all of them when `expanded`, plus every exiting toast (it
 * finishes its exit animation). `more` counts the toasts beyond the maximum whether or not they are expanded.
 */
export function toastStack(state: readonly ToastItem[], expanded: boolean): ToastStack {
  const live = state.filter((t) => t.phase !== 'exiting');
  const keep = new Set((expanded ? live : live.slice(-MAX_TOASTS)).map((t) => t.id));
  return { shown: state.filter((t) => t.phase === 'exiting' || keep.has(t.id)), more: Math.max(0, live.length - MAX_TOASTS) };
}
