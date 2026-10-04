// WORKER-ORDER (ARCHITECTURE §12.4): a fill is journaled before the ledger lets the position go. A crash image of the
// state dir is taken right after the first of an exit fill's two durable writes (the journal line, the ledger commit),
// which is exactly what a SIGKILL between them leaves on disk; a new worker then starts on that image. The runner's
// own restart check (`closedSince`, `recoveredState`) judges it: the position is either still recovered or excused by
// its `exit` line, never silently gone. The other way round (line written, ledger not), the restart books the fill
// again from the paper world and the line is not written twice.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Health, JournalLine } from '../../runner/src/contract.ts';
import type { Kept } from '../../runner/src/report.ts';
import { closedSince, recoveredState, withoutTrades } from '../../runner/src/runner.ts';
import { type Lamports, type MicroUsd, lamportsToMicroUsd } from '../../core/src/units/index.ts';
import { type AccountState, accountFile, paperTradeLamports } from '../src/run/account.ts';
import { FILL_RATE_UNKNOWN, fillKey, journaledFillKeys } from '../src/run/desk.ts';
import { FILL_CONFIG } from '../../core/src/config/index.ts';
import { attemptFee, tradeNet, tradeUsd } from '../../core/src/fills/index.ts';
import type { PaperAttempt } from '../src/run/paper-world.ts';
import { LANDS, Market, SOL_PRICE, makeWorker, passingMarket } from './worker-harness.ts';

