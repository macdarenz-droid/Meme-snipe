// Component catalogue (UI-T01): the in-repository replacement for Storybook 10, whose esbuild dependency has an install
// script the dependency policy refuses (E_INSTALL_SCRIPT). Each ticket adds a section that renders every state of its
// components; the Playwright tests screenshot and axe-check each section. `?section=<id>` shows one section.
import { createElement as h, type ReactElement, type ReactNode } from 'react';
import { dialogOpenSection, dialogsSection } from './sections/dialogs.ts';
import { menuOpenSection, overlaysSection, popoverOpenSection, primitivesSection, toastStackSection } from './sections/primitives.ts';
import { statesSection } from './sections/states.ts';
import { positionsSection, tableDenseSection, tablePerfSection, tableStatesSection } from './sections/table.ts';
import { tokensSection } from './sections/tokens.ts';
import { numbersSection, typographySection } from './sections/typography.ts';

/**
 * One catalogue section: an id for `?section=`, a heading and the states it renders. A `standalone` section (open
 * overlays, which move focus) shows only when selected by `?section=`.
 */
export interface Section { id: string; title: string; render(): ReactNode; standalone?: boolean }

/** The sections, in catalogue order. */
export const SECTIONS: readonly Section[] = [tokensSection, typographySection, numbersSection, primitivesSection, statesSection, overlaysSection,
  menuOpenSection, popoverOpenSection, toastStackSection, tableStatesSection, tableDenseSection, positionsSection, tablePerfSection, dialogsSection,
  dialogOpenSection];

/** The sections `?section=<id>` selects: that one, or all but the standalone ones when the parameter is absent or unknown. */
export function selectSections(search: string, sections: readonly Section[]): readonly Section[] {
  const id = new URLSearchParams(search).get('section');
  const one = sections.filter((s) => s.id === id);
  return one.length > 0 ? one : sections.filter((s) => s.standalone !== true);
}

export function Catalogue(props: { sections: readonly Section[] }): ReactElement {
  return h('main', { className: 'catalogue', id: 'main' },
    h('h1', { className: 'catalogue__title' }, 'Catalogue'),
    props.sections.map((s) => h('section', { key: s.id, id: s.id, className: 'catalogue__section', 'aria-labelledby': `${s.id}-title` },
      h('h2', { id: `${s.id}-title`, className: 'catalogue__heading' }, s.title),
      s.render())));
}
