import { describe, expect, it } from 'vitest';
import { createBackStack } from '../src/lib/backStack.ts';
import { themeToBarStyle } from '../src/lib/native.ts';

/**
 * A small model of the WebView: a list of history entries, and the Android back button
 * as MainActivity wires it (goBack while there is history, otherwise leave the app).
 */
function makeWebView() {
  const entries: string[] = ['#/home'];
  let index = 0;
  const listeners: Array<() => void> = [];
  const queue: Array<() => void> = [];
  const win = {
    history: {
      pushState(_state: unknown, _unused: string) {
        entries.splice(index + 1);
        entries.push(entries[index] as string);
        index += 1;
      },
      back() {
        queue.push(() => {
          if (index > 0) {
            index -= 1;
            listeners.forEach((l) => l());
          }
        });
      },
    },
    addEventListener(_type: 'popstate', l: () => void) {
      listeners.push(l);
    },
  };
  const flush = () => {
    while (queue.length) queue.shift()?.();
  };
  const pending: Array<() => void> = [];
  const stack = createBackStack(win, (fn) => pending.push(fn));
  const runDeferred = () => {
    while (pending.length) pending.shift()?.();
    flush();
  };
  return {
    stack,
    runDeferred,
    navigate(hash: string) {
      entries.splice(index + 1);
      entries.push(hash);
      index += 1;
    },
    get screen() {
      return entries[index];
    },
    get depth() {
      return index;
    },
    /** The Android back button. Returns false when the app would exit. */
    systemBack(): boolean {
      if (index === 0) return false;
      index -= 1;
      listeners.forEach((l) => l());
      return true;
    },
  };
}

describe('back button', () => {
  it('closes an open sheet first, then goes back a screen, then exits', () => {
    const w = makeWebView();
    w.navigate('#/wallet');
    let sheetOpen = true;
    w.stack(() => {
      sheetOpen = false;
    });
    expect(w.screen).toBe('#/wallet');

    expect(w.systemBack()).toBe(true); // 1st back: sheet closes, screen stays
    expect(sheetOpen).toBe(false);
    expect(w.screen).toBe('#/wallet');

    expect(w.systemBack()).toBe(true); // 2nd back: previous screen
    expect(w.screen).toBe('#/home');

    expect(w.systemBack()).toBe(false); // 3rd back: nothing left, the app exits
  });

  it('removes the sheet history entry when the sheet is closed another way', () => {
    const w = makeWebView();
    w.navigate('#/wallet');
    const depthBefore = w.depth;
    let closes = 0;
    const release = w.stack(() => {
      closes += 1;
    });
    expect(w.depth).toBe(depthBefore + 1);
    release(); // the sheet's own Close button
    w.runDeferred();
    expect(w.depth).toBe(depthBefore);
    expect(closes).toBe(0); // our own back() must not run the close handler again
    expect(w.systemBack()).toBe(true);
    expect(w.screen).toBe('#/home'); // one back goes straight to the earlier screen
  });

  it('keeps one entry when an effect re-runs in the same tick (release then register again)', () => {
    const w = makeWebView();
    w.navigate('#/wallet');
    const depthBefore = w.depth;
    const first = w.stack(() => {});
    first();
    w.stack(() => {});
    w.runDeferred();
    expect(w.depth).toBe(depthBefore + 1);
  });

  it('closes only the newest of two stacked sheets per back press', () => {
    const w = makeWebView();
    const closed: string[] = [];
    w.stack(() => closed.push('a'));
    w.stack(() => closed.push('b'));
    w.systemBack();
    expect(closed).toEqual(['b']);
    w.systemBack();
    expect(closed).toEqual(['b', 'a']);
  });
});

describe('system bar style', () => {
  it('uses light icons on Silent Black and dark icons on Paper', () => {
    expect(themeToBarStyle('black')).toBe('DARK');
    expect(themeToBarStyle('paper')).toBe('LIGHT');
    expect(themeToBarStyle(undefined)).toBe('LIGHT');
  });
});
