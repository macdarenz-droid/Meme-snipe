// REPLAY-1000: the inputs of one replay run, from the day's coin lists, the collected tapes and the create index.
//   node research/replay-1000/prep.ts <day> <out-dir> <runStartIso> <runEndIso> [sample|all]
// Writes coins.json (coins replayed in full: their tape was collected without truncation), others.json (every other
// coin of the run's span: migration and survival read only) and creates.json (the creates stream: every create by the
// full coins' creators inside the run, from the create index).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { recordFromRpc, transactionEvents, type RpcTransactionBase64 } from '../../packages/core/src/chain/index.ts';
import { type Coin, inSample, loadIndex } from './coins.ts';
import { DATA_DIR, PublicRpc, type RawSig } from './rpc.ts';
import type { CoinTapes } from './collect.ts';
import { ChainView } from './world/chain.ts';

const pick = (c: Coin) => ({ mint: c.mint, pool: c.pool, migrationSig: c.migrationSig, migrationSlot: c.migrationSlot, migrationTime: c.migrationTime });

const main = async () => {
  const [day, out, startIso, endIso, which] = process.argv.slice(2);
  const start = Date.parse(startIso!) / 1000;
  const end = Date.parse(endIso!) / 1000;
  mkdirSync(out!, { recursive: true });
  const rpc = new PublicRpc();
  const index = loadIndex();
  const chain = new ChainView(rpc, index);
  // The previous day's evening tail and the next day's early coins are others (the regime's graduates series is fed by
  // every coin live, and a run reaches past midnight while the day's last windows run out).
  const lists = [`coins-${day}.json`, ...[`coins-${prevDay(day!)}-from-18.json`, `coins-${nextDay(day!)}.json`].filter((f) => existsSync(join(DATA_DIR, f)))];
  const all = [...new Map(lists.flatMap((f) => (JSON.parse(readFileSync(join(DATA_DIR, f), 'utf8')) as { coins: Coin[] }).coins).map((c) => [c.mint, c] as const)).values()];
  const tapes = JSON.parse(readFileSync(join(DATA_DIR, `tapes-${day}.json`), 'utf8')) as Record<string, CoinTapes>;
  const inRun = all.filter((c) => c.migrationTime >= start && c.migrationTime < end);
  // The day's coins only can be full coins (the tapes are the day's); the previous day's tail is always "others".
  const full = inRun.filter((c) => tapes[c.mint] !== undefined && !tapes[c.mint]!.truncated && (which !== 'sample' || inSample(c)));
  const fullSet = new Set(full.map((c) => c.mint));
  const others = inRun.filter((c) => !fullSet.has(c.mint));
  const createSigs = new Set(index.map((x) => x.signature));
  const startSlot = chain.clock.slotAt(start * 1000);
  const endSlot = chain.clock.slotAt(end * 1000);
  const creates = new Map<string, RawSig>();
  const byCreator: Record<string, string[]> = {};
  for (const c of full) {
    const sig = tapes[c.mint]!.createSig;
    if (sig === null) continue;
    const tx = await rpc.tx(sig);
    if (tx === null) continue;
    const ev = transactionEvents(recordFromRpc(sig, tx as RpcTransactionBase64)).find((e) => e.name === 'CreateEvent');
    const creator = (ev?.data as { creator?: string } | undefined)?.creator;
    if (creator === undefined) continue;
    const theirs = (await chain.signaturesBetween(creator, startSlot, endSlot)).filter((x) => x.err === null && createSigs.has(x.signature));
    byCreator[creator] = theirs.map((x) => x.signature);
    for (const x of theirs) creates.set(x.signature, index.find((i) => i.signature === x.signature)!);
  }
  // Every create from ALL_CREATES_FROM on (env, ISO; the earliest still on publicnode's ledger when collected): the live
  // creates watch receives every create, and a cut create log anywhere changes H14 for every coin (README "Streams").
  const allFrom = process.env['ALL_CREATES_FROM'];
  if (allFrom !== undefined) {
    const t = Date.parse(allFrom) / 1000;
    for (const x of index) if (x.err === null && (x.blockTime ?? 0) >= t && x.slot <= endSlot && rpc.hasTx(x.signature)) creates.set(x.signature, x);
  }
  writeFileSync(join(out!, 'coins.json'), JSON.stringify(full.map(pick)));
  writeFileSync(join(out!, 'others.json'), JSON.stringify(others.map(pick)));
  writeFileSync(join(out!, 'creates.json'), JSON.stringify([...creates.values()].sort((a, b) => a.slot - b.slot)));
  writeFileSync(join(out!, 'creators.json'), JSON.stringify(byCreator, null, 1));
  console.error(`prep: ${full.length} full coins, ${others.length} others, ${creates.size} creates by ${Object.keys(byCreator).length} creators`);
};

const prevDay = (day: string): string => new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
const nextDay = (day: string): string => new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

if (process.argv[1] === new URL(import.meta.url).pathname) await main();
