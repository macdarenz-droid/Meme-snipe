// Shared helpers for EDGE-HUNT-U1: polite fetch with backoff, public keyless RPC, GeckoTerminal limiter.
// No bot key is ever used. DATA is the scratch data folder (large files stay out of git; manifests carry sha256).
export const sleep = (ms) => new Promise(r => setTimeout(r, ms));
export const DATA = process.env.EH_DATA || new URL('./data/', import.meta.url).pathname;
// Holdout wall (research/signals/window.json): start of Melbourne day 2026-09-22 = 2026-09-21T14:00Z. Nothing at or after it is read.
export const WALL_S = Date.parse('2026-09-21T14:00:00Z') / 1000;
export async function getJSON(url, opts = {}, tries = 7, onLimit = null) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(30000) });
      if (r.status === 429 || r.status >= 500) { if (onLimit) onLimit(); await sleep(Math.min(60000, (onLimit ? 1500 : 3000) * 2 ** i)); continue; }
      if (!r.ok) return { _err: r.status, _body: (await r.text()).slice(0, 200) };
      const j = await r.json();
      if (j?.error?.code === 429 || j?.error?.code === -32429) { if (onLimit) onLimit(); await sleep(Math.min(60000, 3000 * 2 ** i)); continue; }
      return j;
    } catch (e) { await sleep(2000 * (i + 1)); }
  }
  return { _err: 'failed' };
}
export const RPC = 'https://api.mainnet-beta.solana.com';
// Per-method pacing below the public RPC limit (40 requests / 10 s per method per IP): RPC_GAP ms between calls of a method.
const lastCall = new Map(), gaps = new Map();
// Adaptive: each 429 widens the method's gap by 1.5x (up to 10 s); each success narrows it by 2% (down to RPC_GAP).
const lastWiden = new Map(); // one widening per 2 s, so simultaneous 429s from several workers count once
const widen = (m) => { if (process.env.ADAPT === '0') return; const now = Date.now(); if (now - (lastWiden.get(m) || 0) < 2000) return; lastWiden.set(m, now);
  gaps.set(m, Math.min(5000, (gaps.get(m) || Number(process.env.RPC_GAP || 330)) * 1.3)); };
const narrow = (m) => gaps.set(m, Math.max(Number(process.env.RPC_GAP || 330), (gaps.get(m) || Number(process.env.RPC_GAP || 330)) * 0.99));
export const gapOf = (m) => gaps.get(m);
export async function pace(method) {
  const gap = gaps.get(method) || Number(process.env.RPC_GAP || 330);
  for (;;) { const t = lastCall.get(method) || 0, now = Date.now(); if (now >= t + gap) { lastCall.set(method, now); return; } await sleep(t + gap - now); }
}
export const rpc = async (method, params) => { await pace(method); const r = await rpcRaw(method, params); if (r && !r._err) narrow(method); return r; };
const rpcRaw = (method, params) => getJSON(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }, 7, () => widen(method));
let lastGT = 0;
export async function gt(path, minGapMs = 2100) { // <= ~28 calls/min (GeckoTerminal public limit 30/min)
  const wait = lastGT + minGapMs - Date.now(); if (wait > 0) await sleep(wait); lastGT = Date.now();
  return getJSON('https://api.geckoterminal.com/api/v2' + path, { headers: { accept: 'application/json' } });
}
// One record per pool: the earliest migration (later transactions can also log a Migrate instruction; EDGE-HUNT-U2 fix).
export function earliest(recs) {
  const m = new Map();
  for (const r of recs) if (r.pool && (!m.has(r.pool) || r.t < m.get(r.pool).t)) m.set(r.pool, r);
  return [...m.values()];
}
