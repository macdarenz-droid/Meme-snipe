import type { Screen } from '../lib/route.ts';

const paths: Record<Screen, string> = {
  home: 'M3 9.5L10 4l7 5.5V16a1 1 0 0 1-1 1h-3.5v-4.5h-5V17H4a1 1 0 0 1-1-1z',
  snipe: 'M10 3v3M10 14v3M3 10h3M14 10h3M10 16a6 6 0 1 0 0-12 6 6 0 0 0 0 12z',
  fixtures: 'M4 16V9M10 16V4M16 16v-5',
  wallet: 'M3 6.5A1.5 1.5 0 0 1 4.5 5h11A1.5 1.5 0 0 1 17 6.5v8a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 14.5zM13 10.5h1.5',
};

export function NavIcon({ id }: { id: Screen }) {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path d={paths[id]} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
