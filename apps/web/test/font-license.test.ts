// Geist is SIL OFL 1.1: every folder in the repo that ships its font files, or an SVG with the font embedded, carries
// the licence beside them (OFL 1.1 §2: the copyright notice and licence go with every copy).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);

describe('font licence', () => {
  it('sits beside every font file and every SVG that embeds a font', () => {
    const fonts = tracked.filter((f) => /\.(woff2?|ttf|otf)$/i.test(f));
    const embedded = tracked.filter((f) => f.endsWith('.svg') && /@font-face/.test(readFileSync(join(root, f), 'utf8')));
    expect(fonts).toContain('brand/geist-semibold.woff2');
    expect(embedded).toContain('brand/zeroed-lockup-ink.svg');
    for (const dir of new Set([...fonts, ...embedded].map(dirname))) {
      const ofl = join(root, dir, 'OFL.txt');
      expect(existsSync(ofl), `${dir}/OFL.txt`).toBe(true);
      const text = readFileSync(ofl, 'utf8');
      expect(text, dir).toContain('Copyright (c) 2023 Vercel');
      expect(text, dir).toContain('SIL Open Font License, Version 1.1');
    }
  });
});
