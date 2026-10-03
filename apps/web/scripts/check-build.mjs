// Fails the build if dev-only fixtures reached the production bundle.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const dist = new URL('../dist', import.meta.url).pathname;
const files = (dir) => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : [join(dir, n)]));
const leaks = files(dist).filter((f) => /\.(js|html|css)$/.test(f)).filter((f) => {
  const s = readFileSync(f, 'utf8');
  return s.includes('ZEROED_FIXTURES_DEV_ONLY') || s.includes('FAKEmint') || s.includes('Fixture data');
});
if (leaks.length) {
  console.error(`Fixture data found in the production build:\n${leaks.join('\n')}`);
  process.exit(1);
}
console.log('check-build: no fixture data in dist/');
