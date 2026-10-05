// R14-EVIDENCE: a candidate refused by R14's cost gate (or R5's planned risk) carries the round trip it was refused on,
// in parts, on its reject line; the daily summary lists the day's latest ones and counts the refusal by its risk code.
import { describe, expect, it } from 'vitest';
import { FEE_CONTEXT } from '../../core/test/gates/world.ts';
import { bps } from '../../core/src/units/index.ts';
import { checkSummary } from '../../ops/src/watchdog/summary.ts';
import { COST_PREFIX } from '../src/engine/strategy.ts';
import { Summarizer, buildSummary, emptySummaryState, foldLine } from '../src/run/summary.ts';
import type { HttpClient } from '../src/providers/index.ts';
import { tempState } from './worker-harness.ts';
import { writeFileSync } from 'node:fs';
import { makeWorker, passingMarket } from './worker-harness.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const lines = (dir: string): Record<string, unknown>[] =>
  readFileSync(join(dir, 'journal.jsonl'), 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as Record<string, unknown>);
const rejects = (dir: string) => lines(dir).filter((l) => l['kind'] === 'decision' && l['action'] === 'reject');

/** The passing pool's fee terms with the creator rate raised to `creator` bps a side. */
const feesWith = (creator: number) => ({
  ...FEE_CONTEXT,
  feeConfig: { ...FEE_CONTEXT.feeConfig, feeTiers: [{ marketCapThreshold: 0n, fees: { lp: bps(2), protocol: bps(93), creator: bps(creator) } }] },
});

describe('R14-EVIDENCE: a cost refusal shows its round trip', () => {
  it('a pool whose fees push the round trip over 5% is refused by R14, and the reject line carries the parts it was refused on', async () => {
    const h = makeWorker();
    expect(await h.worker.reconcile()).toEqual({ ok: true });
    const m = await passingMarket(h);
    m.feeContext = feesWith(400);
    const costRefused = () => rejects(h.stateDir).find((l) => JSON.stringify(l['gate_reasons']).includes('cost_gate'));
    const end = m.now + 30_000;
    while (costRefused() === undefined && m.now < end) await m.run(400, 400, () => { m.slot(); m.pool(); });
    const r = costRefused();
    expect(r).toBeDefined();
    expect(r!['gate_reasons']).toEqual([expect.objectContaining({ gate: 'R14', code: 'cost_gate' })]);
    const raw = (r!['reasons'] as string[]).find((x) => x.startsWith(COST_PREFIX));
    expect(raw).toBeDefined();
    const c = JSON.parse(raw!.slice(COST_PREFIX.length)) as Record<string, unknown>;
    // The same figure risk refused on: its detail names the round trip in ppm.
    const detail = String((r!['gate_reasons'] as { detail: string }[])[0]!.detail);
    expect(detail).toContain(`round trip ${c['rt_ppm']} ppm`);
    expect(c['rt_ppm'] as number).toBeGreaterThan(50_000);
    expect([c['lp_bps'], c['protocol_bps'], c['creator_bps']]).toEqual([2, 93, 400]);
    expect(c['fee_source']).toBe('feeconfig');
    expect((c['fees_ppm'] as number) + (c['impact_ppm'] as number)).toBeLessThanOrEqual(c['rt_ppm'] as number);
    expect(BigInt(c['f_lamports'] as string)).toBeGreaterThan(0n);
    expect(typeof c['spend_lamports']).toBe('string');
    await h.worker.stop();
  });

  it('at the normal fees R14 passes and the entry opens; no reject line carries a cost reason', async () => {
    const h = makeWorker();
    expect(await h.worker.reconcile()).toEqual({ ok: true });
    const m = await passingMarket(h);
    m.feeContext = feesWith(30);
    const end = m.now + 30_000;
    const opened = () => Object.values(h.worker.book.positions).some((p) => p.status === 'open');
    while (!opened() && m.now < end) await m.run(400, 400, () => { m.slot(); m.pool(); });
    expect(opened()).toBe(true);
    for (const r of rejects(h.stateDir)) expect((r['reasons'] as string[]).some((x) => x.startsWith(COST_PREFIX))).toBe(false);
    await h.worker.stop();
  });
});

