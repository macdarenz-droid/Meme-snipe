// Builds the insider funding supplement for BT-2 (src/facts/supplement.ts). Opt-in: it spends Helius credits.
//   ZEROED_FUNDING_BACKFILL=1 CREDENTIALS_DIRECTORY=<dir with HELIUS_API_KEY> \
//     node packages/worker/scripts/funding-backfill.ts <inputs.jsonl> <out-dir> [funder pages, default 3]
// inputs.jsonl: one {"mint","creator","firstBuyers":[...],"asOfSlot":"<decimal>"} per line (BT-2 derives it from
// DATA-1: the create, the first buyers by the slot rule, the decision slot). Prints counts only, never a key.
import { readFileSync } from 'node:fs';
import { credentialsDirectorySecrets, fetchHttp, heliusRpcUrl } from '../src/providers/index.ts';
import { HELIUS_FREE, P3, Scheduler, systemTimers } from '../src/scheduler/index.ts';
import { FactReaders, FactRpc, supplementRow, writeSupplement, type SupplementRow } from '../src/facts/index.ts';

if (process.env.ZEROED_FUNDING_BACKFILL !== '1') {
  console.error('funding backfill is opt-in: set ZEROED_FUNDING_BACKFILL=1 (it uses real provider credits)');
  process.exit(2);
}
const dir = process.env.CREDENTIALS_DIRECTORY;
const [inputs, out, pages] = process.argv.slice(2);
if (!dir || !inputs || !out) {
  console.error('usage: funding-backfill.ts <inputs.jsonl> <out-dir> [funder pages]; CREDENTIALS_DIRECTORY must be set');
  process.exit(2);
}
const secrets = credentialsDirectorySecrets(dir);
const timers = systemTimers();
const rpc = new FactRpc({ url: () => heliusRpcUrl(secrets), http: fetchHttp, scheduler: new Scheduler(HELIUS_FREE, { timers }), timeoutMs: 15_000 });
const readers = new FactReaders({ feed: { ingest: () => undefined }, rpc, http: fetchHttp, timers, timeoutMs: 15_000 });
const maxPages = Number(pages ?? 3);
const rows: SupplementRow[] = [];
for (const line of readFileSync(inputs, 'utf8').split('\n').filter((l) => l.trim() !== '')) {
  const i = JSON.parse(line) as { mint: string; creator: string; firstBuyers: string[]; asOfSlot: string };
  rows.push(await supplementRow({ ...i, asOfSlot: BigInt(i.asOfSlot) }, (w, at) => readers.funderOf(w, maxPages, at, P3)));
}
const m = writeSupplement(out, rows);
console.log(`wrote ${m.rows} rows (${rows.filter((r) => r.devCluster !== null).length} complete), sha256 ${m.sha256}`);