type H = ReturnType<typeof makeWorker>;
const lines = (dir: string): JournalLine[] => readFileSync(join(dir, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as JournalLine);
const kept = (h: Health): Kept => ({ pending_exits: [...h.pending_exits], positions: h.open_positions.map((p) => ({ trade: p.trade, universe: p.universe })) });

const tick = (m: Market, scalePpm = 1_000_000n) => (): void => {
  m.slot();
  m.pool(scalePpm);
};

const until = async (m: Market, done: () => boolean, maxMs: number, each: () => void): Promise<boolean> => {
  const end = m.now + maxMs;
  while (!done() && m.now < end) await m.run(400, 400, each);
  return done();
};

interface Image {
  readonly dir: string;
  readonly point: string;
  readonly intent: string;
  /** The last health reply before the kill, as the runner holds it. */
  readonly reply: Health;
}

/**
 * Enters, lets the price fall 30% so the stop exits in full, and takes a crash image at the first durable write of the
 * exit fill (or right after its ledger commit, `at`). Returns the image and the first worker (still running).
 */
const crashBetweenExitWrites = async (at?: 'fill-committed', scenario?: typeof LANDS): Promise<{ h: H; image: Image }> => {
  let image: Image | null = null;
  let reply: Health | null = null;
  let h: H | null = null;
  const exits = new Set<string>();
  h = makeWorker({
    ...(scenario === undefined ? {} : { scenario }),
    crashPoint: (point, intent) => {
      if (image !== null || !exits.has(intent) || (at !== undefined && point !== at)) return;
      const dir = mkdtempSync(join(tmpdir(), 'zeroed-crash-'));
      cpSync(h!.stateDir, dir, { recursive: true });
      image = { dir, point, intent, reply: reply! };
    },
  });
  expect(await h.worker.reconcile()).toEqual({ ok: true });
  const m = await passingMarket(h, { heldPoolFacts: true });
  const open = () => Object.values(h!.worker.book.positions).find((p) => p.status === 'open');
  expect(await until(m, () => open() !== undefined, 30_000, tick(m))).toBe(true);
  const each = (scale: bigint) => (): void => {
    tick(m, scale)();
    // The runner's view: the reply it sampled last before the kill.
    reply = h!.worker.health();
    for (const i of Object.values(h!.worker.book.intents)) if (i.intent.purpose === 'exit') exits.add(i.intent.id);
  };
  expect(await until(m, () => image !== null, 30_000, each(700_000n))).toBe(true);
  return { h, image: image! };
};

/**
 * A new worker on the crash image. The first boot traded without a full start (the harness's reconcile only); a real
 * first boot's start would have journaled `recovered` and removed the cold-start marker.
 */
const restart = (h: H, image: Image, scenario?: typeof LANDS): H => {
  rmSync(join(image.dir, 'cold_start'), { force: true });
  return makeWorker({ stateDir: image.dir, timers: h.timers, ...(scenario === undefined ? {} : { scenario }) });
};

/** Enters and takes a crash image of the state dir at `point` of the entry fill's two writes. */
const crashAtEntry = async (point: 'fill-journaled' | 'fill-committed'): Promise<{ h: H; image: { dir: string; intent: string } }> => {
  let image: { dir: string; intent: string } | null = null;
  let h: H | null = null;
  h = makeWorker({
    crashPoint: (p, intent) => {
      if (image !== null || p !== point) return;
      if (h!.worker.book.intents[intent as never]?.intent.purpose !== 'entry') return;
      const dir = mkdtempSync(join(tmpdir(), 'zeroed-crash-'));
      cpSync(h!.stateDir, dir, { recursive: true });
      image = { dir, intent };
    },
  });
  expect(await h.worker.reconcile()).toEqual({ ok: true });
  const m = await passingMarket(h, { heldPoolFacts: true });
  expect(await until(m, () => image !== null, 30_000, tick(m))).toBe(true);
  await h.worker.stop();
  return { h, image: image! };
};

describe('an exit fill is journaled before the ledger lets the position go (§12.4)', () => {
  it('a kill between the two writes: the runner finds the position kept or its exit line, never a silent loss', async () => {
    const { h, image } = await crashBetweenExitWrites();
    await h.worker.stop();
    // The order itself: the journal line is the first durable write.
    expect(image.point).toBe('fill-journaled');
    const pid = image.reply.open_positions[0]!.trade;
    expect(image.reply.pending_exits).toContain(pid);

    const h2 = restart(h, image);
    expect(await h2.worker.start()).toEqual({ ok: true });
    const all = lines(image.dir);
    const atKill = kept(image.reply);
    const closed = closedSince(all, h.worker.boot, image.reply.journal_seq);
    const state = recoveredState(all, h2.worker.boot, 'crash', withoutTrades(atKill, closed), atKill);
    expect(state.notes, JSON.stringify(state)).toEqual([]);
    expect(state.state_ok).toBe(true);
    expect(closed).toEqual([pid]);
    await h2.worker.stop();
  });

  it('the reverse (line written, ledger not): the restart books the fill once, closes the trade, and writes no second line', async () => {
    const { h, image } = await crashBetweenExitWrites();
    await h.worker.stop();
    const pid = image.reply.open_positions[0]!.trade;
    const exitLines = () => lines(image.dir).filter((l) => l.kind === 'exit' && l['intent'] === image.intent);
    expect(exitLines()).toHaveLength(1);

    const h2 = restart(h, image);
    expect(await h2.worker.start()).toEqual({ ok: true });
    const m2 = new Market(h2, { heldPoolFacts: true });
    expect(await until(m2, () => h2.worker.book.positions[pid]?.status === 'closed', 30_000, tick(m2, 700_000n))).toBe(true);
    // Booked from the world's record of the landing: the same fill, once, under the same intent.
    const fills = h2.worker.book.intents[image.intent as never]!.fills;
    expect(fills).toHaveLength(1);
    expect(String(fills[0]!.tokens)).toBe(exitLines()[0]!['tokens']);
    expect(exitLines()).toHaveLength(1);
    // The account closed the trade in the new boot (its record follows the ledger).
    const a = accountFile(image.dir).read(null as unknown as AccountState);
    expect(a.trades.find((t) => t.positionId === pid)?.closedAtMs).not.toBeNull();
    await h2.worker.stop();
  });

  it('a kill after the ledger commit, before account.json: the restart records the close from the ledger and the exit line', async () => {
    const { h, image } = await crashBetweenExitWrites('fill-committed');
    await h.worker.stop();
    const pid = image.reply.open_positions[0]!.trade;
    const before = accountFile(image.dir).read(null as unknown as AccountState).trades.find((t) => t.positionId === pid)!;
    expect(before.closedAtMs).toBeNull();
    const line = lines(image.dir).find((l) => l.kind === 'exit' && l['intent'] === image.intent)!;
    const h2 = restart(h, image);
    expect(await h2.worker.start()).toEqual({ ok: true });
    expect(h2.worker.book.positions[pid]?.status).toBe('closed');
    const m2 = new Market(h2, { heldPoolFacts: true });
    // The first SOL price values the close.
    expect(await until(m2, () => accountFile(image.dir).read(null as unknown as AccountState).trades.find((t) => t.positionId === pid)?.closedAtMs != null, 10_000, tick(m2))).toBe(true);
    const t = accountFile(image.dir).read(null as unknown as AccountState).trades.find((x) => x.positionId === pid)!;
    expect(t.closedAtMs).toBe(Date.parse(line.ts as string));
    expect(t.netLamports).not.toBeNull();
    expect(t.booked).toBe(t.netLamports);
    expect(t.exitReasons).toContain('stop');
    expect(lines(image.dir).filter((l) => l.kind === 'exit' && l['intent'] === image.intent)).toHaveLength(1);
    await h2.worker.stop();
  });

  it('the caught-up close is valued at the fill-time SOL price from its line, not the price after the restart (PAPER-1)', async () => {
    const { h, image } = await crashBetweenExitWrites('fill-committed');
    await h.worker.stop();
    const pid = image.reply.open_positions[0]!.trade;
    const line = lines(image.dir).find((l) => l.kind === 'exit' && l['intent'] === image.intent)!;
    expect(line['sol_usd']).toBe(String(SOL_PRICE));
    const h2 = restart(h, image);
    expect(await h2.worker.start()).toEqual({ ok: true });
    const m2 = new Market(h2, { heldPoolFacts: true });
    // SOL doubled while the worker was down.
    m2.solUsd = SOL_PRICE * 2n;
    const trade = () => accountFile(image.dir).read(null as unknown as AccountState).trades.find((x) => x.positionId === pid);
    expect(await until(m2, () => trade()?.closedAtMs != null, 10_000, tick(m2))).toBe(true);
    const t = trade()!;
    const net = BigInt(String(t.netLamports));
    const atFill = net >= 0n ? lamportsToMicroUsd(net as Lamports, SOL_PRICE as MicroUsd, 'floor') : -lamportsToMicroUsd((-net) as Lamports, SOL_PRICE as MicroUsd, 'ceil');
    expect(net).not.toBe(0n);
    expect(String(t.closeSolPrice)).toBe(String(SOL_PRICE));
    // Exactly the backtest's settlement of this trade's legs at the fill's rate (entry and close both at SOL_PRICE), each
    // flow rounded against us (AUDIT-RM1 F5), so at or below the SOL result at that rate; at the doubled rate it would be
    // far off.
    const legs = paperTradeLamports(h2.worker.book, pid, h2.worker.apiInputs().legs)!;
    expect(tradeNet(legs)).toBe(net);
    const exact = tradeUsd(legs, SOL_PRICE as MicroUsd, SOL_PRICE as MicroUsd).net;
    expect(String(t.netPnl)).toBe(String(exact));
    expect(exact <= atFill).toBe(true);
    await h2.worker.stop();
  });

  it('a kill after both entry writes, before account.json: the restart opens the trade from the ledger and the line, and books it once', async () => {
    const { h, image: img } = await crashAtEntry('fill-committed');
    const line = lines(img.dir).find((l) => l.kind === 'entry' && l['intent'] === img.intent)!;
    const pid = line['trade'] as string;
    const account = () => accountFile(img.dir).read(null as unknown as AccountState);
    expect(account().trades.find((t) => t.positionId === pid)).toBeUndefined();
    const walletBefore = BigInt(String(account().walletLamports));

    rmSync(join(img.dir, 'cold_start'), { force: true });
    const h2 = makeWorker({ stateDir: img.dir, timers: h.timers });
    expect(await h2.worker.start()).toEqual({ ok: true });
    expect(h2.worker.book.positions[pid]?.status).not.toBe('closed');
    const m2 = new Market(h2, { heldPoolFacts: true });
    m2.solUsd = SOL_PRICE * 2n;
    expect(await until(m2, () => account().trades.some((t) => t.positionId === pid), 10_000, tick(m2))).toBe(true);
    const t = account().trades.find((x) => x.positionId === pid)!;
    expect(t.openedAtMs).toBe(Date.parse(line.ts as string));
    expect(String(t.openSolPrice)).toBe(String(SOL_PRICE));
    const reason = (line['reasons'] as string[]).find((x) => /^notional \d+$/.test(x))!;
    expect(String(t.notional)).toBe(reason.slice('notional '.length));
    // The wallet paid the entry once: its SOL and fees from the ledger.
    const fills = h2.worker.book.intents[img.intent as never]!.fills;
    // PAPER-1: the entry's first trade also pays its token account's rent.
    const paid = fills.reduce((a, f) => a + f.sol + f.fees, 0n) + FILL_CONFIG.network.tokenAccountRent;
    expect(String(t.booked)).toBe(String(-paid));
    expect(BigInt(String(account().walletLamports))).toBe(walletBefore - paid);
    // Not booked twice: the world's report of the same landing finds the fill already held.
    await m2.run(4_000, 400, tick(m2));
    expect(h2.worker.book.intents[img.intent as never]!.fills).toHaveLength(1);
    expect(BigInt(String(account().walletLamports))).toBe(walletBefore - paid);
    expect(lines(img.dir).filter((l) => l.kind === 'entry' && l['intent'] === img.intent)).toHaveLength(1);
    await h2.worker.stop();
  });

  it('a kill between the entry line and the ledger commit: the restart books the entry once from the paper world, at the line\'s rate', async () => {
    const { h, image: img } = await crashAtEntry('fill-journaled');
    const line = lines(img.dir).find((l) => l.kind === 'entry' && l['intent'] === img.intent)!;
    expect(line['sol_usd']).toBe(String(SOL_PRICE));
    const pid = line['trade'] as string;
    const account = () => accountFile(img.dir).read(null as unknown as AccountState);
    expect(account().trades.find((t) => t.positionId === pid)).toBeUndefined();
    const walletBefore = BigInt(String(account().walletLamports));

    rmSync(join(img.dir, 'cold_start'), { force: true });
    const h2 = makeWorker({ stateDir: img.dir, timers: h.timers });
    expect(await h2.worker.start()).toEqual({ ok: true });
    const m2 = new Market(h2, { heldPoolFacts: true });
    m2.solUsd = SOL_PRICE * 2n;
    expect(await until(m2, () => account().trades.some((t) => t.positionId === pid), 30_000, tick(m2))).toBe(true);
    await m2.run(4_000, 400, tick(m2));
    const fills = h2.worker.book.intents[img.intent as never]!.fills;
    expect(fills).toHaveLength(1);
    expect(String(fills[0]!.tokens)).toBe(line['tokens']);
    const t = account().trades.find((x) => x.positionId === pid)!;
    expect(String(t.openSolPrice)).toBe(String(SOL_PRICE));
    expect(t.openedAtMs).toBe(Date.parse(line.ts as string));
    const reason = (line['reasons'] as string[]).find((x) => /^notional \d+$/.test(x))!;
    expect(String(t.notional)).toBe(reason.slice('notional '.length));
    // PAPER-1: the entry's first trade also pays its token account's rent.
    const paid = fills.reduce((a, f) => a + f.sol + f.fees, 0n) + FILL_CONFIG.network.tokenAccountRent;
    expect(BigInt(String(account().walletLamports))).toBe(walletBefore - paid);
    expect(lines(img.dir).filter((l) => l.kind === 'entry' && l['intent'] === img.intent)).toHaveLength(1);
    await h2.worker.stop();
  });

  it('the caught-up close settles as paper does: every attempt\'s fee and the rent outcome (legs), at its line\'s rate', async () => {
    // Every close fails: the first sell fails (its fee paid), the sell-only retry fills, and the rent stays locked.
    const scenario = { ...LANDS, closeSuccessPpm: 0n, dustPpm: 0n };
    const { h, image } = await crashBetweenExitWrites('fill-committed', scenario);
    await h.worker.stop();
    const pid = image.reply.open_positions[0]!.trade;
    const h2 = restart(h, image, scenario);
    expect(await h2.worker.start()).toEqual({ ok: true });
    const m2 = new Market(h2, { heldPoolFacts: true });
    m2.solUsd = SOL_PRICE * 2n;
    const trade = () => accountFile(image.dir).read(null as unknown as AccountState).trades.find((x) => x.positionId === pid);
    expect(await until(m2, () => trade()?.closedAtMs != null, 10_000, tick(m2))).toBe(true);
    const t = trade()!;
    // From paper.json: each fill's SOL and each attempt's fee, failed ones included; less the rent the failed close kept.
    const attempts = Object.values((JSON.parse(readFileSync(join(image.dir, 'paper.json'), 'utf8'), (_k, v) => (v !== null && typeof v === 'object' && '$n' in v ? BigInt(v.$n) : v)) as { attempts: Record<string, PaperAttempt> }).attempts)
      .filter((a) => a.trade === pid);
    expect(attempts.some((a) => a.purpose === 'exit' && a.outcome === 'failed' && a.reason === 'close failed')).toBe(true);
    let flows = -FILL_CONFIG.network.tokenAccountRent;
    for (const a of attempts) {
      if (a.outcome === 'filled') flows += a.purpose === 'entry' ? -a.fill!.sol : a.fill!.sol;
      flows -= attemptFee(FILL_CONFIG.network, a.priorityFee, a.outcome === 'filled' || a.outcome === 'failed' ? a.outcome : 'dropped');
    }
    expect(String(t.netLamports)).toBe(String(flows));
    // Both legs at the line's rate (the price before the restart), not the doubled one: within a few micro-dollars of
    // the SOL result at that rate (each flow is rounded on its own).
    expect(String(t.closeSolPrice)).toBe(String(SOL_PRICE));
    const atLine = flows >= 0n ? lamportsToMicroUsd(flows as Lamports, SOL_PRICE as MicroUsd, 'floor') : -lamportsToMicroUsd((-flows) as Lamports, SOL_PRICE as MicroUsd, 'ceil');
    const off = atLine - BigInt(String(t.netPnl));
    expect(off >= 0n && off <= 10n).toBe(true);
    // Exactly the backtest's settlement of these legs at the line's rate.
    expect(String(t.netPnl)).toBe(String(tradeUsd(paperTradeLamports(h2.worker.book, pid, h2.worker.apiInputs().legs)!, SOL_PRICE as MicroUsd, SOL_PRICE as MicroUsd).net));
    await h2.worker.stop();
  });

  it('a line with sol_usd null (no price at booking) is valued as the live path did; a line without the field falls back to the price now', async () => {
    const { h, image } = await crashBetweenExitWrites('fill-committed');
    await h.worker.stop();
    const pid = image.reply.open_positions[0]!.trade;
    const withLine = (edit: (l: Record<string, unknown>) => void): string => {
      const dir = mkdtempSync(join(tmpdir(), 'zeroed-crash-'));
      cpSync(image.dir, dir, { recursive: true });
      const text = readFileSync(join(dir, 'journal.jsonl'), 'utf8').split('\n').map((t) => {
        if (t === '') return t;
        const l = JSON.parse(t) as Record<string, unknown>;
        if (l['kind'] !== 'exit' || l['intent'] !== image.intent) return t;
        edit(l);
        return JSON.stringify(l);
      });
      writeFileSync(join(dir, 'journal.jsonl'), text.join('\n'));
      return dir;
    };
    const caughtUp = async (dir: string) => {
      const h2 = restart(h, { ...image, dir });
      expect(await h2.worker.start()).toEqual({ ok: true });
      const m2 = new Market(h2, { heldPoolFacts: true });
      m2.solUsd = SOL_PRICE * 2n;
      const trade = () => accountFile(dir).read(null as unknown as AccountState).trades.find((x) => x.positionId === pid);
      expect(await until(m2, () => trade()?.closedAtMs != null, 10_000, tick(m2))).toBe(true);
      await h2.worker.stop();
      return { t: trade()!, logs: h2.logs };
    };
    const nul = await caughtUp(withLine((l) => { l['sol_usd'] = null; }));
    expect(nul.t.closeSolPrice ?? null).toBeNull();
    expect(String(nul.t.netPnl)).toBe(String(-BigInt(String(nul.t.notional))));
    expect(nul.logs.some((l) => l.includes(FILL_RATE_UNKNOWN))).toBe(false);
    const absent = await caughtUp(withLine((l) => { delete l['sol_usd']; }));
    expect(String(absent.t.closeSolPrice)).toBe(String(SOL_PRICE * 2n));
    expect(absent.logs.some((l) => l.includes(FILL_RATE_UNKNOWN))).toBe(true);
  });
});

describe('fill keys', () => {
  it('two equal partial fills of one intent are two keys (cumulative tokens), and only entry and exit lines count', () => {
    expect(fillKey('i1', 5n)).not.toBe(fillKey('i1', 10n));
    const keys = journaledFillKeys([
      { kind: 'exit', intent: 'i1', tokens: '5' },
      { kind: 'exit', intent: 'i1', tokens: '10' },
      { kind: 'decision', intent: 'i2', tokens: '5' },
      { kind: 'entry', intent: 'i3', tokens: 'x' },
    ]);
    expect([...keys.keys()].sort()).toEqual([fillKey('i1', 10n), fillKey('i1', 5n)].sort());
  });
});
