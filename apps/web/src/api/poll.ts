/**
 * Polling rules for paper and live data. The contract has GET endpoints only (no stream), so the
 * app polls: every REFRESH_MS while answers come back, doubling up to MAX_BACKOFF_MS after each
 * failure, and not at all while the app is in the background.
 */

export const REFRESH_MS = 10_000;
export const MAX_BACKOFF_MS = 5 * 60_000;

/** Delay before the next request after `failures` failures in a row; `jitter` in [0, 1) spreads retries by up to 10%. */
export function nextDelay(failures: number, jitter = 0): number {
  const base = Math.min(MAX_BACKOFF_MS, REFRESH_MS * 2 ** Math.min(failures, 16));
  return failures === 0 ? base : Math.round(base * (1 + jitter / 10));
}

export interface Foreground {
  visible(): boolean;
  /** Calls `fn` with the new value whenever the app moves to or from the background. */
  watch(fn: (visible: boolean) => void): () => void;
}

/**
 * The page's visibility, plus Capacitor's document `pause` and `resume` events: the Android shell
 * keeps WebView timers running in the background (Capacitor's KeepRunning defaults to true), so
 * the pause event is what stops polling there.
 */
export function documentForeground(doc: Document | undefined = typeof document === 'undefined' ? undefined : document): Foreground {
  let paused = false;
  const visible = () => !!doc && !paused && doc.visibilityState !== 'hidden';
  return {
    visible,
    watch(fn) {
      if (!doc) return () => {};
      const onVisibility = () => fn(visible());
      const onPause = () => {
        paused = true;
        fn(false);
      };
      const onResume = () => {
        paused = false;
        fn(visible());
      };
      doc.addEventListener('visibilitychange', onVisibility);
      doc.addEventListener('pause', onPause);
      doc.addEventListener('resume', onResume);
      return () => {
        doc.removeEventListener('visibilitychange', onVisibility);
        doc.removeEventListener('pause', onPause);
        doc.removeEventListener('resume', onResume);
      };
    },
  };
}

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
  now(): number;
}

const browserTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

/**
 * Runs `run` now, then again after each answer per nextDelay. `run` resolves true on success.
 * In the background nothing runs; on return, it runs at once if the next run was already due.
 * With `once` it runs a single time (a finished backtest), retrying only after failures.
 */
export function startPolling(
  run: () => Promise<boolean>,
  { once = false, foreground = documentForeground(), timers = browserTimers, random = Math.random }: { once?: boolean; foreground?: Foreground; timers?: Timers; random?: () => number } = {},
): () => void {
  let stopped = false;
  let failures = 0;
  let timer: unknown = null;
  let dueAt = 0;
  let inFlight = false;
  let done = false;

  const schedule = (ms: number) => {
    dueAt = timers.now() + ms;
    if (foreground.visible()) timer = timers.set(tick, ms);
  };

  async function tick() {
    timer = null;
    if (stopped || inFlight || done) return;
    if (!foreground.visible()) return;
    inFlight = true;
    let ok = false;
    try {
      ok = await run();
    } catch {
      ok = false;
    }
    inFlight = false;
    if (stopped) return;
    failures = ok ? 0 : failures + 1;
    if (ok && once) {
      done = true;
      return;
    }
    schedule(nextDelay(failures, random()));
  }

  const unwatch = foreground.watch((visible) => {
    if (stopped || done) return;
    if (!visible) {
      if (timer !== null) timers.clear(timer);
      timer = null;
      return;
    }
    if (timer !== null || inFlight) return;
    const wait = Math.max(0, dueAt - timers.now());
    timer = timers.set(tick, wait);
  });

  void tick();

  return () => {
    stopped = true;
    unwatch();
    if (timer !== null) timers.clear(timer);
  };
}
