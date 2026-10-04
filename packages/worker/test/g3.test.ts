// TEST-3's G3 half on recorded harness sessions: the run's facts, the live-only vetoes, their counterfactual trades
// scored offline, and the gate's report; the run's files never change, and its decision log is the same whether the
// counterfactuals are scored or not.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXEC_HEALTH_KEY, xcheckKey } from '../../core/src/gates/index.ts';
import { VETO_COMPOSITE_LEVEL } from '../../core/src/stats/index.ts';
import { passingFacts } from '../../core/test/gates/world.ts';
import { parseTyped } from '../src/run/json.ts';
import { classify, g3Report, type HoldoutSummary, type Line, LIVE_ONLY_INPUTS, liveOnlyFactKeys, readRun, runStrategy } from '../src/research/g3.ts';
import { scoreCounterfactual } from '../src/research/counterfactual.ts';
import { readRecording } from '../src/research/recording.ts';
import { FILL_CONFIG, RUG_CONFIG } from '../../core/src/config/index.ts';
import { ACCOUNT_KEY, HALT_KEY } from '../src/engine/strategy.ts';
import { LANDS, MINT, T, makeWorker, passingMarket, tempState } from './worker-harness.ts';

type H = ReturnType<typeof makeWorker>;
const XCHECK = passingFacts().get(xcheckKey(MINT))!.value as { obs: Record<string, unknown> };

/** A session on virtual time: the candidate passes every gate but `veto` decides the cross-check; later the pool falls 30%. */
const session = async (veto: boolean, edgePpm?: bigint): Promise<H> => {
  const h = makeWorker(edgePpm === undefined ? {} : { edgePpm });
  expect(await h.worker.reconcile()).toEqual({ ok: true });
  const m = await passingMarket(h, veto ? { omit: [xcheckKey(MINT)] } : {});
  const tick = (scale: bigint) => () => {
    m.slot();
    m.pool(scale);
    // GoPlus reads a mint authority our own read does not see: an H16 cross-check disagreement, a live-only veto.
    if (veto) {
      m.omit = new Set();
      m.fact(xcheckKey(MINT), { ...XCHECK, obs: { ...XCHECK.obs, receivedAt: m.now - 50 }, sources: [{ provider: 'rugcheck', mintAuthority: 'none', freezeAuthority: 'none' }, { provider: 'goplus', mintAuthority: 'set', freezeAuthority: null }] });
      m.omit = new Set([xcheckKey(MINT)]);
    }
  };
  await m.run(20_000, 400, tick(1_000_000n));
  await m.run(20_000, 400, tick(700_000n));
  await h.worker.stop();
  return h;
};

const HOLDOUT: HoldoutSummary = {
  holdout: { n: 400, mean: 0.02, sd: 0.3 }, severeRate: 0.05, lower: { value: 0.004, level: VETO_COMPOSITE_LEVEL },
  candidates: { count: 2_000, hours: 24 * 28 }, rejectMix: { 'regime:unknown': 900, 'H16:missing': 600, 'stop:no-atr': 300 }, returnCap: 0.5,
};
/** The plan registered before the run, judged at `evaluateAtMs` (the session's last line unless a test says otherwise). */
const lastMs = (h: H) => Date.parse(String((JSON.parse(readFileSync(join(h.stateDir, 'journal.jsonl'), 'utf8').trim().split('\n').at(-1)!) as { ts: string }).ts));
const reg = (h: H, evaluateAtMs = lastMs(h)) => ({ registeredAtMs: T - 30 * 86_400_000, thresholds: {}, expectedSimulationErrors: [], evaluateAtMs });

/** Every file under `dir` with its SHA-256. */
const tree = (dir: string): Record<string, string> => {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const f of readdirSync(d).sort()) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else out[p.slice(dir.length)] = createHash('sha256').update(readFileSync(p)).digest('hex');
    }
  };
  walk(dir);
  return out;
};

