import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
const [run, coinsF] = process.argv.slice(2);
const full = new Set(JSON.parse(readFileSync(coinsF, 'utf8')).map((c) => c.mint));
const cut = new Map(); // sig -> {at, first, last, coins:Set, lines}
const re = /creates log ([1-9A-HJ-NP-Za-km-z]+) on logs:\S+ was cut or undecodable at (\d+)/;
for (const s of readFileSync(`${run}/state/journal.jsonl`, 'utf8').split('\n')) {
  if (!s.includes('was cut or undecodable')) continue;
  const l = JSON.parse(s); const mint = l.reasons?.[2];
  for (const g of l.gate_reasons ?? []) {
    const m = re.exec(g.detail ?? ''); if (!m) continue;
    const e = cut.get(m[1]) ?? { at: Number(m[2]), first: l.ts, last: l.ts, coins: new Set(), lines: 0, sample: 0 };
    e.last = l.ts; e.lines++; if (full.has(mint)) { e.coins.add(mint); e.sample++; }
    cut.set(m[1], e);
  }
}
// Every creates-log notice that was cut, and every fetched tx, from the recording.
const fetched = new Map(); const seenCut = new Map();
const root = `${run}/state/recorder`;
for (const boot of readdirSync(root)) for (const day of readdirSync(`${root}/${boot}/days`)) {
  const dir = `${root}/${boot}/days/${day}`;
  for (const f of readdirSync(dir).filter((x) => x.startsWith('frames-')).sort()) {
    for (const line of zstdDecompressSync(readFileSync(`${dir}/${f}`)).toString('utf8').split('\n')) {
      if (line.includes('"type":"tx"')) {
        const m = /"signature":"([1-9A-HJ-NP-Za-km-z]+)"/.exec(line); const t = /"receivedAt":(\d+)/.exec(line);
        if (m && t && !fetched.has(m[1])) fetched.set(m[1], Number(t[1]));
      }
    }
  }
}
let healedAfter = 0, neverFetched = 0, fetchedBeforeLast = 0;
const rows = [];
for (const [sig, e] of cut) {
  const f = fetched.get(sig);
  if (f === undefined) neverFetched++;
  else if (f > Date.parse(e.last)) healedAfter++;
  else fetchedBeforeLast++;
  rows.push({ sig, at: new Date(e.at).toISOString(), fetchedAt: f === undefined ? null : new Date(f).toISOString(), firstNamed: e.first, lastNamed: e.last, sampleCoins: e.coins.size, lines: e.lines });
}
writeFileSync(`${run}/cut-creates.json`, JSON.stringify(rows, null, 1));
console.log(JSON.stringify({ cutSigsNamed: cut.size, neverFetched, fetchedButStillNamedAfterFetch: fetchedBeforeLast, namedOnlyBeforeFetch: healedAfter }));
