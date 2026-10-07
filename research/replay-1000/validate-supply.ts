// REPLAY-1000: checks the cheap supply rule (accounts.ts): after a transaction holding a PumpSwap trade event of a
// non-mayhem pool, the event's `baseSupply` equals the mint's supply (the running sum of every transaction's token
// balance change from the create). Mayhem pools are reported apart (their agent's extra supply is not in the field).
//   node research/replay-1000/validate-supply.ts <day> [mint-prefix ...]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { recordFromRpc, transactionEvents, type RpcTransactionBase64 } from '../../packages/core/src/chain/index.ts';
import { type Coin, loadIndex } from './coins.ts';
import { DATA_DIR, PublicRpc } from './rpc.ts';
import { WINDOW_END_S } from './collect.ts';
import { ChainView } from './world/chain.ts';
import { orderSigs, supplyDelta } from './world/accounts.ts';
import type { RpcTx } from './world/pool-state.ts';

const main = async () => {
  const day = process.argv[2]!;
  const rpc = new PublicRpc();
  const chain = new ChainView(rpc, loadIndex());
  const coins = (JSON.parse(readFileSync(join(DATA_DIR, `coins-${day}.json`), 'utf8')) as { coins: Coin[] }).coins;
  const tapes = JSON.parse(readFileSync(join(DATA_DIR, `tapes-${day}.json`), 'utf8')) as Record<string, { truncated?: boolean }>;
  const pick = process.argv.length > 3 ? coins.filter((c) => process.argv.slice(3).some((p) => c.mint.startsWith(p))) : coins.filter((c) => tapes[c.mint] !== undefined && tapes[c.mint]!.truncated !== true);
  const total = { coins: 0, mayhem: 0, trades: 0, ok: 0, bad: 0 };
  for (const c of pick) {
    const endSlot = chain.clock.slotAt((c.migrationTime + WINDOW_END_S) * 1000);
    const sigs = orderSigs((await chain.signaturesBetween(c.mint, 0, endSlot)).filter((x) => x.err === null));
    let supply = 0n;
    let mayhem = false;
    const r = { trades: 0, ok: 0, bad: 0, first: '' };
    for (const [i, s] of sigs.entries()) {
      const tx = (await rpc.tx(s.signature)) as RpcTx;
      if (i === 0 && !(tx.meta.logMessages ?? []).some((l) => /Instruction: Create(V2)?$/.test(l))) { r.first = 'history does not start at the create'; break; }
      supply += supplyDelta(tx, c.mint);
      for (const e of transactionEvents(recordFromRpc(s.signature, tx as unknown as RpcTransactionBase64))) {
        const d = (e as { data?: Record<string, unknown> }).data;
        if (e.name === 'CreatePoolEvent' && d?.['isMayhemMode'] === true) mayhem = true;
        if ((e.name !== 'BuyEvent' && e.name !== 'SellEvent') || d?.['pool'] !== c.pool || d['baseSupply'] === undefined) continue;
        r.trades++;
        if (d['baseSupply'] === supply) r.ok++;
        else { r.bad++; if (r.first === '') r.first = `${s.signature.slice(0, 8)} event ${d['baseSupply']} sum ${supply}`; }
      }
    }
    total.coins++;
    if (mayhem) { total.mayhem++; console.log(c.mint.slice(0, 6), 'mayhem', JSON.stringify(r)); continue; }
    total.trades += r.trades; total.ok += r.ok; total.bad += r.bad;
    console.log(c.mint.slice(0, 6), JSON.stringify(r));
  }
  console.log('total (non-mayhem)', JSON.stringify(total));
};
if (process.argv[1] === new URL(import.meta.url).pathname) await main();
