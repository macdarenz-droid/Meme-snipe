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
import { checkJournal } from '../../runner/src/journal.ts';
import { closedSince, recoveredState, withoutTrades } from '../../runner/src/runner.ts';
import { type Lamports, type MicroUsd, lamportsToMicroUsd } from '../../core/src/units/index.ts';
import { type AccountState, accountFile, paperTradeLamports } from '../src/run/account.ts';
import { FILL_RATE_UNKNOWN, fillKey, journaledFillKeys } from '../src/run/desk.ts';
import { FILL_CONFIG } from '../../core/src/config/index.ts';
import { attemptFee, tradeNet, tradeUsd } from '../../core/src/fills/index.ts';
import type { PaperAttempt } from '../src/run/paper-world.ts';
import { SOL_PRICE_KEY } from '../src/engine/strategy.ts';
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

  it('a line with sol_usd null (no price at booking) is valued at the first price after it, flagged; a line without the field falls back to the price now, with an unpriced_fill alert', async () => {
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
    const nulDir = withLine((l) => { l['sol_usd'] = null; });
    const nul = await caughtUp(nulDir);
    // ACCOUNT-RATE: never a made-up loss of the notional; the first price after the fill (the restart's) values it.
    expect(String(nul.t.closeSolPrice)).toBe(String(SOL_PRICE * 2n));
    expect(nul.t.pricedLate).toEqual(['close']);
    expect(String(nul.t.netPnl)).not.toBe(String(-BigInt(String(nul.t.notional))));
    expect(nul.logs.some((l) => l.includes(FILL_RATE_UNKNOWN))).toBe(false);
    expect(lines(nulDir).filter((l) => l.kind === 'alert' && l['code'] === 'unpriced_fill')).toEqual([]);
    const absentDir = withLine((l) => { delete l['sol_usd']; });
    const absent = await caughtUp(absentDir);
    expect(String(absent.t.closeSolPrice)).toBe(String(SOL_PRICE * 2n));
    expect(absent.logs.some((l) => l.includes(FILL_RATE_UNKNOWN))).toBe(true);
    // The run report counts it.
    const alerts = lines(absentDir).filter((l) => l.kind === 'alert' && l['code'] === 'unpriced_fill');
    expect(alerts.map((l) => [l.trade, l['purpose']])).toEqual([[pid, 'exit']]);
    expect(checkJournal(readFileSync(join(absentDir, 'journal.jsonl'), 'utf8')).unpriced_fills).toEqual([`${pid}|exit`]);
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

describe('ACCOUNT-RATE: restarts, missed fills and stale prices', () => {
  it('a kill after a partial exit\'s ledger commit, before account.json: the restart\'s reconcile books the proceeds into the wallet once', async () => {
    let image: { dir: string; pid: string } | null = null;
    let h: H | null = null;
    h = makeWorker({
      crashPoint: (point, intent) => {
        if (image !== null || point !== 'fill-committed') return;
        const s = h!.worker.book.intents[intent as never];
        const p = s === undefined ? undefined : h!.worker.book.positions[s.intent.positionId];
        if (s?.intent.purpose !== 'exit' || p?.status !== 'open') return;
        const dir = mkdtempSync(join(tmpdir(), 'zeroed-crash-'));
        cpSync(h!.stateDir, dir, { recursive: true });
        image = { dir, pid: p.id };
      },
    });
    expect(await h.worker.reconcile()).toEqual({ ok: true });
    const m = await passingMarket(h, { heldPoolFacts: true });
    expect(await until(m, () => Object.values(h!.worker.book.positions).some((p) => p.status === 'open'), 30_000, tick(m))).toBe(true);
    // +15%: past 1.5R, so the first partial sells half and the position stays open.
    expect(await until(m, () => image !== null, 30_000, tick(m, 1_150_000n))).toBe(true);
    // The first process's own account after that fill: what the restart must reach.
    await m.run(400, 400, tick(m, 1_150_000n));
    const img = image! as { dir: string; pid: string };
    const want = accountFile(h.stateDir).read(null as unknown as AccountState).trades.find((t) => t.positionId === img.pid)!;
    await h.worker.stop();
    const account = () => accountFile(img.dir).read(null as unknown as AccountState);
    const atKill = account();
    const tKill = atKill.trades.find((t) => t.positionId === img.pid)!;
    // The image: the ledger holds the partial, the account does not.
    expect(BigInt(String(tKill.booked))).not.toBe(BigInt(String(want.booked)));
    const gap = BigInt(String(want.booked)) - BigInt(String(tKill.booked));
    expect(gap > 0n).toBe(true);

    rmSync(join(img.dir, 'cold_start'), { force: true });
    const h2 = makeWorker({ stateDir: img.dir, timers: h.timers });
    expect(await h2.worker.reconcile()).toEqual({ ok: true });
    const t2 = account().trades.find((t) => t.positionId === img.pid)!;
    expect(BigInt(String(t2.booked))).toBe(BigInt(String(want.booked)));
    expect(BigInt(String(account().walletLamports))).toBe(BigInt(String(atKill.walletLamports)) + gap);
    // Once: another settle moves nothing.
    const m2 = new Market(h2, { heldPoolFacts: true });
    await m2.run(2_000, 400, tick(m2, 1_150_000n));
    expect(BigInt(String(account().trades.find((t) => t.positionId === img.pid)!.booked))).toBe(BigInt(String(want.booked)));
    await h2.worker.stop();
  });

  it('an exit the world landed before the kill, booked by the restart before any SOL price: valued at the first price after it, never as a loss of the notional', async () => {
    const { h, image } = await crashBetweenExitWrites();
    await h.worker.stop();
    const pid = image.reply.open_positions[0]!.trade;
    // A kill before the desk wrote anything for the landing: drop the exit line, so the restart books a new fill.
    const path = join(image.dir, 'journal.jsonl');
    writeFileSync(path, readFileSync(path, 'utf8').split('\n').filter((t) => !(t.includes('"kind":"exit"') && t.includes(`"intent":"${image.intent}"`))).join('\n'));
    const h2 = restart(h, image);
    expect(await h2.worker.start()).toEqual({ ok: true });
    const m2 = new Market(h2, { heldPoolFacts: true });
    m2.solUsd = SOL_PRICE * 2n;
    const trade = () => accountFile(image.dir).read(null as unknown as AccountState).trades.find((x) => x.positionId === pid);
    expect(await until(m2, () => trade()?.netPnl != null, 10_000, tick(m2, 700_000n))).toBe(true);
    const line = lines(image.dir).find((l) => l.kind === 'exit' && l['intent'] === image.intent)!;
    // Booked with no price known (the reconcile's), so its line has none.
    expect(line['sol_usd']).toBeNull();
    const t = trade()!;
    expect(t.pricedLate).toEqual(['close']);
    expect(String(t.closeSolPrice)).toBe(String(SOL_PRICE * 2n));
    expect(String(t.netPnl)).not.toBe(String(-BigInt(String(t.notional))));
    await h2.worker.stop();
  });

  it('a fill re-booked from a held line with no rate (booked at the start reconcile, before any price): valued at the first price after it (sol_usd null), or flagged unpriced (no field)', async () => {
    const { h, image } = await crashBetweenExitWrites();
    await h.worker.stop();
    const pid = image.reply.open_positions[0]!.trade;
    const run = async (edit: (l: Record<string, unknown>) => void) => {
      const dir = mkdtempSync(join(tmpdir(), 'zeroed-crash-'));
      cpSync(image.dir, dir, { recursive: true });
      const path = join(dir, 'journal.jsonl');
      writeFileSync(path, readFileSync(path, 'utf8').split('\n').map((t) => {
        if (t === '' || !t.includes('"kind":"exit"') || !t.includes(`"intent":"${image.intent}"`)) return t;
        const l = JSON.parse(t) as Record<string, unknown>;
        edit(l);
        return JSON.stringify(l);
      }).join('\n'));
      const h2 = restart(h, { ...image, dir });
      expect(await h2.worker.start()).toEqual({ ok: true });
      const m2 = new Market(h2, { heldPoolFacts: true });
      m2.solUsd = SOL_PRICE * 2n;
      const trade = () => accountFile(dir).read(null as unknown as AccountState).trades.find((x) => x.positionId === pid);
      expect(await until(m2, () => trade()?.netPnl != null, 30_000, tick(m2, 700_000n))).toBe(true);
      const t = trade()!;
      await h2.worker.stop();
      return { t, alerts: lines(dir).filter((l) => l.kind === 'alert' && l['code'] === 'unpriced_fill') };
    };
    const nul = await run((l) => { l['sol_usd'] = null; });
    expect(String(nul.t.closeSolPrice)).toBe(String(SOL_PRICE * 2n));
    expect(nul.t.pricedLate).toEqual(['close']);
    expect(String(nul.t.netPnl)).not.toBe(String(-BigInt(String(nul.t.notional))));
    expect(nul.alerts).toEqual([]);
    const absent = await run((l) => { delete l['sol_usd']; });
    expect(String(absent.t.closeSolPrice)).toBe(String(SOL_PRICE * 2n));
    expect(absent.alerts.map((l) => [l.trade, l['purpose']])).toEqual([[pid, 'exit']]);
  });

  it('F2: an exit booked when the SOL price is 10 × maxQuoteAgeMs old is not valued at that stale price, but at the first fresh price after it', async () => {
    const h = makeWorker();
    expect(await h.worker.reconcile()).toEqual({ ok: true });
    const m = await passingMarket(h, { heldPoolFacts: true });
    const open = () => Object.values(h.worker.book.positions).find((p) => p.status === 'open');
    expect(await until(m, () => open() !== undefined, 30_000, tick(m))).toBe(true);
    const pid = open()!.id;
    // The price feed goes quiet: the last price ages past ten times the freshness limit.
    m.omit = new Set([SOL_PRICE_KEY]);
    const maxAge = h.session.policy.gates.maxQuoteAgeMs;
    await m.run(10 * maxAge + 400, 400, tick(m));
    expect(await until(m, () => h.worker.book.positions[pid]?.status === 'closed', 30_000, tick(m, 700_000n))).toBe(true);
    const trade = () => accountFile(h.stateDir).read(null as unknown as AccountState).trades.find((x) => x.positionId === pid)!;
    const line = lines(h.stateDir).find((l) => l.kind === 'exit' && l['trade'] === pid && l['position'] === 'closed')!;
    expect(line['sol_usd']).toBeNull();
    expect(trade().closedAtMs).not.toBeNull();
    expect(trade().netPnl).toBeNull();
    // A fresh price again, at a new level: it values the close.
    m.omit = new Set();
    m.solUsd = SOL_PRICE * 2n;
    expect(await until(m, () => trade().netPnl != null, 5_000, tick(m, 700_000n))).toBe(true);
    expect(String(trade().closeSolPrice)).toBe(String(SOL_PRICE * 2n));
    expect(trade().pricedLate).toEqual(['close']);
    await h.worker.stop();
  });

  it('risk ruling: while a close is unvalued no entry is approved; on the event the fresh price returns, the candidate is refused, not judged on a day missing that loss', async () => {
    const h = makeWorker();
    expect(await h.worker.reconcile()).toEqual({ ok: true });
    const m = await passingMarket(h, { heldPoolFacts: true });
    const open = () => Object.values(h.worker.book.positions).find((p) => p.status === 'open');
    expect(await until(m, () => open() !== undefined, 30_000, tick(m))).toBe(true);
    const pid = open()!.id;
    // The price feed goes quiet; the position is closed by its flat-time rule (about break-even, so no loss latch).
    m.omit = new Set([SOL_PRICE_KEY]);
    const end = m.now + 20 * 60_000;
    while (h.worker.book.positions[pid]?.status !== 'closed' && m.now < end) await m.run(1_000, 1_000, tick(m));
    expect(h.worker.book.positions[pid]?.status).toBe('closed');
    const trade = () => accountFile(h.stateDir).read(null as unknown as AccountState).trades.find((x) => x.positionId === pid)!;
    expect(trade().netPnl).toBeNull();
    // Streams fresh again, still no price; then the price returns, with a candidate due on that same event.
    await m.run(2_000, 400, tick(m));
    const seq = h.worker.health().journal_seq;
    m.omit = new Set();
    const at = m.now;
    await m.run(6_000, 400, tick(m));
    const after = lines(h.stateDir).filter((l) => l.seq > seq && l.kind === 'decision');
    const reasons = (l: JournalLine) => ((l.reasons ?? []) as string[]).join(' | ');
    // On the price's own event: refused for the unvalued close, never approved.
    const sameEvent = after.filter((l) => Date.parse(l.ts) === at);
    expect(sameEvent.some((l) => reasons(l).includes('account unvalued'))).toBe(true);
    expect(sameEvent.some((l) => l['action'] === 'approve_risk')).toBe(false);
    expect(trade().netPnl).not.toBeNull();
    // Once the valued snapshot is out, the next candidate is judged by risk with the loss in it (here R11 then refuses a
    // second entry in the mint the same day): no longer held back as unvalued.
    const next = after.find((l) => Date.parse(l.ts) > at && l['action'] !== undefined)!;
    expect(reasons(next)).not.toContain('account unvalued');
    expect(next['action'] === 'approve_risk' || reasons(next).includes('risk ')).toBe(true);
    await h.worker.stop();
  });

  it('F2: with the price feed live, a round trip is booked at its own fresh prices: never valued late', async () => {
    const h = makeWorker();
    expect(await h.worker.reconcile()).toEqual({ ok: true });
    const m = await passingMarket(h, { heldPoolFacts: true });
    const open = () => Object.values(h.worker.book.positions).find((p) => p.status === 'open');
    expect(await until(m, () => open() !== undefined, 30_000, tick(m))).toBe(true);
    const pid = open()!.id;
    expect(await until(m, () => h.worker.book.positions[pid]?.status === 'closed', 30_000, tick(m, 700_000n))).toBe(true);
    const t = accountFile(h.stateDir).read(null as unknown as AccountState).trades.find((x) => x.positionId === pid)!;
    expect(t.pricedLate).toBeUndefined();
    expect(String(t.openSolPrice)).toBe(String(SOL_PRICE));
    expect(String(t.closeSolPrice)).toBe(String(SOL_PRICE));
    expect(t.netPnl).not.toBeNull();
    for (const l of lines(h.stateDir).filter((x) => (x.kind === 'entry' || x.kind === 'exit') && x['trade'] === pid)) expect(l['sol_usd']).toBe(String(SOL_PRICE));
    await h.worker.stop();
  });

  describe('a stray fee booked while the SOL price is stale', () => {
    // Every attempt lands failed: the entry ends unfilled, and its fee is a stray cost (PAPER-1).
    const scenario = { ...LANDS, landPpm: { pumpswap: 0n, 'pump-curve': 0n }, dropPpm: 0n };
    const wallet = (dir: string) => BigInt(String(accountFile(dir).read(null as unknown as AccountState).walletLamports));
    const fees = (dir: string) => {
      const paper = JSON.parse(readFileSync(join(dir, 'paper.json'), 'utf8'), (_k, v) => (v !== null && typeof v === 'object' && '$n' in v ? BigInt((v as { $n: string }).$n) : v)) as { attempts: Record<string, { priorityFee: bigint }> };
      return Object.values(paper.attempts).reduce((x, a) => x + attemptFee(FILL_CONFIG.network, a.priorityFee, 'failed'), 0n);
    };
    /** Trades until the first entry intent appears, then withholds the SOL price until that entry has ended unfilled. */
    const staleStray = async () => {
      const h = makeWorker({ scenario });
      expect(await h.worker.reconcile()).toEqual({ ok: true });
      const m = await passingMarket(h, { heldPoolFacts: true });
      expect(await until(m, () => Object.keys(h.worker.book.intents).length > 0, 30_000, tick(m))).toBe(true);
      const lastPrice = m.now;
      m.omit = new Set([SOL_PRICE_KEY]);
      const ended = () => Object.values(h.worker.book.intents).every((i) => i.status === 'abandoned' || i.status === 'cancelled' || i.status === 'rejected');
      expect(await until(m, ended, 30_000, tick(m))).toBe(true);
      // It ended after the price had gone stale, so its fee was not booked then.
      expect(m.now - lastPrice).toBeGreaterThan(h.session.policy.gates.maxQuoteAgeMs);
      expect(fees(h.stateDir)).toBeGreaterThan(0n);
      return { h, m, before: wallet(h.stateDir) };
    };

    it('a fresh price after the stale stretch, with no book event, books the fee before any entry is judged', async () => {
      const { h, m, before } = await staleStray();
      const seq = h.worker.health().journal_seq;
      m.omit = new Set();
      // Only prices: no slot, no pool, no book event (the feed releases a fact about 2 s after it is received). Each step:
      // no entry approved while the fee is still out of the wallet.
      let approvedEarly = false;
      for (let k = 0; k < 10; k++) {
        await m.run(400, 400, () => m.solPrice());
        const approved = lines(h.stateDir).some((l) => l.seq > seq && l['action'] === 'approve_risk');
        if (approved && wallet(h.stateDir) === before) approvedEarly = true;
      }
      expect(wallet(h.stateDir)).toBe(before - fees(h.stateDir));
      expect(approvedEarly).toBe(false);
      // The candidate on the price's own event saw the unbooked fee in the account and was refused.
      const refused = lines(h.stateDir).filter((l) => l.seq > seq && ((l.reasons ?? []) as string[]).some((r) => r.includes('account unvalued')));
      expect(refused.length).toBeGreaterThan(0);
      const firstApprove = lines(h.stateDir).find((l) => l.seq > seq && l['action'] === 'approve_risk');
      if (firstApprove !== undefined) expect(firstApprove.seq).toBeGreaterThan(refused[0]!.seq);
      await h.worker.stop();
    });

    it('a restart whose first price is stale books the fee at the first fresh price after it', async () => {
      const { h, before } = await staleStray();
      await h.worker.stop();
      const h2 = makeWorker({ stateDir: h.stateDir, timers: h.timers, scenario });
      expect(await h2.worker.reconcile()).toEqual({ ok: true });
      const m2 = new Market(h2, { heldPoolFacts: true });
      // The first price after boot is ten seconds old.
      await m2.run(4_000, 400, () => m2.fact(SOL_PRICE_KEY, { value: SOL_PRICE, atMs: m2.now - 10_000 }));
      expect(wallet(h.stateDir)).toBe(before);
      await m2.run(4_000, 400, () => m2.solPrice());
      expect(wallet(h.stateDir)).toBe(before - fees(h.stateDir));
      await h2.worker.stop();
    });
  });
});

