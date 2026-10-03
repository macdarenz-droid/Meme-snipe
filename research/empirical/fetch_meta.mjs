// Batch metadata for a list of mints: Jupiter tokens v2 (50/call) and DexScreener tokens v1 (30/call), plus SOL/USD.
// NOTE: these are CURRENT values (at fetch time). Only fields fixed before migration (createdAt, socials in metadata,
// dev mint counts) are used as decision-time features; the rest are outcome/state-at-collection fields.
// Usage: node fetch_meta.mjs <migrations.jsonl> <out.json>
import fs from 'node:fs';
import { getJSON, sleep } from './lib.mjs';
const [, , MIGF, OUT] = process.argv;
const mints = [...new Set(fs.readFileSync(MIGF, 'utf8').trim().split('\n').map(l => { try { return JSON.parse(l).mint; } catch { return null; } }).filter(Boolean))];
const jup = {}, dex = {};
for (let i = 0; i < mints.length; i += 50) {
  const r = await getJSON('https://lite-api.jup.ag/tokens/v2/search?query=' + mints.slice(i, i + 50).join(','));
  if (Array.isArray(r)) for (const t of r) jup[t.id] = t; else console.log('jup err', JSON.stringify(r).slice(0, 200));
  await sleep(1200);
}
for (let i = 0; i < mints.length; i += 30) {
  const r = await getJSON('https://api.dexscreener.com/tokens/v1/solana/' + mints.slice(i, i + 30).join(','));
  if (Array.isArray(r)) for (const p of r) { const m = p.baseToken.address; (dex[m] ||= []).push(p); } else console.log('dex err', JSON.stringify(r).slice(0, 200));
  await sleep(400);
}
const sol = await getJSON('https://lite-api.jup.ag/tokens/v2/search?query=So11111111111111111111111111111111111111112');
const solUsd = Array.isArray(sol) ? sol[0].usdPrice : null;
fs.writeFileSync(OUT, JSON.stringify({ fetchedAt: Date.now(), solUsd, nMints: mints.length, jup, dex }));
console.log('mints', mints.length, 'jup', Object.keys(jup).length, 'dex', Object.keys(dex).length, 'solUsd', solUsd);
