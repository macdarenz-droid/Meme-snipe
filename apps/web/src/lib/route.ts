import { useEffect, useState } from 'react';

export type Screen = 'home' | 'snipe' | 'wallet' | 'fixtures';

export const SCREENS: { id: Exclude<Screen, 'fixtures'>; label: string; key: string }[] = [
  { id: 'home', label: 'Home', key: '1' },
  { id: 'snipe', label: 'Snipe', key: '2' },
  { id: 'wallet', label: 'Wallet', key: '3' },
];

function parse(hash: string): Screen {
  const id = hash.replace(/^#\/?/, '');
  if (id === 'snipe' || id === 'wallet') return id;
  if (id === 'dev/fixtures' && import.meta.env.DEV) return 'fixtures';
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
    window.location.hash = s === 'fixtures' ? '/dev/fixtures' : `/${s}`;
  };
  return [screen, go];
}
