/**
 * Lets the system back button (and the browser's) close an open sheet before it changes screen.
 * Each open sheet adds one browser history entry. Going back removes that entry and runs the
 * sheet's close handler. Closing the sheet another way removes its entry again.
 *
 * On Android the native back button calls WebView.goBack() while there is history, and exits
 * otherwise (MainActivity.java), so the order is: sheet, then earlier screens, then the app.
 */

interface HistoryLike {
  pushState(state: unknown, unused: string): void;
  back(): void;
}

interface WindowLike {
  history: HistoryLike;
  addEventListener(type: 'popstate', listener: () => void): void;
}

export function createBackStack(win: WindowLike, defer: (fn: () => void) => void = queueMicrotask) {
  const open: Array<() => void> = [];
  let leftover = 0; // history entries whose sheet closed but whose back() has not run yet
  let ignore = 0; // popstate events caused by our own back() calls

  win.addEventListener('popstate', () => {
    if (ignore > 0) {
      ignore -= 1;
      return;
    }
    open.pop()?.();
  });

  /** Registers an open sheet. Returns the function that unregisters it when it closes. */
  return function pushBack(close: () => void): () => void {
    if (leftover > 0) leftover -= 1; // same tick as a release: reuse the entry (effects re-run together)
    else win.history.pushState({ zeroedSheet: true }, '');
    const entry = close;
    open.push(entry);
    return () => {
      const at = open.lastIndexOf(entry);
      if (at < 0) return; // already closed by going back
      open.splice(at, 1);
      leftover += 1;
      defer(() => {
        if (leftover > 0) {
          leftover -= 1;
          ignore += 1;
          win.history.back();
        }
      });
    };
  };
}

let shared: ReturnType<typeof createBackStack> | undefined;

/** The app-wide stack, created on first use so importing this file needs no window. */
export function pushBack(close: () => void): () => void {
  shared ??= createBackStack(window);
  return shared(close);
}
