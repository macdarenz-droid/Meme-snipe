import { ParityChecker, readMints, curveRow, ammRow, eventRow, csvObjects } from '/home/user/Meme-snipe/research/historical/qa/parity.ts';
import { readFileSync } from 'node:fs'; import { zstdDecompressSync } from 'node:zlib';
const d = process.argv[2]!; const day = d + '/days/2026-10-02/';
const t = (f: string) => zstdDecompressSync(readFileSync(day + f)).toString();
const raw = new Set(t('raw-000.jsonl.zst').trim().split('\n').map((l) => { const r = JSON.parse(l); return r.slot + ':' + r.txIndex; }));
const rows = [...csvObjects(t('curve_trades-000.csv.zst')).map(curveRow), ...csvObjects(t('amm_trades-000.csv.zst')).map(ammRow), ...t('events-000.jsonl.zst').trim().split('\n').map((l) => eventRow(JSON.parse(l)))];
const c: Record<string, number> = {};
for (const r of rows) if (!raw.has(r.slot + ':' + r.txIdx)) { const k = r.kind + ':' + r.event; c[k] = (c[k] ?? 0) + 1; }
console.log(c);
