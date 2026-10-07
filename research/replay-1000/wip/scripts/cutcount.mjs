import { readFileSync, readdirSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
const [run, via] = process.argv.slice(2);
const root = `${run}/state/recorder`;
const byDay = {}; const allByDay = {}; const seen = new Set();
for (const boot of readdirSync(root)) for (const day of readdirSync(`${root}/${boot}/days`)) {
  const dir = `${root}/${boot}/days/${day}`;
  for (const f of readdirSync(dir).filter((x) => x.startsWith('frames-')).sort()) {
    for (const line of zstdDecompressSync(readFileSync(`${dir}/${f}`)).toString('utf8').split('\n')) {
      if (!line.includes('"type":"logs"') || !line.includes(`"via":"logs:${via}"`)) continue;
      const sig = /"signature":"([^"]+)"/.exec(line)?.[1]; if (seen.has(sig)) continue; seen.add(sig);
      const t = Number(/"receivedAt":(\d+)/.exec(line)[1]); const d = new Date(t).toISOString().slice(0, 13);
      allByDay[d] = (allByDay[d] ?? 0) + 1;
      if (line.includes('Log truncated')) byDay[d] = (byDay[d] ?? 0) + 1;
    }
  }
}
const tot = Object.values(allByDay).reduce((a, b) => a + b, 0), cut = Object.values(byDay).reduce((a, b) => a + b, 0);
console.log(JSON.stringify({ creates: tot, cut, share: (cut / tot).toFixed(4), hours: Object.keys(allByDay).length, cutPerHour: Object.fromEntries(Object.keys(allByDay).sort().map((h) => [h, `${byDay[h] ?? 0}/${allByDay[h]}`])) }));
