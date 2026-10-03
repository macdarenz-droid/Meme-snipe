// shared helpers: polite fetch with backoff, RPC, GeckoTerminal limiter
export const sleep = (ms) => new Promise(r => setTimeout(r, ms));
export async function getJSON(url, opts = {}, tries = 6) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(30000) });
      if (r.status === 429) { await sleep(Math.min(60000, 4000 * 2 ** i)); continue; }
      if (!r.ok) return { _err: r.status, _body: (await r.text()).slice(0, 200) };
      const j = await r.json();
      if (j?.error?.code === 429) { await sleep(Math.min(60000, 3000 * 2 ** i)); continue; }
      return j;
    } catch (e) { await sleep(2000 * (i + 1)); }
  }
  return { _err: 'failed' };
}
export const RPC = 'https://api.mainnet-beta.solana.com';
export const rpc = (method, params) => getJSON(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
let lastGT = 0;
export async function gt(path, minGapMs = 3500) { // ~17 calls/min max from this process (GT public limit ~30/min, shared)
  const wait = lastGT + minGapMs - Date.now(); if (wait > 0) await sleep(wait); lastGT = Date.now();
  return getJSON('https://api.geckoterminal.com/api/v2' + path, { headers: { accept: 'application/json' } });
}
