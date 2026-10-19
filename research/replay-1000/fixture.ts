// REPLAY-1000: builds the small offline fixture the tests run on: one quiet coin's migration and first minutes, read
// from the network into a fresh cache folder by an actual replay, plus the trimmed slot index and Coinbase history.
//   node research/replay-1000/fixture.ts <day> <mint-prefix> <minutes> <out-dir>
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Coin, loadIndex } from './coins.ts';
import { loadCandles, loadTrades } from './coinbase.ts';
import { DATA_DIR, writeZ } from './rpc.ts';
import { runReplay, type RunCoin } from './run.ts';

export const FIXTURE_COIN = 'fixture-coin.json';

const main = async () => {
  const [day, prefix, minutes, out] = process.argv.slice(2);
  const coins = (JSON.parse(readFileSync(join(DATA_DIR, `coins-${day}.json`), 'utf8')) as { coins: Coin[] }).coins;
  const c = coins.find((x) => x.mint.startsWith(prefix!))!;
  const coin: RunCoin = { mint: c.mint, pool: c.pool, migrationSig: c.migrationSig, migrationSlot: c.migrationSlot, migrationTime: c.migrationTime };
  const startMs = (c.migrationTime - 90) * 1000;
  const endMs = startMs + Number(minutes) * 60_000;
  const dir = join(tmpdir(), `replay-fixture-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  // The index trimmed to the run and a margin (anchors after every slot the run reads), and today's newest anchors.
  const index = loadIndex();
  const lo = startMs / 1000 - 4 * 3600;
  const hi = endMs / 1000 + 3600;
  writeFileSync(join(dir, 'create-index.json'), JSON.stringify(index.filter((x) => (x.blockTime ?? 0) >= lo && (x.blockTime ?? 0) <= hi)));
  writeZ(join(dir, 'coinbase-trades.json.zst'), loadTrades().filter((t) => t.t >= startMs - 3_600_000 && t.t <= endMs + 60_000));
  writeZ(join(dir, 'coinbase-candles-3600.json.zst'), loadCandles().filter((r) => r[0]! * 1000 >= startMs - 40 * 3_600_000 && r[0]! * 1000 <= endMs));
  const s = await runReplay({ out: join(dir, 'run'), coins: [coin], startMs, endMs, creates: [], mode: 'A', dataDir: dir, parityReplays: 1 });
  rmSync(join(dir, 'run'), { recursive: true, force: true });
  writeFileSync(join(dir, FIXTURE_COIN), JSON.stringify({ coin, startMs, endMs }));
  rmSync(out!, { recursive: true, force: true });
  cpSync(dir, out!, { recursive: true });
  console.error(`fixture: ${out}, refusals ${JSON.stringify(s.refusals)}, net ${JSON.stringify(s.net)}`);
  process.exit(0);
};

if (process.argv[1] === new URL(import.meta.url).pathname) await main();
