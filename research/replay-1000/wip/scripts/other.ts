import { readFileSync } from 'node:fs';
import { loadIndex } from '/home/user/Meme-snipe/research/replay-1000/coins.ts';
import { DATA_DIR, PublicRpc } from '/home/user/Meme-snipe/research/replay-1000/rpc.ts';
import { ChainView } from '/home/user/Meme-snipe/research/replay-1000/world/chain.ts';
import { recordFromRpc, transactionEvents } from '/home/user/Meme-snipe/packages/core/src/chain/index.ts';
const [coinsF, prefix, untilIso] = process.argv.slice(2);
const c = (JSON.parse(readFileSync(coinsF!, 'utf8')) as { mint: string; pool: string; migrationSlot: number }[]).find((x) => x.mint.startsWith(prefix!))!;
const chain = new ChainView(new PublicRpc(undefined, DATA_DIR), loadIndex());
const end = chain.clock.slotAt(Date.parse(untilIso!));
const sigs = (await chain.signaturesBetween(c.pool, c.migrationSlot - 1, end)).filter((x) => x.err === null);
const counts: Record<string, number> = {};
const ex: Record<string, string> = {};
for (const s of sigs) {
  const t = await chain.transaction(s.signature, Number.MAX_SAFE_INTEGER);
  const evs = transactionEvents(recordFromRpc(s.signature, t as never) as never) as unknown as { program: string; name: string; discriminator?: string }[];
  for (const e of evs) {
    if (e.name === 'BuyEvent' || e.name === 'SellEvent') continue;
    const k = `${String(e.program).slice(0, 6)}:${e.name}${e.discriminator ? `:${e.discriminator}` : ''}`;
    counts[k] = (counts[k] ?? 0) + 1;
    ex[k] ??= `${s.slot} ${s.signature}`;
  }
}
console.log(sigs.length, 'txs', counts, ex);
