// Fetch recent PumpSwap txs from public mainnet RPC; decode with the repo's logEvents; test the store's collapse rule.
import { logEvents } from '/home/user/wt-crash/packages/core/src/chain/transaction.ts';
import { tradeTailCollapse } from '/home/user/wt-crash/packages/core/src/gates/tails.ts';
const RPC = 'https://api.mainnet-beta.solana.com';
const call = async (method: string, params: unknown[]) => {
  for (let i = 0; i < 6; i++) {
    const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    const j: any = await r.json();
    if (j.error?.code === 429 || r.status === 429) { await new Promise((g) => setTimeout(g, 1500)); continue; }
    if (j.error) throw new Error(JSON.stringify(j.error));
    return j.result;
  }
  throw new Error('429s');
};
const sigs: any[] = await call('getSignaturesForAddress', ['pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', { limit: 200 }]);
const ok = sigs.filter((s) => s.err === null).slice(0, 60);
const tally = new Map<string, number>();
for (const s of ok) {
  let tx: any;
  try { tx = await call('getTransaction', [s.signature, { maxSupportedTransactionVersion: 1, commitment: 'confirmed', encoding: 'json' }]); } catch (e) { console.log('skip', String(e).slice(0, 80)); continue; }
  if (!tx?.meta?.logMessages) { console.log('nolog'); continue; } const pd = tx.meta.logMessages.filter((l: string) => l.startsWith('Program data:')).length; tally.set('txs with Program data lines: ' + (pd > 0), (tally.get('txs with Program data lines: ' + (pd > 0)) ?? 0) + 1);
  const read = logEvents(tx.meta.logMessages, null);
  for (const e of read.events as any[]) {
    if (e.program !== 'pump_amm' && e.program !== 'pump') continue;
    const subject = e.name === 'other' ? e.program : ('mint' in e.data ? e.data.mint : 'pool' in e.data ? e.data.pool : e.program);
    const key = `logs:${e.program}:${e.name}:${subject}`;
    const entry = { moment: { slot: BigInt(tx.slot), txIndex: 0, ixIndex: 0, receivedAt: 0 }, source: 'x', value: { event: e, signature: s.signature, txSlot: BigInt(tx.slot), truncated: read.truncated, via: 'logs:x' } };
    const test = tradeTailCollapse(key);
    const kept = test === null ? 'n/a' : String(test(entry as any));
    const k = `${e.program}:${e.name} trailing=${e.trailing ?? '-'} extra=${e.extra ?? e.discriminator ?? '-'} keptByCollapse=${kept} truncated=${read.truncated}`;
    tally.set(k, (tally.get(k) ?? 0) + 1);
  }
  await new Promise((g) => setTimeout(g, 600));
}
console.log('slot sample', ok[0]?.slot, 'txs', ok.length);
for (const [k, n] of [...tally].sort((a, b) => b[1] - a[1])) console.log(n, k);
