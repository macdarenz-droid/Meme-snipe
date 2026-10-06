// REPLAY-1000: fills the cache for the coins replayed only for their migration and survival read (run.ts `others`):
// the account reads the bot makes at +30 min (and the create lookup at its shortlist), run through the same account
// world, so the replay itself reads them from disk. Decides nothing.
//   node research/replay-1000/prefetch-others.ts <others.json> [inFlight]
import { readFileSync } from 'node:fs';
import { decodePool, fromBase64 } from '../../packages/core/src/chain/index.ts';
import { PUMP_AMM_GLOBAL_CONFIG } from '../../packages/core/src/chain/index.ts';
import { PUMP_AMM_FEE_CONFIG } from '../../packages/worker/src/run/snapshot.ts';
import { loadIndex } from './coins.ts';
import { PublicRpc, pool } from './rpc.ts';
import { AccountWorld } from './world/accounts.ts';
import { ChainView } from './world/chain.ts';
import type { RunCoin } from './run.ts';

const main = async () => {
  const coins = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as RunCoin[];
  const n = Number(process.argv[3] ?? '8');
  const net = new PublicRpc();
  const chain = new ChainView(net, loadIndex());
  const accounts = new AccountWorld(chain, net);
  let done = 0;
  const refused: Record<string, number> = {};
  await pool(coins, n, async (c) => {
    try {
      await accounts.addCoin(c);
      // The create lookup at the shortlist: the mint's oldest signature and its transaction.
      const created = (await chain.signaturesBetween(c.mint, 0, c.migrationSlot)).filter((x) => x.err === null);
      if (created[0] !== undefined) await net.tx(created[0].signature);
      const p = await accounts.snapshot(c.pool);
      const d = p.value === null ? null : decodePool(fromBase64(p.value.data[0])).value;
      for (const dt of [30 * 60 + 5, 30 * 60 + 40]) {
        const asOf = chain.confirmedSlot((c.migrationTime + dt) * 1000);
        for (const a of [c.mint, c.pool, ...(d === null ? [] : [d.poolBaseTokenAccount, d.poolQuoteTokenAccount, d.lpMint]), PUMP_AMM_GLOBAL_CONFIG, PUMP_AMM_FEE_CONFIG]) {
          await accounts.account(a, asOf).catch((e: unknown) => {
            const k = String((e as { reason?: string }).reason ?? e).slice(0, 60);
            refused[k] = (refused[k] ?? 0) + 1;
          });
        }
      }
    } catch (e) {
      const k = String((e as Error).message).slice(0, 60);
      refused[k] = (refused[k] ?? 0) + 1;
    }
    if (++done % 25 === 0) console.error(`others: ${done}/${coins.length}, refusals ${JSON.stringify(refused)}, calls ${JSON.stringify(net.stats.calls)}`);
  });
  console.error(`others: ${done}/${coins.length} done, refusals ${JSON.stringify(refused)}`);
};

if (process.argv[1] === new URL(import.meta.url).pathname) await main();
