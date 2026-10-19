// REPLAY-1000: caches every pump create transaction (the create authority's signatures, from the index) from a time on,
// for the creates stream: live, the bot's creates watch receives every create, and a truncated create log anywhere
// changes H14 for every coin (gates/hard.ts lostCreate). Decides nothing.
//   node research/replay-1000/prefetch-creates.ts <fromIso> [inFlight]
import { loadIndex } from './coins.ts';
import { PublicRpc, pool } from './rpc.ts';

const main = async () => {
  const from = Date.parse(process.argv[2]!) / 1000;
  const n = Number(process.argv[3] ?? '24');
  const net = new PublicRpc([new PublicRpc().urls[0]!]);
  const sigs = loadIndex().filter((x) => x.err === null && (x.blockTime ?? 0) >= from && !net.hasTx(x.signature));
  let done = 0;
  let missing = 0;
  await pool(sigs, n, async (x) => {
    try {
      if ((await net.tx(x.signature)) === null) missing++;
    } catch {
      missing++;
    }
    if (++done % 2000 === 0) console.error(`creates: ${done}/${sigs.length}, missing ${missing}, retries ${net.stats.retries}`);
  });
  console.error(`creates: ${done}/${sigs.length} done, missing ${missing}`);
};

if (process.argv[1] === new URL(import.meta.url).pathname) await main();