/** The decision log without what differs between two processes by nature (boot id, pid, wall-clock run label). */
const decisionLog = (h: H): string[] => readFileSync(join(h.stateDir, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
  .filter((l) => l['kind'] === 'decision' || l['kind'] === 'entry' || l['kind'] === 'exit')
  .map(({ boot: _b, ...rest }) => JSON.stringify(rest));

describe('G3: live-only vetoes and their counterfactual trades (TEST-3)', () => {
  it('the live-only inputs are exactly the facts core marks live-only-veto', () => {
    const keyOf: Record<string, string> = { sim: 'gates/sim:', xcheck: 'gates/xcheck:', 'exec-health': EXEC_HEALTH_KEY };
    expect([...LIVE_ONLY_INPUTS].map((i) => keyOf[i]).sort()).toEqual(liveOnlyFactKeys().sort());
  });

  it('a veto is a never-entered candidate\'s reject whose every typed reason is on a live-only input', () => {
    const d = (mint: string, gate_reasons: unknown[], ts = '2026-10-04T00:00:00.000Z', action = 'reject'): Line => ({ kind: 'decision', ts, boot: 'b', action, reasons: ['reject', 'U2', mint, 'x'], gate_reasons });
    const xc = { gate: 'H16', code: 'xcheck-disagree', input: 'xcheck', detail: '' };
    const sim = { gate: 'H15', code: 'sim-failed', input: 'sim', detail: '' };
    const holders = { gate: 'H16', code: 'missing', input: 'holders', detail: '' };
    const noInput = { gate: 'H15', code: 'roundtrip', detail: '' };
    const { vetoes, rejectMix } = classify([
      d('A', [xc, sim], '2026-10-04T00:00:01.000Z'), d('A', [xc], '2026-10-04T00:00:02.000Z'),
      d('B', [xc, holders]), d('C', [noInput]), d('D', [xc]), d('E', []),
    ], new Set(['D']));
    expect(vetoes.map((v) => [v.mint, v.atMs])).toEqual([['A', Date.parse('2026-10-04T00:00:01.000Z')]]);
    // One count per never-entered candidate, by its last reject's first reason; an entered one is not in the mix.
    expect(rejectMix).toEqual({ 'H16:xcheck-disagree': 2, 'H15:roundtrip': 1, untyped: 1 });
  });

  it('a vetoed run: the veto is scored offline as if entered, the report runs G3, and the run\'s files do not change', async () => {
    const h = await session(true);
    const run = readRun(h.stateDir);
    expect(run.entered).toEqual([]);
    expect(run.candidates).toBe(1);
    expect(run.vetoes.map((v) => [v.mint, v.reasons])).toEqual([[MINT, [{ gate: 'H16', code: 'xcheck-disagree', input: 'xcheck' }]]]);
    const before = tree(h.stateDir);
    const out = join(tempState(), 'g3');
    const report = await g3Report({ stateDir: h.stateDir, holdout: HOLDOUT, registration: reg(h), parityPassed: true, out, scenario: LANDS });
    expect(tree(h.stateDir)).toEqual(before);
    // The counterfactual: entered once the cross-check is not applied, stopped out when the pool fell 30%.
    expect(report.counterfactuals).toHaveLength(1);
    const cf = report.counterfactuals[0]!;
    expect(cf).toMatchObject({ mint: MINT, entered: true, censored: false, censoredReason: null, exitReasons: ['stop'] });
    // The same recording cut before the stop: the trade is censored, with its reason, never given a return.
    const run2 = runStrategy(readRun(h.stateDir).start);
    const all = readRecording(h.stateDir).flatMap((b) => b.frames);
    const cut = await scoreCounterfactual({ mint: MINT, frames: all.filter((f) => f.receivedAt <= cf.enteredAtMs! + 2_000), session: run2.session, rugs: RUG_CONFIG, strategy: run2.strategy, scenario: LANDS, network: FILL_CONFIG.network, seed: 'cut' });
    expect(cut).toMatchObject({ entered: true, censored: true, r: null, net: null });
    expect(cut.censoredReason).toMatch(/^position open when the recording ends/);
    expect(cf.r!).toBeLessThan(-0.25);
    expect(cf.r!).toBeGreaterThan(-0.35);
    expect(cf.r).toBe(Number(cf.net) / Number(cf.cost));
    expect(cf.enteredAtMs!).toBeGreaterThanOrEqual(cf.vetoAtMs - 1_000);
    // Written to its own file only; a second scoring gives the same bytes.
    const file = readFileSync(join(out, 'counterfactuals.jsonl'), 'utf8');
    expect(file.trim().split('\n').map((l) => (parseTyped(l) as { mint: string }).mint)).toEqual([MINT]);
    const again = join(tempState(), 'g3');
    await g3Report({ stateDir: h.stateDir, holdout: HOLDOUT, registration: reg(h), parityPassed: true, out: again, scenario: LANDS });
    expect(readFileSync(join(again, 'counterfactuals.jsonl'), 'utf8')).toBe(file);
    // G3 on it: one eligible candidate, vetoed; the gap is the worst case (fewer than 10 of each): not a pass.
    const r = report.result;
    expect(r.metrics).toMatchObject({ liveOnlyVetoRate: 1, dryRunTrades: 0, vetoGap: null });
    expect(r.status).not.toBe('pass');
    expect(r.checks.find((c) => c.name === 'live-only vetoes')!.passed).toBe(false);
    expect(r.checks.find((c) => c.name === 'veto counterfactuals')).toBeUndefined();
    const g3 = parseTyped(readFileSync(join(out, 'g3.json'), 'utf8')) as { vetoes: { vetoed: number; eligible: number }; result: { status: string } };
    expect(g3.vetoes).toMatchObject({ vetoed: 1, eligible: 1 });
    expect(g3.result.status).toBe(r.status);
  }, 120_000);

  it('a kept run: the trade\'s net return over its entry cost, and no veto', async () => {
    const h = await session(false);
    const run = readRun(h.stateDir);
    expect(run.entered).toEqual([MINT]);
    expect(run.vetoes).toEqual([]);
    expect(run.kept).toHaveLength(1);
    expect(run.kept[0]!.r).toBeLessThan(-0.25);
    expect(run.simulations.attempted).toBeGreaterThanOrEqual(2);
    expect(run.simulations.succeeded).toBe(run.simulations.attempted);
    expect(run.fillDifferences.every((x) => x === 0)).toBe(true);
  }, 60_000);

  it('scoring a mint the run did enter leaves the run\'s own world out: the offline trade is the strategy\'s, not a copy of the live fills', async () => {
    const h = await session(false);
    const live = readRun(h.stateDir).kept[0]!;
    const { session: s2, strategy } = runStrategy(readRun(h.stateDir).start);
    const frames = readRecording(h.stateDir).flatMap((b) => b.frames);
    const cf = await scoreCounterfactual({ mint: MINT, frames, session: s2, rugs: RUG_CONFIG, strategy, scenario: LANDS, network: FILL_CONFIG.network, seed: 'g3:kept' });
    // One entry and one stop exit of its own: the live run's intents and fills were never replayed into its book,
    // whose ids are the same (the scoring book would refuse them as repeats), on the seed it was given.
    expect(cf).toMatchObject({ entered: true, censored: false, exitReasons: ['stop'], check: { refused: 0, otherPositions: 0, paperSeed: 'g3:kept' } });
    expect(Math.abs(cf.r! - live.r)).toBeLessThan(0.02);
  }, 60_000);

  it('every input is cut at the registered evaluation time, and a run that ended before it is not proven (STATS-1c)', async () => {
    const h = await session(true);
    const full = await g3Report({ stateDir: h.stateDir, holdout: HOLDOUT, registration: reg(h), parityPassed: true, out: join(tempState(), 'g3'), scenario: LANDS });
    const entered = full.counterfactuals[0]!.enteredAtMs!;
    // Judged 2 s after the counterfactual's entry: the recording after it is not seen, so the trade is censored.
    const cutAt = entered + 2_000;
    const cut = await g3Report({ stateDir: h.stateDir, holdout: HOLDOUT, registration: reg(h, cutAt), parityPassed: true, out: join(tempState(), 'g3'), scenario: LANDS });
    expect(cut.counterfactuals[0]).toMatchObject({ entered: true, censored: true, r: null });
    expect(cut.result.metrics['dryRunHours']).toBeCloseTo((cutAt - readRun(h.stateDir).startMs) / 3_600_000, 9);
    expect(cut.result.checks.find((c) => c.name === 'veto counterfactuals')!.detail).toMatch(/1 censored/);
    // A cut before the veto: nothing vetoed yet.
    expect(readRun(h.stateDir, full.counterfactuals[0]!.vetoAtMs - 1).vetoes).toEqual([]);
    // The run ended more than a minute before the evaluation time: not proven, nothing scored.
    const out = join(tempState(), 'g3');
    const early = await g3Report({ stateDir: h.stateDir, holdout: HOLDOUT, registration: reg(h, lastMs(h) + 61_000), parityPassed: true, out, scenario: LANDS });
    expect(early.result).toMatchObject({ status: 'not-proven', checks: [{ name: 'evaluation time', passed: false }] });
    expect(early.counterfactuals).toEqual([]);
    expect(readFileSync(join(out, 'counterfactuals.jsonl'), 'utf8')).toBe('');
    // Within the minute's slack it is judged.
    const onTime = await g3Report({ stateDir: h.stateDir, holdout: HOLDOUT, registration: reg(h, lastMs(h) + 59_000), parityPassed: true, out: join(tempState(), 'g3'), scenario: LANDS });
    expect(onTime.result.checks.some((c) => c.name === 'evaluation time')).toBe(false);
    // A kept trade closed after the evaluation time is not judged.
    const k = await session(false);
    const exitMs = (parseTyped(readFileSync(join(k.stateDir, 'account.json'), 'utf8')) as { trades: { closedAtMs: number }[] }).trades[0]!.closedAtMs;
    expect(readRun(k.stateDir, exitMs - 1).kept).toEqual([]);
    expect(readRun(k.stateDir, exitMs).kept).toHaveLength(1);
  }, 120_000);

  it('a veto counts only when the strategy would have entered without the live-only checks', async () => {
    // No edge: without the cross-check the gates pass, and risk still refuses the entry.
    const h = await session(true, 0n);
    expect(readRun(h.stateDir).vetoes).toHaveLength(1);
    const out = join(tempState(), 'g3');
    const report = await g3Report({ stateDir: h.stateDir, holdout: HOLDOUT, registration: reg(h), parityPassed: true, out, scenario: LANDS });
    expect(report.counterfactuals.map((c) => c.entered)).toEqual([false]);
    const g3 = parseTyped(readFileSync(join(out, 'g3.json'), 'utf8')) as { vetoes: unknown };
    expect(g3.vetoes).toEqual({ classified: 1, vetoed: 0, eligible: 0, notEnteredWithoutThem: [MINT] });
    expect(report.result.checks.find((c) => c.name === 'live-only vetoes')!.detail).toBe('no eligible candidates in the run');
  }, 60_000);

  it('the scoring worker keeps its own account and halt, and takes no other mint', async () => {
    const h = await session(true);
    const { session: s2, strategy } = runStrategy(readRun(h.stateDir).start);
    // The run's own state on its feed says no entry may happen: halted, and the kill switch latched.
    const frames = readRecording(h.stateDir).flatMap((b) => b.frames).map((f) => {
      const b = f.body;
      if (b.type === 'fact' && b.key === HALT_KEY) return { ...f, body: { ...b, value: { halted: true, reasons: ['the run was halted'] } } };
      if (b.type === 'fact' && b.key === ACCOUNT_KEY) {
        const v = b.value as { latches: Record<string, unknown> };
        return { ...f, body: { ...b, value: { ...v, latches: { ...v.latches, killTrippedAtMs: f.receivedAt } } } };
      }
      return f;
    });
    expect(frames.some((f) => f.body.type === 'fact' && f.body.key === HALT_KEY)).toBe(true);
    const cf = await scoreCounterfactual({ mint: MINT, frames, session: s2, rugs: RUG_CONFIG, strategy, scenario: LANDS, network: FILL_CONFIG.network, seed: 's' });
    expect(cf).toMatchObject({ entered: true, check: { refused: 0, otherPositions: 0 } });
    // Asked for another mint, it enters nothing at all.
    const other = await scoreCounterfactual({ mint: '11111111111111111111111111111112', frames, session: s2, rugs: RUG_CONFIG, strategy, scenario: LANDS, network: FILL_CONFIG.network, seed: 's' });
    expect(other).toMatchObject({ entered: false, check: { otherPositions: 0 } });
  }, 60_000);

  it('one command: the script reads the run, writes the two files and exits 1 when G3 does not pass', async () => {
    const h = await session(true);
    const dir = tempState();
    writeFileSync(join(dir, 'holdout.json'), JSON.stringify(HOLDOUT));
    writeFileSync(join(dir, 'registration.json'), JSON.stringify(reg(h)));
    writeFileSync(join(dir, 'parity.json'), JSON.stringify({ ok: true }));
    const before = tree(h.stateDir);
    const r = spawnSync(process.execPath, ['--no-warnings', 'packages/worker/scripts/g3.ts', '--state', h.stateDir, '--holdout', join(dir, 'holdout.json'), '--registration', join(dir, 'registration.json'), '--parity', join(dir, 'parity.json'), '--out', join(dir, 'out')], { cwd: join(import.meta.dirname, '..', '..', '..'), encoding: 'utf8', timeout: 60_000 });
    expect(r.status, r.stderr).toBe(1);
    expect(r.stdout).toMatch(/^G3 (fail|not-proven)/);
    // The script runs the run's own paper scenario (the harness session drew its fills from LANDS).
    expect(r.stdout).toMatch(/^1 live-only vetoes scored; [01] would have entered$/m);
    expect(r.stdout).toMatch(/^FAIL {2}live-only vetoes: /m);
    expect(existsSync(join(dir, 'out', 'g3.json')) && existsSync(join(dir, 'out', 'counterfactuals.jsonl'))).toBe(true);
    expect(tree(h.stateDir)).toEqual(before);
    // Vetoed and eligible count only the candidates the strategy would have entered without the live-only checks.
    const g3 = parseTyped(readFileSync(join(dir, 'out', 'g3.json'), 'utf8')) as { vetoes: { classified: number; vetoed: number; eligible: number } };
    const would = readFileSync(join(dir, 'out', 'counterfactuals.jsonl'), 'utf8').trim().split('\n').filter((l) => (parseTyped(l) as { entered: boolean }).entered).length;
    expect(g3.vetoes).toEqual({ classified: 1, vetoed: would, eligible: would, notEnteredWithoutThem: would === 1 ? [] : [MINT] });
  }, 120_000);

  it('the decision log is byte-identical with counterfactual scoring on and off', async () => {
    const scored = await session(true);
    await g3Report({ stateDir: scored.stateDir, holdout: HOLDOUT, registration: reg(scored), parityPassed: true, out: join(tempState(), 'g3'), scenario: LANDS });
    const plain = await session(true);
    expect(decisionLog(scored)).toEqual(decisionLog(plain));
    expect(decisionLog(scored).length).toBeGreaterThanOrEqual(3);
  }, 120_000);
});
