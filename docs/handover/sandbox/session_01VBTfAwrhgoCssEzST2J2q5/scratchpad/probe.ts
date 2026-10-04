import { readFileSync } from 'node:fs';
import { decodeBase58, toBase64 } from '/home/user/Meme-snipe/packages/core/src/chain/index.ts';
import { compactRaw } from '/home/user/Meme-snipe/packages/backtest/src/dataset/raw.ts';
const d = JSON.parse(readFileSync('/home/user/Meme-snipe/packages/worker/test/fixtures/rug-replay.json', 'utf8'));
for (const c of d.cases) for (const x of c.transactions.slice(0, 1)) {
  const m = x.meta;
  const line = JSON.stringify({ slot: x.slot, blockTime: x.blockTime, txIndex: 0, signature: x.signature, transaction: x.transaction[0], err: m.err, mints: [c.mint],
    meta: { loadedAddresses: m.loadedAddresses, innerInstructions: m.innerInstructions.map((g: any) => ({ index: g.index, instructions: g.instructions.map((i: any) => ({ ...i, data: toBase64(decodeBase58(i.data)) })) })) } });
  const r = compactRaw(line);
  console.log(c.name, c.mint, r?.undecodable, JSON.stringify(r?.ops, (_, v) => typeof v === 'bigint' ? v.toString() : v));
}
