import { readFileSync, readdirSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
const [dir, file, pat, lo, hi] = process.argv.slice(2);
const s = zstdDecompressSync(readFileSync(`${dir}/${file}`)).toString('utf8');
for (const l of s.split('\n')) {
  if (!l.includes(pat)) continue;
  const m = /"receivedAt":(\d+)/.exec(l); if (!m) continue;
  const t = Number(m[1]); if (t < Number(lo) || t > Number(hi)) continue;
  if (/"type":"(seen|logs)"/.test(l)) continue;
  console.log(new Date(t).toISOString(), l.slice(0, 700));
}
