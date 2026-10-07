// RED TEAM B round 2, items 1-3: a kill between ANY two durable state-file writes during a full paper trade (entry,
// stop, exit), then a restart from that image and a drive to the end. Checked on every image:
//  - no position lost or left open without an exit (all closed at the end, nothing in flight);
//  - no fill booked twice: each landed paper attempt (the simulated chain, paper.json) is one book fill, and back;
//  - the paper wallet reconciles to the lamport with the chain: W0 + exits - entries - every landed attempt's fee
//    - entry rent + rent back on the closing sell (scenario with no dust and closes that always succeed).
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { FILL_CONFIG, TRIAL_POLICY } from '../../core/src/config/index.ts';
import { feeParts } from '../../core/src/fills/index.ts';
import { isTerminal } from '../../core/src/lifecycle/index.ts';
import { accountFile } from '../src/run/account.ts';
import { StateFile } from '../src/run/state.ts';
import { parseTyped } from '../src/run/json.ts';
import { LANDS, Market, makeWorker, passingMarket } from './worker-harness.ts';

type H = ReturnType<typeof makeWorker>;
// Every variant keeps the conservative repeated-exit haircut (5% a send inside its 10-minute window, fills-4: RB-11).
// The slow-retry variant raises it so the fast phase fails inside the window, and drives past the first slow retry.
const scen = (land: bigint, haircutPpm = LANDS.exitRetryHaircutPpm) => ({ ...LANDS, landPpm: { pumpswap: land, 'pump-curve': land }, dustPpm: 0n, closeSuccessPpm: 1_000_000n, exitRetryHaircutPpm: haircutPpm });
const NET = FILL_CONFIG.network;

const until = async (m: Market, done: () => boolean, maxMs: number, scale: bigint): Promise<boolean> => {
  const end = m.now + maxMs;
  while (!done() && m.now < end) await m.run(400, 400, () => { m.slot(); m.pool(scale); });
  return done();
};

interface Attempt { intentId: string; signature: string; purpose: 'entry' | 'exit'; priorityFee: bigint; outcome: string; fill: { sol: bigint; tokens: bigint } | null; trade: string }
const attemptsOf = (dir: string): Attempt[] => {
  const p = join(dir, 'paper.json');
  if (!existsSync(p)) return [];
  const v = parseTyped(readFileSync(p, 'utf8')) as { attempts: Record<string, Attempt> };
  return Object.values(v.attempts);
};

/** What the chain says the wallet must hold, from W0 (after the wallet's one-time setup). */
const chainWallet = (w0: bigint, as: readonly Attempt[], closedPositions: number): bigint => {
  let w = w0;
  let entries = 0;
  for (const a of as) {
    const f = feeParts(NET, a.priorityFee, a.outcome);
    w -= f.base + f.priority + f.tip;
    if (a.outcome === 'filled' && a.fill !== null) {
      if (a.purpose === 'entry') { w -= a.fill.sol; entries++; } else w += a.fill.sol;
    }
  }
  return w - BigInt(entries) * NET.tokenAccountRent + BigInt(closedPositions) * NET.tokenAccountRent;
};

/** An exit attempt filled after the position's ladder and bounded blocked retries were spent: a slow retry filled. */
const slowExitFilled = (dir: string): boolean => {
  const exits = attemptsOf(dir).filter((a) => a.purpose === 'exit');
  const bound = TRIAL_POLICY.exits.ladder.maxAttempts + TRIAL_POLICY.exits.blockedRetryAttempts;
  return exits.length > bound && exits.some((a) => a.outcome === 'filled');
};

