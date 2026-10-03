import { useEffect, useState } from 'react';
import { PREVIEW, SAMPLES, SAMPLES_PATH, SAMPLES_TITLE } from './preview.ts';

export type Screen = 'home' | 'snipe' | 'wallet' | 'fixtures';

export type NavScreen = Screen;

/** Tabs and rail links. The sample-data screen is listed only in the preview build. */
export const SCREENS: { id: NavScreen; label: string; key: string }[] = [
  { id: 'home', label: 'Home', key: '1' },
  { id: 'snipe', label: 'Snipe', key: '2' },
  { id: 'wallet', label: 'Wallet', key: '3' },
  ...(PREVIEW ? [{ id: 'fixtures' as const, label: SAMPLES_TITLE, key: '4' }] : []),
];

export function hrefFor(s: Screen): string {
  return s === 'fixtures' ? `#/${SAMPLES_PATH}` : `#/${s}`;
}

function parse(hash: string): Screen {
  const id = hash.replace(/^#\/?/, '');
  if (id === 'snipe' || id === 'wallet') return id;
  if (SAMPLES && id === SAMPLES_PATH) return 'fixtures';
  return 'home';
}

export function useRoute(): [Screen, (s: Screen) => void] {
  const [screen, setScreen] = useState<Screen>(() => parse(window.location.hash));
  useEffect(() => {
    const onHash = () => setScreen(parse(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const go = (s: Screen) => {
    window.location.hash = hrefFor(s).slice(1);
  };
  return [screen, go];
}
