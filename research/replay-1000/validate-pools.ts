// REPLAY-1000: checks pool-state.ts on cached tapes: for every pool transaction after the migration, the state it
// rebuilds (quote vault, base vault, virtual reserves) must equal the next trade event's own pre-trade fields.
//   node research/replay-1000/validate-pools.ts <day> [mint-prefix ...]   (no prefix: every coin with a tape)
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodePool, fromBase64 } from '../../packages/core/src/chain/index.ts';
import { type Coin, loadIndex } from './coins.ts';
import { DATA_DIR, PublicRpc } from './rpc.ts';
import { WINDOW_END_S } from './collect.ts';
import { ChainView } from './world/chain.ts';
import { blockOrder } from './world/ws-world.ts';
import { poolAfter, type RpcTx } from './world/pool-state.ts';

const main = async () => {
  const day = process.argv[2]!;
  const rpc = new PublicRpc();
  const chain = new ChainView(rpc, loadIndex());
  const coins = (JSON.parse(readFileSync(join(DATA_DIR, `coins-${day}.json`), 'utf8')) as { coins: Coin[] }).coins;
  const tapes = JSON.parse(readFileSync(join(DATA_DIR, `tapes-${day}.json`), 'utf8')) as Record<string, unknown>;
  const pick = process.argv.length > 3 ? coins.filter((c) => process.argv.slice(3).some((p) => c.mint.startsWith(p))) : coins.filter((c) => tapes[c.mint] !== undefined);
  const total = { coins: 0, checked: 0, ok: 0, bad: 0 };
  for (const c of pick) {
    const mig = (await rpc.tx(c.migrationSig)) as RpcTx;
    // The vault addresses from the CreatePoolEvent's pool, via today's account (addresses never change).
    const acct = (await rpc.result<{ value: { data: [string, string] } | null }>('getAccountInfo', [c.pool, { encoding: 'base64' }])).value;
    if (acct === null) { console.log(c.mint.slice(0, 6), 'no pool account'); continue; }
    const p = decodePool(fromBase64(acct.data[0])).value;
    const pool = { address: c.pool, baseVault: p.poolBaseTokenAccount as string, quoteVault: p.poolQuoteTokenAccount as string };
    const endSlot = chain.clock.slotAt((c.migrationTime + WINDOW_END_S) * 1000);
    const sigs = blockOrder((await chain.signaturesBetween(c.pool, c.migrationSlot - 1, endSlot)).filter((x) => x.err === null));
    let prev: NonNullable<ReturnType<typeof poolAfter>> | null = null;
    const r = { checked: 0, ok: 0, bad: 0, first: '' };
    for (const s of sigs) {
      if (!rpc.hasTx(s.signature) && !existsSync('/nonexistent')) { /* fetched on demand below */ }
      const tx = (await rpc.tx(s.signature)) as RpcTx;
      let a: NonNullable<ReturnType<typeof poolAfter>>;
      try {
        const got = poolAfter(s.signature, tx, pool, prev?.effective ?? null);
        if (got === null) continue;
        a = got;
      } catch (e) {
        if (r.first === '') r.first = `${s.signature.slice(0, 8)} ${String(e)}`;
        r.bad++;
        prev = null;
        continue;
      }
      if (prev !== null && a.firstPre !== null && prev.virtualQuoteReserves !== null) {
        r.checked++;
        const same = a.firstPre.quoteVault === prev.quoteVault && a.firstPre.baseVault === prev.baseVault && a.firstPre.virtual === prev.virtualQuoteReserves;
        if (same) r.ok++;
        else {
          r.bad++;
          if (r.first === '') r.first = `${s.signature.slice(0, 8)} pre q${a.firstPre.quoteVault} b${a.firstPre.baseVault} v${a.firstPre.virtual} vs rebuilt q${prev.quoteVault} b${prev.baseVault} v${prev.virtualQuoteReserves} [${prev.events.join(',')}]`;
        }
      }
      prev = a;
    }
    void mig;
    total.coins++;
    total.checked += r.checked;
    total.ok += r.ok;
    total.bad += r.bad;
    console.log(c.mint.slice(0, 6), JSON.stringify(r));
  }
  console.log('total', JSON.stringify(total));
};
if (process.argv[1] === new URL(import.meta.url).pathname) await main();
