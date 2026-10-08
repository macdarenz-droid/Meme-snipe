// Registers a happy-dom GlobalWindow on globalThis (UI-T01 test DOM), the way happy-dom's global registrator does: every
// own window property except the JS globals below. It must run before react-dom loads, because react-dom decides at
// load time whether it runs in a DOM (canUseDOM) and whether the input event exists, so test/dom.ts imports it first.
import { GlobalWindow, PropertySymbol } from 'happy-dom';

// Node's console stays: happy-dom's VirtualConsole does not implement console.timeStamp, which react-dom calls.
const IGNORE = new Set(['undefined', 'NaN', 'global', 'globalThis', 'Infinity', 'console']);

const win = new GlobalWindow({ url: 'http://127.0.0.1:5173/', width: 1440, height: 900 });
const g = globalThis as unknown as Record<string, unknown>;
for (const key of Object.getOwnPropertyNames(win)) {
  if (IGNORE.has(key)) continue;
  const own = Object.getOwnPropertyDescriptor(win, key) as PropertyDescriptor;
  const current = Object.getOwnPropertyDescriptor(globalThis, key);
  if (current?.value !== undefined && current.value === own.value) continue;
  if (own.value === win) own.value = globalThis;
  Object.defineProperty(globalThis, key, { ...own, configurable: true });
}
const doc = g['document'] as Record<symbol, unknown>;
doc[PropertySymbol.defaultView] = globalThis;
g['IS_REACT_ACT_ENVIRONMENT'] = true;

export const testWindow = win;
