import { readFileSync, readdirSync } from 'node:fs';
import { zstdDecompressSync, zstdCompressSync } from 'node:zlib';
import { join } from 'node:path';
import { decodeTransaction, accountKeys, fromBase64, PUMP_PROGRAM, PUMP_AMM_PROGRAM } from '/home/user/Meme-snipe/packages/core/src/chain/index.ts';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', T22 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PCnBqCXEpPxuEb';
const dir = process.argv[2];
let recs = 0, moves = 0, swapMoves = 0, tradeRows = 0, mintOnly = 0;
const rows: string[] = [];
for (const u of readdirSync(dir)) {
  const ud = join(dir, u);
  for (const l of zstdDecompressSync(readFileSync(join(ud, 'raw.jsonl.zst'))).toString().split('\n').filter(Boolean)) {
    const r = JSON.parse(l); recs++;
    if (r.err) continue;
    const tx = decodeTransaction(fromBase64(r.transaction));
    const keys = accountKeys(tx, r.meta.loadedAddresses);
    // token account -> [mint, owner] from pre/post token balances
    const acct = new Map<number, [string, string]>();
    for (const b of [...(r.meta.preTokenBalances || []), ...(r.meta.postTokenBalances || [])]) acct.set(b.accountIndex, [b.mint, b.owner || '']);
    const sampled = new Set(r.mints);
    const groups = new Map<number, any[]>((r.meta.innerInstructions || []).map((g: any) => [g.index, g.instructions]));
    tx.instructions.forEach((top: any, oi: number) => {
      const seq = [{ programIdIndex: top.programIdIndex, accounts: top.accounts, data: top.data, stackHeight: 1 }, ...(groups.get(oi) || []).map((x: any) => ({ ...x, data: fromBase64(x.data) }))];
      const stack: string[] = [];
      seq.forEach((ix: any, k: number) => {
        const h = ix.stackHeight ?? 1; stack.length = h - 1; const prog = keys[ix.programIdIndex]; stack.push(prog);
        if (prog !== TOKEN && prog !== T22) return;
        const d = ix.data instanceof Uint8Array ? ix.data : fromBase64(ix.data); const op = d[0];
        let src = -1, dst = -1, amount = 0n;
        const rd = (o: number) => { let x = 0n; for (let i = 7; i >= 0; i--) x = (x << 8n) | BigInt(d[o + i]); return x; };
        if (op === 3) { src = ix.accounts[0]; dst = ix.accounts[1]; amount = rd(1); }       // Transfer
        else if (op === 12) { src = ix.accounts[0]; dst = ix.accounts[2]; amount = rd(1); } // TransferChecked
        else if (op === 8 || op === 15) { src = ix.accounts[0]; amount = rd(1); }          // Burn, BurnChecked
        else return;
        const m = acct.get(src)?.[0] ?? acct.get(dst)?.[0];
        if (!m || !sampled.has(m)) return;
        const inSwap = stack.slice(0, -1).some((p) => p === PUMP_PROGRAM || p === PUMP_AMM_PROGRAM);
        if (inSwap) { swapMoves++; return; }
        moves++;
        rows.push([r.slot, r.txIndex, `${oi}.${k}`, m, acct.get(src)?.[1] ?? '', dst >= 0 ? acct.get(dst)?.[1] ?? '' : '', amount].join(','));
      });
    });
  }
  for (const f of ['curve_trades.csv.zst', 'amm_trades.csv.zst']) tradeRows += zstdDecompressSync(readFileSync(join(ud, f))).toString().split('\n').length - 2;
}
const csv = Buffer.from(rows.join('\n') + '\n'), z = zstdCompressSync(csv);
console.log(JSON.stringify({ recs, moves_outside_swaps: moves, moves_inside_swaps: swapMoves, sampled_trade_rows: tradeRows, csv_bytes: csv.length, zst_bytes: z.length, bytes_per_row: (z.length / Math.max(1, moves)).toFixed(1) }));
