// Mounts the dashboard. The build's page entry calls start(document); importing this module has no side effects, so
// Node can load it (tools/policy/test/load-packages.test.ts) and tests can mount the app into a test document.
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Shell } from './app/shell.ts';
import { DEFAULT_PREFERENCES, applyPreferences } from './theme/preferences.ts';

/** Applies the display preferences and renders the app into the page's `#root` element; throws when the page has none. */
export function start(doc: Document): Root {
  const container = doc.getElementById('root');
  if (container === null) throw new Error('dashboard: the page has no #root element');
  applyPreferences(doc.documentElement, DEFAULT_PREFERENCES);
  const root = createRoot(container);
  root.render(createElement(Shell));
  return root;
}