const check = (label: string, h: H, dir: string, w0: bigint): string[] => {
  const bad: string[] = [];
  const book = h.worker.book;
  const positions = Object.values(book.positions);
  const open = positions.filter((p) => p.status !== 'closed');
  if (open.length > 0) bad.push(`${label}: ${open.length} position(s) not closed: ${open.map((p) => `${p.id} ${p.status} q=${p.quantity}`).join('; ')}`);
  const live = Object.values(book.intents).filter((i) => !isTerminal(i) && i.status !== 'reconciled');
  if (live.length > 0) {
    bad.push(`${label}: intents still live: ${live.map((i) => `${i.intent.id} ${i.status}`).join('; ')}`);
    if (process.env.RB_DEBUG) {
      const pa = attemptsOf(dir);
      for (const i of live) console.log('DBG', label, JSON.stringify({ status: i.status, attempts: i.attempts.map((x) => ({ sig: String(x.signature).slice(0, 12), lvbh: String(x.lastValidBlockHeight) })), feedSlot: String(h.worker.feed.releasedThrough), paper: pa.filter((x) => x.intentId === i.intent.id).map((x) => ({ sig: x.signature.slice(0, 12), outcome: x.outcome, reason: (x as never as { reason: string }).reason, landSlot: String((x as never as { landSlot: bigint }).landSlot), simulated: (x as never as { simulated: boolean }).simulated })) }));
    }
  }
  const as = attemptsOf(dir);
  const chainFills = as.filter((a) => a.outcome === 'filled').map((a) => a.signature).sort();
  const bookFills = Object.values(book.intents).flatMap((i) => i.fills.map((f) => String(f.signature))).sort();
  if (JSON.stringify(chainFills) !== JSON.stringify(bookFills)) bad.push(`${label}: chain fills ${JSON.stringify(chainFills)} != book fills ${JSON.stringify(bookFills)}`);
  const a = accountFile(dir).read(null as never);
  const closed = positions.filter((p) => p.status === 'closed' && p.bought > 0n).length;
  const want = chainWallet(w0, as, closed);
  if (a.walletLamports !== want) bad.push(`${label}: wallet ${a.walletLamports} != chain ${want} (diff ${(a.walletLamports ?? 0n) - want})`);
  const trades = a.trades.length;
  const entered = positions.filter((p) => p.bought > 0n).length;
  if (trades !== entered) bad.push(`${label}: ${trades} trade records for ${entered} entered positions`);
  if (a.trades.some((t) => t.closedAtMs === null)) bad.push(`${label}: a trade record still open`);
  return bad;
};

