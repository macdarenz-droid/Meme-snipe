// Save logMessages of recent successful swaps on SOL-quoted pump pools (public mainnet), for the size measurement.
import { writeFileSync } from 'node:fs';
import { logEvents } from '/home/user/wt-crash/packages/core/src/chain/transaction.ts';
const RPC = 'https://api.mainnet-beta.solana.com';
const sleep = (ms: number) => new Promise((g) => setTimeout(g, ms));
const call = async (method: string, params: unknown[]) => {
  for (let i = 0; i < 12; i++) {
    const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    if (r.status === 429) { await sleep(2500); continue; }
    const j: any = await r.json();
    if (j.error?.code === 429) { await sleep(2500); continue; }
    if (j.error) throw new Error(JSON.stringify(j.error));
    return j.result;
  }
  throw new Error('429s');
};
const sigs: any[] = (await call('getSignaturesForAddress', ['pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', { limit: 400 }])).filter((s: any) => s.err === null);
const out: { signature: string; slot: number; logs: string[]; tails: string[] }[] = [];
for (const s of sigs) {
  if (out.length >= 40) break;
  try {
    const tx = await call('getTransaction', [s.signature, { maxSupportedTransactionVersion: 1, commitment: 'confirmed', encoding: 'json' }]);
    const r = logEvents(tx.meta.logMessages, null);
    const sw = (r.events as any[]).filter((e) => e.program === 'pump_amm' && (e.name === 'BuyEvent' || e.name === 'SellEvent'));
    if (sw.length > 0) out.push({ signature: s.signature, slot: tx.slot, logs: tx.meta.logMessages, tails: sw.map((e) => e.extra) });
  } catch {}
  await sleep(200);
}
writeFileSync('/tmp/claude-0/-home-user/d5c7ba26-609b-51db-bbda-9009df99229c/scratchpad/crash-hunt/final/swaps.json', JSON.stringify(out));
const lines = out.map((o) => o.logs.length); const chars = out.map((o) => o.logs.join('').length);
console.log('saved', out.length, 'nonzero', out.filter((o) => o.tails.some((t) => /[^0]/.test(t))).length, 'lines avg', (lines.reduce((a, b) => a + b, 0) / out.length).toFixed(0), 'chars avg', (chars.reduce((a, b) => a + b, 0) / out.length).toFixed(0));
