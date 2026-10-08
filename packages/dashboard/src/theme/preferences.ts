// Display preferences (UI-T02): theme System/Dark/Light, polarity, density and motion, applied as data attributes on
// <html>. tokens.css does the rest: System follows the OS colour scheme through a media query, so an OS switch applies
// without a reload, and `color-scheme` follows the theme. The OS reduced-motion setting always applies; the in-app
// setting can only add reduced motion, never remove it.

export type ThemePreference = 'system' | 'dark' | 'light';
export type Polarity = 'default' | 'blue-orange';
export type Density = 'compact' | 'standard' | 'comfortable';
export type MotionPreference = 'system' | 'reduced';

export interface DisplayPreferences { theme: ThemePreference; polarity: Polarity; density: Density; motion: MotionPreference }

export const DEFAULT_PREFERENCES: DisplayPreferences = { theme: 'system', polarity: 'default', density: 'standard', motion: 'system' };

const CHOICES = {
  theme: ['system', 'dark', 'light'],
  polarity: ['default', 'blue-orange'],
  density: ['compact', 'standard', 'comfortable'],
  motion: ['system', 'reduced'],
} as const;

/** Sets the `data-theme`, `data-polarity`, `data-density` and `data-motion` attributes on `root`. */
export function applyPreferences(root: HTMLElement, p: DisplayPreferences): void {
  root.dataset['theme'] = p.theme;
  root.dataset['polarity'] = p.polarity;
  root.dataset['density'] = p.density;
  root.dataset['motion'] = p.motion;
}

/** Preferences from URL parameters (`?theme=light&polarity=blue-orange&density=compact&motion=reduced`); unknown values keep the defaults. */
export function preferencesFromSearch(search: string, base: DisplayPreferences = DEFAULT_PREFERENCES): DisplayPreferences {
  const params = new URLSearchParams(search);
  const pick = <K extends keyof typeof CHOICES>(key: K): DisplayPreferences[K] => {
    const value = params.get(key);
    return ((CHOICES[key] as readonly string[]).includes(value ?? '') ? value : base[key]) as DisplayPreferences[K];
  };
  return { theme: pick('theme'), polarity: pick('polarity'), density: pick('density'), motion: pick('motion') };
}
