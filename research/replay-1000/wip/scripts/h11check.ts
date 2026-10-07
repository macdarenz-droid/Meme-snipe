import { readFileSync } from 'node:fs';
import { loadIndex } from '/home/user/Meme-snipe/research/replay-1000/coins.ts';
import { PublicRpc } from '/home/user/Meme-snipe/research/replay-1000/rpc.ts';
import { ChainView } from '/home/user/Meme-snipe/research/replay-1000/world/chain.ts';
import { recordFromRpc, transactionEvents } from '/home/user/Meme-snipe/packages/core/src/chain/index.ts';
const [coinsF, ...prefixes] = process.argv.slice(2);
const coins = JSON.parse(readFileSync(coinsF!, 'utf8')) as { mint: string; pool: string; migrationSlot: number; migrationTime: number }[];
const chain = new ChainView(new PublicRpc(), loadIndex());
for (const p of prefixes) {
  const c = coins.find((x) => x.mint.startsWith(p))!;
  const end = chain.clock.slotAt((c.migrationTime + 330) * 1000);
  const sigs = (await chain.signaturesBetween(c.pool, c.migrationSlot - 1, end)).filter((x) => x.err === null);
  sigs.sort((a, b) => a.slot - b.slot || ((a as { transactionIndex?: number }).transactionIndex ?? 0) - ((b as { transactionIndex?: number }).transactionIndex ?? 0));
  let mig: number | null = null;
  const pts: { t: number; px: number }[] = [];
  for (const s of sigs) {
    const t = await chain.transaction(s.signature, Number.MAX_SAFE_INTEGER);
    for (const e of transactionEvents(recordFromRpc(s.signature, t as never) as never) as unknown as { name: string; data: Record<string, bigint> }[]) {
      if (e.name === 'CreatePoolEvent') mig = Number(e.data['poolQuoteAmount']) / Number(e.data['poolBaseAmount']);
      if (e.name === 'BuyEvent' || e.name === 'SellEvent') {
        const d = e.data;
        const q = Number(d['poolQuoteTokenReserves']) + Number(d['virtualQuoteReserves'] ?? 0n);
        const b = Number(d['poolBaseTokenReserves']);
        const dq = e.name === 'BuyEvent' ? Number(d['quoteAmountInWithLpFee']) : -Number(d['quoteAmountOutWithoutLpFee'] ?? d['userQuoteAmountOut']);
        const db = e.name === 'BuyEvent' ? -Number(d['baseAmountOut']) : Number(d['baseAmountIn']);
        pts.push({ t: s.blockTime!, px: (q + dq) / (b + db) });
      }
    }
  }
  const at = c.migrationTime + 300;
  const bucketEnd = Math.floor(at / 60) * 60; // the last whole-minute candle that ended by +5 min
  const before = pts.filter((x) => x.t < bucketEnd);
  const close = before.at(-1)?.px ?? null;
  console.log(p, 'migration px', mig?.toExponential(4), 'close of last candle ending by +5m', close?.toExponential(4), close !== null && mig !== null ? `${(((close / mig) - 1) * 100).toFixed(2)}% vs migration` : '', 'swaps', pts.length);
}
