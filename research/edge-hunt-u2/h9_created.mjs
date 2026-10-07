// H9 input for the mints that traded in a simulation: creation time from the public keyless RPC, as the oldest
// signature touching the mint before its migration. A page of 1,000 that already reaches 5 min before the migration is
// enough to pass H9 (created at least 5 min before), so most mints need one call.
// Usage: node h9_created.mjs <datadir> <sim.json> ...   (appends to <datadir>/created.jsonl)
//        node h9_created.mjs <datadir> --follow            (every non-dust graduate, following migrations.jsonl; H8 dust and H9
//        reject in every trial, so the candle fetcher skips graduates that fail either: fewer calls, no change to any result)
import fs from 'node:fs';
const [, , D, ...SIMS] = process.argv;
const RPC = 'https://api.mainnet-beta.solana.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function rpc(method, params) {
  for (let i = 0; i < 10; i++) {
    try {
      const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(30000) });
      if (r.status === 429) { await sleep(Math.min(30000, 1000 * 2 ** i)); continue; }
      const j = await r.json();
      if (j.error) { await sleep(Math.min(30000, 1000 * 2 ** i)); continue; }
      return j.result;
    } catch { await sleep(2000 * (i + 1)); }
  }
  return undefined;
}
const readMig = () => {
  const mig = new Map();
  for (const l of fs.readFileSync(`${D}/migrations.jsonl`, 'utf8').trim().split('\n')) { try { const x = JSON.parse(l); if (x.kind === 'migrate' && x.mint && x.pool && (!mig.has(x.mint) || mig.get(x.mint).blockTime > x.blockTime)) mig.set(x.mint, x); } catch {} }
  return mig;
};
const outF = `${D}/created.jsonl`;
// A pool's later transactions can also log a Migrate instruction; the migration is the earliest one. A check made
// against a later record is redone (--recheck); the later line in created.jsonl wins.
const doneAt = new Map(fs.existsSync(outF) ? fs.readFileSync(outF, 'utf8').trim().split('\n').filter(Boolean).map((l) => { const x = JSON.parse(l); return [x.mint, x.migTs]; }) : []);
const done = new Set(doneAt.keys());
async function check(m) {
  let before = m.sig, oldest = null, pages = 0, complete = false;
  for (;;) {
    const arr = await rpc('getSignaturesForAddress', [m.mint, { limit: 1000, before }]);
    pages++;
    if (!arr) break;
    if (arr.length) { oldest = arr[arr.length - 1].blockTime; before = arr[arr.length - 1].signature; }
    if (arr.length < 1000) { complete = true; break; }
    if (oldest < m.blockTime - 300) break;
    await sleep(700);
  }
  fs.appendFileSync(outF, JSON.stringify({ mint: m.mint, migTs: m.blockTime, oldestBefore: oldest, complete, pages }) + '\n');
  done.add(m.mint);
  await sleep(700);
}
if (SIMS[0] === '--recheck') {
  const todo = [...readMig().values()].filter((m) => doneAt.has(m.mint) && doneAt.get(m.mint) !== m.blockTime);
  for (const m of todo) await check(m);
  console.log('rechecked', todo.length);
} else if (SIMS[0] === '--follow') {
  let idle = 0;
  while (idle < 20) {
    const todo = [...readMig().values()].filter((m) => m.kind === 'migrate' && m.sol >= 5 && !done.has(m.mint));
    if (!todo.length) { idle++; await sleep(30000); continue; }
    idle = 0;
    for (const m of todo) await check(m);
    console.log(new Date().toISOString(), 'checked', done.size);
  }
} else {
  const mig = readMig();
  const mints = new Set();
  for (const f of SIMS) for (const t of Object.values(JSON.parse(fs.readFileSync(f)).trials)) for (const x of t.trades) mints.add(x.mint);
  for (const mint of mints) if (!done.has(mint)) await check(mig.get(mint));
  console.log('done', mints.size);
}
