import { readFileSync, readdirSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
import { accountKeys, decodeTransaction, PUMP_PROGRAM, PUMP_AMM_PROGRAM, logEvents } from '/home/user/Meme-snipe/packages/core/src/chain/index.ts';
import { recordFromRaw } from '/home/user/Meme-snipe/packages/backtest/src/dataset/parity.ts';
const dir = process.argv[2] + '/days/';
for (const day of readdirSync(dir)) {
  const t = (f: string) => zstdDecompressSync(readFileSync(dir + day + '/' + f)).toString();
  const raws = t('raw-000.jsonl.zst').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const evs = t('events-000.jsonl.zst') + t('curve_trades-000.csv.zst') + t('amm_trades-000.csv.zst');
  for (const r of raws.filter((r: any) => r.err === null && r.meta.innerInstructions === null)) {
    const rec = recordFromRaw(r); const tx = decodeTransaction(rec.transaction); const keys = accountKeys(tx, rec.loadedAddresses);
    const top = tx.instructions.map((ix) => keys[ix.programIdIndex]?.slice(0, 6));
    const le = r.meta.logMessages ? logEvents(r.meta.logMessages, null) : null;
    console.log(r.slot, r.txIndex, 'pumpKey', keys.includes(PUMP_PROGRAM), 'ammKey', keys.includes(PUMP_AMM_PROGRAM), 'top', top.join(','), 'logs', r.meta.logMessages?.length ?? null, 'logEvents', le ? le.events.map((e) => e.program + ':' + e.name).join(',') : '-', 'rows', evs.includes(r.signature), 'mints', r.mints);
  }
}
