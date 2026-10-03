import { useSyncExternalStore } from 'react';
import type { ThemeName } from './contrast.ts';

/** Same key as the inline script in index.html, which applies it before first paint. */
const KEY = 'zeroed.theme';

export const THEMES: { id: ThemeName; label: string }[] = [
  { id: 'paper', label: 'Paper' },
  { id: 'black', label: 'Silent Black' },
];

const listeners = new Set<() => void>();

function current(): ThemeName {
  return document.documentElement.dataset['theme'] === 'black' ? 'black' : 'paper';
}

export function setTheme(t: ThemeName): void {
  document.documentElement.dataset['theme'] = t;
  try {
    localStorage.setItem(KEY, t);
  } catch {
    // Storage blocked: the choice lasts for this visit only.
  }
  listeners.forEach((l) => l());
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useTheme(): [ThemeName, (t: ThemeName) => void] {
  return [useSyncExternalStore(subscribe, current), setTheme];
}
