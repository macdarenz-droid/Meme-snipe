// Production build: fails if dev-only fixtures reached dist/.
// Preview build (--preview, used only for the APK): requires the fixtures and the "Sample data" marker.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const preview = process.argv.includes('--preview');
const dist = new URL('../dist', import.meta.url).pathname;
const files = (dir) => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : [join(dir, n)]));
const all = files(dist);
const text = all.filter((f) => /\.(js|html|css)$/.test(f)).map((f) => [f, readFileSync(f, 'utf8')]);
const FIXTURE_STRINGS = ['ZEROED_FIXTURES_DEV_ONLY', 'FAKEmint', 'Fixture data', 'Sample data'];

if (preview) {
  const missing = ['ZEROED_FIXTURES_DEV_ONLY', 'Sample data'].filter((m) => !text.some(([, s]) => s.includes(m)));
  if (missing.length) {
    console.error(`Preview build is missing: ${missing.join(', ')}`);
    process.exit(1);
  }
  console.log('check-build: preview build has the sample screen and its marker');
} else {
  const leaks = text.filter(([, s]) => FIXTURE_STRINGS.some((m) => s.includes(m))).map(([f]) => f);
  // Any chunk named after the fixtures page, or carrying a src/dev path, also fails.
  for (const f of all) {
    if (/fixture/i.test(f.slice(dist.length))) leaks.push(f);
    else if (/\.js$/.test(f) && readFileSync(f, 'utf8').includes('src/dev/')) leaks.push(f);
  }
  if (leaks.length) {
    console.error(`Fixture data found in the production build:\n${leaks.join('\n')}`);
    process.exit(1);
  }
  console.log('check-build: no fixture data in dist/');
}