describe('R14-EVIDENCE: the summary', () => {
  const NOON = Date.parse('2026-10-04T01:00:00.000Z');
  const M = 'So11111111111111111111111111111111111111112';
  const parts = (i: number) => ({ fee_source: 'event', spend_lamports: '16537126', sol_usd_micro: '120940000', eff_quote_lamports: '104806998735', stop_bps: 1500, rt_ppm: 59_822 + i, fees_ppm: 54_000, impact_ppm: 300, f_lamports: '99286', lp_bps: 20, protocol_bps: 5, creator_bps: 250 });
  const reject = (ms: number, mint: string, cost: unknown, gate = 'R14', code = 'cost_gate') => ({
    seq: 1, ts: new Date(ms).toISOString(), boot: 'b', kind: 'decision', action: 'reject',
    reasons: ['reject', 'U2', mint, `risk ${gate} ${code}: x`, ...(cost === undefined ? [] : [`${COST_PREFIX}${typeof cost === 'string' ? cost : JSON.stringify(cost)}`])],
    gate_reasons: [{ gate, code, detail: 'x' }],
  });
  const inputs = (fold: ReturnType<typeof emptySummaryState>['days'][string] | undefined) => ({
    day: '2026-10-04', final: false, nowMs: NOON + 3_600_000, fold, gitSha: 'a'.repeat(40), entryRule: 'S0', recorder: 'on' as const, uptimeS: 3600,
    trades: [], openPositions: 0, solPrice: null, credits: [],
  });

  it('counts the refusal by its risk code and lists the day\'s latest 10 cost refusals, oldest first; the body passes both guards', () => {
    const s = emptySummaryState();
    for (let i = 0; i < 12; i++) foldLine(s, reject(NOON + i, M, parts(i)));
    // The fold itself keeps only the latest 10: the saved state stays bounded however many refusals a day has.
    expect(s.days['2026-10-04']!.costs).toHaveLength(10);
    const sum = buildSummary(inputs(s.days['2026-10-04']));
    expect(sum.candidates.refused_by_reason).toEqual([{ gate: 'R14', code: 'cost_gate', count: 1 }]);
    expect(sum.cost_refusals).toHaveLength(10);
    expect(sum.cost_refusals!.map((x) => x.rt_ppm)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((i) => 59_822 + i));
    expect(sum.cost_refusals![0]).toEqual({ at: new Date(NOON + 2).toISOString(), mint: M, gate: 'R14', code: 'cost_gate', unquoted: null, ...parts(2) });
    const c = checkSummary(JSON.stringify(sum));
    expect(c.ok).toBe(true);
  });

  it('keeps nothing unchecked: a malformed number, a bad source or unreadable JSON is not folded, an unknown key is dropped; no cost reason sends no key', () => {
    const s = emptySummaryState();
    foldLine(s, reject(NOON, M, { ...parts(0), extra: 1 }));
    foldLine(s, reject(NOON + 1, M, { ...parts(0), rt_ppm: -5 }));
    foldLine(s, reject(NOON + 2, M, { ...parts(0), fee_source: 'guess' }));
    foldLine(s, reject(NOON + 3, M, { ...parts(0), spend_lamports: '1.5' }));
    foldLine(s, reject(NOON + 4, M, '{not json'));
    foldLine(s, reject(NOON + 5, M, undefined, 'H5', 'low-liquidity'));
    const sum = buildSummary(inputs(s.days['2026-10-04']));
    // Only the first is listed, and only with the summary's own keys: an unknown key is never carried.
    expect(sum.cost_refusals).toEqual([{ at: new Date(NOON).toISOString(), mint: M, gate: 'R14', code: 'cost_gate', unquoted: null, ...parts(0) }]);
    expect(checkSummary(JSON.stringify(sum)).ok).toBe(true);
    // A day with no cost refusal sends no key at all (the shape an older watchdog accepts).
    const none = emptySummaryState();
    foldLine(none, reject(NOON, M, undefined, 'H5', 'low-liquidity'));
    expect(Object.keys(buildSummary(inputs(none.days['2026-10-04'])))).not.toContain('cost_refusals');
  });

  it('an unquoted size lists its reason as a code and no parts', () => {
    const s = emptySummaryState();
    const { fee_source, spend_lamports, sol_usd_micro, eff_quote_lamports, stop_bps } = parts(0);
    foldLine(s, reject(NOON, M, { fee_source, spend_lamports, sol_usd_micro, eff_quote_lamports, stop_bps, unquoted: 'RangeError' }, 'R5', 'planned_risk'));
    const sum = buildSummary(inputs(s.days['2026-10-04']));
    expect(sum.cost_refusals).toEqual([expect.objectContaining({ gate: 'R5', code: 'planned_risk', unquoted: 'error', rt_ppm: null, creator_bps: null })]);
    expect(checkSummary(JSON.stringify(sum)).ok).toBe(true);
  });
});

describe('R14-EVIDENCE: a watchdog from before it', () => {
  it('refuses cost_refusals: the day goes again without them (restart counts kept), once', async () => {
    const NOON = Date.parse('2026-10-04T01:00:00.000Z');
    const dir = tempState();
    const cost = { fee_source: 'event', spend_lamports: '16537126', sol_usd_micro: '120940000', eff_quote_lamports: '104806998735', stop_bps: 1500, rt_ppm: 59_822, fees_ppm: 54_000, impact_ppm: 300, f_lamports: '99286', lp_bps: 20, protocol_bps: 5, creator_bps: 250 };
    const line = { seq: 1, ts: new Date(NOON).toISOString(), boot: 'b', kind: 'decision', action: 'reject', reasons: ['reject', 'U2', 'So11111111111111111111111111111111111111112', 'risk R14 cost_gate: x', `${COST_PREFIX}${JSON.stringify(cost)}`], gate_reasons: [{ gate: 'R14', code: 'cost_gate', detail: 'x' }] };
    writeFileSync(join(dir, 'journal.jsonl'), `${JSON.stringify(line)}\n`);
    const bodies: string[] = [];
    const logs: string[] = [];
    const sz = new Summarizer({
      journalPath: join(dir, 'journal.jsonl'), stateDir: dir,
      http: (async (req) => (bodies.push(String(req.body)), { status: String(req.body).includes('"cost_refusals"') ? 400 : 200, header: () => null, text: '{"ok":true,"written":true}' })) as HttpClient,
      watchdogUrl: 'https://w.test', key: 'k', now: () => NOON + 3_600_000, log: (l) => void logs.push(l),
      live: () => ({ gitSha: 'a'.repeat(40), entryRule: 'S0', recorder: 'on', uptimeS: 3600, trades: [], openPositions: 0, solPrice: null, credits: [] }),
    });
    await sz.tick();
    expect(bodies).toHaveLength(2);
    expect(JSON.parse(bodies[0]!).cost_refusals).toHaveLength(1);
    const second = JSON.parse(bodies[1]!) as Record<string, unknown> & { worker: Record<string, unknown> };
    expect(Object.keys(second)).not.toContain('cost_refusals');
    expect(Object.keys(second.worker)).toContain('restarts');
    expect(logs).toEqual(['Summary for 2026-10-04 refused; sent again without the cost refusals.']);
  });
});
