import { readFileSync } from 'node:fs';
import { loadIndex } from '/home/user/replay-final/research/replay-1000/coins.ts';
import { PublicRpc } from '/home/user/replay-final/research/replay-1000/rpc.ts';
import { ChainView } from '/home/user/replay-final/research/replay-1000/world/chain.ts';
import { recordFromRpc, transactionEvents } from '/home/user/replay-final/packages/core/src/chain/index.ts';
const coins = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as { mint: string; migrationSlot: number }[];
const chain = new ChainView(new PublicRpc(), loadIndex());
let coinsAny = 0, evAll = 0, evNZ = 0, coinsUnknown = 0;
for (const c of coins) {
  let sigs;
  try { sigs = (await chain.signaturesBetween(c.mint, 0, c.migrationSlot)).filter((x) => x.err === null); } catch { coinsUnknown++; continue; }
  let n = 0, nz = 0, first = '';
  for (const s of sigs) {
    const t = await chain.transaction(s.signature, Number.MAX_SAFE_INTEGER);
    for (const e of transactionEvents(recordFromRpc(s.signature, t as never) as never) as unknown as { program: string; name: string; trailing?: number; extra?: string }[]) {
      if (e.program !== 'pump' || e.name !== 'TradeEvent') continue;
      n++;
      if (/[^0]/.test(e.extra ?? '')) { nz++; first ||= `${s.signature.slice(0, 10)} trailing ${e.trailing} ${e.extra}`; }
    }
  }
  evAll += n; evNZ += nz; if (nz > 0) coinsAny++;
  console.log(c.mint.slice(0, 8), 'curve trades', n, 'non-zero tail', nz, first);
}
console.log(JSON.stringify({ coins: coins.length, coinsWithNonZeroCurveTail: coinsAny, curveTrades: evAll, nonZero: evNZ, unknown: coinsUnknown }));
