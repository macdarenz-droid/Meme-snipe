import { readFileSync } from 'node:fs';
import { loadIndex } from '/home/user/Meme-snipe/research/replay-1000/coins.ts';
import { PublicRpc } from '/home/user/Meme-snipe/research/replay-1000/rpc.ts';
import { ChainView } from '/home/user/Meme-snipe/research/replay-1000/world/chain.ts';
const [coinsF, journal] = process.argv.slice(2);
const coins = JSON.parse(readFileSync(coinsF!, 'utf8')) as { mint: string; migrationSlot: number; migrationTime: number }[];
// Per coin: did any evaluation run H9 and not fail it (H9 neither in the failed list nor "not evaluated")?
const ran = new Map<string, { passed: number; failed: number }>();
for (const s of readFileSync(journal!, 'utf8').split('\n')) {
  if (!s.includes('"hard reject')) continue;
  const l = JSON.parse(s) as { reasons: string[] };
  const why = l.reasons[3] ?? '';
  const m = /^hard reject ([^:]*):/.exec(why);
  if (m === null) continue;
  const failed = m[1]!.split(',');
  const notEval = (/not evaluated: ([A-Z0-9,]*)/.exec(why)?.[1] ?? '').split(',');
  const e = ran.get(l.reasons[2]!) ?? { passed: 0, failed: 0 };
  if (failed.includes('H9')) e.failed++;
  else if (!notEval.includes('H9')) e.passed++;
  ran.set(l.reasons[2]!, e);
}
const chain = new ChainView(new PublicRpc(), loadIndex());
for (const c of coins) {
  const sigs = (await chain.signaturesBetween(c.mint, 0, c.migrationSlot)).filter((x) => x.err === null && x.blockTime !== null);
  const first = sigs.reduce<(typeof sigs)[number] | null>((a, x) => (a === null || x.slot < a.slot ? x : a), null);
  const dt = first === null ? null : c.migrationTime - first.blockTime!;
  const r = ran.get(c.mint) ?? { passed: 0, failed: 0 };
  const flag = r.passed > 0 && dt !== null && dt < 300 ? 'FAIL-OPEN?' : r.failed > 0 && dt !== null && dt >= 300 ? 'FALSE-REFUSAL?' : '';
  console.log(c.mint.slice(0, 8), 'grad', dt === null ? '?' : `${dt}s`, 'H9 passed', r.passed, 'failed', r.failed, flag);
}
