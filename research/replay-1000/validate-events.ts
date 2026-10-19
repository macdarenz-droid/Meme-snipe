// REPLAY-1000: checks, on cached tapes, the event-field meanings the account rebuild relies on (accounts.ts):
// - Δsupply of a transaction = the sum over the mint's token balances of (post − pre) (no mint authority, so only burns);
// - a PumpSwap trade event's `baseSupply` is the mint supply after its transaction (or before: both are tested);
// - a trade event's `virtualQuoteReserves` is the pool's value at the trade and stays until a non-trade change.
//   node research/replay-1000/validate-events.ts <day> <mint-prefix>...
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { recordFromRpc, transactionEvents, type RpcTransactionBase64 } from '../../packages/core/src/chain/index.ts';
import type { Coin } from './coins.ts';
import { DATA_DIR, PublicRpc, type RawSig } from './rpc.ts';
import { sigsBetween, WINDOW_END_S } from './collect.ts';
import { blockOrder } from './world/ws-world.ts';

type Tx = { slot: number; meta: { err: unknown; preTokenBalances?: Bal[]; postTokenBalances?: Bal[]; loadedAddresses?: { writable: string[]; readonly: string[] } }; transaction: [string, string] };
type Bal = { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string } };

export const supplyDelta = (tx: Tx, mint: string): bigint => {
  const sum = (bs: Bal[] | undefined) => (bs ?? []).filter((b) => b.mint === mint).reduce((s, b) => s + BigInt(b.uiTokenAmount.amount), 0n);
  return sum(tx.meta.postTokenBalances) - sum(tx.meta.preTokenBalances);
};

const main = async () => {
  const day = process.argv[2]!;
  const rpc = new PublicRpc([new PublicRpc().urls[0]!]);
  const coins = (JSON.parse(readFileSync(join(DATA_DIR, `coins-${day}.json`), 'utf8')) as { coins: Coin[] }).coins;
  const anchor = (await rpc.sigPage('TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM', undefined, 1))[0]!.signature;
  for (const prefix of process.argv.slice(3)) {
    const c = coins.find((x) => x.mint.startsWith(prefix))!;
    const end = c.migrationTime + WINDOW_END_S;
    const mintSigs = blockOrder((await sigsBetween(rpc, c.mint, 0, end, anchor)).filter((x) => x.err === null));
    let supply: bigint | null = null;
    const r = { trades: 0, supplyAfterOk: 0, supplyAfterBad: 0, supplyBeforeOk: 0, vqrSame: 0, vqrChanged: 0, firstTx: '' };
    let lastVqr: bigint | null = null;
    const bad: string[] = [];
    for (const s of mintSigs as RawSig[]) {
      const tx = (await rpc.tx(s.signature)) as Tx;
      const rec = recordFromRpc(s.signature, tx as unknown as RpcTransactionBase64);
      const ev = transactionEvents(rec);
      if (supply === null) {
        const create = ev.find((e) => e.name === 'CreateEvent');
        if (create === undefined) { r.firstTx = 'not-create'; break; }
        supply = 0n; // the create mints the whole supply: its Δ below brings it to the total
      }
      const before = supply;
      supply += supplyDelta(tx, c.mint);
      for (const e of ev) {
        if ((e.name === 'BuyEvent' || e.name === 'SellEvent') && (e.data as { pool: string }).pool === c.pool) {
          const d = e.data as { baseSupply?: bigint; virtualQuoteReserves?: bigint };
          r.trades++;
          if (d.baseSupply !== undefined) {
            if (d.baseSupply === supply) r.supplyAfterOk++;
            else { r.supplyAfterBad++; if (bad.length < 5) bad.push(`${s.signature.slice(0, 8)} event ${d.baseSupply} after ${supply} before ${before}`); }
            if (d.baseSupply === before) r.supplyBeforeOk++;
          }
          if (d.virtualQuoteReserves !== undefined) {
            if (lastVqr === null || d.virtualQuoteReserves === lastVqr) r.vqrSame++;
            else r.vqrChanged++;
            lastVqr = d.virtualQuoteReserves;
          }
        }
        if ((e.name === 'BoostBuyAndBurnEvent' || e.name === 'InitBoostEvent') && (e.data as { pool: string }).pool === c.pool) lastVqr = (e.data as { virtualQuoteReserves: bigint }).virtualQuoteReserves;
      }
    }
    console.log(prefix, JSON.stringify(r), bad.join(' | '));
  }
};
if (process.argv[1] === new URL(import.meta.url).pathname) await main();
