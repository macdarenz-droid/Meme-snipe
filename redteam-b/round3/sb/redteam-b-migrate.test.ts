// RED TEAM B round 3: SOL-BOOKS migration attacks. An account.json from before SOL-BOOKS (dollar day/week marks, a
// dollar NAV peak, trades with dollar notionals and results) is deployed at a SOL/USD price 30% below the price its
// wallet was funded at. Owner rule: a SOL/USD move alone never trips or hides a limit; R10 and R9 must not latch, and
// no day or week loss may appear that the SOL books do not hold.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TRIAL_POLICY } from '../../core/src/config/index.ts';
import { melbourneDay, melbourneWeek } from '../../core/src/risk/index.ts';
import { accountFile } from '../src/run/account.ts';
import { NO_CONTROL, controlFile } from '../src/run/state.ts';
import { Market, SOL_PRICE, T, makeWorker, tempState } from './worker-harness.ts';

const DAY = 86_400_000;
const NOW0 = T - 16 * DAY;
const FUNDED = 133_333_334n; // $20 at SOL_PRICE (as redteam-b-sol.test.ts)
const B = TRIAL_POLICY.capital.bankroll as bigint;
type Line = { kind: string; action?: string; gate_reasons?: { code: string }[]; reasons?: string[] };
const lines = (dir: string) => readFileSync(join(dir, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Line);

/** An old (dollar-books) file whose one closed trade gained `gain` lamports while SOL/USD stood at `pxTrade`. */
const oldFile = (gain: bigint, pxTrade: bigint) => {
  const dayStart = melbourneDay(NOW0).start;
  const weekStart = melbourneWeek(NOW0).start;
  const closedAt = Math.max(dayStart + 60_000, weekStart + 60_000, NOW0 - 3_600_000);
  const pnlUsd = (gain * pxTrade) / 1_000_000_000n;
  const equityUsd = B + pnlUsd; // the old realized equity in dollars, as the old worker marked it at the boundary
  return {
    openedAtMs: T - 20 * DAY, openingEquity: B, walletLamports: FUNDED + gain, entries: [{ mint: 'MintX', atMs: closedAt - 600_000 }], oneTimePaid: true,
    trades: [{ positionId: 'p:MintX:1', mint: 'MintX', openedAtMs: closedAt - 600_000, notional: 2_000_000n, closedAtMs: closedAt, netLamports: gain, netPnl: pnlUsd, stoppedOut: false, booked: gain, openSolPrice: pxTrade, closeSolPrice: pxTrade }],
    dayMark: { startMs: dayStart, atMs: dayStart + 1_000, equity: equityUsd },
    weekMark: { startMs: weekStart, atMs: weekStart + 1_000, equity: equityUsd },
    navPeak: { atMs: closedAt, nav: equityUsd },
  };
};

const deploy = async (file: Record<string, unknown>, port: number) => {
  const stateDir = tempState();
  accountFile(stateDir).write(file as never);
  const h = makeWorker({ stateDir, config: { ZEROED_HEALTH_ADDR: `127.0.0.1:${port}`, ZEROED_API_ADDR: `127.0.0.1:${port + 1}` } });
  expect(await h.worker.reconcile()).toEqual({ ok: true });
  const m = new Market(h);
  m.solUsd = (SOL_PRICE * 70n) / 100n;
  await m.run(4_000, 400, () => { m.slot(); m.solPrice(); h.worker.step(); });
  const latches = controlFile(stateDir).read(NO_CONTROL).latches;
  const codes = h.worker.apiInputs().stops?.codes ?? [];
  const snap = h.worker.apiInputs();
  await h.worker.stop();
  return { latches, codes, lines: lines(stateDir), a: accountFile(stateDir).read(null as never), snap };
};

describe('RB-10 SOL-BOOKS migration at SOL/USD -30%', () => {
  it('RB-10a no trades, dollar marks and NAV peak: nothing latches, no day or week loss', async () => {
    const f = oldFile(0n, SOL_PRICE);
    const r = await deploy({ ...f, trades: [], walletLamports: FUNDED }, 19300);
    expect(r.latches.killTrippedAtMs).toBeNull();
    expect(r.latches.weeklyTrippedAtMs).toBeNull();
    expect(r.codes).not.toContain('kill_switch');
    expect(r.codes).not.toContain('daily_loss');
    expect(r.codes).not.toContain('weekly_loss');
  });
  it('RB-10b a trade that GAINED 35% of B in SOL while SOL/USD was 30% above the funding price: no phantom day loss', async () => {
    const r = await deploy(oldFile((FUNDED * 35n) / 100n, (SOL_PRICE * 130n) / 100n), 19310);
    expect(r.latches.killTrippedAtMs).toBeNull();
    expect(r.codes).not.toContain('daily_loss');
  });
  it('RB-10c a trade that GAINED 75% of B in SOL at SOL/USD +30%: no phantom weekly loss latched (R9)', async () => {
    const r = await deploy(oldFile((FUNDED * 75n) / 100n, (SOL_PRICE * 130n) / 100n), 19320);
    expect(r.latches.weeklyTrippedAtMs).toBeNull();
    expect(r.latches.killTrippedAtMs).toBeNull();
    expect(r.codes).not.toContain('weekly_loss');
  });
  it('RB-10d a trade that LOST 10% of B in SOL while SOL/USD was 30% above: the day loss still shows it (not hidden)', async () => {
    const r = await deploy(oldFile(-(FUNDED * 10n) / 100n, (SOL_PRICE * 130n) / 100n), 19330);
    // 10% of B lost today is past R7's 7.5%: entries refused for the day.
    expect(r.codes).toContain('daily_loss');
  });
});
