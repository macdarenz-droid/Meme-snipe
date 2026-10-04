import { readFileSync } from 'node:fs';
import { transactionEvents, recordFromRpc } from '/home/user/Meme-snipe/packages/core/src/chain/index.ts';
const fx = JSON.parse(readFileSync('/home/user/Meme-snipe/packages/core/test/chain/fixtures/transactions.json', 'utf8'));
const list = Array.isArray(fx) ? fx : Object.values(fx);
console.log(Object.keys(list[0] ?? {}), list.length);
for (const t of list as any[]) {
  try {
    const rec = recordFromRpc(t.signature, t.result ?? t.tx ?? t.response ?? t, t.txIndex ?? null);
    for (const e of transactionEvents(rec) as any[]) {
      if (e.name !== 'BuyEvent') continue;
      const d = e.data ?? e;
      console.log('bytes', 8 + 8 + (e.size ?? '?'), 'ix', d.ixName, 'n7', String(d.quoteAmountIn), 'n13', String(d.userQuoteAmountIn), 'n12', String(d.quoteAmountInWithLpFee), 'lp', String(d.lpFee));
    }
  } catch (err) { console.log('skip', (err as Error).message.slice(0, 80)); }
}
