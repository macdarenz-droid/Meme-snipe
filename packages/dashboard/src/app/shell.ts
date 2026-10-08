// The blank application shell (UI-T01): the frame later tickets fill (mode bar UI-T11, navigation UI-T10).
import { createElement as h, type ReactElement } from 'react';

/** The product name shown in the header and the document title. */
export const APP_NAME = 'Zeroed';

export function Shell(): ReactElement {
  return h('div', { className: 'app-shell' },
    h('header', { className: 'app-shell__header' }, h('span', { className: 'app-shell__name' }, APP_NAME)),
    h('main', { className: 'app-shell__main', id: 'main', tabIndex: -1 },
      h('h1', { className: 'app-shell__title' }, 'Overview')));
}
