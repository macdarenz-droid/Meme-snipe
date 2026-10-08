// Kbd (UI-T04, C22): a key, a combination (`⌘ K` on macOS, `Ctrl K` elsewhere) or a sequence (`G then P`).
import { createElement as h, Fragment, type ReactElement } from 'react';

/** True on Apple platforms (userAgentData.platform, else navigator.platform). */
export function isApplePlatform(nav: { platform?: string; userAgentData?: { platform?: string } } | undefined): boolean {
  const platform = nav?.userAgentData?.platform ?? nav?.platform ?? '';
  return /mac|iphone|ipad|ipod/i.test(platform);
}

const APPLE: Readonly<Record<string, string>> = { Mod: '⌘', Alt: '⌥', Shift: '⇧', Ctrl: '⌃' };
const OTHER: Readonly<Record<string, string>> = { Mod: 'Ctrl' };

/** The label of one key on the platform (`Mod` is ⌘ or Ctrl). */
export function keyLabel(key: string, apple: boolean): string {
  return (apple ? APPLE[key] : OTHER[key]) ?? key;
}

export interface KbdProps {
  /** Keys pressed together. */
  keys?: readonly string[];
  /** Keys pressed one after another. */
  sequence?: readonly string[];
  apple?: boolean;
}

export function Kbd(props: KbdProps): ReactElement {
  const apple = props.apple ?? isApplePlatform(globalThis.navigator as Parameters<typeof isApplePlatform>[0]);
  if (props.sequence !== undefined) {
    return h('span', { className: 'kbd-group' }, props.sequence.map((k, i) =>
      h(Fragment, { key: i }, i > 0 ? h('span', { className: 'kbd-then' }, ' then ') : null, h('kbd', { className: 'kbd' }, keyLabel(k, apple)))));
  }
  return h('span', { className: 'kbd-group' }, (props.keys ?? []).map((k, i) => h('kbd', { key: i, className: 'kbd' }, keyLabel(k, apple))));
}
