// UI-T02 display preferences: the data attributes on <html> and the URL parameters the catalogue reads.
import './dom.ts';
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import { DEFAULT_PREFERENCES, applyPreferences, preferencesFromSearch } from '../src/theme/preferences.ts';

describe('UI-T02 display preferences', () => {
  it('applyPreferences sets data-theme, data-polarity, data-density and data-motion', () => {
    const el = document.createElement('html');
    applyPreferences(el, { theme: 'light', polarity: 'blue-orange', density: 'compact', motion: 'reduced' });
    assert.deepEqual([el.dataset['theme'], el.dataset['polarity'], el.dataset['density'], el.dataset['motion']], ['light', 'blue-orange', 'compact', 'reduced']);
    applyPreferences(el, DEFAULT_PREFERENCES);
    assert.equal(el.getAttribute('data-theme'), 'system');
  });

  it('the defaults are System theme, default polarity, Standard density and the OS motion setting', () => {
    assert.deepEqual(DEFAULT_PREFERENCES, { theme: 'system', polarity: 'default', density: 'standard', motion: 'system' });
  });

  it('reads known URL parameters and ignores unknown values', () => {
    assert.deepEqual(preferencesFromSearch('?theme=dark&polarity=blue-orange&density=comfortable&motion=reduced'),
      { theme: 'dark', polarity: 'blue-orange', density: 'comfortable', motion: 'reduced' });
    assert.deepEqual(preferencesFromSearch('?theme=purple&density='), DEFAULT_PREFERENCES);
    assert.deepEqual(preferencesFromSearch('', { ...DEFAULT_PREFERENCES, theme: 'light' }).theme, 'light');
  });
});
