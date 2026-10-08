// Writes src/styles/tokens.css and src/styles/tokens.json from src/theme/tokens.ts (UI-T02): `npm run tokens`.
// test/tokens.test.ts fails when the committed files differ from what this would write.
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tokensCss, tokensJson } from '../../src/theme/tokens.ts';
import { PACKAGE_DIR } from './build.ts';

export const TOKENS_CSS = join(PACKAGE_DIR, 'src/styles/tokens.css');
export const TOKENS_JSON = join(PACKAGE_DIR, 'src/styles/tokens.json');

/** The tokens.json text: the JSON with two-space indentation and a final newline. */
export function tokensJsonText(): string {
  return `${JSON.stringify(tokensJson(), null, 2)}\n`;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeFileSync(TOKENS_CSS, tokensCss());
  writeFileSync(TOKENS_JSON, tokensJsonText());
  process.stdout.write('tokens: wrote src/styles/tokens.css and src/styles/tokens.json\n');
}
