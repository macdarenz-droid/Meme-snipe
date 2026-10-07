import { readFileSync, readdirSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
const [dir, ...pats] = process.argv.slice(2);
const re = new RegExp(pats.join('|'));
for (const f of readdirSync(dir).filter((x) => x.endsWith('.zst')).sort()) {
  const s = zstdDecompressSync(readFileSync(`${dir}/${f}`)).toString('utf8');
  for (const l of s.split('\n')) if (re.test(l)) console.log(f, l.slice(0, 600));
}
