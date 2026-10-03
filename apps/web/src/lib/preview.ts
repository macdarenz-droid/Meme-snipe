/*
 * VITE_PREVIEW=1 is set only for the APK build. Each condition below is written out in full so the
 * bundler folds it to a constant: in a normal production build the sample screen, its label and its
 * data are all dropped (scripts/check-build.mjs fails the build if any of them remain).
 */

/** The sample-data screen exists in dev and in the preview build, never in a normal production build. */
export const SAMPLES = import.meta.env.DEV || import.meta.env.VITE_PREVIEW === '1';

/** Text of the persistent marker. Empty in a normal production build. */
export const SAMPLE_LABEL = import.meta.env.DEV || import.meta.env.VITE_PREVIEW === '1' ? 'Sample data' : '';

/** The preview build adds the Samples tab; dev reaches the screen by URL only. */
export const PREVIEW = import.meta.env.VITE_PREVIEW === '1';
