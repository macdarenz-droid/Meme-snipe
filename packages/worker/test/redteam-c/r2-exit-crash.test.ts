// RED TEAM C round 2, task 1: a kill at every durable write of an exit. From the moment the price falls through the
// stop until the position is closed, a crash image of the state dir is taken right after each durable write (journal
// line, ledger book event, any whole-file state write: exits.json, account.json, paper.json, ...), which is what a
// SIGKILL at that point leaves on disk. A new worker starts on each image and runs the falling market on. Asserted on
// each: the position closes exactly once (one closing exit line in the journal, sold never above bought, one account
// trade closed once), never lost, and the paper wallet in SOL equals its starting lamports plus what the ledger's legs
// say the trade made (no double sell, no double booking).
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Ledger } from '../../../core/src/ledger/index.ts';
import { tradeNet } from '../../../core/src/fills/index.ts';
import { type AccountState, accountFile, paperTradeLamports } from '../../src/run/account.ts';
import { Journal } from '../../src/run/journal.ts';
import { StateFile } from '../../src/run/state.ts';
import { blockNetwork } from '../helpers.ts';
import { Market, makeWorker, passingMarket, until, type Harness } from '../worker-harness.ts';

blockNetwork();

const HELD = { heldPoolFacts: true } as const;
const tick = (m: Market, scalePpm = 1_000_000n) => (): void => {
  m.slot();
  m.pool(scalePpm);
};
const lines = (dir: string) => readFileSync(join(dir, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
const account = (dir: string) => accountFile(dir).read(null as unknown as AccountState);

interface Image { readonly dir: string; readonly at: string }

describe('red team C r2: a kill at every durable write of an exit', () => {
  for (const recover of [false, true]) it(`each crash image restarts to the position closed exactly once, never lost, and the SOL wallet matches the ledger${recover ? ' (price back above the stop at restart, falls again later)' : ''}`, { timeout: 600_000 }, async () => {
    const images: Image[] = [];
    let armed = false;
    let pid = '';
    let h: Harness | null = null;
    const snap = (at: string): void => {
      if (!armed || h === null) return;
      const dir = mkdtempSync(join(tmpdir(), 'r2-exit-'));
      cpSync(h.stateDir, dir, { recursive: true });
      images.push({ dir, at });
    };
    const sfWrite = StateFile.prototype.write;
    const jWrite = Journal.prototype.write;
    const lWrite = Ledger.prototype.recordBookEvent;
    const s1 = vi.spyOn(StateFile.prototype, 'write').mockImplementation(function (this: StateFile<unknown>, v: unknown) {
      sfWrite.call(this, v);
      snap(`state ${this.path.split('/').pop()}`);
    });
    const s2 = vi.spyOn(Journal.prototype, 'write').mockImplementation(function (this: Journal, kind, fields) {
      jWrite.call(this, kind, fields);
      snap(`journal ${kind}${fields?.['reasons'] !== undefined ? ` ${JSON.stringify((fields['reasons'] as unknown[])[0])}` : ''}`);
    });
    const s3 = vi.spyOn(Ledger.prototype, 'recordBookEvent').mockImplementation(function (this: Ledger, ...a: Parameters<Ledger['recordBookEvent']>) {
      const r = lWrite.apply(this, a);
      snap(`ledger ${a[1].type}`);
      return r;
    });
    let walletStart = 0n;
    try {
      h = makeWorker();
      expect(await h.worker.reconcile()).toEqual({ ok: true });
      const m = await passingMarket(h, HELD);
      expect(await until(m, 30_000, () => Object.values(h!.worker.book.positions).some((p) => p.status === 'open'), tick(m))).toBe(true);
      pid = Object.values(h.worker.book.positions).find((p) => p.status === 'open')!.id;
      // The wallet before the trade: what it holds now plus what the entry cost (the trade's booked lamports so far).
      const a0 = account(h.stateDir);
      walletStart = BigInt(String(a0.walletLamports)) - BigInt(String(a0.trades.find((t) => t.positionId === pid)!.booked));
      armed = true;
      expect(await until(m, 60_000, () => h!.worker.book.positions[pid]!.status === 'closed', tick(m, 700_000n))).toBe(true);
      armed = false;
      await h.worker.stop();
    } finally {
      s1.mockRestore();
      s2.mockRestore();
      s3.mockRestore();
    }
    expect(images.length).toBeGreaterThan(3);

    const failures: string[] = [];
    for (const [n, img] of images.entries()) {
      rmSync(join(img.dir, 'cold_start'), { force: true });
      const h2 = makeWorker({ stateDir: img.dir, timers: h.timers });
      const tag = `#${n} after ${img.at}`;
      try {
        const r = await h2.worker.start();
        if (!('ok' in r) || r.ok !== true) { failures.push(`${tag}: start ${JSON.stringify(r)}`); continue; }
        const m2 = new Market(h2, HELD);
        if (recover) {
          await m2.run(20_000, 400, tick(m2, 1_050_000n));
          const q = h2.worker.book.positions[pid];
          if (q === undefined) { failures.push(`${tag}: position lost from the book after recovery`); continue; }
          if (q.status !== 'closed') {
            const plans = JSON.parse(readFileSync(join(img.dir, 'exits.json'), 'utf8')) as Record<string, unknown>;
            if (plans[pid] === undefined) failures.push(`${tag}: open (${q.status}) with no saved exit plan`);
          }
        }
        const closed = await until(m2, 200_000, () => h2.worker.book.positions[pid]?.status === 'closed', tick(m2, 700_000n));
        // A few more steps: any second sell or second booking would land here.
        await m2.run(4_000, 400, tick(m2, 700_000n));
        const p = h2.worker.book.positions[pid];
        if (p === undefined) { failures.push(`${tag}: position lost from the book`); continue; }
        if (!closed) failures.push(`${tag}: never closed (status ${p.status})`);
        if (p.sold > p.bought) failures.push(`${tag}: sold ${p.sold} > bought ${p.bought}`);
        const closing = lines(img.dir).filter((l) => l['kind'] === 'exit' && l['trade'] === pid && l['position'] === 'closed');
        if (closing.length !== 1) failures.push(`${tag}: ${closing.length} closing exit lines`);
        const exitFills = Object.values(h2.worker.book.intents).filter((i) => i.intent.purpose === 'exit' && i.intent.positionId === pid).flatMap((i) => i.fills);
        const soldByFills = exitFills.reduce((s, f) => s + BigInt(String(f.tokens)), 0n);
        if (soldByFills > p.bought) failures.push(`${tag}: exit fills sold ${soldByFills} > bought ${p.bought}`);
        const a = account(img.dir);
        const trades = a.trades.filter((t) => t.positionId === pid);
        if (trades.length !== 1 || trades[0]!.closedAtMs === null) failures.push(`${tag}: account trades ${trades.length}, closed ${trades[0]?.closedAtMs ?? null}`);
        const legs = paperTradeLamports(h2.worker.book, pid, h2.worker.apiInputs().legs);
        const net = legs === null ? null : tradeNet(legs);
        const t = trades[0];
        if (t !== undefined && net !== null && BigInt(String(t.booked)) !== net) failures.push(`${tag}: account booked ${t.booked} != ledger net ${net}`);
        const stray = Object.values(a.strayFees ?? {}).reduce((s, x) => s + BigInt(String(x.lamports)), 0n) + BigInt(String(a.strayFolded?.lamports ?? 0n));
        if (net !== null && BigInt(String(a.walletLamports)) !== walletStart + net - stray) failures.push(`${tag}: wallet ${a.walletLamports} != start ${walletStart} + ledger net ${net} - stray ${stray}`);
      } catch (e) {
        failures.push(`${tag}: threw ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        await h2.worker.stop();
        rmSync(img.dir, { recursive: true, force: true });
      }
    }
    process.stderr.write(`r2-exit-crash: ${images.length} crash images; points: ${[...new Set(images.map((i) => i.at))].join(' | ')}`);
    expect(failures).toEqual([]);
  });
});
