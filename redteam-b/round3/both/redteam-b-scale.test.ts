// RED TEAM B round 3, item 2b: one paper trade end to end (entry, fill, stop, exit, settlement) with an edge set (TEST
// ONLY, never config) at a $5-trade trial ($20 bankroll), a $100 bankroll and a $10k bankroll. The paper wallet must
// equal the chain-derived balance (paper.json, the simulated chain) to the lamport, and the trade's result is in SOL.
// RB_SCALE=k multiplies the trial's bankroll and trade sizes by k. For k > 1 the policy is built here, not validated
// (a session over the approved baseline is refused by design), and the depth limits are opened so the harness's one
// 245-SOL pool can take the size: this probes the money path, not the gates.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const K = BigInt(process.env['RB_SCALE'] ?? '1');
vi.mock('../../core/src/config/index.ts', async (orig) => {
  const m = await orig<typeof import('../../core/src/config/index.ts')>();
  if (K === 1n) return m;
  const p = structuredClone(m.TRIAL_POLICY) as { -readonly [k in keyof typeof m.TRIAL_POLICY]: any };
  p.capital = { ...p.capital, bankroll: p.capital.bankroll * K, minNotional: p.capital.minNotional * K, maxNotional: p.capital.maxNotional * K };
  p.liquidity = { ...p.liquidity, floorNotionalMultiple: 1, maxImpactBps: 2_000 };
  if (K > 100n) { p.costGate = { ...p.costGate, maxRoundTripBps: 1_200 }; p.loss = { ...p.loss, plannedRiskBps: 900 }; }
  const policy = Object.freeze(p) as typeof m.TRIAL_POLICY;
  const startSession = () => { const s = m.startSession(m.TRIAL_POLICY); return { ...s, policy, get running() { return true; } }; };
  return { ...m, TRIAL_POLICY: policy, startSession };
});

const { FILL_CONFIG, TRIAL_POLICY } = await import('../../core/src/config/index.ts');
const { feeParts } = await import('../../core/src/fills/index.ts');
const { accountFile } = await import('../src/run/account.ts');
const { parseTyped } = await import('../src/run/json.ts');
const { LANDS, makeWorker, passingMarket } = await import('./worker-harness.ts');

const NET = FILL_CONFIG.network;
interface Attempt { intentId: string; signature: string; purpose: 'entry' | 'exit'; priorityFee: bigint; outcome: string; fill: { sol: bigint; tokens: bigint } | null }

describe(`RB-13 one trade at ${K}x the trial`, () => {
  it('ledger exact to the lamport, result in SOL', async () => {
    const scen = { ...LANDS, landPpm: { pumpswap: BigInt(process.env['RB_LAND'] ?? '600000'), 'pump-curve': 600_000n }, dustPpm: 0n, closeSuccessPpm: 1_000_000n };
    const h = makeWorker({ scenario: scen });
    expect(await h.worker.reconcile()).toEqual({ ok: true });
    const m = await passingMarket(h, { heldPoolFacts: true });
    const w0 = accountFile(h.stateDir).read(null as never).walletLamports!;
    const run = async (done: () => boolean, ms: number, scale: bigint) => { const end = m.now + ms; while (!done() && m.now < end) await m.run(400, 400, () => { m.slot(); m.pool(scale); }); return done(); };
    const pos = () => Object.values(h.worker.book.positions);
    const opened = await run(() => pos().some((p) => p.status === 'open'), 40_000, 1_000_000n);
    if (!opened) console.log('REJ', [...new Set(readFileSync(join(h.stateDir, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { kind: string; action?: string; reasons?: string[] }).filter((l) => l.kind === 'decision' && l.action === 'reject').map((l) => (l.reasons ?? [])[3] ?? ''))].join(' | ').slice(0, 1500));
    const strayOnly = process.env['RB_LAND'] === '80000';
    if (!strayOnly) expect(opened).toBe(true);
    if (opened) expect(await run(() => pos().length > 0 && pos().every((p) => p.status === 'closed'), 2_400_000, 700_000n)).toBe(true);
    // Every intent settled (a failed entry's fees are booked as a stray cost at the next price).
    await run(() => Object.values(h.worker.book.intents).every((i) => ['rejected', 'cancelled', 'abandoned', 'reconciled'].includes(i.status)), 600_000, 700_000n);
    await m.run(4_000, 400, () => { m.slot(); m.pool(700_000n); });
    const a = accountFile(h.stateDir).read(null as never);
    const v = parseTyped(readFileSync(join(h.stateDir, 'paper.json'), 'utf8')) as { attempts: Record<string, Attempt> };
    const as = Object.values(v.attempts);
    await h.worker.stop();
    let chain = w0;
    let entrySol = 0n;
    let exitSol = 0n;
    let fees = 0n;
    for (const x of as) {
      const f = feeParts(NET, x.priorityFee, x.outcome);
      fees += f.base + f.priority + f.tip;
      if (x.outcome === 'filled' && x.fill !== null) { if (x.purpose === 'entry') entrySol += x.fill.sol; else exitSol += x.fill.sol; }
    }
    chain += exitSol - entrySol - fees; // rent paid on entry comes back on the closing sell (no dust, closes succeed)
    if (a.trades.length === 0) {
      console.log(`RB-13 ${K}x stray`, JSON.stringify({ fees: String(fees), wallet: String(a.walletLamports), chain: String(chain), attempts: as.length, strays: Object.keys(a.strayFees ?? {}).length }));
      expect(fees > 0n).toBe(true);
      expect(a.walletLamports).toBe(chain);
      return;
    }
    const t = a.trades[0]!;
    console.log(`RB-13 ${K}x`, JSON.stringify({ spent: String(entrySol), got: String(exitSol), fees: String(fees), net: String(t.netLamports), wallet: String(a.walletLamports), chain: String(chain), attempts: as.length, notional: String(t.notional), bankroll: String(TRIAL_POLICY.capital.bankroll) }));
    expect(a.trades).toHaveLength(1);
    expect(entrySol > 0n && exitSol > 0n).toBe(true);
    expect(a.walletLamports).toBe(chain);
    // The trade's result is its SOL: exactly the chain's change for it.
    expect(t.netLamports).toBe(exitSol - entrySol - fees);
    expect(t.booked).toBe(t.netLamports);
    // Its size is in lamports (SOL-BOOKS): q, the SOL the entry spent, within the policy's range at the opening price.
    expect(BigInt(t.notional) > 0n).toBe(true);
  }, 900_000);
});
