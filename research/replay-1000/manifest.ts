// REPLAY-1000: the manifest of the cached data (data/ is git-ignored). Every top-level input file with its sha256, and
// for each replayed coin a digest of its tape: the sha256 over its sorted "signature sha256(file bytes)" lines, for
// every cached transaction of its pool and mint (the transaction files are zstd JSON, one per signature: listing all
// of them here would be over 200,000 lines; the per-coin digest pins each one all the same).
//   node research/replay-1000/manifest.ts <day> <coins.json> > research/replay-1000/MANIFEST.md
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadIndex } from './coins.ts';
import { DATA_DIR, PublicRpc, txFile } from './rpc.ts';
import { ChainView } from './world/chain.ts';
import type { RunCoin } from './run.ts';

const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

const main = async () => {
  const [day, coinsFile] = process.argv.slice(2);
  const coins = JSON.parse(readFileSync(coinsFile!, 'utf8')) as RunCoin[];
  const chain = new ChainView(new PublicRpc([], DATA_DIR), loadIndex());
  const out: string[] = ['# REPLAY-1000 data manifest', '', `Day ${day}. Files under \`research/replay-1000/data/\` (git-ignored); sha256 of each file's bytes.`, '', '| File | Bytes | sha256 |', '| --- | ---: | --- |'];
  for (const f of readdirSync(DATA_DIR).filter((x) => statSync(join(DATA_DIR, x)).isFile() && !x.endsWith('.tmp')).sort()) {
    const b = readFileSync(join(DATA_DIR, f));
    out.push(`| ${f} | ${b.length} | ${sha(b)} |`);
  }
  out.push('', 'Per coin: transactions of its pool (migration to +4 h) and of its mint (create to +4 h) cached, and the sha256 over the sorted lines `signature sha256(zstd file)`.', '', '| Mint | Transactions | Digest |', '| --- | ---: | --- |');
  for (const c of coins) {
    const end = chain.clock.slotAt((c.migrationTime + 4 * 3600) * 1000);
    const sigs = new Set<string>();
    for (const a of [c.pool, c.mint]) {
      try {
        for (const x of await chain.signaturesBetween(a, a === c.pool ? c.migrationSlot - 1 : 0, end)) if (x.err === null) sigs.add(x.signature);
      } catch {
        // A page not in the cache: the coin's digest covers what is cached.
      }
    }
    const lines = [...sigs].filter((s) => existsSync(txFile(DATA_DIR, s))).sort().map((s) => `${s} ${sha(readFileSync(txFile(DATA_DIR, s)))}`);
    out.push(`| ${c.mint} | ${lines.length} | ${sha(lines.join('\n'))} |`);
  }
  console.log(out.join('\n'));
};

if (process.argv[1] === new URL(import.meta.url).pathname) await main();
