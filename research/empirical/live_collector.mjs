// Live forward collector: PumpPortal new tokens + migrations + trades; decision-time snapshots at migration+60s.
// Run: NODE_USE_ENV_PROXY=1 node live_collector.mjs <minutes>
import fs from 'node:fs';
const DIR = new URL('./live/', import.meta.url).pathname;
const RUN_MIN = Number(process.argv[2] || 75);
const out = (f) => fs.createWriteStream(DIR + f, { flags: 'a' });
const fNew = out('new_tokens.jsonl'), fMig = out('migrations.jsonl'), fTr = out('trades.jsonl'), fSnap = out('snapshots.jsonl'), fLog = out('collector.log');
const log = (...a) => fLog.write(new Date().toISOString() + ' ' + a.join(' ') + '\n');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const START = Date.now();
fs.writeFileSync(DIR + 'run_meta.json', JSON.stringify({ start: new Date(START).toISOString(), plannedMinutes: RUN_MIN }));

async function getJSON(url, opts = {}, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(20000) });
      if (r.status === 429) { await sleep(3000 * (i + 1)); continue; }
      if (!r.ok) return { _err: r.status };
      return await r.json();
    } catch (e) { await sleep(1500 * (i + 1)); }
  }
  return { _err: 'failed' };
}
const RPC = 'https://api.mainnet-beta.solana.com';
const rpc = (method, params) => getJSON(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });

// serialize snapshot work to be gentle
let queue = Promise.resolve();
function enqueue(fn) { queue = queue.then(fn).catch(e => log('snapErr', e.message)); }

async function snapshot(mint, migTs, tag) {
  const t0 = Date.now();
  // Public RPC getTokenLargestAccounts was throttled (429) during the run, so holder data comes from
  // RugCheck full report (+60s only) and Jupiter audit (topHoldersPercentage, devBalancePercentage).
  const accs = [], owners = null, supply = null;
  const rug = await getJSON(`https://api.rugcheck.xyz/v1/tokens/${mint}/report${tag === 'mig+60s' ? '' : '/summary'}`);
  if (rug && rug.topHolders) rug.topHolders = rug.topHolders.slice(0, 20);
  if (rug) { delete rug.fileMeta; delete rug.lockers; delete rug.knownAccounts; }
  const dex = await getJSON(`https://api.dexscreener.com/tokens/v1/solana/${mint}`);
  const jup = await getJSON(`https://lite-api.jup.ag/tokens/v2/search?query=${mint}`);
  fSnap.write(JSON.stringify({ mint, tag, migTs, snapTs: t0, largest: accs, owners, supply, rug, dex, jup }) + '\n');
}

const watchedTrades = new Set();
let ws, nNew = 0, nMig = 0, nTr = 0;
function connect() {
  ws = new WebSocket('wss://pumpportal.fun/api/data');
  ws.onopen = () => {
    log('open');
    ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
    ws.send(JSON.stringify({ method: 'subscribeMigration' }));
  };
  ws.onmessage = (e) => {
    const now = Date.now();
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.message || m.errors) { log('msg', JSON.stringify(m).slice(0, 300)); return; }
    if (m.txType === 'create') {
      nNew++;
      fNew.write(JSON.stringify({ ts: now, mint: m.mint, creator: m.traderPublicKey, initialBuySol: m.solAmount, pool: m.pool, mayhem: m.is_mayhem_mode, name: m.name, symbol: m.symbol, uri: m.uri }) + '\n');
      return;
    }
    if (m.txType === 'migrate' || (m.signature && m.pool && !m.txType)) {
      nMig++;
      fMig.write(JSON.stringify({ ts: now, ...m }) + '\n');
      const mint = m.mint;
      // NOTE: subscribeTokenTrade needs a funded API key (verified 2026-10-03), so trades are not collected.
      if (mint) setTimeout(() => enqueue(() => snapshot(mint, now, 'mig+60s')), 60000);
      if (mint) setTimeout(() => enqueue(() => snapshot(mint, now, 'mig+5m')), 300000);
      return;
    }
    if (m.txType === 'buy' || m.txType === 'sell') {
      nTr++;
      fTr.write(JSON.stringify({ ts: now, mint: m.mint, t: m.txType, sol: m.solAmount, tok: m.tokenAmount, tr: m.traderPublicKey, pool: m.pool, mc: m.marketCapSol, sig: m.signature }) + '\n');
      return;
    }
    log('other', JSON.stringify(m).slice(0, 500));
  };
  ws.onclose = () => { log('close'); if (Date.now() - START < RUN_MIN * 60000) setTimeout(connect, 3000); };
  ws.onerror = (e) => log('wserr', e?.message || '');
}
connect();
setInterval(() => log(`stats new=${nNew} mig=${nMig} trades=${nTr} watched=${watchedTrades.size}`), 60000);
setTimeout(async () => { log('stopping'); try { ws.close(); } catch {} await sleep(320000); await queue; log('done'); process.exit(0); }, RUN_MIN * 60000);
