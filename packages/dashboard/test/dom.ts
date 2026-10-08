// Test DOM (UI-T01): a happy-dom window on globalThis (dom-globals.ts, loaded before react-dom), so react-dom renders
// into it under Vitest. Import this module first in a component test. render() mounts an element inside act() and
// returns helpers; the event helpers dispatch inside act().
import { testWindow } from './dom-globals.ts';
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/** The happy-dom window, for its test API (`happyDOM`) and event constructors. */
export { testWindow };

export interface Rendered {
  container: HTMLElement;
  root: Root;
  rerender(element: ReactElement): void;
  unmount(): void;
}

/** Mounts `element` into a fresh container appended to the body. */
export function render(element: ReactElement): Rendered {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(element));
  return {
    container,
    root,
    rerender: (next) => act(() => root.render(next)),
    unmount: () => { act(() => root.unmount()); container.remove(); },
  };
}

/** Runs `fn` inside act(), flushing React updates and effects. */
export function actSync(fn: () => void): void {
  act(fn);
}

/** Awaits `fn` inside act(), flushing async updates. */
export async function actAsync(fn: () => Promise<void> | void): Promise<void> {
  await act(async () => { await fn(); });
}

/** Dispatches a bubbling keyboard event on `target`. */
export function key(target: Element, type: 'keydown' | 'keyup', init: KeyboardEventInit): void {
  act(() => { target.dispatchEvent(new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init })); });
}

/** Clicks `target` inside act(). */
export function click(target: Element): void {
  act(() => { (target as HTMLElement).click(); });
}

/** Sets an input's value the way typing does and fires the input event React listens to. */
export function typeInto(input: HTMLInputElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set as (v: string) => void;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** Dispatches a bubbling event of `type` (mouse, pointer, focus, …) on `target` inside act(). */
export function fire(target: EventTarget, event: Event): void {
  act(() => { target.dispatchEvent(event); });
}