const VARIANTS: { name: string; land: bigint; path: bigint[]; haircutPpm?: bigint; images?: number; untilBlocked?: boolean; driveMs?: number; slow?: boolean }[] = [
  { name: 'all land, stop', land: 1_000_000n, path: [700_000n] },
  { name: 'half land, stop (failures, replacements, rungs)', land: 500_000n, path: [700_000n] },
  { name: '70% land, up then stop (partial take-profit)', land: 700_000n, path: [1_400_000n, 1_400_000n, 700_000n] },
  { name: 'RB-8 30% land, up then stop (ladder pressure)', land: 300_000n, path: [1_400_000n, 1_400_000n, 700_000n] },
  // 15% per send inside the window: a third send there is below the last rung's 25% min-out, so an exit whose first two
  // sends miss ends its ladder and bounded retries blocked; the slow retry, sent an hour later, starts from no haircut.
  { name: 'haircut on (15% a send), 60% land: slow retries fill', land: 600_000n, path: [1_400_000n, 1_400_000n, 700_000n], haircutPpm: 150_000n, images: 400, untilBlocked: true, driveMs: 12 * 3_600_000, slow: true },
];
describe('RB-7 crash at any state-file write during a trade, then restart', () => {
  it.each(VARIANTS)('$name: every image restarts to a closed, reconciled, non-duplicated trade', async ({ land, path, haircutPpm, images: sample, untilBlocked, driveMs, slow }) => {
    const SCEN = scen(land, haircutPpm);
    const images: { dir: string; label: string }[] = [];
    // Every snapshot is deleted when the test ends, pass or fail (thousands of folders otherwise fill the disk).
    onTestFinished(() => { if (!process.env.RB_DEBUG) for (const img of images) rmSync(img.dir, { recursive: true, force: true }); });
    let armed = false;
    let h: H | null = null;
    let n = 0;
    const orig = StateFile.prototype.write;
    StateFile.prototype.write = function (this: StateFile<unknown>, v: unknown) {
      orig.call(this, v);
      if (!armed || h === null) return;
      // A 12-hour drive writes thousands of times and every copy holds its recording: this variant images the trade up
      // to its first blocked exit (each image is then driven through the slow retries), so the copies fit on the disk.
      if (untilBlocked === true && Object.values(h.worker.book.positions).some((p) => p.status === 'exit_blocked')) armed = false;
      if (!armed) return;
      n++;
      const dir = mkdtempSync(join(tmpdir(), 'rb-crash-'));
      cpSync(h.stateDir, dir, { recursive: true });
      images.push({ dir, label: `#${n} after ${this.path.split('/').at(-1)}` });
    };
    let w0 = 0n;
    let baseSlowFilled = false;
    try {
      h = makeWorker({ scenario: SCEN });
      expect(await h.worker.reconcile()).toEqual({ ok: true });
      const m = await passingMarket(h, { heldPoolFacts: true });
      w0 = accountFile(h.stateDir).read(null as never).walletLamports!;
      expect(accountFile(h.stateDir).read(null as never).trades).toHaveLength(0);
      armed = true;
      const opened = () => Object.values(h!.worker.book.positions).some((p) => p.status === 'open');
      expect(await until(m, opened, 30_000, 1_000_000n)).toBe(true);
      const done = () => { const ps = Object.values(h!.worker.book.positions); return ps.length > 0 && ps.every((p) => p.status === 'closed'); };
      for (const [i, sc] of path.entries()) await until(m, i === path.length - 1 ? done : () => false, i === path.length - 1 ? Math.max(120_000, driveMs ?? 0) : 20_000, sc);
      expect(done()).toBe(true);
      armed = false;
      await m.run(4_000, 400, () => { m.slot(); m.pool(700_000n); });
      const base = check('base run', h, h.stateDir, w0);
      baseSlowFilled = slowExitFilled(h.stateDir);
      expect(base).toEqual([]);
      await h.worker.stop();
    } finally {
      StateFile.prototype.write = orig;
    }
    // Every image (bounded): restart, drive to the end, check.
    const step = Math.max(1, Math.floor(images.length / (sample ?? 200)));
    let slowFilled = 0;
    const problems: string[] = [];
    let tried = 0;
    for (let k = 0; k < images.length; k += step) {
      const img = images[k]!;
      tried++;
      if (process.env.RB_DEBUG) cpSync(img.dir, `${img.dir}-orig`, { recursive: true });
      rmSync(join(img.dir, 'cold_start'), { force: true });
      const h2 = makeWorker({ stateDir: img.dir, timers: h!.timers, scenario: SCEN });
      const s = await h2.worker.start();
      if (!s.ok && process.env.RB_DEBUG) {
        const jl = readFileSync(join(img.dir, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
        const refused = jl.filter((l) => l['action'] === 'world_refused').map((l) => (l['reasons'] as string[])[0]);
        console.log('REFUSED', img.label, JSON.stringify([...new Set(refused)]).slice(0, 600));
        const pa = attemptsOf(img.dir).filter((a) => a.purpose === 'exit').map((a) => `${a.signature.slice(0, 6)}:${a.outcome}:${(a as never as { reason: string }).reason}`);
        const bi = Object.values(h2.worker.book.intents).filter((i) => !isTerminal(i)).map((i) => ({ st: i.status, failed: i.failedSignatures.map((x) => String(x).slice(0, 6)), att: i.attempts.map((a) => `${String(a.signature).slice(0, 6)}@${a.lastValidBlockHeight}`) }));
        console.log('STATE', img.label, JSON.stringify({ pa, bi }));
      }
      if (!s.ok) { problems.push(`${img.label}: start refused ${JSON.stringify(s)} open: ${Object.values(h2.worker.book.intents).filter((i) => !isTerminal(i)).map((i) => `${i.intent.id} ${i.status} attempts=${i.attempts.length} fills=${i.fills.length}`).join('; ')} positions: ${Object.values(h2.worker.book.positions).map((p) => `${p.status} q=${p.quantity}`).join('; ')}`); await h2.worker.stop(); if (!process.env.RB_DEBUG) rmSync(img.dir, { recursive: true, force: true }); continue; }
      const m2 = new Market(h2, { heldPoolFacts: true });
      const done = () => Object.values(h2.worker.book.positions).every((p) => p.status === 'closed')
        && Object.values(h2.worker.book.intents).every((i) => isTerminal(i) || i.status === 'reconciled');
      await until(m2, done, driveMs ?? 900_000, 700_000n);
      if (slowExitFilled(img.dir)) slowFilled++;
      await m2.run(4_000, 400, () => { m2.slot(); m2.pool(700_000n); });
      const found = check(img.label, h2, img.dir, w0);
      if (found.length > 0 && process.env.RB_DEBUG) console.log('LOGS', img.label, '\n' + h2.logs.slice(-40).join('\n'));
      problems.push(...found);
      await h2.worker.stop();
      if (!process.env.RB_DEBUG) rmSync(img.dir, { recursive: true, force: true });
    }
    console.log(`RB-7 land ${land}: ${images.length} images, ${tried} restarted, ${problems.length} problems`);
    expect(problems).toEqual([]);
    // The haircut variant must show the point: some image's exit filled on a slow retry (past ladder + blocked retries).
    console.log(`slow-retry fills: base ${baseSlowFilled}, images ${slowFilled}`);
    if (slow === true) expect(baseSlowFilled || slowFilled > 0).toBe(true);
  }, 1_800_000);
});
