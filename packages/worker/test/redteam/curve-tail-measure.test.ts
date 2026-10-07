// A-FACTS-FIXES (RT-A2): how often a pump bonding-curve TradeEvent carries a non-zero 8-byte tail, and how many of a
// graduated coin's curve trades do. Run by hand against the free public RPC (no Helius credits):
//   ZEROED_MEASURE=1 npx vitest run packages/worker/test/redteam/curve-tail-measure.test.ts
// It is skipped in `pnpm test` (it reads mainnet).
import { appendFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { bondingCurveAddress, recordFromRpc, transactionEvents, type Address, type RpcTransactionBase64 } from '../../../core/src/chain/index.ts';
import { PUMP_MIGRATION_AUTHORITY } from '../../src/run/sources.ts';

const URL_ = process.env['ZEROED_MEASURE_RPC'] ?? 'https://api.mainnet-beta.solana.com';
const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
/** The report goes to this file (the test runner keeps console output quiet). */
const OUT = process.env['ZEROED_MEASURE_OUT'] ?? 'curve-tail-measure.txt';
const say = (line: string) => appendFileSync(OUT, `${line}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const call = async (method: string, params: unknown[]): Promise<any> => {
  for (let k = 0; k < 6; k++) {
    const r = await fetch(URL_, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    if (r.status === 429) { await sleep(2_000 * (k + 1)); continue; }
    const j = await r.json() as { result?: unknown; error?: unknown };
    if (j.error !== undefined) throw new Error(JSON.stringify(j.error));
    return j.result;
  }
  throw new Error('rate limited');
};
const tx = async (sig: string) => {
  const res = await call('getTransaction', [sig, { encoding: 'base64', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]) as RpcTransactionBase64 | null;
  return res === null ? null : recordFromRpc(sig, res);
};
type Tail = { mint: string; extra: string; trailing: number; slot: bigint; sig: string };
const curveTails = (rec: NonNullable<Awaited<ReturnType<typeof tx>>>): Tail[] => transactionEvents(rec)
  .filter((e) => e.program === 'pump' && e.name === 'TradeEvent')
  .map((e) => ({ mint: String((e.data as Record<string, unknown>)['mint']), extra: (e as unknown as { extra: string }).extra, trailing: (e as unknown as { trailing: number }).trailing, slot: rec.slot, sig: rec.signature }));

describe.skipIf(process.env['ZEROED_MEASURE'] !== '1')('RT-A2 measurement: curve trade tails on mainnet', () => {
  it('recent pump program trades, and whole curves of recent graduates', async () => {
    const N = Number(process.env['ZEROED_MEASURE_N'] ?? 200);
    const sigs = (await call('getSignaturesForAddress', [PUMP, { limit: 1000, commitment: 'confirmed' }]) as { signature: string; err: unknown }[]).filter((x) => x.err === null);
    const tails: Tail[] = [];
    let txs = 0;
    for (const s of sigs.slice(0, N)) {
      const rec = await tx(s.signature).catch(() => null);
      await sleep(120);
      if (rec === null) continue;
      txs++;
      tails.push(...curveTails(rec));
    }
    const nz = tails.filter((t) => /[^0]/.test(t.extra));
    const values = new Map<string, number>();
    for (const t of tails) values.set(`${t.trailing}:${/[^0]/.test(t.extra) ? 'non-zero' : 'zero'}`, (values.get(`${t.trailing}:${/[^0]/.test(t.extra) ? 'non-zero' : 'zero'}`) ?? 0) + 1);
    say(`RECENT: ${txs} transactions, ${tails.length} curve TradeEvents, ${nz.length} non-zero tails (${tails.length === 0 ? 0 : (100 * nz.length / tails.length).toFixed(1)}%), by length/zero: ${JSON.stringify([...values])}; slots ${tails.at(-1)?.slot}..${tails[0]?.slot}`);
    say(`RECENT non-zero sample: ${JSON.stringify(nz.slice(0, 8).map((t) => [t.extra, t.sig.slice(0, 12)]))}`);
  }, 30 * 60_000);

  it('the curve transactions of recent graduates (what reading a whole curve would cost live)', async () => {
    const G = Number(process.env['ZEROED_MEASURE_G'] ?? 10);
    const migs = (await call('getSignaturesForAddress', [PUMP_MIGRATION_AUTHORITY, { limit: 200, commitment: 'confirmed' }]) as { signature: string; err: unknown }[]).filter((x) => x.err === null);
    const counts: number[] = [];
    const completing: string[] = [];
    for (const m of migs) {
      if (counts.length >= G) break;
      const rec = await tx(m.signature).catch(() => null);
      await sleep(150);
      const ev = rec === null ? undefined : transactionEvents(rec).find((e) => e.name === 'CompletePumpAmmMigrationEvent');
      if (ev === undefined) continue;
      const curve = bondingCurveAddress(String((ev.data as Record<string, unknown>)['mint']) as Address);
      let n = 0;
      let failed = 0;
      let before: string | undefined;
      for (let page = 0; page < 20; page++) {
        const sigs = await call('getSignaturesForAddress', [curve, { limit: 1000, commitment: 'confirmed', ...(before === undefined ? {} : { before }) }]) as { signature: string; err: unknown }[];
        await sleep(150);
        n += sigs.filter((x) => x.err === null).length;
        failed += sigs.filter((x) => x.err !== null).length;
        if (sigs.length < 1000) break;
        before = sigs.at(-1)!.signature;
      }
      counts.push(n);
      // The completing buy: the newest successful curve transaction holding this mint's CompleteEvent.
      let tail = 'not found';
      const newest = (await call('getSignaturesForAddress', [curve, { limit: 20, commitment: 'confirmed' }]) as { signature: string; err: unknown }[]).filter((x) => x.err === null);
      for (const x of newest) {
        if (x.signature === m.signature) continue;
        const c = await tx(x.signature).catch(() => null);
        await sleep(150);
        if (c === null || !transactionEvents(c).some((e) => e.name === 'CompleteEvent')) continue;
        tail = curveTails(c).map((t) => t.extra).join('|');
        break;
      }
      completing.push(tail);
      say(`GRADUATE ${curve}: ${n} successful and ${failed} failed curve transactions; completing buy tail ${tail}`);
    }
    counts.sort((a, b) => a - b);
    say(`GRADUATES: ${counts.length}, successful curve transactions median ${counts[Math.floor(counts.length / 2)]}, min ${counts[0]}, max ${counts.at(-1)}; completing buys with a non-zero tail ${completing.filter((t) => /[^0|]/.test(t) && t !== 'not found').length} of ${completing.filter((t) => t !== 'not found').length}`);
  }, 30 * 60_000);
});
