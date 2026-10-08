// Mounts the component catalogue (UI-T01); the build's catalogue page entry calls startCatalogue(document). URL
// parameters choose the display preferences (`?theme=light&polarity=blue-orange&density=compact&motion=reduced`, UI-T02).
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { applyPreferences, preferencesFromSearch } from '../theme/preferences.ts';
import { Catalogue, SECTIONS, selectSections } from './catalogue.ts';

export function startCatalogue(doc: Document): Root {
  const container = doc.getElementById('root');
  if (container === null) throw new Error('catalogue: the page has no #root element');
  applyPreferences(doc.documentElement, preferencesFromSearch(doc.location.search));
  const root = createRoot(container);
  root.render(createElement(Catalogue, { sections: selectSections(doc.location.search, SECTIONS) }));
  return root;
}
