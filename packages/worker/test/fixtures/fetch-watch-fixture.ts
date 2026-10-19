// Fetches WATCH-1's snapshot fixture (watch-snapshot.json) from the public Solana RPC: one coherent read of an active
// canonical PumpSwap pool (pool, both vaults, the mint, PumpSwap's GlobalConfig and its FeeConfig in one
// getMultipleAccounts at confirmed), then the pool's first successful swap after that slot whose pre-trade reserves
// equal the read. The test quotes that swap from the snapshot alone and must match the chain's fees and amounts.
// Run: node --no-warnings packages/worker/test/fixtures/fetch-watch-fixture.ts
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PUMP_AMM_GLOBAL_CONFIG, PUMP_AMM_PROGRAM, decodePool, feeConfigAddress, fromBase64, pumpPoolAuthority, recordFromRpc, toAddress, transactionEvents, type RpcTransactionBase64 } from '../../../core/src/chain/index.ts';
import { casesHash } from './fixture-hash.ts';
import { redactRpc } from '../../../core/test/redact-rpc.ts';

const RPC = process.env['SOLANA_RPC'] ?? 'https://api.mainnet-beta.solana.com';
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'watch-snapshot.json');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rpc = async <T>(method: string, params: unknown[]): Promise<T> => {
  for (let i = 0; ; i++) {
    const res = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    if ((res.status === 429 || res.status >= 500) && i < 8) {
      await sleep(500 * 2 ** i);
      continue;
    }
    const j = (await res.json()) as { result?: T; error?: unknown };
    if (j.error !== undefined) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
    return j.result as T;
  }
};
type Sig = { signature: string; err: unknown; slot: number };
type Tx = RpcTransactionBase64 & { slot: number };
const getTx = (sig: string) => rpc<Tx>('getTransaction', [sig, { encoding: 'base64', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }]);
const swapsOf = (sig: string, t: Tx) => transactionEvents(recordFromRpc(sig, t)).filter((e) => e.program === 'pump_amm' && (e.name === 'BuyEvent' || e.name === 'SellEvent'));
type Accounts = { context: { slot: number }; value: ({ owner: string; data: [string, string] } | null)[] };

const FEE_CONFIG = feeConfigAddress(PUMP_AMM_PROGRAM);
for (let attempt = 0; attempt < 10; attempt++) {
  // An active canonical SOL pool: the pool of a recent swap whose creator is pump's pool-authority PDA of its mint.
  const recent = await rpc<Sig[]>('getSignaturesForAddress', [PUMP_AMM_PROGRAM, { limit: 25, commitment: 'confirmed' }]);
  let pool: string | null = null;
  for (const s of recent.filter((x) => x.err === null)) {
    const ev = swapsOf(s.signature, await getTx(s.signature))[0];
    if (ev === undefined) continue;
    const address = String((ev.data as { pool: string }).pool);
    const acc = await rpc<Accounts>('getMultipleAccounts', [[address], { encoding: 'base64', commitment: 'confirmed' }]);
    const p = decodePool(fromBase64(acc.value[0]!.data[0])).value;
    if (p.creator === pumpPoolAuthority(toAddress(p.baseMint)) && p.quoteMint === 'So11111111111111111111111111111111111111112') {
      pool = address;
      break;
    }
  }
  if (pool === null) continue;
  const first = await rpc<Accounts>('getMultipleAccounts', [[pool], { encoding: 'base64', commitment: 'confirmed' }]);
  const p = decodePool(fromBase64(first.value[0]!.data[0])).value;
  const addresses = [pool, p.poolBaseTokenAccount, p.poolQuoteTokenAccount, p.baseMint, PUMP_AMM_GLOBAL_CONFIG, FEE_CONFIG];
  const read = await rpc<Accounts>('getMultipleAccounts', [addresses, { encoding: 'base64', commitment: 'confirmed' }]);
  const slot = read.context.slot;
  // The pool's first successful swap after the read, within two minutes.
  let next: { signature: string; tx: Tx } | null = null;
  for (let k = 0; k < 24 && next === null; k++) {
    await sleep(5_000);
    const sigs = (await rpc<Sig[]>('getSignaturesForAddress', [pool, { limit: 100, commitment: 'confirmed' }])).filter((s) => s.slot > slot).reverse();
    for (const s of sigs) {
      if (s.err !== null) continue;
      const tx = await getTx(s.signature);
      if (swapsOf(s.signature, tx).length > 0) {
        next = { signature: s.signature, tx };
        break;
      }
    }
  }
  if (next === null) continue;
  const payload = {
    pool, mint: p.baseMint, slot,
    accounts: addresses.map((address, i) => ({ address, owner: read.value[i]?.owner ?? null, dataBase64: read.value[i]?.data[0] ?? null })),
    next: { signature: next.signature, slot: next.tx.slot, blockTime: next.tx.blockTime, transaction: next.tx.transaction, meta: next.tx.meta },
  };
  writeFileSync(OUT, `${JSON.stringify({ meta: { rpc: redactRpc(RPC), fetchedAt: new Date().toISOString(), sha256: casesHash(payload) }, ...payload }, null, 1)}\n`);
  console.log(`wrote ${pool} at slot ${slot}, next swap ${next.signature} at slot ${next.tx.slot}`);
  process.exit(0);
}
throw new Error('no fixture after 10 attempts');
